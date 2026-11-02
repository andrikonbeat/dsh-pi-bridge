import fs from 'node:fs';
import path from 'node:path';

import { assetPath } from './paths.js';

const HELPER_ASSET = 'pi-dsh-token.sh';

/**
 * The small helper Pi calls to obtain the account token.
 *
 * It lives in the user's bin directory so the path recorded in `models.json`
 * survives an `npx` cache clean and a package upgrade. The helper resolves
 * the CLI at call time, preferring the copy it was installed from and
 * falling back to whatever `pi-dsh-bridge` is on PATH.
 */
export function renderHelper({ cliPath, dshHome }) {
  const template = fs.readFileSync(assetPath(HELPER_ASSET), 'utf8');
  return template
    .replaceAll('__CLI_PATH__', cliPath)
    .replaceAll('__DSH_HOME__', dshHome);
}

/**
 * The program Pi should run for the token.
 *
 * The installed helper wins: it is a stable path. The CLI itself is the
 * fallback for a checkout that was never installed, which is how the test
 * suite and a developer's own machine work.
 */
export function tokenProgram({ layout, cliPath }) {
  if (layout.tokenHelperPath && fs.existsSync(layout.tokenHelperPath)) {
    return layout.tokenHelperPath;
  }
  return cliPath;
}
