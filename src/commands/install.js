import fs from 'node:fs';
import path from 'node:path';

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
import {
  JournalError,
  createBackupBatch,
  createJournal,
  mergeEntries,
  readJournal,
  writeJournal,
} from '../journal.js';

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
  const bytes = Buffer.from(renderHelper({ cliPath, dshHome: layout.dshHome }));
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
 * Without a usable grant there is nothing to wire, and the file is left
 * exactly as it is: a broken bridge must never be worse than no bridge, and
 * the API-key route keeps working untouched.
 */
function modelsChange({ layout, grant }) {
  const current = loadModels(layout.modelsPath);
  const onDisk = readIfExists(layout.modelsPath);
  if (!grant.ok) {
    return {
      path: layout.modelsPath,
      action: 'skipped',
      kind: 'models',
      fileMode: onDisk.exists ? onDisk.mode : MODELS_MODE,
      bytes: null,
      detail: `not wired: ${grant.error}`,
    };
  }
  const provider = sharedProvider({ program: layout.tokenHelperPath, dshHome: layout.dshHome });
  const { merged } = applySharedProvider(current.data, provider);
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
        : 'deepseek provider -> shared dsh account (token read on demand)',
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
    modelsChange({ layout, grant }),
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

export function install({ options = {}, ui, layout, env = process.env, cliPath }) {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? DEFAULT_MODEL;

  const node = nodeCheck();
  if (node.status !== 'ok') {
    ui.error(`node ${node.detail}. pi-dsh-bridge requires node >= 22.19.0.`);
    return 1;
  }

  const facts = preflight({ env });
  const warnings = [];
  if (!facts.pi.found) warnings.push('pi was not found on PATH; settings were still written');

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

  let plan;
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

  const changed = plan.filter((change) => change.action === 'created' || change.action === 'updated');
  const versions = { pi: facts.pi.version, dsh: facts.dsh.version, node: process.versions.node };

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
    const batch = createBackupBatch({ backupsDir: layout.backupsDir });
    const entries = [];
    for (const change of changed) {
      const current = readIfExists(change.path);
      const before = current.exists ? batch.backup(change.path) : null;
      fs.mkdirSync(path.dirname(change.path), { recursive: true });
      fs.writeFileSync(change.path, change.bytes);
      fs.chmodSync(change.path, change.fileMode);
      entries.push({
        path: change.path,
        before,
        after: change.kind === 'settings' ? 'settings-keys' : 'file-copy',
      });
    }

    const next = journal
      ? { ...journal, versions, entries: mergeEntries(journal, entries) }
      : createJournal({ versions });
    if (!journal) next.entries = mergeEntries(next, entries);
    const settingsPlan = plan.find((change) => change.kind === 'settings');
    next.settings = journalSettings(journal, settingsPlan.current.data, settingsPlan.desired);
    writeJournal(layout.journalPath, next);
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
