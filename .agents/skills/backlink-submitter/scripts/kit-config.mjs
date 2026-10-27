import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TARGET_OVERRIDE_FLAGS = new Set([
  '--wiki-url', '--base-token', '--table-id', '--view-id',
  '--lock-file', '--circuit-file',
]);

let activeKit = null;

export function repositoryRoot() {
  return REPO_ROOT;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`kit.json requires ${label}.`);
  return value.trim();
}

function requireHttpUrl(value, label) {
  const text = requireText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`kit.json ${label} must be an absolute HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`kit.json ${label} must be an absolute HTTP(S) URL.`);
  }
  return text;
}

export function validateKitConfig(raw, expectedId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('kit.json must contain an object.');
  const id = requireText(raw.id, 'id');
  if (!PROJECT_ID_RE.test(id)) throw new Error('kit.json id must use lowercase letters, digits, and hyphens.');
  if (expectedId && id !== expectedId) throw new Error(`kit.json id mismatch: expected ${expectedId}, received ${id}.`);
  let sourceProjectRoot;
  if (raw.sourceProjectRoot !== undefined) {
    sourceProjectRoot = requireText(raw.sourceProjectRoot, 'sourceProjectRoot');
    if (!isAbsolute(sourceProjectRoot)) throw new Error('kit.json sourceProjectRoot must be an absolute path.');
  }
  if (!raw.base || typeof raw.base !== 'object' || Array.isArray(raw.base)) throw new Error('kit.json requires base configuration.');
  const base = {
    wikiUrl: requireHttpUrl(raw.base.wikiUrl, 'base.wikiUrl'),
    baseToken: requireText(raw.base.baseToken, 'base.baseToken'),
    tableId: requireText(raw.base.tableId, 'base.tableId'),
    viewId: raw.base.viewId == null ? null : requireText(raw.base.viewId, 'base.viewId'),
  };
  const wiki = new URL(base.wikiUrl);
  const linkedTableId = wiki.searchParams.get('table');
  const linkedViewId = wiki.searchParams.get('view');
  if (linkedTableId && linkedTableId !== base.tableId) throw new Error('kit.json base.tableId conflicts with the table query in base.wikiUrl.');
  if (linkedViewId && linkedViewId !== base.viewId) throw new Error('kit.json base.viewId conflicts with the view query in base.wikiUrl.');
  return {
    id,
    name: requireText(raw.name, 'name'),
    website: requireHttpUrl(raw.website, 'website'),
    submissionKitUrl: requireHttpUrl(raw.submissionKitUrl, 'submissionKitUrl'),
    ...(sourceProjectRoot ? { sourceProjectRoot } : {}),
    base,
    ...(raw.profile !== undefined ? { profile: requireText(raw.profile, 'profile') } : {}),
    ...(raw.defaultSubmitter !== undefined ? { defaultSubmitter: requireText(raw.defaultSubmitter, 'defaultSubmitter') } : {}),
  };
}

export function loadKitConfig(path, expectedId = null) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read project kit at ${path}: ${error.message}`);
  }
  return validateKitConfig(raw, expectedId);
}

export function setActiveKitConfig(config) {
  activeKit = validateKitConfig(config);
  return activeKit;
}

export function getKitConfig() {
  if (activeKit) return activeKit;
  const path = process.env.BACKLINK_KIT_PATH;
  if (!path) throw new Error('Select a project with `node scripts/backlinks.mjs <project-id> <command>` first.');
  activeKit = loadKitConfig(path);
  const expectedPath = join(REPO_ROOT, 'projects', activeKit.id, 'kit.json');
  if (resolve(path) !== resolve(expectedPath)) throw new Error('BACKLINK_KIT_PATH must point to this repository project’s kit.json.');
  return activeKit;
}

export function targetIdentity(kit = getKitConfig()) {
  return {
    project_id: kit.id,
    website: kit.website,
    base: {
      wikiUrl: kit.base.wikiUrl,
      tableId: kit.base.tableId,
      viewId: kit.base.viewId,
      base_id_hash: createHash('sha256').update(kit.base.baseToken).digest('hex'),
    },
  };
}

export function assertArtifactIdentity(artifact, kit = getKitConfig()) {
  const expected = targetIdentity(kit);
  const actualBase = artifact?.base;
  if (
    artifact?.project_id !== expected.project_id
    || artifact?.website !== expected.website
    || !actualBase
    || actualBase.wikiUrl !== expected.base.wikiUrl
    || actualBase.tableId !== expected.base.tableId
    || (actualBase.viewId ?? null) !== expected.base.viewId
    || actualBase.base_id_hash !== expected.base.base_id_hash
  ) {
    throw new Error('Audit report project/Base identity is missing or does not match the selected kit. Add the verified project_id, website, and base identity before importing an older report.');
  }
}

export function assertNoTargetOverrides(args = process.argv.slice(2)) {
  const flag = args.find((value) => TARGET_OVERRIDE_FLAGS.has(value));
  if (flag) throw new Error(`${flag} cannot override the selected project kit or shared safety state.`);
}

export function runtimePaths(kit = getKitConfig()) {
  const sharedDir = join(REPO_ROOT, '.local', 'backlink-submitter');
  const projectDir = join(sharedDir, kit.id);
  return {
    sharedDir,
    projectDir,
    circuitFile: join(sharedDir, 'circuit.json'),
    baseWriteLockFile: join(sharedDir, 'base-write.lock'),
    stateFile: join(projectDir, 'runtime.json'),
    candidatesFile: join(REPO_ROOT, 'tmp', 'backlink-submitter', kit.id, 'backlink-submitted-candidates.json'),
  };
}

export function larkArgs(args, kit = getKitConfig()) {
  return kit.profile ? [...args, '--profile', kit.profile] : args;
}
