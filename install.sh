#!/usr/bin/env bash
# Wire DeepSeek models into Pi / gentle-shell and install the dsh web launcher.
#
# What it changes (all backed up under backups/<timestamp>/):
#   1. ~/.pi/agent/settings.json             -> default provider/model = DeepSeek
#   2. ~/.dsh/profiles/web/cordis.patch.yml  -> provider route deepseek-official
#   3. ~/.dsh/start-web.sh                   -> launcher (reads the key from Pi)
#   4. ~/.local/bin/pi-deepseek              -> symlink to bin/pi-deepseek
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
SETTINGS="$PI_HOME/settings.json"
WEB_PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
LAUNCHER="$DSH_HOME/start-web.sh"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/backups/$STAMP"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v pi   >/dev/null 2>&1 || die "pi not found in PATH"
command -v dsh  >/dev/null 2>&1 || die "dsh not found in PATH"
command -v node >/dev/null 2>&1 || die "node not found in PATH"
[ -f "$SETTINGS" ] || die "missing $SETTINGS (is Pi installed for this user?)"

mkdir -p "$BACKUP" "$DSH_HOME/profiles/web" "$BIN_DIR"
cp -a "$SETTINGS" "$BACKUP/settings.json"
if [ -f "$WEB_PATCH" ]; then cp -a "$WEB_PATCH" "$BACKUP/web-cordis.patch.yml"; fi
if [ -f "$LAUNCHER" ]; then cp -a "$LAUNCHER" "$BACKUP/start-web.sh"; fi

echo "[1/4] Pi defaults -> DeepSeek"
node - "$SETTINGS" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
settings.defaultProvider = "deepseek";
settings.defaultModel = "deepseek-flash";
if (!Array.isArray(settings.enabledModels) || settings.enabledModels.length === 0) {
  settings.enabledModels = ["deepseek/*"];
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
NODE

echo "[2/4] dsh web profile -> deepseek-official"
install -m 0644 "$ROOT/dsh/cordis.patch.yml" "$WEB_PATCH"

echo "[3/4] dsh web launcher -> $LAUNCHER"
install -m 0755 "$ROOT/dsh/start-web.sh" "$LAUNCHER"

echo "[4/4] pi-deepseek wrapper -> $BIN_DIR/pi-deepseek"
chmod 0755 "$ROOT/bin/pi-deepseek"
ln -sfn "$ROOT/bin/pi-deepseek" "$BIN_DIR/pi-deepseek"

echo
echo "Backup: $BACKUP"
if pi auth check --provider deepseek 2>/dev/null | grep -q ready; then
  echo "DeepSeek credential: ready"
else
  echo "WARNING: no DeepSeek credential found. Run: pi auth login --provider deepseek"
fi
echo
echo "Next:"
echo "  pi-deepseek          # Pi/gentle-shell with DeepSeek + Pi tools"
echo "  $LAUNCHER           # DeepSeek Harness web on http://127.0.0.1:3080"
echo "  ./verify.sh          # end-to-end check"
