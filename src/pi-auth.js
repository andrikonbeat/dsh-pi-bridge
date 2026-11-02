import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * The DeepSeek API key Pi keeps in its own auth store.
 *
 * This is the *fallback* route. It is a normal DeepSeek API key, not the dsh
 * account grant, and the two reach the same wallet by different mechanisms.
 *
 * The value is read here only so callers can decide whether the fallback
 * route is alive. It is never printed, never logged and never written to
 * another file: callers get a state, a detail and a fingerprint.
 */

export const API_KEY_STATES = ['absent', 'unusable', 'present'];

/** A short, non-reversible fingerprint. Safe to show, useless to an attacker. */
export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Read the stored deepseek credential.
 *
 * Returns `{ state, detail, key, fingerprint }` where state is one of
 * `absent` (there is no credential), `unusable` (there is one but it cannot
 * be used) or `present` (a well-formed key is stored).
 *
 * `present` deliberately does not mean `working`: a key on an account with no
 * credit is present and perfectly usable as a credential, yet every request
 * fails with 402. Proving that needs a network call, which is what `verify`
 * does and `doctor` deliberately does not.
 */
export function readStoredApiKey(authPath) {
  let raw;
  try {
    raw = fs.readFileSync(authPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        state: 'absent',
        detail: `no auth store at ${authPath}`,
        key: null,
        fingerprint: null,
      };
    }
    return {
      state: 'unusable',
      detail: `cannot read ${authPath}: ${error.message}`,
      key: null,
      fingerprint: null,
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      state: 'unusable',
      detail: `${authPath} is not valid JSON: ${error.message}`,
      key: null,
      fingerprint: null,
    };
  }

  const entry = data?.deepseek ?? data?.['deepseek-official'];
  if (!entry) {
    return {
      state: 'absent',
      detail: `no deepseek entry in ${authPath}`,
      key: null,
      fingerprint: null,
    };
  }

  const key = entry.key ?? entry.apiKey ?? entry.access_token;
  if (typeof key !== 'string' || key.length === 0) {
    return {
      state: 'unusable',
      detail: `the deepseek entry in ${authPath} carries no key`,
      key: null,
      fingerprint: null,
    };
  }

  return {
    state: 'present',
    detail: `present in ${authPath} (sha256 ${fingerprint(key).slice(0, 8)})`,
    key,
    fingerprint: fingerprint(key),
  };
}
