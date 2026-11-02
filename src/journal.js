import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
  return data;
}

export function writeJournal(file, journal) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
}

export function createJournal({ versions, installedAt = new Date().toISOString() }) {
  return { version: JOURNAL_VERSION, installedAt, versions, entries: [], settings: { keys: [], before: {} } };
}

/**
 * Merge new entries into an existing journal, preserving the *original* `before`
 * of a path that was already recorded: a second install must never overwrite the
 * record of what the file looked like before the first one.
 */
export function mergeEntries(journal, entries) {
  const merged = journal.entries.map((entry) => ({ ...entry }));
  for (const entry of entries) {
    const existing = merged.find((candidate) => candidate.path === entry.path);
    if (existing) {
      existing.after = entry.after;
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
  let candidate = path.join(backupsDir, stamp);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(backupsDir, `${stamp}-${counter}`);
    counter += 1;
  }
  return candidate;
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
      fs.mkdirSync(stampDir, { recursive: true });
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
