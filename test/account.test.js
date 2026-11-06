import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GRANT_ERROR_CODES,
  GRANT_RECORD_KEY,
  accountGrantStatus,
  grantState,
  readAccountGrant,
} from '../src/dsh-account.js';

const TOKEN = 'account-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ISSUER = 'https://platform.deepseek.com';

/**
 * Run `body` against a real credentials file in a throwaway directory.
 *
 * Every case here goes through the real filesystem: the parser's job is to
 * read the bytes dsh writes, so a mocked file would prove nothing.
 */
function withCredentials(contents, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dsh-bridge-account-'));
  const file = path.join(dir, '.credentials.yaml');
  if (contents !== null) fs.writeFileSync(file, contents);
  try {
    return body(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The credentials file dsh writes when the user signs in. */
function grantYaml({ token = TOKEN, kind = 'grant', issuer = ISSUER } = {}) {
  return (
    'records:\n' +
    `  ${GRANT_RECORD_KEY}:\n` +
    `    kind: ${kind}\n` +
    '    payload:\n' +
    `      token: ${token}\n` +
    `      issuer: ${issuer}\n`
  );
}

/** The S4 message, word for word, with this file's path in it. */
const NOT_A_SINGLE_LINE = (file) =>
  `the "${GRANT_RECORD_KEY}" record in ${file} does not hold a single-line token. ` +
  'The dsh credentials format may have changed; the shared-account bridge cannot be used until it is understood.';

const NOT_A_MAP = (file) =>
  `the "${GRANT_RECORD_KEY}" record in ${file} does not hold a map payload. ` +
  'The dsh credentials format may have changed; the shared-account bridge cannot be used until it is understood.';

const NOTHING_TO_SHARE =
  'so there is no DeepSeek account credential to share. ' +
  'Sign in to DeepSeek in the dsh web interface and run "pi-dsh-bridge sync" again.';

const EMPTY_FILE = (file) => `${file} is empty, ${NOTHING_TO_SHARE}`;
const NO_RECORDS = (file) => `${file} has no records, ${NOTHING_TO_SHARE}`;

function assertUnparsableToken(file) {
  assert.throws(
    () => readAccountGrant(file),
    (error) => {
      assert.equal(error.code, GRANT_ERROR_CODES.UNPARSABLE);
      assert.equal(error.message, NOT_A_SINGLE_LINE(file));
      return true;
    },
  );
  const state = grantState(file);
  assert.equal(state.state, 'present-but-unusable');
  assert.equal(state.detail, NOT_A_SINGLE_LINE(file));
  // Nothing in the file may be offered as a token to any caller.
  assert.equal(accountGrantStatus(file).token, null);
}

describe('a credential value that is not a single-line token (S4)', () => {
  it('rejects every YAML block indicator instead of reporting it usable', () => {
    for (const indicator of ['|', '>', '|-', '>-', '|+', '>+']) {
      withCredentials(grantYaml({ token: indicator }), (file) => {
        assertUnparsableToken(file);
      });
    }
  });

  it('rejects a block scalar whose body follows the indicator', () => {
    withCredentials(
      `records:\n  ${GRANT_RECORD_KEY}:\n    kind: grant\n    payload:\n      token: |\n        ${TOKEN}\n`,
      (file) => {
        assertUnparsableToken(file);
      },
    );
  });

  it('rejects an unquoted token containing a space', () => {
    withCredentials(grantYaml({ token: `${TOKEN} trailing` }), (file) => {
      assertUnparsableToken(file);
    });
  });

  it('rejects a token containing a tab', () => {
    withCredentials(grantYaml({ token: `${TOKEN}\tmore` }), (file) => {
      assertUnparsableToken(file);
    });
  });
});

describe('scalars are unescaped honestly (S5)', () => {
  /** The credentials file with `token:` set to exactly `tokenLine`. */
  const withTokenLine = (tokenLine) =>
    'records:\n' +
    `  ${GRANT_RECORD_KEY}:\n` +
    '    kind: grant\n' +
    '    payload:\n' +
    `      token: ${tokenLine}\n` +
    `      issuer: ${ISSUER}\n`;

  it('drops a trailing comment from an unquoted scalar', () => {
    withCredentials(withTokenLine(`${TOKEN} # rotated when the last grant expired`), (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('unescapes a double-quoted scalar', () => {
    // YAML: token: "abc\\def\"ghi"  ->  abc\def"ghi
    withCredentials(withTokenLine('"abc\\\\def\\"ghi"'), (file) => {
      assert.equal(readAccountGrant(file).token, 'abc\\def"ghi');
    });
  });

  it('unescapes \\n and \\t, which means such a value is never a token', () => {
    withCredentials(withTokenLine(`"${TOKEN}\\nmore"`), (file) => {
      assertUnparsableToken(file);
    });
    withCredentials(withTokenLine(`"${TOKEN}\\tmore"`), (file) => {
      assertUnparsableToken(file);
    });
  });

  it('keeps a # that is inside a quoted scalar', () => {
    withCredentials(withTokenLine('"token#with#hashes"'), (file) => {
      assert.equal(readAccountGrant(file).token, 'token#with#hashes');
    });
  });

  it('keeps a # that is not a comment, even unquoted', () => {
    withCredentials(withTokenLine('token#with#hashes'), (file) => {
      assert.equal(readAccountGrant(file).token, 'token#with#hashes');
    });
  });

  it('never reports a scalar it cannot read as a usable token', () => {
    // An opening quote with no closing quote is not a value, only a mistake.
    withCredentials(withTokenLine('"/half-a-quote'), (file) => {
      assertUnparsableToken(file);
    });
    // An escape this reader does not know cannot be resolved to a token.
    withCredentials(withTokenLine(`"${TOKEN}\\q"`), (file) => {
      assertUnparsableToken(file);
    });
  });
});

describe('the credentials parser understands what dsh writes (S6)', () => {
  it('strips a UTF-8 BOM', () => {
    withCredentials(`\uFEFF${grantYaml()}`, (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('splits CRLF line endings', () => {
    withCredentials(grantYaml().replace(/\n/g, '\r\n'), (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('accepts records: followed by a comment', () => {
    const yaml = grantYaml().replace('records:\n', 'records: # written by the dsh web panel\n');
    withCredentials(yaml, (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('expands leading tabs to spaces', () => {
    const yaml = `records:\n\t${GRANT_RECORD_KEY}:\n\t\tkind: grant\n\t\tpayload:\n\t\t\ttoken: ${TOKEN}\n`;
    withCredentials(yaml, (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('tracks indent depth instead of absolute columns', () => {
    // A file laid out with four spaces per level, not dsh's usual two.
    const yaml =
      'records:\n' +
      `    ${GRANT_RECORD_KEY}:\n` +
      '        kind: grant\n' +
      '        payload:\n' +
      `            token: ${TOKEN}\n` +
      `            issuer: ${ISSUER}\n`;
    withCredentials(yaml, (file) => {
      const grant = readAccountGrant(file);
      assert.equal(grant.token, TOKEN);
      assert.equal(grant.issuer, ISSUER);
    });
  });

  it('merges duplicate record blocks field by field, keeping the record', () => {
    // dsh may write the same record twice; the object must survive and the
    // last value of each field must win.
    const yaml =
      'records:\n' +
      `  ${GRANT_RECORD_KEY}:\n` +
      '    kind: grant\n' +
      '    payload:\n' +
      `      token: ${TOKEN}\n` +
      '  other/record:\n' +
      '    kind: token\n' +
      `  ${GRANT_RECORD_KEY}:\n` +
      '    payload:\n' +
      `      issuer: ${ISSUER}\n`;
    withCredentials(yaml, (file) => {
      const grant = readAccountGrant(file);
      assert.equal(grant.token, TOKEN);
      assert.equal(grant.issuer, ISSUER);
    });
  });

  it('merges two `records:` blocks the same way', () => {
    const yaml =
      'records:\n' +
      `  ${GRANT_RECORD_KEY}:\n` +
      '    kind: grant\n' +
      '    payload:\n' +
      `      token: ${TOKEN}\n` +
      'records:\n' +
      `  ${GRANT_RECORD_KEY}:\n` +
      '    payload:\n' +
      `      issuer: ${ISSUER}\n`;
    withCredentials(yaml, (file) => {
      const grant = readAccountGrant(file);
      assert.equal(grant.token, TOKEN);
      assert.equal(grant.issuer, ISSUER);
    });
  });

  it('takes the last value when the same field appears twice', () => {
    const yaml =
      'records:\n' +
      `  ${GRANT_RECORD_KEY}:\n` +
      '    kind: grant\n' +
      '    payload:\n' +
      '      token: stale-token\n' +
      `      token: ${TOKEN}\n`;
    withCredentials(yaml, (file) => {
      assert.equal(readAccountGrant(file).token, TOKEN);
    });
  });

  it('rejects a payload that is not a map', () => {
    const yaml = `records:\n  ${GRANT_RECORD_KEY}:\n    kind: grant\n    payload: not-a-map\n`;
    withCredentials(yaml, (file) => {
      assert.throws(
        () => readAccountGrant(file),
        (error) => {
          assert.equal(error.code, GRANT_ERROR_CODES.UNPARSABLE);
          assert.equal(error.message, NOT_A_MAP(file));
          return true;
        },
      );
      assert.equal(grantState(file).state, 'present-but-unusable');
    });
  });
});

describe('an existing credentials file with nothing usable in it (S6)', () => {
  it('reports an empty file as present but unusable, not absent', () => {
    for (const contents of ['', '\n\n', '   \n\t\n']) {
      withCredentials(contents, (file) => {
        assert.throws(
          () => readAccountGrant(file),
          (error) => {
            assert.equal(error.code, GRANT_ERROR_CODES.UNPARSABLE);
            assert.equal(error.message, EMPTY_FILE(file));
            return true;
          },
        );
        const state = grantState(file);
        assert.equal(state.state, 'present-but-unusable');
        assert.equal(state.detail, EMPTY_FILE(file));
        assert.equal(accountGrantStatus(file).code, GRANT_ERROR_CODES.UNPARSABLE);
      });
    }
  });

  it('reports a file with no records at all as present but unusable', () => {
    withCredentials('not: a credentials file\n', (file) => {
      assert.throws(
        () => readAccountGrant(file),
        (error) => {
          assert.equal(error.code, GRANT_ERROR_CODES.UNPARSABLE);
          assert.equal(error.message, NO_RECORDS(file));
          return true;
        },
      );
      assert.equal(grantState(file).state, 'present-but-unusable');
    });
  });

  it('reserves MISSING_RECORD for a file whose records are not ours', () => {
    withCredentials('records:\n  other/record:\n    kind: token\n', (file) => {
      assert.throws(
        () => readAccountGrant(file),
        (error) => {
          assert.equal(error.code, GRANT_ERROR_CODES.MISSING_RECORD);
          assert.match(error.message, /Records found: other\/record/);
          return true;
        },
      );
      assert.equal(grantState(file).state, 'absent');
    });
  });
});

describe('the credentials file dsh writes', () => {
  it('is read as one usable token with its issuer', () => {
    withCredentials(grantYaml(), (file) => {
      assert.deepEqual(readAccountGrant(file), { token: TOKEN, issuer: ISSUER, credentialsPath: file });
      const status = accountGrantStatus(file);
      assert.equal(status.ok, true);
      assert.equal(status.token, TOKEN);
      const state = grantState(file);
      assert.equal(state.state, 'usable');
      assert.equal(state.detail, `account grant from ${ISSUER}`);
      assert.equal(state.issuer, ISSUER);
    });
  });
});
