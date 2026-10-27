import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeBusinessRecord, localRecord, runLark } from './base-store.mjs';
import { assertNoTargetOverrides, getKitConfig, runtimePaths, targetIdentity } from './kit-config.mjs';

const FIELDS = ['URL', 'status', 'date', 'notes', 'link_type', 'myurl'];

const POST_CLICK_CHECKPOINTS = new Set(['submit_click_started', 'submit_result_recorded']);


function selected(value) {
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

function statusValues(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => String(item).toLowerCase());
}

export function isAuditEligible(record) {
  const statuses = statusValues(record.status);
  const automationState = selected(record.automation_state);
  const blockerType = selected(record.blocker_type);
  const checkpoint = selected(record.checkpoint);

  if (record.runtime_pending || record.candidate_mismatch || (record.candidate_website && record.website && record.candidate_website !== record.website) || statuses.some(value => value.startsWith('终止：'))) return false;
  if (statuses.some(status => status.startsWith('受阻：') && status !== '受阻：人工处理')) return false;
  if (statuses.some(status => status.startsWith('已验证：') && status !== '已验证：未找到记录')) return false;
  if (statuses.some((status) => ['succeed', 'succeeded', 'ignored', 'ignore', 'declined', 'rejected'].includes(status))) return false;
  if (automationState === 'ignore' || blockerType === 'stale_lock') return false;
  if (statuses.some(value => ['待核验','已验证：未找到记录','submited','submitted'].includes(value))) return true;
  return automationState === 'manual_review'
    && blockerType === 'submit_unknown'
    && POST_CLICK_CHECKPOINTS.has(checkpoint);
}

export function collectEligibleRecords(data, stateFor = localRecord) {
  return data.data.flatMap((row, i) => {
    const id = data.record_id_list[i];
    const business = decodeBusinessRecord({data: {data: [row]}}, FIELDS);
    const record = { record_id: id, ...business, ...stateFor(id) };
    return isAuditEligible(record) ? [record] : [];
  });
}

function resolveTarget(kit) {
  return {
    baseToken: kit.base.baseToken,
    tableId: kit.base.tableId,
    viewId: kit.base.viewId,
  };
}

async function main() {
  assertNoTargetOverrides();
  if (process.argv.includes('--include-not-due')) {
    throw new Error('--include-not-due was removed; manual collection always selects every eligible record.');
  }
  const kit = getKitConfig();
  const { candidatesFile } = runtimePaths(kit);
  const target = resolveTarget(kit);
  const records = [];
  for (let offset = 0; ; offset += 200) {
    const args = [
      'base', '+record-list',
      '--base-token', target.baseToken,
      '--table-id', target.tableId,
      '--limit', '200',
      '--offset', String(offset),
      '--format', 'json',
      '--as', 'user',
    ];
    for (const field of FIELDS) args.push('--field-id', field);
    const envelope = runLark(args);
    const data = envelope.data;
    records.push(...collectEligibleRecords(data));
    if (!data.has_more) break;
  }

  await mkdir(dirname(candidatesFile), { recursive: true });
  await writeFile(candidatesFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    artifact_sensitivity: 'private',
    ...targetIdentity(kit),
    target: {
      tableId: target.tableId,
      viewId: target.viewId,
    },
    records,
  }, null, 2));

  console.log(JSON.stringify({ output: candidatesFile, eligibleAuditRecords: records.length }, null, 2));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
