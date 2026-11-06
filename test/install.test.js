import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  cleanupSandbox,
  createSandbox,
  journalPath,
  launcherPath,
  listFiles,
  overlayPath,
  readJson,
  run,
  settingsPath,
  snapshotDiff,
  snapshotTree,
  snapshotsEqual,
  wrapperPath,
} from './helpers.js';

const SEEDED_SETTINGS = {
  theme: 'dark',
  deviceId: 'device-abc',
  packages: ['npm:gentle-pi'],
  extensions: { 'gentle:retry': true },
  enabledModels: ['anthropic/*'],
  somethingUnknown: { nested: [1, 2, 3] },
};

describe('install', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('--dry-run writes nothing at all, not even the state directory', () => {
    const dry = createSandbox({ precreate: false, settings: SEEDED_SETTINGS });
    try {
      const result = run(['install', '--dry-run'], dry);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /start-web\.sh/);
      assert.match(result.stdout, /pi-deepseek/);
      assert.match(result.stdout, /settings\.json/);

      assert.equal(fs.existsSync(dry.stateDir), false, 'state dir must not be created');
      assert.equal(fs.existsSync(journalPath(dry)), false, 'journal must not be written');
      assert.equal(fs.existsSync(wrapperPath(dry)), false, 'wrapper must not be written');
      assert.equal(fs.existsSync(launcherPath(dry)), false, 'launcher must not be written');

      const files = listFiles(dry.root).filter(
        (file) => !file.startsWith('fakebin/') && !file.startsWith('dsh-only-bin/'),
      );
      assert.deepEqual(files, ['pi-home/settings.json']);
    } finally {
      cleanupSandbox(dry);
    }
  });

  it('creates the launcher, the wrapper and the settings defaults', () => {
    const box = createSandbox();
    try {
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);

      assert.ok(fs.existsSync(launcherPath(box)), 'launcher written into DSH_HOME');
      assert.ok(fs.existsSync(wrapperPath(box)), 'wrapper written into BIN_DIR');
      assert.ok(fs.statSync(wrapperPath(box)).mode & 0o111, 'wrapper is executable');
      assert.notEqual(fs.lstatSync(wrapperPath(box)).isSymbolicLink(), true, 'wrapper is a real file');

      const settings = readJson(settingsPath(box));
      assert.equal(settings.defaultProvider, 'deepseek');
      assert.equal(settings.defaultModel, 'deepseek-flash');
      assert.deepEqual(settings.enabledModels, ['deepseek/*']);

      const journal = readJson(journalPath(box));
      assert.equal(journal.version, 1);
      assert.match(journal.installedAt, /^\d{4}-\d{2}-\d{2}T/);
      const paths = journal.entries.map((entry) => entry.path);
      assert.ok(paths.includes(settingsPath(box)));
      assert.ok(paths.includes(launcherPath(box)));
      assert.ok(paths.includes(wrapperPath(box)));
      for (const entry of journal.entries) {
        assert.ok(['settings-keys', 'file-copy', 'absent'].includes(entry.after));
        if (entry.before !== null) assert.ok(fs.existsSync(entry.before), entry.before);
      }
    } finally {
      cleanupSandbox(box);
    }
  });

  it('records a sha256 of the exact bytes it wrote for every journal entry', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const journal = readJson(journalPath(box));
      assert.ok(journal.entries.length > 0);
      for (const entry of journal.entries) {
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.path} has a digest`);
        const digest = createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex');
        assert.equal(entry.sha256, digest, `${entry.path} digest matches the bytes on disk`);
      }
    } finally {
      cleanupSandbox(box);
    }
  });

  it('is idempotent: a second install changes not a single byte', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const treeAfterFirst = snapshotTree(box.root);
      const settingsAfterFirst = fs.readFileSync(settingsPath(box));
      const journalAfterFirst = fs.readFileSync(journalPath(box));

      const second = run(['install', '--yes'], box);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /unchanged/);

      const diff = snapshotDiff(treeAfterFirst, snapshotTree(box.root));
      assert.deepEqual(diff, { added: [], removed: [], changed: [] }, 'tree must be byte-identical');
      assert.deepEqual(fs.readFileSync(settingsPath(box)), settingsAfterFirst);
      assert.deepEqual(fs.readFileSync(journalPath(box)), journalAfterFirst);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('keeps the original before path when a later install rewrites the same file', () => {
    const box = createSandbox();
    const priorLauncher = '#!/bin/sh\n# the launcher that existed before the first install\nexec dsh web\n';
    try {
      fs.writeFileSync(launcherPath(box), priorLauncher);
      assert.equal(run(['install', '--yes'], box).status, 0);
      const first = readJson(journalPath(box));
      const firstEntry = first.entries.find((entry) => entry.path === launcherPath(box));
      assert.ok(firstEntry.before, 'the original bytes were backed up');

      fs.writeFileSync(launcherPath(box), '#!/bin/sh\n# changed before the second install\n');
      assert.equal(run(['install', '--yes'], box).status, 0);

      const second = readJson(journalPath(box));
      const secondEntry = second.entries.find((entry) => entry.path === launcherPath(box));
      assert.equal(secondEntry.before, firstEntry.before, 'a re-run keeps the first backup');
      assert.equal(fs.readFileSync(secondEntry.before, 'utf8'), priorLauncher);

      assert.equal(run(['uninstall'], box).status, 0);
      assert.equal(fs.readFileSync(launcherPath(box), 'utf8'), priorLauncher);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('preserves unrelated settings keys and an existing enabledModels list', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS });
    try {
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);

      const settings = readJson(settingsPath(box));
      assert.equal(settings.defaultProvider, 'deepseek');
      assert.equal(settings.defaultModel, 'deepseek-flash');
      assert.deepEqual(settings.enabledModels, ['anthropic/*'], 'non-empty list is left alone');
      for (const [key, value] of Object.entries(SEEDED_SETTINGS)) {
        if (key === 'enabledModels') continue;
        assert.deepEqual(settings[key], value, `${key} must be preserved`);
      }
    } finally {
      cleanupSandbox(box);
    }
  });

  it('refuses to touch a settings.json that does not parse', () => {
    const box = createSandbox({ settings: '{ "theme": "dark", ' });
    try {
      const before = snapshotTree(box.root);
      const result = run(['install', '--yes'], box);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /settings\.json/);
      assert.match(result.stderr, /JSON/i);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
      assert.equal(fs.readFileSync(settingsPath(box), 'utf8'), '{ "theme": "dark", ');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('honours --model and --provider', () => {
    const box = createSandbox();
    try {
      const result = run(
        ['install', '--yes', '--model', 'deepseek-v4-pro', '--provider', 'deepseek'],
        box,
      );
      assert.equal(result.status, 0, result.stderr);
      const settings = readJson(settingsPath(box));
      assert.equal(settings.defaultModel, 'deepseek-v4-pro');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('does not write a dsh overlay when the effective route already matches', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.equal(fs.existsSync(overlayPath(box)), false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('writes the dsh overlay when the effective default model diverges', () => {
    const box = createSandbox();
    try {
      const result = run(['install', '--yes'], box, {
        env: { FAKE_DSH_PROVIDER: 'deepseek-official', FAKE_DSH_MODEL: 'deepseek-v4' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(overlayPath(box)), 'overlay written on divergence');

      const overlay = fs.readFileSync(overlayPath(box), 'utf8');
      assert.match(overlay, /id: agent-default-model/);
      assert.match(overlay, /provider: deepseek-account/);
      assert.match(overlay, /model: deepseek-flash/);

      const journal = readJson(journalPath(box));
      assert.ok(journal.entries.some((entry) => entry.path === overlayPath(box)));

      const second = run(['install', '--yes'], box, {
        env: { FAKE_DSH_PROVIDER: 'deepseek-official', FAKE_DSH_MODEL: 'deepseek-v4' },
      });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /unchanged/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('--json emits one machine-readable document', () => {
    const box = createSandbox();
    try {
      const result = run(['install', '--yes', '--json'], box);
      assert.equal(result.status, 0, result.stderr);

      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.command, 'install');
      assert.equal(parsed.ok, true);
      assert.ok(Array.isArray(parsed.changes));
      const actions = new Map(parsed.changes.map((change) => [change.path, change.action]));
      assert.equal(actions.get(launcherPath(box)), 'created');
      assert.equal(actions.get(wrapperPath(box)), 'created');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('writes the journal before it mutates a path, so an interrupted install is recoverable', () => {
    const box = createSandbox();
    const priorLauncher = '#!/bin/sh\n# the launcher that existed before install\nexec dsh web\n';
    try {
      fs.writeFileSync(launcherPath(box), priorLauncher);
      // A read-only DSH_HOME makes the launcher write fail after the settings
      // write already happened: an interrupt in the middle of the run.
      fs.chmodSync(box.dshHome, 0o555);

      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 1, 'the run fails loudly instead of pretending');

      assert.ok(fs.existsSync(journalPath(box)), 'the journal exists after the interrupt');
      const journal = readJson(journalPath(box));
      const covered = journal.entries.map((entry) => entry.path);
      const settingsEntry = journal.entries.find((entry) => entry.path === settingsPath(box));
      const launcherEntry = journal.entries.find((entry) => entry.path === launcherPath(box));

      assert.ok(settingsEntry, 'the path whose bytes changed is in the journal');
      assert.ok(launcherEntry, 'the path being written when the interrupt hit is in the journal too');
      assert.ok(covered.includes(settingsPath(box)));
      assert.equal(
        settingsEntry.sha256,
        createHash('sha256').update(fs.readFileSync(settingsPath(box))).digest('hex'),
        'the digest covers the bytes already written',
      );
      assert.ok(launcherEntry.before, 'the prior bytes were backed up before the journal entry');
      assert.ok(fs.existsSync(launcherEntry.before), 'the backup really exists');
      assert.deepEqual(
        journal.settings.keys.slice().sort(),
        ['defaultModel', 'defaultProvider', 'enabledModels'],
        'the settings keys install manages are recorded before settings.json is touched',
      );
      assert.equal(
        fs.existsSync(path.join(box.stateDir, 'journal.lock')),
        false,
        'the lock is released even when the run fails',
      );

      // And the recovery really works: uninstall still restores everything.
      fs.chmodSync(box.dshHome, 0o755);
      const recovery = run(['uninstall'], box);
      assert.equal(recovery.status, 0, recovery.stderr);
      assert.equal(fs.readFileSync(launcherPath(box), 'utf8'), priorLauncher);
      assert.equal(fs.existsSync(settingsPath(box)), false, 'nothing was left half-installed');
    } finally {
      try {
        fs.chmodSync(box.dshHome, 0o755);
      } catch {
        /* the sandbox is removed below anyway */
      }
      cleanupSandbox(box);
    }
  });

  it('creates missing parent directories instead of failing', () => {
    const box = createSandbox({ precreate: false });
    try {
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(launcherPath(box)));
      assert.ok(fs.existsSync(wrapperPath(box)));
      assert.ok(fs.existsSync(journalPath(box)));
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('install then uninstall', () => {
  it('round-trips a sandbox back to its starting bytes', () => {
    const box = createSandbox({ settings: SEEDED_SETTINGS, auth: { deepseek: { key: 'sk-test' } } });
    try {
      const pristine = snapshotTree(box.root);
      assert.equal(run(['install', '--yes'], box).status, 0);
      const installed = run(['uninstall', '--yes'], box);
      assert.equal(installed.status, 0, installed.stderr);

      const after = snapshotTree(box.root);
      // The run leaves the journal and the backup directory behind on purpose.
      const added = [...after.keys()].filter((key) => !pristine.has(key));
      assert.ok(
        added.every((key) => key.startsWith('state/')),
        `unexpected leftovers: ${added.filter((key) => !key.startsWith('state/'))}`,
      );
      for (const [key, value] of pristine) {
        assert.equal(after.get(key), value, `${key} must be restored byte-for-byte`);
      }
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('settings.json formatting', () => {
  it('writes two-space JSON with a trailing newline', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const raw = fs.readFileSync(settingsPath(box), 'utf8');
      assert.ok(raw.endsWith('}\n'), 'trailing newline');
      assert.match(raw, /\n {2}"defaultProvider": "deepseek",/);
      assert.deepEqual(JSON.parse(raw), JSON.parse(raw));
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('snapshot helper', () => {
  it('detects content changes', () => {
    const box = createSandbox();
    try {
      const first = snapshotTree(box.root);
      fs.writeFileSync(`${box.root}/extra.txt`, 'hi');
      const second = snapshotTree(box.root);
      assert.equal(snapshotsEqual(first, second), false);
      assert.deepEqual(snapshotDiff(first, second).added, ['extra.txt']);
    } finally {
      cleanupSandbox(box);
    }
  });
});
