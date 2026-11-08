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

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const COMBINING_MARK = /[\p{Mn}\p{Me}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/u;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/gu;
const ZWJ = '\u200d';
const EMOJI_PRESENTATION_SELECTOR = '\ufe0f';
const TEXT_PRESENTATION_SELECTOR = '\ufe0e';
const KEYCAP = '\u20e3';
const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '');
}

function graphemeClusters(text) {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function isWideCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function isEmojiPresentationCluster(cluster) {
  if (cluster.includes(TEXT_PRESENTATION_SELECTOR)) return false;
  if (EMOJI_PRESENTATION.test(cluster)) return true;
  if (cluster.includes(EMOJI_PRESENTATION_SELECTOR)) {
    return EXTENDED_PICTOGRAPHIC.test(cluster) || cluster.includes(KEYCAP);
  }
  if (cluster.includes(ZWJ) && EXTENDED_PICTOGRAPHIC.test(cluster)) return true;
  if (EMOJI_MODIFIER.test(cluster)) return true;
  return (cluster.match(REGIONAL_INDICATOR)?.length ?? 0) >= 2;
}

function clusterDisplayWidth(cluster) {
  if (isEmojiPresentationCluster(cluster)) return 2;

  let width = 0;
  for (const character of cluster) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      COMBINING_MARK.test(character)
    ) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/** Display width in terminal columns, ignoring ANSI escapes. */
export function displayWidth(text) {
  let width = 0;
  for (const cluster of graphemeClusters(stripAnsi(text))) {
    width += clusterDisplayWidth(cluster);
  }
  return width;
}

/** Visible length in terminal columns. */
export function visibleLength(text) {
  return displayWidth(text);
}

function textTokens(text) {
  const tokens = [];
  let offset = 0;

  for (const match of text.matchAll(ANSI_ESCAPE)) {
    if (match.index > offset) {
      tokens.push({ type: 'text', value: text.slice(offset, match.index) });
    }
    tokens.push({ type: 'ansi', value: match[0] });
    offset = match.index + match[0].length;
  }

  if (offset < text.length) {
    tokens.push({ type: 'text', value: text.slice(offset) });
  }
  return tokens;
}

/** Truncate on grapheme boundaries without exceeding the display width. */
export function truncate(text, width) {
  if (displayWidth(text) <= width) return text;
  if (width <= 0) return '';

  const limit = width <= 1 ? width : width - 1;
  let result = '';
  let used = 0;

  for (const token of textTokens(text)) {
    if (token.type === 'ansi') {
      result += token.value;
      continue;
    }

    for (const cluster of graphemeClusters(token.value)) {
      const clusterWidth = clusterDisplayWidth(cluster);
      if (used + clusterWidth > limit) {
        if (width > 1) result += '…';
        return result;
      }
      result += cluster;
      used += clusterWidth;
    }
  }

  if (width > 1) result += '…';
  return result;
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
  const forceInteractive = env.PI_DSH_BRIDGE_FORCE_INTERACTIVE === '1';
  const isInteractive = forceInteractive || (stdin.isTTY === true && stdout.isTTY === true);
  const useColor =
    color ??
    (isInteractive && !dumb && env.NO_COLOR === undefined && env.FORCE_COLOR !== '0');
  const useUnicode = unicode ?? (stdout.isTTY === true && !dumb);
  const symbols = useUnicode ? SYMBOLS : ASCII_SYMBOLS;
  const promptMark = useUnicode ? '›' : '>';
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
    /**
     * Whether a human is present to answer a prompt.
     *
     * The commands use it to decide whether to open a browser: a headless
     * box, a CI job or an SSH session must print a URL, not launch one.
     */
    interactive: isInteractive,

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

    /**
     * A value the user has to copy exactly: a sign-in URL, a token, a path.
     *
     * It is printed on its own line and never truncated, never shortened and
     * never wrapped. A sign-in URL that loses its tail is not a sign-in URL,
     * and a narrow terminal must not decide how much of it the user gets.
     */
    copyable(text) {
      if (json) return;
      write(stdout, `  ${text}`);
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
      write(stdout, paint('gray', (useUnicode ? '─' : '-').repeat(width)));
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
     * Also resolves false on EOF (Ctrl-D) or stream close.
     */
    async waitForEnter(prompt = 'Press Enter when you are done') {
      if (json || !isInteractive) return false;
      stdout.write(`\n  ${paint('gray', prompt)} ${paint('gray', promptMark)} `);
      return new Promise((resolve) => {
        const done = () => {
          cleanup();
          resolve(true);
        };
        const onEnd = () => {
          cleanup();
          resolve(false);
        };
        const cleanup = () => {
          stdin.removeListener('data', done);
          stdin.removeListener('end', onEnd);
          stdin.removeListener('close', onEnd);
          stdin.pause();
        };
        stdin.on('end', onEnd);
        stdin.on('close', onEnd);
        stdin.resume();
        stdin.once('data', done);
      });
    },

    /**
     * Ask for confirmation in an interactive TTY.
     * Returns true only if the user explicitly answers 'y' or 'Y'.
     * Default is false (safe by default).
     * In non-interactive or --json mode, returns false without prompting.
     */
    async confirm(prompt = 'Proceed?') {
      if (json || !isInteractive) return false;
      stdout.write(`\n  ${paint('gray', prompt)} ${paint('gray', '[y/N]')} `);
      return new Promise((resolve) => {
        const done = (chunk) => {
          const answer = chunk.toString().trim().toLowerCase();
          stdin.removeListener('data', done);
          stdin.pause();
          resolve(answer === 'y' || answer === 'yes');
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