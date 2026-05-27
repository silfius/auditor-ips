"""
routers/auth.py — Auditor IPs
Login page, auth endpoints, gestión de usuarios y sesiones, audit log.

Objetivo de esta versión:
- corregir el doble cómputo del rate limiter de login
- mantener la semántica actual de la UI y de las respuestas JSON
- no introducir cambios colaterales en usuarios, sesiones ni audit log
"""

import json
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

import auth_middleware as _am
from auth_middleware import (
    auth_enabled,
    get_user_by_name,
    list_users,
    create_user,
    change_password,
    delete_user,
    create_session,
    validate_session,
    destroy_session,
    list_active_sessions,
    log_action,
    get_client_ip,
    SESSION_COOKIE,
    SESSION_TTL_HOURS,
    set_session_cookie,
    delete_session_cookie,
)
from config import cfg, DB_PATH, login_check_and_record, login_retry_after
from database import db
from utils import get_app_tz

router = APIRouter()
templates = Jinja2Templates(directory="templates")


def _auth_required() -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": "Autenticación requerida", "auth_required": True},
        status_code=401,
    )


def _current_username(request: Request) -> str | None:
    return validate_session(DB_PATH, request.cookies.get(SESSION_COOKIE))


# ══════════════════════════════════════════════════════════════
#  Login page
# ══════════════════════════════════════════════════════════════


@router.post("/api/auth/initial-setup/confirm")
async def api_initial_setup_confirm(request: Request):
    """Aplica asistente inicial en una sola transacción: admin + settings + sesión."""
    import json
    import os
    import secrets
    import sqlite3
    from datetime import datetime, timezone, timedelta
    from fastapi.responses import JSONResponse
    from auth_middleware import hash_password
    from config import cfg

    def as_bool(value, default=False):
        raw = str(value if value is not None else "").strip().lower()
        if raw in {"1", "true", "yes", "on", "si", "sí"}:
            return True
        if raw in {"0", "false", "no", "off"}:
            return False
        return default

    def as_int(value, default, min_value, max_value):
        try:
            parsed = int(str(value).strip())
        except Exception:
            parsed = default
        return max(min_value, min(max_value, parsed))

    def normalize_modules(value):
        allowed = {
            "services", "automation", "agents", "syncthing",
            "quality", "notifications", "ai", "exports",
        }
        incoming = value if isinstance(value, dict) else {}
        return json.dumps({k: as_bool(incoming.get(k), True) for k in sorted(allowed)}, sort_keys=True)

    conn_check = sqlite3.connect(DB_PATH)
    try:
        exists = conn_check.execute("SELECT COUNT(*) FROM auth_users").fetchone()[0]
    finally:
        conn_check.close()

    if exists:
        return JSONResponse(
            {"ok": False, "error": "La configuración inicial ya no está disponible porque ya existe un admin."},
            status_code=409,
        )

    payload = await request.json()

    username = str(payload.get("username") or "").strip().lower()
    password = str(payload.get("password") or "")
    password2 = str(payload.get("password2") or "")

    if len(username) < 2:
        return JSONResponse({"ok": False, "error": "El usuario debe tener al menos 2 caracteres."}, status_code=400)
    if len(password) < 8:
        return JSONResponse({"ok": False, "error": "La contraseña debe tener al menos 8 caracteres."}, status_code=400)
    if password != password2:
        return JSONResponse({"ok": False, "error": "Las contraseñas no coinciden."}, status_code=400)

    scan_cidr = str(payload.get("scan_cidr") or cfg("scan_cidr", "192.168.1.0/24")).strip()
    if not scan_cidr:
        return JSONResponse({"ok": False, "error": "La red principal es obligatoria."}, status_code=400)

    scan_interval = as_int(payload.get("scan_interval"), 900, 30, 86400)
    retention_days = as_int(payload.get("retention_days"), 14, 1, 365)

    ui_lang = str(payload.get("ui_lang") or "es").strip().lower()
    if ui_lang not in {"es", "en", "ca"}:
        ui_lang = "es"

    app_tz = str(payload.get("app_tz") or "Europe/Madrid").strip() or "Europe/Madrid"

    now = datetime.now(timezone.utc).isoformat()
    ttl_hours = int(os.environ.get("SESSION_TTL_HOURS", "8"))
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=ttl_hours)).isoformat()
    ip = get_client_ip(request)
    ua = request.headers.get("user-agent", "")

    settings = {
        "scan_cidr": scan_cidr,
        "scan_interval": str(scan_interval),
        "retention_days": str(retention_days),
        "app_tz": app_tz,
        "ui_lang": ui_lang,
        "enabled_modules": normalize_modules(payload.get("enabled_modules")),
        "notify_new": "1" if as_bool(payload.get("notify_new"), True) else "0",
        "notify_online": "1" if as_bool(payload.get("notify_online"), False) else "0",
        "notify_offline": "1" if as_bool(payload.get("notify_offline"), False) else "0",
        "notify_mac_change": "1" if as_bool(payload.get("notify_mac_change"), False) else "0",
        "notify_service_down": "1" if as_bool(payload.get("notify_service_down"), True) else "0",
        "notify_syncthing_stalled": "1" if as_bool(payload.get("notify_syncthing_stalled"), False) else "0",
        "notify_quality_degraded": "1" if as_bool(payload.get("notify_quality_degraded"), True) else "0",
        "notify_script_alerts": "1" if as_bool(payload.get("notify_script_alerts"), True) else "0",
        "notify_email": "1" if as_bool(payload.get("notify_email"), False) else "0",
        "initial_setup_wizard_completed": "1",
        "initial_setup_wizard_completed_at": now,
        "initial_setup_wizard_version": "2",
    }

    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            conn.execute("BEGIN IMMEDIATE")

            existing = conn.execute("SELECT COUNT(*) FROM auth_users").fetchone()[0]
            if existing:
                conn.rollback()
                return JSONResponse({"ok": False, "error": "Ya existe un usuario admin. Recarga la página."}, status_code=409)

            conn.execute(
                "INSERT INTO auth_users (username, password_hash, created_at) VALUES (?,?,?)",
                (username, hash_password(password), now),
            )
            user_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

            for key, value in settings.items():
                conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, value))

            conn.execute(
                """INSERT INTO auth_sessions
                   (token,user_id,username,created_at,expires_at,ip,user_agent)
                   VALUES(?,?,?,?,?,?,?)""",
                (_am.session_storage_key(token), user_id, username, now, expires_at, ip, ua),
            )
            conn.execute("UPDATE auth_users SET last_login=? WHERE id=?", (now, user_id))

            try:
                conn.execute(
                    """INSERT INTO audit_log (at,ip,username,session,action,detail,authed)
                       VALUES(?,?,?,?,?,?,?)""",
                    (
                        now, ip, username, token[:10],
                        "Asistente inicial confirmado",
                        json.dumps({"updated_keys": sorted(settings.keys())}, ensure_ascii=False),
                        1,
                    ),
                )
            except Exception:
                pass

            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"No se pudo confirmar la configuración inicial: {exc}"}, status_code=500)

    response = JSONResponse({"ok": True, "next": "/"})
    set_session_cookie(
        response,
        token,
        max_age=ttl_hours * 3600,
    )
    return response


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, next: str = "/"):
    """Página de login independiente. Redirige al panel si ya hay sesión."""
    token = request.cookies.get(SESSION_COOKIE)
    if validate_session(DB_PATH, token):
        return RedirectResponse(next or "/", status_code=302)
    return templates.TemplateResponse(
        "login.html",
        {
            "request": request,
            "next": next or "/",
            "page_title": cfg("page_title", "Auditor IPs"),
            "theme": cfg("theme", "dark"),
            "no_users": not auth_enabled(DB_PATH),
        },
    )


# ══════════════════════════════════════════════════════════════
#  Auth endpoints
# ══════════════════════════════════════════════════════════════

@router.get("/api/auth/status")
def api_auth_status(request: Request):
    """Estado de autenticación y sesión actual."""
    enabled = auth_enabled(DB_PATH)
    token = request.cookies.get(SESSION_COOKIE)
    username = validate_session(DB_PATH, token) if enabled else None
    sections = [s.strip() for s in cfg("auth_sections", "config,alertas").split(",") if s.strip()]
    return {
        "ok": True,
        "auth_enabled": enabled,
        "is_admin": bool(username) or not enabled,
        "username": username,
        "auth_sections": sections,
    }


@router.post("/api/auth/login")
async def api_auth_login(request: Request):
    """
    Login con usuario y contraseña.

    Corrección importante:
    antes se llamaba a login_check_and_record(ip, success=False) antes de validar
    credenciales, y luego otra vez si el login fallaba. Como config.py registra un
    intento cada vez que recibe success=False, un fallo real contaba doble.
    """
    payload = await request.json()
    username = (payload.get("username") or "").strip().lower()
    password = (payload.get("password") or "").strip()
    ip = get_client_ip(request)
    ua = request.headers.get("user-agent", "")

    # 1) Si ya está bloqueada, rechazamos sin registrar un nuevo fallo.
    retry_after = login_retry_after(ip)
    if retry_after > 0:
        return JSONResponse(
            {
                "ok": False,
                "error": f"Demasiados intentos fallidos. Espera {retry_after}s.",
                "retry_after": retry_after,
            },
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )

    if not auth_enabled(DB_PATH):
        return JSONResponse(
            {"ok": False, "error": "No hay usuarios configurados. Crea el primero."},
            status_code=400,
        )

    user = get_user_by_name(DB_PATH, username)
    if not user or not _am.verify_password(password, user["password_hash"]):
        # 2) Registrar un único fallo real.
        blocked_now = login_check_and_record(ip, success=False)
        retry_after = login_retry_after(ip) if blocked_now else 0

        log_action(
            DB_PATH,
            ip,
            f"Intento de login fallido — usuario: {username}",
            authed=False,
        )

        if blocked_now:
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"Demasiados intentos fallidos. Espera {retry_after}s.",
                    "retry_after": retry_after,
                },
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )

        return JSONResponse(
            {"ok": False, "error": "Usuario o contraseña incorrectos"},
            status_code=401,
        )

    # 3) Login correcto: limpiar historial.
    login_check_and_record(ip, success=True)

    token = create_session(DB_PATH, user["id"], username, ip, ua)
    log_action(
        DB_PATH,
        ip,
        f"Inicio de sesión — {username}",
        authed=True,
        username=username,
        session_token=token,
    )

    resp = JSONResponse({"ok": True, "username": username})
    set_session_cookie(resp, token)
    return resp


@router.post("/api/auth/logout")
def api_auth_logout(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    ip = get_client_ip(request)
    username = validate_session(DB_PATH, token)

    if token:
        destroy_session(DB_PATH, token)
        log_action(
            DB_PATH,
            ip,
            f"Cierre de sesión — {username or 'desconocido'}",
            authed=True,
            username=username,
            session_token=token,
        )

    resp = JSONResponse({"ok": True})
    delete_session_cookie(resp)
    return resp


# ── Gestión de usuarios ──────────────────────────────────────

@router.get("/api/auth/users")
def api_list_users(request: Request):
    if auth_enabled(DB_PATH) and not _current_username(request):
        return _auth_required()
    return {"ok": True, "users": list_users(DB_PATH)}


@router.post("/api/auth/users")
async def api_create_user(request: Request):
    payload = await request.json()
    if not auth_enabled(DB_PATH):
        return JSONResponse(
            {"ok": False, "error": "Usa el asistente inicial para completar la primera configuración."},
            status_code=409,
        )
    username = (payload.get("username") or "").strip().lower()
    password = (payload.get("password") or "").strip()

    if auth_enabled(DB_PATH) and not _current_username(request):
        return _auth_required()

    result = create_user(DB_PATH, username, password)
    if result["ok"]:
        me = _current_username(request)
        log_action(
            DB_PATH,
            get_client_ip(request),
            f"Usuario creado: {username}",
            authed=bool(me),
            username=me,
        )
    return result


@router.delete("/api/auth/users/{user_id}")
def api_delete_user(user_id: int, request: Request):
    me = _current_username(request)
    if not me:
        return _auth_required()

    result = delete_user(DB_PATH, user_id)
    if result["ok"]:
        log_action(
            DB_PATH,
            get_client_ip(request),
            f"Usuario eliminado (id:{user_id})",
            authed=True,
            username=me,
        )
    return result


@router.post("/api/auth/change-password")
async def api_change_password(request: Request):
    payload = await request.json()
    username = _current_username(request)
    if not username:
        return _auth_required()

    result = change_password(
        DB_PATH,
        username,
        (payload.get("current_password") or "").strip(),
        (payload.get("new_password") or "").strip(),
    )
    if result["ok"]:
        log_action(
            DB_PATH,
            get_client_ip(request),
            f"Contraseña cambiada — {username}",
            authed=True,
            username=username,
        )
    return result


# ── Gestión de sesiones ──────────────────────────────────────

@router.get("/api/auth/sessions")
def api_list_sessions(request: Request):
    if not _current_username(request):
        return _auth_required()
    return {"ok": True, "sessions": list_active_sessions(DB_PATH)}


@router.delete("/api/auth/sessions/{token_prefix}")
def api_kill_session(token_prefix: str, request: Request):
    me = _current_username(request)
    if not me:
        return _auth_required()

    with _am._conn(DB_PATH) as c:
        row = c.execute(
            "SELECT token FROM auth_sessions WHERE token LIKE ?",
            (token_prefix + "%",),
        ).fetchone()

    if row:
        destroy_session(DB_PATH, row["token"])
        log_action(
            DB_PATH,
            get_client_ip(request),
            f"Sesión terminada por {me}",
            authed=True,
            username=me,
        )
    return {"ok": True}


# ── Audit log ────────────────────────────────────────────────

@router.get("/api/auth/audit")
def api_audit_log(request: Request, limit: int = 100, offset: int = 0, ip_filter: str = ""):
    if auth_enabled(DB_PATH) and not _current_username(request):
        return _auth_required()

    hidden_actions = {
        "Acceso al panel",
        "Dashboard consultado",
        "Historial de ejecuciones consultado",
        "Configuración consultada",
        "Consulta de host",
        "Audit log consultado",
    }

    where_parts = []
    params = []

    if ip_filter:
        where_parts.append("ip LIKE ?")
        params.append(f"%{ip_filter}%")

    if hidden_actions:
        placeholders = ",".join("?" for _ in hidden_actions)
        where_parts.append(f"action NOT IN ({placeholders})")
        params.extend(sorted(hidden_actions))

    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid"))

    def _fmt(iso: str) -> str:
        try:
            return (
                datetime.fromisoformat(iso.replace("Z", "+00:00"))
                .astimezone(app_tz)
                .strftime("%d/%m/%Y %H:%M:%S")
            )
        except Exception:
            return iso

    with db() as conn:
        rows = conn.execute(
            f"SELECT at,ip,username,session,action,detail,authed "
            f"FROM audit_log {where} ORDER BY at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) c FROM audit_log {where}",
            params,
        ).fetchone()["c"]

        ips = sorted({str(r["ip"] or "").strip() for r in rows if str(r["ip"] or "").strip()})
        host_map = {}
        if ips:
            placeholders = ",".join("?" for _ in ips)
            host_rows = conn.execute(
                f"""
                SELECT ip,
                       COALESCE(manual_name, '') AS manual_name,
                       COALESCE(router_hostname, '') AS router_hostname,
                       COALESCE(nmap_hostname, '') AS nmap_hostname,
                       COALESCE(dns_name, '') AS dns_name,
                       COALESCE(device_type, '') AS device_type
                FROM hosts
                WHERE ip IN ({placeholders})
                """,
                ips,
            ).fetchall()

            device_type_map = {
                "computer": "PC",
                "mobile": "móvil",
                "server": "servidor",
                "printer": "impresora",
                "tv": "TV",
                "router": "router",
                "iot": "IoT",
                "unknown": "",
            }

            for hr in host_rows:
                ip_value = str(hr["ip"] or "").strip()
                origin = ""
                for key in ("manual_name", "router_hostname", "nmap_hostname", "dns_name"):
                    value = str(hr[key] or "").strip()
                    if value:
                        origin = value
                        break

                raw_type = str(hr["device_type"] or "").strip().lower()
                host_map[ip_value] = {
                    "origin": origin,
                    "device_type": device_type_map.get(raw_type, raw_type),
                }

        for ip_value in ips:
            if ip_value in host_map:
                continue
            if ip_value == "127.0.0.1":
                host_map[ip_value] = {"origin": "localhost", "device_type": ""}
            elif ip_value.startswith("10.8."):
                host_map[ip_value] = {"origin": "VPN", "device_type": ""}

    entries = []
    for r in rows:
        detail_obj = None
        if r["detail"]:
            try:
                detail_obj = json.loads(r["detail"])
            except Exception:
                detail_obj = r["detail"]
        host_info = host_map.get(str(r["ip"] or "").strip(), {})
        entries.append(
            {
                "at": _fmt(r["at"]),
                "at_raw": r["at"],
                "ip": r["ip"],
                "ip_origin": host_info.get("origin", ""),
                "ip_device_type": host_info.get("device_type", ""),
                "username": r["username"],
                "session": r["session"],
                "action": r["action"],
                "detail": detail_obj,
                "authed": bool(r["authed"]),
            }
        )

    return {"ok": True, "total": total, "entries": entries}
