import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { repositoryRoot, runtimePaths, setActiveKitConfig, targetIdentity } from './kit-config.mjs';
import { initializeRuntime, loadRuntime, localRecord, businessPatch, candidateIdentity, sharedResourceMatches } from './base-store.mjs';
import { validateConfirmed, validatePending, candidateSiteMismatch } from './apply-submitted-updates.mjs';
import {baseFields} from './base-schema.mjs';

test('new candidate writes use pending submission and reject the retired assessment status',()=>{
 assert.deepEqual(businessPatch({status:'watching'}),{status:['待提交']});
 assert.throws(()=>businessPatch({status:'待评估'}),/Unsupported business status/);
});

function fixture() {
  const root = repositoryRoot(), id = `test-${randomUUID()}`;
  const dir = mkdtempSync(join(root, 'tmp', 'unified-base-'));
  const project = join(root, 'projects', id); mkdirSync(project, {recursive:true});
  const kit = {id, name:'Example Product', website:'https://product.example/', submissionKitUrl:'https://docs.example/kit',
    profile:'test-account', defaultSubmitter:'example-owner',
    base:{wikiUrl:'https://feishu.example/base/sample?table=tblSample&view=vewSample',baseToken:'sample',tableId:'tblSample',viewId:'vewSample'}};
  writeFileSync(join(project,'kit.json'), JSON.stringify(kit));
  setActiveKitConfig(kit); initializeRuntime({},kit);
  const fakeRoot=join(dir,'repo');
  mkdirSync(join(fakeRoot,'scripts'),{recursive:true});
  cpSync(join(root,'scripts/backlinks.mjs'),join(fakeRoot,'scripts/backlinks.mjs'));
  cpSync(join(root,'.agents/skills/backlink-submitter/scripts'),join(fakeRoot,'.agents/skills/backlink-submitter/scripts'),{recursive:true});
  mkdirSync(join(fakeRoot,'projects'),{recursive:true});symlinkSync(project,join(fakeRoot,'projects',id));
  const shared=join(fakeRoot,'.local/backlink-submitter');mkdirSync(shared,{recursive:true});
  symlinkSync(runtimePaths(kit).projectDir,join(shared,id));
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  writeFileSync(join(shared,'circuit.json'),JSON.stringify({date:today,open:false,reason:null,events:[]}));
  const state = {URL:'https://directory.example/',name:'Directory',status:['待提交'],notes:'Original note',date:'2026-04-01T00:00:00+08:00',DR:72,'Traffic (k)':791};
  const stateFile=join(dir,'base.json'), calls=join(dir,'calls.json');
  const fieldsFile=join(dir,'fields.json');writeFileSync(fieldsFile,JSON.stringify(baseFields(kit)));
  writeFileSync(stateFile,JSON.stringify(state));writeFileSync(calls,'[]');
  const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'lark-cli'), `#!/usr/bin/env node
import fs from 'node:fs';const args=process.argv.slice(2), val=n=>args[args.indexOf(n)+1];
if(val('--profile')!=='test-account')throw Error('Wrong account');
const path=process.env.MOCK_BASE_STATE, calls=process.env.MOCK_BASE_CALLS;
let state=JSON.parse(fs.readFileSync(path));const history=JSON.parse(fs.readFileSync(calls));history.push(args);fs.writeFileSync(calls,JSON.stringify(history));
if(args[1]==='+record-get') {if(process.env.MOCK_EDIT_ON_SECOND_READ && history.filter(a=>a[1]==='+record-get').length===2){state.notes='Human changed after review';fs.writeFileSync(path,JSON.stringify(state));}const fields=args.flatMap((x,i)=>x==='--field-id'?[args[i+1]]:[]);console.log(JSON.stringify({ok:true,data:{data:[fields.map(f=>state[f]??null)],record_id_list:['recExample']}}));}
else if(args[1]==='+record-upsert'){const patch=JSON.parse(val('--json'));if(Object.keys(patch).some(k=>/automation|checkpoint|blocker|last_attempt|^website$|^dofollow$/.test(k)))throw Error('Execution field leaked into Base');Object.assign(state,patch);if(process.env.MOCK_URL_AFTER_WRITE)state.URL='https://new-directory.example/';fs.writeFileSync(path,JSON.stringify(state));if(process.env.MOCK_FAIL_AFTER_WRITE)process.exit(1);console.log(JSON.stringify({ok:true,data:{record_id:'recExample'}}));}
else if(args[1]==='+field-list'){console.log(JSON.stringify({ok:true,data:{fields:JSON.parse(fs.readFileSync(process.env.MOCK_BASE_FIELDS))}}));}
else if(args[1]==='+record-list'){const fields=args.flatMap((x,i)=>x==='--field-id'?[args[i+1]]:[]),empty=process.env.MOCK_EMPTY_BASE==='1';console.log(JSON.stringify({ok:true,data:{data:empty?[]:[fields.map(f=>state[f]??null)],record_id_list:empty?[]:['recExample'],has_more:false}}));}
else throw Error('Unexpected command '+args.join(' '));
`);chmodSync(join(bin,'lark-cli'),0o755);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,BACKLINK_KIT_PATH:join(fakeRoot,'projects',id,'kit.json'),MOCK_BASE_STATE:stateFile,MOCK_BASE_CALLS:calls,MOCK_BASE_FIELDS:fieldsFile};
  const run=(command,input={},extra={})=>spawnSync(process.execPath,[join(fakeRoot,'scripts/backlinks.mjs'),id,command,'--input-json','-'],{env:{...env,...extra},encoding:'utf8',input:JSON.stringify(input)});
  const good=(command,input={},extra={})=>{const r=run(command,input,extra);assert.equal(r.status,0,r.stderr);return r.stdout;};
  let auditEnv={};
  const apply=(report,...flags)=>{const path=join(dir,'audit.json');writeFileSync(path,JSON.stringify(report));return spawnSync(process.execPath,[join(fakeRoot,'scripts/backlinks.mjs'),id,'apply',path,...flags],{env:{...env,...auditEnv},encoding:'utf8'});};
  const base=()=>JSON.parse(readFileSync(stateFile));
  return {auditEnvironment:value=>{auditEnv=value;},kit,dir,run,good,apply,base,env,calls,stateFile,fieldsFile,shared,writeBase:value=>writeFileSync(stateFile,JSON.stringify(value)),clean:()=>{rmSync(dir,{recursive:true,force:true});rmSync(project,{recursive:true,force:true});rmSync(runtimePaths(kit).projectDir,{recursive:true,force:true});}};
}

test('schema comparison works without runtime and init refuses existing or nonempty state',()=>{
 const f=fixture();try{
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
  rmSync(runtimePaths(f.kit).stateFile);
  f.good('check-schema');
  rmSync(join(f.shared,f.kit.id));
  assert.notEqual(f.run('init',{yes:true}).status,0);
  assert.notEqual(f.run('init',{}, {MOCK_EMPTY_BASE:'1'}).status,0);
  f.good('init',{yes:true},{MOCK_EMPTY_BASE:'1'});
  f.good('bootstrap');
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
  assert.ok(JSON.parse(readFileSync(f.calls)).every(a=>!a[1].includes('upsert')));
 }finally{f.clean();}
});

test('init rejects schema drift and preserves existing shared stop state',()=>{
 const f=fixture();try{
  rmSync(runtimePaths(f.kit).stateFile);
  rmSync(join(f.shared,f.kit.id));
  const fields=JSON.parse(readFileSync(f.fieldsFile));fields.find(x=>x.name==='link_type').multiple=true;writeFileSync(f.fieldsFile,JSON.stringify(fields));
  assert.notEqual(f.run('check-schema').status,0);
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
  writeFileSync(f.fieldsFile,JSON.stringify(baseFields(f.kit)));
  const circuit=join(f.shared,'circuit.json'),state=JSON.parse(readFileSync(circuit));
  state.open=true;state.reason='ip_rate_limit';state.events=[{type:'ip_rate_limit',domain:'directory.example'}];
  const before=JSON.stringify(state);writeFileSync(circuit,before);
  f.good('init',{yes:true},{MOCK_EMPTY_BASE:'1'});
  assert.equal(readFileSync(circuit,'utf8'),before);
 }finally{f.clean();}
});

test('first empty workspace initializes its circuit but a damaged existing workspace cannot reset it',()=>{
 const f=fixture();try{
  rmSync(runtimePaths(f.kit).stateFile);rmSync(join(f.shared,'circuit.json'));
  rmSync(join(f.shared,f.kit.id));mkdirSync(join(f.shared,'old-ledger'));
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
  rmSync(join(f.shared,'old-ledger'),{recursive:true});
  f.good('init',{yes:true},{MOCK_EMPTY_BASE:'1'});
  const circuit=JSON.parse(readFileSync(join(f.shared,'circuit.json')));
  assert.equal(circuit.open,false);assert.deepEqual(circuit.events,[]);
 }finally{f.clean();}
});

test('init never rebuilds a project directory after a lost or damaged ledger',()=>{
 const f=fixture();try{
  rmSync(runtimePaths(f.kit).stateFile);
  writeFileSync(join(runtimePaths(f.kit).projectDir,'runtime.backup.json'),'{}');
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
  rmSync(join(runtimePaths(f.kit).projectDir,'runtime.backup.json'));
  assert.notEqual(f.run('init',{yes:true},{MOCK_EMPTY_BASE:'1'}).status,0);
 }finally{f.clean();}
});

test('unified workflow preserves dates and metrics, persists private checkpoints, and repairs only metadata on replay',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  const count=()=>JSON.parse(readFileSync(f.calls)).filter(args=>args[1]==='+record-upsert').length;
  assert.equal(count(),0);
  for(const checkpoint of ['public_precheck_done','form_ready','form_filled','pre_submit_verified','submit_click_started','submit_result_recorded'])f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint,detail:checkpoint});
  assert.equal(count(),0);
  assert.notEqual(f.run('resume',{'record-id':'recExample','run-id':'run-one',yes:true}).status,0);
  const input={'record-id':'recExample','run-id':'run-one',result:'submitted',evidence:'Receipt confirmed','notes-before':'Original note','base-note':'Received; waiting for review. Edit: https://directory.example/edit/sample'};
  f.good('finish',input);assert.deepEqual(f.base().status,['待核验']);
  assert.equal(f.base().DR,72);assert.equal(f.base()['Traffic (k)'],791);assert.equal(f.base().date,'2026-04-01T00:00:00+08:00');
  const log=localRecord('recExample',f.kit).automation_log;assert.match(log,/submit_click_started/);
  f.writeBase({...f.base(),notes:'Human correction. Edit: https://directory.example/edit/sample'});
  f.good('finish',input);assert.equal(count(),1);assert.match(f.base().notes,/Human correction/);assert.equal(localRecord('recExample',f.kit).automation_log,log);
  assert.notEqual(f.run('claim',{'record-id':'recExample'}).status,0);
 }finally{f.clean();}
});

test('lost runtime and failed remote writes fail closed, with read-only reconciliation after a committed Base write',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  for(const checkpoint of ['public_precheck_done','form_ready','form_filled','pre_submit_verified','submit_click_started','submit_result_recorded']) f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint});
  const input={'record-id':'recExample','run-id':'run-one',result:'manual_review','blocker-type':'submit_unknown',evidence:'No receipt','notes-before':'Original note','base-note':'Clicked once; outcome unknown. Do not resubmit.'};
  assert.notEqual(f.run('finish',input,{MOCK_FAIL_AFTER_WRITE:'1'}).status,0);
  assert.ok(localRecord('recExample',f.kit).runtime_pending);
  assert.notEqual(f.run('claim',{'record-id':'recExample'}).status,0);
  const pendingBase=f.base();
  f.writeBase({...pendingBase,URL:'https://another-directory.example/'});
  assert.notEqual(f.run('reconcile',{'record-id':'recExample'}).status,0);
  assert.ok(localRecord('recExample',f.kit).runtime_pending);
  f.writeBase(pendingBase);
  f.good('reconcile',{'record-id':'recExample'});
  assert.equal(localRecord('recExample',f.kit).blocker_type,'submit_unknown');
  assert.notEqual(f.run('resume',{'record-id':'recExample','run-id':'run-one',yes:true}).status,0);
  rmSync(runtimePaths(f.kit).stateFile);
  const r=f.run('claim',{'record-id':'recExample'});assert.notEqual(r.status,0);assert.match(r.stderr,/Runtime unavailable/);
 }finally{f.clean();}
});

test('one audit tool writes Chinese outcomes, rejects stale notes and cross-project evidence, and replays once',()=>{
 const f=fixture();try{
  f.writeBase({...f.base(),status:['待核验']});
  const item={category:'pending',record:{record_id:'recExample',website:'https://directory.example/',notes:'Original note',status:['待核验'],link_type:null,myurl:null},base_note:'Checked today; no public record found.',browser_evidence:{provider:'chrome',tab_id:'tab-example',url:'https://directory.example/',observed_at:'2026-10-26T03:00:00.000Z'}};
  const report={...targetIdentity(f.kit),generatedAt:'2026-10-26T03:01:00.000Z',method:'browser-fallback',pending:[item]};
  let r=f.apply({...report,project_id:'another-project'},'--append-pending-notes');assert.notEqual(r.status,0);
  r=f.apply(report,'--append-pending-notes');assert.equal(r.status,0,r.stderr);assert.deepEqual(f.base().status,['已验证：未找到记录']);
  r=f.apply(report,'--append-pending-notes');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/updated.*0/);
  const confirmed={category:'confirmed',record:{...item.record,notes:item.base_note,status:['已验证：未找到记录']},myurl:'https://directory.example/product',link_type:'dofollow',links:[{href:f.kit.website,rel:''}],base_note:'Verified public listing.',browser_evidence:{...item.browser_evidence,url:'https://directory.example/product'}};
  const success={...report,generatedAt:'2026-10-26T03:02:00.000Z',pending:[],confirmed:[confirmed]};
  r=f.apply({...success,confirmed:[{...confirmed,record:{...confirmed.record,notes:'stale'}}]},'--confirmed');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/skip-invalid-note/);
  r=f.apply(success,'--confirmed');assert.equal(r.status,0,r.stderr);assert.deepEqual(f.base().status,['已验证：dofollow']);assert.deepEqual(f.base().link_type,['dofollow']);
  assert.equal(f.base().date,'2026-04-01T00:00:00+08:00');
 }finally{f.clean();}
});

test('nolink requires product identity, explicit link inspection, and rejects contradictory outbound evidence',async()=>{
 const f=fixture();try{
  const item={category:'confirmed',record:{record_id:'recExample',website:'https://directory.example/'},myurl:'https://directory.example/product',link_type:'nolink',links:[],browser_evidence:{provider:'chrome',tab_id:'tab-example',url:'https://directory.example/product',observed_at:'2026-10-26T03:00:00.000Z'},product_evidence:{name:f.kit.name,visible_text:'Example Product is listed here.',outbound_links_checked:true}};
  assert.equal(await validateConfirmed(item,{browserFallback:true,kit:f.kit}),null);
  assert.match(await validateConfirmed({...item,dofollow:'Yes'},{browserFallback:true,kit:f.kit}),/contradicts/);
  assert.match(await validateConfirmed({...item,product_evidence:null},{browserFallback:true,kit:f.kit}),/nolink requires/);
  assert.match(await validateConfirmed({...item,links:[{href:f.kit.website,rel:''}]},{browserFallback:true,kit:f.kit}),/contradicts/);
  assert.deepEqual(businessPatch({status:'succeed',link_type:'nolink'}),{status:['已验证：nolink'],link_type:['nolink']});
 }finally{f.clean();}
});


test('a human note edit between audit review and final write is preserved',()=>{
 const f=fixture();try{
  f.writeBase({...f.base(),status:['待核验']});f.auditEnvironment({MOCK_EDIT_ON_SECOND_READ:'1'});
  const item={category:'pending',record:{record_id:'recExample',website:'https://directory.example/',notes:'Original note',status:['待核验'],link_type:null,myurl:null},base_note:'Old reviewed replacement',browser_evidence:{provider:'chrome',tab_id:'tab-example',url:'https://directory.example/',observed_at:'2026-10-26T03:00:00.000Z'}};
  const r=f.apply({...targetIdentity(f.kit),method:'browser-fallback',pending:[item]},'--append-pending-notes');
  assert.notEqual(r.status,0);assert.match(r.stderr,/notes changed since review/);assert.equal(f.base().notes,'Human changed after review');
  assert.equal(JSON.parse(readFileSync(f.calls)).filter(a=>a[1]==='+record-upsert').length,0);
 }finally{f.clean();}
});


test('post-click finish keeps a human pause and note, while closing private execution evidence',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  for(const checkpoint of ['public_precheck_done','form_ready','form_filled','pre_submit_verified','submit_click_started','submit_result_recorded']) f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint});
  const human={...f.base(),status:['受阻：暂缓（需内容/运营）'],notes:'Human paused this channel.'};f.writeBase(human);
  f.good('finish',{'record-id':'recExample','run-id':'run-one',result:'submitted',evidence:'Receipt observed','notes-before':'Original note','base-note':'Old task result'});
  assert.deepEqual(f.base(),human);assert.equal(localRecord('recExample',f.kit).automation_state,'submitted');
  assert.match(localRecord('recExample',f.kit).automation_log,/Receipt observed/);
 }finally{f.clean();}
});


test('an explicitly resumed running record returns from human handling to a usable submission state',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint:'public_precheck_done'});
  f.writeBase({...f.base(),status:['受阻：人工处理'],notes:'Human paused the pre-click run.'});
  f.good('resume',{'record-id':'recExample','run-id':'run-one',yes:true});
  assert.deepEqual(f.base().status,['待提交']);
  f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint:'form_ready'});
  assert.equal(f.base().notes,'Human paused the pre-click run.');
 }finally{f.clean();}
});

test('audit candidate identity includes a shared-host resource path',()=>{
 assert.match(candidateSiteMismatch({record:{website:'https://forms.example/old'}},{website:'https://forms.example/new'}),/URL does not match/);
 assert.equal(candidateSiteMismatch({record:{website:'https://forms.example/same'}},{website:'https://forms.example/same'}),null);
});


test('shared platform intake keeps independent resources distinct while ordinary submission paths dedupe',()=>{
 assert.notEqual(candidateIdentity('https://github.com/org/repo-a'),candidateIdentity('https://github.com/org/repo-b'));
 assert.equal(candidateIdentity('https://directory.example/submit'),candidateIdentity('https://www.directory.example/'));
 assert.equal(candidateIdentity('https://tally.so/r/abc?utm_source=test&lang=en'),candidateIdentity('https://tally.so/r/abc?lang=en'));
 const f=fixture();try{
  f.writeBase({...f.base(),URL:'https://github.com/org/repo-a'});
  const out=f.good('intake',{website:'https://github.com/org/repo-b',notes:'Distinct developer channel.'});
  assert.match(out,/"duplicate": false/);assert.equal(f.base().URL,'https://github.com/org/repo-b');
  assert.deepEqual(f.base().Submitter,['example-owner']);
 }finally{f.clean();}
});


test('finish refuses an old drafted note when a human edited before the command began',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint:'public_precheck_done'});
  f.writeBase({...f.base(),notes:'Human edited before finish.'});
  const r=f.run('finish',{'record-id':'recExample','run-id':'run-one',result:'ignore','blocker-type':'paid',evidence:'Paid only','notes-before':'Original note','base-note':'Old drafted replacement'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/notes changed since review/);assert.equal(f.base().notes,'Human edited before finish.');
 }finally{f.clean();}
});


test('URL drift during remote write keeps pending intent instead of committing private completion',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  for(const checkpoint of ['public_precheck_done','form_ready','form_filled','pre_submit_verified','submit_click_started','submit_result_recorded']) f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint});
  const r=f.run('finish',{'record-id':'recExample','run-id':'run-one',result:'submitted',evidence:'Receipt','notes-before':'Original note','base-note':'Received.'},{MOCK_URL_AFTER_WRITE:'1'});
  assert.notEqual(r.status,0);assert.ok(localRecord('recExample',f.kit).runtime_pending);assert.equal(localRecord('recExample',f.kit).automation_state,'running');
  assert.notEqual(f.run('reconcile',{'record-id':'recExample'}).status,0);
 }finally{f.clean();}
});


test('intake stops before remote creation when durable state is missing',()=>{
 const f=fixture();try{
  rmSync(runtimePaths(f.kit).stateFile);
  const before=f.base(),r=f.run('intake',{website:'https://new-directory.example/',notes:'Candidate'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Runtime unavailable/);assert.deepEqual(f.base(),before);assert.equal(JSON.parse(readFileSync(f.calls)).length,0);
 }finally{f.clean();}
});

test('shared platform public evidence belongs to its candidate resource, including valid subpages',async()=>{
 const candidate='https://github.com/org/repo-a',wrong='https://github.com/another/repo-b';
 assert.equal(sharedResourceMatches(candidate,wrong),false);assert.equal(sharedResourceMatches(candidate,candidate+'/issues/1'),true);
 const f=fixture();try{
  const item={category:'confirmed',record:{record_id:'recExample',website:candidate},myurl:wrong,link_type:'dofollow',links:[{href:f.kit.website,rel:''}],browser_evidence:{provider:'chrome',tab_id:'tab-example',url:wrong,observed_at:'2026-10-26T03:00:00.000Z'}};
  assert.match(await validateConfirmed(item,{browserFallback:true,kit:f.kit}),/candidate resource/);
  assert.match(validatePending({...item,category:'pending'},{browserFallback:true}),/candidate resource/);
 }finally{f.clean();}
});


test('a legacy business status change blocks old pre-click progress until explicitly resumed',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  f.writeBase({...f.base(),status:['待评估']});
  assert.notEqual(f.run('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint:'public_precheck_done'}).status,0);
  f.good('resume',{'record-id':'recExample','run-id':'run-one',yes:true});
  f.good('checkpoint',{'record-id':'recExample','run-id':'run-one',checkpoint:'public_precheck_done'});
 }finally{f.clean();}
});


test('valid JSON corruption of an execution row fails closed instead of creating a fresh run',()=>{
 const f=fixture();try{
  f.good('claim',{'record-id':'recExample','run-id':'run-one'});
  const path=runtimePaths(f.kit).stateFile, original=readFileSync(path,'utf8');
  for(const damage of ['null','empty','delete']) {
   const state=JSON.parse(original);
   if(damage==='delete')delete state.records.recExample;else state.records.recExample=damage==='null'?null:{};
   writeFileSync(path,JSON.stringify(state));
   assert.throws(()=>loadRuntime(f.kit),/integrity|Malformed/);
   assert.notEqual(f.run('claim',{'record-id':'recExample'}).status,0);
  }
 }finally{f.clean();}
});
