"""
system_health.py — Salud interna de Auditor IPs

Endpoints V4 iniciales:
- /api/system/healthz: comprobación mínima para Docker/instalador/smoke.
- /api/system/health: estado básico protegido para futuro panel interno.

No expone secretos, tokens ni API keys.
No consulta servicios remotos pesados.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from config import DB_PATH, cfg, module_enabled
from scan_scheduler import get_scheduler_health

router = APIRouter()

_STARTED_MONOTONIC = time.monotonic()
_STARTED_AT = datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _bytes_or_zero(path: str) -> int:
    try:
        return os.path.getsize(path) if path and os.path.exists(path) else 0
    except Exception:
        return 0


def _safe_int_setting(key: str, default: int, min_value: int, max_value: int) -> int:
    try:
        value = int(str(cfg(key, str(default))).strip())
    except Exception:
        value = default
    return max(min_value, min(max_value, value))


def _db_check() -> Dict[str, Any]:
    started = time.monotonic()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.execute("SELECT 1").fetchone()
            page_size = int(conn.execute("PRAGMA page_size").fetchone()[0] or 0)
            page_count = int(conn.execute("PRAGMA page_count").fetchone()[0] or 0)
            freelist_count = int(conn.execute("PRAGMA freelist_count").fetchone()[0] or 0)
        latency_ms = round((time.monotonic() - started) * 1000, 1)
        return {
            "ok": True,
            "status": "ok",
            "latency_ms": latency_ms,
            "path": DB_PATH,
            "size_bytes": _bytes_or_zero(DB_PATH),
            "wal_bytes": _bytes_or_zero(DB_PATH + "-wal"),
            "shm_bytes": _bytes_or_zero(DB_PATH + "-shm"),
            "sqlite": {
                "page_size": page_size,
                "page_count": page_count,
                "freelist_count": freelist_count,
                "freelist_bytes": page_size * freelist_count,
            },
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - started) * 1000, 1)
        return {
            "ok": False,
            "status": "error",
            "latency_ms": latency_ms,
            "path": DB_PATH,
            "error": str(exc),
        }


def _storage_check() -> Dict[str, Any]:
    data_dir = os.path.dirname(DB_PATH) or "/data"
    warning_pct = _safe_int_setting("health_disk_warning_pct", 80, 1, 99)
    error_pct = _safe_int_setting("health_disk_error_pct", 90, warning_pct, 100)

    try:
        if not os.path.isdir(data_dir):
            return {
                "ok": False,
                "status": "error",
                "path": data_dir,
                "error": "data_dir_missing",
            }

        usage = shutil.disk_usage(data_dir)
        used_pct = round((usage.used / usage.total) * 100, 1) if usage.total else 0.0

        if used_pct >= error_pct:
            status = "error"
        elif used_pct >= warning_pct:
            status = "warning"
        else:
            status = "ok"

        return {
            "ok": status != "error",
            "status": status,
            "path": data_dir,
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "used_pct": used_pct,
            "warning_pct": warning_pct,
            "error_pct": error_pct,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "path": data_dir,
            "error": str(exc),
        }


def _backup_check() -> Dict[str, Any]:
    backup_dir = os.path.join(os.path.dirname(DB_PATH) or "/data", "backups")
    try:
        backups = []
        if os.path.isdir(backup_dir):
            for name in os.listdir(backup_dir):
                if not (name.startswith("auditor_") and name.endswith(".db")):
                    continue
                full = os.path.join(backup_dir, name)
                try:
                    stat = os.stat(full)
                    backups.append({
                        "filename": name,
                        "size_bytes": stat.st_size,
                        "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).replace(microsecond=0).isoformat(),
                    })
                except Exception:
                    pass

        backups.sort(key=lambda item: item.get("mtime") or "", reverse=True)
        latest = backups[0] if backups else None

        return {
            "ok": True,
            "status": "ok" if latest else "warning",
            "path": backup_dir,
            "count": len(backups),
            "latest": latest,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "path": backup_dir,
            "error": str(exc),
        }


def _parse_utc_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _age_seconds(value: Any) -> int | None:
    dt = _parse_utc_dt(value)
    if not dt:
        return None
    return max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))


def _duration_seconds(started_at: Any, finished_at: Any) -> int | None:
    start = _parse_utc_dt(started_at)
    end = _parse_utc_dt(finished_at)
    if not start or not end:
        return None
    return max(0, int((end - start).total_seconds()))


def _scheduler_check() -> Dict[str, Any]:
    try:
        snap = get_scheduler_health()
        jobs = snap.get("jobs") if isinstance(snap.get("jobs"), list) else []
        scan_job = next((j for j in jobs if j.get("id") == "scan_job"), None)

        if not snap.get("available"):
            status = "warning"
        elif snap.get("error"):
            status = "error"
        elif snap.get("state") != "running":
            status = "error"
        elif not scan_job:
            status = "warning"
        else:
            status = "ok"

        return {
            "ok": status != "error",
            "status": status,
            **snap,
            "scan_job": scan_job,
            "scan_job_present": bool(scan_job),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "error": str(exc),
        }


def _scan_check() -> Dict[str, Any]:
    started = time.monotonic()
    scan_interval_seconds = _safe_int_setting("scan_interval", 120, 10, 86400)
    default_stale_minutes = max(60, int((scan_interval_seconds * 5) / 60) + 1)
    stale_minutes = _safe_int_setting("health_scan_stale_minutes", default_stale_minutes, 1, 10080)

    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            latest = conn.execute("""
                SELECT id, started_at, finished_at, cidr,
                       online_hosts, offline_hosts, new_hosts,
                       events_sent, discord_sent, COALESCE(discord_error, '') AS discord_error
                FROM scans
                ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
                LIMIT 1
            """).fetchone()

            today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
            scans_today = int(conn.execute(
                "SELECT COUNT(*) FROM scans WHERE started_at >= ?",
                (today_start,),
            ).fetchone()[0] or 0)

            unfinished_count = int(conn.execute(
                "SELECT COUNT(*) FROM scans WHERE finished_at IS NULL"
            ).fetchone()[0] or 0)

        latency_ms = round((time.monotonic() - started) * 1000, 1)

        if not latest:
            return {
                "ok": True,
                "status": "warning",
                "latency_ms": latency_ms,
                "message": "no_scans_found",
                "scan_interval_seconds": scan_interval_seconds,
                "stale_after_minutes": stale_minutes,
                "scans_today": scans_today,
                "unfinished_count": unfinished_count,
                "latest": None,
            }

        latest_dict = dict(latest)
        last_finished = latest_dict.get("finished_at") or latest_dict.get("started_at")
        age = _age_seconds(last_finished)
        duration = _duration_seconds(latest_dict.get("started_at"), latest_dict.get("finished_at"))

        status = "ok"
        message = "ok"
        if unfinished_count > 0:
            status = "warning"
            message = "unfinished_scans_present"
        elif age is not None and age > stale_minutes * 60:
            status = "warning"
            message = "last_scan_stale"

        return {
            "ok": status != "error",
            "status": status,
            "latency_ms": latency_ms,
            "message": message,
            "scan_interval_seconds": scan_interval_seconds,
            "stale_after_minutes": stale_minutes,
            "scans_today": scans_today,
            "unfinished_count": unfinished_count,
            "latest": {
                **latest_dict,
                "age_seconds": age,
                "duration_seconds": duration,
            },
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - started) * 1000, 1)
        return {
            "ok": False,
            "status": "error",
            "latency_ms": latency_ms,
            "error": str(exc),
        }



def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        return bool(row)
    except Exception:
        return False


def _count_rows(conn: sqlite3.Connection, table: str, where: str = "", params: tuple[Any, ...] = ()) -> int:
    if not _table_exists(conn, table):
        return 0
    sql = f"SELECT COUNT(*) FROM {table}"
    if where:
        sql += f" WHERE {where}"
    return int(conn.execute(sql, params).fetchone()[0] or 0)


def _latest_row(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> Dict[str, Any] | None:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def _quality_check() -> Dict[str, Any]:
    started = time.monotonic()
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(microsecond=0).isoformat()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            total_targets = _count_rows(conn, "quality_targets")
            active_targets = _count_rows(conn, "quality_targets", "enabled=1")
            checks_24h = _count_rows(conn, "quality_checks", "checked_at >= ?", (since,))
            errors_24h = _count_rows(
                conn,
                "quality_checks",
                "checked_at >= ? AND LOWER(COALESCE(status,'')) NOT IN ('ok','up','online','success')",
                (since,),
            )
            settings = _latest_row(conn, "SELECT enabled, last_alert_at, updated_at FROM quality_settings ORDER BY id DESC LIMIT 1") if _table_exists(conn, "quality_settings") else None
            latest = _latest_row(conn, """
                SELECT qc.id, qc.target_id, qt.name AS target_name, qt.host,
                       qc.checked_at, qc.latency_ms, qc.packet_loss, qc.status
                FROM quality_checks qc
                LEFT JOIN quality_targets qt ON qt.id = qc.target_id
                ORDER BY qc.checked_at DESC, qc.id DESC
                LIMIT 1
            """) if _table_exists(conn, "quality_checks") else None

        enabled = bool(settings and int(settings.get("enabled") or 0))
        if not enabled and active_targets == 0:
            status = "disabled"
            message = "quality_disabled"
        elif active_targets == 0:
            status = "warning"
            message = "no_active_quality_targets"
        elif errors_24h > 0:
            status = "warning"
            message = "quality_errors_recent"
        elif not latest:
            status = "warning"
            message = "no_quality_checks"
        else:
            status = "ok"
            message = "ok"

        if latest:
            latest["age_seconds"] = _age_seconds(latest.get("checked_at"))

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "enabled": enabled,
            "targets_total": total_targets,
            "targets_active": active_targets,
            "checks_24h": checks_24h,
            "errors_24h": errors_24h,
            "last_alert_at": settings.get("last_alert_at") if settings else None,
            "latest": latest,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _services_check() -> Dict[str, Any]:
    started = time.monotonic()
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(microsecond=0).isoformat()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            total = _count_rows(conn, "services")
            enabled = _count_rows(conn, "services", "enabled=1")
            checks_24h = _count_rows(conn, "service_checks", "checked_at >= ?", (since,))
            errors_24h = _count_rows(
                conn,
                "service_checks",
                "checked_at >= ? AND LOWER(COALESCE(status,'')) NOT IN ('ok','up','online','success')",
                (since,),
            )
            latest = _latest_row(conn, """
                SELECT sc.id, sc.service_id, s.name, s.host, s.port, s.protocol,
                       sc.checked_at, sc.status, sc.latency_ms, COALESCE(sc.error, '') AS error
                FROM service_checks sc
                LEFT JOIN services s ON s.id = sc.service_id
                ORDER BY sc.checked_at DESC, sc.id DESC
                LIMIT 1
            """) if _table_exists(conn, "service_checks") else None

        if enabled == 0:
            status = "disabled"
            message = "services_disabled"
        elif errors_24h > 0:
            status = "warning"
            message = "service_errors_recent"
        elif not latest:
            status = "warning"
            message = "no_service_checks"
        else:
            status = "ok"
            message = "ok"

        if latest:
            latest["age_seconds"] = _age_seconds(latest.get("checked_at"))
            latest.pop("error", None) if not latest.get("error") else None

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "services_total": total,
            "services_enabled": enabled,
            "checks_24h": checks_24h,
            "errors_24h": errors_24h,
            "latest": latest,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _automation_status_files_check() -> Dict[str, Any]:
    data_dir = os.path.dirname(DB_PATH) or "/data"
    dirs = [
        os.path.join(data_dir, "scripts_status"),
        os.path.join(data_dir, "agent_scripts_status"),
    ]
    counts = {
        "ok": 0,
        "running": 0,
        "error": 0,
        "missed": 0,
        "stalled": 0,
        "unknown": 0,
    }
    total = 0
    latest_mtime = None

    for base in dirs:
        if not os.path.isdir(base):
            continue
        for root, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(".json"):
                    continue
                full = os.path.join(root, name)
                total += 1
                try:
                    stat = os.stat(full)
                    if latest_mtime is None or stat.st_mtime > latest_mtime:
                        latest_mtime = stat.st_mtime
                    with open(full, "r", encoding="utf-8") as fh:
                        payload = json.load(fh)
                    raw = str(
                        payload.get("status")
                        or payload.get("state")
                        or payload.get("last_status")
                        or ""
                    ).strip().lower()
                except Exception:
                    raw = "unknown"

                if raw in ("ok", "success", "done", "completed"):
                    counts["ok"] += 1
                elif raw in ("running", "in_progress", "processing"):
                    counts["running"] += 1
                elif raw in ("error", "failed", "fail"):
                    counts["error"] += 1
                elif raw in ("missed", "late"):
                    counts["missed"] += 1
                elif raw in ("stalled", "timeout", "stuck"):
                    counts["stalled"] += 1
                else:
                    counts["unknown"] += 1

    latest = None
    if latest_mtime is not None:
        latest = datetime.fromtimestamp(latest_mtime, timezone.utc).replace(microsecond=0).isoformat()

    return {
        "status_files": total,
        "status_counts": counts,
        "latest_status_mtime": latest,
        "latest_status_age_seconds": _age_seconds(latest),
    }


def _automations_check() -> Dict[str, Any]:
    started = time.monotonic()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            scripts_total = _count_rows(conn, "monitored_scripts")
            scripts_active = _count_rows(conn, "monitored_scripts", "active=1")
            alert_rules_total = _count_rows(conn, "script_alert_rules")
            alert_rules_enabled = _count_rows(
                conn,
                "script_alert_rules",
                "alert_missed=1 OR alert_error=1 OR alert_running_long=1",
            )

        files = _automation_status_files_check()
        counts = files.get("status_counts") or {}
        noisy = int(counts.get("error") or 0) + int(counts.get("missed") or 0) + int(counts.get("stalled") or 0)

        if scripts_active == 0 and files.get("status_files", 0) == 0:
            status = "disabled"
            message = "automations_disabled"
        elif noisy > 0:
            status = "warning"
            message = "automation_issues_present"
        elif scripts_active > 0 and files.get("status_files", 0) == 0:
            status = "warning"
            message = "no_automation_status_files"
        else:
            status = "ok"
            message = "ok"

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "scripts_total": scripts_total,
            "scripts_active": scripts_active,
            "alert_rules_total": alert_rules_total,
            "alert_rules_enabled": alert_rules_enabled,
            **files,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _agents_check() -> Dict[str, Any]:
    started = time.monotonic()
    stale_minutes = _safe_int_setting("health_agent_stale_minutes", 1440, 5, 10080)
    since_auth = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(microsecond=0).isoformat()
    try:
        stale_enabled = 0
        latest_seen = None
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            total = _count_rows(conn, "automation_agents")
            enabled = _count_rows(conn, "automation_agents", "enabled=1 AND revoked_at IS NULL")
            revoked = _count_rows(conn, "automation_agents", "revoked_at IS NOT NULL OR enabled=0")
            if _table_exists(conn, "automation_agents"):
                rows = conn.execute("""
                    SELECT host_name, enabled, revoked_at, last_seen_at, last_status_script
                    FROM automation_agents
                    WHERE enabled=1 AND revoked_at IS NULL
                """).fetchall()
                for row in rows:
                    item = dict(row)
                    seen = item.get("last_seen_at")
                    age = _age_seconds(seen)
                    if seen and (latest_seen is None or str(seen) > str(latest_seen)):
                        latest_seen = seen
                    if age is None or age > stale_minutes * 60:
                        stale_enabled += 1

            auth_failed_24h = _count_rows(
                conn,
                "automation_agent_events",
                "at >= ? AND ok=0 AND LOWER(COALESCE(action,'')) LIKE '%auth%'",
                (since_auth,),
            )
            latest_event = _latest_row(conn, """
                SELECT id, at, host_name, ip, action, ok
                FROM automation_agent_events
                ORDER BY at DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "automation_agent_events") else None

        if enabled == 0:
            status = "disabled"
            message = "agents_disabled"
        elif auth_failed_24h > 0:
            status = "warning"
            message = "agent_auth_failures_recent"
        elif stale_enabled > 0:
            status = "warning"
            message = "agents_stale"
        else:
            status = "ok"
            message = "ok"

        if latest_event:
            latest_event["age_seconds"] = _age_seconds(latest_event.get("at"))

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "agents_total": total,
            "agents_enabled": enabled,
            "agents_revoked": revoked,
            "stale_after_minutes": stale_minutes,
            "agents_stale": stale_enabled,
            "latest_seen_at": latest_seen,
            "latest_seen_age_seconds": _age_seconds(latest_seen),
            "auth_failed_24h": auth_failed_24h,
            "latest_event": latest_event,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _syncthing_check() -> Dict[str, Any]:
    started = time.monotonic()
    stale_minutes = _safe_int_setting("health_syncthing_stale_minutes", 30, 1, 10080)
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(microsecond=0).isoformat()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            nodes_total = _count_rows(conn, "syncthing_nodes")
            nodes_enabled = _count_rows(conn, "syncthing_nodes", "enabled=1")
            latest_cache = _latest_row(conn, """
                SELECT refreshed_at, status, error, updated_at
                FROM syncthing_overview_cache
                ORDER BY COALESCE(refreshed_at, updated_at) DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "syncthing_overview_cache") else None
            folder_errors_24h = _count_rows(
                conn,
                "syncthing_folder_snapshots",
                "observed_at >= ? AND (errors > 0 OR LOWER(COALESCE(status,'')) LIKE '%error%' OR LOWER(COALESCE(state,'')) LIKE '%error%')",
                (since,),
            )
            stalled_alerts = _count_rows(conn, "syncthing_stalled_alert_state", "COALESCE(last_alert_at,'') <> ''")
            file_events_24h = _count_rows(conn, "syncthing_file_events", "observed_at >= ?", (since,))

        cache_time = None
        cache_status = ""
        cache_error = ""
        if latest_cache:
            cache_time = latest_cache.get("refreshed_at") or latest_cache.get("updated_at")
            cache_status = str(latest_cache.get("status") or "").lower()
            cache_error = str(latest_cache.get("error") or "")

        cache_age = _age_seconds(cache_time)

        if nodes_enabled == 0:
            status = "disabled"
            message = "syncthing_disabled"
        elif cache_error:
            status = "warning"
            message = "syncthing_cache_error"
        elif cache_age is None:
            status = "warning"
            message = "syncthing_cache_missing"
        elif cache_age > stale_minutes * 60:
            status = "warning"
            message = "syncthing_cache_stale"
        elif folder_errors_24h > 0 or stalled_alerts > 0:
            status = "warning"
            message = "syncthing_issues_present"
        else:
            status = "ok"
            message = "ok"

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "nodes_total": nodes_total,
            "nodes_enabled": nodes_enabled,
            "cache_status": cache_status,
            "cache_refreshed_at": cache_time,
            "cache_age_seconds": cache_age,
            "stale_after_minutes": stale_minutes,
            "folder_errors_24h": folder_errors_24h,
            "stalled_alerts": stalled_alerts,
            "file_events_24h": file_events_24h,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _ai_check() -> Dict[str, Any]:
    started = time.monotonic()
    provider = str(
        cfg("ai_provider", "")
        or cfg("ai_service", "")
        or cfg("llm_provider", "")
        or ""
    ).strip()
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            scan_reports = _count_rows(conn, "scan_ai_reports")
            daily_reports = _count_rows(conn, "daily_reports")
            latest_scan = _latest_row(conn, """
                SELECT id, generated_at, discrepancy_count, source
                FROM scan_ai_reports
                ORDER BY generated_at DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "scan_ai_reports") else None
            latest_daily = _latest_row(conn, """
                SELECT id, report_date, generated_at, provider, model
                FROM daily_reports
                ORDER BY generated_at DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "daily_reports") else None

        latest_at = None
        for candidate in (latest_scan, latest_daily):
            if candidate and candidate.get("generated_at"):
                value = candidate.get("generated_at")
                if latest_at is None or str(value) > str(latest_at):
                    latest_at = value

        configured = bool(provider)
        if not configured:
            status = "disabled"
            message = "ai_disabled"
        else:
            status = "ok"
            message = "ok"

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "configured": configured,
            "provider": provider if configured else "",
            "scan_reports": scan_reports,
            "daily_reports": daily_reports,
            "latest_generated_at": latest_at,
            "latest_age_seconds": _age_seconds(latest_at),
            "latest_scan_report": latest_scan,
            "latest_daily_report": latest_daily,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }


def _notifications_check() -> Dict[str, Any]:
    started = time.monotonic()
    discord_configured = bool(str(
        cfg("discord_webhook_alerts", "")
        or cfg("discord_webhook_info", "")
        or cfg("discord_webhook_url", "")
        or cfg("discord_webhook", "")
        or cfg("DISCORD_WEBHOOK_URL", "")
        or ""
    ).strip())
    try:
        with sqlite3.connect(DB_PATH, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            alerts_total = _count_rows(conn, "alerts")
            alerts_enabled = _count_rows(conn, "alerts", "enabled=1")
            script_rules_total = _count_rows(conn, "script_alert_rules")
            script_rules_enabled = _count_rows(
                conn,
                "script_alert_rules",
                "alert_missed=1 OR alert_error=1 OR alert_running_long=1",
            )
            latest_alert = _latest_row(conn, """
                SELECT id, name, trigger_type, action, enabled, last_fired
                FROM alerts
                WHERE COALESCE(last_fired,'') <> ''
                ORDER BY last_fired DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "alerts") else None
            latest_script_alert = _latest_row(conn, """
                SELECT id, host_name, script_name, last_fired
                FROM script_alert_rules
                WHERE COALESCE(last_fired,'') <> ''
                ORDER BY last_fired DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "script_alert_rules") else None
            latest_scan_discord_error = _latest_row(conn, """
                SELECT id, started_at, finished_at, discord_error
                FROM scans
                WHERE COALESCE(discord_error,'') <> ''
                ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
                LIMIT 1
            """) if _table_exists(conn, "scans") else None

        enabled_any = alerts_enabled > 0 or script_rules_enabled > 0

        if not discord_configured and not enabled_any:
            status = "disabled"
            message = "notifications_disabled"
        elif enabled_any and not discord_configured:
            status = "warning"
            message = "alerts_enabled_without_discord"
        elif latest_scan_discord_error:
            status = "warning"
            message = "recent_discord_error"
        else:
            status = "ok"
            message = "ok"

        return {
            "ok": status not in ("error",),
            "status": status,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "message": message,
            "discord_configured": discord_configured,
            "alerts_total": alerts_total,
            "alerts_enabled": alerts_enabled,
            "script_rules_total": script_rules_total,
            "script_rules_enabled": script_rules_enabled,
            "latest_alert": latest_alert,
            "latest_script_alert": latest_script_alert,
            "latest_scan_discord_error": bool(latest_scan_discord_error),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "error",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "error": str(exc),
        }




def _disabled_module_check(module_id: str, message: str | None = None) -> Dict[str, Any]:
    return {
        "ok": True,
        "status": "disabled",
        "message": message or f"{module_id}_disabled_by_module_setting",
        "module_enabled": False,
    }



def _app_info() -> Dict[str, Any]:
    return {
        "name": "Auditor IPs",
        "started_at": _STARTED_AT.replace(microsecond=0).isoformat(),
        "uptime_seconds": int(time.monotonic() - _STARTED_MONOTONIC),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "pid": os.getpid(),
        "db_path": DB_PATH,
    }


def _overall_status(parts: Dict[str, Dict[str, Any]]) -> str:
    statuses = [str(v.get("status", "unknown")) for v in parts.values()]
    if "error" in statuses:
        return "error"
    if "warning" in statuses:
        return "warning"
    if "unknown" in statuses:
        return "unknown"
    return "ok"


@router.get("/api/system/healthz")
def api_system_healthz():
    """Healthcheck mínimo, sin datos sensibles, pensado para Docker/instalador."""
    db = _db_check()
    storage = _storage_check()
    ok = bool(db.get("ok")) and storage.get("status") != "error"

    payload = {
        "ok": ok,
        "status": "ok" if ok else "error",
        "generated_at": _utc_now_iso(),
        "checks": {
            "database": "ok" if db.get("ok") else "error",
            "storage": storage.get("status", "unknown"),
        },
    }

    return JSONResponse(payload, status_code=200 if ok else 503)


@router.get("/api/system/health")
def api_system_health():
    """Estado básico protegido para el futuro panel de salud interno."""
    database = _db_check()
    storage = _storage_check()
    backups = _backup_check()
    scheduler = _scheduler_check()
    scans = _scan_check()
    quality = _quality_check() if module_enabled("quality") else _disabled_module_check("quality")
    services = _services_check() if module_enabled("services") else _disabled_module_check("services")
    automations = _automations_check() if module_enabled("automation") else _disabled_module_check("automation")
    agents = _agents_check() if module_enabled("agents") else _disabled_module_check("agents")
    syncthing = _syncthing_check() if module_enabled("syncthing") else _disabled_module_check("syncthing")
    ai = _ai_check() if module_enabled("ai") else _disabled_module_check("ai")
    notifications = _notifications_check() if module_enabled("notifications") else _disabled_module_check("notifications")

    parts = {
        "database": database,
        "storage": storage,
        "backups": backups,
        "scheduler": scheduler,
        "scans": scans,
        "quality": quality,
        "services": services,
        "automations": automations,
        "agents": agents,
        "syncthing": syncthing,
        "ai": ai,
        "notifications": notifications,
    }

    return {
        "ok": _overall_status(parts) != "error",
        "overall": _overall_status(parts),
        "generated_at": _utc_now_iso(),
        "app": _app_info(),
        **parts,
    }
