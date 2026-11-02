import { parseVersion } from './preflight.js';

/**
 * What has actually been verified. `dsh` is a DeepSeek-owned release candidate,
 * so a version outside this table is reported as `warn`, never `fail`: the
 * tooling keeps working and the user is told what was tested.
 *
 * A row is added only after a real end-to-end run (`verify --yes`), never on the
 * basis of a changelog entry.
 */
export const COMPATIBILITY_MATRIX = [
  {
    bridge: '0.1.0',
    dsh: '0.2.1-rc.5',
    pi: '1.4.0',
    node: `>= 22.19.0`,
    status: 'verified end to end',
  },
];

export const VERIFIED_DSH_VERSIONS = COMPATIBILITY_MATRIX.map((row) => row.dsh);

function normalize(version) {
  const parsed = parseVersion(version);
  return parsed ?? String(version ?? '').trim().replace(/^v/, '');
}

/** { status: 'ok' | 'warn', detail } for an observed dsh version. */
export function checkDshVersion(version) {
  const observed = normalize(version);
  if (!observed) {
    return {
      status: 'warn',
      detail: 'dsh reported no parsable version; see docs/compatibility.md',
    };
  }
  if (VERIFIED_DSH_VERSIONS.includes(observed)) {
    return { status: 'ok', detail: `${observed} matches the verified matrix` };
  }
  return {
    status: 'warn',
    detail: `${observed} is outside the verified matrix (${VERIFIED_DSH_VERSIONS.join(', ')}); see docs/compatibility.md`,
  };
}
