# pi-dsh-bridge

[![npm](https://img.shields.io/npm/v/pi-dsh-bridge.svg)](https://www.npmjs.com/package/pi-dsh-bridge)
[![node](https://img.shields.io/node/v/pi-dsh-bridge.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/pi-dsh-bridge.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-74%20passing-brightgreen.svg)](test)

Pi and the DeepSeek Harness web interface, on **one DeepSeek account**. Switch
accounts in the dsh web panel and Pi follows on its next start — no token to
copy, no secret in a second file, nothing to restart.

It installs reversibly, checks itself, and undoes exactly what it changed.
Zero runtime dependencies.

> **Name note.** This project is published on npm as **`pi-dsh-bridge`**. The
> npm name `dsh-pi-bridge` belongs to an unrelated package, so the GitHub
> repository keeps that name while the package uses this one.

## TL;DR

```bash
npm install -g pi-dsh-bridge    # one command: wires everything and connects your account
pi                             # use it
pi-dsh-bridge account          # only when you switch accounts
```

**New here?** [`docs/getting-started.md`](docs/getting-started.md) is the
step-by-step version: what to install first, what the install writes, how to
sign in, and what to do when a step does not go as planned.

> **Not on npm yet?** This package is published by pushing a version tag, so
> until that happens `npm install -g pi-dsh-bridge` answers 404. Install from a
> checkout instead:
>
> ```bash
> git clone https://github.com/andrikonbeat/dsh-pi-bridge.git
> cd dsh-pi-bridge
> npm install -g .        # or: ./install.sh
> ```

`install` ends by opening the dsh web panel, handing you the sign-in URL and
waiting until the account appears — you do not have to understand what a grant,
a header or `models.json` is, and you never run a second command to finish the
first. If you install before signing in, the wiring is already in place: the
moment you sign in, the next `pi` start uses that account.

Nothing is hidden: `install --dry-run` prints every file it would touch and
writes nothing, and `uninstall` restores the exact previous bytes.

## What it does

Two independent surfaces, one account.

```
                    the DeepSeek account you are signed in to
                                  |
                 +----------------+----------------+
                 |                                 |
   Pi / gentle-shell                        dsh web / headless
   (its own tools: read, bash, edit,          (its own agent loop
    write, MCP, skills, extensions)            and its own tools)
                 |                                 |
   x-dsh-auth-token: <token read on demand>   deepseek-account route
                 +----------------+----------------+
                                  |
                          api.deepseek.com
```

- **One wallet, not two**: Pi and dsh both spend the DeepSeek *account* you
  are signed in to. Signing in to a different account in the dsh web interface
  changes the account Pi spends on its next start.
- **Pi side**: replaces Pi's `deepseek` provider with one that sends the
  account token in the `x-dsh-auth-token` header, read from the dsh
  credentials store *on demand*. The token is never copied into a second file
  and never written into `models.json`.
- **dsh side**: installs `$DSH_HOME/start-web.sh` and pins the dsh route to
  `deepseek-account`, so dsh spends the same wallet rather than a separate
  API-key wallet.
- **Fallback**: the DeepSeek API key Pi may already store keeps working as an
  explicit, separate route. `doctor` always says which route is live.

## What it changes, and how to undo it

| Path | Change |
| --- | --- |
| `$PI_CODING_AGENT_DIR/settings.json` | sets `defaultProvider` and `defaultModel`; every other key is preserved |
| `$PI_CODING_AGENT_DIR/models.json` | the `deepseek` provider, pointing at the account header; every other provider is preserved |
| `$DSH_HOME/start-web.sh` | the web launcher, mode `0755` |
| `$BIN_DIR/pi-deepseek` | the wrapper, mode `0755` (a real file, never a symlink into `node_modules`) |
| `$BIN_DIR/pi-dsh-token` | the helper Pi runs to fetch the account token, mode `0755`; it holds no secret |
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
| A DeepSeek account | sign in to DeepSeek in the dsh web interface; both sides read that account |
| A DeepSeek API key (optional) | run `/login` inside Pi and choose DeepSeek; kept as the explicit fallback route |

The CLI itself has **zero runtime dependencies**: `npx` is instant and there is
no transitive supply chain to audit.

## Commands

```bash
pi-dsh-bridge install     [--dry-run] [-y] [--json] [--open] [--model <id>] [--provider <id>]
pi-dsh-bridge account     [--relogin] [--restart] [--open] [--json]
pi-dsh-bridge doctor      [--json]
pi-dsh-bridge verify      --yes
pi-dsh-bridge uninstall   [--dry-run] [-y]
pi-dsh-bridge sync        [--dry-run] [--json]
pi-dsh-bridge token       [--check]
pi-dsh-bridge help
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the plan and write nothing |
| `-y`, `--yes` | do not prompt for confirmation |
| `--json` | machine-readable output |
| `--no-color` | plain output, no ANSI colour |
| `--ascii` | ASCII glyphs only, for terminals without box drawing |
| `--open` | `install`/`account`: try to open the sign-in URL in a browser |
| `--relogin` | `account`: re-open the panel even when an account already works |
| `--restart` | `account`: restart the dsh web panel to mint a fresh sign-in URL |
| `--pi-home <dir>` | default `$PI_CODING_AGENT_DIR` or `~/.pi/agent` |
| `--dsh-home <dir>` | default `$DSH_HOME` or `~/.dsh` |
| `--bin-dir <dir>` | default `$BIN_DIR` or `~/.local/bin` |
| `--state-dir <dir>` | default `$STATE_DIR` or `~/.local/state/pi-dsh-bridge` |
| `--model <id>` | Pi default model, default `deepseek-flash` |
| `--provider <id>` | Pi provider, default `deepseek` |

Exit codes: `0` success, `1` a check failed, `2` usage error.

`doctor` is cheap and offline: versions, presence, writability, effective dsh
config, and the state of every credential. It never prints a credential value
and never calls the DeepSeek API. `verify` is the paid end-to-end path and
requires `--yes`.

## The shared account

The bridge is deliberately thin. Pi's `models.json` gets one provider:

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "authHeader": false,
      "apiKey": "shared-account",
      "headers": { "x-dsh-auth-token": "!<bin-dir>/pi-dsh-token token --dsh-home <dsh-home>" }
    }
  }
}
```

The header value is a command, not a secret. Pi runs it, takes its stdout, and
caches it for the life of that Pi process only — so the next start reads the
current account. The `apiKey` is a placeholder Pi insists on registering the
provider; it authorises nothing.

Three facts about DeepSeek shape this, all measured against the live API:

- the account token is accepted **only** in `x-dsh-auth-token`; as a bearer
  token it is rejected with 401;
- a non-empty but invalid account token fails the request with 401 and **no**
  fallback, so the command never prints a placeholder;
- an empty or absent account token behaves as absent, which is why the
  fallback lives at the configuration level and not inside a request.

`doctor` reports three states for every credential, never two: **absent**,
**present but unusable**, and **usable**. "Present" is not "working": a stored
API key whose wallet has no credit is present and fails every request with
402. `doctor` is offline, so it reports such a key as *present, balance not
checked offline*; `verify --yes` is what proves the balance.

When the dsh grant is missing or malformed, the bridge stays inactive and the
API-key route keeps working untouched. Nothing is half-wired.

## After installing

Open `gentle-shell` as usual; it now starts on DeepSeek, spending the same
account as the dsh web interface. `Ctrl+P` opens the model picker under the
`deepseek` provider. For non-interactive runs:

```bash
pi-deepseek --print "one shot"
pi-deepseek --provider deepseek --model deepseek-v4-pro
```

```bash
~/.dsh/start-web.sh                  # dsh web on port 3080
DSH_PORT=3090 ~/.dsh/start-web.sh    # another port
DSH_WORKSPACE=~/code ~/.dsh/start-web.sh
```

Or let the CLI start it and hand you the URL:

```bash
pi-dsh-bridge account --restart --open
```

Open the exact `http://127.0.0.1:3080/?token=...` URL that the panel prints. A
plain `curl` without the browser flow answers `401` by design.

### Switching accounts

When your quota runs out, sign in to another DeepSeek account in the panel and
run `pi-dsh-bridge account`: it detects the change, re-wires Pi, and says so.
There is nothing to copy and nothing to edit.

## What this is not

**It is not an agent bridge (Pi → dsh).** `dsh` exposes ACP and SDK profiles,
but it is a *different agent*: its own loop, its own tools. Pi has no ACP
client, and its subagents are model-based rather than command-based. Routing
Pi's turns into `dsh` would replace Pi's loop and lose Pi's tools — the opposite
of the goal ("use the model, keep gentle-shell's tools").

**It is not a model implementation.** Pi's `deepseek` provider is native; this
project only configures it, and only in the files listed above.

**It is not a proxy.** No process sits between Pi and DeepSeek. The account
token travels in a request header, read on demand from the dsh credentials
store, and nowhere else.

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

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for the workflow, the test expectations and the review-size rule. Security
reports go through [SECURITY.md](SECURITY.md) instead of the issue tracker.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).
