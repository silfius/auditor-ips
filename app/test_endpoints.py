#!/usr/bin/env python3
"""
test_endpoints.py — Auditor IPs  (Sesión 10)
Verifica que todos los endpoints del nuevo código responden igual que el original.

Uso:
    python test_endpoints.py
    python test_endpoints.py --base https://localhost:8088
    python test_endpoints.py --base http://192.168.1.x:8088 --no-verify-ssl
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
import ssl
import time

# ── Args ─────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--base",           default="https://localhost:8088")
parser.add_argument("--no-verify-ssl",  action="store_true")
parser.add_argument("--verbose",        action="store_true")
args = parser.parse_args()

BASE     = args.base.rstrip("/")
SSL_CTX  = ssl.create_default_context()
if args.no_verify_ssl:
    SSL_CTX.check_hostname = False
    SSL_CTX.verify_mode    = ssl.CERT_NONE

# ── Colores ───────────────────────────────────────────────────────────────────
OK   = "\033[92m✅\033[0m"
ERR  = "\033[91m❌\033[0m"
WARN = "\033[93m⚠️ \033[0m"
SKIP = "\033[90m⏭ \033[0m"

passed = failed = skipped = 0


def request(method, path, body=None, expect_status=200, expect_keys=None, label=None):
    global passed, failed, skipped
    url   = BASE + path
    name  = label or f"{method} {path}"
    data  = json.dumps(body).encode() if body else None
    hdrs  = {"Content-Type": "application/json"} if data else {}

    try:
        req  = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        resp = urllib.request.urlopen(req, context=SSL_CTX, timeout=10)
        status = resp.status
        raw    = resp.read()
        try:    obj = json.loads(raw)
        except: obj = {}

        if status != expect_status:
            failed += 1
            print(f"  {ERR}  {name} → HTTP {status} (esperado {expect_status})")
            return obj

        missing = [k for k in (expect_keys or []) if k not in obj]
        if missing:
            failed += 1
            print(f"  {ERR}  {name} → faltan claves: {missing}")
            return obj

        passed += 1
        extra = ""
        if args.verbose and obj:
            preview = str(obj)[:80]
            extra   = f"  \033[90m{preview}\033[0m"
        print(f"  {OK}  {name}{extra}")
        return obj

    except urllib.error.HTTPError as e:
        if e.code == expect_status:
            passed += 1
            print(f"  {OK}  {name} → HTTP {e.code} (esperado)")
            return {}
        failed += 1
        print(f"  {ERR}  {name} → HTTP {e.code}: {e.reason}")
        return {}
    except Exception as e:
        failed += 1
        print(f"  {ERR}  {name} → {e}")
        return {}


def skip(name):
    global skipped
    skipped += 1
    print(f"  {SKIP}  {name}")


# ══════════════════════════════════════════════════════════════════════════════
print(f"\n{'═'*60}")
print(f"  Auditor IPs — Test de endpoints")
print(f"  Base URL: {BASE}")
print(f"{'═'*60}\n")

# ── 1. Páginas HTML ───────────────────────────────────────────────────────────
print("─── Páginas HTML ────────────────────────────────────────────────")
request("GET",  "/",       expect_status=200, label="GET / (home)")
request("GET",  "/login",  expect_status=200, label="GET /login")

# ── 2. Auth ───────────────────────────────────────────────────────────────────
print("\n─── Auth ────────────────────────────────────────────────────────")
request("GET",  "/api/auth/status",  expect_keys=["ok", "auth_enabled"], label="GET /api/auth/status")
request("POST", "/api/auth/login",   body={"username":"x","password":"x"},
        expect_status=401, label="POST /api/auth/login (credenciales erróneas → 401)")
request("POST", "/api/auth/logout",  expect_keys=["ok"], label="POST /api/auth/logout")

# ── 3. Estado general ─────────────────────────────────────────────────────────
print("\n─── Estado general ──────────────────────────────────────────────")
request("GET",  "/api/status",    expect_keys=["ok","online","offline","total"], label="GET /api/status")
request("GET",  "/api/dashboard", expect_keys=["ok","hosts"],                   label="GET /api/dashboard")

# ── 4. Hosts ──────────────────────────────────────────────────────────────────
print("\n─── Hosts ───────────────────────────────────────────────────────")
data = request("GET", "/api/status", label=None)
hosts = data.get("recent_new", [])

request("GET",  "/api/search?q=192",         expect_keys=["ok"],           label="GET /api/search?q=192")
request("GET",  "/api/tags",                  expect_keys=["ok"],           label="GET /api/tags")
request("GET",  "/export.csv",                expect_status=200,            label="GET /export.csv")

# Si hay algún host, probar endpoints por IP
test_ip = None
try:
    res2 = urllib.request.urlopen(
        urllib.request.Request(BASE + "/api/status"),
        context=SSL_CTX, timeout=5
    )
    obj2 = json.loads(res2.read())
    # Obtener primera IP conocida desde dashboard
    res3 = urllib.request.urlopen(
        urllib.request.Request(BASE + "/api/dashboard"),
        context=SSL_CTX, timeout=5
    )
    obj3    = json.loads(res3.read())
    h_list  = obj3.get("hosts", {})
    if obj3.get("long_offline"):
        test_ip = obj3["long_offline"][0]["ip"]
    elif obj3.get("recent_events"):
        test_ip = obj3["recent_events"][0]["ip"]
except Exception:
    pass

if test_ip:
    request("GET", f"/api/hosts/{test_ip}/detail",     expect_keys=["ok"],  label=f"GET /api/hosts/{test_ip}/detail")
    request("GET", f"/api/hosts/{test_ip}/uptime",     expect_keys=["ok"],  label=f"GET /api/hosts/{test_ip}/uptime")
    request("GET", f"/api/hosts/{test_ip}/latency",    expect_keys=["ok"],  label=f"GET /api/hosts/{test_ip}/latency")
    request("GET", f"/api/hosts/{test_ip}/scan-history", expect_keys=["ok"],label=f"GET /api/hosts/{test_ip}/scan-history")
else:
    skip("Endpoints /api/hosts/{ip}/* (sin hosts disponibles)")

# ── 5. Tipos ──────────────────────────────────────────────────────────────────
print("\n─── Tipos de host ───────────────────────────────────────────────")
request("GET", "/api/types", expect_keys=["ok", "types"], label="GET /api/types")

# ── 6. Scans ──────────────────────────────────────────────────────────────────
print("\n─── Scans ───────────────────────────────────────────────────────")
request("GET", "/api/scans", expect_keys=["ok"], label="GET /api/scans")
skip("POST /scan (lanzaría scan real — ejecutar manualmente si se desea)")

# ── 7. Servicios ──────────────────────────────────────────────────────────────
print("\n─── Servicios ───────────────────────────────────────────────────")
request("GET", "/api/services", expect_keys=["ok", "services"], label="GET /api/services")

# ── 8. Alertas ────────────────────────────────────────────────────────────────
print("\n─── Alertas ─────────────────────────────────────────────────────")
request("GET", "/api/alerts", expect_keys=["ok"], label="GET /api/alerts")

# ── 9. Quality ────────────────────────────────────────────────────────────────
print("\n─── Calidad de conexión ─────────────────────────────────────────")
request("GET", "/api/quality/settings", expect_keys=["ok"],     label="GET /api/quality/settings")
request("GET", "/api/quality/targets",  expect_keys=["ok"],     label="GET /api/quality/targets")
request("GET", "/api/quality/summary",  expect_keys=["ok"],     label="GET /api/quality/summary")
request("GET", "/api/quality/history",  expect_keys=["ok"],     label="GET /api/quality/history")

# ── 10. Router SSH ────────────────────────────────────────────────────────────
print("\n─── Router SSH ──────────────────────────────────────────────────")
request("GET", "/api/router/status", expect_keys=["ok", "enabled"], label="GET /api/router/status")
request("GET", "/api/router/scans",  expect_keys=["ok"],             label="GET /api/router/scans")

# ── 11. Settings ──────────────────────────────────────────────────────────────
print("\n─── Settings ────────────────────────────────────────────────────")
request("GET", "/api/settings", expect_keys=["ok", "settings"], label="GET /api/settings")

# ── 12. Backup ────────────────────────────────────────────────────────────────
print("\n─── Backup ──────────────────────────────────────────────────────")
request("GET", "/api/backup/list", expect_keys=["ok"], label="GET /api/backup/list")

# ── 13. Push / VAPID ─────────────────────────────────────────────────────────
print("\n─── Push / VAPID ────────────────────────────────────────────────")
request("GET", "/api/push/vapid-key", expect_keys=["ok"], label="GET /api/push/vapid-key")

# ── 14. OpenAPI / docs ────────────────────────────────────────────────────────
print("\n─── OpenAPI ─────────────────────────────────────────────────────")
request("GET", "/docs",         expect_status=200, label="GET /docs (Swagger UI)")
request("GET", "/openapi.json", expect_status=200, label="GET /openapi.json")

# ── 15. PWA ───────────────────────────────────────────────────────────────────
print("\n─── PWA ─────────────────────────────────────────────────────────")
request("GET", "/manifest.json", expect_status=200, label="GET /manifest.json")
request("GET", "/sw.js",         expect_status=200, label="GET /sw.js")

# ── Resumen ───────────────────────────────────────────────────────────────────
total = passed + failed + skipped
print(f"\n{'═'*60}")
print(f"  {OK}  Pasados:  {passed}/{total-skipped}")
if failed:
    print(f"  {ERR}  Fallidos: {failed}")
if skipped:
    print(f"  {SKIP}  Saltados: {skipped}")
print(f"{'═'*60}\n")

sys.exit(0 if failed == 0 else 1)
