"""
routers/router_ssh.py — Auditor IPs
Endpoints de consulta y control del router via SSH:
  GET  /api/router/status
  POST /api/router/test       — diagnóstico SSH detallado
  POST /api/router/test/reset-known-hosts
  POST /api/router/scan       — scan manual
  GET  /api/router/scans      — historial de router_scans
  GET  /api/hosts/{ip}/router-history
"""

import os
import shutil as _shutil
import socket
import stat as _stat
import subprocess
from datetime import timedelta
from typing import Any, Dict

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from config import cfg, save_setting, ROUTER_SSH_HOST, ROUTER_SSH_PORT, ROUTER_SSH_USER, ROUTER_SSH_KEY
from database import db
from utils import utc_now, utc_now_iso

router = APIRouter()


# ══════════════════════════════════════════════════════════════
#  Helpers importados desde scans para evitar duplicación
# ══════════════════════════════════════════════════════════════

def _fetch_router_data():
    from routers.scans import fetch_router_data
    return fetch_router_data()


def _merge_router_data(conn, found_by_ip, router_data, default_type_id):
    from routers.scans import merge_router_data
    return merge_router_data(conn, found_by_ip, router_data, default_type_id)


def _reset_known_hosts() -> bool:
    """Elimina el fichero known_hosts persistente para forzar re-aceptación."""
    path = "/data/ssh_known_hosts"
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def _ensure_router_profiles_supports_ssh_column() -> None:
    """Garantiza columna supports_ssh para perfiles sin soporte SSH."""
    try:
        with db() as conn:
            cols = conn.execute("PRAGMA table_info(router_profiles)").fetchall()
            names = {str((c["name"] if isinstance(c, dict) else c[1]) or "").strip() for c in cols}
            if "supports_ssh" not in names:
                conn.execute("ALTER TABLE router_profiles ADD COLUMN supports_ssh INTEGER NOT NULL DEFAULT 1")
    except Exception:
        pass


def _router_profiles_rows() -> list[dict[str, Any]]:
    """Devuelve perfiles de router desde schema nuevo o, si está vacío, derivado legacy."""
    _ensure_router_profiles_supports_ssh_column()
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT id, name, host, port, user, key_path, router_type, notes, enabled, supports_ssh, created_at, updated_at
                FROM router_profiles
                ORDER BY enabled DESC, id ASC
                """
            ).fetchall()
        if rows:
            return [dict(r) for r in rows]
    except Exception:
        pass

    host = (cfg("router_ssh_host", ROUTER_SSH_HOST) or "").strip()
    port = int(cfg("router_ssh_port", str(ROUTER_SSH_PORT)) or 22)
    user = (cfg("router_ssh_user", ROUTER_SSH_USER) or "").strip()
    key  = (cfg("router_ssh_key", ROUTER_SSH_KEY) or "").strip()
    enabled = 1 if cfg("router_enabled", "0") == "1" else 0
    if not any([host, user, key, enabled]):
        return []

    return [{
        "id": "legacy",
        "name": (cfg("primary_net_label", "") or "Router legacy").strip() or "Router legacy",
        "host": host,
        "port": port,
        "user": user,
        "key_path": key,
        "router_type": "",
        "notes": "Derivado temporalmente de la configuración Router SSH legacy",
        "enabled": enabled,
        "supports_ssh": 1,
        "created_at": "",
        "updated_at": "",
        "origin": "legacy-settings",
    }]


def _legacy_router_config() -> Dict[str, Any]:
    return {
        "enabled": 1 if cfg("router_enabled", "0") == "1" else 0,
        "host": (cfg("router_ssh_host", ROUTER_SSH_HOST) or "").strip(),
        "port": int(cfg("router_ssh_port", str(ROUTER_SSH_PORT)) or 22),
        "user": (cfg("router_ssh_user", ROUTER_SSH_USER) or "").strip(),
        "key_path": (cfg("router_ssh_key", ROUTER_SSH_KEY) or "").strip(),
    }


def _profile_matches_legacy(profile: Dict[str, Any], legacy: Dict[str, Any]) -> bool:
    try:
        if int(profile.get("supports_ssh", 1) or 0) != 1:
            return False
        return (
            (str(profile.get("host") or "").strip() == str(legacy.get("host") or "").strip())
            and int(profile.get("port") or 22) == int(legacy.get("port") or 22)
            and (str(profile.get("user") or "").strip() == str(legacy.get("user") or "").strip())
            and (str(profile.get("key_path") or "").strip() == str(legacy.get("key_path") or "").strip())
        )
    except Exception:
        return False


def _router_profiles_response() -> Dict[str, Any]:
    profiles = _router_profiles_rows()
    source = "schema" if profiles and profiles[0].get("id") != "legacy" else ("legacy" if profiles else "none")
    legacy = _legacy_router_config()
    active_profile_id = None
    enriched = []
    for p in profiles:
        row = dict(p)
        is_active = _profile_matches_legacy(row, legacy)
        row["active_legacy"] = is_active
        if is_active and active_profile_id is None:
            active_profile_id = row.get("id")
        enriched.append(row)
    return {
        "ok": True,
        "source": source,
        "count": len(enriched),
        "active_legacy_profile_id": active_profile_id,
        "legacy_enabled": bool(legacy.get("enabled")),
        "profiles": enriched,
    }


def _normalize_profile_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    name = (payload.get("name") or "").strip()
    host = (payload.get("host") or "").strip()
    user = (payload.get("user") or "").strip()
    key_path = (payload.get("key_path") or payload.get("key") or "").strip()
    router_type = (payload.get("router_type") or "").strip()
    notes = (payload.get("notes") or "").strip()
    enabled = 1 if str(payload.get("enabled", 1)).strip() not in ("0", "false", "False", "") else 0
    supports_ssh = 1 if str(payload.get("supports_ssh", payload.get("ssh_enabled", 1))).strip() not in ("0", "false", "False", "") else 0
    try:
        port = int(payload.get("port") or 22)
    except Exception:
        port = 22
    if not supports_ssh:
        host = ""
        user = ""
        key_path = ""
        port = 22
    return {
        "name": name,
        "host": host,
        "port": port,
        "user": user,
        "key_path": key_path,
        "router_type": router_type,
        "notes": notes,
        "enabled": enabled,
        "supports_ssh": supports_ssh,
    }


def _activate_router_profile_legacy(profile: Dict[str, Any]) -> Dict[str, Any]:
    save_setting("router_enabled", "1")
    save_setting("router_ssh_host", str(profile.get("host") or "").strip())
    save_setting("router_ssh_port", str(int(profile.get("port") or 22)))
    save_setting("router_ssh_user", str(profile.get("user") or "").strip())
    save_setting("router_ssh_key", str(profile.get("key_path") or "").strip())
    return _legacy_router_config()


# ══════════════════════════════════════════════════════════════
#  Endpoints
# ══════════════════════════════════════════════════════════════

@router.get("/api/router/profiles")
def api_router_profiles():
    """Lista perfiles de router y marca cuál coincide con la configuración legacy activa."""
    return _router_profiles_response()


@router.post("/api/router/profiles")
def api_router_profiles_create(payload: Dict[str, Any] = Body(...)):
    _ensure_router_profiles_supports_ssh_column()
    data = _normalize_profile_payload(payload)
    if not data["name"]:
        return JSONResponse({"ok": False, "error": "name requerido"}, status_code=400)
    if data["supports_ssh"] and not data["host"]:
        return JSONResponse({"ok": False, "error": "host requerido"}, status_code=400)
    if data["supports_ssh"] and not data["user"]:
        return JSONResponse({"ok": False, "error": "user requerido"}, status_code=400)
    if data["supports_ssh"] and not data["key_path"]:
        return JSONResponse({"ok": False, "error": "key_path requerido"}, status_code=400)
    now = utc_now_iso()
    try:
        with db() as conn:
            conn.execute(
                """
                INSERT INTO router_profiles
                    (name, host, port, user, key_path, router_type, notes, enabled, supports_ssh, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    data["name"], data["host"], data["port"], data["user"], data["key_path"],
                    data["router_type"], data["notes"], data["enabled"], data["supports_ssh"], now, now,
                ),
            )
            new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"ok": True, "id": new_id}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.put("/api/router/profiles/{profile_id}")
def api_router_profiles_update(profile_id: int, payload: Dict[str, Any] = Body(...)):
    _ensure_router_profiles_supports_ssh_column()
    data = _normalize_profile_payload(payload)
    fields = []
    vals = []
    for key in ("name", "host", "port", "user", "key_path", "router_type", "notes", "enabled", "supports_ssh"):
        if key in data:
            fields.append(f"{key}=?")
            vals.append(data[key])
    fields.append("updated_at=?")
    vals.append(utc_now_iso())
    vals.append(profile_id)
    try:
        with db() as conn:
            exists = conn.execute("SELECT id FROM router_profiles WHERE id=?", (profile_id,)).fetchone()
            if not exists:
                return JSONResponse({"ok": False, "error": "No encontrado"}, status_code=404)
            conn.execute(f"UPDATE router_profiles SET {', '.join(fields)} WHERE id=?", vals)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.delete("/api/router/profiles/{profile_id}")
def api_router_profiles_delete(profile_id: int):
    try:
        with db() as conn:
            cur = conn.execute("DELETE FROM router_profiles WHERE id=?", (profile_id,))
        if cur.rowcount == 0:
            return JSONResponse({"ok": False, "error": "No encontrado"}, status_code=404)
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/router/profiles/{profile_id}/activate-legacy")
def api_router_profiles_activate_legacy(profile_id: int):
    try:
        with db() as conn:
            row = conn.execute(
                """
                SELECT id, name, host, port, user, key_path, router_type, notes, enabled, supports_ssh, created_at, updated_at
                FROM router_profiles WHERE id=?
                """,
                (profile_id,),
            ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "No encontrado"}, status_code=404)
        profile = dict(row)
        if int(profile.get("supports_ssh", 1) or 0) != 1:
            return JSONResponse({"ok": False, "error": "El perfil no soporta SSH"}, status_code=400)
        legacy = _activate_router_profile_legacy(profile)
        return {"ok": True, "profile_id": profile_id, "legacy_config": legacy}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/router/status")
def api_router_status():
    """Estado general del módulo router SSH."""
    with db() as conn:
        last = conn.execute(
            "SELECT * FROM router_scans ORDER BY scanned_at DESC LIMIT 1"
        ).fetchone()
        total_silent = conn.execute(
            "SELECT COUNT(*) c FROM hosts WHERE router_seen=1 AND status='online_silent'"
        ).fetchone()["c"]
    return {
        "ok":           True,
        "enabled":      cfg("router_enabled", "0") == "1",
        "last_scan":    dict(last) if last else None,
        "silent_hosts": total_silent,
        "config": {
            "host": cfg("router_ssh_host", ""),
            "port": cfg("router_ssh_port", "22"),
            "user": cfg("router_ssh_user", ""),
            "key":  cfg("router_ssh_key",  ""),
        },
    }


@router.post("/api/router/test")
def api_router_test():
    """
    Diagnóstico completo de la conexión SSH al router.
    Devuelve lista de pasos con ✅/❌/💡 y verbose SSH si falla.
    """
    host = cfg("router_ssh_host", ROUTER_SSH_HOST)
    port = int(cfg("router_ssh_port", str(ROUTER_SSH_PORT)) or 22)
    user = cfg("router_ssh_user", ROUTER_SSH_USER)
    key  = cfg("router_ssh_key",  ROUTER_SSH_KEY)

    diag = []

    # ── 1. Localizar fichero de clave ──────────────────────────
    key_path = key
    if key and not os.path.exists(key_path):
        alt = os.path.join("/data", os.path.basename(key_path))
        if os.path.exists(alt):
            key_path = alt
            diag.append(f"ℹ Key encontrada en fallback: {key_path}")
        else:
            return {
                "ok": False,
                "error": f"Key file no encontrado: {key_path}",
                "diagnostics": [
                    f"❌ Ruta configurada: {key_path}",
                    f"❌ Fallback /data/{os.path.basename(key_path or '')} tampoco existe",
                    "💡 Solución: docker compose down && docker compose up -d --build",
                    "💡 Verifica: docker exec auditor_ips ls -la /app/router_key",
                ],
                "hosts": [],
            }
    elif key and os.path.exists(key_path):
        diag.append(f"✅ Key encontrada: {key_path}")

    # ── 2. Permisos de la clave ────────────────────────────────
    if key_path and os.path.exists(key_path):
        km = _stat.S_IMODE(os.stat(key_path).st_mode)
        if km & 0o077:
            diag.append(f"⚠ Permisos incorrectos: {oct(km)} (necesita 600). Se usará copia temporal.")
        else:
            diag.append(f"✅ Permisos correctos: {oct(km)}")

        # ── 3. Tipo de clave ───────────────────────────────────
        try:
            with open(key_path, "rb") as f:
                head = f.read(50).decode("utf-8", errors="replace")
            if   "OPENSSH PRIVATE KEY" in head: diag.append("✅ Formato: OpenSSH (moderno)")
            elif "RSA PRIVATE KEY"     in head: diag.append("✅ Formato: RSA PEM (clásico)")
            elif "EC PRIVATE KEY"      in head: diag.append("✅ Formato: EC PEM")
            elif "BEGIN"               in head: diag.append(f"ℹ Formato PEM: {head[:40].strip()}")
            else:                               diag.append(f"⚠ Formato desconocido: {head[:30]}")
        except Exception as ex:
            diag.append(f"⚠ No se pudo leer la clave: {ex}")

    # ── 4. Test TCP ────────────────────────────────────────────
    try:
        with socket.create_connection((host, port), timeout=5):
            diag.append(f"✅ Puerto TCP {host}:{port} accesible")
    except Exception as ex:
        diag.append(f"❌ Puerto TCP {host}:{port} NO accesible: {ex}")
        return {"ok": False, "error": f"No se puede conectar a {host}:{port} — {ex}",
                "diagnostics": diag, "hosts": []}

    # ── 5. SSH real ────────────────────────────────────────────
    try:
        data, err = _fetch_router_data()

        if err:
            # ssh -v para diagnóstico extra
            verbose_diag = []
            try:
                effective_key = key_path
                km2 = _stat.S_IMODE(os.stat(key_path).st_mode)
                if km2 & 0o077:
                    tmp_k = f"/tmp/router_key_diag_{os.getpid()}"
                    _shutil.copy2(key_path, tmp_k)
                    os.chmod(tmp_k, 0o600)
                    effective_key = tmp_k

                r = subprocess.run([
                    "ssh", "-v", "-i", effective_key,
                    "-p", str(port),
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "ConnectTimeout=8",
                    "-o", "BatchMode=yes",
                    "-o", "IdentitiesOnly=yes",
                    f"{user}@{host}", "echo ok",
                ], capture_output=True, text=True, timeout=12)

                if effective_key != key_path and os.path.exists(effective_key):
                    os.unlink(effective_key)

                keywords = [
                    "Offering", "Authentications", "identity", "key",
                    "Permission denied", "debug1: Trying", "debug1: Sending",
                    "debug1: Server accepts", "publickey", "Authenticated",
                    "debug1: Next auth",
                ]
                for line in (r.stdout + r.stderr).splitlines():
                    if any(k in line for k in keywords):
                        clean = line.replace("debug1: ", "").replace("Warning: ", "⚠ ")
                        verbose_diag.append(clean)
            except Exception as vex:
                verbose_diag.append(f"(verbose no disponible: {vex})")

            suggestions = []
            el = err.lower()
            if "permission denied" in el:
                suggestions = [
                    "❌ El router rechaza la clave pública.",
                    "💡 La clave pública debe estar en el router en:",
                    "   /etc/dropbear/authorized_keys  o  ~/.ssh/authorized_keys",
                    f"💡 Prueba manual: ssh -i {key_path} -p {port} {user}@{host}",
                ]
            elif "timeout" in el or "connection" in el:
                suggestions = [
                    "❌ No se puede conectar al router.",
                    f"💡 Verifica que SSH está habilitado en el router en el puerto {port}",
                ]
            elif "no such file" in el or "not found" in el:
                suggestions = [
                    "❌ Fichero de clave no encontrado en el contenedor.",
                    "💡 docker exec auditor_ips ls -la /app/router_key",
                    "💡 docker compose down && docker compose up -d --build",
                ]
            elif "host key verification" in el or "known_hosts" in el:
                suggestions = [
                    "❌ El fingerprint del router ha cambiado.",
                    "💡 Usa POST /api/router/test/reset-known-hosts para limpiar el fichero.",
                ]

            return {"ok": False, "error": err,
                    "diagnostics": diag + suggestions,
                    "verbose": verbose_diag[:20], "hosts": []}

        return {
            "ok": True,
            "hosts_found": len(data),
            "diagnostics": diag + [f"✅ Conexión SSH exitosa — {len(data)} hosts encontrados"],
            "hosts": [
                {
                    "ip":              ip,
                    "mac":             d["mac"],
                    "router_hostname": d.get("router_hostname") or "",
                    "ip_assignment":   d.get("ip_assignment") or "",
                    "dhcp_lease_secs": d.get("dhcp_lease_secs"),
                }
                for ip, d in sorted(data.items())
            ],
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "diagnostics": diag, "hosts": []}


@router.post("/api/router/test/reset-known-hosts")
def api_router_reset_known_hosts():
    """
    Elimina el fichero /data/ssh_known_hosts para que la próxima conexión
    acepte el nuevo fingerprint del router (útil tras cambio de router).
    """
    removed = _reset_known_hosts()
    return {
        "ok": True,
        "removed": removed,
        "message": "Fichero known_hosts eliminado. La próxima conexión aceptará el nuevo fingerprint."
                   if removed else "El fichero no existía (ya estaba limpio).",
    }


@router.post("/api/router/scan")
def api_router_manual_scan():
    """Lanza un scan manual del router SSH e importa hosts silenciosos."""
    if cfg("router_enabled", "0") != "1":
        return JSONResponse({"ok": False, "error": "Router SSH no habilitado"}, status_code=400)
    try:
        data, err = _fetch_router_data()
        with db() as conn:
            default_id = conn.execute(
                "SELECT id FROM host_types WHERE name='Por defecto' LIMIT 1"
            ).fetchone()
            default_id = default_id["id"] if default_id else None
            silent_new = _merge_router_data(conn, {}, data, default_id)
            conn.execute(
                "INSERT INTO router_scans (scanned_at, hosts_seen, silent_new, error) VALUES (?,?,?,?)",
                (utc_now_iso(), len(data), silent_new, err or ""),
            )
        return {"ok": True, "hosts_found": len(data), "silent_new": silent_new, "error": err}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/router/scans")
def api_router_scans():
    """Historial de los últimos 50 scans del router."""
    with db() as conn:
        rows = conn.execute("""
            SELECT id, scanned_at, hosts_seen, silent_new, error
            FROM router_scans ORDER BY scanned_at DESC LIMIT 50
        """).fetchall()
    return {"ok": True, "scans": [dict(r) for r in rows]}


@router.get("/api/hosts/{ip}/router-history")
def api_router_history(ip: str):
    """Historial de los últimos 7 días de un host en router_scan_history."""
    cutoff = (utc_now() - timedelta(days=7)).isoformat()
    with db() as conn:
        rows = conn.execute("""
            SELECT scanned_at, router_hostname, ip_assignment, dhcp_lease_secs
            FROM router_scan_history
            WHERE ip=? AND scanned_at > ?
            ORDER BY scanned_at ASC
        """, (ip, cutoff)).fetchall()
    return {"ok": True, "ip": ip, "history": [dict(r) for r in rows]}
