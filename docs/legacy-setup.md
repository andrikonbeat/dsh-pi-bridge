# The original shell-script setup (legacy)

Before this was a package it was four shell scripts. They still work: they now
delegate to the CLI, so there is one implementation and no drift.

| Old | Now |
| --- | --- |
| `./install.sh` | `npx pi-dsh-bridge install` |
| `./verify.sh` | `npx pi-dsh-bridge verify --yes` |
| `./uninstall.sh` | `npx pi-dsh-bridge uninstall` |

The shims accept the same environment overrides as before (`PI_HOME`,
`DSH_HOME`, `BIN_DIR`) and pass everything through to the CLI.

## How the original install worked

It is worth keeping this written down, because it explains the file layout and
the reasoning behind the defaults.

1. **`~/.pi/agent/settings.json`** — set `defaultProvider=deepseek`,
   `defaultModel=deepseek-flash`, and `enabledModels=["deepseek/*"]` only when
   the list was absent or empty.
2. **`~/.dsh/profiles/web/cordis.patch.yml`** — pin the effective default model
   to the `deepseek-official` route, because the `deepseek-account` route
   answered `403` on `/auth-api/v0/users/current`.
3. **`~/.dsh/start-web.sh`** — a launcher that resolves the DeepSeek key at
   launch time instead of copying it into a config file.
4. **`~/.local/bin/pi-deepseek`** — a symlink to `bin/pi-deepseek`, a wrapper
   that runs plain `pi` with the DeepSeek flags plus `--no-skill-registry` for a
   faster boot.

It backed everything up to `backups/<timestamp>/` inside the clone, and
`uninstall.sh` restored the newest backup wholesale.

## What changed, and why

Step 2 is **gone**. On `@deepseek-ai/dsh@0.2.1-rc.5` the shipped `web` profile
already defaults to `provider: deepseek-official`, so the profile patch was
only carrying `reasoningEffort: high` and a cosmetic welcome-notice version —
and it mutated a user's profile layer, which is the most painful change to
undo. The overlay is now applied at launch time (`--patch`) and only when the
effective default actually diverges. See
[`compatibility.md`](compatibility.md).

Three other things changed with it:

- **Backups moved out of the clone**, to `~/.local/state/pi-dsh-bridge/`, so a
  `git pull` never lands on top of them.
- **Restore is per recorded path**, not a whole-directory copy back, so a file
  you edited after installing is not silently reverted.
- **`pi-deepseek` is copied, not symlinked** into `bin/`. A symlink into a
  package directory breaks the moment `npx` cleans its cache.

## If you prefer no npm

Read `install.sh`, `verify.sh` and `uninstall.sh` in the repository root. They
are the supported fallback path and they run without a network fetch, but they
require the clone to stay where it is: the wrapper is resolved relative to it,
and the CLI they call lives in `bin/`.
