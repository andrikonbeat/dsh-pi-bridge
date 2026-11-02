#!/usr/bin/env bash
# Restore the files backed up by install.sh.
#
#   ./uninstall.sh                 # restore the latest backup
#   ./uninstall.sh backups/<dir>   # restore a specific backup
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BACKUP="${1:-}"

if [ -z "$BACKUP" ]; then
  BACKUP="$(ls -1d "$ROOT"/backups/*/ 2>/dev/null | sort | tail -1 || true)"
fi
if [ -z "$BACKUP" ] || [ ! -d "$BACKUP" ]; then
  echo "ERROR: no backup found under $ROOT/backups" >&2
  exit 1
fi

echo "Restoring from $BACKUP"
if [ -f "$BACKUP/settings.json" ]; then
  cp -a "$BACKUP/settings.json" "$PI_HOME/settings.json"
  echo "  restored $PI_HOME/settings.json"
fi
if [ -f "$BACKUP/web-cordis.patch.yml" ]; then
  cp -a "$BACKUP/web-cordis.patch.yml" "$DSH_HOME/profiles/web/cordis.patch.yml"
  echo "  restored $DSH_HOME/profiles/web/cordis.patch.yml"
fi
if [ -f "$BACKUP/start-web.sh" ]; then
  cp -a "$BACKUP/start-web.sh" "$DSH_HOME/start-web.sh"
  echo "  restored $DSH_HOME/start-web.sh"
else
  rm -f "$DSH_HOME/start-web.sh"
  echo "  removed $DSH_HOME/start-web.sh (it did not exist before install)"
fi
rm -f "$BIN_DIR/pi-deepseek"
echo "  removed $BIN_DIR/pi-deepseek"
echo "Done."
