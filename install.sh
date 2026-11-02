#!/usr/bin/env bash
# Legacy entry point, kept so existing habits and docs keep working.
#
#   ./install.sh [--dry-run] [-y] [--json] [--model <id>]
#
# There is exactly one implementation: this forwards to the CLI in bin/cli.js.
# Environment overrides still work: PI_HOME, DSH_HOME, BIN_DIR, STATE_DIR.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/bin/cli.js" install "$@"
