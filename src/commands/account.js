import { ensureAccount } from '../onboarding.js';
import { grantState } from '../dsh-account.js';
import { LockHeldError, acquireJournalLock } from '../journal.js';
import { packageVersion } from '../paths.js';

/**
 * `account` — the one command for everything account-shaped.
 *
 * It answers the three questions a user actually has, without making them learn
 * the difference between them:
 *
 *   - which account is Pi using right now?
 *   - I need to sign in (or re-sign in): where is that panel?
 *   - my quota ran out and I changed accounts: is Pi on the new one yet?
 *
 * Everything else — the grant, the header, `models.json` — stays invisible.
 */
export async function account({ options = {}, ui, layout, env = process.env, cliPath }) {
  let lock;
  try {
    lock = acquireJournalLock(layout);
  } catch (error) {
    if (error instanceof LockHeldError) {
      ui.note(error.message);
      return 1;
    }
    throw error;
  }

  try {
    const status = grantState(layout.credentialsPath);
    const interactive = ui.json ? false : ui.interactive === true;

    if (!ui.json) {
      ui.banner({ version: packageVersion() });
    }

    if (status.state === 'usable' && !options.relogin && !options.restart) {
      ui.ok('account', `connected to ${status.issuer ?? 'DeepSeek'}`);
      ui.blank();
      ui.aside('Pi is spending this account. To switch accounts — for example when the quota runs out:');
      ui.cmd('pi-dsh-bridge account --relogin');
      if (ui.json) {
        ui.emitJson({
          command: 'account',
          ok: true,
          state: 'usable',
          issuer: status.issuer,
          relogin: false,
        });
      }
      return 0;
    }

    if (status.state !== 'usable') {
      ui.warn('account', `${status.state}: ${status.detail}`);
    }

    ui.step(1, 2, options.restart ? 'Restarting the dsh web panel' : 'Opening the dsh web panel');

    const result = await ensureAccount({
      layout,
      ui,
      env,
      cliPath,
      // A human is present: open the panel for them, the way `dsh web`
      // does. `--open` still forces it, and a non-interactive run never
      // launches a browser.
      open: interactive || options.open === true,
      restart: options.restart === true || options.relogin === true,
      interactive,
      announce: false,
    });

    if (ui.json) {
      ui.emitJson({
        command: 'account',
        ok: result.ok,
        state: result.state?.state ?? status.state,
        issuer: result.state?.issuer ?? null,
        changed: result.changed,
        accountChanged: result.accountChanged,
        url: result.url ?? null,
        reason: result.reason ?? null,
      });
      return result.ok ? 0 : 1;
    }

    if (!result.ok) {
      if (result.reason === 'not-interactive') {
        ui.blank();
        ui.aside('Sign in with that URL, then run: pi-dsh-bridge account');
      }
      return 1;
    }

    ui.blank();
    ui.rule();
    ui.ok('ready', 'Pi will use this account on its next start');
    ui.cmd('pi');
    return 0;
  } finally {
    lock.release();
  }
}

export const ACCOUNT_HELP = `Usage: pi-dsh-bridge account [options]

Show which DeepSeek account Pi is using, or switch to another one.

Run it when your quota runs out and you have signed in to a different account,
or when you need the dsh web panel's sign-in URL again.

  --relogin            re-open the panel and switch account even if one works
  --restart            restart the dsh web panel to get a fresh sign-in URL
  --open               try to open the sign-in URL in your browser
  --json               machine-readable output
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
`;
