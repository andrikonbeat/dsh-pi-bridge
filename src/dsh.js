import { spawnSync } from 'node:child_process';

/**
 * The route the `web` profile must compose with (contract, not configurable).
 *
 * `deepseek-account` is the account route: it spends the same wallet the dsh
 * web interface is signed in to, which is the whole point of the bridge.
 * `deepseek-official` is the API-key route and is a different wallet.
 */
export const REQUIRED_PROVIDER = 'deepseek-account';
export const REQUIRED_MODEL = 'deepseek-flash';

export class DshError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DshError';
  }
}

const PROFILE = 'web';

/**
 * Compose the effective config without booting anything:
 * `dsh --profile web --dump-config`, plus `--patch <file>` when an overlay is
 * installed. `--patch` applies after every bundle and after the user layer, and
 * an entry whose `id` already exists replaces it.
 */
export function dumpConfig({ dshPath, env = process.env, patchPath = null, patchPaths = null, timeout = 20_000 }) {
  if (!dshPath) throw new DshError('dsh was not found on PATH');
  const args = ['--profile', PROFILE];
  // Every patch is applied in the order it is given, and the last one wins:
  // the launcher passes the overlay first and the route it chose last, so
  // the effective route is the one the panel mounts.
  const patches = patchPaths ?? (patchPath ? [patchPath] : []);
  for (const file of patches) args.push('--patch', file);
  args.push('--dump-config');
  const result = spawnSync(dshPath, args, { encoding: 'utf8', env, timeout });
  if (result.error) {
    throw new DshError(`could not run dsh: ${result.error.message}`);
  }
  const stdout = result.stdout ?? '';
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n')[0] || `exit ${result.status}`;
    throw new DshError(`dsh --profile ${PROFILE} --dump-config failed: ${detail}`);
  }
  if (!stdout.trim()) {
    throw new DshError('dsh --profile web --dump-config printed nothing');
  }
  return stdout;
}

/**
 * The id a patch/bundle entry line declares, or null when the line is not one.
 *
 * A trailing `#` comment after the value is not part of the id, and a
 * commented-out entry never declares anything: only `id:` at the start of a
 * line (after an optional list marker) counts.
 */
function idOnLine(line) {
  const match = /^\s*(?:-\s*)?id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * The block belonging to one patch/bundle entry, as raw lines.
 *
 * The winning entry is the last one whose `id` matches, not the first: dsh
 * applies every overlay after the bundles and after the user layer, and an
 * entry whose id already exists replaces it. Reading the first match would
 * report the entry the overlay was written to replace.
 */
function blockLines(document, id) {
  const lines = document.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (idOnLine(lines[index]) === id) start = index;
  }
  if (start === -1) return null;
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^-\s/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block;
}

function fieldValue(block, key) {
  for (const line of block) {
    const match = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*["']?([^"'#\\s]+)["']?`).exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read `provider`/`model` out of the `agent-default-model` entry. Returns
 * { provider, model } or null when the entry is missing.
 */
export function readEffectiveDefaultModel(document) {
  const block = blockLines(document, 'agent-default-model');
  if (!block) return null;
  return { provider: fieldValue(block, 'provider'), model: fieldValue(block, 'model') };
}

/**
 * Probe the effective route. Never throws: a broken probe is data, not an
 * exception, so `doctor` and `install` can report it.
 *
 * Fails closed. An `agent-default-model` entry that exists but names no
 * provider or no model is not a route this bridge can compare against, and
 * reporting it as `ok` would let every caller print a placeholder instead of
 * the reason.
 *
 * Returns { ok, provider, model, raw, error }.
 */
export function probe({ dshPath, env = process.env, patchPath = null, patchPaths = null }) {
  try {
    const raw = dumpConfig({ dshPath, env, patchPath, patchPaths });
    const effective = readEffectiveDefaultModel(raw);
    if (!effective) {
      return {
        ok: false,
        provider: null,
        model: null,
        raw,
        error: 'the effective config has no agent-default-model entry',
      };
    }
    if (!effective.provider) {
      return {
        ok: false,
        provider: null,
        model: null,
        raw,
        error: 'the effective config has no agent-default-model provider',
      };
    }
    if (!effective.model) {
      return {
        ok: false,
        provider: null,
        model: null,
        raw,
        error: 'the effective config has no agent-default-model model',
      };
    }
    return { ok: true, provider: effective.provider, model: effective.model, raw, error: null };
  } catch (error) {
    return { ok: false, provider: null, model: null, raw: null, error: error.message };
  }
}

/** True when the effective default model is not the required route. */
export function diverges(result, { provider = REQUIRED_PROVIDER, model = REQUIRED_MODEL } = {}) {
  if (!result.ok) return false;
  return result.provider !== provider || result.model !== model;
}

/**
 * One line describing a probe result.
 *
 * A successful probe always carries both values, so a result missing one is
 * not described with a `?` placeholder: it is unknown, and says so.
 */
export function describeRoute(result) {
  if (!result.ok || !result.provider || !result.model) return 'unknown';
  return `provider: ${result.provider}, model: ${result.model}`;
}
