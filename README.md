# pi-dsh-bridge

DeepSeek inside Pi / gentle-shell — keeping every Pi tool — plus a working
DeepSeek Harness (`dsh`) web launcher. It installs reversibly, checks itself,
and undoes what it changed.

> **Name note.** This project is published on npm as **`pi-dsh-bridge`**. The
> npm name `dsh-pi-bridge` belongs to an unrelated package, so the GitHub
> repository keeps that name while the package uses this one.

## TL;DR

```bash
npx pi-dsh-bridge doctor     # what is missing on this machine?
npx pi-dsh-bridge install    # wire it up (reversible, journaled)
npx pi-dsh-bridge verify     # prove it works end to end (spends API credit)
```

Nothing is hidden: `install --dry-run` prints every file it would touch and
writes nothing, and `uninstall` restores the exact previous bytes.

## What it does

Two independent surfaces, one integration point.

```
Pi / gentle-shell   --(Pi's native deepseek provider)-->  api.deepseek.com
   tools: read, bash, edit, write, MCP, skills, extensions

dsh web / headless  --(deepseek-official API-key route)-->  api.deepseek.com
   its own agent loop and its own tools
```

- **Pi side**: points Pi's default provider/model at DeepSeek and installs a
  `pi-deepseek` wrapper for flag-driven runs. Pi keeps all of its own tools.
- **dsh side**: installs `$DSH_HOME/start-web.sh`, which reuses the DeepSeek
  credential Pi already stores, so the key is never duplicated into a config
  file or a second dotfile.

## What it changes, and how to undo it

| Path | Change |
| --- | --- |
| `$PI_HOME/settings.json` | sets `defaultProvider` and `defaultModel`; every other key is preserved |
| `$DSH_HOME/start-web.sh` | the web launcher, mode `0755` |
| `$BIN_DIR/pi-deepseek` | the wrapper, mode `0755` (a real file, never a symlink into `node_modules`) |
| `$STATE_DIR/dsh-overlay.yml` | only when the effective dsh default model diverges from the required route |

Every changed path is recorded in `$STATE_DIR/journal.json` with a byte copy of
its previous content. `uninstall` restores exactly those paths, deletes the ones
that did not exist before, and touches nothing it did not record.

`$STATE_DIR` defaults to `~/.local/state/pi-dsh-bridge` — outside the
repository, so pulling a new version never lands on top of your backups.

## Requirements

| Requirement | Why |
| --- | --- |
| Node.js >= 22.19.0 | the floor `@deepseek-ai/dsh` declares |
| `pi` on `PATH` | installs Pi's DeepSeek defaults, and `verify` drives it |
| `dsh` on `PATH` | the web launcher execs it; `doctor` reports version drift |
| A DeepSeek credential | `pi auth login --provider deepseek` writes it once, both sides read it |

The CLI itself has **zero runtime dependencies**: `npx` is instant and there is
no transitive supply chain to audit.

## Commands

```bash
pi-dsh-bridge install     [--dry-run] [-y] [--json] [--model <id>] [--provider <id>]
pi-dsh-bridge doctor      [--json]
pi-dsh-bridge verify      --yes
pi-dsh-bridge uninstall   [--dry-run] [-y]
pi-dsh-bridge help
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the plan and write nothing |
| `-y`, `--yes` | do not prompt for confirmation |
| `--json` | machine-readable output |
| `--pi-home <dir>` | default `$PI_HOME` or `~/.pi/agent` |
| `--dsh-home <dir>` | default `$DSH_HOME` or `~/.dsh` |
| `--bin-dir <dir>` | default `$BIN_DIR` or `~/.local/bin` |
| `--state-dir <dir>` | default `$STATE_DIR` or `~/.local/state/pi-dsh-bridge` |
| `--model <id>` | Pi default model, default `deepseek-flash` |
| `--provider <id>` | Pi provider, default `deepseek` |

Exit codes: `0` success, `1` a check failed, `2` usage error.

`doctor` is cheap and offline: versions, presence, writability, effective dsh
config, credential presence. It never prints a credential value and never calls
the DeepSeek API. `verify` is the paid end-to-end path and requires `--yes`.

## After installing

Open `gentle-shell` as usual; it now starts on DeepSeek. `Ctrl+P` opens the
model picker under the `deepseek` provider. For non-interactive runs:

```bash
pi-deepseek --print "one shot"
pi-deepseek --provider deepseek --model deepseek-v4-pro
```

```bash
~/.dsh/start-web.sh                  # dsh web on port 3080
DSH_PORT=3090 ~/.dsh/start-web.sh    # another port
DSH_WORKSPACE=~/code ~/.dsh/start-web.sh
```

Open the exact `http://127.0.0.1:3080/?token=...` URL that `dsh web` prints. A
plain `curl` without the browser flow answers `401` by design.

## What this is not

**It is not an agent bridge (Pi → dsh).** `dsh` exposes ACP and SDK profiles,
but it is a *different agent*: its own loop, its own tools. Pi has no ACP
client, and its subagents are model-based rather than command-based. Routing
Pi's turns into `dsh` would replace Pi's loop and lose Pi's tools — the opposite
of the goal ("use the model, keep gentle-shell's tools").

**It is not a model implementation.** Pi's `deepseek` provider is native; this
project only configures it, and only in the two files listed above.

## Compatibility

`dsh` is a release candidate owned by DeepSeek, not by this project. The
supported versions, what is verified, and what `doctor` does when it sees
something else are in [`docs/compatibility.md`](docs/compatibility.md).

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md). If you are filing a
bug, include the output of `npx pi-dsh-bridge doctor --json`.

## Development

```bash
node --test        # hermetic suite: fake pi/dsh, temp homes, no network
npm run pack:check # what would actually be published
```

The public command and flag names are a frozen contract: adding a command is a
minor bump, changing or removing one is a major bump.

## License

MIT — see [LICENSE](LICENSE).
