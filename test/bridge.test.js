import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
      assert.match(header, /token --dsh-home/);
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
});
