import { accountGrantStatus, grantState, readAccountGrant } from '../dsh-account.js';
import { applySharedProvider, loadModels, renderModels, sharedProvider } from '../models.js';
import { tokenProgram } from '../token-helper.js';
import { writeFileAtomic } from '../fs-atomic.js';
import {
  JournalError,
  createBackupBatch,
  createJournal,
  mergeEntries,
  readJournal,
  writeJournal,
} from '../journal.js';

/**
 * Print the DeepSeek account token on stdout and nothing else.
 *
 * This is the command Pi resolves through the `!command` header value, so
 * its output is the credential that travels in the `x-dsh-auth-token`
 * header. Two rules follow from that and are not negotiable:
 *
 *   - stdout carries the token and only the token;
 *   - every diagnostic goes to stderr.
 *
 * Pi caches the result for the life of the process, so a fresh Pi start
 * reads the current grant. That is what makes a new account in the dsh web
 * interface take effect on the next start, with nothing copied anywhere.
 */
export function token({ options = {}, ui, layout, env = process.env }) {
  const credentialsPath = layout.credentialsPath;

  // `--check` answers "can the bridge work right now?" without ever putting
  // the credential on stdout, so a launcher can ask without handling a
  // secret.
  if (options.check) {
    const state = grantState(credentialsPath);
    if (state.state === 'usable') {
      process.stderr.write(`dsh account grant usable (${state.detail})\n`);
      return 0;
    }
    process.stderr.write(`dsh account grant ${state.state}: ${state.detail}\n`);
    return 1;
  }

  let grant;
  try {
    grant = readAccountGrant(credentialsPath);
  } catch (error) {
    // The error must never reach stdout: a partial or explanatory message
    // there would be sent to DeepSeek as the credential.
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  process.stdout.write(`${grant.token}\n`);
  return 0;
}

/**
 * Compute the provider entry and the bytes it implies, without writing.
 *
 * Shared by `sync`, `install` and `account` so that there is exactly one
 * implementation of "what the provider looks like". The token itself is never
 * written anywhere: the file records only the command that fetches it.
 */
export function wireSharedProvider({ layout, cliPath }) {
  const program = tokenProgram({ layout, cliPath });
  const provider = sharedProvider({ program, dshHome: layout.dshHome });
  const current = loadModels(layout.modelsPath);
  const { merged } = applySharedProvider(current.data, provider);
  const rendered = Buffer.from(renderModels(merged));
  const changed = !(current.exists && current.raw.equals(rendered));
  return { changed, modelsPath: layout.modelsPath, provider, rendered, current };
}

/**
 * Write the shared provider, recording the prior bytes in the journal once.
 *
 * The journal keeps the first copy of the file it ever saw, so `uninstall`
 * restores the `models.json` that existed before the bridge touched it, byte
 * for byte.
 */
export function persistSharedProvider({ layout, plan, journal }) {
  const batch = createBackupBatch({ backupsDir: layout.backupsDir });
  const before = plan.current.exists ? batch.backup(plan.modelsPath) : null;

  // Atomic: Pi may be starting while this runs, and a truncated models.json
  // would make it fail to parse its own configuration.
  writeFileAtomic(plan.modelsPath, plan.rendered, { mode: 0o644 });

  const entries = [{ path: plan.modelsPath, before, after: 'file-copy' }];
  const next = journal
    ? { ...journal, entries: mergeEntries(journal, entries) }
    : createJournal({ versions: {} });
  if (!journal) next.entries = mergeEntries(next, entries);
  writeJournal(layout.journalPath, next);
}

/**
 * Wire Pi's `models.json` to the shared DeepSeek account.
 *
 * The token itself is never written anywhere: the file records only the
 * command that fetches it. Re-running this is safe and writes nothing when
 * the file already says what it should.
 */
export function sync({ options = {}, ui, layout, env = process.env, cliPath }) {
  const grant = accountGrantStatus(layout.credentialsPath);

  if (!grant.ok) {
    ui.error(grant.error);
    ui.aside('the API-key route is untouched, so Pi still works with a stored deepseek key');
    ui.aside('sign in to DeepSeek in the dsh web interface, then run "pi-dsh-bridge sync" again');
    ui.aside('or run "pi-dsh-bridge account", which opens the panel for you');
    return 1;
  }

  let plan;
  try {
    plan = wireSharedProvider({ layout, cliPath });
  } catch (error) {
    ui.error(error.message);
    return 1;
  }

  const command = plan.provider.headers['x-dsh-auth-token'];

  if (options.dryRun) {
    ui.line('sync plan (dry run: nothing is written)');
    ui.line(`  ${plan.changed ? 'updated  ' : 'unchanged'} ${plan.modelsPath}  deepseek provider -> shared account`);
    ui.line(`  header    ${command}`);
    if (ui.json) {
      ui.emitJson({
        command: 'sync',
        ok: true,
        dryRun: true,
        modelsPath: plan.modelsPath,
        changed: plan.changed,
        issuer: grant.issuer,
      });
    }
    return 0;
  }

  if (!plan.changed) {
    ui.line('sync');
    ui.line(`  unchanged ${plan.modelsPath}  deepseek provider -> shared account`);
    ui.line(`  account   ${grant.issuer ?? 'deepseek account'} (token read on demand, never stored here)`);
    if (ui.json) {
      ui.emitJson({
        command: 'sync',
        ok: true,
        dryRun: false,
        modelsPath: plan.modelsPath,
        changed: false,
        issuer: grant.issuer,
      });
    }
    return 0;
  }

  let journal;
  try {
    journal = readJournal(layout.journalPath);
  } catch (error) {
    if (error instanceof JournalError) {
      ui.error(error.message);
      return 1;
    }
    throw error;
  }

  persistSharedProvider({ layout, plan, journal });

  ui.line('sync');
  ui.line(`  updated  ${plan.modelsPath}  deepseek provider -> shared account`);
  ui.line(`  header    ${command}`);
  ui.line(`  account   ${grant.issuer ?? 'deepseek account'} (token read on demand, never stored here)`);

  if (ui.json) {
    ui.emitJson({
      command: 'sync',
      ok: true,
      dryRun: false,
      modelsPath: plan.modelsPath,
      changed: true,
      issuer: grant.issuer,
    });
  }
  return 0;
}

export const SYNC_HELP = `Usage: pi-dsh-bridge sync [options]

Re-wire Pi to the DeepSeek account the dsh web interface uses.

You rarely need this: "install" does it, and "account" does it after you switch
accounts. The account token is never written to a file — Pi fetches it on
demand through a command.

  --dry-run            print the plan and change nothing
  -y, --yes            do not ask for confirmation
  --json               machine-readable output
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
`;

export const TOKEN_HELP = `Usage: pi-dsh-bridge token [options]

Print the DeepSeek account token on stdout.

This command exists for Pi to call. It is not meant to be run by hand, and
the token it prints is a credential: do not paste it anywhere.

  --check              report whether the grant is usable, print no token
  --json               machine-readable output
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
`;
