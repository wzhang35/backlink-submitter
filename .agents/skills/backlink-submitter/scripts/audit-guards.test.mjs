import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import { collectEligibleRecords, isAuditEligible } from './collect-submitted.mjs';
import {
  assertConfirmedReadback,
  assertPendingReadback,
  auditEvent,
  auditLogDetail,
  auditRunId,
  reviewedAuditNote,
  manualReviewCompletionPatch,
  validateConfirmed,
  validatePending,
} from './apply-submitted-updates.mjs';
import {
  anchors,
  canConfirm,
  classifySecurityChallenge,
  detectSecurityChallenge,
  dofollowForLinks,
  recordPersistentCircuitEvent,
  renderScreeningReport,
  sameSiteDomain,
  verifyRecords,
} from './verify-submitted.mjs';
import { appendAutomationLog, readCircuit, updateCircuit, writeCircuit } from './run-state.mjs';
import { loadKitConfig, repositoryRoot, setActiveKitConfig, targetIdentity } from './kit-config.mjs';

const kitPath = join(repositoryRoot(), 'projects', 'example', 'kit.json');
const kit = loadKitConfig(kitPath, 'example');
setActiveKitConfig(kit);
const projectTmp = join(repositoryRoot(), 'tmp');
await mkdir(projectTmp, { recursive: true });

test('human HTTP report preserves leads while clearly separating them from public verification',()=>{
 const report=renderScreeningReport({kit,results:[
  {category:'confirmed',record:{website:'https://directory.example/'},myurl:'https://directory.example/product',dofollow:'Yes'},
  {category:'pending',record:{website:'https://other.example/'},reason:'No HTTP match'},
 ]});
 assert.match(report,/SCREENING ONLY/);assert.match(report,/PRIVATE/);
 assert.match(report,/requires Chrome DOM review/);assert.match(report,/cannot be applied to Base/);
 assert.match(report,/Link candidates requiring Chrome review: 1/);
 assert.match(report,/No match in HTTP checks: 1/);
 assert.match(report,/https:\/\/directory\.example\/product/);
 assert.doesNotMatch(report,/## Confirmed|Submitted Backlink Audit/);
});

function mockResponse(url, { status = 200, body = '', location = null, cfMitigated = null, textError = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: String(url),
    headers: { get: (name) => {
      const key = name.toLowerCase();
      if (key === 'location') return location;
      if (key === 'cf-mitigated') return cfMitigated;
      return null;
    } },
    text: async () => {
      if (textError) throw textError;
      return body;
    },
  };
}

test('audit collector admits submitted and post-click submit_unknown records only', () => {
  assert.equal(isAuditEligible({ status: ['submited'] }), true);
  assert.equal(isAuditEligible({
    status: ['to-submit'],
    automation_state: ['manual_review'],
    blocker_type: ['submit_unknown'],
    checkpoint: ['submit_result_recorded'],
  }), true);
  assert.equal(isAuditEligible({
    status: [],
    automation_state: 'manual_review',
    blocker_type: 'submit_unknown',
    checkpoint: 'submit_click_started',
  }), true);
  for (const checkpoint of ['claimed', 'form_ready', null]) {
    assert.equal(isAuditEligible({ automation_state: 'manual_review', blocker_type: 'submit_unknown', checkpoint }), false);
  }
  assert.equal(isAuditEligible({ status: ['ignored'], automation_state: 'manual_review', blocker_type: 'submit_unknown', checkpoint: 'submit_result_recorded' }), false);
  assert.equal(isAuditEligible({ status: ['declined'] }), false);
  assert.equal(isAuditEligible({ status: ['submited'], blocker_type: 'stale_lock' }), false);
  assert.equal(isAuditEligible({ status: ['succeed'], automation_state: 'submitted' }), false);
  assert.equal(isAuditEligible({status:['受阻：暂缓（需内容/运营）'],automation_state:'manual_review',blocker_type:'submit_unknown',checkpoint:'submit_click_started'}),false);
  assert.equal(isAuditEligible({status:['终止：不适合提交'],automation_state:'manual_review',blocker_type:'submit_unknown',checkpoint:'submit_click_started'}),false);
});

test('manual collection combines business status with private post-click state', () => {
  const data = {data:[
    ['https://submitted.example',['待核验'],null,'submitted',null,null],
    ['https://unknown.example',['受阻：人工处理'],null,'clicked once',null,null],
    ['https://ignored.example',['终止：不适合提交'],null,'irrelevant',null,null],
  ],record_id_list:['rec-submitted','rec-unknown','rec-ignored']};
  const records = collectEligibleRecords(data, id => id === 'rec-unknown' ? {automation_state:'manual_review',blocker_type:'submit_unknown',checkpoint:'submit_click_started'} : {});
  assert.deepEqual(records.map(r=>r.record_id),['rec-submitted','rec-unknown']);
  assert.equal(records[1].website,'https://unknown.example');
  assert.equal(records[1].blocker_type,'submit_unknown');
});

test('removed collection scheduling option fails explicitly', () => {
  const result = spawnSync(process.execPath, [
    new URL('./collect-submitted.mjs', import.meta.url).pathname,
    '--include-not-due',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--include-not-due was removed/);
});

test('verifier rejects another project candidate before navigation', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-verify-identity-'));
  const inputPath = join(dir, 'candidates.json');
  const scriptPath = new URL('./verify-submitted.mjs', import.meta.url).pathname;
  await writeFile(inputPath, JSON.stringify({
    project_id: 'other-project',
    website: 'https://other.example/',
    base: { wikiUrl: 'https://feishu.example/wiki/base', baseToken: 'other', tableId: 'other', viewId: null },
    records: [{ record_id: 'rec-other', website: 'http://127.0.0.1' }],
  }));

  try {
    const result = spawnSync(process.execPath, [scriptPath, inputPath], {
      encoding: 'utf8', env: { ...process.env, BACKLINK_KIT_PATH: kitPath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project\/Base identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('audit replacements require complete reviewed business snapshots and preserve human changes', () => {
  const notes='Queued. Edit: https://directory.example/edit?token=sample';
  const base_note='Verified. Edit: https://directory.example/edit?token=sample';
  const current={notes,status:['待核验'],link_type:null,myurl:null};
  const item={record:{...current},base_note};
  assert.equal(reviewedAuditNote(item,current),base_note);
  assert.throws(()=>reviewedAuditNote({...item,base_note:undefined},current),/reviewed Base note/);
  assert.throws(()=>reviewedAuditNote({record:{},base_note},current),/notes snapshot/);
  assert.throws(()=>reviewedAuditNote(item,{...current,notes:notes+'Human edit'}),/changed since review/);
  assert.throws(()=>reviewedAuditNote(item,{...current,status:['已验证：未找到记录']}),/status changed/);
  assert.throws(()=>reviewedAuditNote(item,{...current,link_type:'nofollow'}),/link_type changed/);
  assert.throws(()=>reviewedAuditNote(item,{...current,myurl:'https://directory.example/new'}),/myurl changed/);
  assert.equal(reviewedAuditNote({record:{...current,notes:null},base_note},{...current,notes:null}),base_note);
});

test('audit readback validates terminal status, URLs, notes, dates and log', () => {
  const expectedSuccess = {
    myurl: 'https://example.com/tools/example-product',
    dofollow: 'Yes',
    notes: 'Editorial placement.',
    date: '2026-09-26 12:00:00',
    automation_state: 'submitted',
    blocker_type: null,
    automation_log: '[2026-09-26 09:00:00] run_id=prior event=checkpoint:submitted',
  };
  const currentSuccess = {
    status: ['已验证：dofollow'],
    link_type: 'dofollow',
    ...expectedSuccess,
  };
  assert.doesNotThrow(() => assertConfirmedReadback(currentSuccess, expectedSuccess));
  assert.throws(() => assertConfirmedReadback({ ...currentSuccess, myurl: 'https://example.com/wrong' }, expectedSuccess), /myurl mismatch/);
  assert.throws(() => assertConfirmedReadback({ ...currentSuccess, date: '2026-09-25 23:59:00' }, expectedSuccess), /date mismatch/);
  assert.throws(() => assertConfirmedReadback({ ...currentSuccess, date: '2026-09-26 12:01:00' }, expectedSuccess), /date mismatch/);

  const expectedPending = {
    notes: '公开复查：候选 URL 和站内搜索暂未找到 Example Product 公开收录页。',
    date: '2026-09-26 12:00:00',
    automation_log: '[2026-09-26 12:00:00] run_id=audit-one event=public-audit:123 detail=result=pending',
  };
  assert.doesNotThrow(() => assertPendingReadback(expectedPending, expectedPending));
  assert.throws(() => assertPendingReadback({ ...expectedPending, automation_log: null }, expectedPending), /automation_log writeback mismatch/);
});

test('public audit logs have stable report and record identities with truthful evidence details', () => {
  const audit = { generatedAt: '2026-09-26T02:00:00.000Z' };
  const confirmed = auditLogDetail({
    myurl: 'https://directory.example/example-product',
    dofollow: 'No',
    links: [{ href: 'https://product.example/', rel: 'nofollow' }],
    checks: [{ url: 'https://directory.example/example-product', finalUrl: 'https://directory.example/example-product', status: 200 }],
  }, 'confirmed', audit);
  assert.match(confirmed, /result=confirmed/);
  assert.match(confirmed, /report_at=2026-09-26T02:00:00\.000Z/);
  assert.match(confirmed, /confirmed_href=https:\/\/product\.example\//);
  assert.match(confirmed, /rel=nofollow/);
  assert.match(confirmed, /dofollow=No/);
  assert.match(confirmed, /site_access=attempted/);
  assert.match(auditLogDetail({ dofollow: 'Yes', links: [{ href: 'https://product.example/' }] }, 'confirmed', { method: 'browser-fallback' }), /rel=unknown/);
  assert.match(auditLogDetail({ dofollow: 'Yes', links: [{ href: 'https://product.example/', rel: null }] }, 'confirmed', { method: 'browser-fallback' }), /rel=unknown/);
  assert.match(auditLogDetail({ dofollow: 'Yes', links: [{ href: 'https://product.example/', rel: '' }] }, 'confirmed', { method: 'browser-fallback' }), /rel=none/);
  assert.match(auditLogDetail({ checks: [] }, 'needs_attention', { method: 'browser-fallback' }), /site_access=not_attempted checks=0/);
  assert.match(auditLogDetail({ links: [{ href: 'https://product.example/' }] }, 'pending', { method: 'browser-fallback' }), /site_access=unknown checks=unknown/);

  const pending = auditLogDetail({ record: { website: 'https://directory.example' }, checks: [], reason: 'Audit stopped before navigation by global safety circuit: rate_limit_429.' }, 'needs_attention', audit);
  assert.match(pending, /site_access=not_attempted checks=0/);
  assert.match(pending, /reason=Audit stopped before navigation by global safety circuit/);
  assert.match(pending, /links=https:\/\/directory\.example/);

  const attention = auditLogDetail({ checks: [{ url: 'https://directory.example', finalUrl: 'https://directory.example', status: 403, blockType: 'forbidden_403' }], reason: 'Public verification was blocked.' }, 'needs_attention', audit);
  assert.match(attention, /check_evidence=https:\/\/directory\.example\(forbidden_403\)/);
  assert.match(attention, /reason=Public verification was blocked/);

  const ambiguous = auditLogDetail({ checks: [{ url: 'https://directory.example/tools/example-product', status: 200 }], reason: 'Mention found without a real link.' }, 'ambiguous', audit);
  assert.match(ambiguous, /result=ambiguous/);
  assert.match(ambiguous, /Mention found without a real link/);
  assert.match(ambiguous, /https:\/\/directory\.example\/tools\/example-product/);

  const legacy = auditRunId({ pending: [{ record: { record_id: 'rec1' } }] });
  assert.equal(legacy, auditRunId({ pending: [{ record: { record_id: 'rec1' } }] }));
  assert.notEqual(auditRunId({ ...audit, pending: [] }), auditRunId({ generatedAt: '2026-09-26T02:01:00.000Z', pending: [] }));
  assert.notEqual(auditEvent('rec1'), auditEvent('rec2'));
  assert.doesNotMatch(auditLogDetail({ checks: [] }, 'pending', {}), /report_at=/);
});

test('confirmed public audit closes only post-click submit_unknown automation runs', () => {
  assert.deepEqual(manualReviewCompletionPatch({
    automation_state: 'manual_review', blocker_type: 'submit_unknown', checkpoint: 'submit_result_recorded',
  }), { automation_state: 'submitted', blocker_type: null });
  assert.deepEqual(manualReviewCompletionPatch({
    automation_state: 'manual_review', blocker_type: 'stale_lock', checkpoint: 'submit_result_recorded',
  }), {});
  assert.deepEqual(manualReviewCompletionPatch({
    automation_state: 'manual_review', blocker_type: 'submit_unknown', checkpoint: 'form_ready',
  }), {});
});

test('Chrome success evidence requires configured-domain href and explicit matching rel evidence', async () => {
  const item = {
    category: 'confirmed',
    record: { record_id: 'rec1', website: 'https://directory.example/' },
    myurl: 'https://directory.example/product',
    dofollow: 'Yes',
    links: [{ href: kit.website, rel: '' }],
    browser_evidence: {
      provider: 'chrome', tab_id: 'tab-123', url: 'https://directory.example/product', observed_at: '2026-09-26T02:03:00.000Z',
    },
  };
  assert.equal(await validateConfirmed(item, { browserFallback: true, kit }), null);
  assert.equal(await validateConfirmed({ ...item, links: [{ href: 'https://product.example/public/listing', rel: '' }] }, { browserFallback: true, kit }), null);
  for (const blockedMyurl of [
    'https://directory.example/log%69n',
    'https://user:pass@directory.example/listing',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      myurl: blockedMyurl,
      browser_evidence: { ...item.browser_evidence, url: blockedMyurl },
    }, { browserFallback: true, kit }), /browser confirmation requires Chrome tab, matching URL/);
  }
  const publicMyurl = 'https://directory.example/public/listing';
  assert.equal(await validateConfirmed({
    ...item,
    myurl: publicMyurl,
    browser_evidence: { ...item.browser_evidence, url: publicMyurl },
  }, { browserFallback: true, kit }), null);
  const rootDotMyurl = 'https://directory.example./public/listing';
  assert.equal(await validateConfirmed({
    ...item,
    myurl: rootDotMyurl,
    browser_evidence: { ...item.browser_evidence, url: rootDotMyurl },
  }, { browserFallback: true, kit }), null);
  for (const localRootDotMyurl of [
    'https://localhost./listing',
    'https://host.localhost./listing',
    'https://host.local./listing',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      myurl: localRootDotMyurl,
      browser_evidence: { ...item.browser_evidence, url: localRootDotMyurl },
    }, { browserFallback: true, kit }), /browser confirmation requires Chrome tab, matching URL/);
  }
  const rootDotProductKit = { ...kit, website: 'https://product.example./' };
  assert.equal(await validateConfirmed({
    ...item,
    links: [{ href: rootDotProductKit.website, rel: '' }],
  }, { browserFallback: true, kit: rootDotProductKit }), null);
  const rootDotLocalKit = { ...kit, website: 'https://localhost./' };
  assert.match(await validateConfirmed({
    ...item,
    links: [{ href: rootDotLocalKit.website, rel: '' }],
  }, { browserFallback: true, kit: rootDotLocalKit }), /missing real .* evidence link/);
  for (const href of [
    'https://product.example/log%69n',
    'https://product.example/auth',
    'https://product.example/sso',
    'https://product.example/oauth',
    'https://product.example/authorize',
    'https://product.example/authentication',
    'https://user:pass@product.example/',
  ]) {
    assert.match(await validateConfirmed({ ...item, links: [{ href, rel: '' }] }, { browserFallback: true, kit }), /missing real .* evidence link/, `${href} must be rejected`);
  }
  assert.match(await validateConfirmed({ ...item, links: [{ href: kit.website }] }, { browserFallback: true, kit }), /missing explicit rel/);
  assert.match(await validateConfirmed({ ...item, dofollow: 'No' }, { browserFallback: true, kit }), /does not match/);
  assert.match(await validateConfirmed({ ...item, browser_evidence: { ...item.browser_evidence, url: 'https://directory.example/other' } }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  assert.match(await validateConfirmed({ ...item, browser_evidence: { ...item.browser_evidence, observed_at: 'yesterday' } }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  assert.match(await validateConfirmed({ ...item, links: [
    { href: kit.website, rel: 'nofollow' },
    { href: 'https://unrelated.example/clean-link', rel: '' },
  ] }, { browserFallback: true, kit }), /dofollow does not match/);

  const otherKit = { ...kit, id: 'other-product', name: 'Other Product', website: 'https://other.example/' };
  assert.match(await validateConfirmed(item, { browserFallback: true, kit: otherKit }), /other\.example evidence link/);
});

test('Chrome redirect evidence binds original href and rel to a same-tab public product destination', async () => {
  const sourceObservedAt = '2026-10-14T02:00:00.000Z';
  const destinationObservedAt = '2026-10-14T02:00:05.000Z';
  const redirectEvidence = {
    source: {
      href: 'https://directory.example/go/product',
      myurl: 'https://directory.example/product-card',
      tab_id: 'tab-redirect-1',
      observed_at: sourceObservedAt,
    },
    destination: {
      provider: 'chrome',
      tab_id: 'tab-redirect-1',
      url: kit.website,
      observed_at: destinationObservedAt,
    },
  };
  const link = {
    href: redirectEvidence.source.href,
    rel: 'noopener noreferrer',
    redirect_evidence: redirectEvidence,
  };
  const item = {
    category: 'confirmed',
    record: { record_id: 'rec-redirect-1', website: 'https://directory.example/' },
    myurl: redirectEvidence.source.myurl,
    dofollow: 'Yes',
    links: [link],
    browser_evidence: {
      provider: 'chrome', tab_id: redirectEvidence.source.tab_id,
      url: redirectEvidence.source.myurl, observed_at: sourceObservedAt,
    },
  };

  assert.equal(await validateConfirmed(item, { browserFallback: true, kit }), null);
  const rootDotListing = 'https://directory.example./product-card';
  const rootDotSource = 'https://directory.example./go/product';
  assert.equal(await validateConfirmed({
    ...item,
    myurl: rootDotListing,
    browser_evidence: { ...item.browser_evidence, url: rootDotListing },
    links: [{ ...link, href: rootDotSource, redirect_evidence: {
      ...redirectEvidence,
      source: { ...redirectEvidence.source, href: rootDotSource, myurl: rootDotListing },
    } }],
  }, { browserFallback: true, kit }), null);
  for (const localRedirectUrl of ['https://localhost./go/product', 'https://host.localhost./go/product', 'https://host.local./go/product']) {
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, href: localRedirectUrl, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: localRedirectUrl },
      } }],
    }, { browserFallback: true, kit }), /redirect source href is not a public HTTP URL/);
  }
  for (const localDestinationUrl of ['https://localhost./', 'https://host.localhost./', 'https://host.local./']) {
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, redirect_evidence: {
        ...redirectEvidence,
        destination: { ...redirectEvidence.destination, url: localDestinationUrl },
      } }],
    }, { browserFallback: true, kit }), /redirect destination is not a public non-login HTTP URL/);
  }
  const newTabEvidence = {
    ...redirectEvidence,
    destination: {
      ...redirectEvidence.destination,
      tab_id: 'tab-redirect-destination',
      opened_from: { ...redirectEvidence.source },
    },
  };
  assert.equal(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: newTabEvidence }] }, { browserFallback: true, kit }), null);
  assert.match(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: {
    ...newTabEvidence,
    destination: { ...newTabEvidence.destination, opened_from: undefined },
  } }] }, { browserFallback: true, kit }), /new-tab redirect destination must bind/);
  const relativeHref = '/go/product';
  const relativeEvidence = {
    ...redirectEvidence,
    source: { ...redirectEvidence.source, href: relativeHref },
  };
  assert.equal(await validateConfirmed({ ...item, links: [{ ...link, href: relativeHref, redirect_evidence: relativeEvidence }] }, { browserFallback: true, kit }), null);
  for (const fragmentHref of [
    '#',
    '#foo',
    'https://directory.example/product-card#foo',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, href: fragmentHref, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: fragmentHref },
      } }],
    }, { browserFallback: true, kit }), /only changes the audited page fragment/);
  }
  const queryHref = '?redirect=product';
  assert.equal(await validateConfirmed({
    ...item,
    links: [{ ...link, href: queryHref, redirect_evidence: {
      ...redirectEvidence,
      source: { ...redirectEvidence.source, href: queryHref },
    } }],
  }, { browserFallback: true, kit }), null);
  for (const privateIpv6Href of [
    'http://[::2]/go/product',
    'http://[0:0:0:0:0:0:0:2]/go/product',
    'http://[fe90::1]/go/product',
    'http://[fed0::1]/go/product',
    'http://[64:ff9b:1::1]/go/product',
    'http://[100:0:0:1::1]/go/product',
    'http://[2001:2::1]/go/product',
    'http://[2001:0db8:0:0:0:0:0:1]/go/product',
    'http://[3fff::1]/go/product',
    'http://[5f00::1]/go/product',
    'http://[100:0:0:0::1]/go/product',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, href: privateIpv6Href, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: privateIpv6Href },
      } }],
    }, { browserFallback: true, kit }), /redirect source href is not a public HTTP URL/);
  }
  for (const privateIpv4Href of [
    'http://192.0.0.8/go/product',
    'http://192.0.0.170/go/product',
    'http://192.0.0.171/go/product',
    'http://192.0.2.1/go/product',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, href: privateIpv4Href, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: privateIpv4Href },
      } }],
    }, { browserFallback: true, kit }), /redirect source href is not a public HTTP URL/);
  }
  for (const publicIpv4Href of [
    'http://192.0.1.1/go/product',
    'http://192.0.0.9/go/product',
    'http://192.0.0.10/go/product',
  ]) {
    assert.equal(await validateConfirmed({
      ...item,
      links: [{ ...link, href: publicIpv4Href, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: publicIpv4Href },
      } }],
    }, { browserFallback: true, kit }), null, `${publicIpv4Href} must remain public`);
  }
  for (const publicIpv6Href of [
    'http://[2001:4860:4860::8888]/go/product',
    'http://[2001:1::1]/go/product',
    'http://[2002:c000:0201::1]/go/product',
    'http://[64:ff9b::c000:0101]/go/product',
    'http://[::ffff:c000:0101]/go/product',
  ]) {
    assert.equal(await validateConfirmed({
      ...item,
      links: [{ ...link, href: publicIpv6Href, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: publicIpv6Href },
      } }],
    }, { browserFallback: true, kit }), null, `${publicIpv6Href} must remain public`);
  }
  for (const restrictedSourcePath of ['/auth', '/sso', '/log%69n', '/bad%ZZ']) {
    const href = `https://directory.example${restrictedSourcePath}`;
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, href, redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href },
      } }],
    }, { browserFallback: true, kit }), /redirect source href is not a public HTTP URL/);
  }
  for (const restrictedDestinationPath of ['/auth', '/sso', '/log%69n', '/bad%ZZ']) {
    const url = `https://product.example${restrictedDestinationPath}`;
    assert.match(await validateConfirmed({
      ...item,
      links: [{ ...link, redirect_evidence: {
        ...redirectEvidence,
        destination: { ...redirectEvidence.destination, url },
      } }],
    }, { browserFallback: true, kit }), /redirect destination is not a public non-login HTTP URL/);
  }
  assert.match(await validateConfirmed(item, { kit }), /redirect evidence requires browser-fallback/);
  assert.match(await validateConfirmed({ ...item, links: [{ href: link.href, rel: link.rel }] }, { browserFallback: true, kit }), /missing real .* evidence link/);
  assert.match(await validateConfirmed({ ...item, links: [{ ...link, rel: undefined }] }, { browserFallback: true, kit }), /missing explicit rel/);
  assert.match(await validateConfirmed({ ...item, browser_evidence: { ...item.browser_evidence, provider: 'other' } }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  assert.match(await validateConfirmed({ ...item, browser_evidence: { ...item.browser_evidence, observed_at: undefined } }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  assert.match(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: { destination: redirectEvidence.destination } }] }, { browserFallback: true, kit }), /include source and destination/);
  assert.match(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: { source: redirectEvidence.source } }] }, { browserFallback: true, kit }), /include source and destination/);

  for (const [sourceAt, destinationAt] of [
    ['2026-10-14T02:00:00+05:30', '2026-10-13T20:30:01Z'],
    ['2026-10-14T02:00:00+00:30', '2026-10-14T01:30:01Z'],
    ['2026-10-14T02:00:00-03:30', '2026-10-14T05:30:01Z'],
    ['2026-10-14T02:00:00+12:45', '2026-10-13T13:15:01Z'],
  ]) {
    assert.equal(await validateConfirmed({
      ...item,
      browser_evidence: { ...item.browser_evidence, observed_at: sourceAt },
      links: [{ ...link, redirect_evidence: {
        source: { ...redirectEvidence.source, observed_at: sourceAt },
        destination: { ...redirectEvidence.destination, observed_at: destinationAt },
      } }],
    }, { browserFallback: true, kit }), null, `valid offset in ${sourceAt}`);
  }
  const invalidEvidence = [
    [{ ...redirectEvidence, source: { ...redirectEvidence.source, href: 'https://directory.example/other' } }, /source href does not match/],
    [{ ...redirectEvidence, source: { ...redirectEvidence.source, myurl: 'https://directory.example/other' } }, /source myurl does not match/],
    [{ ...redirectEvidence, source: { ...redirectEvidence.source, tab_id: 'another-tab' } }, /source tab and observed_at/],
    [{ ...redirectEvidence, source: { ...redirectEvidence.source, observed_at: 'yesterday' } }, /source tab and observed_at/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, provider: 'safari' } }, /observed in a Chrome tab/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, tab_id: 'another-tab' } }, /new-tab redirect destination must bind/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, url: 'https://other.example/' } }, /destination does not match/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, url: 'http://127.0.0.1/' } }, /not a public non-login/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, url: 'https://product.example/login' } }, /not a public non-login/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, observed_at: 'yesterday' } }, /valid observed_at/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, observed_at: undefined } }, /valid observed_at/],
    [{ ...redirectEvidence, destination: { ...redirectEvidence.destination, observed_at: '2026-10-14T01:59:59.000Z' } }, /at or after the source/],
  ];
  for (const [badEvidence, expectedError] of invalidEvidence) {
    assert.match(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: badEvidence }] }, { browserFallback: true, kit }), expectedError);
  }
  assert.match(await validateConfirmed({ ...item, links: [{ ...link, redirect_evidence: {
    ...newTabEvidence,
    destination: {
      ...newTabEvidence.destination,
      opened_from: { ...newTabEvidence.destination.opened_from, href: 'https://directory.example/not-the-anchor' },
    },
  } }] }, { browserFallback: true, kit }), /new-tab redirect destination must bind/);

  for (const rel of ['nofollow', 'ugc', 'sponsored']) {
    const restrictedLink = { ...link, rel };
    assert.equal(await validateConfirmed({ ...item, dofollow: 'No', links: [restrictedLink] }, { browserFallback: true, kit }), null);
    assert.match(await validateConfirmed({ ...item, dofollow: 'Yes', links: [restrictedLink] }, { browserFallback: true, kit }), /dofollow does not match/);
  }
  assert.equal(await validateConfirmed({
    ...item,
    links: [
      { href: kit.website, rel: 'nofollow' },
      { ...link, rel: 'noreferrer' },
    ],
  }, { browserFallback: true, kit }), null);

  const leapSourceAt = '2024-02-29T10:00:00.900+08:00';
  const leapDestinationAt = '2024-02-29T02:00:00.901Z';
  const leapEvidence = {
    ...redirectEvidence,
    source: { ...redirectEvidence.source, observed_at: leapSourceAt },
    destination: { ...redirectEvidence.destination, observed_at: leapDestinationAt },
  };
  assert.equal(await validateConfirmed({
    ...item,
    browser_evidence: { ...item.browser_evidence, observed_at: leapSourceAt },
    links: [{ ...link, redirect_evidence: leapEvidence }],
  }, { browserFallback: true, kit }), null);
  const millisecondSourceAt = '2026-10-14T02:00:00.900Z';
  const highPrecisionSourceAt = '2026-10-14T02:00:00.9009Z';
  assert.match(await validateConfirmed({
    ...item,
    browser_evidence: { ...item.browser_evidence, observed_at: highPrecisionSourceAt },
    links: [{ ...link, redirect_evidence: {
      ...redirectEvidence,
      source: { ...redirectEvidence.source, observed_at: highPrecisionSourceAt },
    } }],
  }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  assert.match(await validateConfirmed({
    ...item,
    browser_evidence: { ...item.browser_evidence, observed_at: millisecondSourceAt },
    links: [{ ...link, redirect_evidence: {
      ...redirectEvidence,
      source: { ...redirectEvidence.source, observed_at: millisecondSourceAt },
      destination: { ...redirectEvidence.destination, observed_at: '2026-10-14T02:00:00.9001Z' },
    } }],
  }, { browserFallback: true, kit }), /valid observed_at/);
  for (const invalidTimestamp of [
    '2026-02-30T02:00:00Z',
    '2023-02-29T02:00:00Z',
    '2026-10-14T25:00:00Z',
    '2026-10-14T02:00:60Z',
    '2026-10-14T02:00:00+08:60',
  ]) {
    assert.match(await validateConfirmed({
      ...item,
      browser_evidence: { ...item.browser_evidence, observed_at: invalidTimestamp },
    }, { browserFallback: true, kit }), /Chrome tab, matching URL/);
  }

  const detail = auditLogDetail(item, 'confirmed', { method: 'browser-fallback', generatedAt: '2026-10-14T02:01:00.000Z' }, kit);
  assert.match(detail, /confirmed_href=https:\/\/directory\.example\/go\/product/);
  assert.match(detail, /rel=noopener noreferrer/);
  assert.match(detail, /links=.*directory\.example\/go\/product.*product\.example/);
  assert.match(detail, /link_evidence=.*source.*observed_at.*2026-10-14T02:00:00\.000Z.*destination.*product\.example.*2026-10-14T02:00:05\.000Z/);

  const exactHref = 'https://directory.example/go/  product';
  const exactRel = 'noopener   noreferrer';
  const exactItem = {
    ...item,
    links: [{
      ...link,
      href: exactHref,
      rel: exactRel,
      redirect_evidence: {
        ...redirectEvidence,
        source: { ...redirectEvidence.source, href: exactHref },
      },
    }],
  };
  const exactDetail = auditLogDetail(exactItem, 'confirmed', {
    method: 'browser-fallback', generatedAt: '2026-10-14T02:01:00.000Z',
  }, kit);
  const appendedLog = appendAutomationLog('', {
    runId: 'redirect-roundtrip',
    event: 'audit:event',
    detail: exactDetail,
    now: new Date('2026-10-14T02:01:00.000Z'),
  });
  const evidenceStart = appendedLog.indexOf('link_evidence=') + 'link_evidence='.length;
  const evidenceEnd = appendedLog.indexOf(' reason=', evidenceStart);
  const recoveredEvidence = JSON.parse(appendedLog.slice(evidenceStart, evidenceEnd));
  assert.equal(recoveredEvidence[0].href, exactHref);
  assert.equal(recoveredEvidence[0].rel, exactRel);
  assert.equal(recoveredEvidence[0].redirect_evidence.source.href, exactHref);
});

test('pending Chrome evidence must have a valid tab, timestamp, and candidate-domain URL', () => {
  const item = {
    category: 'pending',
    record: { record_id: 'rec1', website: 'https://www.directory.example/listing' },
    browser_evidence: {
      provider: 'chrome', tab_id: 'tab-123', url: 'https://directory.example/search', observed_at: '2026-09-26T02:03:00.000Z',
    },
  };
  assert.equal(validatePending(item, { browserFallback: true }), null);
  assert.match(validatePending(item), /Chrome tab, URL, and ISO observed_at/);
  assert.match(validatePending({ ...item, browser_evidence: { ...item.browser_evidence, url: 'https://foreign.example/search' } }, { browserFallback: true }), /does not match the report candidate domain/);
  assert.match(validatePending({ ...item, browser_evidence: { ...item.browser_evidence, observed_at: 'yesterday' } }, { browserFallback: true }), /Chrome tab, URL, and ISO observed_at/);
  assert.match(validatePending({ ...item, record: { record_id: 'rec1' } }, { browserFallback: true }), /missing or invalid candidate website/);
});

test('404 pages cannot be confirmed even when their template links the example product', () => {
  assert.equal(canConfirm({ finalUrl: 'https://example.com/missing', status: 404, links: [{ href: 'https://product.example/', rel: '' }], blocked: false }), false);
  assert.equal(canConfirm({ finalUrl: 'https://example.com/tools/example-product', status: 200, links: [{ href: 'https://product.example/', rel: '' }], blocked: false }), true);
});

test('verifier rejects explicit non-public IPv6 ranges without rejecting public IPv6', () => {
  const check = (finalUrl) => canConfirm({
    finalUrl,
    status: 200,
    links: [{ href: kit.website, rel: '' }],
    blocked: false,
  });
  const nonPublicHosts = [
    '::2', '0:0:0:0:0:0:0:2',
    'fe80::1', 'fe90::1', 'fea0::1', 'febf::1',
    'fec0::1', 'fed0::1', 'feff::1',
    '64:ff9b:1::1', '0064:ff9b:0001:0000:0000:0000:0000:0001',
    '100:0:0:1::1', '0100:0000:0000:0001:0000:0000:0000:0001',
    '2001:2::1', '2001:0002:0000:0000:0000:0000:0000:0001',
    '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001',
    '3fff::1', '3fff:0000:0000:0000:0000:0000:0000:0001',
    '5f00::1', '5f00:0000:0000:0000:0000:0000:0000:0001',
    '100::1', '100:0:0:0::1', '0100:0000:0000:0000:0000:0000:0000:0001',
  ];
  for (const host of nonPublicHosts) {
    assert.equal(check(`https://[${host}]/listing`), false, `${host} must be treated as non-public`);
  }
  for (const publicHost of [
    '2001:4860:4860::8888',
    '2001:1::1',
    '2002:c000:0201::1',
    '64:ff9b::c000:0101',
    '::ffff:c000:0101',
  ]) {
    assert.equal(check(`https://[${publicHost}]/listing`), true, `${publicHost} must remain public`);
  }
});

test('verifier rejects local DNS root-dot hostnames and keeps public root-dot domains', () => {
  const check = (finalUrl) => canConfirm({
    finalUrl,
    status: 200,
    links: [{ href: kit.website, rel: '' }],
    blocked: false,
  });
  for (const url of [
    'https://localhost./tools/example-product',
    'https://host.localhost./tools/example-product',
    'https://host.local./tools/example-product',
    'https://127.0.0.1./tools/example-product',
  ]) {
    assert.equal(check(url), false, `${url} must be treated as non-public`);
  }
  assert.equal(check('https://example.com./tools/example-product'), true);
});

test('verifier blocks the exact 192.0.0.0/24 and documentation IPv4 ranges while preserving global exceptions', () => {
  const check = (finalUrl) => canConfirm({
    finalUrl,
    status: 200,
    links: [{ href: kit.website, rel: '' }],
    blocked: false,
  });
  for (const address of ['192.0.0.8', '192.0.0.170', '192.0.0.171', '192.0.2.1']) {
    assert.equal(check(`https://${address}/listing`), false, `${address} must be treated as non-public`);
  }
  for (const address of ['192.0.1.1', '192.0.0.9', '192.0.0.10']) {
    assert.equal(check(`https://${address}/listing`), true, `${address} must remain public`);
  }
});

test('attribute and inert-content lookalikes are not treated as public links', async () => {
  const html = [
    '<div data-href="https://product.example/">not a link</div>',
    '<a data-href="https://product.example/">also not a link</a>',
    '<script>const fake = `<a href="https://product.example/">fake</a>`;</script>',
    '<template><a href="https://product.example/">fake</a></template>',
    '<textarea><a href="https://product.example/">fake</a></textarea>',
    '<title><a href="https://product.example/">fake</a></title>',
    '<a href="https://example.com/real">real</a>',
  ].join('');
  assert.deepEqual(anchors(html, 'https://example.com').map((link) => link.href), ['https://example.com/real']);
});

test('challenge detection requires challenge-page evidence', () => {
  assert.equal(detectSecurityChallenge('<p>We use Cloudflare analytics and discuss captcha privacy.</p>'), false);
  assert.equal(detectSecurityChallenge('<p>challenge-platform is mentioned in this help article.</p>'), false);
  assert.equal(detectSecurityChallenge('<a href="/cdn-cgi/challenge-platform/reference">challenge-platform docs</a>'), false);
  assert.equal(detectSecurityChallenge('<script>const path = "/cdn-cgi/challenge-platform/x.js";</script>'), false);
  assert.equal(detectSecurityChallenge('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><main>Normal page</main>'), false);
  assert.equal(detectSecurityChallenge('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'), false);
  assert.equal(detectSecurityChallenge('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script>'), false);
  assert.equal(detectSecurityChallenge('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc"></script>'), true);
  assert.equal(detectSecurityChallenge('<title>Just a moment...</title>'), false);
  assert.equal(detectSecurityChallenge('<main>Normal page</main><footer><div class="g-recaptcha"></div></footer>'), false);
  assert.equal(detectSecurityChallenge('<main>Normal page</main><footer><div class="cf-turnstile"></div></footer>'), false);
  assert.equal(classifySecurityChallenge('<h1>Verify you are human</h1><div class="g-recaptcha"></div>'), 'captcha');
  assert.equal(classifySecurityChallenge('<h1>About CAPTCHA</h1><p>We explain how Cloudflare works.</p>'), null);
  assert.equal(classifySecurityChallenge('<script>const copy = "Verify you are human; challenge-platform";</script>'), null);
});

test('any real dofollow link wins over another nofollow link', () => {
  assert.equal(dofollowForLinks([{ rel: 'nofollow' }, { rel: '' }]), 'Yes');
  assert.equal(dofollowForLinks([{ rel: 'ugc nofollow' }, { rel: 'sponsored' }]), 'No');
});

test('public listing must stay on the Base record domain', () => {
  assert.equal(sameSiteDomain('https://www.linktr.ee/', 'https://linktr.ee/example-product'), true);
  assert.equal(sameSiteDomain('https://community.sanity.tools/', 'https://www.sanity.io/exchange/community/levwy'), true);
  assert.equal(sameSiteDomain('https://community.sanity.tools/', 'https://www.sanity.io/other/levwy'), false);
  assert.equal(sameSiteDomain('https://cal.com/', 'https://linktr.ee/example-product'), false);
});

test('verifier stops before redirect and later records when the shared circuit opens mid-run', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-fetch-circuit-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const circuitDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    await writeFile(circuitPath, JSON.stringify({ date: circuitDate, open: false, reason: null, events: [] }));
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      await writeFile(circuitPath, JSON.stringify({ date: circuitDate, open: true, reason: 'external_rate_limit', events: [] }));
      return {
        ok: false,
        status: 302,
        url: String(url),
        headers: { get: (name) => name.toLowerCase() === 'location' ? '/redirected' : null },
        text: async () => '',
      };
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-first', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/start' },
      { record_id: 'rec-second', website: 'https://1.0.0.2/', myurl: 'https://1.1.1.2/start' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/start']);
    assert.equal(results[0].category, 'needs_attention');
    assert.equal(results[0].checks[0].blockType, null);
    assert.equal(results[0].checks[0].circuitStopReason, 'external_rate_limit');
    assert.equal(results[1].reason, 'Audit stopped before navigation by global safety circuit: external_rate_limit.');
    assert.deepEqual(results[1].checks, []);
    assert.equal(circuit.stopReason, 'external_rate_limit');
    assert.equal(persistentCircuit.events.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('one security block skips later records on the same normalized host but permits other hosts', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-domain-block-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/first') return mockResponse(url, { status: 403 });
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-blocked', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-same-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/second' },
      { record_id: 'rec-other-host', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.0.0.1/listing']);
    assert.equal(results[0].category, 'needs_attention');
    assert.equal(results[1].category, 'needs_attention');
    assert.deepEqual(results[1].checks, []);
    assert.equal(results[2].category, 'confirmed');
    assert.equal(persistentCircuit.open, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('normal 200 page with Cloudflare JSD asset does not block and permits another same-host probe', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-cloudflare-jsd-200-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return mockResponse(url, {
        status: 200,
        body: `<title>Directory</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><a href="${kit.website}">${kit.name}</a>`,
      });
    };

    const { results, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-jsd-first', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-jsd-same-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/second' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.1.1.1/second']);
    assert.equal(results[0].checks[0].status, 200);
    assert.equal(results[0].checks[0].blockType, null);
    assert.equal(results[0].category, 'confirmed');
    assert.equal(results[1].category, 'confirmed');
    assert.equal(persistentCircuit.events.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cloudflare challenge on a 403 response is recorded separately and does not stop other hosts', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-cloudflare-403-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/first') {
        return mockResponse(url, {
          status: 403,
          body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc"></script><div id="cf-challenge-running">Checking your browser</div>',
        });
      }
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-cloudflare', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-same-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/second' },
      { record_id: 'rec-other-host', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.0.0.1/listing']);
    assert.equal(results[0].category, 'needs_attention');
    assert.equal(results[0].checks[0].status, 403);
    assert.equal(results[0].checks[0].blockType, 'cloudflare');
    assert.equal(results[1].category, 'needs_attention');
    assert.deepEqual(results[1].checks, []);
    assert.equal(results[2].category, 'confirmed');
    assert.equal(circuit.stopReason, null);
    assert.equal(persistentCircuit.events.length, 1);
    assert.equal(persistentCircuit.events[0].type, 'cloudflare');
    assert.equal(persistentCircuit.open, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('cf-mitigated challenge header classifies inline 403 and 200 pages as host-only Cloudflare blocks', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-cf-mitigated-header-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;
  const inlineChallenge = '<title>Just a moment...</title><script>window._cf_chl_opt={};location.href="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc";</script><div id="cf-challenge-running">Checking your browser</div>';

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/challenge-403') {
        return mockResponse(url, { status: 403, cfMitigated: 'challenge', body: inlineChallenge });
      }
      if (requested === 'https://1.0.0.2/challenge-200') {
        return mockResponse(url, { status: 200, cfMitigated: 'challenge', body: inlineChallenge });
      }
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-cf-header-403', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/challenge-403' },
      { record_id: 'rec-cf-header-403-same-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/skip-403-host' },
      { record_id: 'rec-cf-header-403-other-host', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/continue-403' },
      { record_id: 'rec-cf-header-200', website: 'https://1.0.0.2/', myurl: 'https://1.0.0.2/challenge-200' },
      { record_id: 'rec-cf-header-200-same-host', website: 'https://1.0.0.2/', myurl: 'https://1.0.0.2/skip-200-host' },
      { record_id: 'rec-cf-header-200-other-host', website: 'https://1.0.0.3/', myurl: 'https://1.0.0.3/continue-200' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, [
      'https://1.1.1.1/challenge-403',
      'https://1.0.0.1/continue-403',
      'https://1.0.0.2/challenge-200',
      'https://1.0.0.3/continue-200',
    ]);
    assert.equal(results[0].checks[0].blockType, 'cloudflare');
    assert.equal(results[0].checks[0].status, 403);
    assert.deepEqual(results[1].checks, []);
    assert.equal(results[2].category, 'confirmed');
    assert.equal(results[3].checks[0].blockType, 'cloudflare');
    assert.equal(results[3].checks[0].status, 200);
    assert.deepEqual(results[4].checks, []);
    assert.equal(results[5].category, 'confirmed');
    assert.equal(circuit.stopReason, null);
    assert.deepEqual(persistentCircuit.events.map((event) => event.type), ['cloudflare', 'cloudflare']);
    assert.equal(persistentCircuit.open, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('distinct real 403 hosts are skipped while other hosts continue', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-403-challenge-keyword-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;
  const ordinaryForbiddenPage = [
    '<title>Access denied</title>',
    '<p>The challenge-platform route is documented here.</p>',
    '<a href="/cdn-cgi/challenge-platform/reference">reference</a>',
    '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
    '<script>const note = "challenge-platform is unrelated to this error";</script>',
  ].join('');

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/first' || requested === 'https://1.0.0.1/second') {
        return mockResponse(url, { status: 403, body: ordinaryForbiddenPage });
      }
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-ordinary-403-a', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-ordinary-403-b', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/second' },
      { record_id: 'rec-same-403-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/retry' },
      { record_id: 'rec-after-403-hosts', website: 'https://1.0.0.2/', myurl: 'https://1.0.0.2/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.0.0.1/second', 'https://1.0.0.2/listing']);
    assert.equal(results[0].checks[0].blockType, 'forbidden_403');
    assert.equal(results[1].checks[0].blockType, 'forbidden_403');
    assert.equal(results[2].checks.length, 0);
    assert.match(results[2].reason, /after a real non-verification 403 today/);
    assert.equal(results[3].category, 'confirmed');
    assert.equal(circuit.stopReason, null);
    assert.deepEqual(persistentCircuit.events.map((event) => event.type), ['forbidden_403', 'forbidden_403']);
    assert.deepEqual(persistentCircuit.events.map((event) => event.domain), ['1.1.1.1', '1.0.0.1']);
    assert.equal(persistentCircuit.open, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh circuit checks stop later same-host requests within a record after an external 403 and allow other hosts', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-fresh-403-mid-record-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/first') {
        await recordPersistentCircuitEvent(
          { type: 'forbidden_403', domain: '1.1.1.1', record_id: 'rec-external-403' },
          { circuitPath, lockPath },
        );
        return mockResponse(url, { body: '<title>Public listing</title>' });
      }
      if (requested === 'https://1.0.0.2/listing') {
        return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
      }
      return mockResponse(url);
    };

    const { results, circuit } = await verifyRecords([
      {
        record_id: 'rec-mid-record-block',
        website: 'https://1.1.1.1/',
        myurl: 'https://1.1.1.1/first',
        notes: 'Another listing path: https://1.1.1.1/second',
      },
      { record_id: 'rec-other-host', website: 'https://1.0.0.2/', myurl: 'https://1.0.0.2/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.0.0.2/listing']);
    assert.equal(results[0].category, 'needs_attention');
    assert.equal(results[0].checks.length, 2);
    assert.ok(results[0].checks[1].batchBlockedDomain);
    assert.equal(results[1].category, 'confirmed');
    assert.equal(circuit.stopReason, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh circuit checks block an externally 403-locked redirect target before fetch and continue other hosts', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-fresh-403-redirect-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.0.0.1/start') {
        await recordPersistentCircuitEvent(
          { type: 'forbidden_403', domain: '1.1.1.2', record_id: 'rec-external-redirect-403' },
          { circuitPath, lockPath },
        );
        return mockResponse(url, { status: 302, location: 'https://1.1.1.2/locked-target' });
      }
      if (requested === 'https://1.0.0.3/listing') {
        return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
      }
      return mockResponse(url);
    };

    const { results, circuit } = await verifyRecords([
      { record_id: 'rec-redirect-to-locked-host', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/start' },
      { record_id: 'rec-other-host', website: 'https://1.0.0.3/', myurl: 'https://1.0.0.3/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.0.0.1/start', 'https://1.0.0.3/listing']);
    assert.equal(results[0].category, 'needs_attention');
    assert.ok(results[0].checks[0].batchBlockedDomain);
    assert.equal(results[1].category, 'confirmed');
    assert.equal(circuit.stopReason, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('403 response body read errors preserve the block and skip only its host', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-403-body-error-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;
  let responseHeadersRead = false;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/first') {
        return {
          ...mockResponse(url, { status: 403, textError: new Error('403 body read failed') }),
          headers: { get: (name) => {
            if (name.toLowerCase() === 'location') responseHeadersRead = true;
            return null;
          } },
        };
      }
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-blocked', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-same-host', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/second' },
      { record_id: 'rec-other-host', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first', 'https://1.0.0.1/listing']);
    assert.equal(responseHeadersRead, true);
    assert.equal(results[0].checks[0].status, 403);
    assert.equal(results[0].checks[0].finalUrl, 'https://1.1.1.1/first');
    assert.equal(results[0].checks[0].error, '403 body read failed');
    assert.equal(results[0].checks[0].blockType, 'forbidden_403');
    assert.equal(results[1].checks.length, 0);
    assert.equal(results[2].category, 'confirmed');
    assert.equal(persistentCircuit.open, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy repeated 403 state skips its recorded domain and audits a different host', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-legacy-403-domain-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;
  const now = new Date();
  const legacy = updateCircuit(null, { type: 'forbidden_403', domain: '1.1.1.1', record_id: 'rec-old-a' }, now);
  await writeCircuit(circuitPath, {
    ...legacy,
    open: true,
    reason: 'repeated_security_blocks',
    events: [
      ...legacy.events,
      { type: 'forbidden_403', domain: '1.0.0.1', record_id: 'rec-old-b', at: now.toISOString() },
    ],
  });

  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
    };

    const { results, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-retry-blocked', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/retry' },
      { record_id: 'rec-other-host', website: 'https://1.0.0.2/', myurl: 'https://1.0.0.2/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.0.0.2/listing']);
    assert.match(results[0].reason, /after a real non-verification 403 today/);
    assert.equal(results[1].category, 'confirmed');
    assert.equal(persistentCircuit.open, false);
    assert.deepEqual(persistentCircuit.events.map((event) => event.record_id), ['rec-old-a', 'rec-old-b']);
    assert.deepEqual(persistentCircuit.events.map((event) => event.domain), ['1.1.1.1', '1.0.0.1']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('429 response body read errors preserve status and stop the batch', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-429-body-error-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return mockResponse(url, { status: 429, textError: new Error('429 body read failed') });
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-rate-limited', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-after-limit', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first']);
    assert.equal(results[0].checks[0].status, 429);
    assert.equal(results[0].checks[0].finalUrl, 'https://1.1.1.1/first');
    assert.equal(results[0].checks[0].error, '429 body read failed');
    assert.equal(results[0].checks[0].blockType, 'rate_limit_429');
    assert.match(results[1].reason, /global safety circuit: rate_limit_429/);
    assert.equal(circuit.stopReason, 'rate_limit_429');
    assert.equal(persistentCircuit.open, true);
    assert.equal(persistentCircuit.reason, 'rate_limit_429');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('429 keeps immediate rate-limit priority even with a Cloudflare challenge header', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-429-cloudflare-priority-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return mockResponse(url, {
        status: 429,
        cfMitigated: 'challenge',
        body: '<title>Just a moment...</title><script>window._cf_chl_opt={};location.href="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc";</script>',
      });
    };

    const { results, circuit, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-429-cloudflare', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/first' },
      { record_id: 'rec-after-429', website: 'https://1.0.0.1/', myurl: 'https://1.0.0.1/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.1.1.1/first']);
    assert.equal(results[0].checks[0].blockType, 'rate_limit_429');
    assert.match(results[1].reason, /global safety circuit: rate_limit_429/);
    assert.equal(circuit.stopReason, 'rate_limit_429');
    assert.deepEqual(persistentCircuit.events.map((event) => event.type), ['rate_limit_429']);
    assert.equal(persistentCircuit.open, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('blocked redirect hosts are skipped and unrelated notes URLs are not probed', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-redirect-domain-block-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.1.1.1/start') {
        return mockResponse(url, { status: 302, location: 'https://1.1.1.2/blocked-source' });
      }
      if (requested === 'https://1.1.1.2/blocked-source') return mockResponse(url, { status: 403 });
      if (requested === 'https://1.0.0.2/start') {
        return mockResponse(url, { status: 302, location: 'https://1.1.1.2/should-not-fetch' });
      }
      if (requested === 'https://1.0.0.3/listing') {
        return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
      }
      return mockResponse(url);
    };

    const { results, persistentCircuit } = await verifyRecords([
      { record_id: 'rec-redirect-block', website: 'https://1.1.1.1/', myurl: 'https://1.1.1.1/start' },
      {
        record_id: 'rec-redirect-skipped',
        website: 'https://1.0.0.2/',
        myurl: 'https://1.0.0.2/start',
        notes: 'Unrelated reference: https://1.1.1.2/unrelated-reference',
      },
      { record_id: 'rec-other-host', website: 'https://1.0.0.3/', myurl: 'https://1.0.0.3/listing' },
    ], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, [
      'https://1.1.1.1/start',
      'https://1.1.1.2/blocked-source',
      'https://1.0.0.2/start',
      'https://1.0.0.3/listing',
    ]);
    assert.equal(results[0].category, 'needs_attention');
    assert.equal(results[1].category, 'needs_attention');
    assert.ok(results[1].checks[0].batchBlockedDomain);
    assert.equal(results[2].category, 'confirmed');
    assert.equal(persistentCircuit.open, false);
    assert.equal(persistentCircuit.events[0].domain, '1.1.1.2');
    assert.deepEqual(persistentCircuit.events[0].domains, ['1.1.1.1', '1.1.1.2']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('notes URL probing stays within the candidate same-site scope', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-note-scope-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  const lockPath = join(dir, 'base-write.lock');
  const requests = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const requested = String(url);
      requests.push(requested);
      if (requested === 'https://1.0.0.4/') {
        return mockResponse(url, { body: `<a href="${kit.website}">${kit.name}</a>` });
      }
      return mockResponse(url);
    };

    const { results } = await verifyRecords([{
      record_id: 'rec-note-scope',
      website: 'https://1.0.0.4/',
      myurl: 'https://1.0.0.4/listing',
      notes: 'Reference: https://1.0.0.5/unrelated',
    }], kit, { circuitPath, lockPath });

    assert.deepEqual(requests, ['https://1.0.0.4/listing', 'https://1.0.0.4/']);
    assert.equal(results[0].category, 'confirmed');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistent audit circuit retains 403 domains and stops immediately on 429', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-circuit-'));
  const cloudflarePath = join(dir, 'cloudflare.json');
  const mixedPath = join(dir, 'mixed.json');
  const rateLimitPath = join(dir, 'rate-limit.json');
  const captchaPath = join(dir, 'captcha.json');
  const at = new Date('2026-07-13T01:00:00.000Z');
  const persist = (path, type, now, domain = `${type}.example`) => recordPersistentCircuitEvent(
    { type, record_id: type, domain },
    { circuitPath: path, lockPath: `${path}.lock`, now },
  );

  try {
    for (const path of [cloudflarePath, mixedPath, rateLimitPath, captchaPath]) await writeCircuit(path, {date:'2026-07-13',open:false,reason:null,events:[]});
    await persist(cloudflarePath, 'cloudflare', at);
    const cloudflareTwice = await persist(cloudflarePath, 'cloudflare', new Date(at.getTime() + 5 * 60_000));
    assert.equal(cloudflareTwice.events.length, 2);
    assert.equal(cloudflareTwice.open, false);

    await persist(mixedPath, 'cloudflare', at);
    const mixed = await persist(mixedPath, 'forbidden_403', new Date(at.getTime() + 5 * 60_000));
    assert.equal(mixed.events.length, 2);
    assert.equal(mixed.open, false);
    assert.deepEqual(mixed.events.filter((event) => event.type === 'forbidden_403').map((event) => event.domain), ['forbidden_403.example']);
    const another403 = await persist(mixedPath, 'forbidden_403', new Date(at.getTime() + 30 * 60_000), 'later.example');
    assert.equal(another403.events.length, 3);
    assert.equal(another403.open, false);
    assert.deepEqual(another403.events.filter((event) => event.type === 'forbidden_403').map((event) => event.domain), ['forbidden_403.example', 'later.example']);

    const rateLimited = await persist(rateLimitPath, 'rate_limit_429', at);
    assert.equal(rateLimited.open, true);
    assert.equal(rateLimited.reason, 'rate_limit_429');

    const captcha = await persist(captchaPath, 'captcha', at);
    assert.equal(captcha.open, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt circuit state fails closed and writes are valid JSON', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-audit-circuit-'));
  const circuitPath = join(dir, 'circuit.json');
  await writeCircuit(circuitPath, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), open: false, reason: null, events: [] });
  await rm(circuitPath);
  const missing=await readCircuit(circuitPath);
  assert.equal(missing.open,true);
  assert.equal(missing.reason,'circuit_state_unreadable');
  assert.throws(()=>updateCircuit(missing,{type:'cloudflare'}),/Restore the durable circuit/);
  await writeFile(circuitPath, '{broken');
  assert.equal((await readCircuit(circuitPath)).open, true);
  await writeCircuit(circuitPath, { date: '2026-07-13', open: false, reason: null, events: [] });
  assert.equal(JSON.parse(await readFile(circuitPath, 'utf8')).open, false);
  await rm(dir, { recursive: true, force: true });
});
