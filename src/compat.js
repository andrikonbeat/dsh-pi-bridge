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

/**
 * dsh builds that cannot mount a single agent preset.
 *
 * `0.2.2-alpha.2` ships `dsh-agent-preset-registry@0.2.2-alpha.2`, which
 * reads a service implementation's `fiber` property to decide who owns it,
 * and asks cordis for `~4.0.6-alpha.1`. That range now resolves to cordis
 * 4.0.6-alpha.2, whose implementations carry the owning `ctx` instead of
 * `fiber`, so the registry sees a fiber-less implementation, throws while
 * mounting, and every preset ends up broken. The web UI then refuses to
 * create any session. `0.2.2-alpha.3` ships the registry that reads
 * `impl.ctx.fiber` and is not affected.
 */
export const KNOWN_BROKEN_DSH_VERSIONS = new Map([
  [
    '0.2.2-alpha.2',
    {
      symptom:
        "agent-preset/invalid: Cannot read properties of undefined (reading 'parent')",
      remedy: 'npm install -g @deepseek-ai/dsh@0.2.2-alpha.3',
      alternative: '0.2.1-rc.5',
    },
  ],
]);

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

/**
 * Whether the observed dsh can mount an agent preset at all.
 *
 * This is not the compatibility matrix: a build outside the matrix is merely
 * untested, while a build listed as broken cannot start a single session.
 * That difference is the difference between a warning and a failure.
 */
export function checkDshPresetCompatibility(version) {
  const observed = normalize(version);
  if (!observed) {
    return {
      status: 'warn',
      detail: 'dsh reported no parsable version; the agent preset compatibility was not checked',
    };
  }
  const broken = KNOWN_BROKEN_DSH_VERSIONS.get(observed);
  if (!broken) {
    return { status: 'ok', detail: `${observed} has no known agent preset defect` };
  }
  return {
    status: 'fail',
    detail:
      `${observed} cannot mount agent presets; new sessions fail with: ${broken.symptom}. ` +
      `Fix: ${broken.remedy} (${broken.alternative} is not affected)`,
  };
}
