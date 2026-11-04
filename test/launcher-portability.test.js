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
 * A `paste` that behaves like the BSD one on macOS: it rejects the bundled
 * short-option form `-sd:` and answers with its usage message. GNU paste
 * accepts that form, so the difference only shows up on macOS — this stub
 * reproduces it everywhere, so the launcher is checked against the stricter
 * of the two dialects instead of against whichever one the test happens to
 * run on.
 */
const BSD_PASTE = `#!/bin/sh
case "$1" in
  -sd:*)
    echo "usage: paste [-s] [-d delimiters] file ..." >&2
    exit 1
    ;;
esac
exec /usr/bin/paste "$@"
`;

describe('launcher portability', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('starts under a paste that rejects the bundled -sd: form', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);

      // A PATH whose first entry is a `paste` that refuses `-sd:`, the way
      // the BSD implementation on macOS does.
      const strictBin = path.join(box.root, 'strict-bin');
      fs.mkdirSync(strictBin, { recursive: true });
      const strictPaste = path.join(strictBin, 'paste');
      fs.writeFileSync(strictPaste, BSD_PASTE, { mode: 0o755 });
      fs.chmodSync(strictPaste, 0o755);

      const result = spawnSync(launcherPath(box), [], {
        encoding: 'utf8',
        env: launcherEnv(box, {
          PATH: [strictBin, box.fakebin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
          FAKE_DSH_VERSION: '0.2.1-rc.5',
          DEEPSEEK_API_KEY: 'sk-fake-key',
        }),
        timeout: 15_000,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /DeepSeek Harness web/);
      assert.doesNotMatch(result.stderr, /usage: paste/);
    } finally {
      cleanupSandbox(box);
    }
  });
});
