"""
scan_enrichment_runners.py — Auditor IPs
Runners y selección de candidatos para fingerprint activo/auto-enrichment.

Este módulo no registra jobs ni decide scheduling.
Se limita a:
- ejecutar fingerprint manual/auto
- seleccionar candidatos de auto-enrichment
- ejecutar el ciclo conservador de auto-enrichment
"""

from __future__ import annotations

import sqlite3
import subprocess
from typing import Any, Callable, Dict, List, Tuple

from database import db
from device_enrichment import (
    has_manual_fingerprint_source,
    classify_with_fingerprint,
    persist_device_classification,
)
from fingerprint_utils import (
    derive_vendor_from_fingerprint,
    merge_fingerprint_parts,
    parse_fingerprint_output,
)
from utils import parse_iso, utc_now, utc_now_iso


def run_auto_fingerprint(ip: str) -> Dict[str, Any]:
    """
    Fingerprint automático conservador:
    - sin OS scan
    - pocos puertos top
    - budget corto para no interferir con el scan principal
    """
    cmd = [
        "nmap",
        "-n", "-Pn",
        "-sV", "--version-light",
        "--top-ports", "12",
        "--max-retries", "1",
        "--host-timeout", "12s",
        "--open",
        ip,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=18)
    return parse_fingerprint_output(result.stdout or "")


def select_auto_enrichment_candidates(
    conn: sqlite3.Connection,
    limit: int,
    *,
    auto_enrich_unknown_cooldown_minutes: int,
    auto_enrich_lowconf_cooldown_hours: int,
) -> List[str]:
    """
    Selecciona solo hosts online sin clasificar (device_type=unknown).

    Regla de backoff:
    - unknown "virgen" o solo heurístico -> cooldown corto en minutos
    - unknown que ya pasó por fingerprint_auto y siguió unknown -> cooldown largo
      reutilizando auto_enrich_lowconf_cooldown_hours por compatibilidad de firma
    """
    rows = conn.execute(
        """
        SELECT ip, status, last_seen, device_type, device_confidence, device_source, device_updated_at
        FROM hosts
        WHERE status='online'
        ORDER BY COALESCE(device_updated_at, ''), COALESCE(last_seen, '') DESC, ip ASC
        """
    ).fetchall()

    now_dt = utc_now()
    scored: List[Tuple[int, float, str]] = []

    retry_unknown_cooldown_minutes = max(
        auto_enrich_unknown_cooldown_minutes,
        auto_enrich_lowconf_cooldown_hours * 60,
    )

    for row in rows:
        source = str(row["device_source"] or "").strip()
        source_lc = source.lower()
        if has_manual_fingerprint_source(source):
            continue

        device_type = ((row["device_type"] or "unknown").strip().lower() or "unknown")
        if device_type != "unknown":
            continue

        updated_at = parse_iso(row["device_updated_at"]) if row["device_updated_at"] else None
        has_auto_attempt = "fingerprint_auto" in source_lc

        if updated_at:
            age_minutes = max(0.0, (now_dt - updated_at).total_seconds() / 60.0)
            cooldown_minutes = (
                retry_unknown_cooldown_minutes
                if has_auto_attempt
                else auto_enrich_unknown_cooldown_minutes
            )
            if age_minutes < cooldown_minutes:
                continue

        priority = 1 if has_auto_attempt else 0
        updated_sort = updated_at.timestamp() if updated_at else 0.0
        scored.append((priority, updated_sort, row["ip"]))

    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    return [ip for _, _, ip in scored[: max(1, limit)]]


def run_auto_enrichment_scan(
    *,
    auto_enrichment_lock: Any,
    db_write_lock: Any,
    nmap_complement_lock: Any,
    auto_enrich_batch_size: int,
    auto_enrich_unknown_cooldown_minutes: int,
    auto_enrich_lowconf_cooldown_hours: int,
    oui_lookup_fn: Callable[[str], str],
) -> None:
    """
    Reintento conservador en segundo plano para hosts online que sigan en unknown.
    Procesa muy pocos hosts por ciclo, nunca pisa clasificaciones manuales y
    aplica un backoff más largo a unknown que ya fueron probados con
    fingerprint_auto sin mejora.
    """
    if auto_enrichment_lock.is_set():
        return
    if db_write_lock.locked() or nmap_complement_lock.is_set():
        return

    auto_enrichment_lock.set()
    processed = 0
    improved = 0

    try:
        with db() as conn:
            candidates = select_auto_enrichment_candidates(
                conn,
                auto_enrich_batch_size,
                auto_enrich_unknown_cooldown_minutes=auto_enrich_unknown_cooldown_minutes,
                auto_enrich_lowconf_cooldown_hours=auto_enrich_lowconf_cooldown_hours,
            )

        if not candidates:
            return

        for ip in candidates:
            if db_write_lock.locked() or nmap_complement_lock.is_set():
                break

            try:
                fp = run_auto_fingerprint(ip)
            except subprocess.TimeoutExpired:
                fp = parse_fingerprint_output("")
            except Exception as e:
                print(f"[device_auto] Error fingerprint {ip}: {e}")
                continue

            with db() as conn:
                row = conn.execute(
                    """
                    SELECT ip, mac, vendor, router_hostname, dns_name, nmap_hostname,
                           ip_assignment, status, device_type, device_confidence,
                           device_source, device_evidence, device_updated_at
                    FROM hosts WHERE ip=?
                    """,
                    (ip,),
                ).fetchone()

            if row is None or (row["status"] or "") != "online":
                continue
            if has_manual_fingerprint_source(row["device_source"] or ""):
                continue

            current_vendor, new_vendor, hostname = derive_vendor_from_fingerprint(row, fp, oui_lookup_fn)
            classification = classify_with_fingerprint(
                row,
                fp,
                new_vendor or current_vendor or "",
                fingerprint_kind="fingerprint_auto",
            )
            now_iso = utc_now_iso()

            with db_write_lock:
                with db() as conn:
                    latest = conn.execute(
                        """
                        SELECT ip, status, vendor, nmap_hostname, device_type, device_confidence, device_source
                        FROM hosts WHERE ip=?
                        """,
                        (ip,),
                    ).fetchone()
                    if latest is None or (latest["status"] or "") != "online":
                        continue
                    if has_manual_fingerprint_source(latest["device_source"] or ""):
                        continue

                    if new_vendor and new_vendor != (latest["vendor"] or ""):
                        conn.execute("UPDATE hosts SET vendor=? WHERE ip=?", (new_vendor, ip))
                    if hostname and hostname != (latest["nmap_hostname"] or ""):
                        conn.execute("UPDATE hosts SET nmap_hostname=? WHERE ip=?", (hostname, ip))

                    prev_type = latest["device_type"] or "unknown"
                    prev_conf = float(latest["device_confidence"] or 0.0)
                    persist_device_classification(conn, ip, classification, now_iso)

                    new_type = classification.get("device_type") or "unknown"
                    new_conf = float(classification.get("device_confidence") or 0.0)
                    if new_type != prev_type or new_conf > prev_conf + 0.05:
                        improved += 1

            processed += 1

        if processed:
            print(f"[device_auto] Enriquecimiento conservador: {processed} host(s), mejorados={improved}")
    finally:
        auto_enrichment_lock.clear()


def run_manual_fingerprint(ip: str) -> Tuple[Dict[str, Any], bool]:
    """
    Fingerprint manual interactivo y conservador:
    1) pasada rápida de servicios/puertos
    2) pasada corta de SO solo si la primera no ha agotado el presupuesto
    """
    cmd_fast = [
        "nmap",
        "-n", "-Pn",
        "-sV", "--version-light",
        "--top-ports", "20",
        "--max-retries", "1",
        "--host-timeout", "18s",
        "--open",
        ip,
    ]
    fast = subprocess.run(cmd_fast, capture_output=True, text=True, timeout=25)
    fp = parse_fingerprint_output(fast.stdout or "")

    os_completed = False
    try:
        cmd_os = [
            "nmap",
            "-n", "-Pn",
            "-O", "--osscan-limit",
            "--max-retries", "1",
            "--host-timeout", "12s",
            ip,
        ]
        os_scan = subprocess.run(cmd_os, capture_output=True, text=True, timeout=15)
        fp = merge_fingerprint_parts(fp, parse_fingerprint_output(os_scan.stdout or ""))
        os_completed = True
    except subprocess.TimeoutExpired:
        pass

    return fp, os_completed
