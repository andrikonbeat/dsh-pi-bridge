# Troubleshooting

Start with `npx pi-dsh-bridge doctor --json`. It answers most of what is below
without spending API credit, and its output is exactly what an issue needs.

## The shared account

**Pi fails with `Failed to resolve provider "deepseek" header
"x-dsh-auth-token" from shell command: ...`.**
The account token could not be fetched. The command in `models.json` ran and
failed, so Pi never sent a request. Almost always the dsh account grant is
missing or malformed. `doctor` says which of the three states it is in:
**absent**, **present but unusable** or **usable**. Fix it by signing in to
DeepSeek in the dsh web interface and then running:

```bash
pi-dsh-bridge sync
```

The `pi-deepseek` wrapper checks the same thing before it starts Pi and prints
the same remedy, so a broken bridge never starts as a mysterious 401.

**The account is signed in, but Pi still uses the old wallet.**
The token is read when Pi starts, not continuously. Restart Pi (or run
`pi-dsh-bridge sync` and start it again). Pi caches the value for the life of
one process, by design: that is what makes a new account take effect on the
next start.

**DeepSeek answers `401` with `invalid dsh token`.**
The account token was sent but DeepSeek rejected it. An invalid, non-empty
`x-dsh-auth-token` fails the request outright; there is **no** fallback to the
API key inside the same request, which is why the token command never prints a
placeholder. Run `pi-dsh-bridge doctor` to check whether the grant is usable,
and `pi-dsh-bridge verify --yes` to see what the API says about it.

**DeepSeek answers `402 insufficient_balance`.**
No per-request fallback is possible: the account route is the one in use. If
the account itself has no credit, top it up in the DeepSeek account page. The
separate API-key route is a different wallet — `doctor` reports its balance
only through `verify`, never as a silent fallback.

**`doctor` says the credential is `present` but not `working`.**
That is deliberate. `doctor` is offline and free, so it can tell that a
credential exists and is well-formed, but not whether it has credit. Run
`pi-dsh-bridge verify --yes` to prove it.

**`doctor` says the `deepseek` provider is not wired to the dsh account.**
Run `pi-dsh-bridge sync`. If it says the account-token program is missing or
not executable, run `pi-dsh-bridge install`.

## Pi side

**Pi hangs at startup (over 60 s, no output).**
The Pi home was declaring the gentle-pi package twice — once as `npm:gentle-pi`
and once by local path. Pi then npm-installs the whole package on every start
and registers the same tools twice (`Tool "write" conflicts with ...`). Keep
exactly one declaration, by local path. The gentle-shell launcher documents
that an `npm:gentle-pi` declaration must never survive.

**Do not pass `--link` to `gentle-shell`.**
The plain launcher (`gentle-shell`, no flags) is verified to leave
`settings.json` untouched. The explicit `--link` flag performs a take-over that
rewrites the package declaration in `settings.json`, which is how the duplicate
`npm:gentle-pi` entry gets in.

**Pi clones the gentle-shell repo on every start.**
`~/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell` was an
incomplete checkout (`.git` only, no `HEAD`), so Pi re-cloned ~72k objects at
~150 KiB/s. Complete the checkout once and make sure its dependencies resolve
(`node_modules/@heyhuynhgiabuu/pi-pretty`).

**Pi exits 1 with `403 Forbidden`.**
The previous default provider route is failing; `install` switches the default
to DeepSeek. Check with `pi auth check --provider deepseek`.

**Startup is slow.**
Measured on a loaded machine with the full package set:

| Run | Time |
| --- | --- |
| `pi -ne` (no extensions, no tools) | ~3 s |
| `pi --no-skill-registry` | ~30 s |
| `pi --no-skill-registry --no-mcp` | ~25 s |

The skill-registry refresh costs about 20 s; MCP servers cost the rest. The
`pi-deepseek` wrapper skips the registry refresh by default
(`PI_DEEPSEEK_FULL_STARTUP=1` keeps it) and `PI_DEEPSEEK_NO_MCP=1` skips MCP.

## dsh side

**`dsh web` hangs or logs 403.**
Two causes were found historically: a `vision-git` shim in `PATH` (removed, and
`start-web.sh` filters it out if a stale entry survives), and the account
dashboard host answering `403` on `/auth-api/v0/users/current`. The second one
is Cloudflare blocking `platform.deepseek.com` from this machine: it does not
affect inference, only the account panel. `start-web.sh` detects it once and
says so.

The launcher uses the `deepseek-account` route, so dsh and Pi spend the same
wallet. Confirm what your dsh actually composes with:

```bash
dsh --profile web --dump-config | grep -A5 agent-default-model
```

It must show `provider: deepseek-account`. If it shows something else,
`install` writes an overlay and passes it with `--patch`; re-run
`pi-dsh-bridge doctor` and it will say which of the two is in effect.

**`dsh web` asks for authentication.**
Open the exact `http://127.0.0.1:3080/?token=...` URL printed by `dsh web`. A
plain `curl` without the browser flow answers `401` by design.

**`--from-default-profile web` errors.**
That flag only works for custom profile names. `web`, `headless`, `tui`, `acp`
and `sdk` are shipped profiles; boot them without it. This project never uses
that flag.

**The API key.**
`start-web.sh` does not duplicate the secret. When the dsh account grant is
usable, the launcher uses the account route and does not touch the API key at
all. When the account grant is unusable, it falls back to `DEEPSEEK_API_KEY`
from the environment, or `deepseek.key` from
`$PI_CODING_AGENT_DIR/auth.json`, and says loudly that dsh is then on the
*other* wallet. To rotate the key, run `pi auth login --provider deepseek`
again.

## This tool

**`install` says everything is `unchanged` but Pi still starts on another
provider.**
Something else is writing `settings.json` after install — most often
`gentle-shell --link`. Re-run `pi-dsh-bridge doctor` to see the effective
values, and remove the take-over source first.

**`uninstall` says it has no journal.**
It never restores anything it did not record, on purpose. Either `install` was
never run with this `--state-dir`, or the journal was deleted. Restore the files
by hand from `$STATE_DIR/backups/` if a copy exists, or reinstall and uninstall
from there.

**A new `dsh` release broke something.**
See [`compatibility.md`](compatibility.md). Include `doctor --json` output and
`dsh --version` in the issue.
