import { fingerprint } from './pi-auth.js';
import { grantState } from './dsh-account.js';
import {
  openInBrowser,
  resolveDshPort,
  startDshWeb,
  stopDshWeb,
  stopPanelGroup,
} from './dsh-web.js';
import { JournalError, readJournal } from './journal.js';
import { persistSharedProvider, wireSharedProvider } from './commands/sync.js';

/**
 * The one thing a new user has to do that a program cannot do for them.
 *
 * A DeepSeek account is signed in inside the dsh web panel, and nothing else
 * can mint the grant this bridge reads. So instead of telling the user to go
 * somewhere and come back, this module opens the panel, hands over the
 * tokenised URL, waits, and then detects the account by itself.
 *
 * That is the whole design goal: the user should never have to understand what
 * a grant, a header or `models.json` is, and should never be told to run a
 * second command to finish the first.
 */

const SIGN_IN_HINT = 'Sign in with DeepSeek, then come back here.';

/**
 * The fingerprint of the account a state names, or `null` when it names none.
 *
 * A state that is not `usable` has no token, so this is the only place an
 * account identity is derived: two `usable` states can be compared, and no
 * other pair is ever compared at all.
 */
function accountFingerprint(state) {
  return state.state === 'usable' ? fingerprint(state.token) : null;
}

/** The state returned when the user interrupts the wait. */
const ABORTED_STATE = {
  state: 'aborted',
  detail: 'the wait was interrupted before an account appeared',
  issuer: null,
};

/**
 * Sleep, but wake up early when the wait is aborted.
 *
 * A plain `setTimeout` would keep the process alive for the whole interval
 * after a Ctrl-C, which is exactly the delay the user is trying to escape.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll the grant until it appears, or give up honestly.
 *
 * The wait is interruptible in two ways: an `AbortSignal` the caller owns,
 * and Ctrl-C. Ctrl-C is handled here rather than left to the default, because
 * the default kills the process outright and would leave the panel running
 * with nobody watching it.
 *
 * `onAbort` runs exactly once, when the wait is cut short, so the caller can
 * clean up what it started.
 */
export async function waitForGrant(
  credentialsPath,
  { timeoutMs = 45_000, intervalMs = 1_500, signal = null, onAbort = null } = {},
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  // A SIGINT listener replaces the default "die immediately" behaviour, so
  // the cleanup below actually runs. It is removed again in the `finally`.
  const onSigint = () => abort();
  process.on('SIGINT', onSigint);

  let aborted = false;
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (controller.signal.aborted) {
        aborted = true;
        break;
      }
      const state = grantState(credentialsPath);
      if (state.state === 'usable') return state;
      if (Date.now() >= deadline) return state;
      await sleep(intervalMs, controller.signal);
    }
  } finally {
    process.off('SIGINT', onSigint);
    signal?.removeEventListener('abort', abort);
  }

  if (aborted && onAbort) onAbort();
  return { ...ABORTED_STATE };
}

/**
 * Show the sign-in panel and wait for the account to appear.
 *
 * `open` asks the browser to the URL and is opt-in everywhere: a headless box,
 * a CI job or an SSH session must print the URL, not try to launch a browser.
 * That is why the URL is always printed as text, whatever `open` says.
 */
async function presentSignIn({ layout, ui, env, open, restart, interactive, before, signal }) {
  const resolved = resolveDshPort(undefined, env);
  if (resolved.error) {
    ui.error(resolved.error);
    return { ok: false, reason: 'bad-port', url: null };
  }
  const port = resolved.port;
  let url = null;
  let started = null;

  // No interactive terminal means nobody is there to click "sign in". Starting
  // a server would take a port and a process for nothing, so print the exact
  // command instead and leave the machine untouched.
  if (!interactive) {
    ui.blank();
    ui.box('Sign in to DeepSeek', [
      'Pi will use the same account as the dsh web panel.',
      'This is the only step left, and it needs a browser:',
      '',
      '  pi-dsh-bridge account',
    ]);
    ui.aside('Run that on your desktop, sign in, and Pi is wired.');
    return { ok: false, reason: 'not-interactive', url: null };
  }

  if (restart) {
    const stopped = stopDshWeb(port, { launcherPath: layout.launcherPath });
    if (!stopped.stopped) {
      ui.warn('restart', stopped.reason);
    } else {
      ui.info('restart', `stopped the panel on port ${port} (pid ${stopped.pid})`);
      // Give the socket a moment to be released before rebinding it.
      await new Promise((resolve) => {
        setTimeout(resolve, 1_200);
      });
    }
  }

  started = await startDshWeb({ launcherPath: layout.launcherPath, env, port });
  url = started.url;

  if (started.alreadyRunning) {
    ui.warn('panel', `dsh web is already serving port ${port}`);
    ui.aside('Its sign-in URL was printed when it started, and it cannot be recovered from a running server.');
    ui.aside('If you lost it, re-run this command with --restart.');
  } else if (!url) {
    ui.error(started.error ?? 'dsh web did not report a sign-in URL');
    return { ok: false, reason: 'no-url' };
  }

  ui.blank();
  if (url) {
    ui.box('Sign in to DeepSeek', [
      'Pi will use the same account as the dsh web panel.',
      'Open this address in your browser:',
      '',
      `  ${url}`,
      '',
      SIGN_IN_HINT,
      'Keep this page: it is where you change accounts later, too.',
    ]);
    if (open) {
      const opened = openInBrowser(url, { env });
      ui.aside(opened ? 'Opening it in your browser…' : 'Could not open a browser; open the address above yourself.');
    } else {
      ui.aside('Copy the address above into your browser.');
    }
  }

  await ui.waitForEnter('Press Enter once you are signed in');
  ui.blank();
  ui.step(2, 2, 'Detecting your DeepSeek account');

  // An interrupted wait must not leave the panel running with nobody
  // watching it: the group is stopped, and the run reports `aborted` instead
  // of pretending the account was never found.
  const after = await waitForGrant(layout.credentialsPath, {
    signal,
    onAbort: () => {
      if (started && !started.alreadyRunning && started.pid) {
        stopPanelGroup(started.pid);
      }
    },
  });
  if (after.state === 'aborted') {
    ui.error(after.detail);
    return { ok: false, reason: 'aborted', url };
  }
  if (after.state !== 'usable') {
    ui.error(after.detail);
    void before;
    return { ok: false, reason: 'no-grant', url };
  }
  return { ok: true, state: after, url };
}

/**
 * Make sure Pi is wired to a usable DeepSeek account.
 *
 * Returns `{ ok, changed, state, reason, accountChanged }`:
 *   - `ok` false with reason `no-grant` means the user has not signed in yet;
 *   - `accountChanged` is true when a *different* account took over, which is
 *     exactly the case the user cares about when their quota runs out.
 */
export async function ensureAccount({
  layout,
  ui,
  env = process.env,
  cliPath,
  open = false,
  restart = false,
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
  announce = true,
  signal = null,
} = {}) {
  const before = grantState(layout.credentialsPath);

  if (before.state === 'usable' && !restart) {
    const wiring = wireSharedProvider({ layout, cliPath });
    if (announce) {
      ui.ok('account', `connected to ${before.issuer ?? 'DeepSeek'}`);
      ui.aside(`Pi reads the token on demand; nothing is stored in models.json (${wiring.modelsPath}).`);
    }
    return { ok: true, changed: false, state: before, reason: null, accountChanged: false, url: null };
  }

  const presented = await presentSignIn({ layout, ui, env, open, restart, interactive, before, signal });
  if (!presented.ok) {
    if (presented.reason === 'not-interactive') {
      return { ok: false, changed: false, state: before, reason: 'not-interactive', url: presented.url };
    }
    return { ok: false, changed: false, state: before, reason: presented.reason, url: presented.url ?? null };
  }

  // The account is real. Wiring is the last step, and it is the one that makes
  // the next `pi` start use it.
  const plan = wireSharedProvider({ layout, cliPath });
  let journal = null;
  try {
    journal = readJournal(layout.journalPath);
  } catch (error) {
    if (error instanceof JournalError) {
      ui.error(error.message);
      return { ok: false, changed: false, state: before, reason: 'journal', url: presented.url };
    }
    throw error;
  }
  if (plan.changed) persistSharedProvider({ layout, plan, journal });

  const previous = accountFingerprint(before);
  const current = accountFingerprint(presented.state);
  const accountChanged = previous !== null && current !== null && previous !== current;

  ui.ok('account', `connected to ${presented.state.issuer ?? 'DeepSeek'}`);
  if (accountChanged) ui.ok('switched', 'a different account is now in use');
  ui.aside(`Pi picks it up on its next start, through ${plan.provider.headers['x-dsh-auth-token'].slice(1)}`);

  return { ok: true, changed: plan.changed, state: presented.state, reason: null, accountChanged, url: presented.url };
}
