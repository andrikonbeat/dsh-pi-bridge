import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, cleanupSandbox, createSandbox } from './helpers.js';

const WRAPPER = path.join(REPO_ROOT, 'assets', 'pi-deepseek.sh');

/**
 * Run the wrapper with a controlled environment.
 *
 * `pi` is stubbed so the wrapper reaches `exec pi` and exits 0; the point of
 * these cases is what happens *before* that, when HOME is missing.
 */
function runWrapper({ env = {}, args = ['--print', 'hello'] } = {}) {
  const sandbox = createSandbox();
  try {
    return spawnSync('/bin/bash', [WRAPPER, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: `${sandbox.fakebin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        ...env,
      },
    });
  } finally {
    cleanupSandbox(sandbox);
  }
}

describe('the pi-deepseek wrapper', () => {
  it('starts with HOME set (S4-10)', () => {
    const result = runWrapper({ env: { HOME: '/home/tester' } });
    assert.equal(result.status, 0, result.stderr);
  });

  it('does not fail with an unbound-variable error when HOME is missing (S4-10)', () => {
    const result = runWrapper({ env: {} });
    assert.notEqual(result.status, 0, 'the wrapper must not start without a home directory');
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /variable sin asignar|unbound variable/i,
      'the shell must not report an unbound variable',
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /HOME/,
      'the message names the variable that is missing',
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /DSH_HOME/,
      'the message names the variable that would fix it',
    );
  });

  it('starts without HOME when DSH_HOME is set (S4-10)', () => {
    const result = runWrapper({ env: { DSH_HOME: '/tmp/dsh-home' } });
    assert.equal(result.status, 0, result.stderr);
  });
});
