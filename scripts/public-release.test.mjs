import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {privatePath,contentFindings} from './public-release.mjs';

test('publication checks distinguish private resources from fictional examples',()=>{
 assert.equal(privatePath('projects/private/kit.json'),true);
 assert.equal(privatePath('projects/example/kit.json'),false);
 assert.equal(privatePath('output/report.pdf'),true);
 assert.equal(privatePath('.local/backlink-submitter/runtime.json'),true);
 assert.equal(privatePath('README.md'),false);
 assert.deepEqual(contentFindings('https://product.example/ example@example.com'),[]);
 assert.ok(contentFindings('https://workspace.'+'feishu.cn/wiki/'+'private-resource').length);
 assert.ok(contentFindings('https://github.com/'+'actual-owner/actual-repo/pull/'+'123').length);
 assert.ok(contentFindings('a@'+'mail-service.com').length);
 assert.ok(contentFindings('An internal product name',['internal product']).length);
 assert.ok(contentFindings(JSON.stringify({artifact_sensitivity:'private'})).length);
});

test('export drops old history and ignored files, never overwrites a release, and detects historical leaks',()=>{
 mkdirSync(new URL('../tmp/',import.meta.url),{recursive:true});
 const root=mkdtempSync(fileURLToPath(new URL('../tmp/publication-test-',import.meta.url)));
 const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const run=(...args)=>spawnSync(process.execPath,[join(root,'scripts/public-release.mjs'),...args],{encoding:'utf8',env:{...process.env,GIT_TEMPLATE_DIR:join(root,'tmp/git-template'),GIT_DIR:join(root,'.git')}});
 try{
  mkdirSync(join(root,'scripts'));mkdirSync(join(root,'projects/example'),{recursive:true});mkdirSync(join(root,'tmp'));
  copyFileSync(new URL('./public-release.mjs',import.meta.url),join(root,'scripts/public-release.mjs'));
  writeFileSync(join(root,'projects/example/kit.json'),'{}');
  writeFileSync(join(root,'.gitignore'),'tmp/\nprojects/*\n!projects/example/\n');
  git('init','--initial-branch=main');
  writeFileSync(join(root,'old.md'),'https://workspace.'+'feishu.cn/wiki/'+'private-resource');
  git('add','.');git('-c','user.name=Example','-c','user.email=example@invalid','commit','-m','Old version');
  git('rm','old.md');git('-c','user.name=Example','-c','user.email=example@invalid','commit','-m','Remove old version');
  writeFileSync(join(root,'tmp/private.json'),'private runtime');
  const check=run('check');assert.equal(check.status,1);assert.match(check.stdout,/history:/);assert.ok(!check.stdout.includes('private-resource'));
  git('-c','user.name=Example','-c','user.email=example@invalid','tag','-a','sample-tag','-m','https://workspace.'+'feishu.cn/wiki/'+'tag-resource');
  git('-c','user.name=Example','-c','user.email=example@invalid','tag','-a','outer-tag','sample-tag','-m','Nested tag');git('tag','-d','sample-tag');
  const tagCheck=JSON.parse(run('check').stdout);assert.ok(tagCheck.findings.some(f=>f.location.startsWith('tag:')));
  writeFileSync(join(root,'staged.md'),'https://workspace.'+'feishu.cn/wiki/'+'staged-resource');git('add','staged.md');
  writeFileSync(join(root,'staged.md'),'clean working copy');
  const stagedCheck=run('check');assert.equal(stagedCheck.status,1);assert.ok(JSON.parse(stagedCheck.stdout).findings.some(f=>f.location==='index:staged.md'));
  assert.equal(run('export','tmp/blocked').status,1);assert.equal(existsSync(join(root,'tmp/blocked')),false);
  git('reset','--','staged.md');
  mkdirSync(join(root,'outside'));symlinkSync(join(root,'outside'),join(root,'tmp/linked-parent'));
  assert.equal(run('export','tmp/linked-parent/release').status,1);assert.equal(existsSync(join(root,'outside/release')),false);
  mkdirSync(join(root,'tmp/git-template'));
  writeFileSync(join(root,'tmp/git-template/config'),'[remote "inherited"]\n url = https://code.example/private\n');
  const exported=run('export','tmp/clean');assert.equal(exported.status,0,exported.stderr);
  assert.equal(existsSync(join(root,'tmp/clean/tmp/private.json')),false);
  assert.equal(existsSync(join(root,'tmp/clean/old.md')),false);
  assert.equal(spawnSync('git',['-C',join(root,'tmp/clean'),'rev-list','--all'],{encoding:'utf8'}).stdout,'');
  assert.equal(spawnSync('git',['-C',join(root,'tmp/clean'),'remote'],{encoding:'utf8'}).stdout,'');
  const cleanCheck=spawnSync(process.execPath,[join(root,'tmp/clean/scripts/public-release.mjs'),'check'],{encoding:'utf8'});
  assert.equal(cleanCheck.status,0,cleanCheck.stdout+cleanCheck.stderr);
  assert.equal(run('export','tmp/clean').status,1);
  assert.equal(run('export','.').status,1);
  assert.match(readFileSync(join(root,'tmp/clean/.gitignore'),'utf8'),/tmp\//);
 }finally{rmSync(root,{recursive:true,force:true});}
});
