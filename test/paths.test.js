import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveLayout } from '../src/paths.js';

describe('resolveLayout', () => {
  it('uses flag > env > default precedence', () => {
    const layout = resolveLayout({
      flags: { piHome: '/flag/pi', dshHome: '/flag/dsh' },
      env: {
        PI_HOME: '/env/pi',
        DSH_HOME: '/env/dsh',
        BIN_DIR: '/env/bin',
        STATE_DIR: '/env/state',
      },
      home: '/home/tester',
    });

    assert.equal(layout.piHome, '/flag/pi');
    assert.equal(layout.dshHome, '/flag/dsh');
    assert.equal(layout.binDir, '/env/bin');
    assert.equal(layout.stateDir, '/env/state');
  });

  it('falls back to portable defaults under the home directory', () => {
    const layout = resolveLayout({ flags: {}, env: {}, home: '/home/tester' });

    assert.equal(layout.piHome, path.join('/home/tester', '.pi', 'agent'));
    assert.equal(layout.dshHome, path.join('/home/tester', '.dsh'));
    assert.equal(layout.binDir, path.join('/home/tester', '.local', 'bin'));
    assert.equal(layout.stateDir, path.join('/home/tester', '.local', 'state', 'pi-dsh-bridge'));
  });

  it('derives the paths install touches', () => {
    const layout = resolveLayout({
      flags: {},
      env: { PI_HOME: '/p', DSH_HOME: '/d', BIN_DIR: '/b', STATE_DIR: '/s' },
      home: '/home/tester',
    });

    assert.equal(layout.settingsPath, path.join('/p', 'settings.json'));
    assert.equal(layout.authPath, path.join('/p', 'auth.json'));
    assert.equal(layout.launcherPath, path.join('/d', 'start-web.sh'));
    assert.equal(layout.wrapperPath, path.join('/b', 'pi-deepseek'));
    assert.equal(layout.journalPath, path.join('/s', 'journal.json'));
    assert.equal(layout.overlayPath, path.join('/s', 'dsh-overlay.yml'));
    assert.equal(layout.backupsDir, path.join('/s', 'backups'));
  });

  it('expands a leading ~ in a flag value', () => {
    const layout = resolveLayout({
      flags: { stateDir: '~/custom-state' },
      env: {},
      home: '/home/tester',
    });

    assert.equal(layout.stateDir, path.join('/home/tester', 'custom-state'));
  });
});
