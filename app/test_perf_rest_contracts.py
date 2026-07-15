#!/usr/bin/env python3
"""Contratos dirigidos del macrobloque PERF-02/03/04."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "auditor.db")
        os.environ["DB_PATH"] = db_path
        sys.path.insert(0, str(ROOT))

        import config
        import database

        database.DB_PATH = db_path
        config.DB_PATH = db_path
        database.init_db()
        config.load_settings()

        now = datetime.now(timezone.utc).replace(microsecond=0)
        old = now - timedelta(days=120)
        recent = now - timedelta(hours=1)

        with database.db() as conn:
            conn.execute(
                """
                INSERT INTO quality_targets (
                    id, name, host, enabled, interface, created_at
                )
                VALUES (1, 'Router', '192.0.2.1', 1, '', ?)
                """,
                (now.isoformat(),),
            )
            conn.execute(
                """
                INSERT INTO quality_checks (
                    target_id, checked_at, latency_ms, packet_loss, status
                )
                VALUES
                    (1, ?, 10.0, 0, 'ok'),
                    (1, ?, NULL, 100, 'down')
                """,
                (recent.isoformat(), old.isoformat()),
            )
            conn.execute(
                """
                INSERT INTO services (
                    id, name, host, port, protocol, check_interval,
                    enabled, service_type, created_at
                )
                VALUES (
                    1, 'Web', '192.0.2.2', 443, 'https', 60,
                    1, 'generic', ?
                )
                """,
                (now.isoformat(),),
            )
            conn.execute(
                """
                INSERT INTO service_checks (
                    service_id, checked_at, status, latency_ms
                )
                VALUES
                    (1, ?, 'up', 20.0),
                    (1, ?, 'down', NULL)
                """,
                (recent.isoformat(), old.isoformat()),
            )
            conn.execute(
                """
                INSERT INTO host_events (
                    ip, at, event_type, old_value, new_value
                )
                VALUES ('192.0.2.2', ?, 'status', 'up', 'down')
                """,
                (old.isoformat(),),
            )
            conn.execute(
                """
                INSERT INTO host_availability_intervals (
                    ip, status, started_at, ended_at
                )
                VALUES
                    ('192.0.2.10', 'online', ?, NULL),
                    ('192.0.2.11', 'offline', ?, ?)
                """,
                (
                    old.isoformat(),
                    old.isoformat(),
                    old.isoformat(),
                ),
            )
            conn.execute(
                """
                INSERT INTO scans (
                    started_at, finished_at, cidr,
                    online_hosts, offline_hosts, new_hosts,
                    events_sent, discord_sent, discord_error
                )
                VALUES (?, ?, '192.0.2.0/24', 1, 0, 0, 0, 0, '')
                """,
                (recent.isoformat(), recent.isoformat()),
            )

        # Segunda inicialización: simula el primer arranque tras la migración
        # y debe backfillear los rollups sin duplicarlos.
        database.init_db()
        database.init_db()

        with database.db() as conn:
            indexes = {
                row["name"]
                for table in (
                    "quality_checks",
                    "service_checks",
                    "host_events",
                    "scans",
                )
                for row in conn.execute(f'PRAGMA index_list("{table}")')
            }
            required = {
                "idx_quality_checks_checked_at_global",
                "idx_service_checks_checked_at_global",
                "idx_host_events_at_global",
                "idx_scans_started_at_global",
            }
            check(required <= indexes, f"índices ausentes: {required - indexes}")

            quality_rollups = conn.execute(
                "SELECT COUNT(*) FROM quality_rollups"
            ).fetchone()[0]
            service_rollups = conn.execute(
                "SELECT COUNT(*) FROM service_daily_rollups"
            ).fetchone()[0]
            check(quality_rollups == 6, f"rollups quality inesperados: {quality_rollups}")
            check(service_rollups == 2, f"rollups service inesperados: {service_rollups}")

        from routers import quality
        from routers import services
        import performance_maintenance

        quality._invalidate_quality_history_cache()
        payload = quality.api_quality_history(days=1)
        check(payload["ok"] is True, "quality history no responde OK")
        check(len(payload["targets"]) == 1, "target quality perdido")
        check(len(payload["targets"][0]["data"]) == 1, "quality 1d no filtra rollup antiguo")
        check(
            payload["targets"][0]["data"][0]["latency_ms"] == 10.0,
            "latencia agregada incorrecta",
        )

        services._invalidate_services_cache()
        service_payload = services.api_services_list()
        check(service_payload["ok"] is True, "services no responde OK")
        check(len(service_payload["services"]) == 1, "servicio perdido")
        check(
            service_payload["services"][0]["uptime_pct"] == 100.0,
            "uptime no respeta ventana de retención",
        )

        config.save_setting(
            "retention_module_days",
            json.dumps({
                "audit": 180,
                "automation_agents": 90,
                "hosts": 90,
                "quality": 60,
                "reports": 180,
                "scans": 60,
                "services": 60,
                "syncthing": 30,
            }, sort_keys=True),
        )
        performance_maintenance.DB_PATH = db_path
        performance_maintenance.BACKUP_DIR = os.path.join(temp_dir, "backups")
        performance_maintenance.set_db_write_lock(threading.Lock())

        estimate = performance_maintenance.estimate_performance_retention(now=now)
        check(estimate["total_rows_delete"] >= 4, "retención no detecta históricos antiguos")

        result = performance_maintenance.run_performance_maintenance(force=True)
        check(result["ok"] is True, f"mantenimiento falló: {result}")
        check(result["total_rows_deleted"] >= 5, "mantenimiento no eliminó históricos")
        backup_path = str((result.get("backup") or {}).get("path") or "")
        check(backup_path and os.path.isfile(backup_path), "backup de mantenimiento ausente")
        check(
            performance_maintenance._backup_integrity_ok(backup_path),
            "backup de mantenimiento no supera quick_check",
        )

        with database.db() as conn:
            check(
                conn.execute(
                    "SELECT COUNT(*) FROM quality_checks WHERE checked_at=?",
                    (old.isoformat(),),
                ).fetchone()[0] == 0,
                "quality antiguo no eliminado",
            )
            check(
                conn.execute(
                    "SELECT COUNT(*) FROM service_checks WHERE checked_at=?",
                    (old.isoformat(),),
                ).fetchone()[0] == 0,
                "service antiguo no eliminado",
            )
            check(
                conn.execute(
                    "SELECT COUNT(*) FROM host_events WHERE at=?",
                    (old.isoformat(),),
                ).fetchone()[0] == 0,
                "host_event antiguo no eliminado",
            )
            check(
                conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM host_availability_intervals
                    WHERE ip='192.0.2.10' AND ended_at IS NULL
                    """
                ).fetchone()[0] == 1,
                "intervalo abierto antiguo eliminado indebidamente",
            )
            check(
                conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM host_availability_intervals
                    WHERE ip='192.0.2.11'
                    """
                ).fetchone()[0] == 0,
                "intervalo cerrado antiguo no eliminado",
            )
            check(
                conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                "integrity_check falló",
            )

        for source_name in (
            "routers/quality.py",
            "routers/services.py",
            "routers/scans.py",
        ):
            source = (ROOT / source_name).read_text(encoding="utf-8")
            check(
                "DELETE FROM quality_checks WHERE checked_at <" not in source,
                f"purga caliente de quality reapareció en {source_name}",
            )
            check(
                "DELETE FROM service_checks WHERE checked_at <" not in source,
                f"purga caliente de services reapareció en {source_name}",
            )
            check(
                "purge_old_scans(conn" not in source,
                f"purga caliente de scans reapareció en {source_name}",
            )

        print("PERF_REST_CONTRACTS_OK")


if __name__ == "__main__":
    main()
