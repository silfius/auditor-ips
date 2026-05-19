"""
device_enrichment.py — Auditor IPs
Helpers de clasificación y persistencia de enriquecimiento de dispositivo.

Este módulo concentra:
- clasificación heurística persistida
- clasificación enriquecida con fingerprint
- backfill conservador de clasificación

No ejecuta scans ni registra jobs.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import nullcontext
from typing import Any, Dict, List, Optional

from database import db
from host_classification import classify_host_device
from utils import utc_now_iso


def has_manual_fingerprint_source(source: Any) -> bool:
    return "fingerprint_manual" in str(source or "").lower()


def classify_with_fingerprint(
    host_row: Optional[sqlite3.Row],
    fp: Dict[str, Any],
    vendor_value: str,
    *,
    fingerprint_kind: str = "fingerprint_manual",
) -> Dict[str, Any]:
    host_view = dict(host_row) if host_row is not None else {}
    hostname = (fp.get("hostname") or "").strip()
    if hostname:
        host_view["nmap_hostname"] = hostname
    if vendor_value:
        host_view["vendor"] = vendor_value

    base = classify_host_device(host_view)
    try:
        base_conf = float(base.get("device_confidence") or 0.0)
    except Exception:
        base_conf = 0.0

    if base_conf >= 0.64 and (base.get("device_type") or "unknown") != "unknown":
        return base

    ports = {int(p) for p in fp.get("open_ports") or []}
    os_text = str(fp.get("os_guess") or "").lower()
    dtype_text = str(fp.get("device_type") or "").lower()

    best_category = "unknown"
    best_weight = 0.0
    evidences: List[Dict[str, Any]] = []

    def add_signal(category: str, weight: float, field: str, matched: str, reason: str) -> None:
        nonlocal best_category, best_weight
        evidences.append({
            "category": category,
            "kind": fingerprint_kind,
            "field": field,
            "value": matched,
            "matched": matched,
            "weight": round(weight, 2),
            "reason": reason,
        })
        if weight > best_weight:
            best_category = category
            best_weight = weight

    if 9100 in ports or 631 in ports or "printer" in dtype_text:
        add_signal(
            "printer",
            0.90,
            "ports",
            "631/9100",
            "puertos típicos de impresora detectados por fingerprint manual",
        )

    if "windows server" in os_text:
        add_signal(
            "server",
            0.88,
            "os_guess",
            fp.get("os_guess") or "windows server",
            "firma de SO indica Windows Server",
        )
    elif any(token in os_text for token in ["windows 11", "windows 10", "windows 8", "windows 7", "microsoft windows"]):
        add_signal(
            "computer",
            0.78,
            "os_guess",
            fp.get("os_guess") or "windows",
            "firma de SO compatible con equipo cliente Windows",
        )

    if {135, 139, 445} & ports:
        add_signal(
            "computer",
            0.66,
            "ports",
            ",".join(str(p) for p in sorted({135, 139, 445} & ports)),
            "puertos SMB/RPC típicos de PC Windows",
        )

    if 3389 in ports and "server" not in os_text:
        add_signal(
            "computer",
            0.62,
            "ports",
            "3389",
            "RDP expuesto, compatible con equipo Windows",
        )
    elif 3389 in ports:
        add_signal(
            "server",
            0.62,
            "ports",
            "3389",
            "RDP expuesto, compatible con servidor Windows",
        )

    if "general purpose" in dtype_text and best_weight < 0.60:
        add_signal(
            "computer",
            0.60,
            "nmap_device_type",
            fp.get("device_type") or "general purpose",
            "nmap reporta dispositivo de propósito general",
        )

    if best_category == "unknown":
        if fingerprint_kind == "fingerprint_auto":
            base = dict(base)
            base["device_source"] = "heuristic_v1+fingerprint_auto"
        return base

    classification = {
        "device_type": best_category,
        "device_confidence": round(best_weight, 2),
        "device_source": f"heuristic_v1+{fingerprint_kind}",
        "device_evidence": sorted(
            evidences,
            key=lambda item: item.get("weight", 0),
            reverse=True,
        )[:6],
    }
    return classification


def persist_device_classification(
    conn: sqlite3.Connection,
    ip: str,
    classification: Dict[str, Any],
    now_iso: str,
) -> None:
    evidence_json = json.dumps(classification.get("device_evidence") or [], ensure_ascii=False)
    conn.execute(
        """
        UPDATE hosts SET
            device_type=?,
            device_confidence=?,
            device_source=?,
            device_evidence=?,
            device_updated_at=?
        WHERE ip=?
        """,
        (
            classification.get("device_type") or "unknown",
            float(classification.get("device_confidence") or 0.0),
            classification.get("device_source") or "",
            evidence_json,
            now_iso,
            ip,
        ),
    )


def classify_and_persist_host(
    conn: sqlite3.Connection,
    ip: str,
    *,
    row: Optional[sqlite3.Row] = None,
    force: bool = False,
) -> bool:
    if row is None:
        row = conn.execute(
            """
            SELECT ip, mac, vendor, router_hostname, dns_name, nmap_hostname, ip_assignment,
                   device_type, device_confidence, device_source, device_evidence, device_updated_at
            FROM hosts WHERE ip=?
            """,
            (ip,),
        ).fetchone()
    if row is None:
        return False

    current_source = row["device_source"] or ""
    current_source_lc = str(current_source).lower()
    if not force and has_manual_fingerprint_source(current_source):
        return False

    classification = classify_host_device(dict(row))
    current_type = row["device_type"] or "unknown"
    current_conf = float(row["device_confidence"] or 0.0)
    current_evidence = str(row["device_evidence"] or "[]")

    new_type = classification.get("device_type") or "unknown"
    new_conf = float(classification.get("device_confidence") or 0.0)
    new_source = classification.get("device_source") or "heuristic_v1"
    new_source_lc = str(new_source).lower()
    new_evidence = json.dumps(classification.get("device_evidence") or [], ensure_ascii=False)

    # No degradar unknown ya probados con fingerprint_auto a heuristic_v1.
    # Si una pasada heurística posterior no mejora el resultado, preservamos
    # source/timestamp previos para que el backoff siga funcionando.
    if (
        not force
        and current_type == "unknown"
        and new_type == "unknown"
        and "fingerprint_auto" in current_source_lc
        and "fingerprint_auto" not in new_source_lc
        and new_conf <= current_conf + 0.0001
    ):
        return False

    if (
        not force
        and current_type == new_type
        and abs(current_conf - new_conf) < 0.0001
        and current_source == new_source
        and current_evidence == new_evidence
    ):
        return False

    persist_device_classification(conn, ip, classification, utc_now_iso())
    return True


def backfill_host_classification(
    *,
    force: bool = False,
    limit: Optional[int] = None,
    db_write_lock: Any = None,
) -> int:
    updated = 0
    lock_ctx = db_write_lock if db_write_lock is not None else nullcontext()

    with lock_ctx:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT ip, mac, vendor, router_hostname, dns_name, nmap_hostname, ip_assignment,
                       device_type, device_confidence, device_source, device_evidence, device_updated_at
                FROM hosts
                ORDER BY COALESCE(last_seen, first_seen, '') DESC, ip ASC
                """
            ).fetchall()
            for row in rows:
                if limit is not None and updated >= limit:
                    break
                if not force and has_manual_fingerprint_source(row["device_source"] or ""):
                    continue
                if classify_and_persist_host(conn, row["ip"], row=row, force=force):
                    updated += 1
    return updated
