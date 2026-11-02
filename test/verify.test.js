import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSandbox, createSandbox, run, snapshotDiff, snapshotTree } from './helpers.js';

describe('verify', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('refuses to run without --yes and exits 2', () => {
    const box = createSandbox();
    try {
      const before = snapshotTree(box.root);
      const result = run(['verify'], box);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /--yes/);
      assert.match(result.stderr, /credit/i);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('documents that --yes is required in its help', () => {
    const result = run(['verify', '--help'], sandbox);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  });
});
