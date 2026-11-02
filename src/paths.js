import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Required Pi default route (contract, not configurable). */
export const DEFAULT_PROVIDER = 'deepseek';
export const DEFAULT_MODEL = 'deepseek-flash';

const here = path.dirname(fileURLToPath(import.meta.url));

export function packageRoot() {
  return path.resolve(here, '..');
}

export function assetPath(name) {
  return path.join(packageRoot(), 'assets', name);
}

/** The version this CLI reports. Read from the manifest, never hardcoded. */
export function packageVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
  return manifest.version;
}

function expandTilde(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function resolveOne(flagValue, envValue, fallback, home) {
  const raw = flagValue ?? envValue;
  if (raw === undefined || raw === null || raw === '') return path.resolve(fallback);
  return path.resolve(expandTilde(String(raw), home));
}

/**
 * Resolve every path the CLI touches. Precedence: flag, then environment
 * variable, then a portable default under the user's home directory.
 *
 * No locale-specific directories are ever used: the dsh workspace default is
 * `$DSH_HOME/workspace`, resolved by the launcher, not a translated
 * "Documents" folder.
 */
export function resolveLayout({ flags = {}, env = {}, home = os.homedir() } = {}) {
  // Pi reads its own configuration from `$PI_CODING_AGENT_DIR` and falls back
  // to `~/.pi/agent`. This CLI must write to the *same* directory Pi reads,
  // or the bridge silently configures a home Pi never looks at. `PI_HOME`
  // stays supported as an alias because the installer feature and its docs
  // already use it, but Pi's own variable wins so the two can never diverge.
  const piHome = resolveOne(
    flags.piHome,
    env.PI_CODING_AGENT_DIR ?? env.PI_HOME,
    path.join(home, '.pi', 'agent'),
    home,
  );
  const dshHome = resolveOne(flags.dshHome, env.DSH_HOME, path.join(home, '.dsh'), home);
  const binDir = resolveOne(flags.binDir, env.BIN_DIR, path.join(home, '.local', 'bin'), home);
  const stateDir = resolveOne(
    flags.stateDir,
    env.STATE_DIR,
    path.join(home, '.local', 'state', 'pi-dsh-bridge'),
    home,
  );

  return {
    piHome,
    dshHome,
    binDir,
    stateDir,
    settingsPath: path.join(piHome, 'settings.json'),
    authPath: path.join(piHome, 'auth.json'),
    modelsPath: path.join(piHome, 'models.json'),
    credentialsPath: path.join(dshHome, '.credentials.yaml'),
    launcherPath: path.join(dshHome, 'start-web.sh'),
    wrapperPath: path.join(binDir, 'pi-deepseek'),
    tokenHelperPath: path.join(binDir, 'pi-dsh-token'),
    journalPath: path.join(stateDir, 'journal.json'),
    overlayPath: path.join(stateDir, 'dsh-overlay.yml'),
    backupsDir: path.join(stateDir, 'backups'),
  };
}
