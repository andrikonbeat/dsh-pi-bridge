#!/usr/bin/env bash
# Run the pi-dsh-bridge CLI wherever it was installed.
#
# Pi records this helper's absolute path in models.json and runs it through
# the shell to obtain the account token. Keeping the path here — instead of
# pointing Pi straight at a package directory — is what lets the bridge
# survive an `npx` cache clean and a package upgrade.
#
# This script takes no arguments of its own: whatever Pi asks for is passed
# straight to the CLI.
#
#   pi-dsh-token token --dsh-home /home/me/.dsh
#   pi-dsh-token token --check --dsh-home /home/me/.dsh
#
# The token itself is never written to a file by this project: it is read
# from the dsh credentials store at call time and handed straight to Pi.
#
# Set PI_DSH_BRIDGE_BIN to point Pi at a different copy of the CLI.
set -euo pipefail

CLI="${PI_DSH_BRIDGE_BIN:-__CLI_PATH__}"

if [ ! -x "$CLI" ] && ! command -v "$CLI" >/dev/null 2>&1; then
  if command -v pi-dsh-bridge >/dev/null 2>&1; then
    CLI="$(command -v pi-dsh-bridge)"
  else
    echo "pi-dsh-bridge: cannot find the CLI (set PI_DSH_BRIDGE_BIN)" >&2
    exit 1
  fi
fi

exec "$CLI" "$@"
