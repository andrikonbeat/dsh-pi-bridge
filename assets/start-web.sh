#!/usr/bin/env bash
# Start the DeepSeek Harness web UI on the same DeepSeek account Pi uses.
#
# The account route is the one that matters: dsh and Pi must spend the same
# wallet, so switching accounts in the dsh web interface switches the account
# Pi spends too. The credential is never copied here — dsh reads its own
# credential store, and Pi reads the token on demand.
#
#   ~/.dsh/start-web.sh
#   DSH_PORT=3090 ~/.dsh/start-web.sh
#   DSH_WORKSPACE=~/code ~/.dsh/start-web.sh
set -euo pipefail

# vision-git's shim was uninstalled; keep it out of PATH if a stale entry survives.
# `grep -v` exits 1 when it filters nothing, which under `pipefail` would abort
# the launcher on a machine that never had the shim.
# The lines are joined with `tr`/`sed`, not `paste -sd:`: the bundled
# short-option form is a GNU extension that the BSD paste on macOS rejects
# with a usage message, and the launcher would die there before starting.
clean_path="$(printf '%s' "$PATH" | tr ':' '\n' | { grep -v 'vision-git/shim' || true; } | tr '\n' ':' | sed 's/:$//')"
export PATH="$clean_path"

# Pi reads its own home from PI_CODING_AGENT_DIR. PI_HOME stays as an alias.
PI_HOME_DIR="${PI_CODING_AGENT_DIR:-${PI_HOME:-$HOME/.pi/agent}}"
PI_AUTH="$PI_HOME_DIR/auth.json"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/pi-dsh-bridge}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

# A dsh that cannot mount an agent preset leaves the panel open but unable to
# create a single session: the preset registry throws while mounting and the
# UI reports `agent-preset/invalid: Cannot read properties of undefined
# (reading 'parent')`. Refuse to start that build instead of handing over a
# dead panel. The list mirrors KNOWN_BROKEN_DSH_VERSIONS in src/compat.js.
DSH_VERSION="$(dsh --version 2>/dev/null | head -n 1 | tr -d '\r' | sed 's/^v//' | awk '{print $1}' || true)"
if [ "$DSH_VERSION" = "0.2.2-alpha.2" ]; then
  echo "ERROR: dsh $DSH_VERSION cannot mount agent presets." >&2
  echo "       New sessions fail with: agent-preset/invalid: Cannot read properties of undefined (reading 'parent')" >&2
  echo "  Fix: npm install -g @deepseek-ai/dsh@0.2.2-alpha.3" >&2
  echo "        (0.2.1-rc.5 is the latest release candidate and is not affected)" >&2
  exit 1
fi

# Is the dsh account grant usable? The helper installed next to the CLI knows
# the paths; the CLI itself is the fallback.
ACCOUNT_OK=0
TOKEN_HELPER="$BIN_DIR/pi-dsh-token"
if [ -x "$TOKEN_HELPER" ]; then
  if "$TOKEN_HELPER" token --check --dsh-home "$DSH_HOME" >/dev/null 2>&1; then ACCOUNT_OK=1; fi
elif command -v pi-dsh-bridge >/dev/null 2>&1; then
  if pi-dsh-bridge token --check --dsh-home "$DSH_HOME" >/dev/null 2>&1; then ACCOUNT_OK=1; fi
fi

if [ "$ACCOUNT_OK" = "1" ]; then
  echo "route: dsh account (deepseek-account/deepseek-flash) — the same account Pi uses"
else
  # No usable account grant. The API-key route is a different wallet, so it
  # is used only as an explicit fallback and said out loud.
  if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$PI_AUTH" ]; then
    DEEPSEEK_API_KEY="$(node -p "try{require('$PI_AUTH').deepseek.key||''}catch(e){''}" 2>/dev/null || true)"
    export DEEPSEEK_API_KEY
  fi
  if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    echo "ERROR: no DeepSeek credential." >&2
    echo "  Sign in to DeepSeek in the dsh web interface, then run: pi-dsh-bridge sync" >&2
    echo "  Or export DEEPSEEK_API_KEY, register it in Pi ($PI_AUTH)," >&2
    echo "  or paste it in dsh web -> Settings -> Models." >&2
    exit 1
  fi
  echo "route: API key (deepseek-official/deepseek-flash) — fallback, NOT the dsh account" >&2
  echo "note: the dsh account grant is unusable, so dsh and Pi are not on the same account yet" >&2
fi

# The account platform dashboard is a different host from the inference API.
# When it is blocked from this machine (Cloudflare answers 403) the account
# panel cannot load while inference still works. Say it once instead of
# letting it look like a healthy route.
#
# The probe has to look like the browser that will actually sign in: the
# dashboard sits behind a WAF that turns away a plain command line client
# with 403 and asks a browser for a check instead. Probing with curl's own
# user agent measures what curl may do, not what the user's browser may do,
# and the answer was "blocked" for a dashboard the browser can open.
if [ "$ACCOUNT_OK" = "1" ] && command -v curl >/dev/null 2>&1; then
  PLATFORM_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \
    https://platform.deepseek.com/auth-api/v0/users/current 2>/dev/null || echo 000)"
  if [ "$PLATFORM_STATUS" = "403" ]; then
    echo "note: the DeepSeek account dashboard is blocked from this machine (HTTP 403)." >&2
    echo "      Inference still works; only the account panel in the web UI is affected." >&2
  fi
fi

# The overlay is applied at launch, and only when install detected a divergence
# from the required route. $DSH_HOME/profiles/web/cordis.patch.yml is never edited.
OVERLAY="$STATE_DIR/dsh-overlay.yml"
PATCH_ARGS=()
if [ -f "$OVERLAY" ]; then
  PATCH_ARGS=(--patch "$OVERLAY")
fi

# The route the panel mounts has to be the route this launcher just announced.
# The overlay pins the account route, but that route is only usable when its
# grant is: without it the panel has to use the API-key route, the one this
# launcher said it fell back to. Mounting the account route anyway leaves the
# UI without a model to run, and the user is told the panel is ready. A patch
# passed later wins, so the route patch is passed last.
ROUTE_PATCH="$STATE_DIR/dsh-web-route.yml"
if [ "$ACCOUNT_OK" = "1" ]; then
  ROUTE_PROVIDER=deepseek-account
else
  ROUTE_PROVIDER=deepseek-official
fi
{
  printf '%s\n' '- id: agent-default-model'
  printf '%s\n' '  name: "@deepseek-ai/dsh-agent-default-model"'
  printf '%s\n' '  config:'
  printf '    provider: %s\n' "$ROUTE_PROVIDER"
  printf '%s\n' '    model: deepseek-flash'
} > "$ROUTE_PATCH"
PATCH_ARGS+=(--patch "$ROUTE_PATCH")

# Portable default: never a locale-specific "Documents" folder.
WS="${DSH_WORKSPACE:-$DSH_HOME/workspace}"
mkdir -p "$WS"
cd "$WS"

PORT="${DSH_PORT:-3080}"
echo "DeepSeek Harness web -> http://127.0.0.1:$PORT (open the token URL printed below)"

# dsh's grammar is `dsh [--profile] <name> [options] [app-args...]`. With the
# profile named explicitly the app flags follow the global options, and the
# `web` shortcut must not be repeated.
exec dsh --profile web ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"} --port "$PORT" --no-open
