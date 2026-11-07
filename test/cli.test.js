import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSandbox, createSandbox, run, runWithStdin, recorder, snapshotTree, snapshotsEqual } from './helpers.js';
import { createUi } from '../src/ui.js';

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

  it('--json with --version emits a JSON document on stdout', () => {
    const result = run(['--json', '--version'], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, true);
    assert.match(doc.version, /^\d+\.\d+\.\d+$/);
  });

  it('--json with --help emits a JSON document on stdout', () => {
    const result = run(['--json', '--help'], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, true);
    assert.ok(doc.usage);
    assert.ok(doc.commands);
  });

  it('--json with help emits a JSON document on stdout', () => {
    const result = run(['--json', 'help'], sandbox);
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, true);
    assert.ok(doc.usage);
  });

  it('--json with unknown command emits JSON error on stdout, not stderr', () => {
    const result = run(['--json', 'frobnicate'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /unknown command/);
  });

  it('--json with unknown flag emits JSON error on stdout', () => {
    const result = run(['--json', 'install', '--frobnicate'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /unknown option/);
  });

  it('--json with missing flag value emits JSON error on stdout', () => {
    const result = run(['--json', 'install', '--pi-home'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /requires a value/);
  });

  it('--json with no arguments emits JSON error on stdout', () => {
    const result = run(['--json'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /no command/);
  });

  it('-- ends option parsing; remaining tokens are positionals', () => {
    const result = run(['install', '--', '--unknown', '-y', '--json'], sandbox);
    // --unknown after -- should NOT be parsed as a flag; since install doesn't take
    // positional args, this becomes "unexpected argument" with exit 2
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unexpected argument/);
  });

  it('-- before command separates global flags from command', () => {
    const result = run(['--json', '--', 'install', '--help'], sandbox);
    // --json is a global flag; -- ends global parsing; install is command; --help after command
    // is a flag for install. Should print install help as JSON.
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, true);
    assert.ok(doc.usage);
    assert.ok(doc.commands);
  });

  it('value starting with - accepted in --opt=value form', () => {
    const result = run(['--json', '--model=-x'], sandbox);
    assert.equal(result.status, 2); // no command provided
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.match(doc.error, /no command/);
    // The key test: parsing didn't fail with "requires a value"
  });

  it('value starting with - accepted in --opt value form', () => {
    const result = run(['--json', '--model', '-x'], sandbox);
    assert.equal(result.status, 2); // no command
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.match(doc.error, /no command/);
    // The key test: '-x' was accepted as the value, not rejected as flag
  });

  it('literal - as value works', () => {
    const result = run(['--json', '--model', '-'], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.match(doc.error, /no command/);
  });

  it('install without --yes in TTY prompts and defaults to no', async () => {
    const box = createSandbox({ precreate: false });
    try {
      const result = await runWithStdin(['install'], box, 'n\n', { env: { PI_DSH_BRIDGE_FORCE_INTERACTIVE: '1' } });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /proceed/i);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('install with --yes skips prompt', () => {
    const box = createSandbox({ precreate: false });
    try {
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('--model= with empty value is rejected', () => {
    const result = run(['--json', '--model='], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /empty value/);
  });

  it('--provider= with empty value is rejected', () => {
    const result = run(['--json', '--provider='], sandbox);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), '');
    const doc = JSON.parse(result.stdout.trim());
    assert.equal(doc.ok, false);
    assert.equal(doc.code, 2);
    assert.match(doc.error, /empty value/);
  });

  it('waitForEnter resolves false on EOF (Ctrl-D)', async () => {
    const stdout = recorder({ isTTY: true });
    const listeners = new Map();
    const stdin = {
      isTTY: true,
      resume() {},
      pause() {},
      on(event, handler) { listeners.set(event, handler); if (event === 'end') setTimeout(handler, 0); },
      once(event, handler) { if (event === 'data') setTimeout(() => handler(Buffer.from('')), 0); },
      removeListener(event, handler) { if (listeners.get(event) === handler) listeners.delete(event); },
    };
    const ui = createUi({ stdout, stdin, env: { PI_DSH_BRIDGE_FORCE_INTERACTIVE: '1' } });
    const result = await ui.waitForEnter('Press Enter');
    assert.equal(result, false);
  });

  it('waitForEnter resolves false on close', async () => {
    const stdout = recorder({ isTTY: true });
    const listeners = new Map();
    const stdin = {
      isTTY: true,
      resume() {},
      pause() {},
      on(event, handler) { listeners.set(event, handler); if (event === 'close') setTimeout(handler, 0); },
      once(event, handler) { if (event === 'data') setTimeout(() => handler(Buffer.from('')), 0); },
      removeListener(event, handler) { if (listeners.get(event) === handler) listeners.delete(event); },
    };
    const ui = createUi({ stdout, stdin, env: { PI_DSH_BRIDGE_FORCE_INTERACTIVE: '1' } });
    const result = await ui.waitForEnter('Press Enter');
    assert.equal(result, false);
  });
});
