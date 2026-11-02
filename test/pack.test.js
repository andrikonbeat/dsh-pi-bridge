import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './helpers.js';

/**
 * What we publish is part of the product.
 *
 * This check existed only in CI, which meant a broken tarball was discovered
 * after a push instead of before one — and it broke for a reason nobody would
 * guess: `npm pack --json` returns an array on npm 10 and an object keyed by
 * package name on npm 11 and later. It runs here, with the same tolerance, so
 * `node --test` is enough to know the release is sound.
 */

const REQUIRED = [
  'bin/cli.js',
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
  'docs/troubleshooting.md',
];

/** Working notes, tests, CI and anything machine-specific must never ship. */
const FORBIDDEN = [
  /^\.atl\//,
  /^backups\//,
  /^odd\//,
  /^test\//,
  /^\.github\//,
  /skill-registry/,
  /\.log$/,
  /\.credentials/,
  /(^|\/)auth\.json$/,
  /\.tgz$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
];

function packDocument() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `npm pack failed: ${result.stderr}`);
  const raw = JSON.parse(result.stdout);
  const pack = Array.isArray(raw) ? raw[0] : Object.values(raw)[0];
  assert.ok(pack?.files?.length > 0, 'the pack document carries a file list');
  return pack;
}

describe('published package', () => {
  const pack = packDocument();
  const names = pack.files.map((file) => file.path);

  it('carries everything a user needs, including the security policy', () => {
    const missing = REQUIRED.filter((path) => !names.includes(path));
    assert.deepEqual(missing, [], `missing from the tarball: ${missing.join(', ')}`);
  });

  it('never ships working notes, tests, CI or machine-specific files', () => {
    const leaked = names.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));
    assert.deepEqual(leaked, [], `private paths in the tarball: ${leaked.join(', ')}`);
  });

  it('ships the CLI entry point as an executable script', () => {
    const entry = pack.files.find((file) => file.path === 'bin/cli.js');
    assert.ok(entry, 'bin/cli.js is packed');
    assert.equal(entry.mode & 0o111, 0o111, 'bin/cli.js is executable');
  });

  it('declares the same version the manifest declares', () => {
    const manifest = JSON.parse(
      spawnSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).stdout,
    );
    assert.equal(pack.version, manifest.version);
  });
});
