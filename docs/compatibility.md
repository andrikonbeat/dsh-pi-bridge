# Compatibility

`dsh` (`@deepseek-ai/dsh`) is a release candidate published by DeepSeek, not by
this project. This page records what has actually been verified, so that a
failure can be attributed quickly instead of guessed at.

## Verified matrix

| `pi-dsh-bridge` | `@deepseek-ai/dsh` | `pi` | Node | Status |
| --- | --- | --- | --- | --- |
| 0.1.0 | `0.2.1-rc.5` | `1.4.0` | >= 22.19.0 | verified end to end |

`doctor` compares the installed `dsh` against this table. A version outside it
is reported as `warn`, not `fail`: the tooling keeps working and you are told
what was tested.

## What is actually coupled

Only three things about `dsh` matter to this project, and all three are checked
by `doctor`:

1. **The CLI shape**: `dsh --profile web --dump-config` composes the config
   without booting a server, and `--patch <file>` applies an overlay.
2. **The shipped default model**: the `web` profile ships
   `provider: deepseek-official`, `model: deepseek-flash`.
3. **The profile layer location**: `$DSH_HOME/profiles/web/cordis.patch.yml`.

Nothing else. This project deliberately does **not** edit the profile layer —
see below.

## Verified behaviour on 0.2.1-rc.5

- A fresh `DSH_HOME` composes `agent-default-model` with
  `provider: deepseek-official` and `model: deepseek-flash` from the shipped
  template. The API-key route is the default; no patch is needed.
- `--patch <file>` applies after every bundle and after the user layer, and an
  entry whose `id` already exists **replaces** it rather than conflicting.
- `--from-default-profile web` fails for a shipped profile name
  (`profile "web" names shipped profile "web" and cannot be a custom profile
  target`). Never use it for `web`, `headless`, `tui`, `acp` or `sdk`.

Because of the first two facts, an earlier version of this setup wrote a
`cordis.patch.yml` into the user profile. That was redundant, and mutating a
user's profile layer is exactly the kind of change that is painful to undo, so
it was removed: the overlay is applied at launch time (via `--patch`) and only
when `doctor`'s probe finds the effective default model diverging from the
required route.

## When a new `dsh` release breaks something

1. Run `npx pi-dsh-bridge doctor --json` and keep the output.
2. Compare: does the probe still compose `agent-default-model`? Does
   `--dump-config` still accept `--patch`? Does `web` still default to
   `deepseek-official`?
3. Open an issue with the `doctor --json` output and the `dsh --version` value.
   The matrix above is updated only after a real end-to-end run
   (`pi-dsh-bridge verify --yes`), never on the basis of a changelog entry.
