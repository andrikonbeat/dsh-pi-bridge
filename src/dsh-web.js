import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Starting and finding the dsh web panel.
 *
 * The panel is where a DeepSeek account is signed in, and it is the only place
 * that can mint the account grant this bridge depends on. It is also the one
 * thing a user loses track of: the URL carries a session token that is printed
 * once, when the server boots.
 *
 * So this module does two jobs and nothing else: find out whether the panel is
 * already listening, and start it in a way that lets us read that first URL out
 * of its output.
 */

export const DEFAULT_PORT = 3080;

/** A URL that carries the panel's session token. */
const TOKEN_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?\?token=[A-Za-z0-9._~-]+/;

/**
 * How long the wait keeps listening for output after the launcher exits.
 *
 * Long enough for a pipe that still has a writer on it to deliver what is
 * already buffered, short enough that a stream nobody closes cannot hold the
 * wait for the whole timeout.
 */
const EXIT_DRAIN_GRACE_MS = 500;

/**
 * How often the panel's output file is read while waiting for its URL.
 */
const OUTPUT_POLL_MS = 100;

/**
 * Where the panel's output is written when this process starts it.
 *
 * A pipe belongs to the process that created it: when that process exits, the
 * pipe closes, and the panel's next log line lands on a closed pipe and kills
 * it. dsh logs at runtime (a failed model listing, a gateway error), so a
 * panel started through a pipe died on its first message and took the web UI
 * with it. A file has no reader to lose: the panel keeps writing to it after
 * this process is gone.
 */
function panelOutputPath(port, logDir) {
  return path.join(logDir, `pi-dsh-bridge-web-${port}.log`);
}

/** The one message a bad `DSH_PORT` produces. */
export function portError(value) {
  return `DSH_PORT must be an integer between 1 and 65535, got "${value}"`;
}

/**
 * Resolve the panel port once, here.
 *
 * `0` is invalid rather than "use the default", and so is every non-integer:
 * a panel started on a port nobody asked for is worse than a message, because
 * the sign-in URL it prints then points somewhere the user will not look.
 *
 * Returns `{ port, error }`; `port` is null when the value is not usable.
 */
export function resolveDshPort(port, env = process.env) {
  const raw =
    port === undefined || port === null
      ? Object.prototype.hasOwnProperty.call(env, 'DSH_PORT')
        ? env.DSH_PORT
        : undefined
      : port;
  if (raw === undefined) return { port: DEFAULT_PORT, error: null };
  const text = String(raw);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65535) {
    return { port: null, error: portError(text) };
  }
  return { port: value, error: null };
}

/** True when something accepts TCP connections on `port` of the loopback. */
export function isListening(port = DEFAULT_PORT, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Ask the port two questions in one connection: is anything listening, and
 * does it answer HTTP?
 *
 * A TCP accept proves only that a socket exists. Anything can hold the port —
 * a stale process, a container proxy, a completely different service — and
 * treating that as "the panel is already serving" sends the user looking for
 * a sign-in URL that was never printed. The panel answers HTTP, so any status
 * line counts, including 401 and 403.
 *
 * Returns `{ listening, answering }`.
 */
export function probePanel(port, { host = '127.0.0.1', timeout = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    let buffer = '';
    let settled = false;
    const finish = (listening, answering) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ listening, answering });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      connected = true;
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (/^HTTP\/\d(?:\.\d)?\s+\d{3}/.test(buffer)) finish(true, true);
    });
    socket.once('timeout', () => finish(connected, false));
    socket.once('error', () => finish(false, false));
    socket.once('close', () => finish(connected, /^HTTP\//.test(buffer)));
    socket.connect(port, host);
  });
}

/**
 * The pid listening on `port`, when the platform can tell us.
 *
 * Only Linux with `ss` is supported on purpose: guessing from `lsof` output or
 * `fuser` exit codes is how a "restart" turns into killing the wrong thing. A
 * platform we cannot read returns null, and the caller says so instead of
 * pretending.
 */
export function pidOnPort(port = DEFAULT_PORT) {
  if (process.platform !== 'linux') return null;
  const result = spawnSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0 || !result.stdout) return null;
  const match = result.stdout.match(/pid=(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Start the panel and read the tokenised URL it prints.
 *
 * Resolves `{ url, alreadyRunning, port, pid, error }`. It never rejects: a
 * panel that will not start is data the caller renders, not an exception.
 *
 * `killGroup` is injectable so the "no URL, no orphan" path can be tested
 * without signalling anything on the host.
 */
export async function startDshWeb({
  launcherPath,
  env = process.env,
  port,
  timeoutMs = 30_000,
  logDir = os.tmpdir(),
  killGroup = (target, signal) => process.kill(target, signal),
} = {}) {
  const resolved = resolveDshPort(port, env);
  if (resolved.error) {
    return { url: null, alreadyRunning: false, port: null, pid: null, error: resolved.error };
  }
  const chosen = resolved.port;

  const panel = await probePanel(chosen);
  if (panel.answering) {
    return { url: null, alreadyRunning: true, port: chosen, pid: null, error: null };
  }
  if (panel.listening) {
    return {
      url: null,
      alreadyRunning: false,
      port: chosen,
      pid: null,
      error:
        `port ${chosen} is held by something that is not the dsh web panel ` +
        '(it accepts connections but returns no HTTP response); the panel was not started',
    };
  }

  if (!launcherPath || !fs.existsSync(launcherPath)) {
    return {
      url: null,
      alreadyRunning: false,
      port: chosen,
      pid: null,
      error: `the dsh web launcher is missing at ${launcherPath}; run: pi-dsh-bridge install`,
    };
  }

  const outputPath = panelOutputPath(chosen, logDir);
  let outputFd = null;
  try {
    outputFd = fs.openSync(outputPath, 'w');
  } catch (error) {
    return {
      url: null,
      alreadyRunning: false,
      port: chosen,
      pid: null,
      error: `the panel output file could not be opened at ${outputPath}: ${error.message}`,
    };
  }

  const child = spawn('bash', [launcherPath], {
    env: { ...env, DSH_PORT: String(chosen) },
    detached: true,
    // The panel writes to a file, not to a pipe of this process: a pipe dies
    // with this process, and the panel's first log line after that would
    // kill it. The file outlives the CLI, so the panel outlives it too.
    stdio: ['ignore', outputFd, outputFd],
  });
  fs.closeSync(outputFd);

  const readOutput = () => {
    try {
      return fs.readFileSync(outputPath, 'utf8');
    } catch {
      return '';
    }
  };

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      resolve(value);
    };
    const poll = () => {
      // Match the whole file, not a chunk: the URL can be split across two
      // writes and is then never whole inside either.
      const match = readOutput().match(TOKEN_URL);
      if (match) finish({ url: match[0], reason: null });
    };
    const poller = setInterval(poll, OUTPUT_POLL_MS);
    poller.unref?.();
    const timer = setTimeout(() => finish({ url: null, reason: 'timeout' }), timeoutMs);
    child.once('error', (error) => finish({ url: null, reason: 'error', error }));
    // Any exit settles the wait, whatever the code: a launcher that exits 0
    // without printing a URL will never print one afterwards, so burning the
    // whole timeout only delays the truth.
    //
    // The exit does not settle it *immediately*: the process can be gone
    // while its output is still being written, because a launcher that
    // leaves a child behind (a shell backgrounding its worker) exits first
    // and the child's output arrives after. Settling on the exit alone
    // throws that URL away, and the user is told the panel never printed
    // one. So the exit waits a short grace period and reads the file once
    // more before telling the truth.
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        const match = readOutput().match(TOKEN_URL);
        if (match) finish({ url: match[0], reason: null });
        else finish({ url: null, reason: 'exit', code, signal });
      }, EXIT_DRAIN_GRACE_MS).unref?.();
    });
    poll();
  });

  if (!outcome.url && child.pid) {
    // No URL means this child will never hand over the tokenised address, so it
    // must not keep the port: an orphan makes every later run report a running
    // panel whose sign-in URL can no longer be recovered.
    try {
      killGroup(-child.pid, 'SIGTERM');
    } catch {
      // Best effort: the child may already be gone, which is the wanted state.
    }
  }
  child.unref();

  return {
    url: outcome.url,
    alreadyRunning: false,
    port: chosen,
    pid: child.pid ?? null,
    error: outcome.url ? null : failureMessage(outcome, readOutput(), timeoutMs),
  };
}

/** The last few captured lines, for a message the user can act on. */
function capturedOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'no output';
  return trimmed.split('\n').slice(-3).join(' | ').slice(0, 240);
}

function failureMessage(outcome, outputText, timeoutMs) {
  if (outcome.reason === 'exit') {
    const how = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`;
    return `dsh web exited (${how}) without printing a sign-in URL: ${capturedOutput(outputText)}`;
  }
  if (outcome.reason === 'error') {
    return `dsh web could not be started: ${outcome.error?.message ?? 'unknown error'}`;
  }
  return `dsh web did not print a sign-in URL within ${Math.round(timeoutMs / 1000)}s: ${capturedOutput(outputText)}`;
}

/** Read a process command line, or null when it cannot be read. */
export function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter((part) => part.length > 0).join(' ').trim();
  } catch {
    return null;
  }
}

/** True when a command line identifies the dsh web panel. */
function identifiesPanel(cmdline, launcherPath) {
  if (launcherPath && cmdline.includes(launcherPath)) return true;
  const lower = cmdline.toLowerCase();
  return /\bdsh\b/.test(lower) && /\bweb\b/.test(lower);
}

/**
 * Stop the panel listening on `port`, when we can identify it safely.
 *
 * Signalling whatever happens to hold a port is how a "restart" kills an
 * unrelated service. So the pid is only signalled when its command line says
 * it is the panel. `pid`, `readCmdline`, `launcherPath` and `kill` are
 * injectable so the decision is testable without touching the host.
 */
export function stopDshWeb(
  port = DEFAULT_PORT,
  {
    pid = undefined,
    launcherPath = null,
    readCmdline = readProcCmdline,
    kill = (target, signal) => process.kill(target, signal),
  } = {},
) {
  const target = pid === undefined ? pidOnPort(port) : pid;
  if (target === null || target === undefined) {
    return { stopped: false, reason: `cannot identify the process listening on port ${port}` };
  }
  const cmdline = readCmdline(target);
  if (cmdline === null || cmdline === undefined) {
    return {
      stopped: false,
      reason: `pid ${target} on port ${port} is not the dsh web panel (cmdline unreadable); not touching it`,
    };
  }
  if (!identifiesPanel(cmdline, launcherPath)) {
    return {
      stopped: false,
      reason: `pid ${target} on port ${port} is not the dsh web panel (${cmdline}); not touching it`,
    };
  }
  try {
    kill(target, 'SIGTERM');
    return { stopped: true, pid: target };
  } catch (error) {
    return { stopped: false, reason: `could not stop pid ${target}: ${error.message}` };
  }
}

/**
 * Stop a panel this process started, by process group.
 *
 * The panel is spawned detached, so it leads its own group and the launcher
 * that started it may have children of its own. Signalling the group stops
 * all of them at once; signalling only the leader can leave the rest behind,
 * still holding the port.
 *
 * A group that is already gone is reported as such rather than as a failure
 * worth retrying.
 */
export function stopPanelGroup(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return { stopped: false, reason: 'no panel process to stop' };
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch (error) {
    if (error.code === 'ESRCH') {
      return { stopped: false, reason: `the panel process ${pid} is already gone` };
    }
    // The group could not be signalled (no permission, or the platform does
    // not support it): fall back to the leader alone.
    try {
      process.kill(pid, 'SIGTERM');
      return { stopped: true, pid };
    } catch (inner) {
      if (inner.code === 'ESRCH') {
        return { stopped: false, reason: `the panel process ${pid} is already gone` };
      }
      return { stopped: false, reason: `could not stop the panel process ${pid}: ${inner.message}` };
    }
  }
}

/**
 * Open a URL in the user's browser, best effort.
 *
 * A failure here is never fatal: the URL is always printed as text too, which
 * is what makes this safe on a headless box or over SSH.
 */
export function openInBrowser(url, { env = process.env } = {}) {
  const command =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true, env });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
