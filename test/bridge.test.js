import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { resolveDshPort, startDshWeb, stopDshWeb } from '../src/dsh-web.js';
import { applySharedProvider, sharedProvider } from '../src/models.js';
import {
  cleanupSandbox,
  createSandbox,
  journalPath,
  readJson,
  run,
  sandboxEnv,
} from './helpers.js';

const TOKEN = 'account-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUER = 'https://platform.deepseek.com';

/**
 * The credentials file dsh writes when the user signs in. Only the record
 * the bridge reads matters here; the shape is what the real file has.
 */
function credentialsYaml({ token = TOKEN, kind = 'grant', issuer = ISSUER } = {}) {
  return `records:
  deepseek-account-platform/default:
    kind: ${kind}
    payload:
      token: ${token}
      issuer: ${issuer}
`;
}

function writeCredentials(sandbox, contents = credentialsYaml()) {
  fs.mkdirSync(sandbox.dshHome, { recursive: true });
  const file = path.join(sandbox.dshHome, '.credentials.yaml');
  fs.writeFileSync(file, contents);
  return file;
}

function modelsPath(sandbox) {
  return path.join(sandbox.piHome, 'models.json');
}

function helperPath(sandbox) {
  return path.join(sandbox.binDir, 'pi-dsh-token');
}

function providerOf(sandbox) {
  return readJson(modelsPath(sandbox)).providers.deepseek;
}

/**
 * A loopback port this test itself opened and closed again, so the panel
 * probe below never talks to — or binds — a port owned by the host.
 */
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

/** A stand-in launcher inside the sandbox, so nothing of the host is run. */
function writeLauncher(box, body) {
  const file = path.join(box.root, 'fake-web.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

describe('the shared-account bridge', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('sync wires the deepseek provider to the account header, and stores no token', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      const result = run(['sync'], box);
      assert.equal(result.status, 0, result.stderr);

      const provider = providerOf(box);
      const header = provider.headers['x-dsh-auth-token'];
      assert.ok(header.startsWith('!'), 'the account header is a command');
      assert.ok(path.isAbsolute(helperPath(box)), 'the command points at an absolute path');
      assert.match(header, /'token' '--dsh-home'/);
      assert.equal(provider.baseUrl, 'https://api.deepseek.com');
      assert.equal(provider.api, 'openai-completions');

      const written = fs.readFileSync(modelsPath(box), 'utf8');
      assert.ok(!written.includes(TOKEN), 'the token is never written to models.json');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync is idempotent: a second run changes no byte and journals nothing new', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      assert.equal(run(['sync'], box).status, 0);
      const first = fs.readFileSync(modelsPath(box), 'utf8');
      const journal = readJson(journalPath(box));
      const entries = journal.entries.length;

      const second = run(['sync'], box);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /unchanged/);
      assert.equal(fs.readFileSync(modelsPath(box), 'utf8'), first);
      assert.equal(readJson(journalPath(box)).entries.length, entries);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync --dry-run writes nothing', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      const result = run(['sync', '--dry-run'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(modelsPath(box)), false);
      assert.equal(fs.existsSync(journalPath(box)), false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync refuses without a usable grant and leaves Pi untouched', () => {
    const box = createSandbox();
    try {
      const result = run(['sync'], box);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /credentials file|grant/i);
      assert.equal(fs.existsSync(modelsPath(box)), false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync reports a grant of the wrong kind as unusable', () => {
    const box = createSandbox();
    try {
      writeCredentials(box, credentialsYaml({ kind: 'secret' }));
      const result = run(['sync'], box);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /expected "grant"/);
      assert.equal(fs.existsSync(modelsPath(box)), false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('the command Pi runs produces the token, exactly as Pi invokes it', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      assert.equal(run(['install', '--yes'], box).status, 0);

      // Pi strips the leading `!` and runs the rest through the shell, then
      // takes its stdout. Running the very same command is the only way to
      // catch one that reads well but composes wrong.
      const header = providerOf(box).headers['x-dsh-auth-token'];
      const result = spawnSync('/bin/sh', ['-c', header.slice(1)], {
        encoding: 'utf8',
        // Pi runs the command with the user's PATH, where node lives; the
        // CLI is a node script reached through its shebang.
        env: sandboxEnv(box, {
          PATH: `${box.fakebin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        }),
      });
      assert.equal(result.status, 0, `the header command failed: ${result.stderr}`);
      assert.equal(result.stdout.trim(), TOKEN);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('token prints the token and nothing else', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      const result = run(['token'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${TOKEN}\n`);
      assert.equal(result.stderr, '');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('token --check never prints the token, and reports usability by exit code', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      const usable = run(['token', '--check'], box);
      assert.equal(usable.status, 0, usable.stderr);
      assert.ok(!usable.stdout.includes(TOKEN), 'no token on stdout');
      assert.ok(!usable.stderr.includes(TOKEN), 'no token on stderr');

      fs.rmSync(path.join(box.dshHome, '.credentials.yaml'));
      const missing = run(['token', '--check'], box);
      assert.equal(missing.status, 1);
      assert.ok(!missing.stdout.includes(TOKEN));
      assert.equal(missing.stdout, '');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('token fails with a message on stderr and no token on stdout when absent', () => {
    const box = createSandbox();
    try {
      const result = run(['token'], box);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /no dsh credentials file/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('install wires the provider and the helper, and uninstall restores models.json byte for byte', () => {
    const box = createSandbox();
    try {
      const original = `${JSON.stringify({ providers: { mine: { baseUrl: 'https://example.test' } } }, null, 2)}\n`;
      fs.writeFileSync(modelsPath(box), original);
      writeCredentials(box);

      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.equal(providerOf(box).headers['x-dsh-auth-token'].startsWith('!'), true);
      assert.ok(fs.existsSync(helperPath(box)), 'the helper is installed');
      assert.equal(fs.statSync(helperPath(box)).mode & 0o777, 0o755);
      assert.ok(!fs.readFileSync(helperPath(box), 'utf8').includes(TOKEN), 'no token in the helper');

      assert.equal(run(['uninstall', '--yes'], box).status, 0);
      assert.equal(fs.readFileSync(modelsPath(box), 'utf8'), original, 'models.json restored exactly');
      assert.equal(fs.existsSync(helperPath(box)), false, 'the helper is removed again');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('install wires the provider even before sign-in, so signing in is enough', () => {
    const box = createSandbox();
    try {
      const original = `${JSON.stringify({ providers: {} }, null, 2)}\n`;
      fs.writeFileSync(modelsPath(box), original);

      // No DeepSeek credentials on purpose: the provider is a command, not a
      // token, so it is valid before the user signs in. Skipping it would make
      // Pi fall back silently to its built-in provider — a different wallet.
      assert.equal(run(['install', '--yes'], box).status, 0);
      const provider = providerOf(box);
      assert.ok(provider, 'the deepseek provider is written without a grant');
      assert.ok(provider.headers['x-dsh-auth-token'].startsWith('!'));
      assert.notEqual(fs.readFileSync(modelsPath(box), 'utf8'), original);

      // And the moment the account appears, the wiring already works.
      writeCredentials(box);
      const result = spawnSync('/bin/sh', ['-c', provider.headers['x-dsh-auth-token'].slice(1)], {
        encoding: 'utf8',
        env: sandboxEnv(box, {
          PATH: `${box.fakebin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), TOKEN);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('doctor separates absent, unusable and usable, and says when a key is merely present', () => {
    const box = createSandbox();
    try {
      const absent = JSON.parse(run(['doctor', '--json'], box).stdout);
      const account = absent.checks.find((check) => check.id === 'dsh-account');
      assert.equal(account.status, 'warn');
      assert.match(account.detail, /absent/);

      writeCredentials(box, credentialsYaml({ kind: 'secret' }));
      const unusable = JSON.parse(run(['doctor', '--json'], box).stdout);
      const broken = unusable.checks.find((check) => check.id === 'dsh-account');
      assert.equal(broken.status, 'fail');
      assert.match(broken.detail, /expected "grant"/);

      writeCredentials(box);
      const usable = JSON.parse(run(['doctor', '--json'], box).stdout);
      const good = usable.checks.find((check) => check.id === 'dsh-account');
      assert.equal(good.status, 'ok');
      assert.match(good.detail, /usable/);

      fs.writeFileSync(
        path.join(box.piHome, 'auth.json'),
        `${JSON.stringify({ deepseek: { key: 'sk-present-but-unverified' } }, null, 2)}\n`,
      );
      const withKey = JSON.parse(run(['doctor', '--json'], box).stdout);
      const credential = withKey.checks.find((check) => check.id === 'credential');
      assert.equal(credential.status, 'warn');
      assert.match(credential.detail, /balance not checked offline/);
      assert.ok(!JSON.stringify(withKey).includes('sk-present-but-unverified'));
    } finally {
      cleanupSandbox(box);
    }
  });

  it('doctor notices a bridge that points at a program that is not there', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.match(providerOf(box).headers['x-dsh-auth-token'], new RegExp(helperPath(box).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      fs.rmSync(helperPath(box));
      const doc = JSON.parse(run(['doctor', '--json'], box).stdout);
      const bridge = doc.checks.find((check) => check.id === 'bridge');
      assert.equal(bridge.status, 'fail');
      assert.match(bridge.detail, /missing or not executable/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync without an installed helper points at this CLI, which still works', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      assert.equal(run(['sync'], box).status, 0);
      const header = providerOf(box).headers['x-dsh-auth-token'];
      assert.ok(!header.includes(helperPath(box)), 'the helper is not installed, so it is not referenced');
      assert.match(header, /cli\.js/);

      const doc = JSON.parse(run(['doctor', '--json'], box).stdout);
      const bridge = doc.checks.find((check) => check.id === 'bridge');
      assert.equal(bridge.status, 'ok');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync accepts a models.json with a UTF-8 BOM (S4-4)', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      fs.writeFileSync(
        modelsPath(box),
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(`${JSON.stringify({ providers: {} }, null, 2)}\n`),
        ]),
      );

      const result = run(['sync'], box);
      assert.equal(result.status, 0, result.stderr);

      // The BOM is gone and the file is plain JSON again.
      const raw = fs.readFileSync(modelsPath(box));
      assert.notDeepEqual(Array.from(raw.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
      assert.ok(providerOf(box), 'the provider was wired');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('sync refuses a models.json whose providers is an array, and changes nothing (S4-5)', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      const original = '{\n  "providers": []\n}\n';
      fs.writeFileSync(modelsPath(box), original);

      const result = run(['sync'], box);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /providers` must be an object, not an array/);
      assert.equal(
        fs.readFileSync(modelsPath(box), 'utf8'),
        original,
        'the corrupt file is left exactly as it was',
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('install refuses a models.json whose providers is a string, and changes nothing (S4-5)', () => {
    const box = createSandbox();
    try {
      const original = '{\n  "providers": "nope"\n}\n';
      fs.writeFileSync(modelsPath(box), original);

      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /providers` must be an object, not string/);
      assert.equal(fs.readFileSync(modelsPath(box), 'utf8'), original);
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('the dsh web panel', () => {
  it('never signals a pid it cannot identify as the panel', () => {
    const killed = [];
    const result = stopDshWeb(3080, {
      pid: 4242,
      readCmdline: () => '/usr/bin/node /usr/lib/other-server.js --port 3080',
      kill: (...args) => killed.push(args),
    });

    assert.deepEqual(killed, [], 'an unidentified pid is never signalled');
    assert.equal(result.stopped, false);
    assert.equal(
      result.reason,
      'pid 4242 on port 3080 is not the dsh web panel (/usr/bin/node /usr/lib/other-server.js --port 3080); not touching it',
    );
  });

  it('reads the real /proc cmdline of a pid it did not spawn itself', async () => {
    // A process this test owns, so nothing on the host is touched.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const killed = [];
      const result = stopDshWeb(3080, { pid: child.pid, kill: (...args) => killed.push(args) });
      assert.deepEqual(killed, [], 'a node process is not the panel');
      assert.equal(result.stopped, false);
      assert.match(result.reason, new RegExp(`^pid ${child.pid} on port 3080 is not the dsh web panel \\(.+\\); not touching it$`));
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('signals the pid when the cmdline is the installed launcher or mentions dsh web', () => {
    const viaLauncher = [];
    const launcher = '/opt/panel/start.sh';
    const launched = stopDshWeb(3080, {
      pid: 4243,
      launcherPath: launcher,
      readCmdline: () => `/bin/sh ${launcher}`,
      kill: (...args) => viaLauncher.push(args),
    });
    assert.deepEqual(viaLauncher, [[4243, 'SIGTERM']]);
    assert.deepEqual(launched, { stopped: true, pid: 4243 });

    const viaCmdline = [];
    const mentioned = stopDshWeb(3080, {
      pid: 4244,
      readCmdline: () => '/usr/local/bin/dsh web --port 3080',
      kill: (...args) => viaCmdline.push(args),
    });
    assert.deepEqual(viaCmdline, [[4244, 'SIGTERM']]);
    assert.equal(mentioned.stopped, true);
  });

  it('refuses to guess when the cmdline cannot be read at all', () => {
    const killed = [];
    const unreadable = stopDshWeb(3080, {
      pid: 4245,
      readCmdline: () => null,
      kill: (...args) => killed.push(args),
    });
    assert.deepEqual(killed, []);
    assert.equal(unreadable.stopped, false);
    assert.match(unreadable.reason, /cmdline unreadable/);

    const unknown = stopDshWeb(3080, { pid: null, readCmdline: () => 'ignored', kill: () => {} });
    assert.equal(unknown.stopped, false);
    assert.equal(unknown.reason, 'cannot identify the process listening on port 3080');
  });

  it('counts the panel as running when the port answers HTTP, even with 401', async () => {
    const port = await freePort();
    const server = http.createServer((request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('sign in');
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const started = await startDshWeb({
        launcherPath: path.join('/nonexistent', 'start-web.sh'),
        env: {},
        port,
        timeoutMs: 2_000,
      });
      assert.equal(started.alreadyRunning, true);
      assert.equal(started.url, null);
      assert.equal(started.error, null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('never reports a foreign listener as an already-serving panel', async () => {
    const port = await freePort();
    const sockets = [];
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      sockets.push(socket);
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const started = await startDshWeb({
        launcherPath: path.join('/nonexistent', 'start-web.sh'),
        env: {},
        port,
        timeoutMs: 2_000,
      });
      assert.equal(started.alreadyRunning, false);
      assert.match(started.error, /not the dsh web panel/);
      assert.ok(started.error.includes(String(port)), 'the message names the port');
      assert.doesNotMatch(started.error, /already serving/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('kills the process group instead of leaving an orphan when no URL appears', async () => {
    const box = createSandbox();
    try {
      const port = await freePort();
      const launcherPath = writeLauncher(box, "printf 'panel started without a url\\n'");
      const killed = [];
      const started = await startDshWeb({
        launcherPath,
        env: { PATH: '/usr/bin:/bin' },
        port,
        timeoutMs: 10_000,
        killGroup: (...args) => killed.push(args),
      });

      assert.equal(started.url, null);
      assert.ok(started.pid > 0, 'the child was spawned');
      assert.deepEqual(killed, [[-started.pid, 'SIGTERM']], 'the whole group is terminated');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('settles as soon as the launcher exits, even when it exits 0', async () => {
    const box = createSandbox();
    try {
      const port = await freePort();
      const launcherPath = writeLauncher(box, "printf 'the launcher gave up\\n'");
      const began = Date.now();
      const started = await startDshWeb({
        launcherPath,
        env: { PATH: '/usr/bin:/bin' },
        port,
        timeoutMs: 20_000,
        killGroup: () => {},
      });
      const elapsed = Date.now() - began;

      assert.equal(started.url, null);
      assert.ok(elapsed < 5_000, `settled in ${elapsed}ms instead of waiting for the timeout`);
      assert.match(started.error, /the launcher gave up/, 'the captured output is reported');
      assert.doesNotMatch(started.error, /within 20s/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('finds a sign-in URL split across two output chunks', async () => {
    const box = createSandbox();
    try {
      const port = await freePort();
      const launcherPath = writeLauncher(
        box,
        "printf 'http://127.0.0.1:3080/?tok'\nsleep 0.2\nprintf 'en=abc123\\n'",
      );
      const started = await startDshWeb({
        launcherPath,
        env: { PATH: '/usr/bin:/bin' },
        port,
        timeoutMs: 10_000,
        killGroup: () => {},
      });

      assert.equal(started.url, 'http://127.0.0.1:3080/?token=abc123');
      assert.equal(started.error, null);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('rejects a DSH_PORT that is not an integer between 1 and 65535, without rejecting', async () => {
    const box = createSandbox();
    try {
      const marker = path.join(box.root, 'launched');
      const launcherPath = writeLauncher(box, `printf launched > '${marker}'`);
      for (const bad of ['0', 'abc', '65536', '', '-1', '3080.5']) {
        const started = await startDshWeb({ launcherPath, env: { DSH_PORT: bad }, timeoutMs: 1_000 });
        assert.equal(started.url, null);
        assert.equal(started.alreadyRunning, false);
        assert.equal(started.error, `DSH_PORT must be an integer between 1 and 65535, got "${bad}"`);
      }
      assert.equal(fs.existsSync(marker), false, 'nothing was spawned for an invalid port');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('accepts exactly the port boundaries and rejects everything else', () => {
    assert.deepEqual(resolveDshPort('1'), { port: 1, error: null });
    assert.deepEqual(resolveDshPort('65535'), { port: 65535, error: null });
    assert.deepEqual(resolveDshPort(undefined, {}), { port: 3080, error: null });
    assert.deepEqual(resolveDshPort(3080), { port: 3080, error: null });
    for (const bad of ['0', '65536', '-1', '1.5', 'abc', '', ' 3080']) {
      assert.equal(resolveDshPort(bad).error, `DSH_PORT must be an integer between 1 and 65535, got "${bad}"`);
    }
  });

  it('uses a valid DSH_PORT as given', async () => {
    const box = createSandbox();
    try {
      const port = await freePort();
      const seen = path.join(box.root, 'port.txt');
      const launcherPath = writeLauncher(
        box,
        `printf '%s' "$DSH_PORT" > '${seen}'\nprintf 'http://127.0.0.1:${port}/?token=deadbeef\\n'`,
      );
      const started = await startDshWeb({
        launcherPath,
        env: { DSH_PORT: String(port), PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000,
        killGroup: () => {},
      });

      assert.equal(started.port, port);
      assert.equal(started.url, `http://127.0.0.1:${port}/?token=deadbeef`);
      assert.equal(fs.readFileSync(seen, 'utf8'), String(port));
    } finally {
      cleanupSandbox(box);
    }
  });

  it('keeps the sign-in URL when the launcher exits before its output is drained', async () => {
    const box = createSandbox();
    try {
      const port = await freePort();
      // The launcher leaves a child that prints the URL after the launcher
      // itself is already gone. The process exits first and the output
      // arrives later, so a wait that settles on the exit alone loses it.
      const launcherPath = writeLauncher(
        box,
        `( sleep 0.1; printf 'http://127.0.0.1:${port}/?token=deadbeef\\n' ) &\nexit 0`,
      );
      const started = await startDshWeb({
        launcherPath,
        env: { DSH_PORT: String(port), PATH: '/usr/bin:/bin' },
        timeoutMs: 10_000,
        killGroup: () => {},
      });

      assert.equal(started.url, `http://127.0.0.1:${port}/?token=deadbeef`);
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('the shared provider plan', () => {
  const provider = sharedProvider({ program: '/home/user/.local/bin/pi-dsh-token', dshHome: '/home/user/.dsh' });

  it('warns instead of replacing a hand-written deepseek provider in silence', () => {
    const current = {
      providers: {
        deepseek: {
          name: 'DeepSeek (mine)',
          baseUrl: 'https://api.deepseek.com',
          api: 'openai-completions',
          apiKey: 'sk-user-owned-key',
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        },
      },
    };

    const plan = applySharedProvider(current, provider);

    assert.equal(plan.existed, true);
    assert.equal(
      plan.warning,
      'the existing "deepseek" provider is not the one this bridge writes; its `models` and `name` are preserved',
    );
    const merged = plan.merged.providers.deepseek;
    assert.deepEqual(merged.models, [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]);
    assert.equal(merged.name, 'DeepSeek (mine)');
    assert.equal(merged.headers['x-dsh-auth-token'], provider.headers['x-dsh-auth-token']);
    assert.ok(!JSON.stringify(plan.merged).includes('sk-user-owned-key'), 'the old api key is not kept');
  });

  it('says nothing when the entry is already the one this bridge writes', () => {
    const plan = applySharedProvider({ providers: { deepseek: { ...provider } } }, provider);
    assert.equal(plan.warning, null);
    assert.deepEqual(plan.merged.providers.deepseek, provider);
  });

  it('says nothing when there is no deepseek provider yet', () => {
    const plan = applySharedProvider({ providers: { mine: { baseUrl: 'https://example.test' } } }, provider);
    assert.equal(plan.existed, false);
    assert.equal(plan.warning, null);
    assert.deepEqual(plan.merged.providers.deepseek, provider);
  });
});
