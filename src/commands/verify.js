import { spawnSync } from 'node:child_process';

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../paths.js';
import { describeRoute, diverges, probe } from '../dsh.js';
import { nodeCheck, preflight } from '../preflight.js';
import { loadSettings, settingsMismatch, SettingsParseError } from '../settings.js';

const PROMPT = 'Reply with the single word: ok';

/**
 * The costly end-to-end path: it drives Pi against the DeepSeek API, which
 * spends credit, so it is never implicit. Without `--yes` it refuses and exits 2.
 */
export function verify({ options = {}, ui, layout, env = process.env }) {
  if (!options.yes) {
    ui.error(
      'verify drives Pi against the DeepSeek API and spends API credit, so it is never implicit.',
    );
    ui.note('Re-run with --yes:  pi-dsh-bridge verify --yes');
    ui.note('For a free, offline check use:  pi-dsh-bridge doctor');
    return 2;
  }

  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? DEFAULT_MODEL;
  const checks = [];
  const push = (id, title, status, detail) => checks.push({ id, title, status, detail });

  const node = nodeCheck();
  push('node', 'node >= 22.19.0', node.status, node.detail);

  const facts = preflight({ env });
  push(
    'pi',
    'pi on PATH',
    facts.pi.found ? 'ok' : 'fail',
    facts.pi.found ? `${facts.pi.version ?? 'version unknown'} at ${facts.pi.path}` : 'pi not found on PATH',
  );
  push(
    'dsh',
    'dsh on PATH',
    facts.dsh.found ? 'ok' : 'warn',
    facts.dsh.found ? `${facts.dsh.version ?? 'version unknown'} at ${facts.dsh.path}` : 'dsh not found on PATH',
  );

  let settingsOk = false;
  try {
    const settings = loadSettings(layout.settingsPath);
    if (!settings.exists) {
      push('settings', 'settings.json points at the requested route', 'fail', `${layout.settingsPath} is missing; run: pi-dsh-bridge install`);
    } else {
      const mismatches = settingsMismatch(settings.data, { provider, model });
      settingsOk = mismatches.length === 0;
      push('settings', 'settings.json points at the requested route', settingsOk ? 'ok' : 'fail',
        settingsOk
          ? `defaultProvider=${provider}, defaultModel=${model}`
          : `${mismatches.join('; ')}; run: pi-dsh-bridge install`,
      );
    }
  } catch (error) {
    if (!(error instanceof SettingsParseError)) throw error;
    push('settings', 'settings.json points at the requested route', 'fail', error.message);
  }

  if (facts.pi.found) {
    const result = spawnSync(
      facts.pi.path,
      ['--print', PROMPT, '--provider', provider, '--model', model],
      { encoding: 'utf8', env, timeout: 120_000 },
    );
    const answer = (result.stdout ?? '').trim();
    const ok = result.status === 0 && answer.length > 0;
    push(
      'pi-round-trip',
      'pi answers one prompt through the DeepSeek provider',
      ok ? 'ok' : 'fail',
      ok
        ? `${model} answered (${answer.split('\n')[0].slice(0, 60)})`
        : `pi exited ${result.status ?? 'with a signal'}: ${(result.stderr ?? '').trim().split('\n')[0] || 'no output'}`,
    );
  }

  if (facts.dsh.found) {
    const result = probe({ dshPath: facts.dsh.path, env });
    if (!result.ok) {
      push('dsh-route', 'effective dsh default model matches the required route', 'warn', `config probe failed: ${result.error}`);
    } else if (diverges(result)) {
      push('dsh-route', 'effective dsh default model matches the required route', 'warn', `${describeRoute(result)}; run: pi-dsh-bridge install`);
    } else {
      push('dsh-route', 'effective dsh default model matches the required route', 'ok', describeRoute(result));
    }
  }

  const ok = !checks.some((check) => check.status === 'fail');

  if (ui.json) {
    ui.emitJson({
      command: 'verify',
      ok,
      versions: { node: process.versions.node, pi: facts.pi.version, dsh: facts.dsh.version },
      checks,
    });
  } else {
    ui.line(`verify: end-to-end run against ${provider}/${model} (spends API credit)`);
    for (const check of checks) ui.status(check.status, check.id, check.detail);
    ui.line(ok ? 'verify: ok' : 'verify: failed');
  }

  return ok ? 0 : 1;
}

export const VERIFY_HELP = `Usage: pi-dsh-bridge verify --yes [options]

End-to-end check: drives Pi against the DeepSeek API and probes the effective
dsh config. It spends API credit, so it requires an explicit --yes.

  -y, --yes            required; confirms you accept the API cost
  --json               machine-readable output
  --pi-home <dir>      default $PI_HOME or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi model to verify, default ${DEFAULT_MODEL}
  --provider <id>      Pi provider to verify, default ${DEFAULT_PROVIDER}
`;
