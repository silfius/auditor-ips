"""
routers/services.py — Auditor IPs
CRUD de servicios monitorizados, checks TCP/HTTP, info avanzada y scheduler.
"""

import json as _json
import ssl as _ssl
import threading
import urllib.request as _urlreq
from datetime import timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from config import cfg
from database import db
from utils import utc_now, utc_now_iso

router = APIRouter()

_scheduler_ref: Any = None
SERVICE_CHECK_LOCK = threading.Lock()


def _cfg_timeout_seconds(key: str, fallback: float, min_value: float, max_value: float) -> float:
    try:
        raw = cfg(key, str(fallback))
        value = float(raw)
    except Exception:
        value = fallback
    return max(min_value, min(max_value, value))


def _service_check_timeout() -> float:
    return _cfg_timeout_seconds("service_check_timeout_seconds", 8.0, 1.0, 60.0)


def _service_info_timeout() -> float:
    return _cfg_timeout_seconds("service_info_timeout_seconds", 6.0, 1.0, 60.0)


def set_scheduler(sched: Any) -> None:
    global _scheduler_ref
    _scheduler_ref = sched


def _get_scheduler():
    return _scheduler_ref


# ══════════════════════════════════════════════════════════════
#  Helpers de comprobación TCP / HTTP
# ══════════════════════════════════════════════════════════════

def tcp_check(host: str, port: int, timeout: Optional[float] = None):
    import socket as _socket, time
    timeout = _service_check_timeout() if timeout is None else timeout
    t0 = time.monotonic()
    try:
        s = _socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True, round((time.monotonic() - t0) * 1000, 1), None
    except _socket.timeout:
        return False, None, "timeout"
    except Exception as e:
        return False, None, str(e)[:120]


def http_check(url: str, timeout: Optional[float] = None):
    import time
    timeout = _service_check_timeout() if timeout is None else timeout
    t0 = time.monotonic()
    try:
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        req = _urlreq.Request(url, headers={"User-Agent": "AuditorIPs/1.0"})
        with _urlreq.urlopen(req, timeout=timeout, context=ctx) as resp:
            ms   = round((time.monotonic() - t0) * 1000, 1)
            body = resp.read(4096).decode("utf-8", errors="replace")
            return True, ms, resp.status, body, None
    except Exception as e:
        return False, round((time.monotonic() - t0) * 1000, 1), None, None, str(e)[:120]


def fetch_service_info(svc: dict) -> dict:
    """Info avanzada según service_type."""
    info_timeout = _service_info_timeout()
    stype = (svc.get("service_type") or "generic").lower()
    url   = (svc.get("service_url") or "").rstrip("/")
    info: dict = {}
    try:
        if stype == "immich":
            ok, ms, code, body, err = http_check(f"{url}/api/server-info", timeout=info_timeout)
            if ok and body:
                d = _json.loads(body)
                info = {"version": d.get("version"), "build": d.get("sourceRef")}
            ok2, _, _, body2, _ = http_check(f"{url}/api/server-info/statistics", timeout=info_timeout)
            if ok2 and body2:
                d2 = _json.loads(body2)
                info["photos"]   = d2.get("photos")
                info["videos"]   = d2.get("videos")
                info["usage_gb"] = round((d2.get("usage") or 0) / 1073741824, 1)

        elif stype in ("plex", "jellyfin"):
            ok, ms, code, body, err = http_check(f"{url}/", timeout=info_timeout)
            if ok and body and stype == "jellyfin":
                ok2, _, _, body2, _ = http_check(f"{url}/System/Info/Public", timeout=info_timeout)
                if ok2 and body2:
                    d = _json.loads(body2)
                    info = {"version": d.get("Version"), "server_name": d.get("ServerName")}

        elif stype == "qbittorrent":
            ok, ms, code, body, err = http_check(f"{url}/api/v2/app/version", timeout=info_timeout)
            if ok and body:
                info["version"] = body.strip()
            ok2, _, _, body2, _ = http_check(f"{url}/api/v2/transfer/info", timeout=info_timeout)
            if ok2 and body2:
                d = _json.loads(body2)
                info["dl_kbs"] = round(d.get("dl_info_speed", 0) / 1024, 1)
                info["up_kbs"] = round(d.get("up_info_speed", 0) / 1024, 1)

        elif stype == "pihole":
            ok, ms, code, body, err = http_check(f"{url}/api/summary", timeout=info_timeout)
            if ok and body:
                d = _json.loads(body)
                info = {"status": d.get("status"), "blocked_today": d.get("ads_blocked_today"),
                        "queries_today": d.get("dns_queries_today"),
                        "block_pct": d.get("ads_percentage_today")}
            else:
                ok2, _, _, body2, _ = http_check(f"{url}/admin/api.php?summary", timeout=info_timeout)
                if ok2 and body2:
                    d2 = _json.loads(body2)
                    info = {"status": d2.get("status"),
                            "blocked_today": d2.get("ads_blocked_today"),
                            "queries_today": d2.get("dns_queries_today"),
                            "block_pct": round(float(d2.get("ads_percentage_today") or 0), 1)}

        elif stype == "omnitools":
            ok, ms, code, body, err = http_check(f"{url}/", timeout=info_timeout)
            info = {"reachable": ok, "http_code": code}

    except Exception as e:
        info["info_error"] = str(e)[:80]
    return info


# ══════════════════════════════════════════════════════════════
#  run_service_check
# ══════════════════════════════════════════════════════════════

def run_service_check(service_id: int) -> None:
    """Ejecuta un check de un servicio y persiste el resultado."""
    with SERVICE_CHECK_LOCK:
        with db() as conn:
            svc = conn.execute("SELECT * FROM services WHERE id=?", (service_id,)).fetchone()
        if not svc:
            return

        svc      = dict(svc)
        host     = svc["host"]
        port     = svc["port"]
        protocol = svc["protocol"] or "tcp"
        now      = utc_now_iso()

        if protocol in ("http", "https"):
            url = svc.get("service_url") or f"{protocol}://{host}:{port}"
            ok, ms, code, body, err = http_check(url)
            status = "up" if ok else "down"
        else:
            ok, ms, err = tcp_check(host, port)
            status = "up" if ok else ("timeout" if err == "timeout" else "down")

        info_dict: dict = {}
        if ok and svc.get("service_type") and svc["service_type"] != "generic":
            info_dict = fetch_service_info(svc)
        info_json = _json.dumps(info_dict) if info_dict else None

        with db() as conn:
            conn.execute("""
                INSERT INTO service_checks (service_id, checked_at, status, latency_ms, info, error)
                VALUES (?,?,?,?,?,?)
            """, (service_id, now, status, ms, info_json, err))
            cutoff = (utc_now() - timedelta(days=120)).isoformat()
            conn.execute("DELETE FROM service_checks WHERE checked_at < ? AND service_id=?",
                         (cutoff, service_id))

            prev_row    = conn.execute(
                "SELECT status FROM service_last_status WHERE service_id=?", (service_id,)
            ).fetchone()
            prev_status = prev_row["status"] if prev_row else None

            if prev_status is not None and prev_status != status:
                emoji = "🟢" if status == "up" else ("🟡" if status == "timeout" else "🔴")
                msg = (f"{emoji} **Servicio {status.upper()}**: {svc['name']} "
                       f"(`{svc['host']}:{svc['port']}`)")
                if status == "up" and ms is not None:
                    msg += f" · {ms}ms"
                if err:
                    msg += f" · {err[:80]}"
                if cfg("notify_service_down", "1") == "1":
                    from routers.scans import discord_notify
                    threading.Thread(
                        target=discord_notify,
                        args=(msg,),
                        kwargs={"channel": "alerts"},
                        daemon=True,
                    ).start()
                if cfg("push_service_down", "1") == "1" and status in ("down", "timeout"):
                    from routers.scans import send_push_notification
                    threading.Thread(
                        target=send_push_notification,
                        args=(f"Servicio {status.upper()}: {svc['name']}",
                              f"{svc['host']}:{svc['port']}" + (f" — {err[:60]}" if err else "")),
                        daemon=True,
                    ).start()
                # Email
                if cfg("notify_email", "0") == "1" and cfg("email_service_down", "1") == "1":
                    try:
                        from routers.config_api import send_email
                        threading.Thread(
                            target=send_email,
                            args=(f"⚠️ Servicio {status.upper()} — Auditor IPs", msg),
                            daemon=True,
                        ).start()
                    except Exception:
                        pass

            conn.execute("""
                INSERT INTO service_last_status (service_id, status, notified_at)
                VALUES (?,?,?)
                ON CONFLICT(service_id) DO UPDATE
                    SET status=excluded.status, notified_at=excluded.notified_at
            """, (service_id, status, now))


def schedule_services() -> None:
    """Registra un job por servicio habilitado en el scheduler."""
    sched = _get_scheduler()
    if sched is None:
        return
    with db() as conn:
        svcs = conn.execute("SELECT id, check_interval FROM services WHERE enabled=1").fetchall()
    for svc in svcs:
        job_id = f"svc_{svc['id']}"
        try:
            sched.remove_job(job_id)
        except Exception:
            pass
        sched.add_job(
            lambda sid=svc["id"]: run_service_check(sid),
            "interval",
            seconds=max(30, svc["check_interval"]),
            id=job_id,
            replace_existing=True,
        )


# ══════════════════════════════════════════════════════════════
#  API endpoints
# ══════════════════════════════════════════════════════════════

@router.get("/api/services")
def api_services_list():
    with db() as conn:
        rows = conn.execute("""
            SELECT s.*,
                   sc.status AS last_status, sc.latency_ms AS last_latency,
                   sc.checked_at AS last_checked, sc.info AS last_info, sc.error AS last_error,
                   ROUND((
                       SELECT AVG(CASE WHEN status = 'up' THEN 100.0 ELSE 0.0 END)
                       FROM service_checks
                       WHERE service_id = s.id
                   ), 1) AS uptime_pct
            FROM services s
            LEFT JOIN service_checks sc ON sc.id = (
                SELECT id FROM service_checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1
            )
            ORDER BY s.name
        """).fetchall()
    return {"ok": True, "services": [dict(r) for r in rows]}


@router.get("/api/services/{svc_id}/history")
def api_service_history(svc_id: int, days: int = 1, limit: int = 90):
    days = max(1, min(int(days or 1), 120))
    limit = max(1, min(int(limit or 90), 20000))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()
    with db() as conn:
        rows = conn.execute("""
            SELECT checked_at, status, latency_ms, info, error
            FROM service_checks
            WHERE service_id=? AND checked_at >= ?
            ORDER BY checked_at DESC LIMIT ?
        """, (svc_id, cutoff, limit)).fetchall()
    return {"ok": True, "history": [dict(r) for r in rows]}


@router.post("/api/services")
def api_service_create(payload: Dict[str, Any] = Body(...)):
    name           = (payload.get("name") or "").strip()
    host           = (payload.get("host") or "").strip()
    port           = int(payload.get("port") or 80)
    protocol       = (payload.get("protocol") or "tcp").strip()
    check_interval = int(payload.get("check_interval") or 60)
    service_type   = (payload.get("service_type") or "generic").strip()
    service_url    = (payload.get("service_url") or "").strip() or None
    access_url     = (payload.get("access_url") or "").strip() or None
    notes          = (payload.get("notes") or "").strip() or None

    if not name or not host:
        return JSONResponse({"ok": False, "error": "name y host son obligatorios"}, status_code=400)

    with db() as conn:
        cur = conn.execute("""
            INSERT INTO services
                (name,host,port,protocol,check_interval,enabled,service_type,service_url,access_url,notes,created_at)
            VALUES (?,?,?,?,?,1,?,?,?,?,?)
        """, (name, host, port, protocol, check_interval, service_type, service_url, access_url, notes, utc_now_iso()))
        new_id = cur.lastrowid

    threading.Thread(target=run_service_check, args=(new_id,), daemon=True).start()
    sched = _get_scheduler()
    if sched:
        sched.add_job(
            lambda sid=new_id: run_service_check(sid),
            "interval", seconds=max(30, check_interval),
            id=f"svc_{new_id}", replace_existing=True,
        )
    return {"ok": True, "id": new_id}


@router.put("/api/services/{svc_id}")
def api_service_update(svc_id: int, payload: Dict[str, Any] = Body(...)):
    name           = (payload.get("name") or "").strip()
    host           = (payload.get("host") or "").strip()
    port           = int(payload.get("port") or 80)
    protocol       = (payload.get("protocol") or "tcp").strip()
    check_interval = int(payload.get("check_interval") or 60)
    service_type   = (payload.get("service_type") or "generic").strip()
    service_url    = (payload.get("service_url") or "").strip() or None
    access_url     = (payload.get("access_url") or "").strip() or None
    notes          = (payload.get("notes") or "").strip() or None
    enabled        = 1 if payload.get("enabled", True) else 0

    with db() as conn:
        row = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Servicio no encontrado"}, status_code=404)
        conn.execute("""
            UPDATE services
            SET name=?,host=?,port=?,protocol=?,check_interval=?,
                service_type=?,service_url=?,access_url=?,notes=?,enabled=?
            WHERE id=?
        """, (name, host, port, protocol, check_interval,
              service_type, service_url, access_url, notes, enabled, svc_id))

    sched = _get_scheduler()
    if sched:
        try:
            sched.remove_job(f"svc_{svc_id}")
        except Exception:
            pass
        if enabled:
            sched.add_job(
                lambda sid=svc_id: run_service_check(sid),
                "interval", seconds=max(30, check_interval),
                id=f"svc_{svc_id}", replace_existing=True,
            )
    return {"ok": True}


@router.delete("/api/services/{svc_id}")
def api_service_delete(svc_id: int):
    with db() as conn:
        row = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Servicio no encontrado"}, status_code=404)
        conn.execute("DELETE FROM service_checks WHERE service_id=?", (svc_id,))
        conn.execute("DELETE FROM services WHERE id=?", (svc_id,))
    sched = _get_scheduler()
    if sched:
        try:
            sched.remove_job(f"svc_{svc_id}")
        except Exception:
            pass
    return {"ok": True}


@router.post("/api/services/{svc_id}/check")
def api_service_check_now(svc_id: int):
    with db() as conn:
        row = conn.execute("SELECT id FROM services WHERE id=?", (svc_id,)).fetchone()
    if not row:
        return JSONResponse({"ok": False, "error": "Servicio no encontrado"}, status_code=404)
    threading.Thread(target=run_service_check, args=(svc_id,), daemon=True).start()
    return {"ok": True, "message": "Check lanzado"}


@router.post("/api/services/{svc_id}/toggle")
def api_service_toggle(svc_id: int):
    with db() as conn:
        row = conn.execute("SELECT id, enabled, check_interval FROM services WHERE id=?", (svc_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Servicio no encontrado"}, status_code=404)
        new_state = 0 if row["enabled"] else 1
        conn.execute("UPDATE services SET enabled=? WHERE id=?", (new_state, svc_id))

    sched = _get_scheduler()
    if sched:
        if new_state:
            sched.add_job(
                lambda sid=svc_id: run_service_check(sid),
                "interval", seconds=max(30, row["check_interval"]),
                id=f"svc_{svc_id}", replace_existing=True,
            )
        else:
            try:
                sched.remove_job(f"svc_{svc_id}")
            except Exception:
                pass
    return {"ok": True, "enabled": bool(new_state)}
