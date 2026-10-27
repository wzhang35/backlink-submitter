#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { loadKitConfig, repositoryRoot } from '../.agents/skills/backlink-submitter/scripts/kit-config.mjs';

const COMMANDS = new Map([
  ['collect', 'collect-submitted.mjs'],
  ['verify', 'verify-submitted.mjs'],
  ['apply', 'apply-submitted-updates.mjs'],
]);
const RUN_STATE_COMMANDS = new Set([
  'schema', 'check-schema', 'init', 'bootstrap', 'intake', 'get', 'reconcile', 'reopen', 'claim', 'checkpoint', 'finish', 'resume',
  'lock-reset', 'circuit-check', 'circuit-event', 'circuit-reset',
]);

function usage() {
  console.error('Usage: node scripts/backlinks.mjs <project-id> <collect|verify|apply|run-state-command> [options]');
  console.error('Setup: schema, check-schema, init (empty Base only), bootstrap. Run-state: intake, get, reconcile, reopen, claim, checkpoint, finish, resume, lock-reset, circuit-check, circuit-event, circuit-reset.');
  process.exitCode = 2;
}

const [, , projectId, command, ...args] = process.argv;
if (!projectId || !command) {
  usage();
} else {
  try {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) throw new Error('project-id must use lowercase letters, digits, and hyphens.');
    const root = repositoryRoot();
    const kitPath = resolve(root, 'projects', projectId, 'kit.json');
    const kit = loadKitConfig(kitPath, projectId);
    const filename = COMMANDS.get(command)
      || (RUN_STATE_COMMANDS.has(command) ? 'run-state.mjs' : null);
    if (!filename) throw new Error(`Unknown backlink command: ${command}.`);
    const scriptPath = join(root, '.agents', 'skills', 'backlink-submitter', 'scripts', filename);
    const child = spawnSync(process.execPath, [scriptPath, ...(filename === 'run-state.mjs' ? [command] : []), ...args], {
      cwd: root,
      env: { ...process.env, BACKLINK_KIT_PATH: kitPath },
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
