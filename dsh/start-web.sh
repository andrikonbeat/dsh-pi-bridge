#!/usr/bin/env bash
# Start the DeepSeek Harness web UI with a working DeepSeek credential.
#
# The key is not duplicated: it is read from Pi's auth store at launch time.
# Override it with DEEPSEEK_API_KEY if you prefer.
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

PI_AUTH="${PI_HOME:-$HOME/.pi/agent}/auth.json"
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$PI_AUTH" ]; then
  DEEPSEEK_API_KEY="$(node -p "try{require('$PI_AUTH').deepseek.key||''}catch(e){''}" 2>/dev/null || true)"
  export DEEPSEEK_API_KEY
fi
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "ERROR: no DeepSeek credential." >&2
  echo "  Export DEEPSEEK_API_KEY, register it in Pi ($PI_AUTH)," >&2
  echo "  or paste it in dsh web -> Settings -> Models." >&2
  exit 1
fi

WS="${DSH_WORKSPACE:-$HOME/Documentos/deepseek-harness-default-workspace}"
mkdir -p "$WS"
cd "$WS"

PORT="${DSH_PORT:-3080}"
echo "DeepSeek Harness web -> http://127.0.0.1:$PORT (open the token URL printed below)"
exec dsh web --port "$PORT" --no-open
