import fs from 'node:fs';
import path from 'node:path';

import { ACCOUNT_TOKEN_HEADER, GRANT_RECORD_KEY } from './bridge-protocol.js';

export { ACCOUNT_TOKEN_HEADER, GRANT_RECORD_KEY };

/**
 * Why a grant could not be read.
 *
 * The distinction matters to the user: a missing credential is fixed by
 * signing in, while a malformed one means the dsh format changed. Reporting
 * "present but unusable" for both would hide the real problem.
 */
export const GRANT_ERROR_CODES = {
  MISSING_FILE: 'missing-file',
  MISSING_RECORD: 'missing-record',
  WRONG_KIND: 'wrong-kind',
  NO_TOKEN: 'no-token',
  UNREADABLE: 'unreadable',
  UNPARSABLE: 'unparsable',
};

/**
 * The dsh account grant, read from the credentials file dsh writes when the
 * user signs in to a DeepSeek account in the web interface.
 *
 * This is an internal dsh format with no public API, so the parser is
 * deliberately strict: it looks for exactly one known record key and exactly
 * the two fields it needs. Anything unexpected is an error, never a guess.
 * A wrong guess here would send a broken credential to the API and produce a
 * confusing 401 instead of an honest message.
 */

export class GrantError extends Error {
  constructor(message, { cause, code = GRANT_ERROR_CODES.UNREADABLE } = {}) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Parse the small, fixed subset of YAML that `.credentials.yaml` uses.
 *
 * The file is a map of record keys to `kind`/`payload` pairs with scalar
 * values. It is parsed by hand rather than with a YAML library because this
 * package has zero runtime dependencies, and because a strict parser that
 * understands only what we need cannot be fooled by unexpected structure.
 */
export function parseCredentialsYaml(text) {
  const root = {};
  const lines = text.split('\n');

  // Records live under `records:` and are keyed by an indented path.
  const records = {};
  let inRecords = false;
  let currentKey = null;
  let currentSection = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (indent === 0) {
      inRecords = line === 'records:';
      currentKey = null;
      currentSection = null;
      continue;
    }
    if (!inRecords) continue;

    // "  some/key:" — a record key.
    if (indent === 2 && line.endsWith(':')) {
      currentKey = line.slice(0, -1);
      records[currentKey] = {};
      currentSection = null;
      continue;
    }
    if (currentKey === null) continue;

    // "    payload:" opens a nested section; "    kind: grant" is a scalar.
    if (indent === 4) {
      if (line.endsWith(':')) {
        currentSection = line.slice(0, -1);
        records[currentKey][currentSection] ??= {};
        continue;
      }
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!match) continue;
      currentSection = null;
      records[currentKey][match[1]] = unquote(match[2]);
      continue;
    }

    // "      token: value" inside the section opened above.
    if (indent >= 6 && currentSection) {
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!match) continue;
      records[currentKey][currentSection] ??= {};
      records[currentKey][currentSection][match[1]] = unquote(match[2]);
    }
  }

  root.records = records;
  return root;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The account grant, or a GrantError explaining precisely what is wrong.
 *
 * Returns `{ token, issuer }`. The token is never logged or printed by this
 * package; callers pass it straight to the API.
 */
export function readAccountGrant(credentialsPath = defaultCredentialsPath()) {
  let text;
  try {
    text = fs.readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new GrantError(
        `no dsh credentials file at ${credentialsPath}. Sign in to DeepSeek in the dsh web ` +
          'interface first, then run "pi-dsh-bridge sync".',
        { code: GRANT_ERROR_CODES.MISSING_FILE },
      );
    }
    throw new GrantError(`cannot read ${credentialsPath}: ${error.message}`, {
      cause: error,
      code: GRANT_ERROR_CODES.UNREADABLE,
    });
  }

  let parsed;
  try {
    parsed = parseCredentialsYaml(text);
  } catch (error) {
    throw new GrantError(`cannot parse ${credentialsPath}: ${error.message}`, {
      cause: error,
      code: GRANT_ERROR_CODES.UNPARSABLE,
    });
  }

  const record = parsed.records?.[GRANT_RECORD_KEY];
  if (!record) {
    const available = Object.keys(parsed.records ?? {});
    throw new GrantError(
      `${credentialsPath} has no "${GRANT_RECORD_KEY}" record, so there is no DeepSeek account ` +
        `credential to share. Records found: ${available.length ? available.join(', ') : 'none'}. ` +
        'Sign in to DeepSeek in the dsh web interface and run "pi-dsh-bridge sync" again.',
      { code: GRANT_ERROR_CODES.MISSING_RECORD },
    );
  }
  if (record.kind !== 'grant') {
    throw new GrantError(
      `the "${GRANT_RECORD_KEY}" record in ${credentialsPath} is of kind ` +
        `${JSON.stringify(record.kind ?? null)}, expected "grant". The dsh credentials format may ` +
        'have changed; the shared-account bridge cannot be used until it is understood.',
      { code: GRANT_ERROR_CODES.WRONG_KIND },
    );
  }

  const payload = record.payload ?? {};
  const token = payload.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new GrantError(
      `the "${GRANT_RECORD_KEY}" record in ${credentialsPath} has no token. Sign in to DeepSeek ` +
        'in the dsh web interface and run "pi-dsh-bridge sync" again.',
      { code: GRANT_ERROR_CODES.NO_TOKEN },
    );
  }
  const issuer = typeof payload.issuer === 'string' ? payload.issuer : null;

  return { token, issuer, credentialsPath };
}

/** True when the grant is readable and has a token. Never throws. */
export function accountGrantStatus(credentialsPath = defaultCredentialsPath()) {
  try {
    const grant = readAccountGrant(credentialsPath);
    return { ok: true, token: grant.token, issuer: grant.issuer, error: null, code: null };
  } catch (error) {
    const code = error instanceof GrantError ? error.code : GRANT_ERROR_CODES.UNREADABLE;
    return { ok: false, token: null, issuer: null, error: error.message, code };
  }
}

/**
 * The grant as one of the three states every credential check reports:
 * `absent` (nothing to use), `present-but-unusable` (something is there but
 * cannot be used) or `usable`.
 *
 * "Present" is never promoted to "usable" on the strength of the file alone:
 * only `verify`, which talks to the API, can prove a credential still works.
 */
export function grantState(credentialsPath = defaultCredentialsPath()) {
  const status = accountGrantStatus(credentialsPath);
  if (status.ok) {
    return { state: 'usable', detail: status.issuer ? `account grant from ${status.issuer}` : 'account grant present', issuer: status.issuer };
  }
  const absent = status.code === GRANT_ERROR_CODES.MISSING_FILE || status.code === GRANT_ERROR_CODES.MISSING_RECORD;
  return {
    state: absent ? 'absent' : 'present-but-unusable',
    detail: status.error,
    issuer: null,
  };
}

export function defaultCredentialsPath(home = process.env.HOME) {
  return path.join(home ?? '', '.dsh', '.credentials.yaml');
}
