import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSandbox, createSandbox, run, snapshotTree, snapshotsEqual } from './helpers.js';

describe('cli surface', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('help exits 0 and lists every command', () => {
    const result = run(['help'], sandbox);
    assert.equal(result.status, 0);
    for (const command of ['install', 'uninstall', 'doctor', 'verify']) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    }
    assert.match(result.stdout, /Usage:/);
  });

  it('--help exits 0 and prints usage', () => {
    const result = run(['--help'], sandbox);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it('every command supports -h', () => {
    for (const command of ['install', 'uninstall', 'doctor', 'verify']) {
      const result = run([command, '-h'], sandbox);
      assert.equal(result.status, 0, `${command} -h should exit 0`);
      assert.match(result.stdout, /Usage:/, `${command} -h should print usage`);
    }
  });

  it('--version exits 0 and prints the package version', () => {
    const result = run(['--version'], sandbox);
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('-V exits 0 too', () => {
    const result = run(['-V'], sandbox);
    assert.equal(result.status, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('an unknown command exits 2 with usage on stderr', () => {
    const result = run(['frobnicate'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stdout.trim(), '');
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /install/);
  });

  it('an unknown flag exits 2 with usage on stderr', () => {
    const result = run(['install', '--frobnicate'], sandbox);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });

  it('a flag missing its value exits 2', () => {
    const result = run(['install', '--pi-home'], sandbox);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });

  it('no arguments exits 2 with usage on stderr', () => {
    const result = run([], sandbox);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  });

  it('<command> --help writes nothing', () => {
    const before = snapshotTree(sandbox.root);
    for (const command of ['install', 'uninstall', 'doctor', 'verify']) {
      const result = run([command, '--help'], sandbox);
      assert.equal(result.status, 0);
    }
    assert.ok(snapshotsEqual(before, snapshotTree(sandbox.root)));
  });
});
