import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './kit-config.mjs';

import {
  assertCircuitDomainAvailable,
  assertCheckpointCircuitClosed,
  assertPatchReadback,
  assertResumeCheckpoint,
  assertCheckpointTransition,
  assertFreshClaimRun,
  appendAutomationLog,
  buildCheckpointPatch,
  canClaim,
  checkpointDetail,
  formatDateTime,
  intakePatch,
  metricPatch,
  normalizeCircuitDomain,
  parseInputJsonOptions,
  reopenPatch,
  finishEvent,
  resumeEvent,
  RECORD_FIELDS,
  readCircuit,
  terminalBaseNotePatch,
  terminalPatch,
  terminalRetryPatch,
  updateCircuit,
  writeCircuit,
  waitForReadback,
  withFileLock,
} from './run-state.mjs';

const kitPath = join(repositoryRoot(), 'projects', 'example', 'kit.json');
const kitEnv = { ...process.env, BACKLINK_KIT_PATH: kitPath };
const projectTmp = join(repositoryRoot(), 'tmp');
await mkdir(projectTmp, { recursive: true });

test('Base datetimes use Singapore wall-clock time', () => {
  assert.equal(formatDateTime(new Date('2026-07-11T05:07:10.000Z')), '2026-07-11 13:07:10');
});

test('claim rejects already submitted or successful records', () => {
  assert.equal(canClaim({ status: ['submited'], automation_state: 'ready' }), false);
  assert.equal(canClaim({ status: ['submitted'], automation_state: 'ready' }), false);
  assert.equal(canClaim({ status: ['succeed'], automation_state: 'ready' }), false);
  assert.equal(canClaim({ status: ['declined'], automation_state: null }), false);
  assert.equal(canClaim({ status: ['ignored'], automation_state: null }), false);
  assert.equal(canClaim({ status: [], automation_state: 'ready', blocker_type: 'submit_unknown' }), false);
  assert.equal(canClaim({ status: [], automation_state: null, checkpoint: 'submit_click_started' }), false);
  assert.equal(canClaim({ status: [], automation_state: 'ready', checkpoint: 'submit_result_recorded' }), false);
  assert.equal(canClaim({ status: [], automation_state: 'ready' }), false);
  assert.equal(canClaim({ status: ['待提交'], automation_state: 'ready' }), true);
  assert.equal(canClaim({ status: ['待核验'] }), false);
  assert.equal(canClaim({ status: ['受阻：人工处理'] }), false);
});

test('local writer lock waits once and succeeds after release', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-lock-'));
  const lock = join(dir, 'base-write.lock');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = withFileLock(lock, async () => held);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = withFileLock(lock, async () => 'second', { waitMs: 20 });
  setTimeout(release, 5);
  assert.equal(await second, 'second');
  await first;
  await rm(dir, { recursive: true, force: true });
});

test('local writer lock stops after the second collision', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-lock-'));
  const lock = join(dir, 'base-write.lock');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = withFileLock(lock, async () => held);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(withFileLock(lock, async () => {}, { waitMs: 5 }), /after 2 attempts/);
  release();
  await first;
  await rm(dir, { recursive: true, force: true });
});

test('automation log is idempotent and rejects changed evidence', () => {
  const event = { runId: 'run-1', event: 'checkpoint:form_ready', detail: 'Chrome metrics checked.', now: new Date('2026-07-11T05:07:10.000Z') };
  const first = appendAutomationLog('', event);
  assert.match(first, /run_id=run-1 event=checkpoint:form_ready/);
  assert.equal(appendAutomationLog(first, event), first);
  assert.throws(
    () => appendAutomationLog(first, { ...event, detail: 'Different evidence.' }),
    /different evidence/,
  );
});

test('automation log rejects multi-line run IDs and events', () => {
  assert.throws(
    () => appendAutomationLog('', { runId: 'run-1\n[2026-08-31] run_id=spoof', event: 'claimed' }),
    /single-line token/,
  );
  assert.throws(() => appendAutomationLog('', { runId: 'run-1', event: 'claimed\nspoof' }), /single-line token/);
});

test('automation log ignores matching text inside evidence', () => {
  const first = appendAutomationLog('', {
    runId: 'run-1',
    event: 'claimed',
    detail: 'operator wrote run_id=run-1 event=checkpoint:form_ready in evidence',
  });
  const next = appendAutomationLog(first, {
    runId: 'run-1',
    event: 'checkpoint:form_ready',
    detail: 'metrics checked',
  });
  assert.match(next, /event=claimed/);
  assert.match(next, /event=checkpoint:form_ready detail=metrics checked/);
});

test('input JSON preserves literal shell-sensitive text and rejects unknown or conflicting keys', () => {
  const evidence = 'Price is $5; literal $(command) and `backticks` stay text.';
  assert.deepEqual(
    parseInputJsonOptions(JSON.stringify({ result: 'ignore', evidence, 'base-note': 'skip: $5' }), { command: 'finish' }),
    { result: 'ignore', evidence, 'base-note': 'skip: $5' },
  );
  assert.deepEqual(
    parseInputJsonOptions('{"evidence":"new path","base-note":"原申请仍保留，已找到免费入口。","yes":true}', { command: 'reopen' }),
    { evidence: 'new path', 'base-note': '原申请仍保留，已找到免费入口。', yes: true },
  );
  assert.throws(
    () => parseInputJsonOptions('{"surprise":"x"}', { command: 'finish' }),
    /Unknown --input-json field/,
  );
  assert.throws(
    () => parseInputJsonOptions('{"next-action-at":"2026-10-10"}', { command: 'finish' }),
    /Unknown --input-json field/,
  );
  assert.throws(
    () => parseInputJsonOptions('{"evidence":"from json"}', { command: 'finish', cliArgs: ['--evidence', 'from cli'] }),
    /Conflicting input/,
  );
  assert.throws(
    () => parseInputJsonOptions('{"yes":"true"}', { command: 'resume' }),
    /must be boolean/,
  );
  assert.throws(
    () => parseInputJsonOptions('{"evidence":null}', { command: 'finish' }),
    /must be a string or finite number/,
  );
  assert.deepEqual(
    parseInputJsonOptions('{"dr-unavailable":true,"traffic-unavailable":false}', { command: 'checkpoint' }),
    { 'dr-unavailable': true, 'traffic-unavailable': false },
  );
});

test('--input-json - rejects shared runtime path overrides', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-state.mjs', import.meta.url)), 'circuit-check', '--input-json', '-'],
    { input: JSON.stringify({ 'circuit-file': join(projectTmp, 'backlink-circuit.json') }), encoding: 'utf8', env: kitEnv },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown --input-json field/);
});

test('intake defaults new rows to pending submission without setting a synthetic date', () => {
  const patch = intakePatch({ website: 'https://example.com', notes: 'source note', submitUrl: 'https://example.com/submit' });
  assert.deepEqual(patch, {
    website: 'https://example.com',
    status: '待提交',
    notes: 'source note',
    submit_url: 'https://example.com/submit',
  });
  assert.equal(Object.hasOwn(patch, 'date'), false);
});

test('business projection excludes metrics and internal execution fields', () => {
  assert.ok(RECORD_FIELDS.includes('URL'));
  assert.ok(RECORD_FIELDS.includes('link_type'));
  for (const field of ['DR','Traffic (k)','automation_state','checkpoint','automation_log']) assert.equal(RECORD_FIELDS.includes(field), false);
});

test('removed finish scheduling option fails explicitly', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./run-state.mjs', import.meta.url)),
    'finish', '--next-action-at', '2026-10-10',
  ], { encoding: 'utf8', env: kitEnv });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--next-action-at was removed/);
});

test('a reopened record cannot reuse its earlier claim run ID', () => {
  const log = appendAutomationLog('', { runId: 'run-1', event: 'claimed' });
  assert.throws(() => assertFreshClaimRun(log, 'run-1'), /already claimed/);
  assert.doesNotThrow(() => assertFreshClaimRun(log, 'run-2'));
});

test('repeated blocked and resume transitions get distinct, retry-safe audit events', () => {
  let log = appendAutomationLog('', { runId: 'run-1', event: 'claimed' });
  const firstFinish = finishEvent(log, { runId: 'run-1', result: 'blocked' });
  assert.equal(firstFinish, 'finish:blocked:1');
  log = appendAutomationLog(log, { runId: 'run-1', event: firstFinish, detail: 'login needed' });
  assert.equal(finishEvent(log, { runId: 'run-1', result: 'blocked', terminalRetry: true }), firstFinish);
  const firstResume = resumeEvent(log, 'run-1');
  assert.equal(firstResume, 'resumed:1');
  log = appendAutomationLog(log, { runId: 'run-1', event: firstResume, detail: 'user approved' });
  assert.equal(resumeEvent(log, 'run-1'), firstResume);
  const secondFinish = finishEvent(log, { runId: 'run-1', result: 'blocked' });
  assert.equal(secondFinish, 'finish:blocked:2');
  log = appendAutomationLog(log, { runId: 'run-1', event: secondFinish, detail: 'login expired again' });
  assert.equal(resumeEvent(log, 'run-1'), 'resumed:2');
});

test('running post-click records cannot use the resume shortcut', () => {
  for (const checkpoint of ['submit_click_started', 'submit_result_recorded']) {
    assert.throws(() => assertResumeCheckpoint({ automation_state: 'running', checkpoint }), /Cannot resume after final submit/);
  }
  assert.throws(() => assertResumeCheckpoint({ automation_state: 'running', checkpoint: 'pre_submit_verified', blocker_type: 'submit_unknown' }), /submit outcome is unknown/);
  assert.throws(() => assertResumeCheckpoint({ automation_state: 'manual_review', checkpoint: 'submit_click_started', blocker_type: 'submit_unknown' }), /submit outcome is unknown/);
  for (const checkpoint of [undefined, null, '', 'unknown']) {
    assert.throws(() => assertResumeCheckpoint({ automation_state: 'blocked', checkpoint }), /missing or unknown checkpoint/);
  }
  assert.throws(() => assertResumeCheckpoint(null), /missing or unknown checkpoint/);
  assert.doesNotThrow(() => assertResumeCheckpoint({ automation_state: 'running', checkpoint: 'pre_submit_verified' }));
  assert.throws(
    () => assertResumeCheckpoint({ automation_state: 'blocked', checkpoint: 'public_precheck_done', blocker_type: 'forbidden_403' }),
    /Cannot resume after a real 403 block/,
  );
  for (const blocker_type of ['cloudflare', 'captcha']) {
    assert.doesNotThrow(() => assertResumeCheckpoint({ automation_state: 'blocked', checkpoint: 'public_precheck_done', blocker_type }));
  }
});

test('checkpoint progression is monotonic and cannot skip', () => {
  assert.doesNotThrow(() => assertCheckpointTransition('claimed', 'public_precheck_done'));
  assert.throws(() => assertCheckpointTransition('claimed', 'form_ready'), /cannot skip/);
  assert.throws(() => assertCheckpointTransition('form_ready', 'claimed'), /cannot move backward/);
  for (const current of [undefined, null, '', 'unknown']) {
    assert.throws(() => assertCheckpointTransition(current, 'submit_click_started'), /missing or unknown checkpoint/);
  }
});

test('form_ready does not require a metrics check or claim one when skipped', () => {
  assert.equal(checkpointDetail({ checkpoint: 'form_ready' }), '');
  assert.equal(checkpointDetail({ checkpoint: 'form_ready', detail: 'Form visible.' }), 'Form visible.');
  assert.equal(
    checkpointDetail({ checkpoint: 'form_ready', metricsCheckedInChrome: true }),
    'Chrome DR/Traffic checked.',
  );
  assert.equal(
    checkpointDetail({ checkpoint: 'form_ready', detail: 'Form visible.', metricsCheckedInChrome: true }),
    'Form visible. Chrome DR/Traffic checked.',
  );
  assert.equal(checkpointDetail({ checkpoint: 'public_precheck_done', detail: 'No valid path.' }), 'No valid path.');
});

test('submitted requires a recorded result and explicit evidence', () => {
  assert.throws(() => terminalPatch({ result: 'submitted', checkpoint: 'pre_submit_verified', evidence: 'ok' }), /submit_result_recorded/);
  assert.throws(() => terminalPatch({ result: 'submitted', checkpoint: 'submit_click_started', evidence: 'Submission received' }), /submit_result_recorded/);
  assert.throws(() => terminalPatch({ result: 'submitted', checkpoint: 'submit_result_recorded', evidence: '' }), /explicit confirmation/);
  assert.throws(() => terminalPatch({ result: 'submitted', reason: 'ip_rate_limit', checkpoint: 'submit_result_recorded', evidence: 'Submission received' }), /cannot include a blocker_type/);
  assert.throws(() => terminalPatch({ result: 'submitted', reason: ' ', checkpoint: 'submit_result_recorded', evidence: 'Submission received' }), /cannot include a blocker_type/);
  const patch = terminalPatch({
    result: 'submitted',
    checkpoint: 'submit_result_recorded',
    evidence: 'Submission received',
    now: new Date('2026-07-18T12:34:56.000Z'),
  });
  assert.equal(patch.status, '待核验');
  assert.equal(Object.hasOwn(patch, 'date'), false);
  assert.equal(patch.automation_state, 'submitted');
  assert.equal(patch.checkpoint, 'submit_result_recorded');
  assert.equal(Object.hasOwn(patch, 'next_action_at'), false);
  assert.equal(terminalPatch({ result: 'submitted', checkpoint: 'submit_result_recorded', evidence: 'Submission received' }).checkpoint, 'submit_result_recorded');
});

test('terminal updates require a known checkpoint and unknown submit outcomes require post-click review', () => {
  for (const checkpoint of [undefined, null, '', 'unknown']) {
    assert.throws(
      () => terminalPatch({ result: 'blocked', reason: 'cloudflare', checkpoint, evidence: 'challenge remained visible' }),
      /requires a known checkpoint/,
    );
  }
  assert.throws(
    () => terminalPatch({ result: 'manual_review', reason: 'submit_unknown', checkpoint: 'pre_submit_verified', evidence: 'No receipt' }),
    /submit_unknown requires manual_review at a post-click checkpoint/,
  );
  assert.throws(
    () => terminalPatch({ result: 'blocked', reason: 'submit_unknown', checkpoint: 'submit_click_started', evidence: 'No receipt' }),
    /submit_unknown requires manual_review at a post-click checkpoint/,
  );
  assert.equal(
    terminalPatch({ result: 'manual_review', reason: 'submit_unknown', checkpoint: 'submit_click_started', evidence: 'No receipt' }).checkpoint,
    'submit_result_recorded',
  );
});

test('finish rejects submitted with a blocker before reading or writing Base', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-finish-submitted-blocker-'));
  const binDir = join(dir, 'bin');
  const callsPath = join(dir, 'calls.json');
  const mockCliPath = join(binDir, 'lark-cli');
  const scriptPath = fileURLToPath(new URL('./run-state.mjs', import.meta.url));

  try {
    await mkdir(binDir);
    await writeFile(callsPath, JSON.stringify({ calls: 0 }));
    await writeFile(mockCliPath, `#!/usr/bin/env node
import fs from 'node:fs';
const callsPath = process.env.MOCK_BASE_CALLS;
const calls = JSON.parse(fs.readFileSync(callsPath, 'utf8'));
calls.calls += 1;
fs.writeFileSync(callsPath, JSON.stringify(calls));
`);
    await chmod(mockCliPath, 0o755);
    const result = spawnSync(process.execPath, [
      scriptPath, 'finish', '--record-id', 'rec1', '--run-id', 'run-1', '--result', 'submitted',
      '--blocker-type', 'ip_rate_limit', '--evidence', 'Submission received',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        BACKLINK_KIT_PATH: kitPath,
        MOCK_BASE_CALLS: callsPath,
      },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Submitted cannot include a blocker_type/);
    assert.equal(JSON.parse(await readFile(callsPath, 'utf8')).calls, 0);
    for (const args of [
      ['finish', '--record-id', 'rec1', '--run-id', 'run-1', '--result', 'submitted', '--evidence', 'technical evidence'],
      ['reopen', '--record-id', 'rec1', '--evidence', 'technical evidence', '--yes'],
    ]) {
      const missingNote = spawnSync(process.execPath, [scriptPath, ...args], {
        encoding: 'utf8', env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
          BACKLINK_KIT_PATH: kitPath,
          MOCK_BASE_CALLS: callsPath,
        },
      });
      assert.equal(missingNote.status, 1);
      assert.match(missingNote.stderr, /reviewed Base note/);
      assert.equal(JSON.parse(await readFile(callsPath, 'utf8')).calls, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal notes require reviewed copy and preserve complete links without evidence fallback', () => {
  const baseNote = '排队审核中。\n编辑：https://directory.example/edit?token=sample#section';
  for (const result of ['submitted', 'ignore', 'blocked', 'manual_review']) {
    assert.deepEqual(terminalBaseNotePatch({ result, evidence: 'full technical evidence', baseNote }), { notes: baseNote });
    for (const missing of [undefined, null, '', '   ', 123]) {
      assert.throws(() => terminalBaseNotePatch({ result, evidence: 'full technical evidence', baseNote: missing }), /reviewed Base note/);
    }
  }
});

test('all terminal outcomes preserve existing and empty archive dates', () => {
  const outcomes = [
    { result: 'submitted', checkpoint: 'submit_result_recorded' },
    { result: 'ignore', reason: 'paid', checkpoint: 'public_precheck_done' },
    { result: 'blocked', reason: 'login_verify', checkpoint: 'public_precheck_done' },
    { result: 'manual_review', reason: 'submit_unknown', checkpoint: 'submit_click_started' },
  ];
  for (const date of [null, '2026-04-15T00:00:00.000+08:00']) {
    for (const outcome of outcomes) {
      const patch = terminalPatch({ ...outcome, evidence: 'Observed result' });
      assert.equal(Object.hasOwn(patch, 'date'), false);
      assert.equal(({ date, ...patch }).date, date);
    }
  }
});

test('unknown result after click cannot become blocked or ignored', () => {
  assert.throws(() => terminalPatch({ result: 'blocked', reason: 'cloudflare', checkpoint: 'submit_click_started', evidence: 'challenge remained visible' }), /only submitted/);
  assert.throws(() => terminalPatch({ result: 'ignore', reason: 'no_path', checkpoint: 'submit_result_recorded', evidence: 'unexpected state' }), /only submitted/);
  const patch = terminalPatch({ result: 'manual_review', reason: 'submit_unknown', checkpoint: 'submit_click_started', evidence: 'post-click state unknown' });
  assert.equal(patch.automation_state, 'manual_review');
  assert.equal(patch.checkpoint, 'submit_result_recorded');
  assert.equal(Object.hasOwn(patch, 'date'), false);
});

test('ignore rejects blockers that still require user resolution', () => {
  const patch = terminalPatch({ result: 'ignore', reason: 'low_quality', checkpoint: 'public_precheck_done', evidence: 'link farm' });
  assert.equal(patch.automation_state, 'ignore');
  assert.equal(patch.status, '终止：不适合提交');
  assert.throws(() => terminalPatch({ result: 'ignore', reason: 'login_verify', checkpoint: 'public_precheck_done', evidence: 'Google verification required' }), /Ignore is limited/);
});

test('ignored candidates can reopen only with new evidence', () => {
  const current = {
    status: ['ignored'],
    website: 'https://directory.example/',
    automation_state: 'ignore',
    notes: '旧结论',
  };
  const patch = reopenPatch({
    current,
    evidence: '发现公开 Projects & Publications 项目路径',
    notesBefore: '旧结论',
    statusBefore: 'ignored',
    websiteBefore: 'https://directory.example/',
    baseNote: '原入口关闭，现已找到免费项目页；继续编辑：https://directory.example/edit/sample',
    now: new Date('2026-07-11T08:00:00.000Z'),
  });
  assert.equal(patch.status, '待提交');
  assert.equal(patch.automation_state, 'ready');
  assert.equal(patch.checkpoint, null);
  assert.equal(patch.blocker_type, null);
  assert.equal(canClaim({ ...current, ...patch }), true);
  assert.equal(patch.automation_run_id, null);
  assert.equal(patch.notes, '原入口关闭，现已找到免费项目页；继续编辑：https://directory.example/edit/sample');
  const reopenedPreclick = reopenPatch({
    current: { ...current, blocker_type: 'low_quality', checkpoint: 'public_precheck_done' },
    evidence: '发现可编辑的正式产品目录入口',
    baseNote: '找到免费产品入口，待提交。',
    notesBefore: '旧结论',
    statusBefore: 'ignored',
    websiteBefore: 'https://directory.example/',
  });
  assert.equal(reopenedPreclick.automation_state, 'ready');
  for (const unsafe of [
    { blocker_type: 'submit_unknown', checkpoint: 'public_precheck_done' },
    { blocker_type: null, checkpoint: 'submit_click_started' },
    { blocker_type: null, checkpoint: 'submit_result_recorded' },
  ]) {
    assert.throws(
      () => reopenPatch({ current: { ...current, ...unsafe }, evidence: 'new evidence' }),
      /unknown post-click submission evidence/,
    );
  }
  assert.throws(() => reopenPatch({ current: { status: ['watching'], automation_state: 'ready' }, evidence: 'x' }), /limited/);
  assert.throws(() => reopenPatch({ current, evidence:'new',baseNote:'New draft',notesBefore:'旧结论',statusBefore:'受阻：人工处理',websiteBefore:current.website }),/status-before/);
  assert.throws(() => reopenPatch({ current, evidence:'new',baseNote:'New draft',notesBefore:'旧结论',statusBefore:'ignored',websiteBefore:'https://another.example/' }),/website-before/);
  assert.throws(() => reopenPatch({ current, evidence: '' }), /new evidence/);
  assert.throws(() => reopenPatch({ current, evidence: 'new evidence' }), /reviewed Base note/);
});

test('metric writeback converts numeric values without duplicating them in notes', () => {
  const patch = metricPatch({ dr: '81', trafficK: '754' });
  assert.equal(patch.DR, 81);
  assert.equal(patch['Traffic (k)'], 754);
  assert.equal(patch.notes, undefined);
  assert.deepEqual(metricPatch({ dr: '', trafficK: '  ' }), {});
  assert.deepEqual(metricPatch({ dr: 0, trafficK: 0 }), { DR: 0, 'Traffic (k)': 0 });
  assert.deepEqual(metricPatch({ dr: '20' }), { DR: 20 });
  assert.deepEqual(metricPatch({ trafficK: '2' }), { 'Traffic (k)': 2 });
  assert.throws(() => metricPatch({ dr: '101' }), /0 to 100/);
});

test('unobserved and unavailable metrics preserve existing values', () => {
  assert.deepEqual(metricPatch({}), {});
  assert.deepEqual(metricPatch({ drUnavailable: true }), {});
  assert.deepEqual(metricPatch({ trafficUnavailable: true }), {});
  const existing = { DR: 72, 'Traffic (k)': 791 };
  assert.deepEqual({ ...existing, ...metricPatch({ drUnavailable: true, trafficUnavailable: true }) }, existing);
  assert.deepEqual(metricPatch({ drUnavailable: true, trafficK: '2' }), { 'Traffic (k)': 2 });
  assert.deepEqual(metricPatch({ dr: '0', trafficK: 0, trafficUnavailable: false }), { DR: 0, 'Traffic (k)': 0 });
  assert.throws(() => metricPatch({ dr: 81, drUnavailable: true }), /cannot be used together/);
  assert.throws(() => metricPatch({ trafficK: '12', trafficUnavailable: true }), /cannot be used together/);
});

test('same-checkpoint retries merge and validate metric patches without changing log evidence', () => {
  const now = new Date('2026-09-26T10:00:00.000Z');
  const automationLog = appendAutomationLog('', {
    runId: 'run-1',
    event: 'checkpoint:form_ready',
    detail: 'Chrome DR/Traffic checked.',
    now,
  });
  const current = {
    automation_state: 'running',
    automation_run_id: 'run-1',
    checkpoint: 'form_ready',
    automation_log: automationLog,
  };
  const built = buildCheckpointPatch({
    current,
    runId: 'run-1',
    checkpoint: 'form_ready',
    metricsCheckedInChrome: true,
    drUnavailable: true,
    now,
  });
  assert.equal(built.unchanged, true);
  assert.deepEqual(built.patch, {});
  const zeroMetrics = buildCheckpointPatch({
    current,
    runId: 'run-1',
    checkpoint: 'form_ready',
    metricsCheckedInChrome: true,
    dr: 0,
    trafficK: 0,
    now,
  });
  assert.equal(zeroMetrics.unchanged, true);
  assert.deepEqual(zeroMetrics.patch, { DR: 0, 'Traffic (k)': 0 });
  const firstFormReady = buildCheckpointPatch({
    current: { ...current, checkpoint: 'public_precheck_done', automation_log: '' },
    runId: 'run-1',
    checkpoint: 'form_ready',
    metricsCheckedInChrome: true,
    dr: 0,
    trafficK: 0,
    now,
  });
  assert.equal(firstFormReady.unchanged, false);
  assert.equal(firstFormReady.patch.DR, 0);
  assert.equal(firstFormReady.patch['Traffic (k)'], 0);
  assert.equal(firstFormReady.patch.checkpoint, 'form_ready');
  assert.throws(
    () => buildCheckpointPatch({
      current,
      runId: 'run-1',
      checkpoint: 'form_ready',
      metricsCheckedInChrome: true,
      dr: 81,
      drUnavailable: true,
      now,
    }),
    /cannot be used together/,
  );
  assert.throws(
    () => buildCheckpointPatch({
      current: { ...current, automation_state: 'submitted' },
      runId: 'run-1',
      checkpoint: 'form_ready',
      metricsCheckedInChrome: true,
      drUnavailable: true,
      now,
    }),
    /not running/,
  );
});

test('form_ready preserves metrics by default and requires Chrome evidence only for metric writes', () => {
  const current = {
    automation_state: 'running',
    automation_run_id: 'run-1',
    checkpoint: 'public_precheck_done',
    automation_log: '',
    DR: 72,
    'Traffic (k)': 791,
  };
  for (const metrics of [{}, { drUnavailable: true, trafficUnavailable: true }]) {
    const { patch } = buildCheckpointPatch({ current, runId: 'run-1', checkpoint: 'form_ready', ...metrics });
    assert.equal(patch.checkpoint, 'form_ready');
    assert.equal(({ ...current, ...patch }).DR, 72);
    assert.equal(({ ...current, ...patch })['Traffic (k)'], 791);
    assert.doesNotMatch(patch.automation_log, /Chrome DR\/Traffic checked/);
  }
  assert.throws(
    () => buildCheckpointPatch({ current, runId: 'run-1', checkpoint: 'form_ready', dr: 0 }),
    /Metric writes require --metrics-checked-in-chrome/,
  );
});

test('checkpoint metrics can only be written at form_ready', () => {
  const nonFormReadyCheckpoints = [
    'claimed',
    'public_precheck_done',
    'form_filled',
    'pre_submit_verified',
    'submit_click_started',
    'submit_result_recorded',
  ];

  for (const [index, checkpoint] of nonFormReadyCheckpoints.entries()) {
    const current = {
      automation_state: 'running',
      automation_run_id: 'run-1',
      checkpoint,
      automation_log: '',
    };
    const metric = index % 2 === 0
      ? { dr: 0 }
      : { trafficUnavailable: true };
    assert.throws(
      () => buildCheckpointPatch({ current, runId: 'run-1', checkpoint, ...metric }),
      /only be written at form_ready/,
      `${checkpoint} should reject metric writes`,
    );
  }
});

test('terminal ignore retry combines legacy status repair with the idempotent repair patch', () => {
  const current = {
    status: ['watching'],
    date: null,
    notes: null,
    automation_log: '',
    checkpoint: 'public_precheck_done',
  };
  const args = {
    current,
    runId: 'run-1',
    result: 'ignore',
    reason: 'paid',
    evidence: 'Requires payment.',
    baseNote: '仅付费提交，未付款。',
    now: new Date('2026-09-26T10:00:00.000Z'),
  };
  const patch = terminalRetryPatch(args);
  assert.equal(patch.status, undefined);
  assert.equal(Object.hasOwn(patch, 'date'), false);
  assert.equal(patch.notes, undefined);
  assert.match(patch.automation_log, /event=finish:ignore:1/);
  assert.deepEqual(terminalRetryPatch({ ...args, current: {
    ...current,
    status: ['ignored'],
    date: null,
    notes: '仅付费提交，未付款。编辑：https://directory.example/edit?token=added-later',
    automation_log: patch.automation_log,
  } }), {
    automation_log: patch.automation_log,
  });
  assert.throws(() => terminalRetryPatch({ ...args, current: { ...current, checkpoint: null } }), /requires a known checkpoint/);
});

test('ignored skip reasons write the ignored legacy status and preserve blocker detail', () => {
  for (const reason of ['paid', 'reciprocal', 'phone_verify', 'site_registration']) {
    const patch = terminalPatch({
      result: 'ignore',
      reason,
      checkpoint: 'public_precheck_done',
      evidence: `${reason} requirement`,
    });
    assert.equal(patch.status, ['paid','reciprocal'].includes(reason) ? '受阻：需换链/付费' : '受阻：人工处理');
    assert.equal(patch.automation_state, 'ignore');
    assert.equal(patch.blocker_type, reason);
  }
  assert.throws(
    () => terminalPatch({ result: 'ignore', reason: 'login_verify', checkpoint: 'public_precheck_done', evidence: 'OAuth email confirmation' }),
    /Ignore is limited/,
  );
});

test('patch readback normalizes select, URL, datetime, and null values', () => {
  const patch = {
    status: 'ignored',
    automation_state: 'ignore',
    blocker_type: null,
    date: '2026-09-26 19:30:45',
    notes: 'Price is $5.',
    submit_url: 'https://example.com/submit',
    DR: null,
    'Traffic (k)': 12,
  };
  const record = {
    record_id: 'rec123',
    status: ['ignored'],
    automation_state: ['ignore'],
    blocker_type: [],
    date: '2026-09-26T19:30:00.000+08:00',
    notes: 'Price is $5.',
    submit_url: '[Submit](https://example.com/submit)',
    DR: null,
    'Traffic (k)': '12',
  };
  assert.equal(assertPatchReadback(record, patch, { command: 'Finish' }), true);
  assert.throws(() => assertPatchReadback({ ...record, notes: 'stale' }, patch, { command: 'Finish' }), /readback mismatch for notes.*get --record-id/);
});

test('readback mismatch retries reads only and returns the first valid record', () => {
  let reads = 0;
  const record = waitForReadback(
    () => ({ attempt: ++reads }),
    (value) => {
      if (value.attempt < 3) throw new Error('eventual consistency');
      return true;
    },
    { attempts: 3, delayMs: 0 },
  );
  assert.equal(reads, 3);
  assert.equal(record.attempt, 3);
  assert.throws(
    () => waitForReadback(() => ({}), () => { throw new Error('still stale'); }, { attempts: 2, delayMs: 0 }),
    /still stale/,
  );
});

test('403 events stay site-scoped while Cloudflare events stay non-global', () => {
  const firstAt = new Date('2026-07-11T01:00:00.000Z');
  const firstCloudflare = updateCircuit(null, { type: 'cloudflare' }, firstAt);
  const secondCloudflare = updateCircuit(firstCloudflare, { type: 'cloudflare' }, new Date('2026-07-11T01:05:00.000Z'));
  assert.equal(secondCloudflare.open, false);
  assert.equal(secondCloudflare.events.length, 2);
  const oneCloudflareAnd403 = updateCircuit(firstCloudflare, { type: 'forbidden_403' }, new Date('2026-07-11T01:10:00.000Z'));
  assert.equal(oneCloudflareAnd403.open, false);
  assert.equal(oneCloudflareAnd403.events.length, 2);

  const first403 = updateCircuit(null, { type: 'forbidden_403', domain: 'blocked.example', record_id: 'rec-403' }, firstAt);
  const second403 = updateCircuit(first403, { type: 'forbidden_403', domain: 'other.example', record_id: 'rec-other' }, new Date('2026-07-11T01:10:00.000Z'));
  assert.equal(second403.open, false);
  assert.equal(second403.reason, null);
  assert.equal(second403.events.length, 2);
  assert.deepEqual(second403.events.map((event) => event.domain), ['blocked.example', 'other.example']);

  const rateLimited = updateCircuit(null, { type: 'rate_limit_429' }, firstAt);
  assert.equal(rateLimited.open, true);
  const ipLimited = updateCircuit(null, { type: 'ip_rate_limit' }, firstAt);
  assert.equal(ipLimited.open, true);
});

test('circuit domains normalize host casing, trailing dots and www', () => {
  assert.equal(normalizeCircuitDomain('https://WWW.Example.COM./submit'), 'example.com');
  assert.equal(normalizeCircuitDomain('example.com'), 'example.com');
  assert.equal(normalizeCircuitDomain('not a host'), '');
});

test('legacy repeated 403 circuit opens are normalized while retaining domain and record evidence', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-legacy-403-circuit-'));
  const circuitPath = join(dir, 'circuit.json');
  const now = new Date();
  const old403Events = [
    { type: 'forbidden_403', domain: 'www.blocked.example', record_id: 'rec-blocked', at: now.toISOString() },
    { type: 'forbidden_403', domain: 'elsewhere.example', record_id: 'rec-elsewhere', at: now.toISOString() },
  ];

  try {
    const legacy = updateCircuit(null, old403Events[0], now);
    await writeCircuit(circuitPath, { ...legacy, open: true, reason: 'repeated_security_blocks', events: old403Events });
    const normalized = await readCircuit(circuitPath, now);
    assert.equal(normalized.open, false);
    assert.equal(normalized.reason, null);
    assert.deepEqual(normalized.events, old403Events);
    await assert.rejects(
      assertCircuitDomainAvailable(circuitPath, { domain: 'https://blocked.example/new', recordId: 'rec-new' }),
      /blocked for today after a real non-verification 403: blocked\.example/,
    );
    await assert.doesNotReject(assertCircuitDomainAvailable(circuitPath, { domain: 'https://safe.example/', recordId: 'rec-safe' }));

    for (const type of ['rate_limit_429', 'ip_rate_limit']) {
      await writeCircuit(circuitPath, {
        ...legacy,
        open: true,
        reason: 'repeated_security_blocks',
        events: [...old403Events, { type, record_id: `rec-${type}`, at: now.toISOString() }],
      });
      const preserved = await readCircuit(circuitPath, now);
      assert.equal(preserved.open, true);
      assert.equal(preserved.reason, type);
      assert.deepEqual(preserved.events.slice(0, 2), old403Events);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkpoint circuit blocks pre-click steps on global rate limits and 403 domains, except result recording', async () => {
  const dir = await mkdtemp(join(projectTmp, 'backlink-checkpoint-circuit-'));
  const circuitPath = join(dir, 'circuit.json');
  const checkpoints = [
    'claimed',
    'public_precheck_done',
    'form_ready',
    'form_filled',
    'pre_submit_verified',
    'submit_click_started',
  ];

  try {
    for (const type of ['rate_limit_429', 'ip_rate_limit']) {
      const openCircuit = updateCircuit(null, { type }, new Date());
      await writeCircuit(circuitPath, openCircuit);
      for (const checkpoint of checkpoints) {
        await assert.rejects(
          assertCheckpointCircuitClosed(checkpoint, circuitPath),
          new RegExp(`Submission circuit is open for today: ${type}`),
          `${checkpoint} should stop while the ${type} circuit is open`,
        );
      }
      await assert.doesNotReject(assertCheckpointCircuitClosed('submit_result_recorded', circuitPath));
    }

    const openCircuit = updateCircuit(null, { type: 'rate_limit_429' }, new Date());
    await writeCircuit(circuitPath, { ...openCircuit, open: false, reason: null, events: [] });
    for (const checkpoint of [...checkpoints, 'submit_result_recorded']) {
      await assert.doesNotReject(assertCheckpointCircuitClosed(checkpoint, circuitPath));
    }

    const siteBlocked = updateCircuit(null, {
      type: 'forbidden_403', domain: 'blocked.example', record_id: 'rec-old',
    }, new Date());
    await writeCircuit(circuitPath, siteBlocked);
    for (const checkpoint of checkpoints) {
      await assert.rejects(
        assertCheckpointCircuitClosed(checkpoint, circuitPath, { website: 'https://www.blocked.example/submit', recordId: 'rec-new' }),
        /blocked for today after a real non-verification 403: blocked\.example/,
      );
    }
    await assert.doesNotReject(assertCheckpointCircuitClosed('form_ready', circuitPath, { website: 'https://safe.example/', recordId: 'rec-safe' }));
    await assert.doesNotReject(assertCheckpointCircuitClosed('submit_result_recorded', circuitPath, { website: 'https://blocked.example/', recordId: 'rec-new' }));

    let current = {
      automation_state: 'running',
      automation_run_id: 'run-1',
      checkpoint: 'claimed',
      automation_log: '',
    };
    for (const checkpoint of [...checkpoints.slice(1), 'submit_result_recorded']) {
      await assertCheckpointCircuitClosed(checkpoint, circuitPath);
      const { patch } = buildCheckpointPatch({
        current,
        runId: 'run-1',
        checkpoint,
        metricsCheckedInChrome: checkpoint === 'form_ready',
        ...(checkpoint === 'form_ready' ? { dr: 0, trafficK: 0 } : {}),
      });
      current = { ...current, ...patch };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('circuit deduplicates identified replays but preserves independent events', () => {
  const firstAt = new Date('2026-07-11T01:00:00.000Z');
  const eventId = JSON.stringify(['run-1', 'rec1', 'finish:blocked:1']);
  const first = updateCircuit(null, { type: 'forbidden_403', domain: 'first.example', record_id: 'rec1', event_id: eventId }, firstAt);
  const replay = updateCircuit(first, { type: 'forbidden_403', domain: 'first.example', record_id: 'rec1', event_id: eventId }, new Date('2026-07-11T01:01:00.000Z'));
  assert.equal(replay.events.length, 1);
  assert.equal(replay.open, false);
  assert.equal(replay.events[0].type, 'forbidden_403');

  const independent = updateCircuit(null, { type: 'forbidden_403', domain: 'first.example' }, firstAt);
  const next = updateCircuit(independent, { type: 'forbidden_403', domain: 'second.example' }, new Date('2026-07-11T01:01:00.000Z'));
  assert.equal(next.events.length, 2);
  assert.equal(next.open, false);
});

test('circuit resets on the next Singapore date', () => {
  const previous = updateCircuit(null, { type: 'rate_limit_429' }, new Date('2026-07-11T15:59:00.000Z'));
  const next = updateCircuit(previous, { type: 'cloudflare' }, new Date('2026-07-11T16:01:00.000Z'));
  assert.equal(next.open, false);
  assert.equal(next.events.length, 1);
});

test('human business termination blocks pre-click progress and resume, while post-click evidence may be recorded', () => {
 const current={status:['终止：不适合提交'],automation_state:'running',automation_run_id:'run-1',checkpoint:'form_filled'};
 assert.throws(()=>buildCheckpointPatch({current,runId:'run-1',checkpoint:'pre_submit_verified'}),/Business status blocks/);
 assert.throws(()=>assertResumeCheckpoint(current),/Business status blocks/);
 assert.doesNotThrow(()=>buildCheckpointPatch({current:{...current,checkpoint:'submit_click_started'},runId:'run-1',checkpoint:'submit_result_recorded'}));
});
