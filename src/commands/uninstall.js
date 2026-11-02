import fs from 'node:fs';
import path from 'node:path';

import { JournalError, readJournal } from '../journal.js';
import { writeFileAtomic } from '../fs-atomic.js';

function readIfExists(file) {
  try {
    const stats = fs.statSync(file);
    return { exists: true, bytes: fs.readFileSync(file), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null, mode: null };
    throw error;
  }
}

function planEntry(entry) {
  if (entry.before === null) {
    const current = readIfExists(entry.path);
    return {
      path: entry.path,
      action: current.exists ? 'delete' : 'unchanged',
      detail: 'did not exist before install',
      backupPath: null,
    };
  }
  let backup;
  let backupMode;
  try {
    backup = fs.readFileSync(entry.before);
    backupMode = fs.statSync(entry.before).mode & 0o777;
  } catch {
    return {
      path: entry.path,
      action: 'missing',
      detail: `backup ${entry.before} is gone; cannot restore exactly`,
      backupPath: null,
    };
  }
  const current = readIfExists(entry.path);
  const identical =
    current.exists &&
    Buffer.compare(current.bytes, backup) === 0 &&
    (current.mode === null || current.mode === backupMode);
  return {
    path: entry.path,
    action: identical ? 'unchanged' : 'restore',
    detail: identical
      ? 'already restored'
      : `from ${entry.before} (mode ${backupMode.toString(8)})`,
    backupPath: entry.before,
    bytes: backup,
    mode: backupMode,
  };
}

export function uninstall({ options = {}, ui, layout }) {
  let journal;
  try {
    journal = readJournal(layout.journalPath);
  } catch (error) {
    if (error instanceof JournalError) {
      ui.error(error.message);
      return 1;
    }
    throw error;
  }

  if (!journal) {
    ui.error(
      `no install journal at ${layout.journalPath}. Nothing to restore: uninstall only reverts ` +
        'paths that install recorded, and it never guesses. If you installed with a different ' +
        '--state-dir, pass the same one here; otherwise restore by hand from $STATE_DIR/backups/.',
    );
    return 1;
  }

  const plan = journal.entries.map(planEntry);
  const actionable = plan.filter((item) => item.action !== 'unchanged');
  const failures = plan.filter((item) => item.action === 'missing');

  if (options.dryRun) {
    ui.line(`uninstall plan from ${layout.journalPath} (dry run: nothing is written)`);
    for (const item of plan) ui.line(`  ${item.action.padEnd(9)} ${item.path}  ${item.detail}`);
    for (const item of failures) ui.warn('note', `${item.path}: ${item.detail}`);
    if (ui.json) {
      ui.emitJson({
        command: 'uninstall',
        ok: failures.length === 0,
        dryRun: true,
        journal: layout.journalPath,
        changes: plan.map(({ path: file, action, detail }) => ({ path: file, action, detail })),
      });
    }
    return failures.length === 0 ? 0 : 1;
  }

  for (const item of actionable) {
    if (item.action === 'delete') {
      fs.rmSync(item.path, { force: true });
    } else if (item.action === 'restore') {
      // Atomic, and the mode is applied on the temporary file, so the restored
      // bytes and the restored permissions become visible together.
      writeFileAtomic(item.path, item.bytes, { mode: item.mode });
      // writeFileSync only applies `mode` on creation; restore the prior mode
      // even when the file survived, because install may have changed it.
      fs.chmodSync(item.path, item.mode);
    }
  }

  ui.line(`uninstall from ${layout.journalPath}`);
  for (const item of plan) ui.line(`  ${item.action.padEnd(9)} ${item.path}  ${item.detail}`);

  if (failures.length > 0) {
    for (const item of failures) ui.error(`${item.path}: ${item.detail}`);
    ui.error(
      'nothing else was touched. The backups directory is never deleted by uninstall, so check ' +
        `${layout.backupsDir} or restore those files by hand.`,
    );
    return 1;
  }

  ui.line(`journal kept at ${layout.journalPath} for audit; backups are never deleted`);

  if (ui.json) {
    ui.emitJson({
      command: 'uninstall',
      ok: true,
      dryRun: false,
      journal: layout.journalPath,
      changes: plan.map(({ path: file, action, detail }) => ({ path: file, action, detail })),
    });
  }

  return 0;
}

export const UNINSTALL_HELP = `Usage: pi-dsh-bridge uninstall [options]

Restore exactly what install changed, and nothing else.

  --dry-run            print the plan and change nothing
  -y, --yes            do not ask for confirmation
  --json               machine-readable output
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
`;
