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

/**
 * YAML block scalar indicators. A record written as `token: |` carries its
 * value on the following lines, so what the key holds is not a token at all.
 */
const BLOCK_INDICATORS = new Set(['|', '>', '|-', '>-', '|+', '>+']);

/**
 * A token is one non-empty line of printable characters.
 *
 * Anything else — a block indicator, a stray space from a two-column value, a
 * newline from an unescaped quote — is not a credential and must never reach
 * the API, where it would be sent verbatim and fail with a 401 that looks like
 * a wrong account instead of a wrong parser.
 */
function isSingleLineToken(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (BLOCK_INDICATORS.has(value)) return false;
  return !/\s/.test(value);
}

const notASingleLineToken = (credentialsPath) =>
  `the "${GRANT_RECORD_KEY}" record in ${credentialsPath} does not hold a single-line token. ` +
  'The dsh credentials format may have changed; the shared-account bridge cannot be used until it is understood.';

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
 *
 * What dsh actually writes is respected rather than assumed: a UTF-8 BOM, CRLF
 * line endings, a comment after `records:`, tab indentation, a different
 * number of spaces per level, and the same record appearing twice. None of
 * those are reasons to lose a valid grant.
 */
export function parseCredentialsYaml(text) {
  const records = {};

  // Depth is tracked relative to the `records:` line and by level, never by
  // absolute column: a file laid out with four spaces per level parses the
  // same way as one laid out with two.
  let inRecords = false;
  let recordsIndent = -1;
  let keyIndent = null;
  let sectionIndent = null;
  let currentKey = null;
  let currentSection = null;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const source = expandLeadingTabs(rawLine);
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;

    const indent = source.length - source.trimStart().length;

    // `records:` opens (or re-opens) the record map. A comment may follow it.
    if (/^records:\s*(#.*)?$/.test(line)) {
      inRecords = true;
      recordsIndent = indent;
      keyIndent = null;
      sectionIndent = null;
      currentKey = null;
      currentSection = null;
      continue;
    }
    if (!inRecords) continue;

    // Anything at or left of `records:` belongs to the rest of the document.
    if (indent <= recordsIndent) {
      inRecords = false;
      currentKey = null;
      currentSection = null;
      continue;
    }

    // The first child of `records:` defines the record-key level.
    if (keyIndent === null) keyIndent = indent;

    // "  some/key:" — a record key. A repeated key merges into the record
    // already collected instead of replacing it, so a second block that only
    // repeats one field does not erase the others.
    if (indent === keyIndent) {
      const key = parseKeyLine(line);
      if (key === null) continue;
      currentKey = key;
      records[currentKey] ??= {};
      currentSection = null;
      sectionIndent = null;
      continue;
    }

    if (currentKey === null || indent < keyIndent) continue;

    // The first child of a record defines the field level.
    if (sectionIndent === null) sectionIndent = indent;

    // "    payload:" opens a nested map; "    kind: grant" is a scalar field.
    if (indent === sectionIndent) {
      const name = parseKeyLine(line);
      if (name !== null) {
        const existing = records[currentKey][name];
        if (existing === undefined || typeof existing !== 'object' || existing === null) {
          records[currentKey][name] = {};
        }
        currentSection = name;
        continue;
      }
      const field = parseFieldLine(line);
      if (!field) continue;
      currentSection = null;
      records[currentKey][field.name] = field.raw;
      continue;
    }

    // "      token: value" inside the section opened above. Deeper lines are
    // read as fields of that section; a section that is not a map is left as
    // it is so the reader can report it instead of inventing structure.
    if (currentSection === null) continue;
    const section = records[currentKey][currentSection];
    if (typeof section !== 'object' || section === null) continue;
    const field = parseFieldLine(line);
    if (!field) continue;
    section[field.name] = field.raw;
  }

  return { records };
}

/**
 * A line that is only a key: `some/key:`, optionally followed by a comment.
 *
 * Returns the key, or `null` when the line carries a value (which makes it a
 * scalar field, not a nested map).
 */
function parseKeyLine(line) {
  const match = line.match(/^([^:\s][^:]*):(?:\s*(?:#.*)?)$/);
  return match ? match[1].trim() : null;
}

/** A `name: value` line, with the raw value still unparsed. */
function parseFieldLine(line) {
  const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
  return match ? { name: match[1], raw: parseScalar(match[2]) } : null;
}

/** Tabs are valid indentation in a hand-edited file; count them as spaces. */
function expandLeadingTabs(line) {
  const leading = line.match(/^[ \t]+/);
  if (!leading) return line;
  return leading[0].replace(/\t/g, '  ') + line.slice(leading[0].length);
}

/**
 * Read one scalar the way YAML reads it.
 *
 * Only the shapes dsh writes are supported: an unquoted scalar, possibly with
 * a trailing comment, and a single- or double-quoted one. Everything else
 * returns `null`, which means "present but not readable": a caller that needs
 * a token must treat that as unusable rather than guessing at raw bytes.
 */
function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) return parseDoubleQuoted(trimmed);
  if (trimmed.startsWith("'")) return parseSingleQuoted(trimmed);

  // An unquoted scalar ends at a " #" comment. A "#" with no whitespace
  // before it is part of the value, which is also how YAML reads it.
  return trimmed.replace(/(^|\s)#.*$/, '').trim();
}

/** A double-quoted scalar: `\\`, `\"`, `\n` and `\t` are unescaped. */
function parseDoubleQuoted(text) {
  let out = '';
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '\\') out += '\\';
      else if (next === '"') out += '"';
      else if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else return null; // An escape this reader does not know: not readable.
      index += 1;
      continue;
    }
    if (char === '"') {
      // Only a comment may follow the closing quote, as in YAML.
      return /^\s*(#.*)?$/.test(text.slice(index + 1)) ? out : null;
    }
    out += char;
  }
  return null; // Never closed.
}

/** A single-quoted scalar is literal, except that `''` is one quote. */
function parseSingleQuoted(text) {
  let out = '';
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (text[index + 1] === "'") {
        out += "'";
        index += 1;
        continue;
      }
      return /^\s*(#.*)?$/.test(text.slice(index + 1)) ? out : null;
    }
    out += char;
  }
  return null;
}

/**
 * The account grant, or a GrantError explaining precisely what is wrong.
 *
 * Returns `{ token, issuer, credentialsPath }`. The token is never logged or
 * printed by this package; callers pass it straight to the API.
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
    // A file with nothing in it is not the same as a file with no credential
    // for us: the first is present-but-unusable (the file exists, and the user
    // may be looking at a half-written sign-in), the second is our record
    // missing from records dsh does write.
    if (available.length === 0) {
      const reason = text.trim().length === 0 ? 'is empty' : 'has no records';
      throw new GrantError(
        `${credentialsPath} ${reason}, so there is no DeepSeek account credential to share. ` +
          'Sign in to DeepSeek in the dsh web interface and run "pi-dsh-bridge sync" again.',
        { code: GRANT_ERROR_CODES.UNPARSABLE },
      );
    }
    throw new GrantError(
      `${credentialsPath} has no "${GRANT_RECORD_KEY}" record, so there is no DeepSeek account ` +
        `credential to share. Records found: ${available.join(', ')}. ` +
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

  const payload = record.payload;
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new GrantError(
      `the "${GRANT_RECORD_KEY}" record in ${credentialsPath} does not hold a map payload. ` +
        'The dsh credentials format may have changed; the shared-account bridge cannot be used until it is understood.',
      { code: GRANT_ERROR_CODES.UNPARSABLE },
    );
  }

  const token = payload?.token;
  // `null` means the scalar was there but could not be read; a string that is
  // not one line means dsh wrote something this bridge must not send to the
  // API. Both are "present and wrong", never "absent".
  if (token === null || (typeof token === 'string' && token.length > 0 && !isSingleLineToken(token))) {
    throw new GrantError(notASingleLineToken(credentialsPath), { code: GRANT_ERROR_CODES.UNPARSABLE });
  }
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
 *
 * A `usable` state carries the token so a caller can tell one account from
 * another (which is how an account switch is noticed). It is `null` in every
 * other state, never `undefined`, so comparing two states can never compare
 * two absences by accident. The token is never printed, logged or written.
 */
export function grantState(credentialsPath = defaultCredentialsPath()) {
  const status = accountGrantStatus(credentialsPath);
  if (status.ok) {
    return {
      state: 'usable',
      detail: status.issuer ? `account grant from ${status.issuer}` : 'account grant present',
      issuer: status.issuer,
      token: status.token,
    };
  }
  const absent = status.code === GRANT_ERROR_CODES.MISSING_FILE || status.code === GRANT_ERROR_CODES.MISSING_RECORD;
  return {
    state: absent ? 'absent' : 'present-but-unusable',
    detail: status.error,
    issuer: null,
    token: null,
  };
}

export function defaultCredentialsPath(home = process.env.HOME) {
  return path.join(home ?? '', '.dsh', '.credentials.yaml');
}
