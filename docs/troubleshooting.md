# Troubleshooting

Start with `npx pi-dsh-bridge doctor --json`. It answers most of what is below
without spending API credit, and its output is exactly what an issue needs.

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
`start-web.sh` filters it out if a stale entry survives), and the
`deepseek-account` route answering `403` on `/auth-api/v0/users/current`. The
launcher uses the verified `deepseek-official` API-key route. Confirm what your
dsh actually composes with:

```bash
dsh --profile web --dump-config | grep -A5 agent-default-model
```

It must show `provider: deepseek-official`. If it shows something else,
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
`start-web.sh` does not duplicate the secret: it reads `DEEPSEEK_API_KEY` from
the environment, or `deepseek.key` from `$PI_HOME/auth.json`, at launch time.
Nothing is written into the launcher. To rotate the key, run
`pi auth login --provider deepseek` again.

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
