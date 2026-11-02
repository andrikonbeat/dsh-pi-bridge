import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../paths.js';
import { describeRoute, diverges, probe } from '../dsh.js';
import { nodeCheck, preflight } from '../preflight.js';
import { loadSettings, settingsMismatch, SettingsParseError } from '../settings.js';
import { readAccountGrant } from '../dsh-account.js';
import { readStoredApiKey } from '../pi-auth.js';
import { ACCOUNT_TOKEN_HEADER, SHARED_PROVIDER_ID } from '../bridge-protocol.js';
import { isSharedProvider, loadModels, programFromCommand } from '../models.js';
import { tokenProgram } from '../token-helper.js';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/**
 * What DeepSeek says about a wallet.
 *
 * `GET /user/balance` costs nothing, so it is the cheapest proof that a
 * credential still works and that it has credit. The account token is sent
 * in its own header; the API key travels as a bearer token.
 */
async function balanceOf({ accountToken, apiKey }) {
  const headers = {};
  if (accountToken) headers[ACCOUNT_TOKEN_HEADER] = accountToken;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(BALANCE_URL, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}: ${text.slice(0, 120)}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'the balance response was not JSON' };
  }
  const balances = (data.balance_infos ?? [])
    .map((info) => `${info.currency} ${info.total_balance}`)
    .join(', ');
  return {
    ok: true,
    available: data.is_available === true,
    detail: `is_available=${data.is_available === true}${balances ? `, balances: ${balances}` : ''}`,
  };
}

/**
 * Is Pi wired to the shared account, and can the program that fetches the
 * token actually run?
 */
function bridgeCheck(layout, cliPath) {
  let models;
  try {
    models = loadModels(layout.modelsPath);
  } catch (error) {
    return { status: 'fail', detail: error.message };
  }
  if (!models.exists) {
    return { status: 'fail', detail: `${layout.modelsPath} does not exist; run: pi-dsh-bridge sync` };
  }
  const provider = models.data?.providers?.[SHARED_PROVIDER_ID];
  if (!provider) {
    return {
      status: 'fail',
      detail: `no ${SHARED_PROVIDER_ID} provider in ${layout.modelsPath}; run: pi-dsh-bridge sync`,
    };
  }
  if (!isSharedProvider(provider)) {
    return {
      status: 'fail',
      detail: `the ${SHARED_PROVIDER_ID} provider is not wired to the dsh account; run: pi-dsh-bridge sync`,
    };
  }
  const program = programFromCommand(provider.headers?.[ACCOUNT_TOKEN_HEADER]);
  if (!program) {
    return {
      status: 'fail',
      detail: `the ${SHARED_PROVIDER_ID} provider does not carry a runnable account command; run: pi-dsh-bridge sync`,
    };
  }
  if (!fs.existsSync(program)) {
    return {
      status: 'fail',
      detail: `the account-token program ${program} does not exist; run: pi-dsh-bridge install`,
    };
  }
  return { status: 'ok', detail: `${SHARED_PROVIDER_ID} -> shared dsh account via ${program}` };
}

const PROMPT = 'Reply with the single word: ok';

/**
 * The costly end-to-end path: it drives Pi against the DeepSeek API, which
 * spends credit, so it is never implicit. Without `--yes` it refuses and exits 2.
 */
export async function verify({ options = {}, ui, layout, env = process.env, cliPath }) {
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

  // The shared account route is the one Pi is supposed to use. It is proved
  // directly, so a wrong wiring cannot hide behind a lucky round trip.
  let grant = null;
  try {
    grant = readAccountGrant(layout.credentialsPath);
  } catch (error) {
    push('shared-account', 'the dsh account route is usable', 'fail', error.message);
  }
  if (grant) {
    try {
      const balance = await balanceOf({ accountToken: grant.token });
      push(
        'shared-account',
        'the dsh account route is usable',
        balance.ok && balance.available ? 'ok' : 'fail',
        balance.ok ? balance.detail : `the account route did not answer: ${balance.detail}`,
      );
    } catch (error) {
      push('shared-account', 'the dsh account route is usable', 'fail', `could not reach DeepSeek: ${error.message}`);
    }
  }

  const storedKey = readStoredApiKey(layout.authPath);
  if (storedKey.state === 'present') {
    try {
      const balance = await balanceOf({ apiKey: storedKey.key });
      push(
        'api-key-balance',
        'the API-key fallback route has credit',
        balance.ok ? (balance.available ? 'ok' : 'warn') : 'warn',
        balance.ok
          ? `${balance.detail}${balance.available ? '' : ' — this key cannot pay; the bridge does not need it'}`
          : `the API-key route did not answer: ${balance.detail}`,
      );
    } catch (error) {
      push('api-key-balance', 'the API-key fallback route has credit', 'warn', `could not reach DeepSeek: ${error.message}`);
    }
  } else {
    push(
      'api-key-balance',
      'the API-key fallback route has credit',
      'warn',
      `${storedKey.detail}; there is no API-key fallback if the account route breaks`,
    );
  }

  push('bridge', 'Pi is wired to the shared dsh account', bridgeCheck(layout, cliPath));

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
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi model to verify, default ${DEFAULT_MODEL}
  --provider <id>      Pi provider to verify, default ${DEFAULT_PROVIDER}
`;
