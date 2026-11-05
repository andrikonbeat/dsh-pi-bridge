import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { JournalError, createBackupBatch, readJournal } from '../src/journal.js';
import {
  cleanupSandbox,
  createSandbox,
  journalPath,
  launcherPath,
  readJson,
  run,
  snapshotDiff,
  snapshotTree,
  wrapperPath,
} from './helpers.js';

const TOKEN = 'account-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The credentials file dsh writes once the user signs in. */
function writeCredentials(box) {
  fs.mkdirSync(box.dshHome, { recursive: true });
  fs.writeFileSync(
    path.join(box.dshHome, '.credentials.yaml'),
    `records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: ${TOKEN}\n      issuer: https://platform.deepseek.com\n`,
  );
}

function lockPath(box) {
  return path.join(box.stateDir, 'journal.lock');
}

const LOCK_MESSAGE = (file) =>
  `another pi-dsh-bridge run is in progress (lock: ${file}). ` +
  'Wait for it to finish, or delete the file if no run is alive.';

/**
 * Stand in for a run that is still alive: the lock file exists and names a
 * process that can be proven to exist. A made-up pid would be a lock whose
 * owner is gone, which the bridge now treats as recoverable.
 */
function holdLock(box) {
  fs.mkdirSync(box.stateDir, { recursive: true });
  fs.writeFileSync(lockPath(box), `${process.pid}\n`);
  return lockPath(box);
}

function writeJournalFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

describe('readJournal validation', () => {
  it('rejects a version it does not know, naming the version', () => {
    const box = createSandbox();
    try {
      const file = journalPath(box);
      writeJournalFile(file, { version: 99, installedAt: '2024-01-01T00:00:00.000Z', entries: [] });

      assert.throws(
        () => readJournal(file),
        (error) => {
          assert.ok(error instanceof JournalError, 'a bad version is a JournalError');
          assert.equal(error.file, file);
          assert.match(error.message, /version/i);
          assert.match(error.message, /99/);
          return true;
        },
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('rejects an entry that is not an object', () => {
    const box = createSandbox();
    try {
      const file = journalPath(box);
      writeJournalFile(file, { version: 1, entries: [null] });

      assert.throws(
        () => readJournal(file),
        (error) => {
          assert.ok(error instanceof JournalError);
          assert.match(error.message, /entry/i);
          return true;
        },
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('rejects an entry without a string path', () => {
    const box = createSandbox();
    try {
      const file = journalPath(box);
      writeJournalFile(file, { version: 1, entries: [{ before: null, after: 'file-copy' }] });

      assert.throws(
        () => readJournal(file),
        (error) => {
          assert.ok(error instanceof JournalError);
          assert.match(error.message, /path/i);
          return true;
        },
      );
    } finally {
      cleanupSandbox(box);
    }
  });

  it('still reports a missing journal as null', () => {
    const box = createSandbox();
    try {
      assert.equal(readJournal(journalPath(box)), null);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('uninstall never acts on a journal recorded by a newer version', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const journal = JSON.parse(fs.readFileSync(journalPath(box), 'utf8'));
      writeJournalFile(journalPath(box), { ...journal, version: 2 });
      const before = snapshotTree(box.root);

      const result = run(['uninstall'], box);
      assert.equal(result.status, 1, 'a newer journal is refused, not guessed at');
      assert.match(result.stderr, /version/i);
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('journal digests', () => {
  it('records the exact models.json bytes written by sync', () => {
    const box = createSandbox();
    try {
      writeCredentials(box);
      assert.equal(run(['sync'], box).status, 0);

      const journal = readJson(journalPath(box));
      const entry = journal.entries.find((candidate) => candidate.path === path.join(box.piHome, 'models.json'));
      assert.ok(entry, 'sync records models.json in the journal');
      assert.equal(
        entry.sha256,
        createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex'),
      );
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('backup stamp directories', () => {
  it('claims the stamp directory with mkdir, not with existsSync', () => {
    const box = createSandbox();
    try {
      const backupsDir = path.join(box.stateDir, 'backups');
      fs.mkdirSync(backupsDir, { recursive: true });
      // A dangling symlink: `existsSync` reports false, but the name is taken,
      // so only a real mkdir (and its EEXIST) can tell the truth.
      fs.symlinkSync(path.join(box.root, 'gone'), path.join(backupsDir, '20240101-000000'));

      const file = path.join(box.root, 'sample.txt');
      fs.writeFileSync(file, 'prior bytes\n');
      const backup = createBackupBatch({ backupsDir, stamp: '20240101-000000' }).backup(file);

      assert.equal(path.basename(path.dirname(backup)), '20240101-000000-1');
      assert.equal(fs.readFileSync(backup, 'utf8'), 'prior bytes\n');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('retries the next candidate while the earlier ones are taken', () => {
    const box = createSandbox();
    try {
      const backupsDir = path.join(box.stateDir, 'backups');
      // Two runs already claimed these names; a third one must not reuse them.
      fs.mkdirSync(path.join(backupsDir, '20240101-000000'), { recursive: true });
      fs.mkdirSync(path.join(backupsDir, '20240101-000000-1'), { recursive: true });

      const file = path.join(box.root, 'sample.txt');
      fs.writeFileSync(file, 'prior bytes\n');
      const batch = createBackupBatch({ backupsDir, stamp: '20240101-000000' });
      const backup = batch.backup(file);

      assert.equal(path.basename(path.dirname(backup)), '20240101-000000-2');
      assert.equal(fs.readFileSync(backup, 'utf8'), 'prior bytes\n');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('creates the backup root when the state directory is still empty', () => {
    const box = createSandbox({ precreate: false });
    try {
      const backupsDir = path.join(box.stateDir, 'backups');
      const file = path.join(box.root, 'sample.txt');
      fs.writeFileSync(file, 'prior bytes\n');

      const backup = createBackupBatch({ backupsDir, stamp: '20240101-000000' }).backup(file);
      assert.equal(
        fs.readFileSync(backup, 'utf8'),
        'prior bytes\n',
        'the batch creates backups/<stamp>/ without copying recursive assumptions',
      );
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('the run lock', () => {
  for (const [command, expected] of [
    ['install', 'installation'],
    ['uninstall', 'uninstallation'],
    ['sync', 'sync'],
  ]) {
    it(`${command} refuses to run while another run holds the lock`, () => {
      const box = createSandbox();
      try {
        if (command !== 'install') {
          writeCredentials(box);
          assert.equal(run(['install', '--yes'], box).status, 0, 'seed an installed machine');
        }
        const lock = holdLock(box);
        const before = snapshotTree(box.root);

        const result = run([command], box);
        assert.equal(result.status, 1, `${command} must not run a second time`);
        assert.equal(
          result.stderr.trim(),
          LOCK_MESSAGE(lock),
          `${command} reports the held lock exactly`,
        );
        assert.ok(fs.existsSync(lock), 'a refused run never deletes the lock of the live one');
        assert.deepEqual(
          snapshotDiff(before, snapshotTree(box.root)),
          { added: [], removed: [], changed: [] },
          `${command} changed nothing (${expected})`,
        );
      } finally {
        cleanupSandbox(box);
      }
    });
  }

  it('account refuses to run while another run holds the lock', () => {
    const box = createSandbox();
    try {
      const lock = holdLock(box);
      const before = snapshotTree(box.root);

      const result = run(['account', '--json'], box);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), LOCK_MESSAGE(lock));
      assert.equal(result.stdout, '');
      assert.deepEqual(snapshotDiff(before, snapshotTree(box.root)), {
        added: [],
        removed: [],
        changed: [],
      });
    } finally {
      cleanupSandbox(box);
    }
  });

  it('takes over a lock left behind by a run that is no longer alive', () => {
    const box = createSandbox();
    try {
      // A process that has already exited: its pid is proof of a crash, not of
      // a live run, so the lock must not block recovery forever.
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      fs.mkdirSync(box.stateDir, { recursive: true });
      fs.writeFileSync(lockPath(box), `${dead.pid}\n`);

      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(lockPath(box)), false, 'the takeover released the lock');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('refuses a lock whose recorded owner is still alive', () => {
    const box = createSandbox();
    try {
      const lock = holdLock(box);
      const result = run(['install', '--yes'], box);

      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), LOCK_MESSAGE(lock));
    } finally {
      cleanupSandbox(box);
    }
  });

  it('refuses a lock it cannot attribute to any process', () => {
    const box = createSandbox();
    try {
      fs.mkdirSync(box.stateDir, { recursive: true });
      fs.writeFileSync(lockPath(box), '');

      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 1, 'an unreadable owner is never assumed dead');
      assert.match(result.stderr, /another pi-dsh-bridge run is in progress/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('releases the lock when the run finishes, so the next run works', () => {
    const box = createSandbox();
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.equal(fs.existsSync(lockPath(box)), false, 'the lock is gone after a successful run');
      assert.equal(run(['uninstall'], box).status, 0, 'a later run is not blocked');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('never creates a lock for a dry run', () => {
    const box = createSandbox({ precreate: false });
    try {
      assert.equal(run(['install', '--dry-run'], box).status, 0);
      assert.equal(fs.existsSync(lockPath(box)), false);
      assert.equal(fs.existsSync(box.stateDir), false, 'a dry run writes nothing at all');

      assert.equal(run(['install', '--yes'], box).status, 0);
      assert.equal(run(['uninstall', '--dry-run'], box).status, 0);
      assert.equal(fs.existsSync(lockPath(box)), false);
      assert.ok(fs.existsSync(wrapperPath(box)), 'the dry run restored nothing');
      assert.ok(fs.existsSync(launcherPath(box)));
      assert.equal(readJson(journalPath(box)).entries.length > 0, true);
    } finally {
      cleanupSandbox(box);
    }
  });
});
