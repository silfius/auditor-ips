"""
performance_maintenance.py — mantenimiento histórico centralizado.

PERF-REST:
- una única ejecución diaria;
- política persistida por módulo;
- backup reciente obligatorio antes de borrar;
- lotes acotados para reducir el tiempo de bloqueo;
- PRAGMA optimize, nunca VACUUM automático.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from config import cfg, save_setting
from database import DB_PATH, db

BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH), "backups")
_BATCH_SIZE = 5000
_MAINTENANCE_LOCK = threading.Lock()
_DB_WRITE_LOCK: threading.Lock = threading.Lock()

_MODULE_DEFAULTS = {
    "scans": 60,
    "hosts": 90,
    "quality": 60,
    "services": 60,
    "automation_agents": 90,
    "syncthing": 30,
    "audit": 180,
    "reports": 180,
}

_MODULE_TABLES = {
    "scans": {
        "scans": "started_at",
        "router_scans": "scanned_at",
        "router_scan_history": "scanned_at",
        "scan_ai_reports": "generated_at",
    },
    "hosts": {
        "host_events": "at",
        "host_latency": "scanned_at",
        # Solo se purgan intervalos ya cerrados. Un intervalo abierto puede
        # haber empezado antes del cutoff y sigue siendo estado vigente.
        "host_availability_intervals": "ended_at",
        "host_uptime": "date",
    },
    "quality": {
        "quality_checks": "checked_at",
        "quality_rollups": "bucket_start",
        "quality_history": "checked_at",
    },
    "services": {
        "service_checks": "checked_at",
        "service_daily_rollups": "day",
    },
    "automation_agents": {
        "automation_agent_events": "at",
    },
    "syncthing": {
        "syncthing_folder_snapshots": "observed_at",
        "syncthing_transfer_snapshots": "observed_at",
        "syncthing_remote_transfer_snapshots": "observed_at",
        "syncthing_file_events": "event_time",
    },
    "audit": {
        "audit_log": "at",
    },
    "reports": {
        "daily_reports": "generated_at",
    },
}


def set_db_write_lock(lock: threading.Lock) -> None:
    global _DB_WRITE_LOCK
    _DB_WRITE_LOCK = lock


def _quote_identifier(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _cutoff_value(date_column: str, cutoff_iso: str) -> str:
    if str(date_column or "").lower() in ("day", "date"):
        return str(cutoff_iso or "")[:10]
    return cutoff_iso


def _policy_days() -> Dict[str, int]:
    policy = dict(_MODULE_DEFAULTS)
    raw = str(cfg("retention_module_days", "") or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            for module_id in policy:
                try:
                    value = int(parsed.get(module_id, policy[module_id]))
                except Exception:
                    continue
                policy[module_id] = max(1, min(3650, value))
    return policy


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row["name"])
        for row in conn.execute(
            f"PRAGMA table_info({_quote_identifier(table)})"
        )
    }


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        """
        SELECT 1
        FROM sqlite_schema
        WHERE type='table' AND name=?
        """,
        (table,),
    ).fetchone() is not None


def estimate_performance_retention(
    *,
    now: datetime | None = None,
) -> Dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    policy = _policy_days()
    modules = []
    total_rows_delete = 0

    with db() as conn:
        for module_id, tables in _MODULE_TABLES.items():
            days = policy[module_id]
            cutoff = (
                current - timedelta(days=days)
            ).replace(microsecond=0).isoformat()
            module_rows_delete = 0
            table_results = []

            for table, date_column in tables.items():
                if not _table_exists(conn, table):
                    table_results.append({
                        "table": table,
                        "status": "missing",
                        "rows_delete": 0,
                    })
                    continue

                columns = _table_columns(conn, table)
                if date_column not in columns:
                    table_results.append({
                        "table": table,
                        "status": f"missing_column:{date_column}",
                        "rows_delete": 0,
                    })
                    continue

                qtable = _quote_identifier(table)
                qcolumn = _quote_identifier(date_column)
                rows_delete = int(
                    conn.execute(
                        f"""
                        SELECT COUNT(*)
                        FROM {qtable}
                        WHERE {qcolumn} IS NOT NULL
                          AND {qcolumn} <> ''
                          AND {qcolumn} < ?
                        """,
                        (_cutoff_value(date_column, cutoff),),
                    ).fetchone()[0]
                    or 0
                )
                module_rows_delete += rows_delete
                table_results.append({
                    "table": table,
                    "date_column": date_column,
                    "rows_delete": rows_delete,
                    "status": "supported",
                })

            total_rows_delete += module_rows_delete
            modules.append({
                "id": module_id,
                "days": days,
                "cutoff_iso": cutoff,
                "rows_delete": module_rows_delete,
                "tables": table_results,
            })

    return {
        "ok": True,
        "generated_at": current.replace(microsecond=0).isoformat(),
        "module_days": policy,
        "total_rows_delete": total_rows_delete,
        "modules": modules,
    }


def _backup_integrity_ok(path: str) -> bool:
    """Valida una copia SQLite antes de usarla como salvaguarda."""
    try:
        uri = f"file:{os.path.abspath(path)}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=30)
        try:
            row = conn.execute("PRAGMA quick_check").fetchone()
            return bool(row and str(row[0]).lower() == "ok")
        finally:
            conn.close()
    except Exception:
        return False


def _latest_recent_backup(max_age_seconds: int = 7200) -> Dict[str, Any] | None:
    if not os.path.isdir(BACKUP_DIR):
        return None

    now = time.time()
    candidates = []
    for name in os.listdir(BACKUP_DIR):
        if not name.startswith("auditor_") or not name.endswith(".db"):
            continue
        path = os.path.join(BACKUP_DIR, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        if stat.st_size <= 0:
            continue
        candidates.append((stat.st_mtime, path, stat.st_size))

    # Validar solo desde la copia más reciente hacia atrás. Así no se hace
    # quick_check de todas las copias conservadas en cada mantenimiento.
    for modified_at, path, size in sorted(candidates, reverse=True):
        age_seconds = max(0, int(now - modified_at))
        if age_seconds > max_age_seconds:
            break
        if not _backup_integrity_ok(path):
            continue
        return {
            "path": path,
            "filename": os.path.basename(path),
            "size_bytes": size,
            "age_seconds": age_seconds,
            "reused": True,
            "integrity": "ok",
        }

    return None


def _create_backup() -> Dict[str, Any]:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    recent = _latest_recent_backup()
    if recent is not None:
        return recent

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = os.path.join(
        BACKUP_DIR,
        f"auditor_performance_retention_{timestamp}.db",
    )

    source = sqlite3.connect(DB_PATH, timeout=60)
    target = sqlite3.connect(path)
    try:
        source.backup(target, pages=4096, sleep=0.01)
        target.commit()
    finally:
        target.close()
        source.close()

    if not _backup_integrity_ok(path):
        try:
            os.remove(path)
        except OSError:
            pass
        raise RuntimeError("backup_integrity_check_failed")

    result = {
        "path": path,
        "filename": os.path.basename(path),
        "size_bytes": os.path.getsize(path),
        "age_seconds": 0,
        "reused": False,
        "integrity": "ok",
    }
    _prune_backups()
    return result


def _prune_backups() -> None:
    try:
        keep = max(1, min(30, int(cfg("backup_keep", "7") or 7)))
    except Exception:
        keep = 7

    try:
        files = sorted(
            (
                os.path.join(BACKUP_DIR, name)
                for name in os.listdir(BACKUP_DIR)
                if name.startswith("auditor_") and name.endswith(".db")
            ),
            key=os.path.getmtime,
            reverse=True,
        )
    except Exception:
        return

    for path in files[keep:]:
        try:
            os.remove(path)
        except OSError:
            pass


def _delete_table_in_batches(
    conn: sqlite3.Connection,
    *,
    table: str,
    date_column: str,
    cutoff: str,
) -> int:
    qtable = _quote_identifier(table)
    qcolumn = _quote_identifier(date_column)
    total = 0

    while True:
        cursor = conn.execute(
            f"""
            DELETE FROM {qtable}
            WHERE rowid IN (
                SELECT rowid
                FROM {qtable}
                WHERE {qcolumn} IS NOT NULL
                  AND {qcolumn} <> ''
                  AND {qcolumn} < ?
                LIMIT ?
            )
            """,
            (_cutoff_value(date_column, cutoff), _BATCH_SIZE),
        )
        removed = max(0, int(cursor.rowcount or 0))
        conn.commit()
        total += removed
        if removed < _BATCH_SIZE:
            return total


def _last_run_is_recent(now: datetime) -> bool:
    raw = str(cfg("performance_maintenance_last_run_at", "") or "").strip()
    if not raw:
        return False
    try:
        previous = datetime.fromisoformat(raw)
        if previous.tzinfo is None:
            previous = previous.replace(tzinfo=timezone.utc)
        return (now - previous.astimezone(timezone.utc)) < timedelta(hours=20)
    except Exception:
        return False


def run_performance_maintenance(
    *,
    force: bool = False,
) -> Dict[str, Any]:
    if cfg("performance_maintenance_enabled", "1") != "1":
        return {"ok": True, "skipped": True, "reason": "disabled"}

    now = datetime.now(timezone.utc)
    if not force and _last_run_is_recent(now):
        return {"ok": True, "skipped": True, "reason": "recent_run"}

    if not _MAINTENANCE_LOCK.acquire(blocking=False):
        return {"ok": True, "skipped": True, "reason": "already_running"}

    started = time.monotonic()
    try:
        estimate = estimate_performance_retention(now=now)
        if int(estimate["total_rows_delete"] or 0) <= 0:
            save_setting(
                "performance_maintenance_last_run_at",
                now.replace(microsecond=0).isoformat(),
            )
            result = {
                "ok": True,
                "skipped": True,
                "reason": "nothing_to_delete",
                "estimate": estimate,
                "duration_seconds": round(time.monotonic() - started, 3),
            }
            save_setting(
                "performance_maintenance_last_result",
                json.dumps(result, ensure_ascii=False, sort_keys=True),
            )
            return result

        # SQLite backup() produce una instantánea consistente y puede convivir
        # con lecturas/escrituras. No mantener el lock global durante la copia:
        # se reserva para la fase de borrado, que sí debe serializar escritores.
        backup = _create_backup()

        with _DB_WRITE_LOCK:
            deleted_tables = []
            total_deleted = 0

            with db() as conn:
                for module in estimate["modules"]:
                    for table_info in module["tables"]:
                        if table_info.get("status") != "supported":
                            continue
                        expected = int(table_info.get("rows_delete") or 0)
                        if expected <= 0:
                            continue

                        removed = _delete_table_in_batches(
                            conn,
                            table=table_info["table"],
                            date_column=table_info["date_column"],
                            cutoff=module["cutoff_iso"],
                        )
                        total_deleted += removed
                        deleted_tables.append({
                            "module": module["id"],
                            "table": table_info["table"],
                            "days": module["days"],
                            "cutoff_iso": module["cutoff_iso"],
                            "estimated": expected,
                            "deleted": removed,
                        })

                conn.execute("PRAGMA optimize")

        finished_at = datetime.now(timezone.utc).replace(microsecond=0)
        result = {
            "ok": True,
            "skipped": False,
            "started_at": now.replace(microsecond=0).isoformat(),
            "finished_at": finished_at.isoformat(),
            "duration_seconds": round(time.monotonic() - started, 3),
            "backup": backup,
            "total_rows_deleted": total_deleted,
            "tables": deleted_tables,
            "vacuum_automatic": False,
        }
        save_setting(
            "performance_maintenance_last_run_at",
            finished_at.isoformat(),
        )
        save_setting(
            "performance_maintenance_last_result",
            json.dumps(result, ensure_ascii=False, sort_keys=True),
        )
        return result
    except Exception as exc:
        result = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "duration_seconds": round(time.monotonic() - started, 3),
        }
        save_setting(
            "performance_maintenance_last_result",
            json.dumps(result, ensure_ascii=False, sort_keys=True),
        )
        return result
    finally:
        _MAINTENANCE_LOCK.release()
