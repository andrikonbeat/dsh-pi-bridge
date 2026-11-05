import fs from 'node:fs';
import path from 'node:path';

import {
  ACCOUNT_TOKEN_HEADER,
  DEEPSEEK_API,
  DEEPSEEK_BASE_URL,
  SHARED_ACCOUNT_PLACEHOLDER,
  SHARED_PROVIDER_ID,
} from './bridge-protocol.js';

export {
  ACCOUNT_TOKEN_HEADER,
  DEEPSEEK_API,
  DEEPSEEK_BASE_URL,
  SHARED_ACCOUNT_PLACEHOLDER,
  SHARED_PROVIDER_ID,
};

/**
 * The shared-account provider written into Pi's `models.json`.
 *
 * Pi resolves a `!command` header value by running it through the shell and
 * using its stdout, caching the result for the life of that Pi process only.
 * That gives the property the bridge needs: the token is read fresh every
 * time Pi starts, so signing in to a different DeepSeek account in the dsh
 * web interface changes the account Pi uses on the next start, with nothing
 * to copy and no secret stored in a second file.
 *
 * Two facts about DeepSeek shape this file, both measured against the live
 * API rather than assumed:
 *
 *   - the account token is accepted only in the `x-dsh-auth-token` header;
 *     as `Authorization: Bearer` it is rejected with 401;
 *   - a non-empty but invalid `x-dsh-auth-token` fails the request with 401
 *     and no fallback, so the command behind it must never print a
 *     placeholder or an empty string.
 */

export class ModelsParseError extends Error {
  constructor(file, cause) {
    super(
      `${file} is not valid JSON (${cause}). Refusing to write: fix or remove it first, ` +
        'nothing was changed.',
    );
    this.name = 'ModelsParseError';
    this.file = file;
  }
}

/**
 * The file parses as JSON but does not have the shape Pi expects.
 *
 * Kept distinct from `ModelsParseError` because the fix is different: the
 * JSON is fine, the `providers` key inside it is not.
 */
export class ModelsShapeError extends Error {
  constructor(file, detail) {
    super(
      `${file} has an unexpected shape: ${detail}. Refusing to write: fix or remove it first, ` +
        'nothing was changed.',
    );
    this.name = 'ModelsShapeError';
    this.file = file;
  }
}

/**
 * POSIX single-quote a string for safe shell interpolation.
 *
 * Every character is literal inside single quotes except the single quote
 * itself, which is escaped by ending the quote, adding an escaped quote,
 * and reopening: `'"'"'`.
 */
function shellQuote(str) {
  return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * The command Pi runs to obtain the account token.
 *
 * It prints the token and nothing else. Any diagnostic goes to stderr so it
 * can never corrupt the value.
 *
 * `program` is an absolute path: Pi runs the command with the user's project
 * as its working directory, and the path must survive an `npx` cache clean.
 *
 * Every argument is POSIX single-quoted so that $, backticks, spaces, quotes,
 * newlines, and other shell metacharacters are literal.
 */
export function tokenCommand({ program, dshHome }) {
  const args = [program, 'token', '--dsh-home', dshHome];
  return `!${args.map(shellQuote).join(' ')}`;
}

/**
 * The provider entry that replaces the built-in `deepseek` one.
 *
 * `authHeader: false` stops Pi from adding its own `Authorization` header.
 * It does not stop the OpenAI-compatible SDK from sending one when a stored
 * credential exists, so a stale API key may still travel alongside the
 * account token; DeepSeek ignores it while the account token is valid.
 *
 * `apiKey` is required — Pi refuses to register a provider with no
 * authentication method at all — but it is not a credential: it never
 * authorises anything, because the header does.
 *
 * The entry deliberately carries no `models` list. Pi then keeps the models
 * of the built-in DeepSeek provider (`deepseek-flash`, `deepseek-v4-pro`) and
 * only overrides where they are served from, which is what lets the account
 * route serve both.
 */
export function sharedProvider({ program, dshHome }) {
  return {
    name: 'DeepSeek (shared dsh account)',
    baseUrl: DEEPSEEK_BASE_URL,
    api: DEEPSEEK_API,
    authHeader: false,
    apiKey: SHARED_ACCOUNT_PLACEHOLDER,
    headers: {
      [ACCOUNT_TOKEN_HEADER]: tokenCommand({ program, dshHome }),
    },
  };
}

/** Raw bytes, or null when the file does not exist. */
export function readModelsRaw(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Strip a leading UTF-8 BOM if present. */
function stripBom(text) {
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

export function parseModels(raw, file) {
  let data;
  try {
    const text = stripBom(raw.toString('utf8'));
    data = JSON.parse(text);
  } catch (error) {
    throw new ModelsParseError(file, error.message);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ModelsParseError(file, 'expected a JSON object at the top level');
  }
  return data;
}

/** { exists, raw: Buffer|null, data: object|null } — throws ModelsParseError. */
export function loadModels(file) {
  const raw = readModelsRaw(file);
  if (raw === null) return { exists: false, raw: null, data: null };
  const data = parseModels(raw, file);
  const providers = data.providers;
  if (providers !== undefined && providers !== null) {
    if (Array.isArray(providers)) {
      throw new ModelsShapeError(file, '`providers` must be an object, not an array');
    }
    if (typeof providers !== 'object') {
      throw new ModelsShapeError(
        file,
        `\`providers\` must be an object, not ${typeof providers}`,
      );
    }
  }
  return { exists: true, raw, data };
}

/**
 * The warning the install plan carries when the `deepseek` entry on disk is
 * the user's own rather than the one this bridge writes.
 *
 * Replacing it silently would throw away a provider someone configured by
 * hand — a different base URL, a different model list, an API key. The bridge
 * still needs its own entry to route through the account, so the two fields
 * that describe what the user meant are carried over and the fact is reported.
 */
export const SHARED_PROVIDER_WARNING =
  'the existing "deepseek" provider is not the one this bridge writes; its `models` and `name` are preserved';

/**
 * Write the shared provider, preserving every other provider and every other
 * key in the file. The built-in `deepseek` provider is replaced in place, so
 * its position in the file does not change.
 *
 * Returns `{ merged, existed, warning }`:
 *   - `existed` is true when a `deepseek` entry was already there;
 *   - `warning` is `SHARED_PROVIDER_WARNING` when that entry diverges from the
 *     one this bridge writes, and null otherwise;
 *   - the diverging entry's `name` and `models` are carried into the merged
 *     entry when present, so a hand-written model list still reaches Pi.
 */
export function applySharedProvider(current, provider) {
  const data = current ?? {};
  const providers = { ...(data.providers ?? {}) };
  const existed = Object.prototype.hasOwnProperty.call(providers, SHARED_PROVIDER_ID);
  const existing = existed && providers[SHARED_PROVIDER_ID] && typeof providers[SHARED_PROVIDER_ID] === 'object'
    ? providers[SHARED_PROVIDER_ID]
    : null;
  const diverges = existed && !modelsMatch(data, provider);

  const entry = { ...provider };
  if (existing) {
    if (Object.prototype.hasOwnProperty.call(existing, 'name')) entry.name = existing.name;
    if (Object.prototype.hasOwnProperty.call(existing, 'models')) entry.models = existing.models;
  }
  providers[SHARED_PROVIDER_ID] = entry;
  // Keep the original key order of `providers`: replacing an existing key does
  // not move it, and a new key is appended.
  const merged = { ...data, providers };
  return { merged, existed, warning: diverges ? SHARED_PROVIDER_WARNING : null };
}

/** Two-space JSON with a trailing newline, matching the settings.json format. */
export function renderModels(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * True when the file already carries exactly the shared provider we want.
 * Used to keep repeated installs and syncs from rewriting the file.
 */
export function modelsMatch(current, provider) {
  if (!current) return false;
  const existing = current.providers?.[SHARED_PROVIDER_ID];
  if (!existing) return false;
  return (
    existing.baseUrl === provider.baseUrl &&
    existing.api === provider.api &&
    existing.authHeader === provider.authHeader &&
    existing.apiKey === provider.apiKey &&
    existing.headers?.[ACCOUNT_TOKEN_HEADER] === provider.headers[ACCOUNT_TOKEN_HEADER]
  );
}

/**
 * True when a provider entry is the shared-account one.
 *
 * Used by `doctor` to tell a wired bridge from an unwired one without
 * guessing: the account header must be there and must be a command.
 */
export function isSharedProvider(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry.headers?.[ACCOUNT_TOKEN_HEADER];
  return typeof value === 'string' && value.startsWith('!');
}

/**
 * The program a `!command` header value runs.
 *
 * The command is `<program> token --dsh-home <dir>`. Reading it back is what
 * lets `doctor` check the file the configuration actually points at, instead
 * of the one it merely ought to point at.
 *
 * Two formats are understood, because both exist on disk:
 *
 *   - the current one, where every argument is POSIX single-quoted and an
 *     embedded single quote is escaped as `'"'"'` (close quote, double-quoted
 *     quote, reopen quote);
 *   - the older one, where a path containing whitespace was wrapped in JSON
 *     double quotes and everything else was left bare.
 *
 * The program is the first argument in both cases.
 */
export function programFromCommand(command) {
  if (typeof command !== 'string' || !command.startsWith('!')) return null;
  const rest = command.slice(1);
  if (rest.length === 0) return null;

  if (rest.startsWith("'")) {
    let index = 1;
    let result = '';
    while (index < rest.length) {
      const character = rest[index];
      if (character === "'") {
        // `'"'"'` is five characters: the closing quote of this segment, a
        // double-quoted literal single quote, and the opening quote of the
        // next segment. A bare `'` that is not followed by `"'"` closes the
        // argument.
        if (
          rest[index + 1] === '"' &&
          rest[index + 2] === "'" &&
          rest[index + 3] === '"' &&
          rest[index + 4] === "'"
        ) {
          result += "'";
          index += 5;
          continue;
        }
        return result;
      }
      result += character;
      index += 1;
    }
    return null;
  }

  if (rest.startsWith('"')) {
    // Legacy JSON-quoted form: parse the first double-quoted string.
    let escaped = false;
    for (let index = 1; index < rest.length; index += 1) {
      const character = rest[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(rest.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Bare form: the program is the first whitespace-delimited token.
  const match = rest.match(/^(\S+)/);
  return match ? match[1] : null;
}

/**
 * The models the shared provider must expose.
 *
 * The built-in DeepSeek provider ships `deepseek-flash` and `deepseek-v4-pro`;
 * both are served by the account route, so both stay reachable.
 */
export const DEFAULT_SHARED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

export function modelsFilePath(piHome) {
  return path.join(piHome, 'models.json');
}