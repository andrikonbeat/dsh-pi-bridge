import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomic file writes.
 *
 * Several of the files this tool installs are read by *other* processes while
 * they run: Pi executes the token helper on every request, and it parses
 * `models.json` when it starts. A plain `writeFileSync` truncates the file
 * first, so a reader that arrives in that window sees an empty or half-written
 * file — a script that fails, or JSON that does not parse.
 *
 * Writing to a sibling temporary file and then renaming it is atomic on POSIX:
 * a reader sees either the old bytes or the new bytes, never a mixture. It
 * also avoids `ETXTBSY` when the target is an executable another process has
 * open.
 *
 * The temporary file is created in the same directory on purpose; `rename`
 * is only atomic within one filesystem.
 */
export function writeFileAtomic(file, bytes, { mode } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const suffix = randomBytes(6).toString('hex');
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${suffix}`);

  // `wx` refuses to reuse an existing path, so a collision can never make us
  // write through somebody else's file.
  const handle = fs.openSync(temp, 'wx', mode ?? 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    if (mode !== undefined) fs.fchmodSync(handle, mode);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.renameSync(temp, file);
  } catch (error) {
    // Never leave a stray temporary file behind if the rename could not happen.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error;
  }
}
