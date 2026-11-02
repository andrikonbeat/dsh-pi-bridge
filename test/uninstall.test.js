import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  cleanupSandbox,
  createSandbox,
  journalPath,
  launcherPath,
  readJson,
  run,
  settingsPath,
  snapshotDiff,
  snapshotTree,
  wrapperPath,
} from './helpers.js';

const SEEDED_SETTINGS = {
  theme: 'dark',
  enabledModels: ['anthropic/*'],
  deviceId: 'device-abc',
};

const PRIOR_LAUNCHER = '#!/bin/sh\n# the user had their own launcher\nexec dsh web\n';

describe('uninstall', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('restores the exact prior settings.json bytes and removes what it created', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      const priorRaw = fs.readFileSync(settingsPath(box), 'utf8');
      const priorBytes = fs.readFileSync(settingsPath(box));

      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.notEqual(fs.readFileSync(settingsPath(box), 'utf8'), priorRaw);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);

      assert.deepEqual(fs.readFileSync(settingsPath(box)), priorBytes, 'byte-for-byte restore');
      assert.equal(fs.existsSync(wrapperPath(box)), false, 'wrapper removed');
      assert.equal(fs.existsSync(launcherPath(box)), false, 'launcher removed');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('deletes a file that did not exist before install', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const journal = readJson(journalPath(box));
      const wrapperEntry = journal.entries.find((entry) => entry.path === wrapperPath(box));
      assert.equal(wrapperEntry.before, null, 'absent before install');
      assert.equal(fs.existsSync(settingsPath(box)), true);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(wrapperPath(box)), false);
      assert.equal(
        fs.existsSync(settingsPath(box)),
        false,
        'settings.json did not exist before install either',
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('restores a pre-existing launcher to its prior bytes and mode', () => {
    const box = createSandbox();
    try {
      fs.writeFileSync(launcherPath(box), PRIOR_LAUNCHER, { mode: 0o700 });
      fs.chmodSync(launcherPath(box), 0o700);
      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.notEqual(fs.readFileSync(launcherPath(box), 'utf8'), PRIOR_LAUNCHER);
      assert.equal(fs.statSync(launcherPath(box)).mode & 0o777, 0o755);

      assert.equal(run(['uninstall'], box).status, 0);
      assert.equal(fs.readFileSync(launcherPath(box), 'utf8'), PRIOR_LAUNCHER);
      assert.equal(fs.statSync(launcherPath(box)).mode & 0o777, 0o700, 'prior mode restored');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('is idempotent', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.equal(run(['uninstall'], box).status, 0);
      const once = snapshotTree(box.root);
      const again = run(['uninstall'], box);
      assert.equal(again.status, 0, again.stderr);
      assert.deepEqual(snapshotDiff(once, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('--dry-run restores nothing', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const before = snapshotTree(box.root);
      const result = run(['uninstall', '--dry-run'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /settings\.json/);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('tolerates a missing journal with a clear message', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      const before = snapshotTree(box.root);
      const result = run(['uninstall'], box);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /journal/i);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('tolerates an edited, unparsable journal with a clear message', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      fs.writeFileSync(journalPath(box), '{"version": 1, "entries": [ oops\n');
      const before = snapshotTree(box.root);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /journal/i);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('never restores a file it did not record', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const userFile = `${box.piHome}/notes.md`;
      fs.writeFileSync(userFile, 'user content\n');

      assert.equal(run(['uninstall'], box).status, 0);
      assert.equal(fs.readFileSync(userFile, 'utf8'), 'user content\n');
      assert.ok(fs.existsSync(journalPath(box)), 'journal kept for audit');
    } finally {
      cleanupSandbox(box);
    }
  });
});
