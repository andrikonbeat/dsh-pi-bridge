import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { compareVersions, isNodeSupported, nodeCheck, probeCommand } from '../src/preflight.js';
import { cleanupSandbox, createSandbox } from './helpers.js';

describe('version comparison', () => {
  it('orders two parsable versions', () => {
    assert.equal(compareVersions('22.19.0', '22.19.0'), 0);
    assert.equal(compareVersions('22.19.1', '22.19.0'), 1);
    assert.equal(compareVersions('22.18.9', '22.19.0'), -1);
    assert.equal(compareVersions('22.19.0', '22.19.0-rc.1'), 1);
  });

  it('fails closed on an unparsable version (S4-6)', () => {
    // The old behaviour returned 0, which read as "equal" and made any
    // garbage version look supported.
    assert.ok(
      !(compareVersions('garbage', '22.19.0') >= 0),
      'an unparsable version must not compare as newer or equal',
    );
    assert.ok(
      !(compareVersions('22.19.0', 'garbage') >= 0),
      'an unparsable floor must not be treated as satisfied',
    );
  });

  it('rejects an unparsable node version (S4-6)', () => {
    assert.equal(isNodeSupported('22.19.0'), true);
    assert.equal(isNodeSupported('22.18.0'), false);
    assert.equal(isNodeSupported('garbage'), false);
    assert.equal(isNodeSupported(''), false);
  });

  it('says why an unparsable node version failed (S4-6)', () => {
    const check = nodeCheck('garbage');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /not a parsable version/i);
  });
});

describe('command probing', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('reports the version of a command that answers', () => {
    const result = probeCommand('dsh', { env: sandbox.env });
    assert.equal(result.found, true);
    assert.equal(typeof result.path, 'string');
    assert.match(result.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.ok(result.raw.includes(result.version));
    assert.equal(result.error, null);
    assert.equal(result.signal, null);
  });

  it('reports a program that cannot start as an actionable error (S4-11)', () => {
    const bin = path.join(sandbox.root, 'bad-shebang-bin');
    fs.mkdirSync(bin, { recursive: true });
    const program = path.join(bin, 'broken');
    fs.writeFileSync(program, '#!/nonexistent/interpreter\nprintf hi\n', { mode: 0o755 });

    const result = probeCommand('broken', { env: { PATH: bin } });
    assert.equal(result.found, true);
    assert.ok(result.error, 'the failure is reported');
    assert.match(result.error, /ENOENT|interpreter|execute/i);
    assert.match(result.error, /broken/, 'the message names the program');
  });

  it('reports a permission failure as an actionable error (S4-11)', () => {
    const result = probeCommand('pi', {
      env: sandbox.env,
      spawn: () => ({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }),
    });
    assert.equal(result.found, true);
    assert.match(result.error, /EACCES|permission/i);
    assert.match(result.error, /pi/, 'the message names the program');
    assert.match(result.error, /chmod/, 'the message says what to do');
  });

  it('surfaces a signal death as the signal, not as an empty exit code (S4-11)', () => {
    const bin = path.join(sandbox.root, 'suicide-bin');
    fs.mkdirSync(bin, { recursive: true });
    const program = path.join(bin, 'suicide');
    fs.writeFileSync(program, '#!/bin/sh\nkill -KILL $$\n', { mode: 0o755 });

    const result = probeCommand('suicide', { env: { PATH: bin } });
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(result.error, 'the death is reported');
    assert.match(result.error, /SIGKILL/);
    assert.doesNotMatch(result.error, /exit null/i);
  });
});
