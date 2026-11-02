#!/usr/bin/env bash
# Launch Pi on DeepSeek while keeping every Pi/gentle-shell tool.
#
#   pi-deepseek                          interactive session
#   pi-deepseek --print "one shot"       non-interactive
#   pi-deepseek --provider deepseek --model deepseek-v4-pro
#
# Why plain `pi` and not `gentle-shell --link`:
# the live Pi home already declares gentle-pi once, by local path, so `pi`
# loads the same gentle-shell extensions (gentle:retry, gentle-ai, skills,
# codemode, ...) as the launcher does. The plain `gentle-shell` launcher is
# verified to leave settings.json untouched, but its explicit `--link` flag
# performs a take-over that rewrites the package declaration, which is how a
# duplicate `npm:gentle-pi` entry (slow npm install on every Pi start, plus
# "Tool ... conflicts with ..." errors) got in during setup.
#
# For interactive work, just run `gentle-shell`: it starts on DeepSeek and
# Ctrl+P opens the model picker. This wrapper is for flag-driven runs.
#
# Env:
#   PI_DEEPSEEK_PROVIDER        default: deepseek
#   PI_DEEPSEEK_MODEL           default: deepseek-flash
#   PI_DEEPSEEK_FULL_STARTUP=1  keep the skill-registry refresh (slower boot)
#   PI_DEEPSEEK_NO_MCP=1        skip MCP servers (faster boot, fewer tools)
set -euo pipefail

PROVIDER="${PI_DEEPSEEK_PROVIDER:-deepseek}"
MODEL="${PI_DEEPSEEK_MODEL:-deepseek-flash}"

# Resolve the account credential fresh, on every start.
#
# The token itself is never read here: Pi fetches it on demand through the
# command recorded in models.json, so switching accounts in the dsh web
# interface changes the account Pi spends on the next start.
#
# This check only asks whether that route is usable. Without it, a signed-out
# or half-written credential surfaces as a 401 from DeepSeek with no hint of
# what went wrong.
HELPER="$(dirname "$0")/pi-dsh-token"
if [ -x "$HELPER" ]; then
  TOKEN_CHECK=("$HELPER" --check)
elif command -v pi-dsh-bridge >/dev/null 2>&1; then
  TOKEN_CHECK=(pi-dsh-bridge token --check)
else
  TOKEN_CHECK=()
fi

if [ "${#TOKEN_CHECK[@]}" -gt 0 ]; then
  if ! "${TOKEN_CHECK[@]}" >/dev/null 2>&1; then
    echo "ERROR: the dsh DeepSeek account credential is not usable." >&2
    echo "  Sign in to DeepSeek in the dsh web interface, then run: pi-dsh-bridge sync" >&2
    echo "  Pi reads the token on demand, so there is nothing else to change." >&2
    exit 1
  fi
fi

FLAGS=(--provider "$PROVIDER" --model "$MODEL")
if [ "${PI_DEEPSEEK_FULL_STARTUP:-0}" != "1" ]; then
  FLAGS+=(--no-skill-registry)
fi
if [ "${PI_DEEPSEEK_NO_MCP:-0}" = "1" ]; then
  FLAGS+=(--no-mcp)
fi

exec pi "${FLAGS[@]}" "$@"
