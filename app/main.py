"""
main.py — Auditor IPs
Orquestador: crea la app FastAPI, registra routers y arranca el scheduler.

Objetivo de esta versión:
- cerrar el perímetro de acceso cuando hay usuarios
- dejar públicas solo las rutas explícitamente permitidas
- mantener WoL público únicamente si wol_public=1
- redirigir páginas HTML privadas al login y devolver 401 JSON en la API

Toda la lógica de negocio vive en los módulos bajo routers/:
  routers/scans.py       — motor nmap, discord, push, OUI, fingerprint
  routers/hosts.py       — CRUD hosts, tipos, WoL, dashboard, export CSV
  routers/services.py    — servicios monitorizados TCP/HTTP
  routers/quality.py     — calidad de conexión (ping externo)
  routers/router_ssh.py  — integración router SSH
  routers/auth.py        — autenticación, sesiones, audit log
  routers/alerts.py      — alertas programables
  routers/config_api.py  — settings, backup/restore, push, VAPID, XLSX
"""

import os
import sqlite3
import struct
import threading
import zlib
from urllib.parse import quote

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from auth_middleware import (
    SESSION_COOKIE,
    auth_enabled,
    validate_session,
    init_auth_tables,
    log_action,
    get_client_ip,
    should_audit,
    semantic_action,
)
from config import cfg, load_settings, DB_PATH, SCAN_CIDR, SCAN_INTERVAL_SECONDS
from database import db, init_db

# ── Routers ──────────────────────────────────────────────────
from routers.daily_report import (
    router as daily_report_router,
    set_scheduler as dr_set_scheduler,
    register_daily_report_job,
)
from routers import (
    auth as r_auth,
    alerts as r_alerts,
    hosts as r_hosts,
    quality as r_quality,
    scans as r_scans,
    services as r_services,
    router_ssh as r_router_ssh,
    discovery as r_discovery,
    config_api as r_config_api,
    scripts_status as r_scripts_status,
    syncthing_control as r_syncthing_control,
    system_health as r_system_health,
)

# ═══════════════════════════════════════════════════════════════
#  App y static files
# ═══════════════════════════════════════════════════════════════


def _ensure_hosts_device_columns(db_path: str) -> None:
    """Asegura columnas device_* esperadas por hosts.py en BDs limpias/antiguas."""
    conn = sqlite3.connect(db_path)
    try:
        exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hosts'"
        ).fetchone()
        if not exists:
            return

        cols = {r[1] for r in conn.execute("PRAGMA table_info(hosts)").fetchall()}
        needed = {
            "device_type": "TEXT DEFAULT 'unknown'",
            "device_confidence": "INTEGER DEFAULT 0",
            "device_source": "TEXT DEFAULT ''",
            "device_label": "TEXT DEFAULT ''",
            "device_evidence": "TEXT DEFAULT ''",
            "device_updated_at": "TEXT DEFAULT ''",
        }
        for col, ddl in needed.items():
            if col not in cols:
                conn.execute(f"ALTER TABLE hosts ADD COLUMN {col} {ddl}")
        conn.commit()
    finally:
        conn.close()

app = FastAPI(
    title="Auditor IPs",
    docs_url="/docs",
    redoc_url="/redoc",
)

# BEGIN initial setup access gate v2
@app.middleware("http")
async def initial_setup_access_gate(request, call_next):
    """Bloquea la app hasta completar el asistente inicial transaccional."""
    try:
        from starlette.responses import RedirectResponse, JSONResponse
        from config import DB_PATH as _setup_db_path
        import sqlite3 as _setup_sqlite3

        path = request.url.path or "/"
        allowed_exact = {
            "/login",
            "/favicon.ico",
            "/manifest.json",
            "/sw.js",
            "/api/system/healthz",
            "/api/auth/initial-setup/confirm",
        }
        allowed_prefixes = ("/static/",)
        allowed = path in allowed_exact or any(path.startswith(prefix) for prefix in allowed_prefixes)

        if not allowed:
            has_admin = False
            try:
                conn = _setup_sqlite3.connect(_setup_db_path)
                try:
                    row = conn.execute("SELECT COUNT(*) FROM auth_users").fetchone()
                    has_admin = bool(row and int(row[0]) > 0)
                finally:
                    conn.close()
            except Exception:
                has_admin = False

            if not has_admin:
                if path.startswith("/api/"):
                    return JSONResponse(
                        {"ok": False, "error": "Configuración inicial pendiente."},
                        status_code=403,
                    )
                return RedirectResponse("/login", status_code=302)
    except Exception:
        pass

    return await call_next(request)
# END initial setup access gate v2


app.mount("/static", StaticFiles(directory="static", html=False), name="static")


# ═══════════════════════════════════════════════════════════════
#  Middleware — Auth enforce + Audit log
# ═══════════════════════════════════════════════════════════════

_PUBLIC_NON_API_EXACT_PATHS = {
    "/login",
    "/tls-info",
    "/manifest.json",
    "/sw.js",
}
_PUBLIC_NON_API_PREFIXES = (
    "/static/",
    "/docs",
    "/redoc",
    "/openapi.json",
)

_PUBLIC_API_EXACT_PATHS = {
    "/api/automation-agents/status",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/tls/ca.crt",
    "/api/system/healthz",
}


def _wol_is_public() -> bool:
    """Devuelve True si WoL está configurado como público (sin auth)."""
    try:
        return cfg("wol_public", "0") == "1"
    except Exception:
        return False


def _is_public_wol_path(path: str, method: str) -> bool:
    """
    WoL solo puede quedar público si wol_public=1 y además la ruta es una de las
    previstas para la página pública o para compatibilidad con las rutas legacy.
    """
    if path == "/wol" and method == "GET":
        return True
    if path == "/api/public/wol/hosts" and method == "GET":
        return True
    if path.startswith("/api/public/wol/") and path.endswith("/wake") and method == "POST":
        return True
    if path == "/api/wol/fixed" and method == "POST":
        return True
    return method == "POST" and path.startswith("/api/hosts/") and path.endswith("/wol")


def _is_public_path(path: str, method: str) -> bool:
    """Devuelve True si la ruta debe quedar pública incluso con auth activa."""
    if path in _PUBLIC_NON_API_EXACT_PATHS:
        return True
    if any(path.startswith(prefix) for prefix in _PUBLIC_NON_API_PREFIXES):
        return True
    if _wol_is_public() and _is_public_wol_path(path, method):
        return True

    if path.startswith("/api/"):
        if path in _PUBLIC_API_EXACT_PATHS:
            return True

    return False


def _build_login_redirect(request: Request) -> RedirectResponse:
    """
    Para rutas HTML privadas, redirigimos al login en vez de devolver JSON.
    Preservamos la URL de destino en `next`.
    """
    next_target = request.url.path
    if request.url.query:
        next_target += f"?{request.url.query}"
    login_url = f"/login?next={quote(next_target, safe='')}"
    return RedirectResponse(login_url, status_code=302)


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method
        token = request.cookies.get(SESSION_COOKIE)

        username = validate_session(DB_PATH, token) if auth_enabled(DB_PATH) else None

        if auth_enabled(DB_PATH) and not _is_public_path(path, method) and not username:
            if path.startswith("/api/"):
                return JSONResponse(
                    {
                        "ok": False,
                        "error": "Autenticación requerida",
                        "auth_required": True,
                        "show_login": True,
                    },
                    status_code=401,
                )
            return _build_login_redirect(request)

        response = await call_next(request)

        if should_audit(path) and response.status_code < 500:
            action = semantic_action(method, path)
            if action:
                ip = get_client_ip(request)
                detail = None

                if path.startswith("/api/hosts/"):
                    parts = path.split("/")
                    hip = parts[3] if len(parts) > 3 else None
                    if hip and "." in hip:
                        detail = {"host": hip}

                log_action(
                    DB_PATH,
                    ip,
                    action,
                    authed=bool(username),
                    username=username,
                    session_token=token,
                    detail=detail,
                )

        return response


app.add_middleware(AuditMiddleware)


# ═══════════════════════════════════════════════════════════════
#  Registrar routers
# ═══════════════════════════════════════════════════════════════

app.include_router(r_auth.router)
app.include_router(r_alerts.router)
app.include_router(r_hosts.router)
app.include_router(r_quality.router)
app.include_router(r_scans.router)
app.include_router(r_services.router)
app.include_router(r_router_ssh.router)
app.include_router(r_discovery.router)
app.include_router(r_config_api.router)
app.include_router(r_scripts_status.router)
app.include_router(r_syncthing_control.router)
app.include_router(r_system_health.router)
app.include_router(daily_report_router)


# ═══════════════════════════════════════════════════════════════
#  PWA icon generation (no deps externas)
# ═══════════════════════════════════════════════════════════════

def _generate_pwa_icons() -> None:
    """Genera iconos PNG mínimos para PWA si no existen."""
    static_dir = "static"
    os.makedirs(static_dir, exist_ok=True)
    for size in (192, 512):
        path = os.path.join(static_dir, f"icon-{size}.png")
        if os.path.exists(path):
            continue
        try:
            w = h = size
            color = (77, 255, 181)
            bg = (26, 31, 38)
            r_c = size // 4
            rows = []
            for y in range(h):
                row = []
                for x in range(w):
                    cx, cy = w // 2, h // 2
                    dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                    row.extend(color if dist < r_c else bg)
                rows.append(bytes([0] + row))
            raw = b"".join(rows)
            compressed = zlib.compress(raw)

            def chunk(tag: bytes, data: bytes) -> bytes:
                c = tag + data
                return (
                    struct.pack(">I", len(data))
                    + c
                    + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
                )

            ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
            png = (
                b"\\x89PNG\\r\\n\\x1a\\n"
                + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", compressed)
                + chunk(b"IEND", b"")
            )
            with open(path, "wb") as f:
                f.write(png)
        except Exception as e:
            print(f"[PWA] Icon generation failed for {size}px: {e}")


# ═══════════════════════════════════════════════════════════════
#  Startup
# ═══════════════════════════════════════════════════════════════

@app.on_event("startup")
def startup() -> None:
    init_db()
    load_settings()
    init_auth_tables(DB_PATH)
    _ensure_hosts_device_columns(DB_PATH)
    _generate_pwa_icons()

    from routers.scans import oui_lookup

    with db() as conn:
        hosts_no_vendor = conn.execute(
            "SELECT ip, mac FROM hosts WHERE mac IS NOT NULL AND (vendor IS NULL OR vendor='')"
        ).fetchall()
        for h in hosts_no_vendor:
            vendor = oui_lookup(h["mac"])
            if vendor:
                conn.execute("UPDATE hosts SET vendor=? WHERE ip=?", (vendor, h["ip"]))

    scheduler = BackgroundScheduler(timezone="UTC")

    r_quality.set_scheduler(scheduler)
    r_services.set_scheduler(scheduler)
    r_config_api.set_scheduler(scheduler)
    r_scans.set_scheduler(scheduler)
    dr_set_scheduler(scheduler)
    register_daily_report_job()

    lock = r_scans.get_db_write_lock()
    r_quality.set_db_write_lock(lock)

    scan_interval = int(cfg("scan_interval", SCAN_INTERVAL_SECONDS))

    scheduler.add_job(
        lambda: r_scans.run_scan_guarded(cfg("scan_cidr", SCAN_CIDR)),
        "interval",
        seconds=scan_interval,
        id="scan_job",
        replace_existing=True,
    )

    from routers.config_api import run_backup

    scheduler.add_job(
        run_backup,
        "cron",
        hour=3,
        minute=0,
        id="backup_job",
        replace_existing=True,
    )

    from routers.scripts_status import check_script_alerts

    script_alert_check_interval_seconds = int(cfg("script_alert_check_interval_seconds", "60") or 60)
    if script_alert_check_interval_seconds < 30:
        script_alert_check_interval_seconds = 30

    scheduler.add_job(
        check_script_alerts,
        "interval",
        seconds=script_alert_check_interval_seconds,
        id="script_alerts_job",
        replace_existing=True,
    )

    scheduler.add_job(
        r_syncthing_control.refresh_syncthing_overview_cache,
        "interval",
        seconds=r_syncthing_control.get_syncthing_refresh_interval_seconds(),
        id="syncthing_overview_cache_job",
        replace_existing=True,
        max_instances=2,
        coalesce=True,
        misfire_grace_time=30,
    )

    scheduler.start()

    r_services.schedule_services()

    with db() as conn_q:
        qs = conn_q.execute("SELECT enabled FROM quality_settings WHERE id=1").fetchone()
        if qs and qs["enabled"]:
            r_quality.reschedule_quality(True, 30)

    def _first_scan():
        import time

        time.sleep(3)
        try:
            r_scans.run_scan_guarded(cfg("scan_cidr", SCAN_CIDR))
        except Exception as e:
            print(f"[startup] Primer scan fallido: {e}")

    threading.Thread(target=_first_scan, daemon=True).start()

    def _first_syncthing_refresh():
        import time

        time.sleep(5)
        try:
            r_syncthing_control.refresh_syncthing_overview_cache(force=True)
        except Exception as e:
            print(f"[startup] Refresco inicial Syncthing fallido: {e}")

    threading.Thread(target=_first_syncthing_refresh, daemon=True).start()

    print(
        f"[startup] Auditor IPs listo — CIDR={cfg('scan_cidr', SCAN_CIDR)} "
        f"interval={scan_interval}s DB={DB_PATH}"
    )