import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { GRANT_RECORD_KEY, accountGrantStatus, grantState } from '../src/dsh-account.js';
import { stopPanelGroup } from '../src/dsh-web.js';
import { ensureAccount, waitForGrant } from '../src/onboarding.js';
import { resolveLayout } from '../src/paths.js';
import { CLI, cleanupSandbox, createSandbox } from './helpers.js';

const FIRST_TOKEN = 'account-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_TOKEN = 'account-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ISSUER = 'https://platform.deepseek.com';

/** The credentials file dsh writes when the user signs in. */
function grantYaml(token) {
  return (
    'records:\n' +
    `  ${GRANT_RECORD_KEY}:\n` +
    '    kind: grant\n' +
    '    payload:\n' +
    `      token: ${token}\n` +
    `      issuer: ${ISSUER}\n`
  );
}

function writeCredentials(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, grantYaml(token));
}

/** A port nothing is listening on, so the panel is really started. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function fakeUi() {
  const calls = [];
  const record = (kind) => (...args) => calls.push([kind, ...args]);
  return {
    calls,
    blank: () => {},
    box: (title) => calls.push(['box', title]),
    rule: record('rule'),
    line: record('line'),
    note: record('note'),
    cmd: record('cmd'),
    aside: record('aside'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    step: record('step'),
    ok: record('ok'),
    waitForEnter: async () => {},
  };
}

function writeLauncher(layout, token) {
  fs.mkdirSync(layout.dshHome, { recursive: true });
  fs.writeFileSync(
    layout.launcherPath,
    `#!/bin/sh\ncat > '${layout.credentialsPath}' <<'YAML'\n${grantYaml(token)}YAML\n` +
      "printf 'open http://127.0.0.1:%s/?token=test-token\\n' \"$DSH_PORT\"\n",
    { mode: 0o755 },
  );
}

async function signIn(sandbox, { token, before = null }) {
  const layout = resolveLayout({ env: { DSH_HOME: sandbox.dshHome, PI_HOME: sandbox.piHome, BIN_DIR: sandbox.binDir, STATE_DIR: sandbox.stateDir } });
  if (before !== null) writeCredentials(layout.credentialsPath, before);
  writeLauncher(layout, token);
  const port = await freePort();
  const ui = fakeUi();
  const result = await ensureAccount({
    layout,
    ui,
    env: { PATH: process.env.PATH, DSH_PORT: String(port) },
    cliPath: CLI,
    restart: true,
    interactive: true,
  });
  return { result, ui, layout };
}

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

describe('the state a caller compares accounts with (S8)', () => {
  it('carries the token, so two states can be compared', () => {
    const box = createSandbox();
    try {
      const layout = resolveLayout({ env: { DSH_HOME: box.dshHome } });
      writeCredentials(layout.credentialsPath, FIRST_TOKEN);
      assert.equal(grantState(layout.credentialsPath).token, FIRST_TOKEN);
      assert.equal(accountGrantStatus(layout.credentialsPath).token, FIRST_TOKEN);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('reports "no token" as null, never as undefined', () => {
    const box = createSandbox();
    try {
      const layout = resolveLayout({ env: { DSH_HOME: box.dshHome } });
      const state = grantState(layout.credentialsPath);
      assert.equal(state.state, 'absent');
      assert.equal(state.token, null);
      assert.equal(accountGrantStatus(layout.credentialsPath).token, null);
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('ensureAccount reports an account switch (S8)', () => {
  it('is true when a different account signs in', async () => {
    const box = createSandbox();
    try {
      const { result, ui } = await signIn(box, { token: SECOND_TOKEN, before: FIRST_TOKEN });
      assert.equal(result.ok, true, result.reason ?? '');
      assert.equal(result.accountChanged, true);
      assert.equal(result.state.token, SECOND_TOKEN);
      assert.deepEqual(
        ui.calls.find(([kind, topic]) => kind === 'ok' && topic === 'switched'),
        ['ok', 'switched', 'a different account is now in use'],
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('is false when the same account signs in again', async () => {
    const box = createSandbox();
    try {
      const { result } = await signIn(box, { token: FIRST_TOKEN, before: FIRST_TOKEN });
      assert.equal(result.ok, true, result.reason ?? '');
      assert.equal(result.accountChanged, false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('is false when there was no usable token before', async () => {
    const box = createSandbox();
    try {
      const { result } = await signIn(box, { token: FIRST_TOKEN, before: null });
      assert.equal(result.ok, true, result.reason ?? '');
      assert.equal(result.accountChanged, false);
    } finally {
      cleanupSandbox(box);
    }
  });
});
