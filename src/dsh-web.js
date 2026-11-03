import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

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
 * Resolves `{ url, alreadyRunning, error }`. It never rejects: a panel that
 * will not start is data the caller renders, not an exception.
 */
export async function startDshWeb({
  launcherPath,
  env = process.env,
  port = Number(env.DSH_PORT) || DEFAULT_PORT,
  timeoutMs = 30_000,
} = {}) {
  if (await isListening(port)) {
    return { url: null, alreadyRunning: true, port, error: null };
  }
  if (!launcherPath || !fs.existsSync(launcherPath)) {
    return {
      url: null,
      alreadyRunning: false,
      port,
      error: `the dsh web launcher is missing at ${launcherPath}; run: pi-dsh-bridge install`,
    };
  }

  const child = spawn('bash', [launcherPath], {
    env: { ...env, DSH_PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const collected = [];
  const url = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const onChunk = (chunk) => {
      const text = chunk.toString();
      collected.push(text);
      const match = text.match(TOKEN_URL);
      if (match) finish(match[0]);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      if (code !== 0) finish(null);
    });
  });

  // The panel keeps running after this CLI exits: that is the point. Detach it
  // so the CLI does not wait, and so the terminal is not held by a pipe.
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) {
      stream.removeAllListeners('data');
      stream.destroy();
    }
  }
  child.unref();

  return {
    url,
    alreadyRunning: false,
    port,
    pid: child.pid ?? null,
    error: url
      ? null
      : `dsh web did not print a sign-in URL within ${Math.round(timeoutMs / 1000)}s: ${collected
          .join('')
          .trim()
          .split('\n')
          .slice(-3)
          .join(' | ')
          .slice(0, 240)}`,
  };
}

/** Stop the panel listening on `port`, when we can identify it safely. */
export function stopDshWeb(port = DEFAULT_PORT) {
  const pid = pidOnPort(port);
  if (pid === null) {
    return { stopped: false, reason: `cannot identify the process listening on port ${port}` };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch (error) {
    return { stopped: false, reason: `could not stop pid ${pid}: ${error.message}` };
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
