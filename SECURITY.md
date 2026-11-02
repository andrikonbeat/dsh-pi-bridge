# Security policy

## Reporting a vulnerability

Email **andrikonbeat** through the address on their GitHub profile, or open a
[private security advisory](https://github.com/andrikonbeat/dsh-pi-bridge/security/advisories/new).
Please do not open a public issue for anything that involves a credential.

You can expect an acknowledgement within a few days. If the report is valid, a
fix and an advisory are published together, and you are credited unless you ask
otherwise.

## What this tool touches, and what it never does

`pi-dsh-bridge` sits between Pi, the dsh web interface and DeepSeek, so it is
fair to ask what it can see.

- **It never stores a DeepSeek credential.** The account token is read from the
  dsh credentials store (`$DSH_HOME/.credentials.yaml`) at request time, by the
  command recorded in Pi's `models.json`. That command is a *path to a program*,
  not a secret: nothing in the repository, the npm tarball or the installed
  files contains a token.
- **It never prints a credential.** `doctor`, `verify`, `sync` and `account`
  report lengths and fingerprints only. `token` prints the token to stdout
  because Pi consumes it there; `token --check` exists precisely so a caller can
  ask "is the account usable?" without the value.
- **It reads three files it does not own**: `~/.pi/agent/settings.json`,
  `~/.pi/agent/models.json` and `$DSH_HOME/.credentials.yaml`. It writes only
  the first two, and only the keys it documents in the README.
- **It can start a process**: `install` and `account` start the dsh web panel on
  an interactive terminal, and `--open` asks the browser to open a URL. Neither
  happens on a non-interactive terminal.
- **It has zero dependencies.** There is no transitive supply chain to audit:
  the published tarball contains only this project's own files.

## Supported versions

Only the latest published minor receives security fixes. This is a small,
single-maintainer project; there are no backports.

| Version | Supported |
| --- | --- |
| `0.2.x` | yes |
| `< 0.2` | no |
