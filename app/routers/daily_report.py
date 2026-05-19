"""
daily_report.py — Auditor IPs · Sesión 15
Informe diario IA de red: patrones de hosts, anomalías, dispositivos nuevos/desaparecidos,
horarios de conexión y resumen de scripts del día anterior.

Endpoints:
  POST /api/daily-report/generate          — Genera informe bajo demanda (o cron)
  GET  /api/daily-report/latest            — Último informe guardado
  GET  /api/daily-report/history?days=N    — Historial de informes (default 14)

Tabla BD: daily_reports (creada automáticamente si no existe)
Cron: se registra en main.py → scheduler, disparo a las 06:00 hora local.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ─────────────────────────────────────────────────────────────────────────────
# Helpers — imports circulares evitados con import local
# ─────────────────────────────────────────────────────────────────────────────

def _db():
    from database import db
    return db()

def _cfg(key, default=None):
    try:
        from config import cfg
        return cfg(key, default)
    except Exception:
        return default

def _ai_generate(prompt: str):
    """Reutiliza la lógica de proveedor IA de scripts_status."""
    from routers.scripts_status import _ai_generate as _gen
    return _gen(prompt)

def _utc_now():
    from utils import utc_now
    return utc_now()

def _to_local(iso: str) -> str:
    try:
        from utils import to_local_str, parse_iso
        return to_local_str(parse_iso(iso))
    except Exception:
        return iso


# ─────────────────────────────────────────────────────────────────────────────
# BD — Crear tabla si no existe
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_table():
    with _db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_reports (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            report_date  TEXT NOT NULL UNIQUE,
            analysis     TEXT NOT NULL,
            meta_json    TEXT NOT NULL DEFAULT '{}',
            generated_at TEXT NOT NULL,
            provider     TEXT NOT NULL DEFAULT '',
            model        TEXT NOT NULL DEFAULT ''
        )
        """)
        # Index para queries por fecha
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date DESC)"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Recolección de datos de la BD
# ─────────────────────────────────────────────────────────────────────────────

def _collect_network_data(report_date: str) -> dict:
    """
    Recopila datos de la BD para el día `report_date` (YYYY-MM-DD) y los 14 días anteriores.
    Devuelve un dict estructurado listo para construir el prompt.
    """
    # Ventana: día completo a analizar
    day_start = f"{report_date} 00:00:00"
    day_end   = f"{report_date} 23:59:59"

    # Ventana histórica: 14 días antes
    d = datetime.strptime(report_date, "%Y-%m-%d")
    hist_start = (d - timedelta(days=14)).strftime("%Y-%m-%d") + " 00:00:00"

    with _db() as conn:

        # ── Scans del día ────────────────────────────────────────────────────
        scans_today = conn.execute("""
            SELECT id, started_at, finished_at, online_hosts, offline_hosts, new_hosts
            FROM scans
            WHERE started_at BETWEEN ? AND ?
            ORDER BY started_at
        """, (day_start, day_end)).fetchall()

        # ── Hosts conocidos (total, online hoy, offline hoy) ─────────────────
        hosts_total = conn.execute("SELECT COUNT(*) FROM hosts").fetchone()[0]
        hosts_known = conn.execute("SELECT COUNT(*) FROM hosts WHERE known=1").fetchone()[0]

        # IPs que estuvieron online hoy (al menos 1 scan las vio online)
        online_today = conn.execute("""
            SELECT DISTINCT ip FROM host_uptime
            WHERE date = ? AND online_seconds > 0
        """, (report_date,)).fetchall()
        online_today_ips = {r["ip"] for r in online_today}

        # ── Dispositivos nuevos el día de hoy ────────────────────────────────
        new_devices = conn.execute("""
            SELECT h.ip, h.mac, COALESCE(h.manual_name, h.dns_name, h.nmap_hostname, '') as name,
                   h.vendor, h.first_seen
            FROM hosts h
            WHERE date(h.first_seen) = ?
        """, (report_date,)).fetchall()

        # ── Dispositivos desaparecidos (online ayer, offline hoy) ────────────
        yesterday = (d - timedelta(days=1)).strftime("%Y-%m-%d")
        online_yesterday = conn.execute("""
            SELECT DISTINCT ip FROM host_uptime
            WHERE date = ? AND online_seconds > 0
        """, (yesterday,)).fetchall()
        online_yesterday_ips = {r["ip"] for r in online_yesterday}
        disappeared_ips = online_yesterday_ips - online_today_ips

        disappeared_hosts = []
        for ip in disappeared_ips:
            h = conn.execute("""
                SELECT ip, COALESCE(manual_name, dns_name, nmap_hostname, '') as name, vendor
                FROM hosts WHERE ip=?
            """, (ip,)).fetchone()
            if h:
                disappeared_hosts.append(dict(h))

        # ── Uptime por host hoy ───────────────────────────────────────────────
        uptime_today = conn.execute("""
            SELECT u.ip,
                   COALESCE(h.manual_name, h.dns_name, h.nmap_hostname, u.ip) as name,
                   u.online_seconds, u.offline_seconds,
                   ROUND(u.online_seconds * 100.0 / MAX(u.online_seconds + u.offline_seconds, 1), 1) as pct
            FROM host_uptime u
            LEFT JOIN hosts h ON h.ip = u.ip
            WHERE u.date = ? AND u.online_seconds > 0
            ORDER BY u.online_seconds DESC
        """, (report_date,)).fetchall()

        # ── Eventos del día (conexiones, desconexiones, MAC changes, nuevos) ──
        events_today = conn.execute("""
            SELECT event_type, ip, COUNT(*) as cnt
            FROM host_events
            WHERE at BETWEEN ? AND ?
            GROUP BY event_type, ip
            ORDER BY cnt DESC
            LIMIT 30
        """, (day_start, day_end)).fetchall()

        # ── Horarios de mayor actividad (scans con más hosts online) ──────────
        hourly_online = conn.execute("""
            SELECT strftime('%H', started_at) as hour,
                   ROUND(AVG(online_hosts), 1) as avg_online,
                   MAX(online_hosts) as max_online
            FROM scans
            WHERE started_at BETWEEN ? AND ?
            GROUP BY hour
            ORDER BY hour
        """, (day_start, day_end)).fetchall()

        # ── Tendencia histórica: media online por día (14d) ───────────────────
        daily_trend = conn.execute("""
            SELECT date(started_at) as day,
                   ROUND(AVG(online_hosts), 1) as avg_online,
                   MAX(online_hosts) as max_online,
                   COUNT(*) as n_scans
            FROM scans
            WHERE started_at BETWEEN ? AND ?
            GROUP BY day
            ORDER BY day
        """, (hist_start, day_end)).fetchall()

        # ── Hosts con comportamiento inusual (online_pct < 50% o > 98%) ──────
        anomaly_hosts = conn.execute("""
            SELECT u.ip,
                   COALESCE(h.manual_name, h.dns_name, h.nmap_hostname, u.ip) as name,
                   u.online_seconds, u.offline_seconds,
                   ROUND(u.online_seconds * 100.0 / MAX(u.online_seconds + u.offline_seconds, 1), 1) as pct
            FROM host_uptime u
            LEFT JOIN hosts h ON h.ip = u.ip
            WHERE u.date = ?
              AND (u.online_seconds + u.offline_seconds) > 3600
              AND (
                  ROUND(u.online_seconds * 100.0 / (u.online_seconds + u.offline_seconds), 1) < 50
                  OR ROUND(u.online_seconds * 100.0 / (u.online_seconds + u.offline_seconds), 1) > 98
              )
            ORDER BY pct ASC
            LIMIT 10
        """, (report_date,)).fetchall()

        # ── Hosts con MAC change ──────────────────────────────────────────────
        mac_changes = conn.execute("""
            SELECT ip, old_value, new_value, at
            FROM host_events
            WHERE event_type = 'mac_change' AND at BETWEEN ? AND ?
        """, (day_start, day_end)).fetchall()

    def _fmt_uptime(secs):
        secs = int(secs or 0)
        h, m = divmod(secs // 60, 60)
        return f"{h}h {m:02d}m" if h else f"{m}m"

    return {
        "report_date":        report_date,
        "scans_count":        len(scans_today),
        "hosts_total":        hosts_total,
        "hosts_known":        hosts_known,
        "online_today_count": len(online_today_ips),
        "new_devices":        [dict(r) for r in new_devices],
        "disappeared_hosts":  disappeared_hosts,
        "uptime_top": [
            {
                "ip":   r["ip"],
                "name": r["name"],
                "pct":  r["pct"],
                "time": _fmt_uptime(r["online_seconds"]),
            }
            for r in uptime_today[:20]
        ],
        "events_summary": [dict(r) for r in events_today],
        "hourly_online":  [dict(r) for r in hourly_online],
        "daily_trend":    [dict(r) for r in daily_trend],
        "anomaly_hosts":  [dict(r) for r in anomaly_hosts],
        "mac_changes":    [dict(r) for r in mac_changes],
    }


def _collect_scripts_data(report_date: str) -> list[dict]:
    """Lee los .status.json del directorio de scripts para el día indicado."""
    import os
    scripts_dir = Path(os.getenv("SCRIPTS_STATUS_DIR", "/data/scripts_status"))
    results = []
    if not scripts_dir.exists():
        return results

    for f in sorted(scripts_dir.glob("*.status.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            start = data.get("start_time", "")
            # Solo incluir scripts que corrieron el día del informe
            if start and start.startswith(report_date):
                name      = f.stem.replace(".status", "")
                exit_code = data.get("exit_code")
                state     = data.get("status", "?")
                duration  = data.get("duration_seconds")
                errors    = data.get("error_messages", [])

                # Determinar estado real
                if exit_code == 0:
                    real_state = "OK"
                elif exit_code is not None:
                    real_state = f"ERROR (exit={exit_code})"
                elif state in ("missed", "stalled"):
                    real_state = state.upper()
                else:
                    real_state = state

                # Filtrar ruido interno del monitor
                _NOISE = ("[MONITOR] ERROR: Ejecución completada con alertas",)
                clean_errors = [e for e in errors if not any(e.startswith(n) for n in _NOISE)]

                results.append({
                    "name":       name,
                    "state":      real_state,
                    "start":      start,
                    "end":        data.get("end_time", ""),
                    "duration":   duration,
                    "exit_code":  exit_code,
                    "errors":     clean_errors[:3],
                })
        except Exception:
            pass
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Construcción del prompt
# ─────────────────────────────────────────────────────────────────────────────

def _fmt_dur(secs) -> str:
    if secs is None:
        return "?"
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    m, s = divmod(secs, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


def _build_daily_prompt(net: dict, scripts: list[dict]) -> str:

    # ── Resumen de red ────────────────────────────────────────────────────────
    network_lines = [
        f"Fecha analizada: {net['report_date']}",
        f"Total hosts en BD: {net['hosts_total']} ({net['hosts_known']} conocidos)",
        f"Hosts online durante el día: {net['online_today_count']}",
        f"Scans realizados: {net['scans_count']}",
    ]

    # Dispositivos nuevos
    if net["new_devices"]:
        devs = ", ".join(
            f"{d['ip']} ({d['name'] or d.get('vendor','?')})"
            for d in net["new_devices"]
        )
        network_lines.append(f"Dispositivos NUEVOS detectados: {devs}")
    else:
        network_lines.append("Dispositivos nuevos: ninguno")

    # Dispositivos desaparecidos
    if net["disappeared_hosts"]:
        gone = ", ".join(
            f"{d['ip']} ({d['name'] or '?'})"
            for d in net["disappeared_hosts"]
        )
        network_lines.append(f"Dispositivos que estaban ayer y HOY NO aparecieron: {gone}")

    # Top hosts por uptime
    if net["uptime_top"]:
        network_lines.append("\nTop hosts por tiempo online:")
        for h in net["uptime_top"][:12]:
            network_lines.append(f"  · {h['name'] or h['ip']:25s}  {h['time']:8s}  ({h['pct']}%)")

    # Horarios de actividad
    if net["hourly_online"]:
        network_lines.append("\nMedia de hosts online por hora:")
        hourly = "  " + "  ".join(
            f"{r['hour']}h:{r['avg_online']}"
            for r in net["hourly_online"]
        )
        network_lines.append(hourly)

    # Anomalías
    if net["anomaly_hosts"]:
        network_lines.append("\nHosts con comportamiento inusual (pct online anómalo):")
        for h in net["anomaly_hosts"]:
            network_lines.append(f"  ⚠ {h['name'] or h['ip']}  → {h['pct']}% online")

    # MAC changes
    if net["mac_changes"]:
        network_lines.append(f"\nCambios de MAC detectados: {len(net['mac_changes'])}")
        for m in net["mac_changes"][:5]:
            network_lines.append(f"  · {m['ip']}: {m['old_value']} → {m['new_value']}")

    # Tendencia 14 días
    if len(net["daily_trend"]) >= 3:
        trend_line = "  " + " | ".join(
            f"{r['day'][-5:]}:{r['avg_online']}"
            for r in net["daily_trend"][-7:]
        )
        network_lines.append(f"\nTendencia online (últimos 7 días de los 14):\n{trend_line}")

    # ── Resumen de scripts ────────────────────────────────────────────────────
    scripts_lines = []
    if scripts:
        for s in scripts:
            err_str = ""
            if s["errors"]:
                err_str = " | Alertas: " + "; ".join(s["errors"][:2])
            scripts_lines.append(
                f"  · {s['name']:35s} {s['state']:12s} dur={_fmt_dur(s['duration'])}{err_str}"
            )
    else:
        scripts_lines.append("  (no se registraron ejecuciones de scripts este día)")

    network_block  = "\n".join(network_lines)
    scripts_block  = "\n".join(scripts_lines)

    return f"""Eres un experto en administración de redes y sistemas Linux. \
Analiza los datos de red y scripts del servidor para el día {net['report_date']} \
y genera un informe ejecutivo en español con observaciones concretas y útiles.

══════════════════════════════════════════
DATOS DE RED — {net['report_date']}
══════════════════════════════════════════
{network_block}

══════════════════════════════════════════
SCRIPTS AUTOMATIZADOS DEL DÍA
══════════════════════════════════════════
{scripts_block}

══════════════════════════════════════════
INSTRUCCIONES:
Responde con exactamente estas 5 secciones en Markdown. \
Usa datos concretos (IPs, nombres, horas, porcentajes reales). \
Sé directo y útil. No inventes datos que no estén arriba.

## Resumen del día
(2-3 frases: cuántos hosts, actividad general, si todo fue normal o hubo incidencias)

## Dispositivos y cambios
(Nuevos dispositivos, desaparecidos, cambios de MAC. Si no hay, indicar "Sin cambios relevantes.")

## Patrones de conexión
(Hosts más activos, horario de mayor actividad, hosts con comportamiento inusual)

## Scripts del servidor
(Estado de cada script: OK o problemas. Si todos OK, decirlo en una frase.)

## Recomendaciones
(1-3 acciones concretas basadas en los datos. Si todo está bien, indicarlo.)"""


# ─────────────────────────────────────────────────────────────────────────────
# Lógica de generación
# ─────────────────────────────────────────────────────────────────────────────

def generate_daily_report(report_date: str | None = None) -> dict:
    """
    Genera el informe para `report_date` (YYYY-MM-DD).
    Si es None, usa el día de ayer (el informe se genera a las 06:00 del día siguiente).
    Guarda en BD y devuelve el informe.
    """
    _ensure_table()

    if report_date is None:
        report_date = (_utc_now() - timedelta(days=1)).strftime("%Y-%m-%d")

    # Recolectar datos
    net     = _collect_network_data(report_date)
    scripts = _collect_scripts_data(report_date)

    # Construir prompt y llamar a IA
    prompt = _build_daily_prompt(net, scripts)
    try:
        analysis, model_used = _ai_generate(prompt)
    except Exception as e:
        analysis   = f"[Error generando informe: {e}]"
        model_used = "error"

    # Limpiar wrappers markdown
    analysis = re.sub(r'^```(?:markdown)?\s*', '', analysis, flags=re.IGNORECASE)
    analysis = re.sub(r'\s*```\s*$', '', analysis).strip()

    provider = _cfg("ai_provider", "gemini")
    now_iso  = _utc_now().isoformat()

    meta = {
        "hosts_total":        net["hosts_total"],
        "online_today_count": net["online_today_count"],
        "scans_count":        net["scans_count"],
        "new_devices":        len(net["new_devices"]),
        "disappeared":        len(net["disappeared_hosts"]),
        "scripts_count":      len(scripts),
        "scripts_ok":         sum(1 for s in scripts if s["state"] == "OK"),
    }

    # Guardar en BD (upsert por fecha)
    with _db() as conn:
        conn.execute("""
            INSERT INTO daily_reports (report_date, analysis, meta_json, generated_at, provider, model)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(report_date) DO UPDATE SET
                analysis     = excluded.analysis,
                meta_json    = excluded.meta_json,
                generated_at = excluded.generated_at,
                provider     = excluded.provider,
                model        = excluded.model
        """, (report_date, analysis, json.dumps(meta), now_iso, provider, model_used))

    return {
        "report_date":  report_date,
        "analysis":     analysis,
        "meta":         meta,
        "generated_at": now_iso,
        "provider":     provider,
        "model":        model_used,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/api/daily-report/generate")
def api_generate_report(date: str | None = None):
    """
    Genera (o regenera) el informe diario para `date` (YYYY-MM-DD).
    Si no se pasa `date`, usa el día de ayer.
    """
    if date:
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Formato de fecha inválido. Usa YYYY-MM-DD.")
    return generate_daily_report(date)


@router.get("/api/daily-report/latest")
def api_latest_report():
    """Devuelve el informe más reciente guardado en BD."""
    _ensure_table()
    with _db() as conn:
        row = conn.execute("""
            SELECT report_date, analysis, meta_json, generated_at, provider, model
            FROM daily_reports
            ORDER BY report_date DESC
            LIMIT 1
        """).fetchone()

    if not row:
        return {"report_date": None, "analysis": None, "meta": {}}

    return {
        "report_date":  row["report_date"],
        "analysis":     row["analysis"],
        "meta":         json.loads(row["meta_json"] or "{}"),
        "generated_at": row["generated_at"],
        "provider":     row["provider"],
        "model":        row["model"],
    }


@router.get("/api/daily-report/history")
def api_report_history(days: int = 14):
    """Devuelve el historial de informes (sin el análisis completo, solo metadatos)."""
    _ensure_table()
    days = min(max(days, 1), 90)
    with _db() as conn:
        rows = conn.execute("""
            SELECT report_date, meta_json, generated_at, provider, model
            FROM daily_reports
            ORDER BY report_date DESC
            LIMIT ?
        """, (days,)).fetchall()

    return [
        {
            "report_date":  r["report_date"],
            "meta":         json.loads(r["meta_json"] or "{}"),
            "generated_at": r["generated_at"],
            "provider":     r["provider"],
            "model":        r["model"],
        }
        for r in rows
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Scheduler — se registra desde main.py
# ─────────────────────────────────────────────────────────────────────────────

_scheduler_ref = None

def set_scheduler(sched) -> None:
    global _scheduler_ref
    _scheduler_ref = sched


def register_daily_report_job() -> None:
    """
    Registra (o reemplaza) el cron de informe diario en el scheduler.
    Se llama desde main.py en el startup. Disparo a las 06:00 hora local.
    """
    sched = _scheduler_ref
    if not sched:
        return

    JOB_ID = "daily_report_job"

    # Eliminar job existente si lo hay
    if sched.get_job(JOB_ID):
        sched.remove_job(JOB_ID)

    def _job():
        try:
            result = generate_daily_report()
            print(f"[DAILY-REPORT] Informe generado para {result['report_date']} "
                  f"con {result['provider']}/{result['model']}")
        except Exception as e:
            print(f"[DAILY-REPORT] Error generando informe: {e}")

    # Cada día a las 06:00 hora local
    try:
        tz = _cfg("app_tz", "Europe/Madrid")
        sched.add_job(_job, "cron", hour=6, minute=0,
                      timezone=tz, id=JOB_ID, replace_existing=True)
        print(f"[DAILY-REPORT] Cron registrado: 06:00 {tz}")
    except Exception as e:
        print(f"[DAILY-REPORT] Error registrando cron: {e}")
