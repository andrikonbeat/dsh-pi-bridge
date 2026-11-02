# dsh-pi-bridge

DeepSeek models inside Pi / gentle-shell (keeping Pi's own tools), plus a ready-to-run DeepSeek Harness (`dsh`) web.

## TL;DR

```bash
./install.sh      # backs up, then wires Pi defaults + the dsh web profile
./verify.sh       # end-to-end: DeepSeek completion, Pi tools, dsh headless, dsh web
```

- `pi-deepseek` -> Pi/gentle-shell on DeepSeek with every Pi tool.
- `~/.dsh/start-web.sh` -> dsh web at `http://127.0.0.1:3080` (open the token URL it prints).

## Architecture

Two independent surfaces, one integration point.

```
Pi / gentle-shell  --(native deepseek provider)-->  api.deepseek.com
   tools: read, bash, edit, write, MCP, skills, extensions

dsh web / headless --(deepseek-official API-key route)--> api.deepseek.com
   its own agent loop and its own tools
```

### Why there is no agent bridge (Pi -> dsh)

`dsh` exposes ACP and SDK profiles, but it is a *different agent*: it has its own loop and its own tools. Pi has no ACP client, and its subagents are model-based, not command-based. Routing Pi's turns into dsh would replace Pi's loop and lose Pi's tools, the opposite of the goal ("use the model, keep gentle-shell's tools").

Pi already ships a native `deepseek` provider, so the correct integration is at the model layer:

```bash
pi --provider deepseek --model deepseek-flash
```

That is exactly what `bin/pi-deepseek` runs.

## What `install.sh` changes

| Target | Change |
| --- | --- |
| `~/.pi/agent/settings.json` | `defaultProvider=deepseek`, `defaultModel=deepseek-flash`, `enabledModels=["deepseek/*"]` when unset |
| `~/.dsh/profiles/web/cordis.patch.yml` | default model route `deepseek-account` -> `deepseek-official` |
| `~/.dsh/start-web.sh` | launcher that reads the key from Pi's auth store |
| `~/.local/bin/pi-deepseek` | symlink to `bin/pi-deepseek` |

Every touched file is copied to `backups/<timestamp>/` first. `uninstall.sh` restores the latest backup.

## Models

| Model id | Notes |
| --- | --- |
| `deepseek-flash` | DeepSeek V4.1 Flash (verified end-to-end) |
| `deepseek-v4-pro` | larger sibling |

Use the wire ids exactly; Pi's internal `chat:` prefix must not be used (the API answers 400).

## Usage

Open gentle-shell the usual way. It starts on DeepSeek because `install.sh` set
`defaultProvider=deepseek` and `defaultModel=deepseek-flash` in the Pi home
that the launcher links to (`gentle-shell home` -> `link ~/.pi/agent`). Inside
the session, `Ctrl+P` opens the model picker: under the `deepseek` provider you
will find `deepseek-flash` (1M context, thinking, images) and `deepseek-v4-pro`.

`pi-deepseek` is only a shortcut for flag-driven or non-interactive runs:

```bash
pi-deepseek                          # interactive, same as gentle-shell on DeepSeek
pi-deepseek --print "one shot"       # non-interactive
pi-deepseek --provider deepseek --model deepseek-v4-pro
```

```bash
~/.dsh/start-web.sh                  # dsh web on port 3080
DSH_PORT=3090 ~/.dsh/start-web.sh    # another port
DSH_WORKSPACE=~/code ~/.dsh/start-web.sh
```

`start-web.sh` does not duplicate the secret: it reads `DEEPSEEK_API_KEY` from the environment or from `~/.pi/agent/auth.json` at launch time.

## Startup cost

Measured on this machine with the full package set:

| Run | Time |
| --- | --- |
| `pi -ne` (no extensions, no tools) | ~3 s |
| `pi --no-skill-registry` | ~30 s |
| `pi --no-skill-registry --no-mcp` | ~25 s |

The skill-registry refresh costs about 20 s; the MCP servers (codegraph, context7, engram, rea) cost the rest. `pi-deepseek` skips the registry refresh by default (`PI_DEEPSEEK_FULL_STARTUP=1` keeps it).

## Troubleshooting

- **Pi seems to hang at startup (>60 s, no output)**: the Pi home was declaring `npm:gentle-pi` *and* the gentle-pi package by path. Pi then npm-installs the whole package on every start (slow registry) and registers the same tools twice (`Tool "write" conflicts with ...`). The gentle-shell launcher itself documents that an `npm:gentle-pi` declaration must never survive. Keep exactly one declaration, by local path.
- **Do not pass `--link` to `gentle-shell`**: the plain launcher (`gentle-shell`, no flags) is verified to leave `settings.json` untouched. The explicit `--link` flag performs a take-over that rewrites the package declaration in `settings.json`, which is how the duplicate `npm:gentle-pi` entry got in during setup.
- **Pi clones the gentle-shell repo on every start**: `~/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell` was an incomplete checkout (`.git` only, no `HEAD`), so Pi re-cloned 72277 objects at ~150 KiB/s. Fix: complete the checkout once, and make sure its dependencies resolve (`node_modules/@heyhuynhgiabuu/pi-pretty`).
- **Pi exits 1 with `403 Forbidden`**: the previous default provider (`nvidia`) route is failing. `install.sh` switches the default to DeepSeek. Check with `pi auth check --provider deepseek`.
- **dsh web hangs or logs 403**: the old `vision-git` shim (removed) and the `deepseek-account` route (403 on `/auth-api/v0/users/current`) were the causes. The launcher uses the verified `deepseek-official` API-key route.
- **dsh web asks for auth**: open the exact `http://127.0.0.1:3080/?token=...` URL printed by `dsh web`. A plain `curl` without the browser flow returns 401 by design.

## Testing against another gentle-shell install

To exercise a different installation without touching the live Pi home:

```bash
TH=/tmp/pi-home-test
mkdir -p "$TH"
cp ~/.pi/agent/auth.json "$TH/auth.json"
cp ~/.pi/agent/mcp.json "$TH/mcp.json"
printf '{"defaultProvider":"deepseek","defaultModel":"deepseek-flash"}\n' > "$TH/settings.json"

gentle-shell --home "$TH" --package-root "/path/to/gentle-shell" -- \
  --provider deepseek --model deepseek-flash --no-session --print "Respondé exactamente: OK"
```

`--package-root` needs the target checkout's dependencies to resolve (`@heyhuynhgiabuu/pi-pretty`); a symlink into `~/.pi/agent/npm/node_modules` is enough.
