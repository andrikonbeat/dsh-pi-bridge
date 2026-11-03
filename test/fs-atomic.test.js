import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../src/fs-atomic.js';
import { cleanupSandbox, createSandbox } from './helpers.js';

/** Temporary files this module may have left behind in `dir`. */
function tempFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('.') && name.includes('.tmp-'));
}

/** Replace a method on the shared `fs` object for the duration of `body`. */
async function withBrokenFs(method, error, body) {
  const original = fs[method];
  fs[method] = () => {
    throw error;
  };
  try {
    return await body();
  } finally {
    fs[method] = original;
  }
}

describe('writeFileAtomic', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('writes the bytes and creates parent directories', () => {
    const file = path.join(sandbox.root, 'a', 'b', 'c', 'file.txt');
    writeFileAtomic(file, Buffer.from('hello atomic world'));
    assert.deepEqual(fs.readFileSync(file), Buffer.from('hello atomic world'));
  });

  it('applies the requested mode', () => {
    const file = path.join(sandbox.root, 'mode.txt');
    writeFileAtomic(file, Buffer.from('x'), { mode: 0o644 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  });

  it('replaces an existing file', () => {
    const file = path.join(sandbox.root, 'replace.txt');
    fs.writeFileSync(file, 'old');
    writeFileAtomic(file, Buffer.from('new'));
    assert.deepEqual(fs.readFileSync(file), Buffer.from('new'));
  });

  it('leaves no temporary file behind when writeFileSync fails (S4-1)', async () => {
    const dir = path.join(sandbox.root, 'write-failure');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');

    await withBrokenFs('writeFileSync', Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }), () => {
      assert.throws(() => writeFileAtomic(file, Buffer.from('data')), /ENOSPC/);
    });

    assert.deepEqual(tempFiles(dir), []);
    assert.equal(fs.existsSync(file), false, 'the target was never created');
  });

  it('leaves no temporary file behind when fchmodSync fails (S4-1)', async () => {
    const dir = path.join(sandbox.root, 'chmod-failure');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');

    await withBrokenFs('fchmodSync', Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }), () => {
      assert.throws(() => writeFileAtomic(file, Buffer.from('data'), { mode: 0o644 }), /EPERM/);
    });

    assert.deepEqual(tempFiles(dir), []);
    assert.equal(fs.existsSync(file), false, 'the target was never created');
  });

  it('leaves no temporary file behind when fsyncSync fails (S4-1)', async () => {
    const dir = path.join(sandbox.root, 'fsync-failure');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');

    await withBrokenFs('fsyncSync', Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }), () => {
      assert.throws(() => writeFileAtomic(file, Buffer.from('data')), /EIO/);
    });

    assert.deepEqual(tempFiles(dir), []);
    assert.equal(fs.existsSync(file), false, 'the target was never created');
  });

  it('leaves no temporary file behind when the rename fails (S4-1)', async () => {
    const dir = path.join(sandbox.root, 'rename-failure');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');

    await withBrokenFs('renameSync', Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }), () => {
      assert.throws(() => writeFileAtomic(file, Buffer.from('data')), /EXDEV/);
    });

    assert.deepEqual(tempFiles(dir), []);
  });

  it('fsyncs the parent directory after the rename (S4-2)', () => {
    const dir = path.join(sandbox.root, 'durable');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');

    const original = fs.fsyncSync;
    const synced = [];
    fs.fsyncSync = (fd) => {
      synced.push(fd);
      return original.call(fs, fd);
    };
    try {
      writeFileAtomic(file, Buffer.from('durable'));
    } finally {
      fs.fsyncSync = original;
    }

    assert.equal(synced.length, 2, 'the file is fsynced and then the directory');
    assert.deepEqual(fs.readFileSync(file), Buffer.from('durable'));
  });
});