#!/usr/bin/env bash
# Legacy entry point, kept so existing habits and docs keep working.
#
#   ./uninstall.sh              # restore what the install journal recorded
#   ./uninstall.sh --dry-run    # show what would be restored
#
# The old script restored a whole backup directory passed as an argument. That
# contract is deliberately gone: restoring a directory wholesale can silently
# revert a file you edited after installing. If you pass a path, this script
# says so instead of guessing.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *)
      cat >&2 <<MSG
ERROR: uninstall no longer takes a backup path ($arg).

Restore is journal-based and per changed file. Run:

  npx pi-dsh-bridge uninstall            # restore what install recorded
  npx pi-dsh-bridge uninstall --dry-run  # see the plan first

If you need the old whole-directory restore, the manual procedure is in
docs/legacy-setup.md.
MSG
      exit 2
      ;;
  esac
done

exec node "$ROOT/bin/cli.js" uninstall "$@"
