"""
scan_scheduler.py — Auditor IPs

Gestión del scheduler y de los jobs de scans.
Extraído de routers/scans.py para reducir acoplamiento sin tocar
el core delicado del motor de escaneo.
"""

from typing import Any, Callable

_scheduler_ref: Any = None


def set_scheduler(sched: Any) -> None:
    """Inyecta el scheduler compartido creado en main.py."""
    global _scheduler_ref
    _scheduler_ref = sched




def remove_job(job_id: str) -> None:
    """Elimina un job si existe; no falla si no está registrado."""
    if _scheduler_ref is None:
        return

    try:
        _scheduler_ref.remove_job(job_id)
    except Exception:
        pass

def register_secondary_scan_job(
    run_secondary_scan_with_ai: Callable[[], None],
    *,
    secondary: str,
    hours: int,
) -> None:
    """Registra/actualiza el job del scan secundario según config."""
    if _scheduler_ref is None:
        return

    try:
        _scheduler_ref.remove_job("secondary_scan")
    except Exception:
        pass

    if secondary == "none" or hours == 0:
        print("[scan] Job secundario deshabilitado")
        return

    _scheduler_ref.add_job(
        run_secondary_scan_with_ai,
        "interval",
        hours=hours,
        id="secondary_scan",
        replace_existing=True,
    )
    print(f"[scan] Job secundario ({secondary}) registrado cada {hours}h")


def register_auto_enrichment_job(
    run_auto_enrichment_scan: Callable[[], None],
    *,
    job_id: str,
    interval_minutes: int,
    batch_size: int,
) -> None:
    """Registra el job conservador de auto-enrichment."""
    if _scheduler_ref is None:
        return

    try:
        _scheduler_ref.remove_job(job_id)
    except Exception:
        pass

    _scheduler_ref.add_job(
        run_auto_enrichment_scan,
        "interval",
        minutes=interval_minutes,
        id=job_id,
        replace_existing=True,
        max_instances=1,
    )
    print(
        f"[scan] Job auto-enrichment registrado cada {interval_minutes}m "
        f"(batch={batch_size})"
    )


def register_nmap_complement_job(
    run_nmap_complement_scan: Callable[[], None],
) -> None:
    """Registra el job nmap complementario cada 2h."""
    if _scheduler_ref is None:
        return

    try:
        _scheduler_ref.remove_job("nmap_complement")
    except Exception:
        pass

    _scheduler_ref.add_job(
        run_nmap_complement_scan,
        "interval",
        hours=2,
        id="nmap_complement",
        replace_existing=True,
    )
    print("[scan] Job nmap complementario registrado (cada 2h)")


def _safe_iso(value: Any) -> str | None:
    """Convierte datetimes de APScheduler a ISO sin lanzar excepción."""
    try:
        return value.isoformat() if value else None
    except Exception:
        return None


def get_scheduler_health() -> dict[str, Any]:
    """
    Snapshot ligero del scheduler compartido.

    No ejecuta jobs ni consulta servicios remotos.
    Solo expone estado, número de jobs y próxima ejecución conocida.
    """
    if _scheduler_ref is None:
        return {
            "available": False,
            "state": "missing",
            "state_code": None,
            "job_count": 0,
            "jobs": [],
        }

    state_code = getattr(_scheduler_ref, "state", None)
    state_name = {
        0: "stopped",
        1: "running",
        2: "paused",
    }.get(state_code, "unknown")

    jobs = []
    try:
        raw_jobs = _scheduler_ref.get_jobs()
    except Exception as exc:
        return {
            "available": True,
            "state": state_name,
            "state_code": state_code,
            "job_count": 0,
            "jobs": [],
            "error": str(exc),
        }

    for job in raw_jobs:
        try:
            jobs.append({
                "id": str(getattr(job, "id", "") or ""),
                "name": str(getattr(job, "name", "") or ""),
                "trigger": str(getattr(job, "trigger", "") or ""),
                "next_run_time": _safe_iso(getattr(job, "next_run_time", None)),
            })
        except Exception:
            pass

    jobs.sort(key=lambda item: item.get("id") or "")

    return {
        "available": True,
        "state": state_name,
        "state_code": state_code,
        "job_count": len(jobs),
        "jobs": jobs,
    }
