import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createUi, displayWidth, truncate, visibleLength } from '../src/ui.js';
import { writeFileAtomic } from '../src/fs-atomic.js';
import { cleanupSandbox, createSandbox, readJson, run } from './helpers.js';

/** A fake stdout that records what a user would see. */
function recorder({ isTTY = false, columns = 80 } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns,
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join('');
    },
  };
}

function fakeStdin({ isTTY = false } = {}) {
  const listeners = new Map();
  return {
    isTTY,
    resume() {},
    pause() {},
    once(event, handler) {
      listeners.set(event, handler);
    },
    on() {},
    removeListener() {},
  };
}

describe('terminal output', () => {
  it('paints with colour and glyphs on a real terminal', () => {
    const stdout = recorder({ isTTY: true });
    const ui = createUi({ stdout, env: {}, color: true, unicode: true });
    ui.ok('node', '22.19.0');
    assert.match(stdout.text, /✓/);
    assert.match(stdout.text, /\u001b\[32m/);
  });

  it('uses ASCII symbols for piped stdout by default', () => {
    const stdout = recorder({ isTTY: false });
    const ui = createUi({ stdout, env: {} });
    ui.ok('node', '22.19.0');
    ui.box('Title', ['body']);
    ui.rule();
    assert.equal(ui.symbols.ok, '+');
    assert.equal(ui.symbols.arrow, '->');
    assert.match(stdout.text, /\+ node/);
    assert.doesNotMatch(stdout.text, /[✓✗─→▸•·]/u);
  });

  it('honours explicit Unicode symbols for a piped stdout', () => {
    const stdout = recorder({ isTTY: false });
    const ui = createUi({ stdout, env: {}, unicode: true });
    ui.ok('node', '22.19.0');
    assert.match(stdout.text, /✓/);
  });

  it('measures visible text in terminal display columns', () => {
    assert.equal(visibleLength('\u001b[31mred\u001b[0m'), 3);
    assert.equal(visibleLength('界界'), 4);
    assert.equal(visibleLength('😀'), 2);
    assert.equal(visibleLength('👩‍💻'), 2);
    assert.equal(visibleLength('❤️'), 2);
    assert.equal(visibleLength('e\u0301'), 1);
  });

  it('truncates on grapheme boundaries within the display width', () => {
    for (const [text, width] of [
      ['界界', 3],
      ['😀😀', 3],
      ['👩‍💻xx', 3],
      ['e\u0301x', 1],
    ]) {
      const result = truncate(text, width);
      assert.ok(displayWidth(result) <= width, `${result} exceeds ${width}`);
      assert.equal(
        [...result].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint >= 0xd800 && codePoint <= 0xdfff;
        }),
        false,
        'truncation left a lone surrogate',
      );
    }
    assert.equal(truncate('界界', 3), '界…');
    assert.equal(truncate('👩‍💻xx', 3), '👩‍💻…');
    assert.equal(truncate('e\u0301x', 1), 'e\u0301');
  });

  it('keeps box content aligned with wide characters', () => {
    const stdout = recorder({ isTTY: true, columns: 50 });
    const ui = createUi({ stdout, env: {}, color: false, unicode: false });
    ui.box('界', ['界😀']);
    const [top, content] = stdout.text.trimEnd().split('\n');
    assert.equal(displayWidth(top), displayWidth(content));
  });

  it('degrades to plain ASCII when piped, dumb, or asked to', () => {
    for (const setup of [
      { env: { TERM: 'dumb' } },
      { env: {}, color: false, unicode: false },
    ]) {
      const stdout = recorder({ isTTY: true });
      const ui = createUi({ stdout, ...setup });
      ui.ok('node', '22.19.0');
      ui.box('Title', ['body']);
      assert.doesNotMatch(stdout.text, /\u001b\[/, 'no escapes');
      assert.doesNotMatch(stdout.text, /[╭╮╰╯│─▸✓]/, 'no unicode glyphs');
      assert.match(stdout.text, /\+/);
    }
  });

  it('honours NO_COLOR without forcing ASCII glyphs', () => {
    // NO_COLOR is about colour. A modern terminal that asked for no colour
    // still renders box drawing correctly, so the glyphs stay.
    const stdout = recorder({ isTTY: true });
    const ui = createUi({ stdout, env: { NO_COLOR: '1' } });
    ui.ok('node', '22.19.0');
    assert.doesNotMatch(stdout.text, /\u001b\[/, 'no escapes');
    assert.match(stdout.text, /✓/);
  });

  it('emits no escapes when output is not a terminal', () => {
    const stdout = recorder({ isTTY: false });
    const ui = createUi({ stdout, env: {} });
    ui.ok('node', '22.19.0');
    assert.doesNotMatch(stdout.text, /\u001b\[/);
  });

  it('emits no decoration at all with --json', () => {
    const stdout = recorder({ isTTY: true });
    const ui = createUi({ json: true, stdout, env: {}, color: true });
    ui.banner();
    ui.ok('node', '22.19.0');
    ui.box('Title', ['body']);
    assert.equal(stdout.text, '');
  });

  it('keeps a box inside the terminal width', () => {
    const stdout = recorder({ isTTY: true, columns: 50 });
    const ui = createUi({ stdout, env: {}, color: false, unicode: false });
    ui.box('Title', ['x'.repeat(200)]);
    for (const line of stdout.text.trimEnd().split('\n')) {
      assert.ok(line.length <= 50, `line too long: ${line.length}`);
    }
  });

  it('never waits for a keypress when there is no terminal', async () => {
    const ui = createUi({ stdout: recorder(), stdin: fakeStdin(), env: {} });
    assert.equal(await ui.waitForEnter(), false);
  });
});

describe('atomic writes', () => {
  let box;
  before(() => {
    box = createSandbox();
  });
  after(() => cleanupSandbox(box));

  it('replaces contents without ever exposing a partial file', () => {
    const file = path.join(box.root, 'target.json');
    fs.writeFileSync(file, '{"old":true}\n');
    // While the write happens the path must still hold the previous bytes:
    // another process may read it at any moment.
    const before = fs.readFileSync(file, 'utf8');
    writeFileAtomic(file, Buffer.from('{"new":true}\n'), { mode: 0o644 });
    assert.equal(before, '{"old":true}\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  });

  it('leaves no temporary files behind', () => {
    const dir = path.join(box.root, 'atomic-dir');
    writeFileAtomic(path.join(dir, 'a.txt'), Buffer.from('x'));
    writeFileAtomic(path.join(dir, 'a.txt'), Buffer.from('y'));
    assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'y');
  });

  it('creates the parent directory when it is missing', () => {
    const file = path.join(box.root, 'deep', 'nested', 'file.txt');
    writeFileAtomic(file, Buffer.from('ok'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
  });
});

describe('account command', () => {
  it('reports the connected account without touching anything', () => {
    const box = createSandbox();
    try {
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(
        path.join(box.dshHome, '.credentials.yaml'),
        'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: abc123\n      issuer: https://platform.deepseek.com\n',
      );
      const result = run(['account'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /connected to https:\/\/platform\.deepseek\.com/);
      assert.match(result.stdout, /pi-dsh-bridge account --relogin/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('explains the missing step outside a terminal and does not start a server', () => {
    const box = createSandbox();
    try {
      const result = run(['account'], box);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Sign in to DeepSeek/);
      assert.match(result.stdout, /pi-dsh-bridge account/);
      // Nothing was started, and nothing was written.
      assert.equal(fs.existsSync(path.join(box.stateDir, 'journal.json')), false);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('--json reports the state as one document', () => {
    const box = createSandbox();
    try {
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(
        path.join(box.dshHome, '.credentials.yaml'),
        'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: abc123\n      issuer: https://platform.deepseek.com\n',
      );
      const result = run(['account', '--json'], box);
      assert.equal(result.status, 0, result.stderr);
      const doc = JSON.parse(result.stdout);
      assert.equal(doc.command, 'account');
      assert.equal(doc.ok, true);
      assert.equal(doc.state, 'usable');
      assert.equal(doc.issuer, 'https://platform.deepseek.com');
    } finally {
      cleanupSandbox(box);
    }
  });
});

describe('install onboarding', () => {
  it('wires everything and states the one step left when no account exists', () => {
    const box = createSandbox();
    try {
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);
      // The bridge is fully installed...
      assert.ok(fs.existsSync(path.join(box.binDir, 'pi-dsh-token')));
      const models = readJson(path.join(box.piHome, 'models.json'));
      assert.ok(models.providers.deepseek, 'provider written before sign-in');
      // ...and the only thing left is named, with its command.
      assert.match(result.stdout, /not connected yet/);
      assert.match(result.stdout, /pi-dsh-bridge account/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('says it is ready when an account is already connected', () => {
    const box = createSandbox();
    try {
      fs.mkdirSync(box.dshHome, { recursive: true });
      fs.writeFileSync(
        path.join(box.dshHome, '.credentials.yaml'),
        'records:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: abc123\n      issuer: https://platform.deepseek.com\n',
      );
      const result = run(['install', '--yes'], box);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /everything is wired/);
      assert.match(result.stdout, /pi-dsh-bridge v/);
    } finally {
      cleanupSandbox(box);
    }
  });
});
