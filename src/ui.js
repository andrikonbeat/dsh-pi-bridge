const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const SYMBOLS = {
  ok: 'ok  ',
  warn: 'warn',
  fail: 'fail',
  info: '  · ',
};

/**
 * TTY-aware output. With `--json` the human lines are suppressed on stdout so
 * that stdout carries exactly one machine-readable document; diagnostics still
 * go to stderr.
 */
export function createUi({
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  color,
} = {}) {
  const useColor =
    color ??
    (stdout.isTTY === true &&
      !env.NO_COLOR &&
      env.TERM !== 'dumb' &&
      env.FORCE_COLOR !== '0');

  const paint = (code, text) => (useColor ? `${CODES[code]}${text}${CODES.reset}` : text);

  const write = (stream, text) => {
    stream.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  return {
    json,

    line(text = '') {
      if (!json) write(stdout, text);
    },

    /** A status line: `ok  label: detail`. */
    status(status, label, detail = '') {
      if (json) return;
      const symbol = SYMBOLS[status] ?? SYMBOLS.info;
      const color = status === 'ok' ? 'green' : status === 'warn' ? 'yellow' : status === 'fail' ? 'red' : 'dim';
      const head = paint(color, symbol);
      const tail = detail ? ` ${label}: ${detail}` : ` ${label}`;
      write(status === 'fail' ? stderr : stdout, `${head}${tail}`);
    },

    ok(label, detail = '') {
      this.status('ok', label, detail);
    },
    warn(label, detail = '') {
      this.status('warn', label, detail);
    },
    fail(label, detail = '') {
      this.status('fail', label, detail);
    },
    info(label, detail = '') {
      this.status('info', label, detail);
    },

    /** Errors are always reported on stderr, with or without `--json`. */
    error(text) {
      write(stderr, paint('red', `error: ${text}`));
    },

    note(text) {
      write(stderr, text);
    },

    heading(text) {
      write(stdout, paint('bold', text));
    },

    write(text) {
      write(stdout, text);
    },

    /** Emit the single machine-readable document for `--json` runs. */
    emitJson(document) {
      write(stdout, JSON.stringify(document, null, 2));
    },
  };
}
