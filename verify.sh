#!/usr/bin/env bash
# End-to-end verification: DeepSeek inside Pi/gentle-shell + dsh headless + dsh web.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PORT="${DSH_PORT:-3080}"
FAIL=0

ok()   { printf "  OK   %s\n" "$*"; }
bad()  { printf "  FAIL %s\n" "$*"; FAIL=1; }
info() { printf "  ..   %s\n" "$*"; }

echo "== Pi settings =="
if node - "$PI_HOME/settings.json" <<'NODE'
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const good = s.defaultProvider === "deepseek" && s.defaultModel === "deepseek-flash";
console.log(`  ${good ? "OK  " : "FAIL"} defaultProvider=${s.defaultProvider} defaultModel=${s.defaultModel}`);
process.exit(good ? 0 : 1);
NODE
then :; else FAIL=1; fi

echo "== DeepSeek credential =="
if pi auth check --provider deepseek 2>/dev/null | grep -q ready; then
  ok "Pi credential ready"
else
  bad "Pi credential missing (pi auth login --provider deepseek)"
fi

echo "== DeepSeek completion (Pi, no extensions) =="
out="$(timeout -s KILL 90 pi -ne --provider deepseek --model deepseek-flash \
  --no-tools --no-session --print 'Respondé exactamente: OK' 2>&1 | tail -3)"
case "$out" in
  *OK*) ok "completion: $(printf '%s' "$out" | tr '\n' ' ')" ;;
  *)    bad "completion: $(printf '%s' "$out" | tr '\n' ' ')" ;;
esac

echo "== Pi tools under DeepSeek =="
out="$(timeout -s KILL 180 pi --no-skill-registry --provider deepseek --model deepseek-flash \
  --no-session --print 'Usá la herramienta bash para ejecutar exactamente: echo PI-TOOLS-OK. Luego respondé solo la salida.' 2>&1 | tail -3)"
case "$out" in
  *PI-TOOLS-OK*) ok "bash tool works under DeepSeek" ;;
  *)             bad "bash tool: $(printf '%s' "$out" | tr '\n' ' ')" ;;
esac

echo "== dsh headless =="
KEY="${DEEPSEEK_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$PI_HOME/auth.json" ]; then
  KEY="$(node -p "try{require('$PI_HOME/auth.json').deepseek.key||''}catch(e){''}" 2>/dev/null || true)"
fi
if [ -n "$KEY" ]; then
  WS="${DSH_WORKSPACE:-$HOME/Documentos/deepseek-harness-default-workspace}"
  mkdir -p "$WS"
  out="$(cd "$WS" && DEEPSEEK_API_KEY="$KEY" timeout -s KILL 180 dsh headless 'Respondé exactamente: OK' 2>&1 | tail -3)"
  case "$out" in
    *OK*) ok "dsh headless: OK" ;;
    *)    bad "dsh headless: $(printf '%s' "$out" | tr '\n' ' ')" ;;
  esac
else
  bad "no DeepSeek key for dsh (Pi auth.json or DEEPSEEK_API_KEY)"
fi

echo "== dsh web =="
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  URL="$(grep -oE "http://127\.0\.0\.1:$PORT/\?token=[A-Za-z0-9_-]+" "$DSH_HOME/web.log" 2>/dev/null | tail -1)"
  if [ -n "$URL" ]; then
    code="$(timeout 20 curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
    if [ "$code" = "303" ]; then ok "web answers 303 on the token URL"; else bad "web token URL returned ${code:-timeout}"; fi
  else
    info "server listening on $PORT but no token URL in $DSH_HOME/web.log"
  fi
else
  info "server not running; start it with $DSH_HOME/start-web.sh"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; fi
exit "$FAIL"
