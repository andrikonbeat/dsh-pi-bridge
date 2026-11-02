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
export PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'vision-git/shim' | paste -sd:)"

# Pi reads its own home from PI_CODING_AGENT_DIR. PI_HOME stays as an alias.
PI_HOME_DIR="${PI_CODING_AGENT_DIR:-${PI_HOME:-$HOME/.pi/agent}}"
PI_AUTH="$PI_HOME_DIR/auth.json"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/pi-dsh-bridge}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

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
if [ "$ACCOUNT_OK" = "1" ] && command -v curl >/dev/null 2>&1; then
  PLATFORM_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
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
