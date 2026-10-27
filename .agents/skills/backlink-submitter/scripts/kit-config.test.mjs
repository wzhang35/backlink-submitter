import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertArtifactIdentity,
  assertNoTargetOverrides,
  loadKitConfig,
  repositoryRoot,
  runtimePaths,
  targetIdentity,
  validateKitConfig,
} from './kit-config.mjs';

const exampleKit = loadKitConfig(`${repositoryRoot()}/projects/example/kit.json`, 'example');

test('kit config rejects table or view IDs that conflict with its Base URL', () => {
  assert.throws(() => validateKitConfig({
    id: 'bad-kit',
    name: 'Bad Kit',
    website: 'https://bad.example/',
    submissionKitUrl: 'https://feishu.example/wiki/kit',
    sourceProjectRoot: '/tmp/source',
    base: {
      wikiUrl: 'https://feishu.example/wiki/base?table=tbl-a&view=vew-a',
      baseToken: 'base-a',
      tableId: 'tbl-b',
      viewId: 'vew-a',
    },
  }), /tableId conflicts/);
});

test('sourceProjectRoot is optional and must be absolute when supplied', () => {
  const withoutRoot = validateKitConfig({
    id: 'no-assets', name: 'No Assets', website: 'https://no-assets.example/',
    submissionKitUrl: 'https://docs.example/no-assets',
    base: { wikiUrl: 'https://feishu.example/wiki/base', baseToken: 'token', tableId: 'tbl', viewId: null },
  });
  assert.equal(Object.hasOwn(withoutRoot, 'sourceProjectRoot'), false);
  assert.throws(() => validateKitConfig({
    ...withoutRoot, sourceProjectRoot: 'relative/path',
  }), /sourceProjectRoot must be an absolute path/);
});

test('project and Base identity blocks importing another product report', () => {
  const otherKit = validateKitConfig({
    id: 'other-product',
    name: 'Other Product',
    website: 'https://other.example/',
    submissionKitUrl: 'https://feishu.example/wiki/other-kit',
    sourceProjectRoot: '/tmp/other-product',
    base: {
      wikiUrl: 'https://feishu.example/wiki/other-base?table=tbl-other&view=vew-other',
      baseToken: 'base-other',
      tableId: 'tbl-other',
      viewId: 'vew-other',
    },
  });
  const report = targetIdentity(exampleKit);

  assert.doesNotThrow(() => assertArtifactIdentity(report, exampleKit));
  assert.throws(() => assertArtifactIdentity(report, otherKit), /project\/Base identity/);
  assert.notEqual(runtimePaths(exampleKit).projectDir, runtimePaths(otherKit).projectDir);
  assert.equal(runtimePaths(exampleKit).circuitFile, runtimePaths(otherKit).circuitFile);
  assert.equal(runtimePaths(exampleKit).baseWriteLockFile, runtimePaths(otherKit).baseWriteLockFile);
});

test('Base identity fingerprints the token without exposing it in artifacts', () => {
  const report = targetIdentity(exampleKit);
  const sameBaseUrlWrongToken = validateKitConfig({
    ...exampleKit,
    base: { ...exampleKit.base, baseToken: `${exampleKit.base.baseToken}-wrong` },
  });

  assert.equal(Object.hasOwn(report.base, 'baseToken'), false);
  assert.notEqual(report.base.base_id_hash, targetIdentity(sameBaseUrlWrongToken).base.base_id_hash);
  assert.throws(() => assertArtifactIdentity(report, sameBaseUrlWrongToken), /project\/Base identity/);
  assert.throws(() => assertArtifactIdentity({ ...report, base: { ...report.base, base_id_hash: undefined } }, exampleKit), /project\/Base identity/);
});

test('target and safety-state paths cannot be overridden through command-line flags', () => {
  assert.throws(() => assertNoTargetOverrides(['get', '--table-id', 'another-table']), /cannot override/);
  assert.throws(() => assertNoTargetOverrides(['claim', '--lock-file', '/tmp/other.lock']), /cannot override/);
  assert.doesNotThrow(() => assertNoTargetOverrides(['get', '--record-id', 'rec1']));
});

test('project account routing and default submitter survive config validation', () => {
  const configured = validateKitConfig({...exampleKit,profile:'test-account',defaultSubmitter:'example-owner'});
  assert.equal(configured.profile,'test-account');
  assert.equal(configured.defaultSubmitter,'example-owner');
  assert.throws(()=>validateKitConfig({...exampleKit,profile:''}),/profile/);
});
