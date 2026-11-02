import fs from 'node:fs';

import { accountGrantStatus, grantState, readAccountGrant } from '../dsh-account.js';
import { applySharedProvider, loadModels, renderModels, sharedProvider } from '../models.js';
import { tokenProgram } from '../token-helper.js';
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
 * Wire Pi's `models.json` to the shared DeepSeek account.
 *
 * The token itself is never written anywhere: the file records only the
 * command that fetches it. Re-running this is safe and writes nothing when
 * the file already says what it should.
 */
export function sync({ options = {}, ui, layout, env = process.env, cliPath }) {
  const modelsPath = layout.modelsPath;
  const grant = accountGrantStatus(layout.credentialsPath);

  if (!grant.ok) {
    ui.error(grant.error);
    ui.line('  the API-key route is untouched, so Pi still works with a stored deepseek key');
    ui.line('  sign in to DeepSeek in the dsh web interface, then run "pi-dsh-bridge sync" again');
    return 1;
  }

  const program = tokenProgram({ layout, cliPath });
  const provider = sharedProvider({ program, dshHome: layout.dshHome });

  let current;
  try {
    current = loadModels(modelsPath);
  } catch (error) {
    ui.error(error.message);
    return 1;
  }

  const { merged } = applySharedProvider(current.data, provider);
  const rendered = Buffer.from(renderModels(merged));
  const unchanged = current.exists && current.raw.equals(rendered);
  const command = provider.headers['x-dsh-auth-token'];

  if (options.dryRun) {
    ui.line('sync plan (dry run: nothing is written)');
    ui.line(`  ${unchanged ? 'unchanged' : 'updated  '} ${modelsPath}  deepseek provider -> shared account`);
    ui.line(`  header    ${command}`);
    if (ui.json) {
      ui.emitJson({
        command: 'sync',
        ok: true,
        dryRun: true,
        modelsPath,
        changed: !unchanged,
        issuer: grant.issuer,
      });
    }
    return 0;
  }

  if (unchanged) {
    ui.line('sync');
    ui.line(`  unchanged ${modelsPath}  deepseek provider -> shared account`);
    ui.line(`  account   ${grant.issuer ?? 'deepseek account'} (token read on demand, never stored here)`);
    if (ui.json) {
      ui.emitJson({
        command: 'sync',
        ok: true,
        dryRun: false,
        modelsPath,
        changed: false,
        issuer: grant.issuer,
      });
    }
    return 0;
  }

  // The journal keeps the first copy of the file it ever saw, so uninstall
  // restores the models.json that existed before the bridge touched it, byte
  // for byte.
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

  const batch = createBackupBatch({ backupsDir: layout.backupsDir });
  const before = current.exists ? batch.backup(modelsPath) : null;

  fs.mkdirSync(layout.piHome, { recursive: true });
  fs.writeFileSync(modelsPath, rendered);

  const entries = [{ path: modelsPath, before, after: 'file-copy' }];
  const next = journal
    ? { ...journal, entries: mergeEntries(journal, entries) }
    : createJournal({ versions: {} });
  if (!journal) next.entries = mergeEntries(next, entries);
  writeJournal(layout.journalPath, next);

  ui.line('sync');
  ui.line(`  updated  ${modelsPath}  deepseek provider -> shared account`);
  ui.line(`  header    ${command}`);
  ui.line(`  account   ${grant.issuer ?? 'deepseek account'} (token read on demand, never stored here)`);

  if (ui.json) {
    ui.emitJson({
      command: 'sync',
      ok: true,
      dryRun: false,
      modelsPath,
      changed: true,
      issuer: grant.issuer,
    });
  }
  return 0;
}

export const SYNC_HELP = `Usage: pi-dsh-bridge sync [options]

Point Pi at the DeepSeek account that the dsh web interface uses.

The account token is never written to a file: Pi fetches it on demand through
a command, so signing in to a different account in the dsh web interface
changes the account Pi uses on its next start.

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
