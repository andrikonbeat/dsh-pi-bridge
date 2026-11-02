#!/usr/bin/env bash
# Legacy entry point, kept so existing habits and docs keep working.
#
#   ./verify.sh
#
# Forwards to the CLI with --yes, because "run the end-to-end verification" is
# what this script has always meant. It spends DeepSeek API credit; that is
# unchanged from the original script. Prefer `npx pi-dsh-bridge doctor` for a
# free check, or call the CLI directly to get the confirmation prompt.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/bin/cli.js" verify --yes "$@"
