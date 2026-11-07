import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The floor `@deepseek-ai/dsh` declares, and this package's own floor. */
export const MIN_NODE_VERSION = '22.19.0';

const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** Extract a version from arbitrary `--version` output. */
export function parseVersion(text) {
  const match = SEMVER.exec(String(text ?? ''));
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return pre ? `${major}.${minor}.${patch}-${pre}` : `${major}.${minor}.${patch}`;
}

function numericParts(version) {
  const match = SEMVER.exec(String(version ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}

/** -1, 0 or 1. Prerelease sorts before the matching release. Invalid input returns -1 so comparisons fail closed. */
export function compareVersions(a, b) {
  const left = numericParts(a);
  const right = numericParts(b);
  if (!left || !right) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  if (left[3] === right[3]) return 0;
  if (left[3] === '') return 1;
  if (right[3] === '') return -1;
  return left[3] < right[3] ? -1 : 1;
}

export function isNodeSupported(version = process.versions.node) {
  return compareVersions(version, MIN_NODE_VERSION) >= 0;
}

export function nodeCheck(version = process.versions.node) {
  const parsed = parseVersion(version);
  const shown = parsed ?? String(version);
  if (!parsed) {
    return { status: 'fail', detail: `${shown} is not a parsable version` };
  }
  if (isNodeSupported(version)) {
    return { status: 'ok', detail: `${shown} (>= ${MIN_NODE_VERSION})` };
  }
  return {
    status: 'fail',
    detail: `${shown} is below the required ${MIN_NODE_VERSION}`,
  };
}

/** PATH lookup without dependencies; honours X_OK, never shells out. */
export function findExecutable(name, env = process.env) {
  if (name.includes(path.sep)) {
    return isExecutable(name) ? name : null;
  }
  const searchPath = env.PATH ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(candidate) {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnErrorMessage(program, error) {
  const code = error?.code ? String(error.code) : null;
  const detail = error?.message ? String(error.message) : String(error);
  const reason = code && !detail.includes(code) ? `${code}: ${detail}` : detail;
  const permissionProblem = code === 'EACCES' || code === 'EPERM' || /permission denied/i.test(reason);
  const advice = permissionProblem
    ? 'Check the file permissions and run chmod +x to make it executable.'
    : 'Check that the program exists and can be executed.';
  return `Could not execute ${program}: ${reason}. ${advice}`;
}

/**
 * Locate a command and read its version.
 * Returns { found, path, version, raw, error, signal }.
 */
export function probeCommand(
  name,
  { env = process.env, args = ['--version'], timeout = 15_000, spawn = spawnSync } = {},
) {
  const resolvedPath = findExecutable(name, env);
  if (!resolvedPath) {
    return { found: false, path: null, version: null, raw: null, error: null, signal: null };
  }

  let result;
  try {
    result = spawn(resolvedPath, args, { encoding: 'utf8', env, timeout });
  } catch (error) {
    return {
      found: true,
      path: resolvedPath,
      version: null,
      raw: null,
      error: spawnErrorMessage(resolvedPath, error),
      signal: null,
    };
  }

  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const signal = result.signal ?? null;
  if (result.error) {
    return {
      found: true,
      path: resolvedPath,
      version: null,
      raw,
      error: spawnErrorMessage(resolvedPath, result.error),
      signal,
    };
  }
  if (signal) {
    return {
      found: true,
      path: resolvedPath,
      version: parseVersion(raw),
      raw,
      error: `${resolvedPath} was terminated by signal ${signal}`,
      signal,
    };
  }
  if (result.status !== null && result.status !== undefined && result.status !== 0) {
    return {
      found: true,
      path: resolvedPath,
      version: parseVersion(raw),
      raw,
      error: `${resolvedPath} exited with status ${result.status}`,
      signal: null,
    };
  }
  return {
    found: true,
    path: resolvedPath,
    version: parseVersion(raw),
    raw,
    error: null,
    signal: null,
  };
}

/** Node, pi and dsh in one call. Cheap and offline. */
export function preflight({ env = process.env } = {}) {
  return {
    node: process.versions.node,
    pi: probeCommand('pi', { env }),
    dsh: probeCommand('dsh', { env }),
  };
}
