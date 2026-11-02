#!/usr/bin/env bash
# Print the DeepSeek account token that Pi's shared provider sends.
#
# Pi calls this through the `!command` value of the `x-dsh-auth-token`
# header in models.json. Two rules follow from that:
#
#   - stdout carries the token and nothing else;
#   - every diagnostic goes to stderr.
#
# The token itself is never written to a file by this project: it is read
# from the dsh credentials store at call time and handed straight to Pi.
#
# Installed by pi-dsh-bridge install. Set PI_DSH_BRIDGE_BIN to point Pi at a
# different copy of the CLI.
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-__DSH_HOME__}"
CLI="${PI_DSH_BRIDGE_BIN:-__CLI_PATH__}"

if [ ! -x "$CLI" ] && ! command -v "$CLI" >/dev/null 2>&1; then
  if command -v pi-dsh-bridge >/dev/null 2>&1; then
    CLI="$(command -v pi-dsh-bridge)"
  else
    echo "pi-dsh-bridge: cannot find the CLI (set PI_DSH_BRIDGE_BIN)" >&2
    exit 1
  fi
fi

exec "$CLI" token --dsh-home "$DSH_HOME_DIR" "$@"
