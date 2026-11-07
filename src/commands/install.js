import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  assetPath,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from '../paths.js';
import { nodeCheck, preflight } from '../preflight.js';
import {
  captureBefore,
  desiredSettings,
  loadSettings,
  mergeSettings,
  renderSettings,
} from '../settings.js';
import { describeRoute, diverges, probe } from '../dsh.js';
import { accountGrantStatus } from '../dsh-account.js';
import { applySharedProvider, loadModels, renderModels, sharedProvider } from '../models.js';
import { renderHelper } from '../token-helper.js';
import { ensureAccount } from '../onboarding.js';
import { writeFileAtomic } from '../fs-atomic.js';
import {
  JournalError,
  LockHeldError,
  acquireJournalLock,
  createBackupBatch,
  createJournal,
  mergeEntries,
  readJournal,
  writeJournal,
} from '../journal.js';
import { packageVersion } from '../paths.js';

const LAUNCHER_ASSET = 'start-web.sh';
const WRAPPER_ASSET = 'pi-deepseek.sh';
const OVERLAY_ASSET = 'dsh-overlay.yml';

const FILE_MODE = 0o755;
const SETTINGS_MODE = 0o644;
const OVERLAY_MODE = 0o644;
const MODELS_MODE = 0o644;

function readIfExists(file) {
  try {
    const stats = fs.statSync(file);
    return { exists: true, bytes: fs.readFileSync(file), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null, mode: null };
    throw error;
  }
}

function sameBytes(left, right) {
  if (left === null || right === null) return false;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function fileChange({ file, asset, mode, kind = 'file', detail = '' }) {
  const bytes = fs.readFileSync(assetPath(asset));
  const current = readIfExists(file);
  if (!current.exists) {
    return { path: file, action: 'created', kind, fileMode: mode, bytes, detail: detail || 'new file' };
  }
  const identical = sameBytes(current.bytes, bytes);
  const modeOk = current.mode === mode;
  if (identical && modeOk) {
    return { path: file, action: 'unchanged', kind, fileMode: mode, bytes, detail: 'already up to date' };
  }
  return {
    path: file,
    action: 'updated',
    kind,
    fileMode: mode,
    bytes,
    detail: identical ? `mode ${current.mode.toString(8)} -> ${mode.toString(8)}` : 'content differs',
  };
}

/** A file whose content is computed rather than copied from an asset. */
function contentChange({ file, bytes, mode, kind = 'file', detail = '' }) {
  const current = readIfExists(file);
  if (!current.exists) {
    return { path: file, action: 'created', kind, fileMode: mode, bytes, detail: detail || 'new file' };
  }
  const identical = sameBytes(current.bytes, bytes);
  const modeOk = current.mode === mode;
  if (identical && modeOk) {
    return { path: file, action: 'unchanged', kind, fileMode: mode, bytes, detail: 'already up to date' };
  }
  return {
    path: file,
    action: 'updated',
    kind,
    fileMode: mode,
    bytes,
    detail: identical ? `mode ${current.mode.toString(8)} -> ${mode.toString(8)}` : 'content differs',
  };
}

/**
 * The helper Pi calls to obtain the token.
 *
 * It lives in the bin directory on purpose: the path recorded in
 * `models.json` must survive an `npx` cache clean and a package upgrade,
 * which a path inside a package directory would not.
 */
function helperChange({ layout, cliPath }) {
  const bytes = Buffer.from(renderHelper({ cliPath }));
  return contentChange({
    file: layout.tokenHelperPath,
    bytes,
    mode: FILE_MODE,
    kind: 'file',
    detail: 'pi-dsh-token helper (fetches the account token on demand)',
  });
}

/**
 * Wire Pi's `models.json` to the shared account.
 *
 * The provider is written whether or not a grant exists yet. The header is a
 * command, not a token, so it is valid before sign-in: the moment the user
 * signs in, the next Pi start already works. Skipping this when there is no
 * grant was worse — Pi then fell back silently to its built-in `deepseek`
 * provider, i.e. a different wallet, and the user saw a bare 402 with no hint.
 */
function modelsChange({ layout, grant, warnings }) {
  const current = loadModels(layout.modelsPath);
  const onDisk = readIfExists(layout.modelsPath);
  const provider = sharedProvider({ program: layout.tokenHelperPath, dshHome: layout.dshHome });
  const { merged, warning } = applySharedProvider(current.data, provider);
  if (warning) warnings.push(warning);
  const bytes = Buffer.from(renderModels(merged));
  const action = !current.exists
    ? 'created'
    : sameBytes(current.raw, bytes)
      ? 'unchanged'
      : 'updated';
  return {
    path: layout.modelsPath,
    action,
    kind: 'models',
    fileMode: onDisk.exists ? onDisk.mode : MODELS_MODE,
    bytes,
    detail:
      action === 'unchanged'
        ? 'already up to date'
        : grant.ok
          ? 'deepseek provider -> shared dsh account (token read on demand)'
          : 'deepseek provider wired; it reads the account once you sign in',
  };
}

function settingsChange({ layout, provider, model }) {
  const current = loadSettings(layout.settingsPath);
  const onDisk = readIfExists(layout.settingsPath);
  const desired = desiredSettings(current.data, { provider, model });
  const merged = mergeSettings(current.data, desired);
  const rendered = renderSettings(merged);
  const action = !current.exists
    ? 'created'
    : sameBytes(current.raw, rendered)
      ? 'unchanged'
      : 'updated';
  // Only the keys that actually change belong in the plan: listing every
  // managed key makes a no-op install look like it rewrote the file.
  const changedKeys = Object.keys(desired).filter(
    (key) => !current.data || current.data[key] !== desired[key],
  );
  return {
    path: layout.settingsPath,
    action,
    kind: 'settings',
    fileMode: onDisk.exists ? onDisk.mode : SETTINGS_MODE,
    bytes: Buffer.from(rendered),
    detail: action === 'unchanged' ? 'already up to date' : changedKeys.join(', '),
    current,
    desired,
  };
}

function overlayChange({ layout, dshPath, env, warnings }) {
  const existing = readIfExists(layout.overlayPath);
  const result = probe({ dshPath, env });
  if (!dshPath) {
    warnings.push('dsh was not found on PATH; the effective route was not probed');
    return {
      path: layout.overlayPath,
      action: 'skipped',
      kind: 'overlay',
      fileMode: OVERLAY_MODE,
      bytes: null,
      detail: 'dsh not found; overlay not evaluated',
    };
  }
  if (!result.ok) {
    warnings.push(`dsh config probe failed: ${result.error}`);
    return {
      path: layout.overlayPath,
      action: 'skipped',
      kind: 'overlay',
      fileMode: OVERLAY_MODE,
      bytes: null,
      detail: 'config probe failed; overlay not evaluated',
    };
  }
  if (!diverges(result)) {
    return {
      path: layout.overlayPath,
      action: 'skipped',
      kind: 'overlay',
      fileMode: OVERLAY_MODE,
      bytes: null,
      detail: `not needed: effective route already matches (${describeRoute(result)})`,
    };
  }
  const change = fileChange({
    file: layout.overlayPath,
    asset: OVERLAY_ASSET,
    mode: OVERLAY_MODE,
    kind: 'overlay',
    detail: `effective route diverges (${describeRoute(result)})`,
  });
  return change;
}

function planChanges({ layout, provider, model, dshPath, env, warnings, grant, cliPath }) {
  return [
    settingsChange({ layout, provider, model }),
    fileChange({ file: layout.launcherPath, asset: LAUNCHER_ASSET, mode: FILE_MODE }),
    fileChange({ file: layout.wrapperPath, asset: WRAPPER_ASSET, mode: FILE_MODE }),
    helperChange({ layout, cliPath }),
    modelsChange({ layout, grant, warnings }),
    overlayChange({ layout, dshPath, env, warnings }),
  ];
}

function journalSettings(prior, data, desired) {
  const recorded = prior?.settings;
  if (recorded && Array.isArray(recorded.keys)) {
    return {
      keys: [...new Set([...recorded.keys, ...Object.keys(desired)])],
      before: { ...(recorded.before ?? {}) },
    };
  }
  return { keys: Object.keys(desired), before: captureBefore(data, desired) };
}

export async function install({ options = {}, ui, layout, env = process.env, cliPath }) {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? DEFAULT_MODEL;

  if (!ui.json) ui.banner({ version: packageVersion() });

  const node = nodeCheck();
  if (node.status !== 'ok') {
    ui.error(`node ${node.detail}. pi-dsh-bridge requires node >= 22.19.0.`);
    return 1;
  }

  const facts = preflight({ env });
  const warnings = [];
  if (!facts.pi.found) warnings.push('pi was not found on PATH; settings were still written');

  // One mutating run at a time. Without the lock a second install could read a
  // journal the first one is in the middle of rewriting, and the two would
  // interleave their backups and settings keys. A dry run writes nothing, so it
  // takes no lock.
  let lock = null;
  if (options.dryRun !== true) {
    try {
      lock = acquireJournalLock(layout);
    } catch (error) {
      if (error instanceof LockHeldError) {
        ui.note(error.message);
        return 1;
      }
      throw error;
    }
  }

  try {
    let plan;
    let changed;
    let versions;
    // Never overwrite a journal we cannot read: that would destroy the only record
    // of what uninstall needs to restore.
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

    try {
      plan = planChanges({
        layout,
        provider,
        model,
        dshPath: facts.dsh.found ? facts.dsh.path : null,
        env,
        warnings,
        grant: accountGrantStatus(layout.credentialsPath),
        cliPath,
      });
    } catch (error) {
      ui.error(error.message);
      return 1;
    }

    changed = plan.filter((change) => change.action === 'created' || change.action === 'updated');
    versions = { pi: facts.pi.version, dsh: facts.dsh.version, node: process.versions.node };

    if (options.dryRun) {
      ui.line(`install plan (dry run: nothing is written)`);
      for (const change of plan) {
        ui.line(`  ${change.action.padEnd(9)} ${change.path}  ${change.detail}`);
      }
      for (const warning of warnings) ui.warn('note', warning);
      if (ui.json) {
        ui.emitJson({
          command: 'install',
          ok: true,
          dryRun: true,
          versions,
          journal: layout.journalPath,
          warnings,
          changes: plan.map((change) => ({ path: change.path, action: change.action, detail: change.detail })),
        });
      }
      return 0;
    }

    if (changed.length > 0) {
      // Prompt for confirmation unless --yes is given or non-interactive
      if (!options.yes) {
        const ok = await ui.confirm(
          `About to write ${changed.length} path(s). Proceed?`
        );
        if (!ok) {
          ui.error('Aborted by user.');
          return 1;
        }
      }

      const batch = createBackupBatch({ backupsDir: layout.backupsDir });
      const settingsPlan = plan.find((change) => change.kind === 'settings');
      // The journal is committed *before* every write: a signal, an ENOSPC or an
      // EACCES between any two steps then leaves a journal that already covers
      // every path whose bytes changed, so uninstall can still put the machine
      // back exactly as it was.
      let next = journal ? { ...journal, versions } : createJournal({ versions });
      // Recorded even when settings.json already matches what install wants:
      // uninstall needs to know which keys this bridge owns and what they were.
      if (settingsPlan) {
        next.settings = journalSettings(journal, settingsPlan.current.data, settingsPlan.desired);
      }
      for (const change of changed) {
        const current = readIfExists(change.path);
        const before = current.exists ? batch.backup(change.path) : null;
        const entry = {
          path: change.path,
          before,
          after: change.kind === 'settings' ? 'settings-keys' : 'file-copy',
          // The digest of the exact bytes about to be written. Without it a later
          // uninstall could not tell its own file from one the user rewrote.
          sha256: createHash('sha256').update(change.bytes).digest('hex'),
        };
        next = { ...next, entries: mergeEntries(next, [entry]) };
        writeJournal(layout.journalPath, next);

        fs.mkdirSync(path.dirname(change.path), { recursive: true });
        // Atomic: Pi executes the token helper and parses models.json while it
        // runs, so these files must never be observable half-written.
        writeFileAtomic(change.path, change.bytes, { mode: change.fileMode });
      }
    }

    ui.line('install');
    for (const change of plan) {
      ui.line(`  ${change.action.padEnd(9)} ${change.path}  ${change.detail}`);
    }
    for (const warning of warnings) ui.warn('note', warning);
    ui.line(
      changed.length === 0
        ? `nothing to do: ${plan.length} path(s) already match (journal unchanged)`
        : `${changed.length} path(s) changed, journal at ${layout.journalPath}`,
    );

    // Everything is on disk. What is left is the one step only the user can take:
    // signing in to DeepSeek inside the dsh web panel. So do not hand them a
    // to-do list — open the panel, hand over the URL and detect the account.
    ui.blank();
    const ready = accountGrantStatus(layout.credentialsPath);
    if (ready.ok) {
      ui.ok('account', `connected to ${ready.issuer ?? 'DeepSeek'}`);
      ui.blank();
      ui.rule();
      ui.ok('ready', 'everything is wired');
      ui.cmd('pi');
    } else {
      ui.warn('account', 'not connected yet — this is the only step left');
      const result = await ensureAccount({
        layout,
        ui,
        env,
        cliPath,
        open: options.open === true && options.noOpen !== true,
        restart: false,
        announce: false,
      });
      ui.blank();
      ui.rule();
      if (result.ok) {
        ui.ok('ready', 'everything is wired');
        ui.cmd('pi');
      } else {
        ui.aside('Pi is installed; it will ask for the account until you sign in.');
        ui.cmd('pi-dsh-bridge account');
      }
    }
    ui.blank();

    if (ui.json) {
      ui.emitJson({
        command: 'install',
        ok: true,
        dryRun: false,
        versions,
        journal: layout.journalPath,
        warnings,
        changes: plan.map((change) => ({ path: change.path, action: change.action, detail: change.detail })),
      });
    }

    return 0;
  } finally {
    if (lock) lock.release();
  }
}

export const INSTALL_HELP = `Usage: pi-dsh-bridge install [options]

Wire DeepSeek into Pi and install the dsh web launcher.

  --dry-run            print the planned changes and write nothing
  -y, --yes            do not ask for confirmation
  --json               machine-readable output
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi default model, default ${DEFAULT_MODEL}
  --provider <id>      Pi provider, default ${DEFAULT_PROVIDER}
`;
