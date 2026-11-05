import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { GRANT_RECORD_KEY, accountGrantStatus, grantState } from '../src/dsh-account.js';
import { ensureAccount } from '../src/onboarding.js';
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

/**
 * The panel the onboarding opens, without a real dsh: it signs the user in by
 * writing the grant, the way the real panel does when the browser signs in.
 */
function writeLauncher(layout, token) {
  fs.mkdirSync(layout.dshHome, { recursive: true });
  fs.writeFileSync(
    layout.launcherPath,
    `#!/bin/sh\ncat > '${layout.credentialsPath}' <<'YAML'\n${grantYaml(token)}YAML\n` +
      "printf 'open http://127.0.0.1:%s/?token=test-token\\n' \"$DSH_PORT\"\n",
    { mode: 0o755 },
  );
}

/** A UI that records what the user would have seen. */
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

/**
 * Sign in through `ensureAccount`, with the panel replaced by a script that
 * writes the grant it would have written.
 */
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
