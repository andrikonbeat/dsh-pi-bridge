import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../paths.js';
import { checkDshVersion } from '../compat.js';
import { describeRoute, diverges, probe } from '../dsh.js';
import { nodeCheck, preflight } from '../preflight.js';
import { loadSettings, settingsMismatch } from '../settings.js';
import { JournalError, readJournal } from '../journal.js';

function readIfExists(file) {
  try {
    const stats = fs.statSync(file);
    return { exists: true, mode: stats.mode & 0o777, size: stats.size };
  } catch {
    return { exists: false, mode: null, size: 0 };
  }
}

function isExecutableFile(file) {
  const info = readIfExists(file);
  if (!info.exists) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function checkWritable(dir) {
  const target = nearestExistingAncestor(dir);
  if (!target) return { status: 'fail', detail: `no existing ancestor for ${dir}` };
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return {
      status: 'ok',
      detail: target === path.resolve(dir) ? `${dir} is writable` : `${dir} is creatable under ${target}`,
    };
  } catch {
    return { status: 'fail', detail: `${target} is not writable` };
  }
}

function credentialCheck(authPath, env) {
  if (typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.length > 0) {
    return { status: 'ok', detail: 'present in the environment (DEEPSEEK_API_KEY)' };
  }
  const info = readIfExists(authPath);
  if (!info.exists) {
    return {
      status: 'warn',
      detail: `no DeepSeek credential found (${authPath} is missing); run: pi auth login --provider deepseek`,
    };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return { status: 'warn', detail: `${authPath} does not parse as JSON` };
  }
  const entry = data?.deepseek ?? data?.['deepseek-official'];
  const key = entry?.key ?? entry?.apiKey ?? entry?.access_token;
  const present = typeof key === 'string' && key.length > 0;
  // Presence only. A credential value is never read into any output.
  return present
    ? { status: 'ok', detail: `present in ${authPath}` }
    : { status: 'warn', detail: `no DeepSeek key in ${authPath}; run: pi auth login --provider deepseek` };
}

function journalCheck(layout, observedDsh) {
  let journal;
  try {
    journal = readJournal(layout.journalPath);
  } catch (error) {
    if (error instanceof JournalError) {
      return { status: 'warn', detail: `${layout.journalPath} is unreadable; run install again` };
    }
    throw error;
  }
  if (!journal) return null;
  const installedDsh = journal.versions?.dsh ?? 'unknown';
  if (observedDsh && installedDsh !== 'unknown' && installedDsh !== observedDsh) {
    return {
      status: 'warn',
      detail: `installed against dsh ${installedDsh}, now running ${observedDsh}; see docs/compatibility.md`,
    };
  }
  return { status: 'ok', detail: `journal from ${journal.installedAt} (dsh ${installedDsh})` };
}

/** Cheap, offline health check. Never spends API credit, never prints a secret. */
export function doctor({ options = {}, ui, layout, env = process.env }) {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? DEFAULT_MODEL;
  const facts = preflight({ env });
  const checks = [];

  const push = (id, title, result) => {
    checks.push({ id, title, status: result.status, detail: result.detail });
  };

  push('node', 'node >= 22.19.0', nodeCheck());

  push(
    'pi',
    'pi on PATH',
    facts.pi.found
      ? { status: 'ok', detail: `${facts.pi.version ?? 'version unknown'} at ${facts.pi.path}` }
      : { status: 'fail', detail: 'pi not found on PATH; install Pi or fix PATH' },
  );

  const dshVersion = facts.dsh.found ? checkDshVersion(facts.dsh.version) : null;
  push(
    'dsh',
    'dsh on PATH and in the compatibility matrix',
    !facts.dsh.found
      ? { status: 'fail', detail: 'dsh not found on PATH; install @deepseek-ai/dsh or fix PATH' }
      : { status: dshVersion.status, detail: `${facts.dsh.path}: ${dshVersion.detail}` },
  );

  let settings = null;
  try {
    settings = loadSettings(layout.settingsPath);
  } catch (error) {
    push('settings', 'settings.json parses and points at the requested route', {
      status: 'fail',
      detail: error.message,
    });
  }
  if (settings === null) {
    // handled above
  } else if (!settings.exists) {
    push('settings', 'settings.json parses and points at the requested route', {
      status: 'warn',
      detail: `${layout.settingsPath} does not exist; run: pi-dsh-bridge install`,
    });
  } else {
    const mismatches = settingsMismatch(settings.data, { provider, model });
    push(
      'settings',
      'settings.json parses and points at the requested route',
      mismatches.length === 0
        ? { status: 'ok', detail: `defaultProvider=${provider}, defaultModel=${model}` }
        : { status: 'warn', detail: `${mismatches.join('; ')}; run: pi-dsh-bridge install` },
    );
  }

  push(
    'credential',
    'a DeepSeek credential is present (value never read)',
    credentialCheck(layout.authPath, env),
  );

  push(
    'launcher',
    'dsh web launcher installed and executable',
    isExecutableFile(layout.launcherPath)
      ? { status: 'ok', detail: `${layout.launcherPath} (mode ${readIfExists(layout.launcherPath).mode.toString(8)})` }
      : readIfExists(layout.launcherPath).exists
        ? { status: 'warn', detail: `${layout.launcherPath} is not executable; run: pi-dsh-bridge install` }
        : { status: 'warn', detail: `${layout.launcherPath} is missing; run: pi-dsh-bridge install` },
  );

  push(
    'wrapper',
    'pi-deepseek wrapper installed and executable',
    isExecutableFile(layout.wrapperPath)
      ? { status: 'ok', detail: layout.wrapperPath }
      : readIfExists(layout.wrapperPath).exists
        ? { status: 'warn', detail: `${layout.wrapperPath} is not executable; run: pi-dsh-bridge install` }
        : { status: 'warn', detail: `${layout.wrapperPath} is missing; run: pi-dsh-bridge install` },
  );

  if (!facts.dsh.found) {
    push('dsh-route', 'effective dsh default model matches the required route', {
      status: 'warn',
      detail: 'dsh not found; the effective route was not probed',
    });
  } else {
    const overlayExists = readIfExists(layout.overlayPath).exists;
    const result = probe({ dshPath: facts.dsh.path, env, patchPath: overlayExists ? layout.overlayPath : null });
    let route;
    if (!result.ok) {
      route = { status: 'warn', detail: `config probe failed: ${result.error}` };
    } else if (overlayExists) {
      route = diverges(result)
        ? {
            status: 'warn',
            detail: `overlay did not fix the route (${describeRoute(result)}); see docs/compatibility.md`,
          }
        : { status: 'ok', detail: `${describeRoute(result)} (overlay ${layout.overlayPath} applied)` };
    } else {
      route = diverges(result)
        ? {
            status: 'warn',
            detail: `${describeRoute(result)}; run: pi-dsh-bridge install to write an overlay`,
          }
        : { status: 'ok', detail: describeRoute(result) };
    }
    push('dsh-route', 'effective dsh default model matches the required route', route);
  }

  const stateCheck = checkWritable(layout.stateDir);
  const drift = journalCheck(layout, facts.dsh.version);
  push(
    'state',
    'state directory writable and journal current',
    drift ? { status: stateCheck.status === 'fail' ? 'fail' : drift.status, detail: `${stateCheck.detail}; ${drift.detail}` } : stateCheck,
  );

  const ok = !checks.some((check) => check.status === 'fail');
  const versions = { node: process.versions.node, pi: facts.pi.version, dsh: facts.dsh.version };
  const paths = {
    piHome: layout.piHome,
    dshHome: layout.dshHome,
    binDir: layout.binDir,
    stateDir: layout.stateDir,
  };

  if (ui.json) {
    ui.emitJson({ command: 'doctor', ok, versions, paths, checks });
  } else {
    ui.line(`doctor: ${layout.piHome}`);
    for (const check of checks) ui.status(check.status, check.id, check.detail);
    ui.line(ok ? 'doctor: no failures' : 'doctor: at least one check failed');
  }

  return ok ? 0 : 1;
}

export const DOCTOR_HELP = `Usage: pi-dsh-bridge doctor [options]

Cheap, offline health check. Never spends API credit and never prints a
credential value, only whether one is present.

  --json               machine-readable output
  --pi-home <dir>      default $PI_HOME or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi model to verify, default ${DEFAULT_MODEL}
  --provider <id>      Pi provider to verify, default ${DEFAULT_PROVIDER}
`;
