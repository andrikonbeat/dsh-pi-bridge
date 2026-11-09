import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../paths.js';
import { checkDshPresetCompatibility, checkDshVersion } from '../compat.js';
import { describeRoute, diverges, probe, readEffectiveDefaultModel } from '../dsh.js';
import { nodeCheck, preflight } from '../preflight.js';
import { loadSettings, settingsMismatch } from '../settings.js';
import { grantState } from '../dsh-account.js';
import { readStoredApiKey } from '../pi-auth.js';
import { ACCOUNT_TOKEN_HEADER, SHARED_PROVIDER_ID } from '../bridge-protocol.js';
import { isSharedProvider, loadModels, programFromCommand } from '../models.js';
import { tokenProgram } from '../token-helper.js';
import { JournalError, readJournal } from '../journal.js';

function readIfExists(file) {
  try {
    const stats = fs.statSync(file);
    return { exists: true, mode: stats.mode & 0o777, size: stats.size, text: fs.readFileSync(file, 'utf8') };
  } catch {
    return { exists: false, mode: null, size: 0, text: '' };
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

/**
 * The stored DeepSeek API key: the fallback route.
 *
 * Three states, never two. A key that is merely present is reported as
 * present and *not* as working, because a key on an account with no credit
 * is present and fails every request with 402. Only `verify`, which talks to
 * the API, can prove the balance.
 */
function credentialCheck(authPath, env) {
  if (typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.length > 0) {
    return {
      status: 'warn',
      detail:
        'present in the environment (DEEPSEEK_API_KEY); balance not checked offline — a key with ' +
        'no credit fails every request (402). Run: pi-dsh-bridge verify --yes',
    };
  }
  const stored = readStoredApiKey(authPath);
  if (stored.state === 'absent') {
    return {
      status: 'warn',
      detail:
        `${stored.detail}; the API-key fallback route is unavailable. ` +
        'Run /login inside Pi and choose DeepSeek to store an API key',
    };
  }
  if (stored.state === 'unusable') {
    return { status: 'warn', detail: `${stored.detail}; the API-key fallback route is unavailable` };
  }
  return {
    status: 'warn',
    detail:
      `${stored.detail}; balance not checked offline — a key with no credit fails every request ` +
      '(402). Run: pi-dsh-bridge verify --yes',
  };
}

/**
 * The dsh account grant: the route the bridge actually uses.
 *
 * `absent` means there is nothing to use and signing in fixes it;
 * `present-but-unusable` means something is there but broken, which is a
 * different problem with a different fix.
 */
function grantCheck(credentialsPath) {
  const state = grantState(credentialsPath);
  const detail = state.detail.replace(/\.\s*$/, '');
  if (state.state === 'usable') {
    return { status: 'ok', detail: `usable: ${detail}` };
  }
  if (state.state === 'absent') {
    return {
      status: 'warn',
      detail: `absent: ${detail}. The bridge stays inactive; the API-key route keeps working`,
    };
  }
  return {
    status: 'fail',
    detail: `present but unusable: ${detail}. Run: pi-dsh-bridge sync`,
  };
}

/**
 * Is Pi actually wired to the shared account?
 *
 * A credential that cannot be read is one failure; a credential that is read
 * but never handed to Pi is another. The bridge is only working when both
 * halves are true: the provider carries the account header, and the program
 * that header points at exists and can run.
 */
function bridgeCheck(layout, cliPath) {
  let models;
  try {
    models = loadModels(layout.modelsPath);
  } catch (error) {
    return { status: 'fail', detail: error.message };
  }
  if (!models.exists) {
    return {
      status: 'warn',
      detail: `${layout.modelsPath} does not exist; run: pi-dsh-bridge sync`,
    };
  }
  const provider = models.data?.providers?.[SHARED_PROVIDER_ID];
  if (!provider) {
    return {
      status: 'warn',
      detail: `no ${SHARED_PROVIDER_ID} provider in ${layout.modelsPath}; run: pi-dsh-bridge sync`,
    };
  }
  if (!isSharedProvider(provider)) {
    return {
      status: 'warn',
      detail:
        `the ${SHARED_PROVIDER_ID} provider is not wired to the dsh account; ` +
        'run: pi-dsh-bridge sync',
    };
  }
  const program = programFromCommand(provider.headers?.[ACCOUNT_TOKEN_HEADER]);
  if (!program) {
    return {
      status: 'warn',
      detail: `the ${SHARED_PROVIDER_ID} provider does not carry a runnable account command; run: pi-dsh-bridge sync`,
    };
  }
  if (!isExecutableFile(program)) {
    return {
      status: 'fail',
      detail: `the account-token program ${program} is missing or not executable; run: pi-dsh-bridge install`,
    };
  }
  const expected = tokenProgram({ layout, cliPath });
  if (program !== expected && program !== layout.tokenHelperPath && program !== cliPath) {
    return {
      status: 'warn',
      detail:
        `the ${SHARED_PROVIDER_ID} provider runs ${program}; run: pi-dsh-bridge sync to use ${expected}`,
    };
  }
  return { status: 'ok', detail: `${SHARED_PROVIDER_ID} -> shared dsh account via ${program}` };
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
export function doctor({ options = {}, ui, layout, env = process.env, cliPath }) {
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

  // A dsh outside the matrix is untested, not broken. A dsh that cannot
  // mount an agent preset is broken: the web panel opens and then refuses
  // every new session, which reads like a bridge bug and is not one.
  push(
    'dsh-preset',
    'agent presets can mount (new sessions start)',
    !facts.dsh.found
      ? {
          status: 'warn',
          detail: 'dsh not found; the agent preset compatibility was not checked',
        }
      : checkDshPresetCompatibility(facts.dsh.version),
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
    'DeepSeek API key (fallback route) — presence is not working',
    credentialCheck(layout.authPath, env),
  );

  push(
    'dsh-account',
    'dsh account grant — the route the bridge uses',
    grantCheck(layout.credentialsPath),
  );

  push(
    'bridge',
    'Pi is wired to the shared dsh account',
    bridgeCheck(layout, cliPath),
  );

  push(
    'token-helper',
    'account-token helper installed and executable',
    isExecutableFile(layout.tokenHelperPath)
      ? { status: 'ok', detail: layout.tokenHelperPath }
      : readIfExists(layout.tokenHelperPath).exists
        ? { status: 'warn', detail: `${layout.tokenHelperPath} is not executable; run: pi-dsh-bridge install` }
        : { status: 'warn', detail: `${layout.tokenHelperPath} is missing; run: pi-dsh-bridge install` },
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
    // The panel does not mount the overlay alone: the launcher passes the
    // route it chose after it, so the route the panel runs on is the one in
    // both. Probing the overlay on its own reports a route the panel never
    // mounts.
    const routePatchExists = readIfExists(layout.routePatchPath).exists;
    const patches = [overlayExists ? layout.overlayPath : null, routePatchExists ? layout.routePatchPath : null]
      .filter(Boolean);
    const result = probe({ dshPath: facts.dsh.path, env, patchPaths: patches });
    let route;
    if (!result.ok) {
      route = { status: 'warn', detail: `config probe failed: ${result.error}` };
    } else if (routePatchExists) {
      const chosen = readEffectiveDefaultModel(readIfExists(layout.routePatchPath).text ?? '');
      const mounted = chosen && chosen.provider ? chosen : null;
      route = mounted && (result.provider !== mounted.provider || result.model !== mounted.model)
        ? {
            status: 'warn',
            detail:
              `the panel mounts ${describeRoute({ ok: true, ...mounted })} but the effective route is ` +
              `${describeRoute(result)}; see docs/compatibility.md`,
          }
        : {
            status: 'ok',
            detail: `${describeRoute(result)} (the route the panel mounts; ${layout.routePatchPath})`,
          };
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
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi model to verify, default ${DEFAULT_MODEL}
  --provider <id>      Pi provider to verify, default ${DEFAULT_PROVIDER}
`;
