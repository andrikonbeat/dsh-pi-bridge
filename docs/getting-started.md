# Getting started

You want Pi and the DeepSeek Harness web interface to spend **one** DeepSeek
account. This guide takes you from "nothing installed" to "Pi answers through
DeepSeek", in the order that works, with the check that tells you each step
landed.

It takes about ten minutes, most of which is the DeepSeek sign-in.

## The quick path

```bash
# 1. install (from a checkout; see the note below if npm has it)
npm install -g .
pi-dsh-bridge install

# 2. confirm it is wired
pi-dsh-bridge doctor

# 3. use it
pi
```

If `doctor` ends with `doctor: no failures`, you are done. Everything below is
what happens underneath, and what to do when a step does not go as expected.

> **Not on npm yet?** This package is published by pushing a version tag, so
> until that happens `npm install -g pi-dsh-bridge` answers **404 Not Found**.
> That is expected, not a broken install. Use the checkout instead:
>
> ```bash
> git clone https://github.com/andrikonbeat/dsh-pi-bridge.git
> cd dsh-pi-bridge
> npm install -g .
> ```

## Before you start

| You need | Why | How to check |
| --- | --- | --- |
| Node.js >= 22.19.0 | the floor `@deepseek-ai/dsh` declares | `node --version` |
| `pi` on `PATH` | the bridge configures Pi's DeepSeek defaults | `pi --version` |
| `dsh` on `PATH` | the web launcher runs it | `dsh --version` |
| A DeepSeek account | both sides spend it | you sign in during step 2 |
| A browser | the sign-in happens in the dsh web panel | — |

If `dsh` is missing:

```bash
npm install -g @deepseek-ai/dsh
```

> **Check the dsh version before you go further.** `0.2.2-alpha.2` is a broken
> build: it cannot mount an agent preset, so the panel opens but every new
> session fails. `doctor` fails the `dsh-preset` check and names it. Fix it
> with:
>
> ```bash
> npm install -g @deepseek-ai/dsh@0.2.2-alpha.3
> ```

## Step 1 — Install

```bash
npm install -g .
pi-dsh-bridge install
```

From a checkout. If npm already carries the package, `npm install -g
pi-dsh-bridge` is the same thing.

If npm does not have the package yet, install from a checkout instead:

```bash
git clone https://github.com/andrikonbeat/dsh-pi-bridge.git
cd dsh-pi-bridge
npm install -g .        # or: ./install.sh
```

To see the plan before anything is written:

```bash
pi-dsh-bridge install --dry-run
```

It lists every file it would touch and writes nothing.

### What it writes

| Path | What changes |
| --- | --- |
| `~/.pi/agent/settings.json` | `defaultProvider` and `defaultModel`; every other key is preserved |
| `~/.pi/agent/models.json` | the `deepseek` provider, pointing at the account header; every other provider is preserved |
| `~/.dsh/start-web.sh` | the web launcher |
| `~/.local/bin/pi-deepseek` | the wrapper, a real file (never a symlink) |
| `~/.local/bin/pi-dsh-token` | the helper Pi runs to fetch the token; it holds no secret |
| `~/.local/state/pi-dsh-bridge/dsh-overlay.yml` | only when the effective dsh route needs pinning |

Every changed path is recorded in
`~/.local/state/pi-dsh-bridge/journal.json` with a byte copy of its previous
content. That is what makes `uninstall` exact.

## Step 2 — Sign in

The install opens the dsh web panel for you and waits. It prints a URL like
`http://127.0.0.1:3080/?token=...`. Open **that exact URL** in your browser —
it is a local address with a token in it, not the DeepSeek site. A plain
`curl` of it answers `401` by design; the panel expects the browser flow.

Sign in with your DeepSeek account. The bridge notices, re-wires Pi, and says
so. There is no token to copy and nothing to paste.

The command opens the panel in your browser by itself, and prints the sign-in
URL in full so you can open it by hand if you prefer. A scripted run — CI, a
pipe, a headless box — prints the URL and never launches a browser.

If you closed the panel, or you want a different account:

```bash
pi-dsh-bridge account
```

> **The panel can log you out on its own.** dsh owns
> `~/.dsh/.credentials.yaml`, and a panel start that cannot reach DeepSeek
> cancels its sign-in and leaves the file without the account grant. The
> bridge then reports `dsh-account: absent` and keeps the API-key route
> working. Sign in again from the panel and run `pi-dsh-bridge sync`; nothing
> else needs reinstalling.

You do **not** need a separate DeepSeek API key. The account token is read on
demand from the dsh credentials store and travels in a request header; it is
never copied into a second file. If you want one anyway — as an explicit
fallback wallet — run `/login` inside Pi and choose DeepSeek.

## Step 3 — Check it

```bash
pi-dsh-bridge doctor
```

This is offline and free. It checks versions, the files, the writable state and
every credential, and ends with one of:

- `doctor: no failures` — everything is wired;
- one line per failed check, each naming what to fix.

`doctor` never prints a credential value and never calls the DeepSeek API.

To prove the account can actually pay — this spends a little credit and needs
a network that reaches DeepSeek:

```bash
pi-dsh-bridge verify --yes
```

## Step 4 — Use it

```bash
pi                                  # interactive
pi-deepseek --print "one shot"      # non-interactive
```

`Ctrl+P` opens the model picker under the `deepseek` provider.

To use the dsh web panel yourself:

```bash
~/.dsh/start-web.sh                  # on port 3080
DSH_PORT=3090 ~/.dsh/start-web.sh    # on another port
DSH_WORKSPACE=~/code ~/.dsh/start-web.sh
```

### Switching accounts

Sign in to another DeepSeek account in the panel, then:

```bash
pi-dsh-bridge account
```

It detects the change, re-wires Pi, and tells you it switched. The next `pi`
start uses the new account.

## When a step does not go as planned

| What you see | What it means | What to do |
| --- | --- | --- |
| `dsh-account: absent` | not signed in, or dsh rewrote its credential file | `pi-dsh-bridge account`, then open the printed URL. If dsh logged you out on its own, re-authenticate once and the bridge re-syncs |
| `the DeepSeek account dashboard is blocked from this machine (HTTP 403)` | your network is blocked by Cloudflare | use a clean VPN, or set `HTTPS_PROXY` for the dsh process only. Inference still works; only the account panel is affected |
| `dsh-preset` fails and names `0.2.2-alpha.2` | a broken dsh build | `npm install -g @deepseek-ai/dsh@0.2.2-alpha.3` |
| `disabling profile plugin row "translator"` | the dsh profile still pins a plugin to the version you just left | `dsh plugin --profile web add @deepseek-ai/dsh-experimental-translator@0.2.2-alpha.3 @deepseek-ai/dsh-experimental-client-ui-cot-translation@0.2.2-alpha.3` |
| `the account route did not answer` | the network cannot reach DeepSeek | check your proxy or VPN; `doctor` still works offline |
| `neither DSH_HOME nor HOME is set` | no home directory to resolve paths against | set `HOME` or `DSH_HOME` |
| `journal is locked` | another mutating run is in progress | wait for it to finish; the lock is taken over automatically if that run died |

More, in [`troubleshooting.md`](troubleshooting.md).

## Undo it

```bash
pi-dsh-bridge uninstall --dry-run   # see what would be restored
pi-dsh-bridge uninstall
```

It restores the exact previous bytes of every path the install recorded, and
deletes the ones that did not exist before. A file you edited after installing
is **kept**, and the output says why — the bridge never deletes work it cannot
prove it created.

## Next

- [The shared account](../README.md#the-shared-account) — how the token travels
- [Compatibility](compatibility.md) — which dsh versions are verified
- [Troubleshooting](troubleshooting.md) — every symptom, with its fix
