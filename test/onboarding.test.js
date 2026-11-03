import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { waitForGrant } from '../src/onboarding.js';
import { stopPanelGroup } from '../src/dsh-web.js';
import { cleanupSandbox, createSandbox } from './helpers.js';

describe('waiting for the account grant', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('returns immediately when the signal is already aborted (S4-12)', async () => {
    const controller = new AbortController();
    controller.abort();

    const state = await waitForGrant(path.join(sandbox.root, 'missing.yaml'), {
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    assert.equal(state.state, 'aborted');
  });

  it('stops waiting as soon as the signal aborts (S4-12)', async () => {
    const controller = new AbortController();
    const started = Date.now();

    const pending = waitForGrant(path.join(sandbox.root, 'missing.yaml'), {
      signal: controller.signal,
      timeoutMs: 60_000,
      intervalMs: 50,
    });
    setTimeout(() => controller.abort(), 150);

    const state = await pending;
    const elapsed = Date.now() - started;

    assert.equal(state.state, 'aborted');
    assert.ok(elapsed < 10_000, `the wait ended promptly (took ${elapsed}ms)`);
  });

  it('runs the abort hook exactly once (S4-12)', async () => {
    const controller = new AbortController();
    let aborted = 0;

    const pending = waitForGrant(path.join(sandbox.root, 'missing.yaml'), {
      signal: controller.signal,
      timeoutMs: 60_000,
      intervalMs: 50,
      onAbort: () => {
        aborted += 1;
      },
    });
    setTimeout(() => controller.abort(), 100);

    await pending;
    assert.equal(aborted, 1);
  });

  it('treats SIGINT as an abort (S4-12)', async () => {
    // The signal is delivered to a child process, so the test process is
    // never at risk of being killed by its own SIGINT.
    const script = `
      import { waitForGrant } from ${JSON.stringify(path.resolve('src/onboarding.js'))};
      const state = await waitForGrant('/nonexistent/credentials.yaml', {
        timeoutMs: 60000,
        intervalMs: 100,
      });
      process.stdout.write(JSON.stringify(state));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });

    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    setTimeout(() => child.kill('SIGINT'), 300);

    const code = await new Promise((resolve) => child.once('exit', resolve));

    assert.equal(code, 0, 'the child finished on its own');
    assert.equal(JSON.parse(out).state, 'aborted');
  });
});

describe('stopping the panel process group', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('kills the whole group of a detached child (S4-12)', async () => {
    const marker = path.join(sandbox.root, 'child.pid');
    const child = spawn('/bin/sh', ['-c', `echo $$ > ${marker}; sleep 60`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for the child to write its pid.
    for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(marker), 'the child reported its pid');
    const pid = Number(fs.readFileSync(marker, 'utf8').trim());

    const result = stopPanelGroup(pid);
    assert.equal(result.stopped, true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'the child is gone');
  });

  it('reports honestly when the process is already gone (S4-12)', () => {
    const result = stopPanelGroup(999_999);
    assert.equal(result.stopped, false);
    assert.match(result.reason, /no such process|not found|gone/i);
  });
});
