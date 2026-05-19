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
    resp.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=SESSION_TTL_HOURS * 3600,
    )
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
    resp.delete_cookie(SESSION_COOKIE)
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
