import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSandbox, createSandbox, launcherPath, run, sandboxEnv } from './helpers.js';

/**
 * The launcher is a bash script, so the sandbox PATH needs the system
 * directories next to the fake `dsh`; otherwise the shebang cannot be
 * resolved and the test would measure the wrong thing.
 */
function launcherEnv(box, extra) {
  return sandboxEnv(box, {
    PATH: [box.fakebin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    ...extra,
  });
}

/**
 * The launcher is the first thing a user runs when the web panel misbehaves,
 * so it is the place where a dsh that cannot mount a single agent preset has
 * to be refused: the panel would start and then refuse every new session.
 */
describe('launcher', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('refuses to start a dsh build that cannot mount agent presets', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);

      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, { FAKE_DSH_VERSION: '0.2.2-alpha.2' }),
        timeout: 15_000,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /agent-preset\/invalid/);
      assert.match(result.stderr, /0\.2\.2-alpha\.3/);
      assert.doesNotMatch(result.stdout, /dsh web:/, 'the broken dsh was never started');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('starts dsh when the build is not known to be broken', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);

      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, { FAKE_DSH_VERSION: '0.2.1-rc.5', DEEPSEEK_API_KEY: 'sk-fake-key' }),
        timeout: 15_000,
      });

      // The fake dsh answers every invocation and exits, so the launcher
      // reaches its final `exec dsh` and the panel is started.
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /DeepSeek Harness web/);
      assert.doesNotMatch(result.stderr, /agent-preset\/invalid/);
    } finally {
      cleanupSandbox(box);
    }
  });
});
