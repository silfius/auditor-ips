#!/usr/bin/env python3
"""Contratos dirigidos de PERF-01: cron, deduplicación y carga diferida."""

from datetime import datetime
from pathlib import Path
from time import perf_counter
from zoneinfo import ZoneInfo

from routers import scripts_status as status

TZ = ZoneInfo("Europe/Madrid")
ROOT = Path(__file__).resolve().parent


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def timed_call(func, *args):
    started = perf_counter()
    value = func(*args)
    return value, perf_counter() - started


def main():
    now = datetime(2026, 7, 14, 18, 31, 37, tzinfo=TZ)

    cases = [
        (
            "*/5 * * * *",
            "2026-07-14T18:35:00+02:00",
            "2026-07-14T18:30:00+02:00",
        ),
        (
            "0 3 1 * *",
            "2026-08-01T03:00:00+02:00",
            "2026-07-01T03:00:00+02:00",
        ),
        (
            "22 7 * * *",
            "2026-07-15T07:22:00+02:00",
            "2026-07-14T07:22:00+02:00",
        ),
        (
            "10 8-22 * * *",
            "2026-07-14T19:10:00+02:00",
            "2026-07-14T18:10:00+02:00",
        ),
    ]
    for expr, next_expected, previous_expected in cases:
        next_value, next_seconds = timed_call(
            status._compute_next_run_from_cron,
            expr,
            now,
        )
        previous_value, previous_seconds = timed_call(
            status._compute_previous_run_from_cron,
            expr,
            now,
        )
        check(
            next_value and next_value.isoformat() == next_expected,
            f"next incorrecto para {expr}: {next_value}",
        )
        check(
            previous_value
            and previous_value.isoformat() == previous_expected,
            f"previous incorrecto para {expr}: {previous_value}",
        )
        check(
            next_seconds < 0.05,
            f"next lento para {expr}: {next_seconds:.6f}s",
        )
        check(
            previous_seconds < 0.05,
            f"previous lento para {expr}: {previous_seconds:.6f}s",
        )

    or_next = status._compute_next_run_from_cron(
        "0 9 15 * 1",
        now,
    )
    check(
        or_next
        and or_next.isoformat() == "2026-07-15T09:00:00+02:00",
        f"DOM/DOW OR roto: {or_next}",
    )

    sunday_zero = status._compute_next_run_from_cron(
        "0 9 * * 0",
        now,
    )
    sunday_seven = status._compute_next_run_from_cron(
        "0 9 * * 7",
        now,
    )
    check(
        sunday_zero == sunday_seven,
        "domingo 0/7 no equivalente",
    )

    leap_now = datetime(2026, 3, 1, 12, 0, tzinfo=TZ)
    leap_next = status._compute_next_run_from_cron(
        "0 0 29 2 *",
        leap_now,
    )
    leap_previous = status._compute_previous_run_from_cron(
        "0 0 29 2 *",
        leap_now,
    )
    check(
        leap_next and leap_next.year == 2028,
        f"leap next incorrecto: {leap_next}",
    )
    check(
        leap_previous and leap_previous.year == 2024,
        f"leap previous incorrecto: {leap_previous}",
    )

    dst_now = datetime(2026, 3, 28, 3, 0, tzinfo=TZ)
    dst_next = status._compute_next_run_from_cron(
        "30 2 * * *",
        dst_now,
    )
    check(
        dst_next
        and dst_next.isoformat() == "2026-03-30T02:30:00+02:00",
        f"hora DST inexistente no omitida: {dst_next}",
    )

    invalid_next, invalid_next_seconds = timed_call(
        status._compute_next_run_from_cron,
        "UNSCHEDULED_MANUAL_PREFLIGHT",
        now,
    )
    invalid_previous, invalid_previous_seconds = timed_call(
        status._compute_previous_run_from_cron,
        "UNSCHEDULED_MANUAL_PREFLIGHT",
        now,
    )
    check(
        invalid_next is None and invalid_previous is None,
        "marcador no cron no degrada a None",
    )
    check(
        max(invalid_next_seconds, invalid_previous_seconds) < 0.01,
        "marcador no cron sigue siendo costoso",
    )

    cfg_map = {
        "active": {
            "label": "Activo",
            "color": "",
            "active": True,
            "cron_expr": "0 1 * * *",
            "cron_source": "test",
            "host_name": "HostA",
            "host_source": "config_ui",
        },
        "inactive": {
            "label": "Inactivo",
            "color": "",
            "active": False,
            "cron_expr": "0 2 * * *",
            "cron_source": "test",
            "host_name": "HostA",
            "host_source": "config_ui",
        },
    }
    prepared = status._prepare_status_items(
        [
            {
                "_file": "active.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 3,
                "updated_at": "2026-07-14T18:00:00+02:00",
            },
            {
                "_file": "active.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 2,
                "updated_at": "2026-07-14T18:01:00+02:00",
            },
            {
                "_file": "active.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 1,
                "updated_at": "2026-07-14 18:02:00+02:00",
            },
            {
                "_file": "inactive.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 3,
            },
        ],
        cfg_map,
        {"active": 0},
    )
    check(
        len(prepared) == 1,
        f"filtrado/dedup temprano incorrecto: {len(prepared)}",
    )
    check(
        prepared[0]["updated_at"] == "2026-07-14 18:02:00+02:00",
        "dedup no prioriza la frescura lógica del estado",
    )
    check(
        prepared[0]["instance_key"] == "HostA::active",
        "instance_key alterado",
    )

    mirror_cfg = {
        "mirror": {
            "label": "Mirror",
            "color": "",
            "active": True,
            "cron_expr": "0 7 * * *",
            "cron_source": "test",
            "host_name": "RemoteA",
            "host_source": "config_ui",
        },
    }
    same_logical_state = status._prepare_status_items(
        [
            {
                "_file": "mirror.status.json",
                "_status_source_from_path": "status_dir_subdir",
                "_status_mtime_ns": 100,
                "_copy": "structured",
                "host_name": "RemoteA",
                "updated_at": "2026-07-14T07:30:00+02:00",
            },
            {
                "_file": "mirror.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 200,
                "_copy": "root",
                "host_name": "RemoteA",
                "updated_at": "2026-07-14T07:30:00+02:00",
            },
        ],
        mirror_cfg,
        {"mirror": 0},
    )
    check(
        len(same_logical_state) == 1
        and same_logical_state[0]["_copy"] == "structured"
        and same_logical_state[0]["host_source"]
        == "status_dir_subdir",
        "dedup no preserva procedencia estructurada con igual fecha lógica",
    )

    newer_root_state = status._prepare_status_items(
        [
            {
                "_file": "mirror.status.json",
                "_status_source_from_path": "status_dir_subdir",
                "_status_mtime_ns": 300,
                "_copy": "structured",
                "host_name": "RemoteA",
                "updated_at": "2026-07-14T07:30:00+02:00",
            },
            {
                "_file": "mirror.status.json",
                "_status_source_from_path": "local_status_dir",
                "_status_mtime_ns": 100,
                "_copy": "root",
                "host_name": "RemoteA",
                "updated_at": "2026-07-14T07:31:00+02:00",
            },
        ],
        mirror_cfg,
        {"mirror": 0},
    )
    check(
        len(newer_root_state) == 1
        and newer_root_state[0]["_copy"] == "root",
        "la autoridad de origen pisa una fecha lógica realmente más nueva",
    )

    dashboard = (
        ROOT / "static/js/dashboard.js"
    ).read_text(encoding="utf-8")
    services = (
        ROOT / "static/js/services.js"
    ).read_text(encoding="utf-8")
    scripts_source = (
        ROOT / "routers/scripts_status.py"
    ).read_text(encoding="utf-8")
    template = (
        ROOT / "templates/index.html"
    ).read_text(encoding="utf-8")

    check(
        "[1, 7, 30].forEach" not in dashboard,
        "Dashboard conserva precarga 1/7/30",
    )
    check(
        "_servicesPaneIsVisible" in services,
        "Servicios no tiene guard de visibilidad",
    )
    check(
        "_servicesLoadInFlight" in services,
        "Servicios no evita cargas concurrentes",
    )
    check(
        "/static/js/dashboard.js?v=20260714_perf01" in template,
        "Template no actualiza cache-busting de dashboard.js",
    )
    check(
        "/static/js/services.js?v=20260714_perf01" in template,
        "Template no actualiza cache-busting de services.js",
    )
    check(
        "_prepare_status_items" in scripts_source,
        "Endpoint no filtra/deduplica temprano",
    )
    controlled_reader = scripts_source.split(
        "def _controlled_stop_active_row", 1
    )[1].split("def _clear_controlled_stop", 1)[0]
    check(
        "CREATE TABLE" not in controlled_reader
        and "ALTER TABLE" not in controlled_reader,
        "GET de Automatizaciones conserva DDL por petición",
    )

    print("PERF01_CONTRACTS_OK")


if __name__ == "__main__":
    main()
