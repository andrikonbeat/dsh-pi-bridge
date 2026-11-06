import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { writeFileAtomic } from './fs-atomic.js';

export const JOURNAL_VERSION = 1;

/** A journal we cannot read is a hard stop: nothing may be restored from it. */
export class JournalError extends Error {
  constructor(file, cause) {
    super(
      `${file} is not a readable install journal (${cause}). Nothing was restored: ` +
        'the journal is written by `pi-dsh-bridge install`, so restore by hand from ' +
        'the backups directory or reinstall and uninstall from there.',
    );
    this.name = 'JournalError';
    this.file = file;
  }
}

/** Another mutating run already owns the journal lock. */
export class LockHeldError extends Error {
  constructor(file) {
    super(
      `another pi-dsh-bridge run is in progress (lock: ${file}). ` +
        'Wait for it to finish, or delete the file if no run is alive.',
    );
    this.name = 'LockHeldError';
    this.file = file;
  }
}

export function journalLockPath(layout) {
  return path.join(layout.stateDir, 'journal.lock');
}

/**
 * Claim the state directory for one mutating run.
 *
 * `openSync(..., 'wx')` is the claim: it succeeds for exactly one process and
 * fails for every other process that tries the same path. The caller owns the
 * returned handle and must release it in a `finally` block.
 *
 * A lock whose recorded owner is provably gone is taken over instead of
 * refusing forever: a crash mid-install must not make the `uninstall` that
 * recovers it impossible to run. A lock whose owner is alive, or whose owner
 * cannot be read at all, still refuses — the safe direction.
 */
export function acquireJournalLock(layout) {
  const file = journalLockPath(layout);
  fs.mkdirSync(layout.stateDir, { recursive: true });

  try {
    return claimLock(file);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    if (!takeOverDeadLock(file)) throw error;
    // Exactly one process wins the re-claim. A second one loses here and gets
    // the honest LockHeldError, which is what the message promises.
    return claimLock(file);
  }
}

function claimLock(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new LockHeldError(file);
    throw error;
  }

  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(file);
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error;
  }
  fs.closeSync(descriptor);

  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}

/** The pid the lock names, or null when it names nothing readable. */
function lockOwnerPid(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True when the process exists. EPERM means it exists and is not ours. */
function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Remove a lock whose owner is gone. An unreadable owner is never assumed
 * dead: the takeover has to be provable, or it is not a takeover.
 */
function takeOverDeadLock(file) {
  const pid = lockOwnerPid(file);
  if (pid === null) return false;
  if (ownerIsAlive(pid)) return false;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

export function readJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new JournalError(file, error.message);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new JournalError(file, error.message);
  }
  if (data === null || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new JournalError(file, 'expected an object with an "entries" array');
  }
  // A journal from a version this code does not know may mean something else
  // entirely: acting on it would restore the wrong bytes. Refuse it instead.
  if (data.version !== JOURNAL_VERSION) {
    throw new JournalError(
      file,
      `expected version ${JOURNAL_VERSION}, found ${JSON.stringify(data.version ?? null)}`,
    );
  }
  data.entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new JournalError(file, `entry ${index} is not an object`);
    }
    if (typeof entry.path !== 'string' || entry.path === '') {
      throw new JournalError(file, `entry ${index} has no string "path"`);
    }
  });
  return data;
}

export function writeJournal(file, journal) {
  writeFileAtomic(file, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o644 });
}

export function createJournal({ versions, installedAt = new Date().toISOString() }) {
  return { version: JOURNAL_VERSION, installedAt, versions, entries: [], settings: { keys: [], before: {} } };
}

/**
 * Merge new entries into an existing journal, preserving the *original* `before`
 * of a path that was already recorded: a second install must never overwrite the
 * record of what the file looked like before the first one.
 *
 * `after` and `sha256` do follow the latest write: they describe the bytes this
 * bridge last put on disk, which is what uninstall needs to recognise them.
 */
export function mergeEntries(journal, entries) {
  const merged = journal.entries.map((entry) => ({ ...entry }));
  for (const entry of entries) {
    const existing = merged.find((candidate) => candidate.path === entry.path);
    if (existing) {
      existing.after = entry.after;
      if (entry.sha256) existing.sha256 = entry.sha256;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

/** `YYYYMMDD-HHMMSS`, local time, collision-safe within a run. */
export function makeStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function uniqueStampDir(backupsDir, stamp) {
  fs.mkdirSync(backupsDir, { recursive: true });
  let counter = 0;
  for (;;) {
    const candidate =
      counter === 0 ? path.join(backupsDir, stamp) : path.join(backupsDir, `${stamp}-${counter}`);
    try {
      // `mkdir` without `recursive` is the claim itself: two runs that start in
      // the same second cannot both create the same directory, so neither can
      // ever write its backups into the other's batch.
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      counter += 1;
    }
  }
}

/**
 * One backup directory per install run: `backupsDir/<stamp>/`. Backups are
 * never deleted by uninstall.
 */
export function createBackupBatch({ backupsDir, stamp = makeStamp() }) {
  let stampDir = null;
  const ensureDir = () => {
    if (!stampDir) {
      stampDir = uniqueStampDir(backupsDir, stamp);
    }
    return stampDir;
  };

  return {
    get dir() {
      return ensureDir();
    },
    /** Copy the prior bytes (and mode) of `file` and return the backup path. */
    backup(file) {
      const dir = ensureDir();
      const base = path.basename(file);
      let target = path.join(dir, base);
      if (fs.existsSync(target)) {
        const digest = createHash('sha256').update(file).digest('hex').slice(0, 8);
        target = path.join(dir, `${digest}-${base}`);
      }
      fs.copyFileSync(file, target);
      // The backup carries the prior mode too, so a restore can put back an
      // executable bit that install changed.
      fs.chmodSync(target, fs.statSync(file).mode & 0o777);
      return target;
    },
  };
}
