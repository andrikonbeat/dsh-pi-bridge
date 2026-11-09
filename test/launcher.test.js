import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
 * A dsh that writes down every patch it was given, so a test can see which
 * route the panel was told to mount.
 */
function writePatchReportingDsh(box, dump) {
  const file = path.join(box.fakebin, 'dsh');
  fs.writeFileSync(
    file,
    `#!/bin/sh
version="\${FAKE_DSH_VERSION:-0.2.1-rc.5}"
prev=""
for arg in "$@"; do
  case "$arg" in
    --version|-V)
      printf '%s\\n' "$version"
      exit 0
      ;;
  esac
  if [ "$prev" = "--patch" ] && [ -f "$arg" ]; then
    printf 'PATCH %s\\n' "$arg" >> "$DUMP_FILE"
    cat "$arg" >> "$DUMP_FILE"
  fi
  prev="$arg"
done
printf 'dsh web: http://127.0.0.1:3080/?token=abc123\\n'
`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
  return dump;
}

/**
 * The credentials file dsh writes when the user signs in. Only the record
 * the bridge reads matters here; the shape is what the real file has.
 */
const GRANT_CREDENTIALS = `records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: account-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      issuer: https://platform.deepseek.com
`;

/**
 * A `curl` that records how it was called and answers with a fixed status.
 *
 * The launcher probes the account dashboard with curl. What curl is allowed
 * to do and what a browser is allowed to do are different questions: the
 * dashboard sits behind a WAF that challenges one and not the other, so a
 * probe that does not look like a browser measures the wrong thing.
 */
function writeCurlStub(box, { status, log }) {
  const file = path.join(box.fakebin, 'curl');
  fs.writeFileSync(
    file,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
printf '%s' '${status}'
`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * A `curl` that behaves the way the dashboard's WAF does: a plain command
 * line client is turned away, a browser is let through.
 */
function writeWafCurlStub(box, log) {
  const file = path.join(box.fakebin, 'curl');
  fs.writeFileSync(
    file,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *Mozilla*) printf '200' ;;
  *) printf '403' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.chmodSync(file, 0o755);
  return file;
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

  it('mounts the route it announced, not the one the overlay pins', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);

      const dump = path.join(box.root, 'patches.txt');
      writePatchReportingDsh(box, dump);
      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, {
          FAKE_DSH_VERSION: '0.2.1-rc.5',
          DEEPSEEK_API_KEY: 'sk-fake-key',
          DUMP_FILE: dump,
        }),
        timeout: 15_000,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /route: API key \(deepseek-official/);
      const patches = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
      assert.match(
        patches,
        /provider: deepseek-official/,
        'the panel was told to mount the account route while the launcher announced the API-key route',
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('mounts the account route when the account grant is usable', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(path.join(box.dshHome, '.credentials.yaml'), GRANT_CREDENTIALS);

      // The launcher probes the account dashboard to say whether it is
      // reachable; the answer does not change the route, so it is a constant.
      const curl = path.join(box.fakebin, 'curl');
      fs.writeFileSync(curl, "#!/bin/sh\nprintf '000'\n", { mode: 0o755 });
      fs.chmodSync(curl, 0o755);

      const dump = path.join(box.root, 'patches.txt');
      writePatchReportingDsh(box, dump);
      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, {
          FAKE_DSH_VERSION: '0.2.1-rc.5',
          DUMP_FILE: dump,
        }),
        timeout: 25_000,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /route: dsh account \(deepseek-account/);
      const patches = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
      assert.match(patches, /provider: deepseek-account/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('probes the account dashboard the way a browser does', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(
        path.join(box.dshHome, '.credentials.yaml'),
        'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: account-token\n      issuer: https://platform.deepseek.com\n',
      );

      const log = path.join(box.root, 'curl.log');
      writeCurlStub(box, { status: '200', log });
      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, { FAKE_DSH_VERSION: '0.2.1-rc.5', DUMP_FILE: path.join(box.root, 'patches.txt') }),
        timeout: 25_000,
      });

      assert.equal(result.status, 0, result.stderr);
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      assert.match(calls, /-A Mozilla/, 'the probe did not look like a browser');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('does not call the account dashboard blocked when only curl is turned away', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(
        path.join(box.dshHome, '.credentials.yaml'),
        'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: account-token\n      issuer: https://platform.deepseek.com\n',
      );

      // The dashboard's WAF turns away a plain command line client and lets
      // a browser through. Reporting the dashboard as blocked because curl
      // was blocked tells the user their browser cannot sign in either.
      const log = path.join(box.root, 'curl.log');
      writeWafCurlStub(box, log);
      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, { FAKE_DSH_VERSION: '0.2.1-rc.5', DUMP_FILE: path.join(box.root, 'patches.txt') }),
        timeout: 25_000,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /blocked from this machine/);
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
