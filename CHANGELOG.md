# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

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

[Unreleased]: https://github.com/andrikonbeat/dsh-pi-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andrikonbeat/dsh-pi-bridge/releases/tag/v0.1.0
