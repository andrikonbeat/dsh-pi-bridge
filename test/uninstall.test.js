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

  it('keeps a file it created when the user changed it after install', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const edited = '#!/bin/sh\n# the user rewrote this wrapper after install\nexec dsh web\n';
      fs.writeFileSync(wrapperPath(box), edited);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /keep/);
      assert.match(result.stdout, /changed since install; left in place/);
      assert.equal(
        fs.readFileSync(wrapperPath(box), 'utf8'),
        edited,
        'uninstall never deletes a file it cannot prove it wrote',
      );
      assert.equal(readJson(settingsPath(box)).theme, 'dark', 'the rest of the plan still ran');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('keeps a file it created when the journal records no digest', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const journal = readJson(journalPath(box));
      for (const entry of journal.entries) delete entry.sha256;
      fs.writeFileSync(journalPath(box), `${JSON.stringify(journal, null, 2)}\n`);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no record of what install wrote; left in place/);
      assert.ok(fs.existsSync(wrapperPath(box)), 'an older journal never authorizes a delete');
      assert.ok(fs.existsSync(launcherPath(box)));
    } finally {
      cleanupSandbox(box);
    }
  });

  it('--dry-run reports a changed file as keep and deletes nothing', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      fs.writeFileSync(wrapperPath(box), '#!/bin/sh\n# edited\n');
      const before = snapshotTree(box.root);

      const result = run(['uninstall', '--dry-run'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /keep/);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('restores only the settings keys it captured and keeps the keys the user added', () => {
    const box = createSandbox({ settings: { theme: 'dark', defaultModel: 'anthropic-opus' } });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);

      const journal = readJson(journalPath(box));
      assert.deepEqual(journal.settings.keys.slice().sort(), [
        'defaultModel',
        'defaultProvider',
        'enabledModels',
      ]);
      assert.deepEqual(journal.settings.before, { defaultModel: 'anthropic-opus' });

      // The user keeps editing settings.json after install: an unrelated key
      // changes, and a new one appears.
      const edited = readJson(settingsPath(box));
      edited.theme = 'light';
      edited.lastUsedModel = 'something-new';
      fs.writeFileSync(settingsPath(box), `${JSON.stringify(edited, null, 2)}\n`);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);

      const restored = readJson(settingsPath(box));
      assert.deepEqual(restored, {
        theme: 'light',
        defaultModel: 'anthropic-opus',
        lastUsedModel: 'something-new',
      });
      assert.equal('defaultProvider' in restored, false, 'a key install brought in is removed');
      assert.equal('enabledModels' in restored, false, 'a key install brought in is removed');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('keeps the settings.json it created when the user added a key to it', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const created = readJson(settingsPath(box));
      assert.equal(created.defaultProvider, 'deepseek');

      created.lastUsedModel = 'something-new';
      fs.writeFileSync(settingsPath(box), `${JSON.stringify(created, null, 2)}\n`);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 0, result.stderr);

      assert.ok(fs.existsSync(settingsPath(box)), 'the user key keeps the file alive');
      assert.deepEqual(readJson(settingsPath(box)), { lastUsedModel: 'something-new' });
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
