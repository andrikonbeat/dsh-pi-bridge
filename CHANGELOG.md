# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Hardening: the bridge can no longer destroy work it did not create, and the
things it reported about a broken credential or a lost web panel now match what
is actually on disk.

### Fixed

- `uninstall` keeps any file whose current bytes are not provably the bytes
  `install` wrote, and names the reason, instead of deleting the file the user
  edited. Journal entries now record a `sha256` of what was written, and the
  journal is written before each path is mutated, so an interrupted `install`
  is still recoverable.
- `uninstall` restores only the settings keys `install` captured, so keys added
  afterwards survive; the file is deleted only when `install` created it and
  nothing is left in it.
- Two mutating runs can no longer interleave: every command that writes takes a
  `journal.lock`, the backup stamp directory is claimed exclusively, and a lock
  whose owner is gone is taken over instead of blocking recovery.
- `readJournal` rejects a version it does not know and entries that are not
  shaped like journal entries, rather than acting on them.
- `models.json` is written with every shell argument POSIX single-quoted, so
  a program path containing spaces, `$`, backticks, quotes or newlines is
  passed to the token command literally instead of being re-interpreted by
  the shell.
- `models.json` with a UTF-8 BOM is accepted instead of being reported as
  invalid JSON.
- A `models.json` whose `providers` key is an array or a string is now
  rejected with a clear error and left untouched, instead of being rewritten
  as an object with numeric keys.
- Atomic writes no longer leave a `.tmp-*` file behind when the write, the
  permission change or the sync fails, and the parent directory is now synced
  after the rename so the new file survives a crash.

- An unparsable version no longer compares as equal to every other version.
  `doctor` now reports it as not parsable, and `isNodeSupported` says no
  instead of yes.
- `doctor` reports why a program could not be probed: a process killed by a
  signal is named as such, and a program that could not be spawned says what
  to fix.
- The token helper is only used when it is a regular executable file; a
  directory or a file without the execute bit falls back to the CLI.

- Unicode glyphs are used only on a terminal; piped output, `TERM=dumb` and
  `--ascii` get plain ASCII.
- Terminal text is measured in display columns, so CJK characters, emoji and
  combining marks no longer make boxes misaligned, and truncation never cuts
  a character in half.

- An exported-but-empty `PI_CODING_AGENT_DIR` no longer shadows the `PI_HOME`
  alias and the default.
- A relative path is resolved against the home directory instead of the
  current working directory, so the same flag means the same thing wherever
  the command is run from.
- The `pi-deepseek` wrapper no longer dies with an unbound-variable error
  when `HOME` is unset: it falls back to `DSH_HOME`, and when neither is set
  it says which variable to set.

- Waiting for the account grant can be interrupted with Ctrl-C. The panel
  started by that run is stopped as a process group instead of being left
  behind, and the run reports the interruption.

- `doctor` reports a new `dsh-preset` check: whether the installed `dsh` can
  mount an agent preset at all. A version outside the compatibility matrix is
  still only a warning; a version that cannot mount a preset is a failure.
- A "Known-broken dsh builds" table in `docs/compatibility.md`, and a
  troubleshooting entry for the exact
  `agent-preset/invalid: Cannot read properties of undefined (reading 'parent')`
  failure.
- `start-web.sh` refuses to start `dsh 0.2.2-alpha.2`, whose preset registry
  cannot mount any preset. The web panel used to open and then reject every
  new session with
  `agent-preset/invalid: Cannot read properties of undefined (reading 'parent')`,
  which read like a bridge failure and was not one.
- The launcher no longer dies on macOS before it starts the web panel. It
  joined the PATH entries with `paste -sd:`, a bundled short-option form
  that the BSD `paste` rejects with a usage message, so on macOS the script
  aborted on its first line. The entries are now joined with `tr`/`sed`,
  which behave the same on both systems.

### Changed

- `--json` now emits a JSON document for `--version`, `--help`, `help` and
  usage errors, so machine consumers never receive mixed output. Usage errors
  report `{ok:false,"error":"...","code":2}` on stdout with exit code 2.
- `--` ends option parsing; the tokens after it are positional arguments.
- A value that starts with `-` is accepted in both the `--opt=value` and the
  `--opt value` form.
- `-y` / `--yes` now actually asks for confirmation on an interactive
  terminal for `install`, `uninstall` and `sync`. The default answer is no,
  so `uninstall` without `--yes` is safe by default.

## [0.2.0] - 2026-11-02

The release that makes the bridge a product rather than a recipe: one DeepSeek
account shared between Pi and the dsh web interface, and an install that
finishes the job instead of handing over a to-do list.

### Added

- `pi-dsh-bridge account` — show which DeepSeek account Pi is using, switch to
  another one when the quota runs out, and recover the dsh web sign-in URL when
  the browser tab is gone.
- `install` now finishes the job: it opens the dsh web panel, hands over the
  tokenised sign-in URL, waits for Enter and detects the account by itself. On a
  non-interactive terminal it starts nothing and prints the one command to run
  later.
- A terminal UI: a four-line arch as the mark, colour, boxed prompts and
  numbered steps, degrading to plain ASCII when piped, on `TERM=dumb`, or with
  `--no-color` / `--ascii`.

### Fixed

- Files that other processes read while they run — the token helper and
  `models.json` — are now written atomically. Writing them in place truncated
  the file first, so a Pi request that landed in that window failed with
  `Failed to resolve provider "deepseek" header "x-dsh-auth-token"` even though
  the bridge was healthy.

### Changed

- The shared provider is written whether or not an account exists yet, so
  signing in is enough. Previously, installing before signing in left Pi on its
  built-in `deepseek` provider — a different wallet — and the failure surfaced
  as a bare `402`.

### Added

- The shared-account bridge: Pi now spends the same DeepSeek account as the
  dsh web interface. Pi's `models.json` gets a `deepseek` provider whose
  `x-dsh-auth-token` header is a *command* that reads the dsh account grant on
  demand. The token is never written into a second file, and signing in to a
  different account in the dsh web interface changes the account Pi spends on
  its next start.
- `pi-dsh-bridge sync` — wire Pi to the account the dsh web interface is
  signed in to. Idempotent, journaled, reversible, `--dry-run` supported.
- `pi-dsh-bridge token` — the command Pi itself calls. `--check` reports
  whether the grant is usable without printing anything.
- `doctor` now reports three states for every credential — absent, present but
  unusable, usable — and checks that Pi is actually wired to the shared
  account, not merely that a credential exists.
- `verify` now exercises the shared account route and reports the balance of
  both wallets, so it is visible which one Pi is spending.

### Changed

- The dsh web route is now `deepseek-account` (the account wallet) instead of
  `deepseek-official` (the API-key wallet), so dsh and Pi spend the same
  money instead of two different ones.
- `install` writes Pi's `models.json` and installs the `pi-dsh-token` helper;
  `uninstall` restores the previous `models.json` byte for byte.
- The Pi home is resolved from `PI_CODING_AGENT_DIR`, the variable Pi itself
  reads. `PI_HOME` stays supported as an alias.
- `doctor` no longer reports a merely present API key as healthy: presence is
  not working, and only `verify` can prove a balance.

## [0.1.0] - 2026-11-01

First released version. The package turns a personal shell-script setup recipe
into a versioned CLI with a frozen public contract.

### Added

- `pi-dsh-bridge install` — points Pi's default provider/model at DeepSeek and
  installs the `pi-deepseek` wrapper plus the `dsh` web launcher. Every changed
  path is journaled with a byte copy of its previous content.
- `--dry-run`, which prints the full plan and writes nothing.
- `pi-dsh-bridge doctor` — cheap, offline health check: versions, presence,
  writability, effective `dsh` default model, credential presence (never the
  value). Supports `--json`.
- `pi-dsh-bridge verify` — end-to-end check behind an explicit `--yes`, because
  it spends DeepSeek API credit.
- `pi-dsh-bridge uninstall` — exact per-path restore from the install journal.
  It never blanket-restores a file it did not record.
- MIT license, and a `dsh` compatibility matrix that `doctor` reports against.

### Changed

- Backups and the install journal moved out of the repository, to
  `~/.local/state/pi-dsh-bridge`, so updating the clone cannot overwrite them.
- `install.sh`, `verify.sh` and `uninstall.sh` are now thin shims over the CLI
  instead of separate implementations.
- `pi-deepseek` is copied into `bin/` rather than symlinked into the clone, so
  it survives an `npx` cache clean.

### Removed

- Writing `~/.dsh/profiles/web/cordis.patch.yml`. On `@deepseek-ai/dsh@0.2.1-rc.5`
  the shipped `web` profile already defaults to the `deepseek-official` route,
  so the patch was redundant, and mutating a user's profile layer is the most
  painful change to undo. An overlay is now applied at launch time and only
  when the effective default model diverges.

[0.2.0]: https://github.com/andrikonbeat/dsh-pi-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/andrikonbeat/dsh-pi-bridge/releases/tag/v0.1.0
