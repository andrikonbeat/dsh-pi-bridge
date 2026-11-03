import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tokenProgram } from '../src/token-helper.js';

describe('token program selection', () => {
  let root;
  let cliPath;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dsh-token-helper-test-'));
    cliPath = path.join(root, 'pi-dsh-bridge');
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects only a regular executable token helper (S4-7)', () => {
    const nonExecutable = path.join(root, 'non-executable');
    fs.writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    fs.chmodSync(nonExecutable, 0o644);

    const directory = path.join(root, 'directory');
    fs.mkdirSync(directory);

    const executable = path.join(root, 'executable');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(executable, 0o755);

    assert.equal(tokenProgram({ layout: { tokenHelperPath: nonExecutable }, cliPath }), cliPath);
    assert.equal(tokenProgram({ layout: { tokenHelperPath: directory }, cliPath }), cliPath);
    assert.equal(tokenProgram({ layout: { tokenHelperPath: executable }, cliPath }), executable);
  });

  it('falls back to the CLI when the token helper is missing (S4-7)', () => {
    const missing = path.join(root, 'missing');
    assert.equal(tokenProgram({ layout: { tokenHelperPath: missing }, cliPath }), cliPath);
  });
});
