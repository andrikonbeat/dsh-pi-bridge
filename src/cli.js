import fs from 'node:fs';
import path from 'node:path';

import { packageRoot, packageVersion, resolveLayout } from './paths.js';
import { createUi } from './ui.js';
import { DOCTOR_HELP, doctor } from './commands/doctor.js';
import { INSTALL_HELP, install } from './commands/install.js';
import { UNINSTALL_HELP, uninstall } from './commands/uninstall.js';
import { VERIFY_HELP, verify } from './commands/verify.js';
import { SYNC_HELP, TOKEN_HELP, sync, token } from './commands/sync.js';
import { ACCOUNT_HELP, account } from './commands/account.js';

const COMMANDS = new Map([
  ['install', { help: INSTALL_HELP, run: install }],
  ['account', { help: ACCOUNT_HELP, run: account }],
  ['uninstall', { help: UNINSTALL_HELP, run: uninstall }],
  ['doctor', { help: DOCTOR_HELP, run: doctor }],
  ['verify', { help: VERIFY_HELP, run: verify }],
  ['sync', { help: SYNC_HELP, run: sync }],
  ['token', { help: TOKEN_HELP, run: token }],
]);

const VALUE_FLAGS = new Map([
  ['--pi-home', 'piHome'],
  ['--dsh-home', 'dshHome'],
  ['--bin-dir', 'binDir'],
  ['--state-dir', 'stateDir'],
  ['--model', 'model'],
  ['--provider', 'provider'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--check', 'check'],
  ['--relogin', 'relogin'],
  ['--restart', 'restart'],
  ['--open', 'open'],
  ['--no-open', 'noOpen'],
  ['--no-color', 'noColor'],
  ['--ascii', 'ascii'],
  ['--dry-run', 'dryRun'],
  ['-y', 'yes'],
  ['--yes', 'yes'],
  ['--json', 'json'],
  ['-h', 'help'],
  ['--help', 'help'],
  ['-V', 'version'],
  ['--version', 'version'],
]);

export const GLOBAL_USAGE = `Usage: pi-dsh-bridge <command> [options]

Commands:
  install     wire DeepSeek into Pi and connect your account
  account     show or switch the DeepSeek account Pi uses
  doctor      cheap, offline health check (never spends API credit)
  verify      end-to-end check; requires --yes (spends API credit)
  uninstall   restore exactly what install changed
  sync        re-wire Pi to the account (install does this for you)
  token       print the account token (called by Pi; --check to test it)
  help        usage

Options:
  --dry-run            print the planned changes and write nothing
  -y, --yes            do not ask for confirmation
  --json               machine-readable output
  --no-color           plain output, no ANSI colour
  --ascii              ASCII glyphs only (no box drawing, no symbols)
  --pi-home <dir>      default $PI_CODING_AGENT_DIR or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi default model, default deepseek-flash
  --provider <id>      Pi provider, default deepseek
  -h, --help           usage
  -V, --version        version

Exit codes: 0 ok, 1 check failed, 2 usage error.`;

export { packageVersion } from './paths.js';

/** Argument parsing only: no filesystem access, no side effects. */
export function parseArgv(argv = []) {
  const options = {};
  let command = null;
  let error = null;

  const tokens = [...argv];
  while (tokens.length > 0) {
    let token = tokens.shift();

    if (token === '--') {
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      let inlineValue = null;
      const equals = token.indexOf('=');
      if (equals !== -1) {
        inlineValue = token.slice(equals + 1);
        token = token.slice(0, equals);
      }

      if (BOOLEAN_FLAGS.has(token)) {
        if (inlineValue !== null) {
          error = `flag ${token} does not take a value`;
          break;
        }
        options[BOOLEAN_FLAGS.get(token)] = true;
        continue;
      }

      if (VALUE_FLAGS.has(token)) {
        let value = inlineValue;
        if (value === null) {
          value = tokens.shift();
          if (value === undefined || value.startsWith('-')) {
            error = `flag ${token} requires a value`;
            break;
          }
        }
        options[VALUE_FLAGS.get(token)] = value;
        continue;
      }

      error = `unknown option: ${token}`;
      break;
    }

    if (command === null) {
      command = token;
      continue;
    }

    error = `unexpected argument: ${token}`;
    break;
  }

  return { command, options, error };
}

function helpFor(command) {
  const known = COMMANDS.get(command);
  if (!known) return `${GLOBAL_USAGE}\n`;
  return `${known.help}\n  -h, --help           this message\n`;
}

/**
 * Entry point. Returns the process exit code: 0 ok, 1 check failed, 2 usage.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const { command, options, error } = parseArgv(argv);
  const ui = createUi({
    json: options.json === true,
    stdout: io.stdout,
    stderr: io.stderr,
    stdin: io.stdin,
    env,
    color: options.noColor === true ? false : undefined,
    unicode: options.ascii === true ? false : undefined,
  });

  if (error) {
    ui.error(error);
    ui.note(GLOBAL_USAGE);
    return 2;
  }

  if (options.version) {
    ui.write(packageVersion());
    return 0;
  }

  if (command === 'help') {
    ui.write(helpFor(null));
    return 0;
  }

  if (options.help) {
    ui.write(helpFor(command));
    return 0;
  }

  if (command === null) {
    ui.note(GLOBAL_USAGE);
    return 2;
  }

  const known = COMMANDS.get(command);
  if (!known) {
    ui.error(`unknown command: ${command}`);
    ui.note(GLOBAL_USAGE);
    return 2;
  }

  const layout = resolveLayout({
    flags: {
      piHome: options.piHome,
      dshHome: options.dshHome,
      binDir: options.binDir,
      stateDir: options.stateDir,
    },
    env,
  });

  return known.run({
    options,
    ui,
    layout,
    env,
    // The provider entry records the command Pi runs to fetch the account
    // token. It must be an absolute path to this very CLI, because Pi runs
    // it with its own working directory, which is the user's project.
    cliPath: path.join(packageRoot(), 'bin', 'cli.js'),
  });
}
