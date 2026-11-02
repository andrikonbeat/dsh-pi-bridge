const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
};

/** Symbols are chosen to read the same on a mono font and in a wide TTY. */
const SYMBOLS = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '·',
  step: '▸',
  arrow: '→',
  bullet: '•',
};

/** Degraded glyphs for terminals that cannot be trusted with Unicode. */
const ASCII_SYMBOLS = {
  ok: '+',
  warn: '!',
  fail: 'x',
  info: '-',
  step: '>',
  arrow: '->',
  bullet: '*',
};

/**
 * The mark: an arch, because that is what this tool is — a bridge between
 * two front ends and one DeepSeek account.
 *
 * It is deliberately narrow (under 40 columns) and only four lines tall so it
 * survives a split terminal, an SSH session and a screen reader.
 */
const LOGO = [
  '          ▄▄▄▄▄▄▄▄▄',
  '     ▄▄▀▀▀         ▀▀▀▄▄',
  '  ▀▀▀                     ▀▀▀',
];

const LOGO_ASCII = [
  '         ___________',
  '     ___/           \\___',
  '  ___/                  \\___',
];

const TAGLINE = 'pi ⇄ deepseek · one account, both ends';
const TAGLINE_ASCII = 'pi <-> deepseek - one account, both ends';

function clampWidth(columns, max = 76, min = 40) {
  if (!Number.isFinite(columns) || columns <= 0) return max;
  const usable = columns - 2;
  return Math.max(min, Math.min(max, usable));
}

/** Visible length, ignoring ANSI escapes. */
function visibleLength(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function truncate(text, width) {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

/**
 * TTY-aware output. With `--json` the human lines are suppressed on stdout so
 * that stdout carries exactly one machine-readable document; diagnostics still
 * go to stderr.
 *
 * Colour, Unicode glyphs and width are all decided once, here, and degrade
 * cleanly: a pipe, a dumb terminal, `NO_COLOR` or `--no-color` all produce
 * plain, complete output rather than escape sequences in a log file.
 */
export function createUi({
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  color,
  unicode,
} = {}) {
  const dumb = env.TERM === 'dumb';
  const useColor =
    color ??
    (stdout.isTTY === true &&
      !dumb &&
      env.NO_COLOR === undefined &&
      env.FORCE_COLOR !== '0');
  const useUnicode = unicode ?? !dumb;
  const symbols = useUnicode ? SYMBOLS : ASCII_SYMBOLS;
  const width = clampWidth(stdout.columns);

  const paint = (code, text) => (useColor ? `${CODES[code]}${text}${CODES.reset}` : text);

  const write = (stream, text = '') => {
    stream.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  const statusColor = (status) =>
    status === 'ok' ? 'green' : status === 'warn' ? 'yellow' : status === 'fail' ? 'red' : 'gray';

  return {
    json,
    width,
    color: useColor,
    unicode: useUnicode,
    symbols,

    line(text = '') {
      if (!json) write(stdout, text);
    },

    blank() {
      if (!json) write(stdout, '');
    },

    /** A status line: `✓ label: detail`. */
    status(status, label, detail = '') {
      if (json) return;
      const symbol = symbols[status] ?? symbols.info;
      const tone = paint(statusColor(status), symbol);
      const tail = detail ? ` ${label}${paint('gray', ':')} ${detail}` : ` ${label}`;
      write(status === 'fail' ? stderr : stdout, `${tone}${tail}`);
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
      const mark = paint('red', symbols.fail);
      write(stderr, `${mark} ${text}`);
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

    /** The mark and the one-line pitch. Suppressed for `--json` and pipes. */
    banner({ version = null, tagline = null } = {}) {
      if (json) return;
      const art = useUnicode ? LOGO : LOGO_ASCII;
      const accent = useUnicode ? TAGLINE : TAGLINE_ASCII;
      this.blank();
      for (const row of art) write(stdout, paint('cyan', row));
      const name = paint('bold', 'pi-dsh-bridge');
      const number = version ? paint('gray', ` v${version}`) : '';
      write(stdout, `   ${name}${number}`);
      write(stdout, `   ${paint('gray', tagline ?? accent)}`);
      this.blank();
    },

    /** A numbered step, so the user always knows how much is left. */
    step(index, total, text) {
      if (json) return;
      const counter = paint('gray', `[${index}/${total}]`);
      write(stdout, `${paint('cyan', symbols.step)} ${counter} ${text}`);
    },

    /** A command the user can copy, visually separated from prose. */
    cmd(text) {
      if (json) return;
      write(stdout, `   ${paint('bold', paint('magenta', text))}`);
    },

    /** A boxed message: the place where the one thing to do is stated. */
    box(title, lines, { tone = 'cyan' } = {}) {
      if (json) return;
      const glyph = useUnicode
        ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
        : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
      const inner = Math.max(10, width - 4);
      const border = (text) => paint(tone, text);
      const fill = Math.max(0, inner - visibleLength(title) - 1);
      write(
        stdout,
        `  ${border(glyph.tl + glyph.h)} ${paint('bold', title)} ${border(glyph.h.repeat(fill))}${border(glyph.tr)}`,
      );
      for (const line of lines) {
        const padded = truncate(line, inner);
        const pad = ' '.repeat(Math.max(0, inner - visibleLength(padded)));
        write(stdout, `  ${border(glyph.v)} ${padded}${pad} ${border(glyph.v)}`);
      }
      write(stdout, `  ${border(glyph.bl + glyph.h.repeat(inner + 1) + glyph.br)}`);
    },

    rule() {
      if (json) return;
      write(stdout, paint('gray', '─'.repeat(width)));
    },

    /** A dim aside, for context the user does not have to act on. */
    aside(text) {
      if (json) return;
      write(stdout, `  ${paint('gray', text)}`);
    },

    /**
     * Wait for the user to press Enter.
     *
     * Returns false immediately when there is no interactive terminal, so a
     * piped or CI run never hangs waiting for a keypress that cannot come.
     */
    async waitForEnter(prompt = 'Press Enter when you are done') {
      if (json || stdin.isTTY !== true || !stdout.isTTY) return false;
      stdout.write(`\n  ${paint('gray', prompt)} ${paint('gray', '›')} `);
      return new Promise((resolve) => {
        const done = () => {
          stdin.removeListener('data', done);
          stdin.pause();
          resolve(true);
        };
        stdin.resume();
        stdin.once('data', done);
      });
    },

    paint,
    /** Emit the single machine-readable document for `--json` runs. */
    emitJson(document) {
      write(stdout, JSON.stringify(document, null, 2));
    },
  };
}
