import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  loadModels,
  parseModels,
  programFromCommand,
  renderModels,
  tokenCommand,
  ModelsParseError,
  ModelsShapeError,
} from '../src/models.js';
import { cleanupSandbox, createSandbox } from './helpers.js';

describe('models.js', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('parseModels accepts valid JSON', () => {
    const data = parseModels(Buffer.from('{"providers":{}}'), 'test.json');
    assert.deepEqual(data, { providers: {} });
  });

  it('parseModels rejects non-object top level', () => {
    assert.throws(
      () => parseModels(Buffer.from('[]'), 'test.json'),
      (e) => e instanceof ModelsParseError && e.message.includes('expected a JSON object')
    );
  });

  it('parseModels strips UTF-8 BOM (S4-4)', () => {
    const withBom = Buffer.from('\ufeff{"providers":{}}', 'utf8');
    const data = parseModels(withBom, 'test.json');
    assert.deepEqual(data, { providers: {} });
  });

  it('loadModels rejects providers as array (S4-5)', () => {
    const file = path.join(sandbox.root, 'models-array.json');
    fs.writeFileSync(file, '{"providers":[]}');
    assert.throws(
      () => loadModels(file),
      (e) =>
        e instanceof ModelsShapeError &&
        e.message.includes('`providers` must be an object, not an array') &&
        e.message.includes('Refusing to write'),
    );
  });

  it('loadModels rejects providers as string (S4-5)', () => {
    const file = path.join(sandbox.root, 'models-string.json');
    fs.writeFileSync(file, '{"providers":"not an object"}');
    assert.throws(
      () => loadModels(file),
      (e) =>
        e instanceof ModelsShapeError &&
        e.message.includes('`providers` must be an object, not string') &&
        e.message.includes('Refusing to write'),
    );
  });

  it('loadModels accepts a missing providers key', () => {
    const file = path.join(sandbox.root, 'models-no-providers.json');
    fs.writeFileSync(file, '{"other":true}');
    assert.ok(loadModels(file).data);
  });

  it('loadModels accepts valid providers object', () => {
    const file = path.join(sandbox.root, 'models-valid.json');
    fs.writeFileSync(file, '{"providers":{"deepseek":{}}}');
    const result = loadModels(file);
    assert.equal(result.exists, true);
    assert.ok(result.data);
  });

  it('tokenCommand POSIX single-quotes every argument (S4-3)', () => {
    const cmd = tokenCommand({ 
      program: '/path/with spaces/program', 
      dshHome: '/home/user/.dsh' 
    });
    // Should single-quote args with spaces, $, backticks, etc.
    assert.match(cmd, /^!/);
    assert.match(cmd, /'\/path\/with spaces\/program'/);
    assert.match(cmd, /'token'/);
    assert.match(cmd, /'--dsh-home'/);
    assert.match(cmd, /'\/home\/user\/.dsh'/);
  });

  it('tokenCommand quotes special shell characters (S4-3)', () => {
    const cmd = tokenCommand({ 
      program: '/path/$HOME/program', 
      dshHome: '/home/user/.dsh' 
    });
    // $ should be inside single quotes so it's literal
    assert.match(cmd, /'[^']*\$HOME[^']*'/);
  });

  it('tokenCommand quotes backticks (S4-3)', () => {
    const cmd = tokenCommand({ 
      program: '/path/`bad`/program', 
      dshHome: '/home/user/.dsh' 
    });
    assert.match(cmd, /'[^']*`bad`[^']*'/);
  });

  it('tokenCommand handles args with newlines (S4-3)', () => {
    const cmd = tokenCommand({ 
      program: '/path\nwith\nnewlines', 
      dshHome: '/home/user/.dsh' 
    });
    // Newline is literal inside single quotes
    assert.match(cmd, /'[^']*\n[^']*'/);
  });

  it('programFromCommand round-trips a program path with a single quote (S4-3)', () => {
    const program = "/path/it's/prog";
    const cmd = tokenCommand({ program, dshHome: '/home/user/.dsh' });
    assert.equal(programFromCommand(cmd), program);
  });

  it('programFromCommand round-trips the legacy JSON-quoted form (S4-3)', () => {
    // Files installed before this change carry the JSON-quoted form; doctor
    // and verify must still read the program out of them.
    assert.equal(
      programFromCommand('!"/path with spaces/prog" token --dsh-home /home/user/.dsh'),
      '/path with spaces/prog',
    );
    assert.equal(
      programFromCommand('!/plain/prog token --dsh-home /home/user/.dsh'),
      '/plain/prog',
    );
  });

  it('tokenCommand survives a real shell: the program runs and prints the token (S4-3)', () => {
    // The whole point of the quoting is that Pi's shell hands the program path
    // to the command verbatim. This runs the generated command through /bin/sh
    // for real: a path with spaces, $, backticks, a semicolon and a quote.
    const dir = path.join(sandbox.root, "weird dir $HOME `id` ; 'quote'");
    fs.mkdirSync(dir, { recursive: true });
    const program = path.join(dir, 'helper $x `y` ; z.sh');
    fs.writeFileSync(program, '#!/bin/sh\nprintf \'%s\\n\' "TOKEN-OK"\n', { mode: 0o755 });

    const cmd = tokenCommand({ program, dshHome: dir });
    const result = spawnSync('/bin/sh', ['-c', cmd.slice(1)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, 'TOKEN-OK\n');
  });

  it('tokenCommand survives a real shell with a newline in the path (S4-3)', () => {
    const dir = path.join(sandbox.root, 'new\nline');
    fs.mkdirSync(dir, { recursive: true });
    const program = path.join(dir, 'helper.sh');
    fs.writeFileSync(program, '#!/bin/sh\nprintf \'%s\\n\' "TOKEN-OK"\n', { mode: 0o755 });

    const cmd = tokenCommand({ program, dshHome: dir });
    const result = spawnSync('/bin/sh', ['-c', cmd.slice(1)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, 'TOKEN-OK\n');
  });

  it('renderModels produces two-space JSON with trailing newline', () => {
    const output = renderModels({ providers: {} });
    assert.equal(output, '{\n  "providers": {}\n}\n');
  });
});