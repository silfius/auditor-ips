# ═══════════════════════════════════════════════════════════
#  auth_middleware.py  —  Auditor IPs  — Sesión 5+
#  Multi-usuario admin + Sesiones cookie + Audit Log semántico
# ═══════════════════════════════════════════════════════════
import os, sqlite3, secrets, hashlib, json
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import Request

SESSION_COOKIE    = "auditor_session"
SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "8"))
_AUDIT_SKIP_IPS: set = set(os.getenv("AUDIT_SKIP_IPS", "").split(",")) - {""}


# ── PBKDF2 ─────────────────────────────────────────────────
def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    if salt is None:
        salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, _ = stored.split("$", 1)
        return secrets.compare_digest(stored, hash_password(password, bytes.fromhex(salt_hex)))
    except Exception:
        return False


# ── DB ──────────────────────────────────────────────────────
def _conn(db_path: str) -> sqlite3.Connection:
    c = sqlite3.connect(db_path, check_same_thread=False, timeout=15)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=10000")
    c.row_factory = sqlite3.Row
    return c


def init_auth_tables(db_path: str) -> None:
    with _conn(db_path) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS auth_users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            last_login    TEXT
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS auth_sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            username   TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            ip         TEXT NOT NULL,
            user_agent TEXT
        )""")
        c.execute("""CREATE TABLE IF NOT EXISTS audit_log (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            at       TEXT NOT NULL,
            ip       TEXT NOT NULL,
            username TEXT,
            session  TEXT,
            action   TEXT NOT NULL,
            detail   TEXT,
            authed   INTEGER NOT NULL DEFAULT 0
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_ip ON audit_log(ip)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_sess_exp ON auth_sessions(expires_at)")


# ── Users ───────────────────────────────────────────────────
def auth_enabled(db_path: str) -> bool:
    try:
        with _conn(db_path) as c:
            return c.execute("SELECT COUNT(*) FROM auth_users").fetchone()[0] > 0
    except Exception:
        return False


def get_user_by_name(db_path: str, username: str) -> Optional[sqlite3.Row]:
    with _conn(db_path) as c:
        return c.execute("SELECT * FROM auth_users WHERE username=?", (username,)).fetchone()


def list_users(db_path: str) -> list:
    with _conn(db_path) as c:
        rows = c.execute(
            "SELECT id, username, created_at, last_login FROM auth_users ORDER BY username"
        ).fetchall()
    return [dict(r) for r in rows]


def create_user(db_path: str, username: str, password: str) -> dict:
    username = (username or "").strip().lower()
    if len(username) < 2:
        return {"ok": False, "error": "El nombre debe tener al menos 2 caracteres"}
    if not password or len(password) < 8:
        return {"ok": False, "error": "La contraseña debe tener al menos 8 caracteres"}
    try:
        with _conn(db_path) as c:
            c.execute(
                "INSERT INTO auth_users (username, password_hash, created_at) VALUES (?,?,?)",
                (username, hash_password(password), datetime.now(timezone.utc).isoformat())
            )
        return {"ok": True}
    except sqlite3.IntegrityError:
        return {"ok": False, "error": f"El usuario '{username}' ya existe"}


def change_password(db_path: str, username: str, current_pw: str, new_pw: str) -> dict:
    user = get_user_by_name(db_path, username)
    if not user:
        return {"ok": False, "error": "Usuario no encontrado"}
    if not verify_password(current_pw, user["password_hash"]):
        return {"ok": False, "error": "Contraseña actual incorrecta"}
    if not new_pw or len(new_pw) < 8:
        return {"ok": False, "error": "La nueva contraseña debe tener al menos 8 caracteres"}
    with _conn(db_path) as c:
        c.execute("UPDATE auth_users SET password_hash=? WHERE username=?",
                  (hash_password(new_pw), username))
    return {"ok": True}


def delete_user(db_path: str, user_id: int) -> dict:
    with _conn(db_path) as c:
        if c.execute("SELECT COUNT(*) FROM auth_users").fetchone()[0] <= 1:
            return {"ok": False, "error": "No se puede eliminar el único usuario admin"}
        c.execute("DELETE FROM auth_users WHERE id=?", (user_id,))
        c.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))
    return {"ok": True}


# ── Sessions ────────────────────────────────────────────────
def create_session(db_path: str, user_id: int, username: str, ip: str, ua: str) -> str:
    token = secrets.token_urlsafe(32)
    now   = datetime.now(timezone.utc)
    exp   = now + timedelta(hours=SESSION_TTL_HOURS)
    with _conn(db_path) as c:
        c.execute("""INSERT INTO auth_sessions
            (token,user_id,username,created_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?)""",
            (token, user_id, username, now.isoformat(), exp.isoformat(), ip, ua[:200]))
        c.execute("UPDATE auth_users SET last_login=? WHERE id=?", (now.isoformat(), user_id))
    return token


def validate_session(db_path: str, token: Optional[str]) -> Optional[str]:
    """Devuelve username si la sesión es válida, None si no."""
    if not token:
        return None
    try:
        now = datetime.now(timezone.utc).isoformat()
        with _conn(db_path) as c:
            row = c.execute(
                "SELECT username FROM auth_sessions WHERE token=? AND expires_at>?", (token, now)
            ).fetchone()
        return row["username"] if row else None
    except Exception:
        return None


def destroy_session(db_path: str, token: str) -> None:
    with _conn(db_path) as c:
        c.execute("DELETE FROM auth_sessions WHERE token=?", (token,))


def purge_expired_sessions(db_path: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _conn(db_path) as c:
        c.execute("DELETE FROM auth_sessions WHERE expires_at<?", (now,))


def purge_expired_sessions_conn(conn: sqlite3.Connection) -> None:
    """Versión que reutiliza una conexión existente (evita deadlock con _db_write_lock)."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("DELETE FROM auth_sessions WHERE expires_at<?", (now,))


def list_active_sessions(db_path: str) -> list:
    now = datetime.now(timezone.utc).isoformat()
    with _conn(db_path) as c:
        rows = c.execute("""SELECT token,username,created_at,expires_at,ip,user_agent
            FROM auth_sessions WHERE expires_at>? ORDER BY created_at DESC""", (now,)).fetchall()
    return [dict(r) for r in rows]


# ── Audit Log ───────────────────────────────────────────────
_ACTION_MAP: list = [
    ("/api/wol/",        None,     "Wake-on-LAN enviado"),
    ("/wol",             None,     "Wake-on-LAN enviado"),
    ("/scan",            "POST",   "Escaneo de red lanzado manualmente"),
    ("/api/hosts/",      "DELETE", "Host eliminado"),
    ("/api/hosts/",      "PUT",    "Host editado"),
    ("/api/hosts/",      "POST",   "Acción sobre host"),
    ("/api/hosts/",      "GET",    "Consulta de host"),
    ("/api/alerts",      "POST",   "Alerta creada"),
    ("/api/alerts/",     "PUT",    "Alerta editada"),
    ("/api/alerts/",     "DELETE", "Alerta eliminada"),
    ("/api/alerts/",     "POST",   "Acción sobre alerta"),
    ("/api/services",    "POST",   "Servicio creado"),
    ("/api/services/",   "PUT",    "Servicio editado"),
    ("/api/services/",   "DELETE", "Servicio eliminado"),
    ("/api/router/test", "POST",   "Conexión SSH al router probada"),
    ("/api/router/scan", "POST",   "Escaneo SSH del router lanzado"),
    ("/api/backup/run",  "POST",   "Backup de BD lanzado manualmente"),
    ("/api/db/restore",  "POST",   "Base de datos restaurada desde fichero"),
    ("/api/db/reset",    "POST",   "Base de datos reseteada"),
    ("/api/db/backup",   "GET",    "Backup de BD descargado"),
    ("/api/quality/check-now", "POST",   "Check de calidad lanzado manualmente"),
    ("/api/quality/targets",   "POST",   "Target de calidad creado"),
    ("/api/quality/targets/",  "DELETE", "Target de calidad eliminado"),
    ("/export.xlsx",     "GET",    "Exportación Excel descargada"),
    ("/export.csv",      "GET",    "Exportación CSV descargada"),
    ("/api/auth/login",  "POST",   "Inicio de sesión"),
    ("/api/auth/logout", "POST",   "Cierre de sesión"),
    ("/api/auth/",       "POST",   "Acción de autenticación"),
    ("/api/auth/audit",  "GET",    "Audit log consultado"),
]

_SKIP_PATHS = {
    "/manifest.json", "/sw.js", "/api/status", "/login",
    "/api/push/", "/api/oui/", "/tls-info", "/api/tls/", "/static/",
    # Los endpoints de /api/auth/* ya registran sus eventos relevantes desde
    # routers/auth.py. Si el middleware genérico también los audita, el log se
    # llena de entradas duplicadas o demasiado genéricas.
    "/api/auth/",
}

def should_audit(path: str) -> bool:
    return not any(path.startswith(s) for s in _SKIP_PATHS)


def semantic_action(method: str, path: str) -> Optional[str]:
    for pat, meth, desc in _ACTION_MAP:
        if (meth is None or meth == method) and (path == pat or path.startswith(pat)):
            return desc
    return None


def log_action(db_path: str, ip: str, action: str, authed: bool = False,
               username: Optional[str] = None, session_token: Optional[str] = None,
               detail: Optional[dict] = None) -> None:
    if ip in _AUDIT_SKIP_IPS:
        return
    try:
        with _conn(db_path) as c:
            c.execute("""INSERT INTO audit_log (at,ip,username,session,action,detail,authed)
                VALUES(?,?,?,?,?,?,?)""", (
                datetime.now(timezone.utc).isoformat(), ip, username,
                (session_token or "")[:8] or None, action,
                json.dumps(detail, ensure_ascii=False) if detail else None,
                1 if authed else 0
            ))
    except Exception:
        pass


def get_client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"
