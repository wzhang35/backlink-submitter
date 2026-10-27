#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoTargetOverrides, getKitConfig, runtimePaths } from './kit-config.mjs';
import { AUTOMATION_STATES, BLOCKER_TYPES, CHECKPOINTS, BUSINESS_FIELDS, BUSINESS_SCHEMA, candidateIdentity, INTERNAL_FIELDS, businessPatch, readHybridRecord, writeHybridRecord, reconcileRecord, loadRuntime, initializeRuntime, runLark } from './base-store.mjs';
import { baseFields, compareBaseSchema } from './base-schema.mjs';

const SHARED_STATE_DIR = runtimePaths({ id: 'shared' }).sharedDir;
export const CIRCUIT_FILE = join(SHARED_STATE_DIR, 'circuit.json');
export const BASE_WRITE_LOCK_FILE = join(SHARED_STATE_DIR, 'base-write.lock');

export { AUTOMATION_STATES, BLOCKER_TYPES, CHECKPOINTS } from './base-store.mjs';

export const RECORD_FIELDS = BUSINESS_FIELDS;

let structuredInputArgs = null;

function cliArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function arg(name) {
  const key = name.startsWith('--') ? name.slice(2) : name;
  if (structuredInputArgs && Object.hasOwn(structuredInputArgs, key)) {
    const value = structuredInputArgs[key];
    return typeof value === 'boolean' ? (value ? 'true' : null) : String(value);
  }
  return cliArg(name);
}

function has(name) {
  const key = name.startsWith('--') ? name.slice(2) : name;
  if (structuredInputArgs && Object.hasOwn(structuredInputArgs, key)) {
    return structuredInputArgs[key] === true;
  }
  return process.argv.includes(name);
}

const COMMON_INPUT_KEYS = [];
const BOOLEAN_INPUT_KEYS = new Set(['yes', 'metrics-checked-in-chrome', 'dr-unavailable', 'traffic-unavailable']);
const COMMAND_INPUT_KEYS = {
  bootstrap: [],
  schema: [],
  'check-schema': [],
  init: ['yes'],
  intake: ['website', 'notes', 'submit-url'],
  get: ['record-id'],
  reconcile: ['record-id'],
  reopen: ['record-id', 'evidence', 'base-note', 'notes-before', 'status-before', 'website-before', 'yes'],
  claim: ['record-id', 'run-id', 'submit-url'],
  checkpoint: [
    'record-id', 'run-id', 'checkpoint', 'detail', 'metrics-checked-in-chrome',
    'submit-url', 'dr', 'traffic-k', 'dr-unavailable', 'traffic-unavailable',
  ],
  finish: ['record-id', 'run-id', 'result', 'blocker-type', 'evidence', 'base-note', 'notes-before', 'business-status'],
  resume: ['record-id', 'run-id', 'yes', 'detail'],
  'lock-reset': ['yes'],
  'circuit-check': [],
  'circuit-event': ['type', 'domain'],
  'circuit-reset': ['yes'],
};

export function parseInputJsonOptions(text, { command, cliArgs = [] } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--input-json must contain valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--input-json must contain a JSON object.');
  }

  const allowedKeys = new Set([...COMMON_INPUT_KEYS, ...(COMMAND_INPUT_KEYS[command] || [])]);
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown --input-json field for ${command || 'command'}: ${key}`);
    if (BOOLEAN_INPUT_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`--input-json field ${key} must be boolean.`);
    } else if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`--input-json field ${key} must be a string or finite number.`);
    }
    if (cliArgs.includes(`--${key}`)) throw new Error(`Conflicting input: provide --${key} either in --input-json or on the CLI, not both.`);
  }
  return parsed;
}

async function loadInputJson() {
  const indexes = process.argv.flatMap((value, index) => value === '--input-json' ? [index] : []);
  if (!indexes.length) return null;
  if (indexes.length !== 1) throw new Error('Pass --input-json only once.');
  const index = indexes[0];
  const source = process.argv[index + 1];
  if (!source || (source.startsWith('--') && source !== '-')) throw new Error('--input-json requires a file path or - for stdin.');
  const jsonText = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  const cliArgs = process.argv.slice(3).filter((_, offset) => {
    const absoluteIndex = offset + 3;
    return absoluteIndex !== index && absoluteIndex !== index + 1;
  });
  return parseInputJsonOptions(jsonText, { command: process.argv[2], cliArgs });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.once('end', () => resolve(chunks.join('')));
    process.stdin.once('error', reject);
  });
}

function selectValue(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function statuses(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function firstUrl(value) {
  const text = String(value || '');
  const markdown = text.match(/\[[^\]]*]\((https?:\/\/[^)]+)\)/);
  if (markdown) return markdown[1];
  return text.match(/https?:\/\/[^\s)\]]+/)?.[0] || text;
}

export function formatDateTime(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const item = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${item.year}-${item.month}-${item.day} ${item.hour}:${item.minute}:${item.second}`;
}

function normalizedDomain(value) {
  try {
    return new URL(firstUrl(value)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(value || '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  }
}

const SELECT_READBACK_FIELDS = new Set(['status', 'automation_state', 'blocker_type', 'checkpoint', 'dofollow']);
const DATETIME_READBACK_FIELDS = new Set(['date', 'last_attempt_at']);
const URL_READBACK_FIELDS = new Set(['website', 'submit_url', 'myurl']);

function normalizedDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Math.floor(milliseconds / 60_000);
  }
  const text = String(value).trim();
  const localDateTime = text.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  const parseable = localDateTime ? `${localDateTime[1]}T${localDateTime[2]}:00+08:00` : text;
  const milliseconds = Date.parse(parseable);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 60_000) : text;
}

function normalizedUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = firstUrl(value).trim();
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}

function matchesReadback(field, expected, actual) {
  if (SELECT_READBACK_FIELDS.has(field)) {
    const actualValues = (Array.isArray(actual) ? actual : [actual]).filter((value) => value !== null && value !== undefined && value !== '');
    if (expected === null) return actualValues.length === 0;
    return actualValues.some((value) => String(value) === String(expected));
  }
  if (DATETIME_READBACK_FIELDS.has(field)) {
    return normalizedDateTime(expected) === normalizedDateTime(actual);
  }
  if (URL_READBACK_FIELDS.has(field)) {
    return normalizedUrl(expected) === normalizedUrl(actual);
  }
  if (expected === null || expected === undefined) return actual === null || actual === undefined || actual === '';
  if (typeof expected === 'number') {
    return actual !== null && actual !== undefined && actual !== ''
      && Number.isFinite(Number(actual)) && Number(actual) === expected;
  }
  return String(actual ?? '') === String(expected);
}

export function assertPatchReadback(record, patch, { command = 'Write', recordId = record?.record_id } = {}) {
  for (const [field, expected] of Object.entries(patch)) {
    if (!matchesReadback(field, expected, record?.[field])) {
      const identity = recordId ? ` record_id=${recordId}` : '';
      const readHint = recordId
        ? ` Read with run-state.mjs get --record-id ${recordId} before any retry.`
        : ' Read with run-state.mjs get --record-id before any retry.';
      throw new Error(`${command} readback mismatch for ${field}${identity}.${readHint}`);
    }
  }
  return true;
}

export function waitForReadback(read, validate, { attempts = 3, delayMs = 500 } = {}) {
  if (typeof read !== 'function' || typeof validate !== 'function') {
    throw new Error('waitForReadback requires read and validate functions.');
  }
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('waitForReadback attempts must be a positive integer.');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('waitForReadback delayMs must be non-negative.');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const record = read();
      if (validate(record) === false) throw new Error('Readback validation returned false.');
      return record;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts && delayMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError;
}

function resolveTarget() {
  const { base } = getKitConfig();
  return { baseToken: base.baseToken, tableId: base.tableId, wikiUrl: base.wikiUrl, viewId: base.viewId };
}

export function getRecord(target, recordId, extraFields = []) {
  return readHybridRecord(target, recordId, extraFields);
}

export function updateRecord(target, recordId, patch, command = 'Update', expected = null) {
  return writeHybridRecord(target, recordId, patch, (record) => {
    assertPatchReadback(record, Object.fromEntries(Object.entries(patch).filter(([k]) => INTERNAL_FIELDS.has(k))), { command, recordId });
  }, waitForReadback, expected);
}

function fieldRows(envelope) {
  const data = envelope?.data;
  const rows = data?.items || data?.fields || data?.data || [];
  return Array.isArray(rows) ? rows : [];
}

function listFields(target) {
  return fieldRows(runLark([
    'base', '+field-list',
    '--base-token', target.baseToken,
    '--table-id', target.tableId,
    '--limit', '200',
    '--as', 'user',
    '--format', 'json',
  ]));
}

function createdRecordId(envelope) {
  return envelope?.data?.record?.record_id
    || envelope?.data?.record_id
    || envelope?.data?.record?.id
    || envelope?.data?.id
    || null;
}

function createRecord(target, patch) {
  return runLark([
    'base', '+record-upsert',
    '--base-token', target.baseToken,
    '--table-id', target.tableId,
    '--json', JSON.stringify(businessPatch(patch)),
    '--as', 'user',
    '--format', 'json',
  ]);
}

async function findByWebsite(target, website) {
  const wanted = candidateIdentity(website);
  for (let offset = 0; ; offset += 200) {
    const envelope = runLark([
      'base', '+record-list',
      '--base-token', target.baseToken,
      '--table-id', target.tableId,
      '--field-id', 'URL',
      '--limit', '200',
      '--offset', String(offset),
      '--as', 'user',
      '--format', 'json',
    ]);
    const data = envelope.data;
    for (let i = 0; i < data.data.length; i += 1) {
      if (candidateIdentity(data.data[i][0]) === wanted) return data.record_id_list[i];
    }
    if (!data.has_more) return null;
  }
}

export function canClaim(record) {
  if (record.runtime_pending) return false;
  const legacy = statuses(record.status).map((value) => String(value).toLowerCase());
  if (!legacy.length || legacy.some(value => !['待评估','待提交','watching','to-submit'].includes(value))) return false;
  if (legacy.some((value) => ['submited', 'submitted', 'succeed', 'succeeded', 'declined', 'rejected', 'ignore', 'ignored'].includes(value))) return false;
  if (record.blocker_type === 'submit_unknown') return false;
  if (['submit_click_started', 'submit_result_recorded'].includes(record.checkpoint)) return false;
  return !record.automation_state || record.automation_state === 'ready';
}

export function assertCheckpointTransition(current, next) {
  const currentIndex = CHECKPOINTS.indexOf(current);
  const nextIndex = CHECKPOINTS.indexOf(next);
  if (nextIndex < 0) throw new Error(`Unknown checkpoint: ${next}`);
  if (currentIndex < 0) throw new Error(`Cannot advance from missing or unknown checkpoint: ${current || 'blank'}. Read the record and investigate before continuing.`);
  if (currentIndex >= 0 && nextIndex < currentIndex) throw new Error(`Checkpoint cannot move backward: ${current} -> ${next}`);
  if (currentIndex >= 0 && nextIndex > currentIndex + 1) throw new Error(`Checkpoint cannot skip steps: ${current} -> ${next}`);
}

export function reopenPatch({ current, evidence, baseNote, notesBefore, statusBefore, websiteBefore, now = new Date() }) {
  if (!statuses(current.status).some(value => value === 'ignored' || value.startsWith('受阻：') || value.startsWith('终止：'))) {
    throw new Error('Reopen is limited to records currently marked ignore/ignored.');
  }
  if (current.blocker_type === 'submit_unknown' || ['submit_click_started', 'submit_result_recorded'].includes(current.checkpoint)) {
    throw new Error('Cannot reopen a record with unknown post-click submission evidence.');
  }
  if (!String(evidence || '').trim()) throw new Error('Reopen requires new evidence.');
  reviewedBaseNote(baseNote);
  assertNotesSnapshot(current, notesBefore);
  if (typeof statusBefore !== 'string' || statusBefore !== selectValue(current.status)) throw new Error('Reviewed status-before is required and must match the current business state.');
  if (typeof websiteBefore !== 'string' || normalizedUrl(websiteBefore) !== normalizedUrl(current.website)) throw new Error('Reviewed website-before is required and must match the current candidate.');
  return {
    status: '待提交',
    notes: reviewedBaseNote(baseNote),
    automation_state: 'ready',
    blocker_type: null,
    checkpoint: null,
    automation_run_id: null,
    last_attempt_at: formatDateTime(now),
  };
}

export function metricPatch({ dr = null, trafficK = null, drUnavailable = false, trafficUnavailable = false }) {
  const hasDr = dr !== null && dr !== undefined && String(dr).trim() !== '';
  const hasTrafficK = trafficK !== null && trafficK !== undefined && String(trafficK).trim() !== '';
  if (drUnavailable && hasDr) throw new Error('--dr and --dr-unavailable cannot be used together.');
  if (trafficUnavailable && hasTrafficK) throw new Error('--traffic-k and --traffic-unavailable cannot be used together.');
  if (!hasDr && !hasTrafficK && !drUnavailable && !trafficUnavailable) return {};
  const patch = {};
  if (hasDr) {
    const value = Number(dr);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('DR must be a number from 0 to 100.');
    patch.DR = value;
  }
  if (hasTrafficK) {
    const value = Number(trafficK);
    if (!Number.isFinite(value) || value < 0) throw new Error('Traffic (k) must be a non-negative number.');
    patch['Traffic (k)'] = value;
  }
  return patch;
}

export function intakePatch({ website, notes = null, submitUrl = null }) {
  const patch = { website, status: '待提交' };
  if (notes) patch.notes = notes;
  if (submitUrl) patch.submit_url = submitUrl;
  return patch;
}

export function checkpointDetail({ checkpoint, detail = '', metricsCheckedInChrome = false }) {
  const text = String(detail || '').trim();
  if (checkpoint !== 'form_ready' || !metricsCheckedInChrome) return text;
  return [text, 'Chrome DR/Traffic checked.'].filter(Boolean).join(' ');
}

export function buildCheckpointPatch({
  current,
  runId,
  checkpoint,
  detail = '',
  metricsCheckedInChrome = false,
  submitUrl = null,
  dr = null,
  trafficK = null,
  drUnavailable = false,
  trafficUnavailable = false,
  now = new Date(),
}) {
  assertOwned(current, runId);
  if (checkpoint !== 'submit_result_recorded') assertActiveBusiness(current);
  assertCheckpointTransition(current.checkpoint, checkpoint);
  const normalizedDetail = checkpointDetail({ checkpoint, detail, metricsCheckedInChrome });
  const unchanged = current.checkpoint === checkpoint;
  const metricRequested = (
    (dr !== null && dr !== undefined && String(dr).trim() !== '')
    || (trafficK !== null && trafficK !== undefined && String(trafficK).trim() !== '')
    || drUnavailable
    || trafficUnavailable
  );
  if (checkpoint !== 'form_ready' && metricRequested) {
    throw new Error('DR/Traffic metrics can only be written at form_ready.');
  }
  const patch = metricPatch({ dr, trafficK, drUnavailable, trafficUnavailable });
  if (Object.keys(patch).length && !metricsCheckedInChrome) {
    throw new Error('Metric writes require --metrics-checked-in-chrome.');
  }
  if (!unchanged) {
    patch.checkpoint = checkpoint;
    patch.last_attempt_at = formatDateTime(now);
    if (submitUrl) patch.submit_url = submitUrl;
  }
  const automationLog = appendAutomationLog(current.automation_log, {
    runId,
    event: `checkpoint:${checkpoint}`,
    detail: normalizedDetail,
    now,
  });
  if (automationLog !== current.automation_log) patch.automation_log = automationLog;
  return { patch, unchanged };
}

export function appendAutomationLog(log, { runId, event, detail = '', now = new Date() }) {
  const normalizedRunId = logToken(runId, 'runId');
  const normalizedEvent = logToken(event, 'event');
  const normalizedDetail = String(detail || '').trim().replace(/\s+/g, ' ');
  const payload = `run_id=${normalizedRunId} event=${normalizedEvent}${normalizedDetail ? ` detail=${normalizedDetail}` : ''}`;
  const existing = String(log || '');
  const marker = `run_id=${normalizedRunId} event=${normalizedEvent}`;
  const previousPayload = existing.split('\n').map((line) => {
    if (!line.startsWith('[')) return null;
    const separator = line.indexOf('] ');
    return separator > 0 ? line.slice(separator + 2) : null;
  }).find((value) => value === marker || value?.startsWith(`${marker} detail=`));
  if (previousPayload) {
    if (previousPayload !== payload) throw new Error(`Automation log event already exists with different evidence: ${normalizedEvent}.`);
    return existing;
  }
  const entry = `[${formatDateTime(now)}] ${payload}`;
  return existing ? `${existing}\n${entry}` : entry;
}

function logToken(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`Automation log ${label} must be a single-line token.`);
  }
  return normalized;
}

function automationEventCount(log, { runId, event }) {
  const marker = `run_id=${logToken(runId, 'runId')} event=${logToken(event, 'event')}`;
  return String(log || '').split('\n').filter((line) => {
    if (!line.startsWith('[')) return false;
    const separator = line.indexOf('] ');
    const payload = separator > 0 ? line.slice(separator + 2) : '';
    return payload === marker || payload.startsWith(`${marker}:`) || payload.startsWith(`${marker} detail=`);
  }).length;
}

export function assertFreshClaimRun(log, runId) {
  if (automationEventCount(log, { runId, event: 'claimed' })) {
    throw new Error(`run_id=${runId} has already claimed this record; use a new run ID.`);
  }
}

export function finishEvent(log, { runId, result, terminalRetry = false }) {
  const event = `finish:${result}`;
  const count = automationEventCount(log, { runId, event });
  return `${event}:${terminalRetry ? Math.max(count, 1) : count + 1}`;
}

export function resumeEvent(log, runId) {
  const blockCount = ['blocked', 'manual_review'].reduce(
    (total, result) => total + automationEventCount(log, { runId, event: `finish:${result}` }),
    0,
  );
  return `resumed:${blockCount}`;
}

export function assertActiveBusiness(record, { resuming = false } = {}) {
  if (!Object.hasOwn(record, 'status')) return;
  const allowed = ['待评估','待提交','watching','to-submit', ...(resuming ? ['受阻：人工处理'] : [])];
  if (!resuming && record.claimed_status && record.claimed_status !== selectValue(record.status)) throw new Error('Business status changed during the run; inspect and explicitly resume before continuing.');
  if (!statuses(record.status).length || statuses(record.status).some(value => !allowed.includes(value))) throw new Error('Business status blocks further submission; inspect the human-visible decision.');
}

function protectedBusiness(record) {
  const active = ['待评估','待提交','watching','to-submit'];
  return (record.claimed_status && record.claimed_status !== selectValue(record.status)) || !statuses(record.status).length || statuses(record.status).some(value => !active.includes(value));
}

export function assertResumeCheckpoint(current) {
  if (current?.runtime_pending || current?.candidate_mismatch || (current?.candidate_website && current.website && current.candidate_website !== current.website)) throw new Error('Candidate or pending write changed; inspect before resume.');
  if (current) assertActiveBusiness(current, { resuming: true });
  if (!current || !CHECKPOINTS.includes(current.checkpoint)) {
    throw new Error('Cannot resume with a missing or unknown checkpoint.');
  }
  if (current.blocker_type === 'submit_unknown') {
    throw new Error('Cannot resume when the submit outcome is unknown.');
  }
  if (current.blocker_type === 'forbidden_403') {
    throw new Error('Cannot resume after a real 403 block; audit public status only.');
  }
  if (['submit_click_started', 'submit_result_recorded'].includes(current.checkpoint)) {
    throw new Error('Cannot resume after final submit may have been clicked.');
  }
}

function assertTerminalCheckpoint({ result, reason, checkpoint }) {
  if (!CHECKPOINTS.includes(checkpoint)) {
    throw new Error(`Result ${result} requires a known checkpoint.`);
  }
  if (result === 'submitted') {
    if (checkpoint !== 'submit_result_recorded') throw new Error('Submitted requires submit_result_recorded checkpoint.');
    return;
  }
  const postClick = ['submit_click_started', 'submit_result_recorded'].includes(checkpoint);
  if (reason === 'submit_unknown') {
    if (result !== 'manual_review' || !postClick) {
      throw new Error('submit_unknown requires manual_review at a post-click checkpoint.');
    }
    return;
  }
  if (postClick) {
    throw new Error('After a post-click checkpoint, only submitted or manual_review/submit_unknown is allowed.');
  }
}

function assertSubmittedHasNoBlocker(result, reason) {
  if (result === 'submitted' && reason !== null && reason !== undefined && String(reason) !== '') {
    throw new Error('Submitted cannot include a blocker_type.');
  }
}

export function terminalPatch({ result, reason, checkpoint, evidence, businessStatus = null }) {
  if (!['submitted', 'blocked', 'ignore', 'manual_review'].includes(result)) throw new Error(`Unknown result: ${result}`);
  assertTerminalCheckpoint({ result, reason, checkpoint });
  if (result === 'submitted') {
    assertSubmittedHasNoBlocker(result, reason);
    if (!String(evidence || '').trim()) throw new Error('Submitted requires explicit confirmation evidence.');
    return {
      status: '待核验',
      automation_state: 'submitted',
      blocker_type: null,
      checkpoint: 'submit_result_recorded',
    };
  }
  if (!BLOCKER_TYPES.includes(reason)) throw new Error(`Result ${result} requires a known blocker_type.`);
  if (!String(evidence || '').trim()) throw new Error(`Result ${result} requires explicit evidence or a user action.`);
  if (result === 'ignore' && ![
    'low_quality', 'not_relevant', 'no_path', 'paid', 'reciprocal', 'phone_verify', 'site_registration',
  ].includes(reason)) {
    throw new Error('Ignore is limited to low_quality, not_relevant, no_path, paid, reciprocal, phone_verify, or site_registration.');
  }
  if (businessStatus && (result !== 'ignore' || !['受阻：人工处理','受阻：需换链/付费','受阻：暂缓（需内容/运营）','终止：网站失效','终止：不适合提交'].includes(businessStatus))) throw new Error('Invalid explicit business status for this result.');
  return {
    status: businessStatus || (['paid', 'reciprocal'].includes(reason) ? '受阻：需换链/付费' : ['not_relevant','low_quality'].includes(reason) ? '终止：不适合提交' : '受阻：人工处理'),
    automation_state: result,
    blocker_type: reason,
    checkpoint: ['submit_click_started', 'submit_result_recorded'].includes(checkpoint) ? 'submit_result_recorded' : checkpoint,
  };
}

export function assertNotesSnapshot(current, notesBefore) {
  if (typeof notesBefore !== 'string') throw new Error('notes-before must contain the reviewed original note (empty string if blank).');
  if ((current.notes ?? '') !== notesBefore) throw new Error('Base notes changed since review; read and review them before replacing.');
}

export function reviewedBaseNote(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A non-empty reviewed Base note is required; supply --base-note (base_note in audit reports).');
  }
  return value.trim();
}

export function terminalBaseNotePatch({ baseNote }) {
  return { notes: reviewedBaseNote(baseNote) };
}

function circuitDate(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeCircuitDomain(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? new URL(input) : new URL(`https://${input}`);
    return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function circuit403Domains(state) {
  return new Set((state?.events || [])
    .filter((event) => event?.type === 'forbidden_403')
    .flatMap((event) => [event.domain, event.website_domain, ...(Array.isArray(event.domains) ? event.domains : [])])
    .map(normalizeCircuitDomain)
    .filter(Boolean));
}

export function isCircuit403Blocked(state, { domain = '', recordId = '' } = {}) {
  const normalizedDomain = normalizeCircuitDomain(domain);
  return (state?.events || []).some((event) => {
    if (event?.type !== 'forbidden_403') return false;
    if (recordId && String(event.record_id || '') === String(recordId)) return true;
    return Boolean(normalizedDomain && [event.domain, event.website_domain, ...(Array.isArray(event.domains) ? event.domains : [])]
      .map(normalizeCircuitDomain)
      .includes(normalizedDomain));
  });
}

export async function assertCircuitDomainAvailable(path, { domain = '', recordId = '' } = {}) {
  const state = await readCircuit(path);
  if (state.open) throw new Error(`Submission circuit is open for today: ${state.reason}`);
  if (isCircuit403Blocked(state, { domain, recordId })) {
    const blockedDomain = normalizeCircuitDomain(domain) || recordId || 'this site';
    throw new Error(`Submission site is blocked for today after a real non-verification 403: ${blockedDomain}`);
  }
  return state;
}

export function updateCircuit(state, event, now = new Date()) {
  const day = circuitDate(now);
  if (state?.reason === 'circuit_state_unreadable') throw new Error('Restore the durable circuit state or explicitly reset it before recording events.');
  const current = state?.date === day ? state : { date: day, open: false, reason: null, events: [] };
  if (event.event_id && (current.events || []).some((item) => item.event_id === event.event_id)) return current;
  const events = [...(current.events || []), { ...event, at: now.toISOString() }];
  const immediate = ['ip_rate_limit', 'rate_limit_429'].includes(event.type);
  const open = current.open || immediate;
  const reason = current.reason || (immediate ? event.type : null);
  return { date: day, open, reason, events };
}

export async function readCircuit(path, now = new Date()) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!state || typeof state !== 'object' || typeof state.date !== 'string' || typeof state.open !== 'boolean' || !Array.isArray(state.events)) {
      throw new Error('Malformed circuit state.');
    }
    if (state.date !== circuitDate(now)) return { date: circuitDate(now), open: false, reason: null, events: [] };
    if (state.open && state.reason === 'repeated_security_blocks') {
      const hardStop = state.events.find((event) => ['ip_rate_limit', 'rate_limit_429'].includes(event?.type));
      if (!hardStop) return { ...state, open: false, reason: null };
      return { ...state, open: true, reason: hardStop.type };
    }
    return state;
  } catch {
    return { date: circuitDate(now), open: true, reason: 'circuit_state_unreadable', events: [] };
  }
}

export async function writeCircuit(path, state) {
  await mkdir(path.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(state, null, 2));
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function assertCircuitClosed(path) {
  const state = await readCircuit(path);
  if (state.open) throw new Error(`Submission circuit is open for today: ${state.reason}`);
  return state;
}

export async function assertCheckpointCircuitClosed(next, path = CIRCUIT_FILE, { website = '', recordId = '' } = {}) {
  if (next === 'submit_result_recorded') return true;
  await assertCircuitDomainAvailable(path, { domain: website, recordId });
  return true;
}

export async function withFileLock(path, action, { waitMs = 30_000 } = {}) {
  await mkdir(path.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let handle;
    try {
      handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === 2) throw new Error(`Another backlink Base writer is still active after 2 attempts (${path}). Stop this run.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(path).catch(() => {});
    }
  }
}

function assertOwned(record, runId) {
  if (record.automation_state !== 'running') throw new Error(`Record is not running: ${record.automation_state || 'blank'}`);
  if (!runId || record.automation_run_id !== runId) throw new Error('automation_run_id ownership mismatch.');
  if (record.candidate_website && record.candidate_website !== record.website) throw new Error('Candidate URL changed during this run; inspect before continuing.');
}

function assertAutomationLogReadback(record, expected, command) {
  if (record.automation_log !== expected) throw new Error(`${command} automation_log readback mismatch.`);
}

export function terminalRetryPatch({ current, runId, result, reason, evidence, now = new Date() }) {
  assertTerminalCheckpoint({ result, reason, checkpoint: current.checkpoint });
  const patch = {};
  patch.automation_log = appendAutomationLog(current.automation_log, {
    runId,
    event: finishEvent(current.automation_log, { runId, result, terminalRetry: true }),
    detail: `blocker=${reason || 'none'} evidence=${evidence}`,
    now,
  });
  // Terminal replay only repairs execution metadata; it never rewrites business fields.
  return patch;
}

async function bootstrap() {
  assertStandardSchema();
  loadRuntime();
  console.log(JSON.stringify({ validated: Object.keys(BUSINESS_SCHEMA), runtime: 'durable' }));
}

function assertStandardSchema() {
  const result = compareBaseSchema(listFields(resolveTarget()), getKitConfig());
  if (!result.ok) throw new Error(`Base schema mismatch; review migration before writing:\n${result.errors.join('\n')}`);
  return result;
}

async function init() {
  if (!has('--yes')) throw new Error('init requires --yes; only a new, empty Base may initialize runtime.');
  const kit = getKitConfig();
  try { await lstat(runtimePaths(kit).projectDir); throw new Error('Project runtime directory already exists; use bootstrap or restore the original ledger, never reinitialize it.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assertStandardSchema();
  const target = resolveTarget();
  const data = runLark(['base','+record-list','--base-token',target.baseToken,'--table-id',target.tableId,'--field-id','URL','--limit','1','--format','json','--as','user']).data;
  if (!Array.isArray(data?.data) || !Array.isArray(data?.record_id_list) || data.data.length || data.record_id_list.length || data.has_more !== false) throw new Error('init requires a confirmed empty Base; restore or explicitly migrate existing runtime instead.');
  let createCircuit = false;
  try {
    await lstat(CIRCUIT_FILE);
    if ((await readCircuit(CIRCUIT_FILE)).reason === 'circuit_state_unreadable') throw new Error('Restore the existing shared circuit before initialization.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const existing = (await readdir(SHARED_STATE_DIR)).filter(name => name !== 'base-write.lock');
    if (existing.length) throw new Error('Shared circuit missing in an existing workspace; restore it instead of initializing.');
    createCircuit = true;
  }
  initializeRuntime({},kit);
  if (createCircuit) await writeCircuit(CIRCUIT_FILE, {date:circuitDate(new Date()),open:false,reason:null,events:[]});
  console.log(JSON.stringify({initialized:true, project_id:kit.id, remote_writes:0}));
}

async function intake() {
  loadRuntime();
  const website = arg('--website');
  if (!website) throw new Error('intake requires --website.');
  const target = resolveTarget();
  const existingId = await findByWebsite(target, website);
  if (existingId) {
    console.log(JSON.stringify({ duplicate: true, record_id: existingId, website }, null, 2));
    return;
  }
  const patch = intakePatch({
    website,
    notes: arg('--notes'),
    submitUrl: arg('--submit-url'),
  });
  const submitter = getKitConfig().defaultSubmitter;
  if (submitter) patch.Submitter = [submitter];
  patch.name = normalizedDomain(website);
  const envelope = createRecord(target, patch);
  const recordId = createdRecordId(envelope) || await findByWebsite(target, website);
  if (!recordId) throw new Error('Created candidate could not be read back by website.');
  waitForReadback(
    () => getRecord(target, recordId),
    (record) => assertPatchReadback(record, patch, { command: 'Intake', recordId }),
  );
  console.log(JSON.stringify({ duplicate: false, record_id: recordId, website }, null, 2));
}

async function claim() {
  const recordId = arg('--record-id');
  if (!recordId) throw new Error('claim requires --record-id.');
  const circuitPath = CIRCUIT_FILE;
  await assertCircuitClosed(circuitPath);
  const target = resolveTarget();
  const current = getRecord(target, recordId);
  await assertCircuitDomainAvailable(circuitPath, { domain: current.website, recordId });
  if (!canClaim(current)) throw new Error(`Record cannot be claimed from status=${current.status.join(',')} automation_state=${current.automation_state || 'blank'}`);
  const runId = arg('--run-id') || randomUUID();
  const automationLog = current.automation_log;
  assertFreshClaimRun(automationLog, runId);
  const patch = {
    automation_state: 'running',
    blocker_type: null,
    checkpoint: 'claimed',
    automation_run_id: runId,
    candidate_website: current.website,
    claimed_status: selectValue(current.status),
    last_attempt_at: formatDateTime(new Date()),
    automation_log: appendAutomationLog(automationLog, {
      runId,
      event: 'claimed',
      detail: `website=${current.website}`,
    }),
  };
  if (arg('--submit-url')) patch.submit_url = arg('--submit-url');
  const after = updateRecord(target, recordId, patch, 'Update', current);
  assertOwned(after, runId);
  if (after.checkpoint !== 'claimed') throw new Error('Claim readback mismatch.');
  assertAutomationLogReadback(after, patch.automation_log, 'Claim');
  console.log(JSON.stringify({ record_id: recordId, run_id: runId, website: current.website }, null, 2));
}

async function get() {
  const recordId = arg('--record-id');
  if (!recordId) throw new Error('get requires --record-id.');
  console.log(JSON.stringify(getRecord(resolveTarget(), recordId), null, 2));
}

async function reopen() {
  const recordId = arg('--record-id');
  const evidence = arg('--evidence');
  const baseNote = arg('--base-note');
  if (!recordId || !evidence || !has('--yes')) {
    throw new Error('reopen requires --record-id, --evidence, and --yes.');
  }
  reviewedBaseNote(baseNote);
  const target = resolveTarget();
  const current = getRecord(target, recordId);
  const patch = reopenPatch({ current, evidence, baseNote, notesBefore: arg('--notes-before'), statusBefore: arg('--status-before'), websiteBefore: arg('--website-before') });
  patch.automation_log = appendAutomationLog(current.automation_log, {
    runId: current.automation_run_id || 'legacy',
    event: 'reopened',
    detail: evidence,
  });
  const after = updateRecord(target, recordId, patch, 'Update', current);
  if (!after.status.includes('待提交') || after.automation_state !== 'ready') {
    throw new Error('Reopen readback mismatch.');
  }
  if (after.automation_run_id || after.blocker_type || after.checkpoint) {
    throw new Error('Reopen did not clear the previous run ownership.');
  }
  assertAutomationLogReadback(after, patch.automation_log, 'Reopen');
  console.log(JSON.stringify({ record_id: recordId, status: after.status, automation_state: after.automation_state }, null, 2));
}

async function checkpoint() {
  const recordId = arg('--record-id');
  const runId = arg('--run-id');
  const next = arg('--checkpoint');
  if (!recordId || !runId || !next) throw new Error('checkpoint requires --record-id, --run-id, and --checkpoint.');
  const target = resolveTarget();
  const current = getRecord(target, recordId);
  await assertCheckpointCircuitClosed(next, CIRCUIT_FILE, { website: current.website, recordId });
  const { patch, unchanged } = buildCheckpointPatch({
    current,
    runId,
    checkpoint: next,
    detail: arg('--detail') || '',
    metricsCheckedInChrome: has('--metrics-checked-in-chrome'),
    submitUrl: arg('--submit-url'),
    dr: arg('--dr'),
    trafficK: arg('--traffic-k'),
    drUnavailable: has('--dr-unavailable'),
    trafficUnavailable: has('--traffic-unavailable'),
  });
  if (unchanged) {
    if (Object.keys(patch).length > 0) {
      const after = updateRecord(target, recordId, patch, 'Update', current);
      assertOwned(after, runId);
      if (patch.automation_log) assertAutomationLogReadback(after, patch.automation_log, 'Checkpoint');
    }
    console.log(JSON.stringify({ unchanged: true, record_id: recordId, checkpoint: next }, null, 2));
    return;
  }
  const after = updateRecord(target, recordId, patch, 'Update', current);
  assertOwned(after, runId);
  if (after.checkpoint !== next) throw new Error('Checkpoint readback mismatch.');
  if (patch.automation_log) assertAutomationLogReadback(after, patch.automation_log, 'Checkpoint');
  console.log(JSON.stringify({ record_id: recordId, run_id: runId, checkpoint: next }, null, 2));
}

async function finish() {
  if (process.argv.includes('--next-action-at')) {
    throw new Error('--next-action-at was removed; audit follow-up is initiated manually.');
  }
  const recordId = arg('--record-id');
  const runId = arg('--run-id');
  const result = arg('--result');
  const reason = arg('--blocker-type');
  const evidence = arg('--evidence');
  const baseNote = arg('--base-note');
  if (!recordId || !runId || !result) throw new Error('finish requires --record-id, --run-id, and --result.');
  assertSubmittedHasNoBlocker(result, reason);
  const notePatch = terminalBaseNotePatch({ baseNote });
  const circuitPath = CIRCUIT_FILE;
  const target = resolveTarget();
  const current = getRecord(target, recordId);
  if (typeof arg('--notes-before') !== 'string') throw new Error('finish requires notes-before: the reviewed original note, empty string if blank.');
  if (current.automation_run_id === runId && current.automation_state === result) {
    assertTerminalCheckpoint({ result, reason, checkpoint: current.checkpoint });
    if (!String(evidence || '').trim()) throw new Error(`Result ${result} requires explicit evidence or a user action.`);
    if (result !== 'submitted' && current.blocker_type !== reason) throw new Error('Terminal retry blocker_type mismatch.');
    if (result === 'submitted' && !protectedBusiness(current) && !current.status.includes('待核验')) throw new Error('Submitted legacy status readback mismatch.');
    const repairPatch = terminalRetryPatch({ current, runId, result, reason, evidence });
    if (
      repairPatch.automation_log !== current.automation_log
      || repairPatch.status
    ) {
      const after = updateRecord(target, recordId, repairPatch, 'Finish', current);
      assertAutomationLogReadback(after, repairPatch.automation_log, 'Finish');
      if (repairPatch.status && !after.status.some(value => value.startsWith('受阻：') || value.startsWith('终止：'))) throw new Error('Ignored legacy status readback mismatch.');
    }
    console.log(JSON.stringify({ unchanged: true, repaired_log: true, record_id: recordId, run_id: runId, automation_state: current.automation_state }, null, 2));
    return;
  }
  assertOwned(current, runId);
  const patch = terminalPatch({
    result,
    reason,
    checkpoint: current.checkpoint,
    evidence,
    businessStatus: arg('--business-status'),
  });
  const preserveBusiness = protectedBusiness(current);
  if (preserveBusiness) delete patch.status;
  else {
    assertNotesSnapshot(current, arg('--notes-before'));
    Object.assign(patch, notePatch);
  }
  const finishMarker = finishEvent(current.automation_log, { runId, result });
  patch.automation_log = appendAutomationLog(current.automation_log, {
    runId,
    event: finishMarker,
    detail: `blocker=${reason || 'none'} evidence=${evidence}`,
  });
  if (result === 'blocked' && ['cloudflare', 'forbidden_403', 'ip_rate_limit'].includes(reason)) {
    const previous = await readCircuit(circuitPath);
    const domain = normalizeCircuitDomain(current.website);
    await writeCircuit(circuitPath, updateCircuit(previous, {
      type: reason,
      record_id: recordId,
      domain,
      website_domain: domain,
      event_id: JSON.stringify([runId, recordId, finishMarker]),
    }));
  }
  patch.last_attempt_at = formatDateTime(new Date());
  const after = updateRecord(target, recordId, patch, 'Update', current);
  if (after.automation_run_id !== runId || after.automation_state !== patch.automation_state) throw new Error('Finish readback ownership/state mismatch.');
  if (patch.checkpoint && after.checkpoint !== patch.checkpoint) throw new Error('Finish checkpoint readback mismatch.');
  assertAutomationLogReadback(after, patch.automation_log, 'Finish');
  if (result === 'submitted' && !preserveBusiness && !after.status.includes('待核验')) throw new Error('Submitted legacy status readback mismatch.');
  if (result === 'ignore' && !preserveBusiness && !after.status.some(value => value.startsWith('受阻：') || value.startsWith('终止：'))) throw new Error('Ignored legacy status readback mismatch.');
  console.log(JSON.stringify({ record_id: recordId, run_id: runId, automation_state: after.automation_state, blocker_type: after.blocker_type, status: after.status }, null, 2));
}

async function resume() {
  const recordId = arg('--record-id');
  const runId = arg('--run-id');
  if (!recordId || !runId || !has('--yes')) throw new Error('resume requires --record-id, --run-id, and --yes.');
  const target = resolveTarget();
  const current = getRecord(target, recordId);
  assertResumeCheckpoint(current);
  await assertCircuitDomainAvailable(CIRCUIT_FILE, { domain: current.website, recordId });
  if (current.automation_state === 'running' && current.automation_run_id === runId && !current.blocker_type) {
    const detail = arg('--detail') || 'user-approved resume';
    const automationLog = appendAutomationLog(current.automation_log, { runId, event: resumeEvent(current.automation_log, runId), detail });
    const restoreStatus = current.status.includes('受阻：人工处理');
    const restoredStatus = restoreStatus ? '待提交' : selectValue(current.status);
    if (automationLog !== current.automation_log || restoreStatus || current.claimed_status !== restoredStatus) {
      const after = updateRecord(target, recordId, { automation_log: automationLog, claimed_status: restoredStatus, ...(restoreStatus ? { status: '待提交' } : {}) }, 'Resume', current);
      assertAutomationLogReadback(after, automationLog, 'Resume');
    }
    console.log(JSON.stringify({ unchanged: true, repaired_log: true, record_id: recordId, run_id: runId, automation_state: current.automation_state }, null, 2));
    return;
  }
  if (!['blocked', 'manual_review'].includes(current.automation_state)) throw new Error(`Cannot resume from ${current.automation_state || 'blank'}.`);
  if (current.automation_run_id !== runId) throw new Error('automation_run_id ownership mismatch.');
  const detail = arg('--detail') || 'user-approved resume';
  const patch = {
    status: '待提交',
    claimed_status: '待提交',
    automation_state: 'running',
    blocker_type: null,
    last_attempt_at: formatDateTime(new Date()),
    automation_log: appendAutomationLog(current.automation_log, { runId, event: resumeEvent(current.automation_log, runId), detail }),
  };
  const after = updateRecord(target, recordId, patch, 'Update', current);
  assertOwned(after, runId);
  assertAutomationLogReadback(after, patch.automation_log, 'Resume');
  console.log(JSON.stringify({ record_id: recordId, run_id: runId, automation_state: after.automation_state, checkpoint: after.checkpoint }, null, 2));
}

async function circuitCommand(command) {
  const path = CIRCUIT_FILE;
  if (command === 'circuit-check') {
    const state = await readCircuit(path);
    console.log(JSON.stringify(state, null, 2));
    if (state.open) process.exitCode = 3;
    return;
  }
  if (command === 'circuit-event') {
    const type = arg('--type');
    if (!['cloudflare', 'forbidden_403', 'rate_limit_429', 'ip_rate_limit'].includes(type)) throw new Error('Unknown circuit event type.');
    const state = updateCircuit(await readCircuit(path), { type, domain: arg('--domain') || null });
    await writeCircuit(path, state);
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (command === 'circuit-reset') {
    if (!has('--yes')) throw new Error('circuit-reset requires --yes.');
    const state = { date: circuitDate(new Date()), open: false, reason: null, events: [] };
    await writeCircuit(path, state);
    console.log(JSON.stringify(state, null, 2));
  }
}

async function main() {
  assertNoTargetOverrides();
  getKitConfig();
  structuredInputArgs = await loadInputJson();
  const command = process.argv[2];
  if (command === 'finish' && process.argv.includes('--next-action-at')) {
    throw new Error('--next-action-at was removed; audit follow-up is initiated manually.');
  }
  const lockPath = BASE_WRITE_LOCK_FILE;
  if (command === 'schema') { console.log(JSON.stringify(baseFields(getKitConfig()), null, 2)); return; }
  if (command === 'check-schema') {
    const result = compareBaseSchema(listFields(resolveTarget()), getKitConfig());
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'init') return withFileLock(lockPath, init);
  if (command === 'bootstrap') return withFileLock(lockPath, bootstrap);
  if (command === 'intake') return withFileLock(lockPath, intake);
  if (command === 'get') return get();
  if (command === 'reconcile') return withFileLock(lockPath, () => {
    const id = arg('--record-id');
    if (!id) throw new Error('reconcile requires --record-id.');
    console.log(JSON.stringify(reconcileRecord(resolveTarget(), id), null, 2));
  });
  if (command === 'reopen') return withFileLock(lockPath, reopen);
  if (command === 'claim') return withFileLock(lockPath, claim);
  if (command === 'checkpoint') return withFileLock(lockPath, checkpoint);
  if (command === 'finish') return withFileLock(lockPath, finish);
  if (command === 'resume') return withFileLock(lockPath, resume);
  if (command === 'lock-reset') {
    if (!has('--yes')) throw new Error('lock-reset requires --yes. Confirm no backlink writer is active first.');
    await unlink(lockPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    console.log(JSON.stringify({ reset: true, lock_file: lockPath }, null, 2));
    return;
  }
  if (command === 'circuit-check') return circuitCommand(command);
  if (['circuit-event', 'circuit-reset'].includes(command)) return withFileLock(lockPath, () => circuitCommand(command));
  throw new Error('Usage: run-state.mjs <bootstrap|intake|get|reopen|claim|checkpoint|finish|resume|lock-reset|circuit-check|circuit-event|circuit-reset> [options] [--input-json <file|->]');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
