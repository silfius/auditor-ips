"""
routers/quality.py — Auditor IPs
CRUD de quality targets/settings, historial, export CSV y check manual.
La lógica de ping (run_quality_checks, reschedule_quality) vive aquí
para que main.py pueda importarla en startup.
"""

import copy
import csv
import io
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse, Response

from config import cfg
from database import db
from utils import utc_now, utc_now_iso, parse_iso, get_app_tz

router = APIRouter()

# Scheduler se inyecta desde main.py tras la creación del APIRouter
# para evitar imports circulares. Se accede via _get_scheduler().
_scheduler_ref: Any = None

def set_scheduler(sched: Any) -> None:
    global _scheduler_ref
    _scheduler_ref = sched

def _get_scheduler():
    return _scheduler_ref


_quality_job_id = "quality_job"
_quality_running = False
_db_write_lock: threading.Lock = threading.Lock()   # compartido con scans.py via setter


def set_db_write_lock(lock: threading.Lock) -> None:
    global _db_write_lock
    _db_write_lock = lock


_quality_history_cache_lock = threading.Lock()
_quality_history_cache: Dict[int, tuple[float, Dict[str, Any]]] = {}


def _performance_api_cache_seconds() -> float:
    try:
        value = float(cfg("performance_api_cache_seconds", "10") or 10)
    except Exception:
        value = 10.0
    return max(0.0, min(60.0, value))


def _invalidate_quality_history_cache() -> None:
    with _quality_history_cache_lock:
        _quality_history_cache.clear()


def _quality_bucket_start(value: str, bucket_minutes: int) -> str:
    dt = datetime.fromisoformat(str(value))
    minute_floor = dt.minute - (dt.minute % bucket_minutes)
    return dt.replace(minute=minute_floor, second=0, microsecond=0).isoformat()


def _upsert_quality_rollups(
    conn,
    *,
    target_id: int,
    checked_at: str,
    latency_ms: Any,
    packet_loss: Any,
    status: Any,
) -> None:
    try:
        latency_value = float(latency_ms) if latency_ms is not None else 0.0
    except Exception:
        latency_value = 0.0

    latency_count = 1 if latency_ms is not None else 0

    try:
        loss_value = float(packet_loss or 0)
    except Exception:
        loss_value = 0.0

    status_value = str(status or "").lower()
    error_count = 1 if (
        latency_ms is None
        or status_value in ("error", "down", "timeout")
    ) else 0

    for bucket_minutes in (5, 15, 60):
        bucket_start = _quality_bucket_start(checked_at, bucket_minutes)
        conn.execute(
            """
            INSERT INTO quality_rollups (
                target_id,
                bucket_minutes,
                bucket_start,
                sample_count,
                latency_sum,
                latency_count,
                packet_loss_max,
                error_count
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(target_id, bucket_minutes, bucket_start)
            DO UPDATE SET
                sample_count = sample_count + 1,
                latency_sum = latency_sum + excluded.latency_sum,
                latency_count = latency_count + excluded.latency_count,
                packet_loss_max = MAX(
                    packet_loss_max,
                    excluded.packet_loss_max
                ),
                error_count = error_count + excluded.error_count
            """,
            (
                target_id,
                bucket_minutes,
                bucket_start,
                latency_value,
                latency_count,
                loss_value,
                error_count,
            ),
        )


# ══════════════════════════════════════════════════════════════
#  Lógica de ping
# ══════════════════════════════════════════════════════════════

def run_quality_ping(host: str, count: int = 4, interface: str = "") -> Dict[str, Any]:
    """Ping a host y devuelve latencia media y packet loss."""
    try:
        cmd = ["ping", "-c", str(count), "-W", "3"]
        if interface:
            cmd += ["-I", interface]
        cmd.append(host)
        result = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=30,
        )
        output = result.stdout
        m      = re.search(r"rtt min/avg/max/mdev = [\d.]+/([\d.]+)/", output)
        avg_ms = float(m.group(1)) if m else None
        loss_m = re.search(r"(\d+)% packet loss", output)
        loss_pct = int(loss_m.group(1)) if loss_m else 100
        status = "ok" if loss_pct < 100 else "down"
        return {"latency_ms": avg_ms, "packet_loss": loss_pct, "status": status}
    except Exception:
        return {"latency_ms": None, "packet_loss": 100, "status": "error"}


def run_quality_checks() -> None:
    """Ejecuta pings a todos los quality_targets activos y persiste resultados."""
    global _quality_running
    if _quality_running:
        return
    _quality_running = True
    try:
        with db() as conn:
            settings = conn.execute("SELECT * FROM quality_settings WHERE id=1").fetchone()
            if not settings or not settings["enabled"]:
                return
            # Interfaz global como fallback si el target no tiene una propia
            global_interface = (settings["quality_interface"] or "").strip() if "quality_interface" in settings.keys() else ""
            targets = conn.execute(
                "SELECT id, host, name, interface FROM quality_targets WHERE enabled=1"
            ).fetchall()
        if not targets:
            return

        now     = utc_now_iso()
        results = []
        for t in targets:
            # Prioridad: interfaz del target → interfaz global → automático
            iface = (t["interface"] or "").strip() if "interface" in t.keys() else ""
            if not iface:
                iface = global_interface
            r = run_quality_ping(t["host"], interface=iface)
            results.append((t["id"], t["host"], t["name"], r, iface))

        with _db_write_lock:
            with db() as conn:
                for (tid, host, name, r, iface) in results:
                    conn.execute("""
                        INSERT INTO quality_checks (target_id, checked_at, latency_ms, packet_loss, status)
                        VALUES (?, ?, ?, ?, ?)
                    """, (tid, now, r["latency_ms"], r["packet_loss"], r["status"]))
                    _upsert_quality_rollups(
                        conn,
                        target_id=tid,
                        checked_at=now,
                        latency_ms=r["latency_ms"],
                        packet_loss=r["packet_loss"],
                        status=r["status"],
                    )
                # La retención se ejecuta una vez al día desde
                # performance_maintenance.py. Evita DELETE masivos cada 30 s.
                _invalidate_quality_history_cache()

            # ── Evaluar umbral de alerta (nueva conexión, la anterior ya cerró) ──
            with db() as conn2:
                settings      = conn2.execute("SELECT * FROM quality_settings WHERE id=1").fetchone()
                threshold_pct = settings["alert_threshold_pct"] if settings else 200.0
                cooldown_min  = settings["alert_cooldown_minutes"] if settings else 30
                last_alert    = parse_iso(settings["last_alert_at"]) if settings else None
                quiet_start   = (settings["quiet_start"] or "").strip()
                quiet_end     = (settings["quiet_end"] or "").strip()

                # Período silencioso
                app_tz    = get_app_tz(cfg("app_tz", "Europe/Madrid"))
                now_local = utc_now().astimezone(app_tz)
                in_quiet  = False
                if quiet_start and quiet_end:
                    try:
                        qs_h, qs_m = map(int, quiet_start.split(":"))
                        qe_h, qe_m = map(int, quiet_end.split(":"))
                        cur_mins = now_local.hour * 60 + now_local.minute
                        qs_mins  = qs_h * 60 + qs_m
                        qe_mins  = qe_h * 60 + qe_m
                        if qs_mins <= qe_mins:
                            in_quiet = qs_mins <= cur_mins <= qe_mins
                        else:
                            in_quiet = cur_mins >= qs_mins or cur_mins <= qe_mins
                    except Exception:
                        pass
                if in_quiet:
                    return

                # Cooldown
                if last_alert and cooldown_min > 0:
                    elapsed = (utc_now() - last_alert).total_seconds() / 60
                    if elapsed < cooldown_min:
                        return

                # Baseline y anomalías
                anomalies = []
                for (tid, host, name, r, iface) in results:
                    if r["latency_ms"] is None:
                        continue
                    baseline_row = conn2.execute("""
                        SELECT AVG(latency_ms) avg FROM quality_checks
                        WHERE target_id=? AND latency_ms IS NOT NULL
                          AND checked_at >= datetime('now', '-24 hours')
                          AND checked_at < ?
                        LIMIT 1000
                    """, (tid, now)).fetchone()
                    baseline = baseline_row["avg"] if baseline_row else None
                    if baseline and baseline > 0:
                        pct_increase = (r["latency_ms"] / baseline) * 100
                        if pct_increase >= threshold_pct:
                            anomalies.append({
                                "name": name, "host": host,
                                "current": r["latency_ms"],
                                "baseline": round(baseline, 1),
                                "pct": round(pct_increase, 0),
                            })

                enabled_count = len(results)
                if anomalies and len(anomalies) >= enabled_count and enabled_count > 0:
                    lines = [
                        f"  • **{a['name']}** ({a['host']}): "
                        f"{a['current']}ms vs {a['baseline']}ms base ({a['pct']}%)"
                        for a in anomalies
                    ]
                    msg = "📡 **Calidad de Conexión — Anomalía detectada**\n" + "\n".join(lines)
                    if cfg("notify_quality_degraded", "1") == "1":
                        from routers.scans import discord_notify
                        threading.Thread(
                            target=discord_notify,
                            args=(msg,),
                            kwargs={"channel": "alerts"},
                            daemon=True,
                        ).start()
                    if cfg("notify_email", "0") == "1" and cfg("email_quality_degraded", "0") == "1":
                        from routers.config_api import send_email
                        threading.Thread(
                            target=send_email,
                            args=("📡 Calidad de conexión degradada — Auditor IPs", msg),
                            daemon=True,
                        ).start()
                    conn2.execute("UPDATE quality_settings SET last_alert_at=? WHERE id=1", (now,))
    finally:
        _quality_running = False


def reschedule_quality(enabled: bool, interval_s: int = 30) -> None:
    """Añade o elimina el job de quality del scheduler global."""
    sched = _get_scheduler()
    if sched is None:
        return
    try:
        sched.remove_job(_quality_job_id)
    except Exception:
        pass
    if enabled:
        sched.add_job(
            run_quality_checks, "interval",
            seconds=max(15, interval_s),
            id=_quality_job_id, replace_existing=True,
        )


# ══════════════════════════════════════════════════════════════
#  API endpoints
# ══════════════════════════════════════════════════════════════

@router.get("/api/quality/settings")
def api_quality_settings_get():
    with db() as conn:
        row     = conn.execute("SELECT * FROM quality_settings WHERE id=1").fetchone()
        targets = conn.execute("SELECT * FROM quality_targets ORDER BY id").fetchall()
    return {
        "ok": True,
        "settings": dict(row) if row else {},
        "targets":  [dict(t) for t in targets],
    }


@router.put("/api/quality/settings")
def api_quality_settings_put(payload: Dict[str, Any] = Body(...)):
    enabled     = 1 if payload.get("enabled") else 0
    threshold   = float(payload.get("alert_threshold_pct", 200.0))
    cooldown    = int(payload.get("alert_cooldown_minutes", 30))
    quiet_start = (payload.get("quiet_start") or "").strip()
    quiet_end   = (payload.get("quiet_end") or "").strip()
    quality_interface = (payload.get("quality_interface") or "").strip()
    incident_streak_min = max(2, int(payload.get("incident_streak_min", 3) or 3))
    with db() as conn:
        conn.execute("""
            UPDATE quality_settings
            SET enabled=?, alert_threshold_pct=?, alert_cooldown_minutes=?,
                quiet_start=?, quiet_end=?, quality_interface=?, incident_streak_min=?, updated_at=?
            WHERE id=1
        """, (enabled, threshold, cooldown, quiet_start, quiet_end, quality_interface, incident_streak_min, utc_now_iso()))
    reschedule_quality(bool(enabled), 30)
    return {"ok": True}


@router.get("/api/quality/targets")
def api_quality_targets():
    with db() as conn:
        rows = conn.execute("SELECT * FROM quality_targets ORDER BY id").fetchall()
    return {"ok": True, "targets": [dict(r) for r in rows]}


@router.post("/api/quality/targets")
def api_quality_target_create(payload: Dict[str, Any] = Body(...)):
    name      = (payload.get("name")      or "").strip()
    host      = (payload.get("host")      or "").strip()
    interface = (payload.get("interface") or "").strip()
    if not name or not host:
        return JSONResponse({"ok": False, "error": "name y host requeridos"}, status_code=400)
    with db() as conn:
        conn.execute(
            "INSERT INTO quality_targets (name, host, interface, enabled, created_at) VALUES (?,?,?,1,?)",
            (name, host, interface, utc_now_iso()),
        )
    return {"ok": True}


@router.put("/api/quality/targets/{tid}")
def api_quality_target_update(tid: int, payload: Dict[str, Any] = Body(...)):
    name      = (payload.get("name")      or "").strip()
    host      = (payload.get("host")      or "").strip()
    interface = (payload.get("interface") or "").strip()
    if not name or not host:
        return JSONResponse({"ok": False, "error": "name y host requeridos"}, status_code=400)
    with db() as conn:
        conn.execute(
            "UPDATE quality_targets SET name=?, host=?, interface=? WHERE id=?",
            (name, host, interface, tid),
        )
    return {"ok": True}


@router.delete("/api/quality/targets/{tid}")
def api_quality_target_delete(tid: int):
    with db() as conn:
        conn.execute("DELETE FROM quality_checks WHERE target_id=?", (tid,))
        conn.execute("DELETE FROM quality_targets WHERE id=?", (tid,))
    return {"ok": True}


@router.post("/api/quality/targets/{tid}/toggle")
def api_quality_target_toggle(tid: int):
    with db() as conn:
        row = conn.execute("SELECT enabled FROM quality_targets WHERE id=?", (tid,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "No encontrado"}, status_code=404)
        new_state = 0 if row["enabled"] else 1
        conn.execute("UPDATE quality_targets SET enabled=? WHERE id=?", (new_state, tid))
    return {"ok": True, "enabled": bool(new_state)}


@router.get("/api/quality/interfaces")
def api_quality_interfaces():
    """Lista interfaces IPv4 activas del host para elegir la salida del ping."""
    import json as _json

    result = []

    try:
        out = subprocess.run(
            ["ip", "-j", "addr"],
            capture_output=True,
            text=True,
            timeout=5,
        )

        if out.returncode == 0 and (out.stdout or "").strip():
            ifaces = _json.loads(out.stdout)
            for iface in ifaces:
                name = (iface.get("ifname") or "").strip()
                # Excluir loopback y virtual docker/bridge
                if not name or name in ("lo",) or name.startswith(("docker", "br-", "veth", "virbr")):
                    continue
                # Aceptar si tiene al menos una IPv4 O si está UP (aunque sea sin IP, puede usar -I)
                operstate = (iface.get("operstate") or "").upper()
                flags = iface.get("flags", [])
                is_up = operstate == "UP" or "UP" in flags
                addrs = [
                    a.get("local")
                    for a in iface.get("addr_info", [])
                    if a.get("family") == "inet" and a.get("local")
                ]
                if not is_up and not addrs:
                    continue

                result.append({
                    "name": name,
                    "addrs": addrs,
                })
    except Exception:
        pass

    # Nunca devolver 500 aquí: el frontend debe poder seguir cargando.
    return {"ok": True, "interfaces": result}


@router.get("/api/quality/history")
def api_quality_history(days: int = 1, trace: str | None = None):
    days = max(1, min(365, int(days or 1)))
    bucket_minutes = 5 if days <= 1 else (15 if days <= 7 else 60)
    cache_ttl = _performance_api_cache_seconds()
    now_monotonic = time.monotonic()

    if cache_ttl > 0:
        with _quality_history_cache_lock:
            cached = _quality_history_cache.get(days)
            if cached and (now_monotonic - cached[0]) < cache_ttl:
                return copy.deepcopy(cached[1])

    cutoff = (utc_now() - timedelta(days=days)).isoformat()
    cutoff_bucket = _quality_bucket_start(cutoff, bucket_minutes)

    with db() as conn:
        settings = conn.execute(
            "SELECT incident_streak_min FROM quality_settings WHERE id=1"
        ).fetchone()
        incident_streak_min = (
            max(2, int(settings["incident_streak_min"] or 3))
            if settings and "incident_streak_min" in settings.keys()
            else 3
        )

        targets = conn.execute(
            "SELECT * FROM quality_targets ORDER BY id"
        ).fetchall()
        target_map = {
            t["id"]: {
                "id": t["id"],
                "name": t["name"],
                "host": t["host"],
                "enabled": bool(t["enabled"]),
                "interface": (t["interface"] or ""),
                "data": [],
            }
            for t in targets
        }

        rows = conn.execute(
            """
            SELECT
                target_id,
                bucket_start,
                sample_count,
                latency_sum,
                latency_count,
                packet_loss_max,
                error_count
            FROM quality_rollups
            WHERE bucket_minutes = ?
              AND bucket_start >= ?
            ORDER BY target_id ASC, bucket_start ASC
            """,
            (bucket_minutes, cutoff_bucket),
        ).fetchall()

    for row in rows:
        target = target_map.get(row["target_id"])
        if target is None:
            continue

        latency_count = int(row["latency_count"] or 0)
        latency = (
            round(float(row["latency_sum"] or 0) / latency_count, 1)
            if latency_count > 0
            else None
        )

        loss = float(row["packet_loss_max"] or 0)
        packet_loss = int(loss) if loss.is_integer() else round(loss, 1)

        if int(row["error_count"] or 0) > 0:
            status = "error"
        elif loss > 0:
            status = "degraded"
        else:
            status = "ok"

        target["data"].append({
            "checked_at": row["bucket_start"],
            "latency_ms": latency,
            "packet_loss": packet_loss,
            "status": status,
        })

    payload = {
        "ok": True,
        "incident_streak_min": incident_streak_min,
        "targets": list(target_map.values()),
    }

    if cache_ttl > 0:
        with _quality_history_cache_lock:
            _quality_history_cache[days] = (
                time.monotonic(),
                copy.deepcopy(payload),
            )

    return payload


@router.get("/api/quality/summary")
def api_quality_summary():
    """Último check por destino + estado agregado (ok / degraded / down)."""
    with db() as conn:
        targets = conn.execute(
            "SELECT id, name, host, enabled FROM quality_targets ORDER BY id"
        ).fetchall()
        out = []
        for t in targets:
            last = conn.execute("""
                SELECT checked_at, latency_ms, packet_loss, status
                FROM quality_checks
                WHERE target_id=?
                ORDER BY checked_at DESC
                LIMIT 1
            """, (t["id"],)).fetchone()
            out.append({
                "id":      t["id"],
                "name":    t["name"],
                "host":    t["host"],
                "enabled": bool(t["enabled"]),
                "last":    dict(last) if last else None,
            })

    enabled = [x for x in out if x["enabled"]]
    worst = "ok"
    for x in enabled:
        last = x.get("last") or {}
        st   = last.get("status")
        loss = last.get("packet_loss")
        if st in ("down", "error"):
            worst = "down"
            break
        if isinstance(loss, (int, float)) and loss and loss > 0:
            worst = "degraded" if worst == "ok" else worst

    return {"ok": True, "overall": worst, "targets": out}


@router.post("/api/quality/check-now")
def api_quality_check_now():
    """Lanza un check manual inmediato en background."""
    threading.Thread(target=run_quality_checks, daemon=True).start()
    return {"ok": True}


@router.post("/api/quality/ping-now")
def api_quality_ping_now():
    """
    Lanza pings a todos los targets activos sincrónicamente y devuelve resultados.
    También persiste los checks en BD.
    """
    import time as _time

    try:
        with db() as conn:
            settings     = conn.execute("SELECT * FROM quality_settings WHERE id=1").fetchone()
            global_iface = (settings["quality_interface"] or "").strip() if settings and "quality_interface" in settings.keys() else ""
            targets      = conn.execute(
                "SELECT id, host, name, interface FROM quality_targets WHERE enabled=1"
            ).fetchall()

        if not targets:
            return {"ok": False, "error": "No hay destinos activos configurados", "results": []}

        now     = utc_now_iso()
        results = []
        for t in targets:
            iface = (t["interface"] or "").strip() or global_iface
            ts    = _time.strftime("%H:%M:%S")
            r     = run_quality_ping(t["host"], count=1, interface=iface)
            results.append({
                "name":        t["name"],
                "host":        t["host"],
                "interface":   iface or "auto",
                "latency_ms":  r["latency_ms"],
                "packet_loss": r["packet_loss"],
                "status":      r["status"],
                "ts":          ts,
            })

        # Persistir en BD
        with _db_write_lock:
            with db() as conn:
                for (idx, t) in enumerate(targets):
                    r = results[idx]
                    conn.execute("""
                        INSERT INTO quality_checks (target_id, checked_at, latency_ms, packet_loss, status)
                        VALUES (?, ?, ?, ?, ?)
                    """, (t["id"], now, r["latency_ms"], r["packet_loss"], r["status"]))

        return {"ok": True, "results": results}

    except Exception as e:
        return {"ok": False, "error": str(e), "results": []}



def _run_quality_command(cmd: List[str], timeout: int = 45) -> Dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        output = "\n".join(part for part in (stdout, stderr) if part).strip()
        return {
            "available": True,
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "output": output,
            "cmd": cmd,
        }
    except FileNotFoundError:
        return {
            "available": False,
            "ok": False,
            "returncode": None,
            "output": "Herramienta no disponible en el runtime.",
            "cmd": cmd,
        }
    except subprocess.TimeoutExpired as e:
        stdout = ((e.stdout or "") if isinstance(e.stdout, str) else "").strip()
        stderr = ((e.stderr or "") if isinstance(e.stderr, str) else "").strip()
        output = "\n".join(part for part in (stdout, stderr) if part).strip()
        return {
            "available": True,
            "ok": False,
            "returncode": None,
            "output": output or "Timeout",
            "cmd": cmd,
            "timeout": True,
        }


def _run_quality_ping_diagnostic(host: str, count: int = 4, interface: str = "") -> Dict[str, Any]:
    count = max(1, min(10, int(count or 4)))
    cmd = ["ping", "-c", str(count), "-W", "3"]
    if interface:
        cmd += ["-I", interface]
    cmd.append(host)

    result = _run_quality_command(cmd, timeout=max(15, count * 5))
    output = result.get("output") or ""

    avg_ms = None
    packet_loss = 100
    if output:
        m = re.search(r"rtt min/avg/max/mdev = [\d.]+/([\d.]+)/", output)
        if m:
            try:
                avg_ms = float(m.group(1))
            except Exception:
                avg_ms = None
        loss_m = re.search(r"(\d+)% packet loss", output)
        if loss_m:
            try:
                packet_loss = int(loss_m.group(1))
            except Exception:
                packet_loss = 100

    status = "ok" if packet_loss < 100 else "error"
    if result.get("timeout"):
        status = "timeout"
    elif result.get("available") and packet_loss > 0 and packet_loss < 100:
        status = "degraded"

    result.update({
        "host": host,
        "interface": interface or "auto",
        "count": count,
        "avg_ms": avg_ms,
        "packet_loss": packet_loss,
        "status": status,
    })
    return result


def _run_quality_traceroute_diagnostic(host: str, interface: str = "", max_hops: int = 12) -> Dict[str, Any]:
    max_hops = max(4, min(30, int(max_hops or 12)))

    traceroute_bin = shutil.which("traceroute")
    tracepath_bin = shutil.which("tracepath")

    if traceroute_bin:
        cmd = [traceroute_bin, "-n", "-m", str(max_hops), "-w", "2"]
        if interface:
            cmd += ["-i", interface]
        cmd.append(host)
        result = _run_quality_command(cmd, timeout=45)
        result.update({
            "tool": "traceroute",
            "host": host,
            "interface": interface or "auto",
            "max_hops": max_hops,
        })
        return result

    if tracepath_bin:
        cmd = [tracepath_bin, "-n", host]
        result = _run_quality_command(cmd, timeout=30)
        note = ""
        if interface:
            note = "tracepath no usa aquí selección explícita de interfaz; se ejecuta por ruta automática."
        result.update({
            "tool": "tracepath",
            "host": host,
            "interface": interface or "auto",
            "max_hops": max_hops,
            "note": note,
        })
        return result

    return {
        "available": False,
        "ok": False,
        "tool": "traceroute",
        "host": host,
        "interface": interface or "auto",
        "max_hops": max_hops,
        "output": "Ni traceroute ni tracepath están disponibles en el runtime.",
    }


def _run_quality_mtr_diagnostic(host: str, interface: str = "", max_hops: int = 12) -> Dict[str, Any]:
    max_hops = max(4, min(30, int(max_hops or 12)))
    mtr_bin = shutil.which("mtr")

    if not mtr_bin:
        return {
            "available": False,
            "ok": False,
            "tool": "mtr",
            "host": host,
            "interface": interface or "auto",
            "max_hops": max_hops,
            "output": "mtr no está disponible en el runtime.",
        }

    def _has_hops(output: str) -> bool:
        for line in (output or "").splitlines():
            if re.match(r"^\s*\d+\.\|--", line):
                return True
        return False

    base_cmd = [
        mtr_bin,
        "--report",
        "--report-wide",
        "--report-cycles", "4",
        "--max-ttl", str(max_hops),
    ]

    requested_interface = interface or "auto"

    if interface:
        cmd = base_cmd + ["--interface", interface, host]
        result = _run_quality_command(cmd, timeout=60)
        result.update({
            "tool": "mtr",
            "host": host,
            "interface": requested_interface,
            "max_hops": max_hops,
        })

        if _has_hops(result.get("output") or ""):
            return result

        fallback = _run_quality_command(base_cmd + [host], timeout=60)
        note = (
            f"mtr con --interface {interface} no devolvió saltos útiles; "
            "se relanza sin interfaz explícita por ruta automática."
        )
        fallback_output = (fallback.get("output") or "").strip()
        fallback["output"] = f"{note}\n\n{fallback_output}".strip()
        fallback.update({
            "tool": "mtr",
            "host": host,
            "interface": requested_interface,
            "effective_interface": "auto",
            "max_hops": max_hops,
            "note": note,
            "fallback_without_interface": True,
        })
        return fallback

    result = _run_quality_command(base_cmd + [host], timeout=60)
    result.update({
        "tool": "mtr",
        "host": host,
        "interface": requested_interface,
        "max_hops": max_hops,
    })
    return result


def _build_quality_incident_report(host: str, interface: str, ping: Dict[str, Any], trace: Dict[str, Any], mtr: Dict[str, Any]) -> str:
    lines = [
        f"Destino: {host}",
        f"Interfaz solicitada: {interface or 'auto'}",
        "",
        "Resumen rápido:",
    ]

    ping_status = ping.get("status") or "unknown"
    avg_ms = ping.get("avg_ms")
    packet_loss = ping.get("packet_loss")

    if ping_status == "ok":
        lines.append(f"- Ping correcto. Latencia media: {avg_ms if avg_ms is not None else '—'} ms. Pérdida: {packet_loss}%.")
    elif ping_status == "degraded":
        lines.append(f"- Ping degradado. Latencia media: {avg_ms if avg_ms is not None else '—'} ms. Pérdida: {packet_loss}%.")
    elif ping_status == "timeout":
        lines.append("- Ping sin respuesta completa por timeout.")
    else:
        lines.append(f"- Ping con error o caída. Pérdida: {packet_loss}%.")

    if trace.get("available"):
        lines.append(f"- {trace.get('tool', 'traceroute')} ejecutado.")
    else:
        lines.append("- Sin traceroute/tracepath disponible en este runtime.")

    if mtr.get("available"):
        lines.append("- mtr ejecutado.")
    else:
        lines.append("- mtr no disponible en este runtime.")

    if trace.get("note"):
        lines.append(f"- Nota traceroute: {trace.get('note')}")

    lines += [
        "",
        "Lectura técnica:",
        "- Este informe es una base técnica local para la futura vista de análisis de incidencia.",
        "- El texto bruto de ping, traceroute/tracepath y mtr se devuelve por separado para mostrarlo en UI o enviarlo luego a IA.",
    ]
    return "\n".join(lines).strip()


@router.post("/api/quality/diagnose-now")
def api_quality_diagnose_now(payload: Dict[str, Any] = Body(...)):
    host = (payload.get("host") or "").strip()
    interface = (payload.get("interface") or "").strip()
    count = max(1, min(10, int(payload.get("count", 4) or 4)))
    max_hops = max(4, min(30, int(payload.get("max_hops", 12) or 12)))

    raw_include_mtr = str(payload.get("include_mtr", True)).strip().lower()
    include_mtr = raw_include_mtr not in ("0", "false", "no", "off")

    if not host:
        return JSONResponse({"ok": False, "error": "host requerido"}, status_code=400)

    ping = _run_quality_ping_diagnostic(host, count=count, interface=interface)
    trace = _run_quality_traceroute_diagnostic(host, interface=interface, max_hops=max_hops)
    mtr = (
        _run_quality_mtr_diagnostic(host, interface=interface, max_hops=max_hops)
        if include_mtr else
        {
            "available": False,
            "ok": False,
            "tool": "mtr",
            "host": host,
            "interface": interface or "auto",
            "max_hops": max_hops,
            "skipped": True,
            "output": "mtr omitido por petición.",
        }
    )

    report_text = _build_quality_incident_report(host, interface, ping, trace, mtr)

    return {
        "ok": True,
        "host": host,
        "interface": interface or "auto",
        "count": count,
        "max_hops": max_hops,
        "ping": ping,
        "traceroute": trace,
        "mtr": mtr,
        "report_text": report_text,
    }



def _build_quality_incident_ai_prompt(
    host: str,
    interface: str,
    report_text: str,
    ping_meta: str,
    ping_output: str,
    trace_meta: str,
    trace_output: str,
    mtr_meta: str,
    mtr_output: str,
) -> str:
    return """Actúa como analista senior de red LAN/WAN.
Quiero una valoración técnica breve, clara y accionable.
Devuélveme solo estas secciones:
1. Resumen ejecutivo
2. Severidad (baja/media/alta)
3. Tramo sospechoso
4. Evidencias clave
5. Hipótesis más probables
6. Siguientes comprobaciones recomendadas
7. Acciones inmediatas sugeridas

CONTEXTO
- Destino: {host}
- Interfaz solicitada: {interface}

INFORME TÉCNICO RESUMIDO
{report_text}

PING META
{ping_meta}
PING OUTPUT
{ping_output}

TRACEROUTE / TRACEPATH META
{trace_meta}
TRACEROUTE / TRACEPATH OUTPUT
{trace_output}

MTR META
{mtr_meta}
MTR OUTPUT
{mtr_output}
""".format(
        host=host or "sin destino",
        interface=interface or "auto",
        report_text=report_text or "(sin informe resumido)",
        ping_meta=ping_meta or "(sin metadatos)",
        ping_output=ping_output or "(sin salida)",
        trace_meta=trace_meta or "(sin metadatos)",
        trace_output=trace_output or "(sin salida)",
        mtr_meta=mtr_meta or "(sin metadatos)",
        mtr_output=mtr_output or "(sin salida)",
    ).strip()


@router.post("/api/quality/diagnose-ai")
def api_quality_diagnose_ai(payload: Dict[str, Any] = Body(...)):
    host = str(payload.get("host") or "").strip()
    interface = str(payload.get("interface") or "").strip()

    report_text = str(payload.get("report_text") or "").strip()
    ping_meta = str(payload.get("ping_meta") or "").strip()
    ping_output = str(payload.get("ping_output") or "").strip()
    trace_meta = str(payload.get("trace_meta") or "").strip()
    trace_output = str(payload.get("trace_output") or "").strip()
    mtr_meta = str(payload.get("mtr_meta") or "").strip()
    mtr_output = str(payload.get("mtr_output") or "").strip()

    if not host:
        return JSONResponse({"ok": False, "error": "Destino requerido"}, status_code=400)

    if not any([report_text, ping_output, trace_output, mtr_output]):
        return JSONResponse({"ok": False, "error": "No hay diagnóstico técnico que analizar"}, status_code=400)

    prompt = _build_quality_incident_ai_prompt(
        host=host,
        interface=interface,
        report_text=report_text,
        ping_meta=ping_meta,
        ping_output=ping_output,
        trace_meta=trace_meta,
        trace_output=trace_output,
        mtr_meta=mtr_meta,
        mtr_output=mtr_output,
    )

    try:
        from routers.scripts_status import _ai_generate, _ai_provider

        analysis, model_used = _ai_generate(prompt)
        provider = _ai_provider()

        return {
            "ok": True,
            "host": host,
            "interface": interface or "auto",
            "provider": provider,
            "model": model_used,
            "analysis": analysis,
            "prompt_used": prompt,
        }
    except HTTPException as e:
        return JSONResponse({"ok": False, "error": str(e.detail)}, status_code=e.status_code)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/quality/export.csv")
def api_quality_export_csv(
    date_from: str = "",
    date_to:   str = "",
    target_id: int = 0,
    loss_only: int = 0,
    loss_min:  int = 1,
):
    """Exporta quality checks como CSV con filtros opcionales."""
    conditions: List[str] = []
    params: List[Any]     = []

    if date_from:
        conditions.append("qc.checked_at >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("qc.checked_at <= ?")
        params.append(date_to + "T23:59:59")
    if target_id:
        conditions.append("qc.target_id = ?")
        params.append(target_id)
    if loss_only:
        conditions.append("qc.packet_loss IS NOT NULL AND qc.packet_loss >= ?")
        params.append(int(loss_min))

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    with db() as conn:
        rows = conn.execute(f"""
            SELECT qt.name AS target_name, qt.host,
                   qc.checked_at, qc.latency_ms, qc.packet_loss, qc.status
            FROM quality_checks qc
            JOIN quality_targets qt ON qt.id = qc.target_id
            {where}
            ORDER BY qc.checked_at ASC
        """, params).fetchall()

    buf = io.StringIO()
    w   = csv.writer(buf)
    w.writerow(["Destino", "Host", "Fecha/Hora (UTC)", "Ping (ms)", "Pérdida paquetes (%)", "Estado"])
    for r in rows:
        w.writerow([
            r["target_name"], r["host"], r["checked_at"],
            r["latency_ms"] if r["latency_ms"] is not None else "",
            r["packet_loss"] if r["packet_loss"] is not None else "",
            r["status"],
        ])

    filename = f"calidad_{date_from or 'inicio'}_{date_to or 'hoy'}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8-sig"),  # BOM para Excel
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )