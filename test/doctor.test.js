import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSandbox, createSandbox, run } from './helpers.js';

const SECRET = 'sk-super-secret-value-1234';

function checkById(doc, id) {
  return doc.checks.find((check) => check.id === id);
}

describe('doctor', () => {
  let sandbox;
  before(() => {
    sandbox = createSandbox();
  });
  after(() => cleanupSandbox(sandbox));

  it('--json emits valid JSON with the documented checks', () => {
    const box = createSandbox({
      settings: { defaultProvider: 'deepseek', defaultModel: 'deepseek-flash' },
      auth: { deepseek: { key: SECRET } },
    });
    try {
      assert.equal(run(['install', '--yes'], box).status, 0);
      const result = run(['doctor', '--json'], box);
      assert.equal(result.status, 0, result.stderr);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.command, 'doctor');
      assert.equal(doc.ok, true);
      assert.ok(Array.isArray(doc.checks));
      assert.ok(doc.checks.length >= 9, 'at least the nine documented checks');
      for (const check of doc.checks) {
        assert.ok(['ok', 'warn', 'fail'].includes(check.status), check.status);
        assert.equal(typeof check.detail, 'string');
        assert.equal(typeof check.title, 'string');
      }
      for (const id of ['node', 'pi', 'dsh', 'settings', 'credential', 'dsh-account', 'bridge', 'token-helper', 'launcher', 'wrapper', 'dsh-route', 'state']) {
        assert.ok(checkById(doc, id), `missing check: ${id}`);
      }
      assert.equal(checkById(doc, 'pi').status, 'ok');
      // Presence is not working: a stored key cannot be proven usable
      // offline, so it is reported as present and unproven.
      assert.equal(checkById(doc, 'credential').status, 'warn');
      assert.match(checkById(doc, 'credential').detail, /balance not checked offline/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('fails (exit 1) when pi is missing from PATH', () => {
    const box = createSandbox();
    try {
      const result = run(['doctor', '--json'], box, { env: { PATH: box.dshOnlyBin } });
      assert.equal(result.status, 1);

      const doc = JSON.parse(result.stdout);
      assert.equal(doc.ok, false);
      const pi = checkById(doc, 'pi');
      assert.equal(pi.status, 'fail');
      assert.match(pi.detail, /PATH/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('warns on a dsh version outside the compatibility matrix', () => {
    const box = createSandbox();
    try {
      const result = run(['doctor', '--json'], box, { env: { FAKE_DSH_VERSION: '9.9.9' } });
      assert.equal(result.status, 0, 'a version outside the matrix is a warning, not a failure');

      const doc = JSON.parse(result.stdout);
      const dsh = checkById(doc, 'dsh');
      assert.equal(dsh.status, 'warn');
      assert.match(dsh.detail, /9\.9\.9/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('reports credential presence without printing the value', () => {
    const box = createSandbox({ auth: { deepseek: { key: SECRET } } });
    try {
      const human = run(['doctor'], box);
      assert.doesNotMatch(human.stdout, new RegExp(SECRET));
      assert.doesNotMatch(human.stderr, new RegExp(SECRET));
      assert.match(human.stdout, /credential/i);

      const json = run(['doctor', '--json'], box);
      assert.doesNotMatch(json.stdout, new RegExp(SECRET));
      const doc = JSON.parse(json.stdout);
      assert.equal(checkById(doc, 'credential').status, 'warn');
      assert.match(checkById(doc, 'credential').detail, /present/);
      assert.match(checkById(doc, 'credential').detail, /balance not checked offline/);
    } finally {
      cleanupSandbox(box);
    }
  });

  it('warns, but does not fail, when nothing has been installed yet', () => {
    const box = createSandbox();
    try {
      const result = run(['doctor', '--json'], box);
      assert.equal(result.status, 0, result.stderr);
      const doc = JSON.parse(result.stdout);
      assert.equal(checkById(doc, 'launcher').status, 'warn');
      assert.equal(checkById(doc, 'wrapper').status, 'warn');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('fails when settings.json does not parse', () => {
    const box = createSandbox({ settings: '{ nope' });
    try {
      const result = run(['doctor', '--json'], box);
      assert.equal(result.status, 1);
      const doc = JSON.parse(result.stdout);
      assert.equal(checkById(doc, 'settings').status, 'fail');
    } finally {
      cleanupSandbox(box);
    }
  });

  it('passes a dsh route probe in a healthy sandbox', () => {
    const box = createSandbox();
    try {
      const result = run(['doctor', '--json'], box);
      const doc = JSON.parse(result.stdout);
      const route = checkById(doc, 'dsh-route');
      assert.equal(route.status, 'ok');
      assert.match(route.detail, /deepseek-account/);
    } finally {
      cleanupSandbox(box);
    }
  });
});
