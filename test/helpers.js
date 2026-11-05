import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..');
export const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');

/** Deterministic YAML tree a real `dsh --profile web --dump-config` prints. */
export const DUMP_CONFIG = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: agent-tools
  config:
    enabled: true
`;

const FAKE_PI = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "\${FAKE_PI_VERSION:-1.4.0}"
  exit 0
fi
printf 'pi stub: %s\\n' "$*"
exit 0
`;

const FAKE_DSH = `#!/bin/sh
# Fake dsh: --version prints a version, --profile web --dump-config prints a
# deterministic YAML tree, and --patch <file> is accepted (an existing overlay
# replaces the default model the way the real dsh does).
version="\${FAKE_DSH_VERSION:-0.2.1-rc.5}"
provider="\${FAKE_DSH_PROVIDER:-deepseek-account}"
model="\${FAKE_DSH_MODEL:-deepseek-flash}"

patch=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--patch" ]; then patch="$arg"; fi
  prev="$arg"
done
if [ -n "$patch" ] && [ -f "$patch" ]; then
  # The effective route reflects the overlay, the way the real dsh does.
  patched_provider="$(grep -m1 'provider:' "$patch" | sed 's/.*provider:[[:space:]]*//' | tr -d '"\r')"
  patched_model="$(grep -m1 'model:' "$patch" | sed 's/.*model:[[:space:]]*//' | tr -d '"\r')"
  [ -n "$patched_provider" ] && provider="$patched_provider"
  [ -n "$patched_model" ] && model="$patched_model"
fi

for arg in "$@"; do
  case "$arg" in
    --version|-V)
      printf '%s\\n' "$version"
      exit 0
      ;;
    --dump-config)
      printf -- '- id: agent-default-model\\n  name: "@deepseek-ai/dsh-agent-default-model"\\n  config:\\n    provider: %s\\n    model: %s\\n- id: agent-tools\\n  config:\\n    enabled: true\\n' "$provider" "$model"
      exit 0
      ;;
  esac
done

printf 'dsh stub: %s\\n' "$*"
exit 0
`;

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/**
 * Hermetic sandbox: temp root with pi-home/, dsh-home/, bin/, state/ and a
 * fakebin/ holding a fake `pi` and fake `dsh`. Nothing outside the temp root
 * is ever read or written.
 */
export function createSandbox(options = {}) {
  const {
    settings = null,
    auth = null,
    withPi = true,
    withDsh = true,
    precreate = true,
  } = options;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dsh-bridge-test-'));
  const dirs = {
    root,
    piHome: path.join(root, 'pi-home'),
    dshHome: path.join(root, 'dsh-home'),
    binDir: path.join(root, 'bin'),
    stateDir: path.join(root, 'state'),
    fakebin: path.join(root, 'fakebin'),
  };

  for (const dir of [dirs.piHome, dirs.dshHome, dirs.binDir, dirs.stateDir, dirs.fakebin]) {
    if (precreate) fs.mkdirSync(dir, { recursive: true });
  }
  if (!precreate) fs.mkdirSync(dirs.fakebin, { recursive: true });

  if (withPi) writeExecutable(path.join(dirs.fakebin, 'pi'), FAKE_PI);
  if (withDsh) writeExecutable(path.join(dirs.fakebin, 'dsh'), FAKE_DSH);

  // A PATH that has dsh but not pi, for the "pi missing" doctor case.
  const dshOnlyBin = path.join(root, 'dsh-only-bin');
  fs.mkdirSync(dshOnlyBin, { recursive: true });
  if (withDsh) writeExecutable(path.join(dshOnlyBin, 'dsh'), FAKE_DSH);

  const sandbox = { ...dirs, dshOnlyBin };

  if (settings !== null) setSettings(sandbox, settings);
  if (auth !== null) setAuth(sandbox, auth);

  return sandbox;
}

export function cleanupSandbox(sandbox) {
  fs.rmSync(sandbox.root, { recursive: true, force: true });
}

export function settingsPath(sandbox) {
  return path.join(sandbox.piHome, 'settings.json');
}

export function authPath(sandbox) {
  return path.join(sandbox.piHome, 'auth.json');
}

export function journalPath(sandbox) {
  return path.join(sandbox.stateDir, 'journal.json');
}

export function launcherPath(sandbox) {
  return path.join(sandbox.dshHome, 'start-web.sh');
}

export function wrapperPath(sandbox) {
  return path.join(sandbox.binDir, 'pi-deepseek');
}

export function overlayPath(sandbox) {
  return path.join(sandbox.stateDir, 'dsh-overlay.yml');
}

/** Write settings.json verbatim (string) or as 2-space JSON (object). */
export function setSettings(sandbox, value) {
  fs.mkdirSync(sandbox.piHome, { recursive: true });
  const raw = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(settingsPath(sandbox), raw);
  return raw;
}

export function setAuth(sandbox, value) {
  fs.mkdirSync(sandbox.piHome, { recursive: true });
  const raw = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(authPath(sandbox), raw);
  return raw;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function sandboxEnv(sandbox, extra = {}) {
  return {
    PATH: sandbox.fakebin,
    HOME: sandbox.root,
    PI_HOME: sandbox.piHome,
    DSH_HOME: sandbox.dshHome,
    BIN_DIR: sandbox.binDir,
    STATE_DIR: sandbox.stateDir,
    NO_COLOR: '1',
    ...extra,
  };
}

/** Invoke bin/cli.js inside the sandbox and return {status, stdout, stderr}. */
export function run(args, sandbox, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: sandbox.root,
    env: sandboxEnv(sandbox, extra.env),
    timeout: 30_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Invoke bin/cli.js with custom stdin and return {status, stdout, stderr}. */
export function runWithStdin(args, sandbox, stdin = '', extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: sandbox.root,
      env: sandboxEnv(sandbox, extra.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Give the child a moment to print the prompt before sending input
    setTimeout(() => {
      child.stdin.end(stdin);
    }, 500);
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (d) => { stdoutData += d; });
    child.stderr.on('data', (d) => { stderrData += d; });
    child.on('close', (code) => resolve({ status: code, stdout: stdoutData, stderr: stderrData }));
    child.on('error', (err) => resolve({ status: 1, stdout: '', stderr: err.message }));
  });
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Content snapshot of a directory tree: relative path -> sha256 of its bytes.
 * Directories (even empty ones) are recorded as "<dir>/" so a dry run that
 * creates a directory is caught too.
 */
export function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, 'dir');
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out.set(rel, `symlink:${fs.readlinkSync(full)}`);
      } else {
        out.set(rel, hashFile(full));
      }
    }
  };
  walk(root);
  return out;
}

export function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

/** Relative paths present in `a` but not in `b`, for readable assertions. */
export function snapshotDiff(a, b) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of a.keys()) {
    if (!b.has(key)) removed.push(key);
    else if (b.get(key) !== a.get(key)) changed.push(key);
  }
  for (const key of b.keys()) {
    if (!a.has(key)) added.push(key);
  }
  return { added, removed, changed };
}

export function listFiles(root) {
  return [...snapshotTree(root).keys()].filter((key) => !key.endsWith('/')).sort();
}

/** A fake stdout that records what a user would see. */
export function recorder({ isTTY = false, columns = 80 } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns,
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}
