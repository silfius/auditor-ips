#!/usr/bin/env bash

# Smoke seguro de salud interna Auditor IPs.
# Comprueba:
# - /api/system/healthz público
# - /api/system/health sin sesión debe devolver 401
# - login temporal por /api/auth/login
# - /api/system/health autenticado
# - logout por /api/auth/logout
#
# No imprime contraseña, cookies ni tokens.
#
# Uso:
#   ./LOCAL/scripts/smoke_system_health.sh
#   AUDITOR_BASE_URL=https://127.0.0.1:9909 ./LOCAL/scripts/smoke_system_health.sh
#   AUDITOR_USER=admin AUDITOR_PASS='...' ./LOCAL/scripts/smoke_system_health.sh

BASE_URL="${AUDITOR_BASE_URL:-${1:-https://127.0.0.1:9909}}"
BASE_URL="${BASE_URL%/}"

TLS_ARGS=("-k")
if [ "${AUDITOR_STRICT_TLS:-0}" = "1" ]; then
  TLS_ARGS=()
fi

COOKIE_FILE="$(mktemp /tmp/auditor_smoke_cookie.XXXXXX)"
LOGIN_PAYLOAD="$(mktemp /tmp/auditor_smoke_login.XXXXXX)"
RESP_FILE="$(mktemp /tmp/auditor_smoke_resp.XXXXXX)"
FAILURES=0

cleanup() {
  rm -f "$COOKIE_FILE" "$LOGIN_PAYLOAD" "$RESP_FILE"
  unset AUDITOR_SMOKE_USER AUDITOR_SMOKE_PASS
}
trap cleanup EXIT

ok() {
  printf '[OK] %s\n' "$1"
}

fail() {
  printf '[ERROR] %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

info() {
  printf '[INFO] %s\n' "$1"
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

path = sys.argv[1]
field = sys.argv[2]

try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print("")
    raise SystemExit(0)

value = data
for part in field.split("."):
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break

if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

request() {
  method="$1"
  url="$2"
  out="$3"
  shift 3

  http_code="$(curl "${TLS_ARGS[@]}" -sS \
    --connect-timeout "${AUDITOR_CURL_CONNECT_TIMEOUT:-5}" \
    --max-time "${AUDITOR_CURL_MAX_TIME:-20}" \
    -X "$method" \
    -o "$out" \
    -w "%{http_code}" \
    "$@" \
    "$url")"
  rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "curl_error:$rc"
  else
    echo "$http_code"
  fi
}

info "Base URL: $BASE_URL"

echo
info "1/5 healthz público"
code="$(request GET "$BASE_URL/api/system/healthz" "$RESP_FILE")"
if [ "$code" = "200" ]; then
  status="$(json_field "$RESP_FILE" "status")"
  db_check="$(json_field "$RESP_FILE" "checks.database")"
  storage_check="$(json_field "$RESP_FILE" "checks.storage")"
  ok "healthz HTTP 200 · status=${status:-?} · database=${db_check:-?} · storage=${storage_check:-?}"
else
  fail "healthz esperaba HTTP 200 y devolvió $code"
fi

echo
info "2/5 health protegido sin sesión"
code="$(request GET "$BASE_URL/api/system/health" "$RESP_FILE")"
if [ "$code" = "401" ]; then
  auth_required="$(json_field "$RESP_FILE" "auth_required")"
  ok "health sin sesión HTTP 401 · auth_required=${auth_required:-?}"
else
  fail "health sin sesión esperaba HTTP 401 y devolvió $code"
fi

echo
info "3/5 login temporal"

if [ -n "${AUDITOR_USER:-}" ]; then
  user="$AUDITOR_USER"
else
  printf 'Usuario Auditor IPs: '
  read -r user
fi

if [ -n "${AUDITOR_PASS:-}" ]; then
  pass="$AUDITOR_PASS"
else
  printf 'Contraseña Auditor IPs: '
  read -r -s pass
  printf '\n'
fi

AUDITOR_SMOKE_USER="$user" AUDITOR_SMOKE_PASS="$pass" python3 - <<'PY' > "$LOGIN_PAYLOAD"
import json
import os

print(json.dumps({
    "username": os.environ.get("AUDITOR_SMOKE_USER", ""),
    "password": os.environ.get("AUDITOR_SMOKE_PASS", ""),
}))
PY

chmod 600 "$LOGIN_PAYLOAD"

code="$(request POST "$BASE_URL/api/auth/login" "$RESP_FILE" \
  -c "$COOKIE_FILE" \
  -H "Content-Type: application/json" \
  --data-binary "@$LOGIN_PAYLOAD")"

login_ok="$(json_field "$RESP_FILE" "ok")"
login_user="$(json_field "$RESP_FILE" "username")"

if [ "$code" = "200" ] && [ "$login_ok" = "true" ]; then
  ok "login HTTP 200 · usuario=${login_user:-$user}"
else
  err="$(json_field "$RESP_FILE" "error")"
  fail "login falló · HTTP $code · ${err:-sin detalle}"
fi

unset pass AUDITOR_SMOKE_PASS
: > "$LOGIN_PAYLOAD"

echo
info "4/5 health protegido autenticado"
code="$(request GET "$BASE_URL/api/system/health" "$RESP_FILE" -b "$COOKIE_FILE")"
health_ok="$(json_field "$RESP_FILE" "ok")"
overall="$(json_field "$RESP_FILE" "overall")"
db_status="$(json_field "$RESP_FILE" "database.status")"
storage_status="$(json_field "$RESP_FILE" "storage.status")"
backup_status="$(json_field "$RESP_FILE" "backups.status")"

if [ "$code" = "200" ] && [ "$health_ok" = "true" ]; then
  ok "health autenticado HTTP 200 · overall=${overall:-?} · db=${db_status:-?} · storage=${storage_status:-?} · backups=${backup_status:-?}"
else
  err="$(json_field "$RESP_FILE" "error")"
  fail "health autenticado falló · HTTP $code · ok=${health_ok:-?} · ${err:-sin detalle}"
fi

echo
info "5/5 logout"
code="$(request POST "$BASE_URL/api/auth/logout" "$RESP_FILE" -b "$COOKIE_FILE")"
logout_ok="$(json_field "$RESP_FILE" "ok")"

if [ "$code" = "200" ] && [ "$logout_ok" = "true" ]; then
  ok "logout HTTP 200"
else
  err="$(json_field "$RESP_FILE" "error")"
  fail "logout falló · HTTP $code · ${err:-sin detalle}"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  ok "Smoke completado sin errores."
  exit 0
fi

fail "Smoke completado con $FAILURES error(es)."
exit 1
