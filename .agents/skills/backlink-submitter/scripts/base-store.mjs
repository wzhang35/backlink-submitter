import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getKitConfig, runtimePaths, targetIdentity, assertArtifactIdentity, larkArgs } from './kit-config.mjs';
export { BUSINESS_SCHEMA, BUSINESS_STATUSES } from './base-schema.mjs';
import { BUSINESS_STATUSES } from './base-schema.mjs';

export const AUTOMATION_STATES = ['ready', 'running', 'blocked', 'submitted', 'ignore', 'manual_review'];
export const BLOCKER_TYPES = [
  'cloudflare',
  'captcha',
  'forbidden_403',
  'ip_rate_limit',
  'login_verify',
  'email_confirm',
  'paid',
  'reciprocal',
  'no_path',
  'low_quality',
  'not_relevant',
  'ambiguous',
  'submit_unknown',
  'stale_lock',
  'further_process',
  'phone_verify',
  'site_registration',
];
export const CHECKPOINTS = [
  'claimed',
  'public_precheck_done',
  'form_ready',
  'form_filled',
  'pre_submit_verified',
  'submit_click_started',
  'submit_result_recorded',
];

export const INTERNAL_FIELDS = new Set(['automation_state', 'blocker_type', 'checkpoint', 'automation_run_id', 'last_attempt_at', 'automation_log', 'candidate_website', 'claimed_status']);
export const BUSINESS_FIELDS = ['URL', 'status', 'date', 'notes', 'submit_url', 'myurl', 'link_type', 'name', 'category', 'Submitter'];
export const firstUrl = (value) => String(value || '').match(/\[[^\]]*]\((https?:\/\/[^)]+)\)/)?.[1] || String(value || '');
// Shared services host independent submission resources; ordinary sites dedupe by host.
const SHARED_HOSTS = ['github.com','gitlab.com','tally.so','airtable.com','forms.gle','docs.google.com','form.typeform.com','forms.office.com','frms.link','notion.site','medium.com','substack.com','beehiiv.com'];
export function candidateIdentity(value) {
  const parsed = new URL(firstUrl(value));
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!SHARED_HOSTS.some(shared => host === shared || host.endsWith(`.${shared}`))) return host;
  for (const key of [...parsed.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const query = parsed.searchParams.toString();
  return `${host}${path}${query ? '?' + query : ''}`;
}
export function sharedResourceMatches(candidate, page) {
  try {
    const source = new URL(firstUrl(candidate)), target = new URL(firstUrl(page));
    const host = source.hostname.toLowerCase().replace(/^www\./, '');
    if (!SHARED_HOSTS.some(shared => host === shared || host.endsWith(`.${shared}`))) return true;
    if (target.hostname.toLowerCase().replace(/^www\./, '') !== host) return false;
    const path = source.pathname.replace(/\/+$/, '') || '/';
    const targetPath = target.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' ? targetPath !== '/' : targetPath !== path && !targetPath.startsWith(path + '/')) return false;
    for (const key of source.searchParams.keys()) {
      if (!key.toLowerCase().startsWith('utm_') && JSON.stringify(source.searchParams.getAll(key)) !== JSON.stringify(target.searchParams.getAll(key))) return false;
    }
    return true;
  } catch { return false; }
}
const selected = (value) => Array.isArray(value) ? value[0] || null : value || null;

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.new`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function runtimeDigest(state) {
  const { integrity_sha256, ...payload } = state;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateRuntimeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Malformed runtime record.');
  for (const key of INTERNAL_FIELDS) {
    if (!Object.hasOwn(row,key) || !(row[key] === null || typeof row[key] === 'string')) throw new Error(`Malformed runtime record field: ${key}`);
  }
  if (row.automation_state !== null && !AUTOMATION_STATES.includes(row.automation_state)) throw new Error('Invalid runtime execution state.');
  if (row.blocker_type !== null && !BLOCKER_TYPES.includes(row.blocker_type)) throw new Error('Invalid runtime blocker.');
  if (row.checkpoint !== null && !CHECKPOINTS.includes(row.checkpoint)) throw new Error('Invalid runtime checkpoint.');
  if (row.automation_state === 'running' && (!row.automation_run_id || !row.checkpoint || !row.candidate_website || !row.claimed_status)) throw new Error('Running record is missing ownership or checkpoint.');
  if (row.blocker_type === 'submit_unknown' && !['submit_click_started','submit_result_recorded'].includes(row.checkpoint)) throw new Error('Unknown submit outcome is missing a post-click checkpoint.');
  if (row.pending) {
    if (typeof row.pending !== 'object' || !row.pending.patch || typeof row.pending.patch !== 'object' || Array.isArray(row.pending.patch) || typeof row.pending.website !== 'string' || !Object.hasOwn(row.pending,'date')) throw new Error('Malformed pending intent.');
    if (row.pending.next?.pending) throw new Error('Nested pending intent.');
    validateRuntimeRecord(row.pending.next);
  }
}

function saveRuntime(state, kit) {
  for (const row of Object.values(state.records)) validateRuntimeRecord(row);
  state.integrity_sha256 = runtimeDigest(state);
  atomicJson(runtimePaths(kit).stateFile,state);
}

export function loadRuntime(kit = getKitConfig()) {
  const path = runtimePaths(kit).stateFile;
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Runtime unavailable at ${path}; restore the durable state or initialize only after migration review. ${error.message}`); }
  assertArtifactIdentity(state, kit);
  if (state.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('Invalid runtime state.');
  if (typeof state.integrity_sha256 !== 'string' || state.integrity_sha256 !== runtimeDigest(state)) throw new Error('Runtime integrity check failed; restore the durable ledger before continuing.');
  for (const row of Object.values(state.records)) validateRuntimeRecord(row);
  return state;
}

export function initializeRuntime(records = {}, kit = getKitConfig()) {
  const path = runtimePaths(kit).stateFile;
  try { readFileSync(path); throw new Error('Runtime already exists; refusing to overwrite it.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const normalized = {};
  for (const [id,row] of Object.entries(records)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid initial runtime record.');
    normalized[id] = { ...Object.fromEntries([...INTERNAL_FIELDS].map(key => [key,null])), ...row };
  }
  const state = { version: 1, ...targetIdentity(kit), records: normalized };
  saveRuntime(state,kit);
  return state;
}

export function localRecord(recordId, kit = getKitConfig()) {
  const records = loadRuntime(kit).records;
  const row = Object.hasOwn(records,recordId) ? records[recordId] : {}; // Absence is valid only in an intact ledger.
  return { ...Object.fromEntries([...INTERNAL_FIELDS].map(k => [k, row[k] ?? null])), ...(row.pending ? { runtime_pending: row.pending } : {}) };
}

export function saveLocalRecord(recordId, row, kit = getKitConfig()) {
  const state = loadRuntime(kit);
  state.records[recordId] = row;
  saveRuntime(state,kit);
}

export function runLark(args) {
  const res = spawnSync('lark-cli', larkArgs(args), { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || `lark-cli exited ${res.status}`);
  const data = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  if (data.ok === false) throw new Error(JSON.stringify(data.error));
  return data;
}

export function decodeBusinessRecord(envelope, fields = BUSINESS_FIELDS) {
  const row = envelope?.data?.data?.[0];
  if (!row) throw new Error('Record not found.');
  const record = Object.fromEntries(fields.map((field, i) => [field, row[i] ?? null]));
  record.website = firstUrl(record.URL);
  record.status = Array.isArray(record.status) ? record.status : record.status ? [record.status] : [];
  record.link_type = selected(record.link_type);
  record.dofollow = ({dofollow:'Yes', nofollow:'No'})[record.link_type] || null;
  record.myurl = record.myurl ? firstUrl(record.myurl) : null;
  return record;
}

export function readBusinessRecord(target, recordId, extraFields = []) {
  const fields = [...new Set([...BUSINESS_FIELDS, ...extraFields])];
  const envelope = runLark(['base', '+record-get', '--base-token', target.baseToken, '--table-id', target.tableId,
    '--record-id', recordId, '--format', 'json', '--as', 'user', ...fields.flatMap(field => ['--field-id', field])]);
  return { ...decodeBusinessRecord(envelope, fields), record_id: recordId };
}

export function readHybridRecord(target, recordId, extraFields = []) {
  const business = readBusinessRecord(target, recordId, extraFields), local = localRecord(recordId);
  return { ...business, ...local, candidate_mismatch: Boolean(local.candidate_website && local.candidate_website !== business.website) };
}

export function businessPatch(patch) {
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (INTERNAL_FIELDS.has(key)) continue;
    if (key === 'website') result.URL = value;
    else if (key === 'dofollow') {
      if (!['Yes','No'].includes(value)) throw new Error('Unknown link attribute cannot be written as a verified link_type.');
      result.link_type = value === 'Yes' ? 'dofollow' : 'nofollow';
    } else result[key] = value;
  }
  if (result.status === 'succeed') {
    if (!['dofollow','nofollow','nolink'].includes(result.link_type)) throw new Error('Verified status requires a matching link_type.');
    result.status = `已验证：${result.link_type}`;
  }
  if (result.status === 'submited') result.status = '待核验';
  if (result.status === 'watching') result.status = '待提交';
  if (result.status === 'to-submit') result.status = '待提交';
  if (result.status === 'ignored') result.status = ['paid','reciprocal'].includes(patch.blocker_type) ? '受阻：需换链/付费'
    : ['not_relevant','low_quality'].includes(patch.blocker_type) ? '终止：不适合提交' : '受阻：人工处理';
  if (result.status?.startsWith('已验证：') && result.status !== '已验证：未找到记录' && result.status !== `已验证：${result.link_type}`) throw new Error('Verified status and link_type must agree.');
  if (result.status && !BUSINESS_STATUSES.includes(result.status)) throw new Error('Unsupported business status.');
  if (Object.hasOwn(result, 'date')) throw new Error('Archive dates cannot be written by the workflow.');
  for (const key of Object.keys(result)) {
    if (![...BUSINESS_FIELDS, 'DR', 'Traffic (k)', 'cost'].includes(key)) throw new Error(`Unsupported business field: ${key}`);
  }
  for (const key of ['status','Submitter','category','link_type']) {
    if (typeof result[key] === 'string') result[key] = [result[key]];
  }
  return result;
}

function valueEqual(key, expected, actual) {
  if (['status','Submitter','category','link_type'].includes(key)) return JSON.stringify(Array.isArray(expected) ? expected : expected == null ? [] : [expected]) === JSON.stringify(Array.isArray(actual) ? actual : actual == null ? [] : [actual]);
  if (['URL','submit_url','myurl'].includes(key)) return firstUrl(expected) === firstUrl(actual);
  return (expected ?? null) === (actual ?? null);
}

export function reconcileRecord(target, recordId) {
  const local = localRecord(recordId);
  if (!local.runtime_pending) return readHybridRecord(target, recordId);
  const pending = local.runtime_pending;
  const current = readBusinessRecord(target, recordId, Object.keys(pending.patch));
  if (!pending.website || current.website !== pending.website || (local.candidate_website && local.candidate_website !== current.website) || current.date !== pending.date || !Object.entries(pending.patch).every(([k,v]) => valueEqual(k,v,current[k]))) {
    throw new Error('Unconfirmed Base write; keep the run blocked, inspect the record and pending intent. Do not repeat the website action.');
  }
  saveLocalRecord(recordId, pending.next);
  return { ...current, ...pending.next };
}

// The caller holds the shared writer lock. Persist intent before a remote write.
export function writeHybridRecord(target, recordId, patch, validate, readback, expected = null) {
  const current = readHybridRecord(target, recordId);
  if (current.runtime_pending) throw new Error('Unconfirmed write exists; inspect get and reconcile before continuing.');
  if (current.candidate_mismatch) throw new Error('Candidate URL changed; keep the previous run blocked and inspect its ownership.');
  if (expected) {
    for (const key of ['notes','status','website','date','myurl','link_type']) {
      if (Object.hasOwn(expected,key) && !valueEqual(key,expected[key],current[key])) throw new Error(`Base ${key} changed since review; inspect before writing.`);
    }
  }
  const remote = businessPatch(patch);
  if (Object.hasOwn(remote,'notes') && (!expected || !Object.hasOwn(expected,'notes'))) throw new Error('A reviewed original notes snapshot is required for replacement.');
  const next = { ...localRecord(recordId), ...Object.fromEntries(Object.entries(patch).filter(([key]) => INTERNAL_FIELDS.has(key))) };
  if (Object.keys(remote).length) {
    saveLocalRecord(recordId, { ...localRecord(recordId), pending: { patch: remote, next, date: current.date, website: current.website } });
    runLark(['base', '+record-upsert', '--base-token', target.baseToken, '--table-id', target.tableId,
      '--record-id', recordId, '--json', JSON.stringify(remote), '--as', 'user', '--format', 'json']);
  }
  const businessAfter = readback(() => readBusinessRecord(target, recordId, Object.keys(remote)), (row) => {
    if (row.website !== current.website || row.date !== current.date || !Object.entries(remote).every(([k,v]) => valueEqual(k,v,row[k]))) {
      throw new Error('Base write readback mismatch or candidate URL changed; inspect get before any retry.');
    }
    if (expected) {
      for (const key of ['notes','status','website','date','myurl','link_type']) {
        if (!Object.hasOwn(remote,key) && Object.hasOwn(expected,key) && !valueEqual(key,expected[key],row[key])) throw new Error(`Base ${key} changed during the operation; inspect before continuing.`);
      }
    }
  });
  const after = { ...businessAfter, ...next };
  validate?.(after);
  saveLocalRecord(recordId, next);
  return after;
}
