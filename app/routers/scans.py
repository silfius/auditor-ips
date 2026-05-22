"""
routers/scans.py — Auditor IPs
Motor de escaneo nmap, helpers de red, notificaciones Discord/Push,
OUI lookup, fingerprinting y endpoints de scans.

Este es el router más pesado — concentra toda la lógica de escaneo.
"""

import base64
import concurrent.futures as _cf
import ipaddress
import json
import re
import sqlite3
import sys
import subprocess
import threading
import time
import urllib.request
from datetime import timedelta, timezone, datetime
from typing import Any, Dict, List, Optional, Tuple

import dns.resolver
import dns.reversename
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from config import cfg, DB_PATH, SCAN_CIDR, RETENTION_DAYS, WOL_PORT
from database import db, purge_old_scans
from routers.discovery import (
    get_discovery_scan_jobs,
    get_discovery_source,
    get_secondary_discovery_networks,
)
from utils import (
    utc_now, utc_now_iso, parse_iso, to_local_str, human_since,
    normalize_mac, compute_broadcast_from_cidr, send_wol, parse_cidr_list,
)
from fingerprint_utils import (
    fingerprint_port_clues,
)
from device_enrichment import (
    classify_and_persist_host,
    backfill_host_classification as _backfill_host_classification,
    classify_with_fingerprint as _classify_with_fingerprint,
    persist_device_classification as _persist_device_classification,
)
from scan_enrichment_runners import (
    run_auto_fingerprint as _run_auto_fingerprint_impl,
    select_auto_enrichment_candidates as _select_auto_enrichment_candidates_impl,
    run_auto_enrichment_scan as _run_auto_enrichment_scan_impl,
    run_manual_fingerprint as _run_manual_fingerprint_impl,
)
from scan_scheduler import (
    set_scheduler as _scheduler_set_scheduler,
    remove_job as _scheduler_remove_job,
    register_secondary_scan_job as _scheduler_register_secondary_scan_job,
    register_auto_enrichment_job as _scheduler_register_auto_enrichment_job,
    register_nmap_complement_job as _scheduler_register_nmap_complement_job,
)
from scan_discovery import (
    RouterData,
    fetch_router_data,
    resolve_ptr,
    get_local_ips_in_cidr,
    auto_detect_interface,
    run_nmap_ping_sweep,
    parse_nmap,
    read_arp_cache,
)

router = APIRouter()

# ── Locks compartidos ────────────────────────────────────────
_scan_running   = threading.Event()
_db_write_lock  = threading.Lock()   # también usado por quality.py via setter
_auto_enrichment_lock = threading.Event()

_AUTO_ENRICH_JOB_ID = "device_auto_enrichment"
_AUTO_ENRICH_INTERVAL_MINUTES = 45
_AUTO_ENRICH_BATCH_SIZE = 2
_AUTO_ENRICH_UNKNOWN_COOLDOWN_MINUTES = 90
_AUTO_ENRICH_LOWCONF_COOLDOWN_HOURS = 24


def get_db_write_lock() -> threading.Lock:
    return _db_write_lock


def is_scan_running() -> bool:
    return _scan_running.is_set()


def run_scan_guarded(cidr_raw: str) -> Dict[str, Any]:
    if _scan_running.is_set():
        return {"ok": False, "warning": "scan_already_running", "aborted": True}
    _scan_running.set()
    try:
        return run_scan(cidr_raw)
    finally:
        _scan_running.clear()


# Scheduler se inyecta desde main.py

def _should_run_nmap_complement_job() -> bool:
    return (
        cfg("router_enabled", "0") == "1"
        and cfg("scan_primary_source", "router") != "router"
    )


def reconfigure_scan_jobs() -> None:
    """Reaplica todos los jobs relacionados con scans según la config actual."""
    register_secondary_scan_job()
    register_auto_enrichment_job()

    if _should_run_nmap_complement_job():
        register_nmap_complement_job()
    else:
        _scheduler_remove_job("nmap_complement")


def set_scheduler(sched: Any) -> None:
    _scheduler_set_scheduler(sched)
    # Registrar jobs al arrancar
    reconfigure_scan_jobs()


# ══════════════════════════════════════════════════════════════
#  Discord + Push notifications
# ══════════════════════════════════════════════════════════════

def discord_webhook_for_channel(channel: str = "alerts") -> str:
    """
    Devuelve el webhook Discord efectivo para un canal lógico.

    Compatibilidad:
    - discord_webhook_alerts tiene prioridad para alertas.
    - discord_webhook se mantiene como fallback legacy de alertas.
    - discord_webhook_info se usa para informativos.
    - discord_info_fallback_to_alerts permite que info caiga en alertas si se desea.
    """
    ch = str(channel or "alerts").strip().lower()
    legacy = str(cfg("discord_webhook", "") or "").strip()
    alerts = str(cfg("discord_webhook_alerts", "") or "").strip()
    info = str(cfg("discord_webhook_info", "") or "").strip()

    if ch in ("info", "informative", "informativo"):
        if info:
            return info
        if str(cfg("discord_info_fallback_to_alerts", "0") or "0") == "1":
            return alerts or legacy
        return ""

    return alerts or legacy


def discord_notify(message: str, channel: str = "alerts") -> Tuple[bool, str]:
    webhook = discord_webhook_for_channel(channel)
    if not webhook:
        return False, f"No hay discord webhook configurado para canal {channel or 'alerts'}"
    payload = {"content": message[:1900]}
    data    = json.dumps(payload).encode("utf-8")
    req     = urllib.request.Request(
        webhook, data=data,
        headers={"Content-Type": "application/json", "User-Agent": "Auditor-IPs/1.0"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=8).read()
        return True, ""
    except Exception as e:
        return False, repr(e)


def _vapid_jwt(endpoint: str, vapid_pub: str, vapid_priv_b64: str) -> Optional[str]:
    import time as _t, tempfile, os
    try:
        origin = "/".join(endpoint.split("/")[:3])
        def b64u(b: bytes) -> str:
            return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
        hdr = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
        pay = b64u(json.dumps({
            "aud": origin,
            "exp": int(_t.time()) + 86400,
            "sub": "mailto:admin@auditor.local",
        }).encode())
        signing_input = f"{hdr}.{pay}".encode()
        priv_bytes = base64.urlsafe_b64decode(vapid_priv_b64 + "==")[-32:]
        pub_bytes  = base64.urlsafe_b64decode(vapid_pub + "==")[-65:]
        with tempfile.TemporaryDirectory() as tmp:
            der_path = os.path.join(tmp, "k.der")
            pem_path = os.path.join(tmp, "k.pem")
            sec1 = (bytes([0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20]) + priv_bytes +
                    bytes([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
                           0xa1, 0x44, 0x03, 0x42]) + pub_bytes)
            with open(der_path, "wb") as f:
                f.write(sec1)
            r1 = subprocess.run(["openssl", "ec", "-inform", "DER", "-in", der_path, "-out", pem_path],
                                capture_output=True)
            if r1.returncode != 0:
                return None
            r2 = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem_path],
                                input=signing_input, capture_output=True)
            if r2.returncode != 0:
                return None
            der = r2.stdout
            i     = 2
            r_len = der[i + 1]; r_raw = der[i + 2:i + 2 + r_len][-32:].rjust(32, b"\x00"); i += 2 + r_len
            s_len = der[i + 1]; s_raw = der[i + 2:i + 2 + s_len][-32:].rjust(32, b"\x00")
            sig = b64u(r_raw + s_raw)
        return f"{hdr}.{pay}.{sig}"
    except Exception as e:
        print(f"[VAPID] JWT build error: {e}")
        return None


def send_push_notification(title: str, body: str, icon: str = "/static/icon-192.png") -> int:
    with db() as conn:
        subs = conn.execute("SELECT endpoint, p256dh, auth FROM push_subscriptions").fetchall()
    if not subs:
        return 0
    vapid_pub  = cfg("vapid_public_key",  "")
    vapid_priv = cfg("vapid_private_key", "")
    payload_bytes = json.dumps({"title": title, "body": body, "icon": icon}).encode()
    sent = 0
    dead: List[str] = []
    for sub in subs:
        try:
            headers: Dict[str, str] = {"Content-Type": "application/json", "TTL": "86400"}
            if vapid_pub and vapid_priv:
                token = _vapid_jwt(sub["endpoint"], vapid_pub, vapid_priv)
                if token:
                    headers["Authorization"] = f"vapid t={token},k={vapid_pub}"
            req = urllib.request.Request(
                sub["endpoint"], data=payload_bytes, headers=headers, method="POST"
            )
            urllib.request.urlopen(req, timeout=8)
            sent += 1
        except Exception:
            dead.append(sub["endpoint"])
    if dead:
        with db() as conn:
            for ep in dead:
                conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (ep,))
    return sent


# ══════════════════════════════════════════════════════════════
#  OUI lookup
# ══════════════════════════════════════════════════════════════

_OUI_TABLE: Dict[str, str] = {
    "00:00:0C": "Cisco","00:00:5E": "IANA/Cisco","00:01:42": "Cisco",
    "00:0C:29": "VMware","00:50:56": "VMware","00:15:5D": "Microsoft Hyper-V",
    "00:1A:7D": "Apple","00:1B:63": "Apple","00:1C:B3": "Apple","00:1D:4F": "Apple",
    "00:1E:52": "Apple","00:1E:C2": "Apple","00:1F:5B": "Apple","00:1F:F3": "Apple",
    "00:21:E9": "Apple","00:22:41": "Apple","00:23:12": "Apple","00:23:32": "Apple",
    "00:23:6C": "Apple","00:24:36": "Apple","00:25:00": "Apple","00:25:4B": "Apple",
    "00:25:BC": "Apple","00:26:08": "Apple","00:26:B0": "Apple","00:26:BB": "Apple",
    "00:17:F2": "Apple","00:03:93": "Apple","00:0A:27": "Apple","00:0A:95": "Apple",
    "00:0D:93": "Apple","00:11:24": "Apple","00:14:51": "Apple","00:16:CB": "Apple",
    "00:19:E3": "Apple","AC:BC:32": "Apple","A4:5E:60": "Apple","F0:DB:F8": "Apple",
    "D0:23:DB": "Apple","78:7B:8A": "Apple","54:33:CB": "Apple","B8:78:2E": "Apple",
    "8C:85:90": "Apple","70:56:81": "Apple","60:F8:1D": "Apple","F4:F1:5A": "Apple",
    "3C:06:30": "Apple","90:B0:ED": "Apple","A8:BE:27": "Apple",
    "00:1A:11": "Google","3C:5A:B4": "Google","F4:F5:D8": "Google","54:60:09": "Google",
    "1C:F2:9A": "Google","48:D6:D5": "Google","94:EB:2C": "Google",
    "18:B4:30": "Nest","64:16:66": "Nest",
    "00:17:88": "Philips Hue","EC:B5:FA": "Philips Hue",
    "B4:E6:2D": "Raspberry Pi","DC:A6:32": "Raspberry Pi","E4:5F:01": "Raspberry Pi",
    "28:CD:C1": "Raspberry Pi","D8:3A:DD": "Raspberry Pi",
    "B8:27:EB": "Raspberry Pi","2C:CF:67": "Raspberry Pi",
    "00:0F:00": "Intel","00:02:B3": "Intel","00:03:47": "Intel","00:04:23": "Intel",
    "00:07:E9": "Intel","00:0C:F1": "Intel","00:11:11": "Intel","00:12:F0": "Intel",
    "00:13:02": "Intel","00:13:CE": "Intel","00:13:E8": "Intel","00:15:17": "Intel",
    "00:16:76": "Intel","00:16:EA": "Intel","00:19:D1": "Intel","00:1B:21": "Intel",
    "00:1C:BF": "Intel","00:1D:E0": "Intel","00:1E:64": "Intel","00:1E:65": "Intel",
    "00:1F:3B": "Intel","00:1F:3C": "Intel","00:21:5C": "Intel","00:21:5D": "Intel",
    "00:22:FB": "Intel","00:23:14": "Intel","00:24:D6": "Intel","00:24:D7": "Intel",
    "00:27:10": "Intel",
    "00:14:22": "Dell","00:21:70": "Dell","14:18:77": "Dell","18:03:73": "Dell",
    "24:B6:FD": "Dell","34:17:EB": "Dell","44:A8:42": "Dell","54:9F:35": "Dell",
    "00:08:74": "Dell","00:0B:DB": "Dell","00:0D:56": "Dell","00:11:43": "Dell",
    "00:12:3F": "Dell","00:13:72": "Dell","00:15:C5": "Dell","00:16:F0": "Dell",
    "00:18:8B": "Dell","00:19:B9": "Dell","00:1A:A0": "Dell","00:1C:23": "Dell",
    "00:1D:09": "Dell","00:1E:4F": "Dell",
    "00:25:64": "HP","3C:D9:2B": "HP","00:1B:78": "HP","00:21:5A": "HP",
    "3C:A8:2A": "HP","94:57:A5": "HP","98:E7:F4": "HP","B4:99:BA": "HP",
    "FC:15:B4": "HP","C8:CB:9E": "HP",
    "F0:2F:74": "Huawei","00:18:82": "Huawei","00:25:68": "Huawei","00:46:4B": "Huawei",
    "04:F9:38": "Huawei","08:19:A6": "Huawei","0C:37:DC": "Huawei","10:47:80": "Huawei",
    "20:F3:A3": "Huawei","28:31:52": "Huawei","2C:AB:00": "Huawei","34:CD:BE": "Huawei",
    "40:4D:8E": "Huawei","48:46:FB": "Huawei","4C:54:99": "Huawei","54:89:98": "Huawei",
    "54:A5:1B": "Huawei","5C:C3:07": "Huawei","68:89:C1": "Huawei","6C:8D:C1": "Huawei",
    "70:72:CF": "Huawei","74:A5:28": "Huawei","78:1D:BA": "Huawei","80:71:7A": "Huawei",
    "84:A9:C4": "Huawei","88:E3:AB": "Huawei","9C:28:EF": "Huawei","A8:CA:7B": "Huawei",
    "AC:E2:15": "Huawei","B4:15:13": "Huawei","BC:76:70": "Huawei","CC:53:B5": "Huawei",
    "D0:7A:B5": "Huawei","DC:D2:FC": "Huawei","E0:19:54": "Huawei","E4:68:A3": "Huawei",
    "E8:CD:2D": "Huawei","EC:23:3D": "Huawei","F4:55:9C": "Huawei","F4:8E:38": "Huawei",
    "F8:98:B9": "Huawei",
    "00:13:46": "Samsung","00:15:B9": "Samsung","00:16:32": "Samsung","00:17:C9": "Samsung",
    "00:17:D5": "Samsung","00:18:AF": "Samsung","00:1A:8A": "Samsung","00:1B:98": "Samsung",
    "00:1C:43": "Samsung","00:1D:25": "Samsung","00:1E:7D": "Samsung","00:1F:CC": "Samsung",
    "00:21:19": "Samsung","00:21:4C": "Samsung","00:23:39": "Samsung","00:24:54": "Samsung",
    "00:24:90": "Samsung","00:24:91": "Samsung","00:25:38": "Samsung","00:26:37": "Samsung",
    "38:AA:3C": "Samsung","3C:8B:FE": "Samsung","40:0E:85": "Samsung","50:01:BB": "Samsung",
    "54:88:0E": "Samsung","5C:49:79": "Samsung","60:6B:BD": "Samsung","78:25:AD": "Samsung",
    "84:25:DB": "Samsung","8C:77:12": "Samsung","90:18:7C": "Samsung","94:35:0A": "Samsung",
    "A0:07:98": "Samsung","A8:06:00": "Samsung","B0:D0:9C": "Samsung","BC:14:85": "Samsung",
    "C8:14:79": "Samsung","CC:07:AB": "Samsung","D0:17:6A": "Samsung","D4:88:90": "Samsung",
    "E4:40:E2": "Samsung","E8:50:8B": "Samsung","F0:25:B7": "Samsung","F4:09:D8": "Samsung",
    "F8:04:2E": "Samsung","FC:A1:3E": "Samsung",
    "00:0C:E7": "Xiaomi","00:9E:C8": "Xiaomi","04:CF:8C": "Xiaomi","0C:1D:AF": "Xiaomi",
    "10:2A:B3": "Xiaomi","14:F6:5A": "Xiaomi","18:59:36": "Xiaomi","20:82:C0": "Xiaomi",
    "28:6C:07": "Xiaomi","34:80:B3": "Xiaomi","38:A4:ED": "Xiaomi","3C:BD:D8": "Xiaomi",
    "50:64:2B": "Xiaomi","50:8F:4C": "Xiaomi","58:44:98": "Xiaomi","5C:E8:EB": "Xiaomi",
    "64:09:80": "Xiaomi","64:B4:73": "Xiaomi","68:DF:DD": "Xiaomi","6C:40:08": "Xiaomi",
    "74:23:44": "Xiaomi","78:11:DC": "Xiaomi","78:02:F8": "Xiaomi","7C:1D:D9": "Xiaomi",
    "8C:BE:BE": "Xiaomi","98:FA:E3": "Xiaomi","9C:99:A0": "Xiaomi","A4:50:46": "Xiaomi",
    "AC:F7:F3": "Xiaomi","B0:E2:35": "Xiaomi","C4:0B:CB": "Xiaomi","C8:47:8C": "Xiaomi",
    "CC:2D:E0": "Xiaomi","D4:97:0B": "Xiaomi","E4:46:DA": "Xiaomi","F4:8B:32": "Xiaomi",
    "F8:A4:5F": "Xiaomi","FC:64:BA": "Xiaomi",
    "00:90:4C": "Epson","08:CC:68": "Epson",
    "00:09:5B": "Netgear","00:14:6C": "Netgear","00:18:4D": "Netgear","00:1B:2F": "Netgear",
    "00:1E:2A": "Netgear","00:1F:33": "Netgear","00:22:3F": "Netgear","00:24:B2": "Netgear",
    "00:26:F2": "Netgear","04:A1:51": "Netgear","10:0D:7F": "Netgear","20:4E:7F": "Netgear",
    "2C:B0:5D": "Netgear","30:46:9A": "Netgear","44:94:FC": "Netgear","6C:B0:CE": "Netgear",
    "84:1B:5E": "Netgear","A0:21:B7": "Netgear","C0:3F:0E": "Netgear","E0:46:9A": "Netgear",
    "E4:F4:C6": "Netgear",
    "00:1D:7E": "Cisco Linksys","00:21:29": "Cisco Linksys","00:22:6B": "Cisco Linksys",
    "00:23:69": "Cisco Linksys","00:25:9C": "Cisco Linksys","C0:C1:C0": "Cisco Linksys",
    "00:18:E7": "TP-Link","00:1D:0F": "TP-Link","00:23:CD": "TP-Link","00:27:19": "TP-Link",
    "14:CC:20": "TP-Link","18:A6:F7": "TP-Link","1C:61:B4": "TP-Link","20:DC:E6": "TP-Link",
    "24:69:68": "TP-Link","28:28:5D": "TP-Link","2C:4D:54": "TP-Link","30:B5:C2": "TP-Link",
    "30:DE:4B": "TP-Link","38:2C:4A": "TP-Link","3C:46:D8": "TP-Link","40:16:7E": "TP-Link",
    "40:3F:8C": "TP-Link","44:33:4C": "TP-Link","50:C7:BF": "TP-Link","54:AF:97": "TP-Link",
    "60:E3:27": "TP-Link",
    "00:08:9B": "QNAP","24:5E:BE": "QNAP","08:9E:01": "QNAP","0C:9D:92": "QNAP",
    "00:1C:C0": "Sonos","34:7E:5C": "Sonos","48:A6:B8": "Sonos","58:27:8C": "Sonos",
    "5C:AA:FD": "Sonos","78:28:CA": "Sonos","94:9F:3E": "Sonos","B8:E9:37": "Sonos",
    "90:FD:61": "Tuya Smart","7C:87:CE": "Tuya Smart",
    "18:FE:34": "Espressif","24:6F:28": "Espressif","30:AE:A4": "Espressif",
    "3C:61:05": "Espressif","3C:71:BF": "Espressif","40:F5:20": "Espressif",
    "48:3F:DA": "Espressif","4C:11:AE": "Espressif","54:32:04": "Espressif",
    "60:01:94": "Espressif","68:C6:3A": "Espressif","70:03:9F": "Espressif",
    "7C:9E:BD": "Espressif","80:7D:3A": "Espressif","84:0D:8E": "Espressif",
    "84:CC:A8": "Espressif","84:F3:EB": "Espressif","8C:AA:B5": "Espressif",
    "90:97:D5": "Espressif","94:B5:55": "Espressif","98:CD:AC": "Espressif",
    "A0:20:A6": "Espressif","A4:CF:12": "Espressif","AC:67:B2": "Espressif",
    "B4:8A:0A": "Espressif","BC:DD:C2": "Espressif","C8:2B:96": "Espressif",
    "CC:50:E3": "Espressif","D4:8A:FC": "Espressif","D8:A0:1D": "Espressif",
    "DC:4F:22": "Espressif","E0:98:06": "Espressif","E8:6B:EA": "Espressif",
    "EC:64:C9": "Espressif","F4:CF:A2": "Espressif","FC:F5:C4": "Espressif",
    "00:19:70": "Hikvision","28:57:BE": "Hikvision","44:19:B6": "Hikvision",
    "BC:AD:28": "Hikvision","C0:56:E3": "Hikvision","D4:74:BF": "Hikvision",
    "00:26:D4": "Axis","AC:CC:8E": "Axis","B8:A4:4F": "Axis","BC:47:60": "Axis",
}


def oui_lookup(mac: str) -> str:
    if not mac:
        return ""
    mac_upper = mac.upper().replace("-", ":").replace(".", ":")
    parts     = mac_upper.split(":")
    if len(parts) < 3:
        return ""
    return _OUI_TABLE.get(":".join(parts[:3]), "")


# ══════════════════════════════════════════════════════════════
#  Device classification helpers
# ══════════════════════════════════════════════════════════════


def backfill_host_classification(force: bool = False, limit: Optional[int] = None) -> int:
    return _backfill_host_classification(
        force=force,
        limit=limit,
        db_write_lock=_db_write_lock,
    )


# ══════════════════════════════════════════════════════════════
#  Scan core helpers
# ══════════════════════════════════════════════════════════════

def add_event(
    conn: sqlite3.Connection,
    ip: str, event_type: str,
    old: Optional[str], new: Optional[str],
) -> None:
    conn.execute(
        "INSERT INTO host_events (ip, at, event_type, old_value, new_value) VALUES (?,?,?,?,?)",
        (ip, utc_now_iso(), event_type, old, new),
    )


def record_availability_transition(
    conn: sqlite3.Connection,
    ip: str,
    old_status: Optional[str],
    new_status: Optional[str],
    at_iso: str,
) -> None:
    old_st = str(old_status or "").strip().lower() or "unknown"
    new_st = str(new_status or "").strip().lower() or "unknown"

    if old_st == new_st:
        return

    open_row = conn.execute(
        """
        SELECT id, status
        FROM host_availability_intervals
        WHERE ip = ? AND ended_at IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1
        """,
        (ip,),
    ).fetchone()

    if open_row:
        open_st = str(open_row["status"] or "").strip().lower() or "unknown"
        if open_st == new_st:
            return

        conn.execute(
            """
            UPDATE host_availability_intervals
            SET ended_at = ?
            WHERE id = ?
            """,
            (at_iso, open_row["id"]),
        )

    conn.execute(
        """
        INSERT INTO host_availability_intervals (ip, status, started_at, ended_at)
        VALUES (?, ?, ?, NULL)
        """,
        (ip, new_st, at_iso),
    )


def move_open_availability_interval_ip(
    conn: sqlite3.Connection,
    old_ip: str,
    new_ip: str,
) -> None:
    old_txt = str(old_ip or "").strip()
    new_txt = str(new_ip or "").strip()
    if not old_txt or not new_txt or old_txt == new_txt:
        return

    conn.execute(
        """
        UPDATE host_availability_intervals
        SET ip = ?
        WHERE ip = ? AND ended_at IS NULL
        """,
        (new_txt, old_txt),
    )


def compute_discord_events_by_channel(
    prev: Dict[str, Dict[str, Optional[str]]],
    current: Dict[str, Dict[str, Optional[str]]],
) -> Dict[str, List[str]]:
    """
    Separa eventos de red por canal lógico Discord.

    - info: cambios no críticos o de seguimiento.
    - alerts: incidencias que requieren atención.
    """
    new_hosts, offline_hosts, online_hosts, mac_changes, ip_changes = [], [], [], [], []

    for ip, cur in current.items():
        p = prev.get(ip)
        if p is None:
            if cfg("notify_new", "1") == "1":
                name = cur.get("name") or ip
                new_hosts.append(f"`{ip}` ({name}) MAC:`{cur.get('mac') or 'N/D'}`")
            continue
        if p.get("status") != cur.get("status"):
            label = cur.get("name") or ip
            if cur.get("status") == "offline" and cfg("notify_offline", "0") == "1":
                offline_hosts.append(f"`{ip}` {label}")
            if cur.get("status") == "online"  and cfg("notify_online",  "0") == "1":
                online_hosts.append(f"`{ip}` {label}")
        if cfg("notify_mac_change", "0") == "1" and p.get("mac") and cur.get("mac") and p["mac"] != cur["mac"]:
            mac_changes.append(f"`{ip}` `{p['mac']}` → `{cur['mac']}`")

    if cfg("notify_new", "1") == "1":
        for old_ip in prev:
            if old_ip not in current:
                old_mac   = prev[old_ip].get("mac")
                if old_mac:
                    new_entry = next((c for c in current.values() if c.get("mac") == old_mac), None)
                    if new_entry:
                        new_ip = next(k for k, v in current.items() if v is new_entry)
                        ip_changes.append(f"MAC `{old_mac}` · `{old_ip}` → `{new_ip}`")

    def _block(emoji: str, label: str, items: List[str]) -> str:
        lista = "\n".join(f"  • {x}" for x in items[:20])
        n     = len(items)
        return f"{emoji} **{n} {label}{'s' if n > 1 else ''}**\n{lista}"

    info_events: List[str] = []
    alert_events: List[str] = []

    if new_hosts:
        info_events.append(_block("🆕", "host nuevo", new_hosts))
    if online_hosts:
        info_events.append(_block("🟢", "host online", online_hosts))
    if mac_changes:
        info_events.append(_block("⚠️", "cambio de MAC", mac_changes))
    if ip_changes:
        info_events.append(_block("🔀", "cambio de IP", ip_changes))
    if offline_hosts:
        alert_events.append(_block("🔴", "host offline", offline_hosts))

    return {"info": info_events, "alerts": alert_events}


def compute_discord_events(
    prev: Dict[str, Dict[str, Optional[str]]],
    current: Dict[str, Dict[str, Optional[str]]],
) -> List[str]:
    grouped = compute_discord_events_by_channel(prev, current)
    return list(grouped.get("info") or []) + list(grouped.get("alerts") or [])


def evaluate_alerts(
    conn: sqlite3.Connection,
    prev: Dict[str, Dict],
    current: Dict[str, Dict],
    new_hosts_count: int,
) -> List[str]:
    now    = utc_now()
    alerts = conn.execute("""
        SELECT id, name, trigger_type, filter_mode, filter_value,
               action, cooldown_minutes, last_fired,
               COALESCE(min_down_minutes, 0) AS min_down_minutes
        FROM alerts WHERE enabled=1
    """).fetchall()

    messages: List[str] = []
    prev_macs = {v.get("mac") for v in prev.values() if v.get("mac")}

    def _norm_mac(value: Any) -> str:
        return str(value or "").strip().upper().replace("-", ":")

    for alert in alerts:
        aid, name, ttype = alert["id"], alert["name"], alert["trigger_type"]
        fmode, fvalue    = alert["filter_mode"], alert["filter_value"] or ""
        cooldown         = alert["cooldown_minutes"] or 0
        min_down         = alert["min_down_minutes"] or 0
        last_fired       = parse_iso(alert["last_fired"])

        if last_fired and cooldown > 0:
            if (now - last_fired).total_seconds() / 60 < cooldown:
                continue

        fired_ips: List[str] = []

        for ip, cur in current.items():
            p = prev.get(ip)
            if fmode == "ip" and fvalue and ip != fvalue:
                continue
            if fmode == "mac" and fvalue:
                target_mac = _norm_mac(fvalue)
                current_mac = _norm_mac(cur.get("mac"))
                previous_mac = _norm_mac(p.get("mac") if p else "")
                if target_mac not in {current_mac, previous_mac}:
                    continue
            if fmode == "type_id" and fvalue:
                host_row = conn.execute("SELECT type_id FROM hosts WHERE ip=?", (ip,)).fetchone()
                if not host_row or str(host_row["type_id"] or "") != fvalue:
                    continue

            if ttype == "new_host" and p is None:
                if cur.get("mac") and cur["mac"] in prev_macs: continue
                fired_ips.append(ip)
            elif ttype == "offline" and cur.get("status") == "offline":
                if p and p.get("status") != "offline": fired_ips.append(ip)
            elif ttype == "offline_for" and cur.get("status") == "offline":
                lc_str = cur.get("last_change") or ""
                try:
                    lc = datetime.fromisoformat(lc_str.replace("Z", "+00:00"))
                    if lc.tzinfo is None:
                        lc = lc.replace(tzinfo=timezone.utc)
                    offline_mins = (now - lc).total_seconds() / 60
                    if offline_mins >= max(min_down, 1):
                        fired_ips.append(f"{ip} ({int(offline_mins)}min offline)")
                except Exception:
                    pass
            elif ttype == "online" and cur.get("status") == "online":
                if p and p.get("status") != "online": fired_ips.append(ip)
            elif ttype == "status_change":
                if p and p.get("status") != cur.get("status"): fired_ips.append(ip)
            elif ttype == "mac_change":
                old_mac = p.get("mac") if p else None
                new_mac = cur.get("mac")
                if old_mac and new_mac and old_mac != new_mac:
                    fired_ips.append(f"{ip} {old_mac}→{new_mac}")

        if ttype == "ip_change":
            current_mac_to_ip = {
                _norm_mac(v.get("mac")): ip
                for ip, v in current.items()
                if _norm_mac(v.get("mac"))
            }
            for old_ip, old_data in prev.items():
                if old_ip in current:
                    continue
                old_mac = _norm_mac(old_data.get("mac"))
                if not old_mac:
                    continue
                new_ip = current_mac_to_ip.get(old_mac)
                if not new_ip or new_ip == old_ip:
                    continue
                if (
                    fmode == "all"
                    or (fmode == "ip" and fvalue == old_ip)
                    or (fmode == "mac" and _norm_mac(fvalue) == old_mac)
                ):
                    fired_ips.append(f"{old_ip}→{new_ip}")

        if not fired_ips:
            continue

        ips_str = ", ".join(f"`{x}`" for x in fired_ips[:10])
        if len(fired_ips) > 10:
            ips_str += f" (+{len(fired_ips)-10} más)"
        labels = {
            "new_host": "🆕 Nuevo host", "offline": "🔴 Offline",
            "online": "🟢 Online", "status_change": "🔄 Cambio estado",
            "ip_change": "🔀 Cambio de IP", "mac_change": "⚠️ Cambio de MAC",
            "offline_for": "🔴 Offline prolongado",
        }
        msg = f"🔔 **Alerta: {name}**\n{labels.get(ttype, ttype)}: {ips_str}"
        messages.append(msg)
        conn.execute("UPDATE alerts SET last_fired=? WHERE id=?", (now.isoformat(), aid))

    return messages


def accum_uptime(
    conn: sqlite3.Connection,
    prev: Dict[str, Dict],
    interval_started_at: str,
    interval_finished_at: str,
    app_tz_name: str = "Europe/Madrid",
) -> None:
    try:
        from utils import get_app_tz
        t_start = parse_iso(interval_started_at)
        t_end   = parse_iso(interval_finished_at)
        if not t_start or not t_end or t_end <= t_start:
            return

        app_tz = get_app_tz(app_tz_name)
        cursor = t_start

        while cursor < t_end:
            local_cursor = cursor.astimezone(app_tz)
            next_midnight_local = (local_cursor + timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            chunk_end = min(t_end, next_midnight_local.astimezone(t_end.tzinfo))
            chunk_secs = max(0, int((chunk_end - cursor).total_seconds()))
            if chunk_secs <= 0:
                break

            day_key = local_cursor.strftime("%Y-%m-%d")

            for ip, pdata in prev.items():
                status = str(pdata.get("status") or "").strip().lower()
                was_online = status in ("online", "online_silent")
                online_s   = chunk_secs if was_online else 0
                offline_s  = chunk_secs if not was_online else 0
                conn.execute("""
                    INSERT INTO host_uptime (ip, date, online_seconds, offline_seconds)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(ip, date) DO UPDATE SET
                        online_seconds  = online_seconds  + excluded.online_seconds,
                        offline_seconds = offline_seconds + excluded.offline_seconds
                """, (ip, day_key, online_s, offline_s))

            cursor = chunk_end
    except Exception as e:
        print(f"[uptime] Error: {e}")




def _merge_router_existing_host(
    conn: sqlite3.Connection,
    *,
    ip: str,
    mac: str,
    rhostname: str,
    assignment: str,
    lease_exp: Any,
    target_status: str,
    now: str,
    existing: sqlite3.Row,
) -> None:
    old_status = _effective_old_status(conn, ip, existing["status"])
    old_mac = existing["mac"] or ""
    status_changed = _availability_family(old_status) != _availability_family(target_status)
    mac_changed = bool(mac and old_mac != mac)

    if status_changed:
        add_event(conn, ip, "status", old_status, target_status)
        record_availability_transition(conn, ip, old_status, target_status, now)
        _remember_cycle_status(ip, target_status)
    if mac_changed and old_mac:
        add_event(conn, ip, "mac", old_mac, mac)

    conn.execute(
        """
        UPDATE hosts SET
            router_hostname    = ?,
            ip_assignment      = ?,
            dhcp_lease_expires = ?,
            router_seen        = 1,
            mac                = COALESCE(NULLIF(?,''), mac),
            last_seen          = ?,
            last_change        = CASE WHEN ? THEN ? ELSE last_change END,
            status             = ?
        WHERE ip=?
        """,
        (
            rhostname or None,
            assignment,
            lease_exp,
            mac,
            now,
            int(status_changed or mac_changed),
            now,
            target_status,
            ip,
        ),
    )
    if status_changed or mac_changed or (existing["router_hostname"] or "") != (rhostname or ""):
        classify_and_persist_host(conn, ip)


def _merge_router_mac_ip_reassignment(
    conn: sqlite3.Connection,
    *,
    ip: str,
    mac: str,
    rhostname: str,
    assignment: str,
    lease_exp: Any,
    target_status: str,
    now: str,
    mac_row: sqlite3.Row,
) -> None:
    old_ip = mac_row["ip"]
    add_event(conn, old_ip, "ip_change", old_ip, ip)
    move_open_availability_interval_ip(conn, old_ip, ip)
    conn.execute(
        """
        UPDATE hosts SET
            ip=?,
            router_hostname=?,
            ip_assignment=?,
            dhcp_lease_expires=?,
            router_seen=1,
            last_seen=?,
            last_change=?,
            status=?
        WHERE mac=? AND ip=?
        """,
        (ip, rhostname or None, assignment, lease_exp, now, now, target_status, mac, old_ip),
    )
    add_event(conn, ip, "ip_change_arrived", old_ip, ip)
    classify_and_persist_host(conn, ip)


def _merge_router_new_host(
    conn: sqlite3.Connection,
    *,
    ip: str,
    mac: str,
    rhostname: str,
    assignment: str,
    lease_exp: Any,
    target_status: str,
    now: str,
    default_type_id: Optional[int],
) -> int:
    vendor = oui_lookup(mac) if mac else ""
    conn.execute(
        """
        INSERT INTO hosts
            (ip, mac, nmap_hostname, dns_name, manual_name, notes, type_id,
             first_seen, last_seen, last_change, status, known, vendor,
             router_hostname, ip_assignment, dhcp_lease_expires, router_seen)
        VALUES (?,?,NULL,NULL,NULL,NULL,?,?,?,?,0,?,?,?,?,?,1)
        """,
        (
            ip,
            mac or None,
            default_type_id,
            now,
            now,
            now,
            target_status,
            vendor or None,
            rhostname or None,
            assignment,
            lease_exp,
        ),
    )
    add_event(
        conn,
        ip,
        "new" if target_status == "online" else "new_silent",
        None,
        f"mac={mac or 'N/D'} via_router",
    )
    record_availability_transition(conn, ip, None, target_status, now)
    classify_and_persist_host(conn, ip)
    return 1 if target_status == "online_silent" else 0

def _icmp_ping_once(ip: str, timeout_s: int = 1) -> bool:
    try:
        proc = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, int(timeout_s))), ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=max(2, int(timeout_s) + 1),
        )
        return proc.returncode == 0
    except Exception:
        return False



def _router_discovery_decision(ip: str, found_by_ip: Dict[str, Any], rdata: Dict[str, Any]) -> Dict[str, Any]:
    """
    Decide la validez de una señal de discovery procedente de nmap/router.

    Criterio conservador:
    - nmap confirma online.
    - el propio router se considera online.
    - router activo sin nmap confirma presencia, pero como online_silent.
    - DHCP/lease o señales inactivas no bastan para marcar online.
    """
    ip = str(ip or "").strip()
    presence_source = (rdata.get("router_presence_source") or "").strip()
    neigh_state = (rdata.get("neigh_state") or "").strip().upper()
    arp_flags = (rdata.get("arp_flags") or "").strip().lower()

    if ip in found_by_ip:
        return {
            "status": "online",
            "confidence": 100,
            "source": "nmap",
            "reason": "nmap_detected",
            "presence_source": presence_source,
            "neigh_state": neigh_state,
            "arp_flags": arp_flags,
        }

    if bool(rdata.get("router_self")):
        return {
            "status": "online",
            "confidence": 95,
            "source": "router_self",
            "reason": "router_management_ip",
            "presence_source": presence_source or "ssh:self",
            "neigh_state": neigh_state,
            "arp_flags": arp_flags,
        }

    if bool(rdata.get("router_active")):
        return {
            "status": "online_silent",
            "confidence": 75,
            "source": "router_active",
            "reason": presence_source or "router_active",
            "presence_source": presence_source,
            "neigh_state": neigh_state,
            "arp_flags": arp_flags,
        }

    return {
        "status": None,
        "confidence": 0,
        "source": "router_inactive",
        "reason": presence_source or "router_inactive_or_lease_only",
        "presence_source": presence_source,
        "neigh_state": neigh_state,
        "arp_flags": arp_flags,
    }

def _router_target_status(ip: str, found_by_ip: Dict[str, Any], rdata: Dict[str, Any]) -> Optional[str]:
    decision = _router_discovery_decision(ip, found_by_ip, rdata)
    status = decision.get("status")
    return str(status) if status else None

def merge_router_data(
    conn: sqlite3.Connection,
    found_by_ip: Dict[str, Any],
    router_data: Dict[str, RouterData],
    default_type_id: Optional[int],
) -> int:
    now = utc_now_iso()
    silent_new = 0
    history_rows: List[Tuple] = []

    found_ips = {str(ip).strip() for ip in found_by_ip.keys() if ip}
    router_ips = {str(ip).strip() for ip in router_data.keys() if ip}

    for raw_ip, rdata in router_data.items():
        ip = str(raw_ip).strip()
        mac = (rdata.get("mac") or "").strip().upper()
        rhostname = (rdata.get("router_hostname") or "").strip()
        assignment = (rdata.get("ip_assignment") or "").strip()
        lease_secs = rdata.get("dhcp_lease_secs")
        lease_exp = rdata.get("dhcp_lease_expires")
        target_status = _router_target_status(ip, found_by_ip, rdata)

        history_rows.append((ip, mac, now, rhostname, assignment, lease_secs))

        if not target_status:
            continue

        existing = conn.execute(
            "SELECT ip, status, mac, router_hostname FROM hosts WHERE ip=?", (ip,)
        ).fetchone()

        if existing:
            _merge_router_existing_host(
                conn,
                ip=ip,
                mac=mac,
                rhostname=rhostname,
                assignment=assignment,
                lease_exp=lease_exp,
                target_status=target_status,
                now=now,
                existing=existing,
            )
            continue

        mac_row = None
        if mac:
            mac_row = conn.execute(
                "SELECT ip FROM hosts WHERE mac=? AND ip!=?", (mac, ip)
            ).fetchone()

        if mac_row:
            _merge_router_mac_ip_reassignment(
                conn,
                ip=ip,
                mac=mac,
                rhostname=rhostname,
                assignment=assignment,
                lease_exp=lease_exp,
                target_status=target_status,
                now=now,
                mac_row=mac_row,
            )
            continue

        silent_new += _merge_router_new_host(
            conn,
            ip=ip,
            mac=mac,
            rhostname=rhostname,
            assignment=assignment,
            lease_exp=lease_exp,
            target_status=target_status,
            now=now,
            default_type_id=default_type_id,
        )

    for ip in found_ips:
        if ip not in router_ips:
            conn.execute("UPDATE hosts SET router_seen=0 WHERE ip=?", (ip,))

    if history_rows:
        conn.executemany(
            """
            INSERT INTO router_scan_history
                (ip, mac, scanned_at, router_hostname, ip_assignment, dhcp_lease_secs)
            VALUES (?,?,?,?,?,?)
            """,
            history_rows,
        )

    return silent_new

def _resolve_dns_background(ips: List[str]) -> None:
    """
    Resuelve PTR DNS para una lista de IPs en background (no bloquea el scan).
    Actualiza nmap_hostname y dns_name en BD cuando termina.
    """
    def _resolve_one(ip: str) -> tuple:
        try:
            name = resolve_ptr(ip)
            return (ip, name)
        except Exception:
            return (ip, None)

    with _cf.ThreadPoolExecutor(max_workers=16) as ex:
        results = list(ex.map(_resolve_one, ips))

    updates = [(name, name, ip) for ip, name in results if name]
    if not updates:
        return
    try:
        with _db_write_lock:
            with db() as conn:
                for dns_name, nmap_hostname, ip in updates:
                    conn.execute(
                        """UPDATE hosts SET
                               dns_name      = COALESCE(NULLIF(?,''), dns_name),
                               nmap_hostname = COALESCE(NULLIF(?,''), nmap_hostname)
                           WHERE ip=?""",
                        (dns_name, nmap_hostname, ip)
                    )
    except Exception as e:
        print(f"[dns_background] Error actualizando BD: {e}")



# ══════════════════════════════════════════════════════════════
#  Análisis IA post-verificación secundaria
# ══════════════════════════════════════════════════════════════

def _ai_analyze_discrepancies(discrepancies: list, context: dict) -> str:
    """
    Llama a la IA configurada para analizar las discrepancias detectadas.
    Devuelve el texto del informe en Markdown.
    """
    try:
        from config import cfg as _cfg
        provider = _cfg("ai_provider", "").lower()
        if not provider or provider == "none":
            return ""

        # Construir prompt estructurado
        disc_text = ""
        for d in discrepancies:
            disc_text += f"- IP: {d.get('ip','?')} | MAC: {d.get('mac','desconocida')} | "
            disc_text += f"Veces detectada: {d.get('times_seen',1)} | "
            disc_text += f"Primera vez: {d.get('first_seen','?')} | Última: {d.get('last_seen','?')}\n"

        known_hosts = context.get("known_hosts", 0)
        total_router = context.get("total_router", 0)
        cidr = context.get("cidr", "?")
        scan_time = context.get("scan_time", "?")

        prompt = f"""Eres un experto en seguridad de redes locales. Analiza las siguientes discrepancias
detectadas en una red doméstica/PYME y genera un informe conciso en español en formato Markdown.

## Contexto del escaneo
- Red analizada: {cidr}
- Hora del scan: {scan_time}
- Hosts conocidos en BD (detectados por router): {known_hosts}
- Hosts que ve el router: {total_router}
- Discrepancias encontradas (nmap ve, router NO): {len(discrepancies)}

## Discrepancias detectadas
{disc_text if disc_text else "Ninguna discrepancia encontrada en este scan."}

## Instrucciones para el informe
1. Para cada discrepancia, sugiere la causa más probable (dispositivo con IP estática, MAC aleatoria, intruso, falso positivo de ARP, etc.)
2. Indica el nivel de riesgo de cada una (Bajo / Medio / Alto)
3. Propón una acción concreta para cada caso
4. Si no hay discrepancias, confirma que la red parece limpia y da un resumen del estado
5. Sé directo y práctico, evita tecnicismos innecesarios
6. Formato: usa encabezados ##, listas, y negritas para destacar puntos clave
7. Máximo 400 palabras"""

        if provider == "gemini":
            import urllib.request, json as _json
            key   = _cfg("ai_gemini_key", "")
            model = _cfg("ai_gemini_model", "gemini-2.0-flash")
            if not key:
                return "_Sin API key de Gemini configurada._"
            url  = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            body = _json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
            req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = _json.loads(resp.read())
            return data["candidates"][0]["content"]["parts"][0]["text"]

        elif provider == "mistral":
            import urllib.request, json as _json
            key   = _cfg("ai_mistral_key", "")
            model = _cfg("ai_mistral_model", "mistral-small-latest")
            if not key:
                return "_Sin API key de Mistral configurada._"
            url  = "https://api.mistral.ai/v1/chat/completions"
            body = _json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 600}).encode()
            req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = _json.loads(resp.read())
            return data["choices"][0]["message"]["content"]

        elif provider == "ollama":
            import urllib.request, json as _json
            ollama_url = _cfg("ollama_url", "http://localhost:11434")
            model      = _cfg("ollama_model", "gemma2:2b")
            url  = f"{ollama_url}/api/generate"
            body = _json.dumps({"model": model, "prompt": prompt, "stream": False}).encode()
            req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = _json.loads(resp.read())
            return data.get("response", "")

    except Exception as e:
        return f"_Error al generar análisis IA: {e}_"
    return ""


def _run_auto_fingerprint(ip: str) -> Dict[str, Any]:
    return _run_auto_fingerprint_impl(ip)


def _select_auto_enrichment_candidates(conn: sqlite3.Connection, limit: int) -> List[str]:
    return _select_auto_enrichment_candidates_impl(
        conn,
        limit,
        auto_enrich_unknown_cooldown_minutes=_AUTO_ENRICH_UNKNOWN_COOLDOWN_MINUTES,
        auto_enrich_lowconf_cooldown_hours=_AUTO_ENRICH_LOWCONF_COOLDOWN_HOURS,
    )


def run_auto_enrichment_scan() -> None:
    return _run_auto_enrichment_scan_impl(
        auto_enrichment_lock=_auto_enrichment_lock,
        db_write_lock=_db_write_lock,
        nmap_complement_lock=_nmap_complement_lock,
        auto_enrich_batch_size=_AUTO_ENRICH_BATCH_SIZE,
        auto_enrich_unknown_cooldown_minutes=_AUTO_ENRICH_UNKNOWN_COOLDOWN_MINUTES,
        auto_enrich_lowconf_cooldown_hours=_AUTO_ENRICH_LOWCONF_COOLDOWN_HOURS,
        oui_lookup_fn=oui_lookup,
    )


def run_secondary_scan_with_ai() -> None:
    """
    Ejecuta el scan secundario (nmap o router según config) y si hay IA habilitada,
    genera un informe de discrepancias y lo guarda en BD.
    """
    secondary = cfg("scan_secondary_source", "none")
    if secondary == "none":
        return

    # Ejecutar el scan secundario
    if secondary == "nmap":
        run_nmap_complement_scan()
    elif secondary == "router":
        # Scan router como verificación (sin modificar estados)
        try:
            router_data, router_error = fetch_router_data()
            if router_data:
                cidr_raw = cfg("scan_cidr", SCAN_CIDR).split(",")[0].strip()
                import ipaddress as _ipa
                router_net = _ipa.ip_network(cidr_raw, strict=False)
                now = utc_now_iso()
                with _db_write_lock:
                    with db() as conn:
                        # Detectar hosts nmap que router no ve
                        nmap_hosts = conn.execute(
                            "SELECT ip, mac FROM hosts WHERE status='online' AND router_seen=0"
                        ).fetchall()
                        for h in nmap_hosts:
                            try:
                                if _ipa.ip_address(h["ip"]) not in router_net:
                                    continue
                            except ValueError:
                                continue
                            if h["ip"] in router_data:
                                continue
                            conn.execute("""
                                INSERT INTO scan_discrepancies (ip, mac, first_seen, last_seen, times_seen)
                                VALUES (?, ?, ?, ?, 1)
                                ON CONFLICT(ip) DO UPDATE SET
                                    last_seen=excluded.last_seen, times_seen=times_seen+1
                            """, (h["ip"], h["mac"], now, now))
        except Exception as e:
            print(f"[secondary_scan] Error router: {e}")

    # Si IA habilitada, generar informe
    if cfg("scan_secondary_ai", "0") != "1":
        return

    try:
        with db() as conn:
            disc_rows = conn.execute(
                "SELECT ip, mac, first_seen, last_seen, times_seen FROM scan_discrepancies WHERE accepted=0"
            ).fetchall()
            known_hosts = conn.execute("SELECT COUNT(*) c FROM hosts").fetchone()["c"]
            total_online = conn.execute("SELECT COUNT(*) c FROM hosts WHERE router_seen=1").fetchone()["c"]

        discs = [dict(r) for r in disc_rows]
        cidr  = cfg("scan_cidr", SCAN_CIDR).split(",")[0].strip()

        report_text = _ai_analyze_discrepancies(discs, {
            "known_hosts":  known_hosts,
            "total_router": total_online,
            "cidr":         cidr,
            "scan_time":    utc_now_iso(),
        })

        if report_text:
            with _db_write_lock:
                with db() as conn:
                    conn.execute("""
                        INSERT INTO scan_ai_reports
                            (generated_at, report_text, discrepancy_count, source)
                        VALUES (?, ?, ?, ?)
                    """, (utc_now_iso(), report_text, len(discs), secondary))
            print(f"[scan_ai] Informe generado ({len(discs)} discrepancias)")
    except Exception as e:
        print(f"[scan_ai] Error generando informe: {e}")


def register_secondary_scan_job() -> None:
    """Registra/actualiza el job del scan secundario según la config actual."""
    secondary = cfg("scan_secondary_source", "none")
    hours = int(cfg("scan_secondary_interval_h", "2") or "2")
    _scheduler_register_secondary_scan_job(
        run_secondary_scan_with_ai,
        secondary=secondary,
        hours=hours,
    )


def register_auto_enrichment_job() -> None:
    """Registra un job conservador para reclasificar hosts ambiguos sin intervención manual."""
    _scheduler_register_auto_enrichment_job(
        run_auto_enrichment_scan,
        job_id=_AUTO_ENRICH_JOB_ID,
        interval_minutes=_AUTO_ENRICH_INTERVAL_MINUTES,
        batch_size=_AUTO_ENRICH_BATCH_SIZE,
    )

# ══════════════════════════════════════════════════════════════
#  Motor de scan con Router como fuente primaria (Sesión 22)
# ══════════════════════════════════════════════════════════════

def _get_default_host_type_id(conn: sqlite3.Connection) -> Optional[int]:
    row = conn.execute(
        "SELECT id FROM host_types WHERE name='Por defecto' LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def _record_router_scan(
    conn: sqlite3.Connection,
    *,
    hosts_seen: int,
    silent_new: int,
    error: str,
) -> None:
    conn.execute(
        "INSERT INTO router_scans (scanned_at, hosts_seen, silent_new, error) VALUES (?,?,?,?)",
        (utc_now_iso(), hosts_seen, silent_new, error or ""),
    )


def _persist_latency_records(
    conn: sqlite3.Connection,
    latency_records: List[Tuple[str, str, float]],
) -> None:
    for ip_l, at_l, ms_l in latency_records:
        conn.execute(
            "INSERT INTO host_latency (ip, scanned_at, latency_ms) VALUES (?,?,?)",
            (ip_l, at_l, ms_l),
        )
        conn.execute("UPDATE hosts SET last_latency_ms=? WHERE ip=?", (ms_l, ip_l))

    lat_cutoff = (
        utc_now() - timedelta(days=int(cfg("retention_days", RETENTION_DAYS)))
    ).isoformat()
    conn.execute("DELETE FROM host_latency WHERE scanned_at < ?", (lat_cutoff,))


def _run_router_primary_scan(cidr: str, prev: Dict, default_type_id: Optional[int]) -> Dict[str, Any]:
    """
    Scan de la red principal usando el router SSH como fuente primaria.
    El router ve TODOS los dispositivos conectados (ARP + DHCP leases),
    incluso móviles con ICMP bloqueado o en power saving.
    
    nmap ya NO se ejecuta aquí — se hace cada 2h en un job separado
    únicamente para detectar hosts sin DHCP que el router no reporta.
    """
    started_at = utc_now_iso()
    now        = utc_now_iso()

    router_data, router_error = {}, ""
    try:
        router_data, router_error = fetch_router_data()
    except Exception as e:
        router_error = str(e)

    if not router_data and router_error:
        # Router no accesible — fallback a nmap para no perder visibilidad
        print(f"[scan] Router no accesible ({router_error}), usando nmap como fallback")
        return _run_scan_inner(cidr, "")

    new_hosts   = 0
    online_ips  = set()
    discovery_source_counts: Dict[str, int] = {}

    with db() as conn:
        arp_cache = read_arp_cache()

        for ip, rdata in router_data.items():
            mac        = rdata.get("mac") or arp_cache.get(ip) or ""
            rhostname  = rdata.get("router_hostname") or ""
            assignment = rdata.get("ip_assignment") or "dhcp"
            lease_exp  = rdata.get("dhcp_lease_expires")
            vendor     = oui_lookup(mac) if mac else ""

            decision = _router_discovery_decision(ip, {}, rdata)
            target_status = str(decision.get("status") or "")
            if not target_status:
                continue

            online_ips.add(ip)
            _src = str(decision.get("source") or "router").strip() or "router"
            discovery_source_counts[_src] = discovery_source_counts.get(_src, 0) + 1

            row = conn.execute(
                "SELECT ip, status, mac, router_hostname FROM hosts WHERE ip=?", (ip,)
            ).fetchone()

            if row is None:
                # ¿Cambio de IP? Buscar por MAC
                mac_row = conn.execute(
                    "SELECT ip FROM hosts WHERE mac=? AND ip!=?", (mac, ip)
                ).fetchone() if mac else None
                if mac_row:
                    old_ip = mac_row["ip"]
                    add_event(conn, old_ip, "ip_change", old_ip, ip)
                    move_open_availability_interval_ip(conn, old_ip, ip)
                    conn.execute("""
                        UPDATE hosts SET ip=?, router_hostname=?, last_seen=?,
                               last_change=?, status=?, router_seen=1
                        WHERE mac=? AND ip=?
                    """, (ip, rhostname or None, now, now, target_status, mac, old_ip))
                    add_event(conn, ip, "ip_change_arrived", old_ip, ip)
                    classify_and_persist_host(conn, ip)
                else:
                    new_hosts += 1
                    conn.execute("""
                        INSERT INTO hosts
                            (ip, mac, nmap_hostname, dns_name, manual_name, notes, type_id,
                             first_seen, last_seen, last_change, status, known, vendor,
                             router_hostname, ip_assignment, dhcp_lease_expires, router_seen)
                        VALUES (?,?,NULL,NULL,NULL,NULL,?,?,?,?,?,0,?,?,?,?,1)
                    """, (ip, mac or None, default_type_id, now, now, now, target_status,
                          vendor or None, rhostname or None, assignment, lease_exp))
                    add_event(conn, ip, "new", None, f"mac={mac or 'N/D'} via_router")
                    record_availability_transition(conn, ip, None, target_status, now)
                    classify_and_persist_host(conn, ip)
            else:
                old_status = _effective_old_status(conn, ip, row["status"])
                changed = _availability_family(old_status) != _availability_family(target_status)
                if changed:
                    add_event(conn, ip, "status", old_status, target_status)
                    record_availability_transition(conn, ip, old_status, target_status, now)
                    _remember_cycle_status(ip, target_status)
                if mac and (row["mac"] or "") != mac:
                    add_event(conn, ip, "mac", row["mac"], mac)
                    changed = True
                conn.execute("""
                    UPDATE hosts SET
                        mac=COALESCE(NULLIF(?,\'\'),mac),
                        router_hostname=?, ip_assignment=?,
                        dhcp_lease_expires=?, router_seen=1,
                        last_seen=?, last_change=CASE WHEN ? THEN ? ELSE last_change END,
                        status=?,
                        vendor=COALESCE(NULLIF(vendor,\'\'), NULLIF(?,\'\'))
                    WHERE ip=?
                """, (mac, rhostname or None, assignment, lease_exp,
                      now, int(changed), now, target_status, vendor or None, ip))
                if changed or (row["router_hostname"] or "") != (rhostname or ""):
                    classify_and_persist_host(conn, ip)

        # Registrar el scan del router
        _record_router_scan(
            conn,
            hosts_seen=len(router_data),
            silent_new=new_hosts,
            error=router_error,
        )

    return {
        "cidr":         cidr,
        "interface":    "",
        "online_hosts": len(online_ips),
        "new_hosts":    new_hosts,
        "started_at":   started_at,
        "finished_at":  utc_now_iso(),
        "router_error": router_error,
        "source":       "router",
        "discovery_sources": discovery_source_counts,
    }


# ── Job nmap complementario (cada 2h) — solo para red principal con router activo ──
_nmap_complement_lock = threading.Event()

def run_nmap_complement_scan() -> None:
    """
    Scan nmap de la red principal cada 2h cuando el router es la fuente primaria.
    Solo sirve para detectar hosts que nmap ve pero el router NO (hosts sin DHCP,
    IPs estáticas fuera del rango, etc.) y guardarlos en scan_discrepancies.
    NO modifica estados online/offline de hosts existentes.
    """
    if cfg("router_enabled", "0") != "1":
        return
    if _nmap_complement_lock.is_set():
        return  # ya hay uno corriendo
    _nmap_complement_lock.set()
    try:
        cidr_raw = cfg("scan_cidr", SCAN_CIDR).split(",")[0].strip()
        if not cidr_raw:
            return

        iface = cfg("primary_net_interface", "").strip() or auto_detect_interface(cidr_raw)
        out   = run_nmap_ping_sweep(cidr_raw, iface)
        found = parse_nmap(out)
        found_by_ip = {h["ip"]: h for h in found if h.get("ip")}
        # Inyectar IPs locales (nmap no se reporta a sí mismo)
        for local in get_local_ips_in_cidr(cidr_raw):
            lip = local["ip"]
            if lip not in found_by_ip:
                found_by_ip[lip] = local
        if not found_by_ip:
            return

        import ipaddress as _ipa
        now = utc_now_iso()
        try:
            router_net = _ipa.ip_network(cidr_raw, strict=False)
        except ValueError:
            return

        with _db_write_lock:
            with db() as conn:
                # Hosts que el router conoce (online o silent)
                router_known = {
                    r["ip"] for r in conn.execute(
                        "SELECT ip FROM hosts WHERE router_seen=1"
                    ).fetchall()
                }
                for nmap_ip, nmap_data in found_by_ip.items():
                    try:
                        if _ipa.ip_address(nmap_ip) not in router_net:
                            continue
                    except ValueError:
                        continue
                    if nmap_ip in router_known:
                        continue  # Router también lo conoce → OK, no es discrepancia
                    # Comprobar si ya fue aceptada
                    accepted = conn.execute(
                        "SELECT accepted FROM scan_discrepancies WHERE ip=?", (nmap_ip,)
                    ).fetchone()
                    if accepted and accepted["accepted"]:
                        continue
                    nmap_mac = nmap_data.get("mac") or ""
                    conn.execute("""
                        INSERT INTO scan_discrepancies (ip, mac, first_seen, last_seen, times_seen)
                        VALUES (?, ?, ?, ?, 1)
                        ON CONFLICT(ip) DO UPDATE SET
                            last_seen  = excluded.last_seen,
                            mac        = COALESCE(NULLIF(excluded.mac,''), mac),
                            times_seen = times_seen + 1
                    """, (nmap_ip, nmap_mac, now, now))
        print(f"[nmap_complement] Completado — {len(found_by_ip)} hosts encontrados")
    except Exception as e:
        print(f"[nmap_complement] Error: {e}")
    finally:
        _nmap_complement_lock.clear()


def register_nmap_complement_job() -> None:
    """Registra el job nmap complementario cada 2h en el scheduler."""
    _scheduler_register_nmap_complement_job(run_nmap_complement_scan)

# ══════════════════════════════════════════════════════════════
#  run_scan (multi-CIDR — Sesión 9)
# ══════════════════════════════════════════════════════════════


_SCAN_CYCLE_STATUS: Dict[str, str] = {}


def _host_offline_grace_seconds() -> int:
    """
    Tiempo de gracia antes de confirmar offline tras no ver un host.
    Evita falsos offline en móviles/IoT intermitentes sin aceptar señales débiles como online.
    """
    try:
        value = int(str(cfg("host_offline_grace_seconds", "600") or "600").strip())
    except Exception:
        value = 600
    return max(60, min(value, 86400))

def _availability_family(status: Any) -> str:
    s = str(status or "").strip().lower()
    if s in ("online", "online_silent"):
        return "online"
    if s == "offline":
        return "offline"
    return s

def _snapshot_old_status(ip: str, fallback: Any) -> str:
    status = _SCAN_CYCLE_STATUS.get(str(ip))
    if status not in (None, ""):
        return str(status)
    return str(fallback or "")

def _remember_cycle_status(ip: str, status: Any) -> None:
    _SCAN_CYCLE_STATUS[str(ip)] = str(status or "")


def _open_interval_status(conn: sqlite3.Connection, ip: str) -> str:
    row = conn.execute(
        """
        SELECT status
        FROM host_availability_intervals
        WHERE ip = ? AND ended_at IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1
        """,
        (ip,),
    ).fetchone()
    return str((row["status"] if row else "") or "").strip()


def _effective_old_status(conn: sqlite3.Connection, ip: str, fallback: Any) -> str:
    open_status = _open_interval_status(conn, ip)
    if open_status:
        return open_status
    return _snapshot_old_status(ip, fallback)


def _prepare_scan_cycle() -> Tuple[Dict[str, Dict[str, Any]], int, int]:
    with db() as conn:
        prev_rows = conn.execute(
            "SELECT ip, status, mac, COALESCE(router_seen,0) AS router_seen FROM hosts"
        ).fetchall()
        prev = {
            r["ip"]: {
                "status": r["status"],
                "mac": r["mac"],
                "router_seen": int(r["router_seen"] or 0),
            }
            for r in prev_rows
        }
        purged_scans = purge_old_scans(conn, int(cfg("retention_days", RETENTION_DAYS)))
        prev_online = sum(
            1 for v in prev.values() if v["status"] in ("online", "online_silent")
        )

        if get_discovery_source() == "schema":
            try:
                active_jobs = get_discovery_scan_jobs(active_only=True)
            except Exception:
                active_jobs = []
            has_router_jobs = any(
                (j.get("scanner_method") or "nmap") in ("router", "router+nmap")
                for j in active_jobs
            )
            if has_router_jobs:
                conn.execute("UPDATE hosts SET status='offline', router_seen=0")
            else:
                conn.execute("UPDATE hosts SET status='offline'")
            return prev, prev_online, purged_scans

        router_primary = (
            cfg("router_enabled", "0") == "1"
            and (cfg("scan_primary_source", "router") or "router").strip().lower() == "router"
        )
        if router_primary:
            conn.execute("UPDATE hosts SET status='offline', router_seen=0")
        else:
            conn.execute("UPDATE hosts SET status='offline'")
    return prev, prev_online, purged_scans


def _load_secondary_scan_networks() -> List[Dict[str, Any]]:
    return get_secondary_discovery_networks()


def _run_scan_jobs(
    cidrs: List[str],
    secondary: List[Dict[str, Any]],
    prev: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []

    if get_discovery_source() == "schema":
        jobs = get_discovery_scan_jobs(active_only=True)

        def _run_schema_job(job: Dict[str, Any]) -> Dict[str, Any]:
            cidr = (job.get("cidr") or "").strip()
            iface = (job.get("interface") or "").strip() or auto_detect_interface(cidr)
            method = (job.get("scanner_method") or "nmap").strip().lower()

            if method == "router":
                return _run_scan_inner(cidr, iface, use_router=True, run_nmap=False)
            if method == "router+nmap":
                return _run_scan_inner(cidr, iface, use_router=True, run_nmap=True)
            return _run_scan_inner(cidr, iface, use_router=False, run_nmap=True)

        if len(jobs) == 1:
            results.append(_run_schema_job(jobs[0]))
            return results

        if jobs:
            with _cf.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
                futs = {ex.submit(_run_schema_job, job): (job.get("cidr") or "") for job in jobs}
                for fut in _cf.as_completed(futs):
                    cidr_key = futs[fut]
                    try:
                        results.append(fut.result())
                    except Exception as e:
                        results.append({"cidr": cidr_key, "error": str(e)})
            return results

    router_is_primary = cfg("router_enabled", "0") == "1"
    primary_iface = cfg("primary_net_interface", "").strip()

    primary_jobs = cidrs
    secondary_jobs = [(s["cidr"], s["interface"]) for s in secondary]

    def _run_primary(cidr: str) -> Dict[str, Any]:
        if router_is_primary:
            return _run_router_primary_scan(cidr, prev, None)
        iface = primary_iface or auto_detect_interface(cidr)
        return _run_scan_inner(cidr, iface)

    all_jobs = (
        [(_run_primary, c) for c in primary_jobs]
        + [(_run_scan_inner, c, iface) for c, iface in secondary_jobs]
    )

    if len(all_jobs) == 1:
        fn, *args = all_jobs[0]
        results.append(fn(*args))
    else:
        with _cf.ThreadPoolExecutor(max_workers=len(all_jobs)) as ex:
            futs = {}
            for item in all_jobs:
                fn, *args = item
                futs[ex.submit(fn, *args)] = args[0]
            for fut in _cf.as_completed(futs):
                cidr_key = futs[fut]
                try:
                    results.append(fut.result())
                except Exception as e:
                    results.append({"cidr": cidr_key, "error": str(e)})

    return results


def _restore_previous_host_statuses(prev: Dict[str, Dict[str, Any]]) -> None:
    with db() as conn:
        for ip, data in prev.items():
            conn.execute(
                "UPDATE hosts SET status=?, router_seen=? WHERE ip=?",
                (data["status"], int(data.get("router_seen", 0) or 0), ip),
            )


def _detect_degraded_scan(
    prev: Dict[str, Dict[str, Any]],
    online_hosts: int,
    results: List[Dict[str, Any]],
) -> Tuple[bool, str]:
    prev_online = sum(
        1 for v in prev.values() if v.get("status") in ("online", "online_silent")
    )
    error_count = sum(1 for r in results if r.get("error"))

    if prev_online < 8:
        return False, ""

    severe_drop = online_hosts <= max(3, int(prev_online * 0.35))
    missing_many = (prev_online - online_hosts) >= 8

    if severe_drop and missing_many:
        reason_parts = [f"online={online_hosts} vs prev_online={prev_online}"]
        if error_count:
            reason_parts.append(f"errors={error_count}")
        return True, ", ".join(reason_parts)

    return False, ""


SCAN_CHART_BUCKETS = {
    1: 15,    # 15 min
    7: 120,   # 2 h
    30: 720,  # 12 h
}


def _bucket_floor_iso(raw_iso: str, bucket_minutes: int) -> str:
    dt = parse_iso(raw_iso)
    ts = int(dt.timestamp())
    floored = ts - (ts % (bucket_minutes * 60))
    return datetime.fromtimestamp(floored, tz=timezone.utc).isoformat()


def rebuild_scans_chart_cache(conn: sqlite3.Connection, lookback_days: int = 32) -> int:
    cutoff_iso = (utc_now() - timedelta(days=max(1, int(lookback_days)))).isoformat()
    rows = conn.execute(
        """
        SELECT started_at, finished_at, online_hosts, offline_hosts, COALESCE(notes,'') AS notes
        FROM scans
        WHERE started_at >= ?
        ORDER BY started_at ASC
        """,
        (cutoff_iso,),
    ).fetchall()

    conn.execute("DELETE FROM scans_chart_cache")

    if not rows:
        return 0

    updated_at = utc_now_iso()
    inserted = 0

    for bucket_minutes in SCAN_CHART_BUCKETS.values():
        buckets: Dict[str, Dict[str, float]] = {}

        for row in rows:
            notes = str(row["notes"] or "").strip().lower()
            if notes.startswith("[degraded]"):
                continue

            raw_iso = row["finished_at"] or row["started_at"] or ""
            if not raw_iso:
                continue

            try:
                bucket_start = _bucket_floor_iso(raw_iso, bucket_minutes)
            except Exception:
                continue

            item = buckets.setdefault(
                bucket_start,
                {"online_sum": 0.0, "offline_sum": 0.0, "count": 0.0},
            )
            item["online_sum"] += float(row["online_hosts"] or 0)
            item["offline_sum"] += float(row["offline_hosts"] or 0)
            item["count"] += 1.0

        for bucket_start, item in buckets.items():
            count = max(1, int(item["count"]))
            conn.execute(
                """
                INSERT OR REPLACE INTO scans_chart_cache
                    (bucket_start, bucket_minutes, online_avg, offline_avg, sample_count, updated_at)
                VALUES (?,?,?,?,?,?)
                """,
                (
                    bucket_start,
                    bucket_minutes,
                    round(item["online_sum"] / count, 2),
                    round(item["offline_sum"] / count, 2),
                    count,
                    updated_at,
                ),
            )
            inserted += 1

    return inserted



def _is_running_under_uvicorn() -> bool:
    argv = " ".join(str(x) for x in getattr(sys, "argv", [])).lower()
    if "uvicorn" in argv:
        return True
    return any(name.startswith("uvicorn") for name in sys.modules.keys())

def _launch_dns_refresh_for_online_hosts() -> None:
    if not _is_running_under_uvicorn():
        return
    try:
        with db() as conn:
            online_ips = [
                r["ip"]
                for r in conn.execute(
                    "SELECT ip FROM hosts WHERE status IN ('online','online_silent')"
                ).fetchall()
            ]
        if online_ips:
            threading.Thread(
                target=_resolve_dns_background,
                args=(online_ips,),
                daemon=True,
            ).start()
    except Exception:
        pass


def _finalize_scan_cycle(
    *,
    prev: Dict[str, Dict[str, Any]],
    results: List[Dict[str, Any]],
    cidrs: List[str],
    secondary: List[Dict[str, Any]],
    cidr_raw: str,
    started_at: str,
    purged_scans: int,
) -> Dict[str, Any]:
    with db() as conn:
        finished_at = utc_now_iso()
        offline_grace_seconds = _host_offline_grace_seconds()

        for row in conn.execute("SELECT ip, status, last_seen, router_seen FROM hosts").fetchall():
            if row["status"] != "offline":
                continue

            previous = prev.get(row["ip"])
            if not previous or previous.get("status") == "offline":
                continue

            keep_previous_status = False
            last_seen = row["last_seen"]
            if last_seen:
                try:
                    age_seconds = max(0.0, (parse_iso(finished_at) - parse_iso(last_seen)).total_seconds())
                    if age_seconds < offline_grace_seconds:
                        keep_previous_status = True
                except Exception:
                    pass

            if keep_previous_status:
                conn.execute(
                    "UPDATE hosts SET status=?, router_seen=? WHERE ip=?",
                    (
                        previous.get("status"),
                        int(previous.get("router_seen", row["router_seen"] or 0) or 0),
                        row["ip"],
                    ),
                )
                continue

            now_iso = utc_now_iso()
            add_event(conn, row["ip"], "status", previous.get("status"), "offline")
            record_availability_transition(conn, row["ip"], previous.get("status"), "offline", now_iso)
            conn.execute(
                "UPDATE hosts SET last_change=? WHERE ip=?",
                (now_iso, row["ip"]),
            )

        cur_rows = conn.execute("SELECT ip, status, mac FROM hosts").fetchall()
        current = {r["ip"]: {"status": r["status"], "mac": r["mac"]} for r in cur_rows}
        online_hosts = conn.execute(
            "SELECT COUNT(*) c FROM hosts WHERE status IN ('online','online_silent')"
        ).fetchone()["c"]
        offline_hosts = conn.execute(
            "SELECT COUNT(*) c FROM hosts WHERE status='offline'"
        ).fetchone()["c"]

        degraded_scan, degraded_reason = _detect_degraded_scan(prev, online_hosts, results)
        if degraded_scan:
            for ip, data in prev.items():
                conn.execute(
                    "UPDATE hosts SET status=?, router_seen=? WHERE ip=?",
                    (data["status"], int(data.get("router_seen", 0) or 0), ip),
                )
            cur_rows = conn.execute("SELECT ip, status, mac FROM hosts").fetchall()
            current = {r["ip"]: {"status": r["status"], "mac": r["mac"]} for r in cur_rows}
            online_hosts = conn.execute(
                "SELECT COUNT(*) c FROM hosts WHERE status IN ('online','online_silent')"
            ).fetchone()["c"]
            offline_hosts = conn.execute(
                "SELECT COUNT(*) c FROM hosts WHERE status='offline'"
            ).fetchone()["c"]

        all_cidrs = (
            ", ".join(cidrs + [s["cidr"] for s in secondary])
            if (cidrs or secondary)
            else cidr_raw
        )
        new_hosts = 0 if degraded_scan else sum(r.get("new_hosts", 0) for r in results)
        scan_notes = f"[degraded] descartado: {degraded_reason}" if degraded_scan else ""

        event_channels = {"info": [], "alerts": []} if degraded_scan else compute_discord_events_by_channel(prev, current)
        events = list(event_channels.get("info") or []) + list(event_channels.get("alerts") or [])
        events_sent = len(events)
        discord_sent = 0
        discord_error = ""

        for channel, channel_events in (("info", event_channels.get("info") or []), ("alerts", event_channels.get("alerts") or [])):
            if not channel_events:
                continue
            msg = f"📡 **Auditor IPs** ({all_cidrs})\n" + "\n".join(channel_events[:40])
            ok, err = discord_notify(msg, channel=channel)
            if ok:
                discord_sent = 1
            elif err:
                discord_error = err

        push_lines: List[str] = []
        prev_mac_to_ip = {v.get("mac"): ip for ip, v in prev.items() if v.get("mac")}
        for ip, cur in current.items():
            previous = prev.get(ip)
            if previous is None and cfg("push_new", "1") == "1":
                cur_mac = cur.get("mac")
                if cur_mac and cur_mac in prev_mac_to_ip:
                    pass
                else:
                    push_lines.append(f"🆕 Nuevo: {ip}")
            elif previous and previous.get("status") != cur.get("status"):
                if cur.get("status") == "offline" and cfg("push_offline", "1") == "1":
                    push_lines.append(f"🔴 Offline: {ip}")
                elif cur.get("status") == "online" and cfg("push_online", "0") == "1":
                    push_lines.append(f"🟢 Online: {ip}")
            if (
                cfg("push_mac_change", "1") == "1"
                and previous
                and previous.get("mac")
                and cur.get("mac")
                and previous["mac"] != cur["mac"]
            ):
                push_lines.append(f"⚠️ MAC cambió: {ip}")

        if push_lines:
            push_body = " | ".join(push_lines[:4]) + (
                f" (+{len(push_lines) - 4} más)" if len(push_lines) > 4 else ""
            )
            threading.Thread(
                target=send_push_notification,
                args=("Auditor IPs — Eventos de red", push_body),
                daemon=True,
            ).start()

        last_scan_row = conn.execute(
            """
            SELECT finished_at
            FROM scans
            WHERE finished_at IS NOT NULL
            ORDER BY finished_at DESC
            LIMIT 1
            """
        ).fetchone()
        uptime_interval_start = (
            last_scan_row["finished_at"]
            if last_scan_row and last_scan_row["finished_at"]
            else started_at
        )

        accum_uptime(conn, prev, uptime_interval_start, finished_at, cfg("app_tz", "Europe/Madrid"))

        alert_msgs = [] if degraded_scan else evaluate_alerts(conn, prev, current, new_hosts)
        if alert_msgs:
            for alert_msg in alert_msgs:
                discord_notify(alert_msg, channel="alerts")

        conn.execute(
            """
            INSERT INTO scans
                (started_at, finished_at, cidr, online_hosts, offline_hosts,
                 new_hosts, events_sent, discord_sent, discord_error, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                started_at,
                finished_at,
                all_cidrs,
                online_hosts,
                offline_hosts,
                new_hosts,
                events_sent,
                discord_sent,
                discord_error,
                scan_notes,
            ),
        )

        rebuild_scans_chart_cache(conn)

    _launch_dns_refresh_for_online_hosts()

    return {
        "cidr": all_cidrs,
        "online_hosts": online_hosts,
        "offline_hosts": offline_hosts,
        "new_hosts": new_hosts,
        "events_sent": events_sent,
        "discord_sent": discord_sent,
        "discord_error": discord_error,
        "started_at": started_at,
        "finished_at": finished_at,
        "purged_scans": purged_scans,
        "per_cidr": results,
    }


def run_scan(cidr_raw: str) -> Dict[str, Any]:
    """
    Lanza un scan completo. cidr_raw puede ser un único CIDR o lista por comas.
    Los CIDRs se escanean en paralelo y consolidan en un único resultado.
    Las redes secundarias configuradas en BD se escanean también en paralelo,
    cada una usando su interfaz física configurada.

    Importante: el estado offline se decide una sola vez al final del ciclo,
    para evitar falsos offline cuando hay varias redes/ciclos en paralelo.
    """
    with _db_write_lock:
        started_at = utc_now_iso()
        prev, prev_online, purged_scans = _prepare_scan_cycle()
        global _SCAN_CYCLE_STATUS
        _SCAN_CYCLE_STATUS = {str(ip): str((data or {}).get("status") or "") for ip, data in prev.items()}

        cidrs = parse_cidr_list(cidr_raw)
        secondary = _load_secondary_scan_networks()
        results = _run_scan_jobs(cidrs, secondary, prev)

        total_found = sum(
            r.get("online_hosts", 0)
            for r in results
            if isinstance(r, dict) and "error" not in r
        )
        if total_found == 0 and prev_online > 0:
            _restore_previous_host_statuses(prev)
            print(
                f"[scan] WARN: 0 hosts encontrados (había {prev_online} online). "
                "Scan descartado — probable fallo transitorio de nmap."
            )
            return {
                "ok": False,
                "warning": "zero_hosts",
                "prev_online": prev_online,
                "aborted": True,
            }

        return _finalize_scan_cycle(
            prev=prev,
            results=results,
            cidrs=cidrs,
            secondary=secondary,
            cidr_raw=cidr_raw,
            started_at=started_at,
            purged_scans=purged_scans,
        )


def _run_scan_inner(
    cidr: str,
    interface: str = "",
    use_router: Optional[bool] = None,
    run_nmap: bool = True,
) -> Dict[str, Any]:
    started_at = utc_now_iso()

    router_data: Dict[str, Any] = {}
    router_error: str = ""
    use_router = (cfg("router_enabled", "0") == "1") if use_router is None else bool(use_router)

    with _cf.ThreadPoolExecutor(max_workers=2) as executor:
        nmap_future = executor.submit(run_nmap_ping_sweep, cidr, interface) if run_nmap else None
        router_future = executor.submit(fetch_router_data) if use_router else None

        out = ""
        if nmap_future:
            out = nmap_future.result()
        if router_future:
            try:
                router_data, router_error = router_future.result(timeout=20)
            except Exception as e:
                router_error = str(e)

    if router_data:
        try:
            net = ipaddress.ip_network(cidr, strict=False)
            router_data = {
                ip: data
                for ip, data in router_data.items()
                if ipaddress.ip_address(str(ip).strip()) in net
            }
        except Exception:
            pass

    found = parse_nmap(out) if run_nmap else []
    found_by_ip = {h["ip"]: h for h in found if h.get("ip")}
    for _data in found_by_ip.values():
        _data.setdefault("_discovery_source", "nmap")
        _data.setdefault("_discovery_confidence", 100)

    # Inyectar IPs locales del servidor en este CIDR (nmap nunca reporta el propio host)
    for local in get_local_ips_in_cidr(cidr):
        lip = local["ip"]
        if lip not in found_by_ip:
            local["_discovery_source"] = "local_self"
            local["_discovery_confidence"] = 95
            found_by_ip[lip] = local

    # Promover a online los hosts que el router ve y además responden a ICMP,
    # aunque el sweep inicial no los haya metido en found_by_ip.
    if router_data:
        for raw_ip, rdata in router_data.items():
            rip = str(raw_ip).strip()
            if not rip or rip in found_by_ip:
                continue
            if _icmp_ping_once(rip, timeout_s=1):
                found_by_ip[rip] = {
                    "ip": rip,
                    "mac": (rdata.get("mac") or "").strip().upper(),
                    "nmap_hostname": (rdata.get("router_hostname") or "").strip(),
                    "latency_ms": None,
                    "_discovery_source": "router_icmp",
                    "_discovery_confidence": 90,
                }

    arp = read_arp_cache()
    discovery_source_counts: Dict[str, int] = {}
    for _data in found_by_ip.values():
        _src = str(_data.get("_discovery_source") or "unknown").strip() or "unknown"
        discovery_source_counts[_src] = discovery_source_counts.get(_src, 0) + 1
    if router_data:
        discovery_source_counts["router_records"] = len(router_data)
    if router_error:
        discovery_source_counts["router_error"] = 1
    new_hosts = 0

    with db() as conn:
        default_id = _get_default_host_type_id(conn)

        latency_records: List[Tuple] = []
        for ip, data in found_by_ip.items():
            mac = data.get("mac") or arp.get(ip)
            dns_name = resolve_ptr(ip)
            nmap_hostname = (data.get("nmap_hostname") or "").strip() or (dns_name or "")
            latency_ms = data.get("latency_ms")
            now = utc_now_iso()

            if latency_ms is not None:
                latency_records.append((ip, now, latency_ms))

            row = conn.execute(
                "SELECT ip, status, mac, dns_name, nmap_hostname, known FROM hosts WHERE ip=?", (ip,)
            ).fetchone()

            if row is None:
                mac_row = None
                if mac:
                    mac_row = conn.execute(
                        "SELECT ip FROM hosts WHERE mac=? AND ip!=?", (mac, ip)
                    ).fetchone()
                if mac_row:
                    old_ip = mac_row["ip"]
                    add_event(conn, old_ip, "ip_change", old_ip, ip)
                    move_open_availability_interval_ip(conn, old_ip, ip)
                    conn.execute("""
                        UPDATE hosts
                        SET ip=?, nmap_hostname=?, dns_name=?, last_seen=?, last_change=?, status='online'
                        WHERE mac=? AND ip=?
                    """, (ip, nmap_hostname or None, dns_name or None, now, now, mac, old_ip))
                    add_event(conn, ip, "ip_change_arrived", old_ip, ip)
                else:
                    new_hosts += 1
                    vendor = oui_lookup(mac) if mac else ""
                    conn.execute("""
                        INSERT INTO hosts
                            (ip, mac, nmap_hostname, dns_name, manual_name, notes, type_id,
                             first_seen, last_seen, last_change, status, known, vendor)
                        VALUES (?,?,?,?,NULL,NULL,?,?,?,?,'online',0,?)
                    """, (ip, mac, nmap_hostname or None, dns_name or None,
                          default_id, now, now, now, vendor or None))
                    add_event(conn, ip, "new", None, f"mac={mac or 'N/D'}")
                    record_availability_transition(conn, ip, None, "online", now)
                    classify_and_persist_host(conn, ip)
            else:
                old_status = _effective_old_status(conn, ip, row["status"])
                old_mac = row["mac"]
                changed = False
                if _availability_family(old_status) != "online":
                    add_event(conn, ip, "status", old_status, "online")
                    record_availability_transition(conn, ip, old_status, "online", now)
                    _remember_cycle_status(ip, "online")
                    changed = True
                if mac and (old_mac or "") != mac:
                    add_event(conn, ip, "mac", old_mac, mac)
                    changed = True
                if (dns_name or None) != (row["dns_name"] or None):
                    add_event(conn, ip, "dns", row["dns_name"], dns_name)
                    changed = True
                if (nmap_hostname or None) != (row["nmap_hostname"] or None):
                    add_event(conn, ip, "nmap", row["nmap_hostname"], nmap_hostname)
                    changed = True

                if changed:
                    vendor_upd = oui_lookup(mac) if mac else None
                    conn.execute("""
                        UPDATE hosts
                        SET mac=COALESCE(?,mac), nmap_hostname=?, dns_name=?,
                            last_seen=?, last_change=?, status='online',
                            vendor=COALESCE(NULLIF(?,''),vendor)
                        WHERE ip=?
                    """, (mac, nmap_hostname or None, dns_name or None, now, now, vendor_upd, ip))
                    classify_and_persist_host(conn, ip)
                else:
                    conn.execute("""
                        UPDATE hosts
                        SET mac=COALESCE(?,mac), nmap_hostname=?, dns_name=?,
                            last_seen=?, status='online'
                        WHERE ip=?
                    """, (mac, nmap_hostname or None, dns_name or None, now, ip))

        online_hosts = len(found_by_ip)
        silent_new = 0

        if router_data:
            silent_new = merge_router_data(conn, found_by_ip, router_data, default_id)
            _record_router_scan(
                conn,
                hosts_seen=len(router_data),
                silent_new=silent_new,
                error=router_error,
            )
            online_hosts += silent_new
            if silent_new:
                discovery_source_counts["router_silent_new"] = silent_new


        elif router_error:
            _record_router_scan(
                conn,
                hosts_seen=0,
                silent_new=0,
                error=router_error,
            )

        _persist_latency_records(conn, latency_records)

    return {
        "cidr": cidr,
        "interface": interface,
        "online_hosts": online_hosts,
        "new_hosts": new_hosts,
        "started_at": started_at,
        "finished_at": utc_now_iso(),
        "router_error": router_error,
        "source": "router+nmap" if use_router and run_nmap else ("router" if use_router else "nmap"),
        "discovery_sources": discovery_source_counts,
    }


# ══════════════════════════════════════════════════════════════
#  API — Scans
# ══════════════════════════════════════════════════════════════



@router.get("/api/router-analysis")
def api_router_analysis():
    """
    Obtiene datos del router SSH y los cruza con los hosts conocidos por nmap.
    Devuelve:
      - hosts_router: lo que el router ve (ARP + leases)
      - hosts_nmap: lo que nmap ha encontrado en el CIDR del router
      - discrepancias: IPs que nmap ve pero el router no (en el mismo CIDR)
      - solo_router: IPs que el router ve pero nmap no (online_silent)
    Solo funciona si router_enabled=1.
    """
    if cfg("router_enabled", "0") != "1":
        return {"ok": False, "error": "Router SSH no está habilitado en Config → Router SSH"}
    try:
        router_data, router_error = fetch_router_data()
        if router_error and not router_data:
            return {"ok": False, "error": router_error}

        # CIDR del router = primer CIDR de la red principal
        router_cidr_raw = cfg("scan_cidr", "").split(",")[0].strip()
        import ipaddress as _ipa

        # Hosts que nmap conoce en el CIDR del router
        with db() as conn:
            all_hosts = conn.execute(
                """SELECT ip, mac, nmap_hostname, dns_name, manual_name,
                          router_hostname, ip_assignment, status, vendor
                   FROM hosts ORDER BY ip"""
            ).fetchall()
        all_hosts = [dict(h) for h in all_hosts]

        # Filtrar hosts nmap en el CIDR del router
        nmap_in_router_cidr = {}
        try:
            router_net = _ipa.ip_network(router_cidr_raw, strict=False)
            for h in all_hosts:
                try:
                    if _ipa.ip_address(h["ip"]) in router_net:
                        nmap_in_router_cidr[h["ip"]] = h
                except ValueError:
                    pass
        except ValueError:
            pass

        # Router data normalizado
        router_by_ip = {}
        for ip, rdata in (router_data or {}).items():
            router_by_ip[ip] = {
                "ip":              ip,
                "mac":             rdata.get("mac", ""),
                "router_hostname": rdata.get("router_hostname", ""),
                "ip_assignment":   rdata.get("ip_assignment", ""),
                "lease_secs":      rdata.get("dhcp_lease_secs"),
            }

        # Discrepancias: nmap ve, router NO ve (en el CIDR del router)
        discrepancias = []
        for ip, h in nmap_in_router_cidr.items():
            if ip not in router_by_ip:
                discrepancias.append({
                    "ip":     ip,
                    "mac":    h.get("mac", ""),
                    "name":   h.get("manual_name") or h.get("nmap_hostname") or h.get("dns_name") or "",
                    "vendor": h.get("vendor", ""),
                    "status": h.get("status", ""),
                    "reason": "Nmap detecta este host pero el router no lo tiene en su ARP/DHCP"
                })

        # Solo router: router ve, nmap NO conoce (o está offline)
        solo_router = []
        for ip, rdata in router_by_ip.items():
            nmap_h = nmap_in_router_cidr.get(ip)
            if not nmap_h or nmap_h.get("status") == "offline":
                solo_router.append({
                    "ip":              ip,
                    "mac":             rdata["mac"],
                    "router_hostname": rdata["router_hostname"],
                    "ip_assignment":   rdata["ip_assignment"],
                    "nmap_known":      bool(nmap_h),
                    "nmap_status":     nmap_h.get("status", "") if nmap_h else "desconocido",
                    "reason": "El router ve este host pero nmap no lo detectó en el último scan"
                })

        # Hosts en común
        en_comun = []
        for ip in router_by_ip:
            if ip in nmap_in_router_cidr:
                h = nmap_in_router_cidr[ip]
                r = router_by_ip[ip]
                # Detectar discrepancia de MAC
                mac_disc = (h.get("mac") or "").upper() != (r.get("mac") or "").upper() \
                           and h.get("mac") and r.get("mac")
                en_comun.append({
                    "ip":              ip,
                    "mac_nmap":        h.get("mac", ""),
                    "mac_router":      r.get("mac", ""),
                    "mac_discrepancy": mac_disc,
                    "name_nmap":       h.get("manual_name") or h.get("nmap_hostname") or "",
                    "name_router":     r.get("router_hostname", ""),
                    "ip_assignment":   r.get("ip_assignment", ""),
                    "vendor":          h.get("vendor", ""),
                    "status":          h.get("status", ""),
                })

        return {
            "ok":            True,
            "router_cidr":   router_cidr_raw,
            "router_error":  router_error or "",
            "total_router":  len(router_by_ip),
            "total_nmap":    len(nmap_in_router_cidr),
            "discrepancias": discrepancias,
            "solo_router":   solo_router,
            "en_comun":      en_comun,
        }
    except Exception as e:
        import traceback
        return {"ok": False, "error": str(e), "detail": traceback.format_exc()}


@router.post("/api/scan/nmap-now")
def api_nmap_complement_now():
    """
    Lanza el scan nmap complementario manualmente (bajo demanda).
    Solo funciona cuando el router es la fuente primaria.
    Resultado: discrepancias en /api/scan/discrepancies
    """
    if cfg("router_enabled", "0") != "1":
        return JSONResponse({"ok": False, "error": "Solo disponible cuando el router es la fuente primaria"})
    if _nmap_complement_lock.is_set():
        return JSONResponse({"ok": False, "error": "Ya hay un scan nmap en curso"})
    threading.Thread(target=run_nmap_complement_scan, daemon=True).start()
    return JSONResponse({"ok": True, "status": "nmap_scanning"})


@router.post("/api/scan/reconfigure-jobs")
def api_reconfigure_jobs():
    """Reconfigura los jobs del scheduler según la config actual."""
    try:
        reconfigure_scan_jobs()
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})


@router.get("/api/scan/ai-reports")
def api_scan_ai_reports(limit: int = 10):
    """Lista los últimos informes IA de verificación secundaria."""
    try:
        with db() as conn:
            rows = conn.execute(
                """SELECT id, generated_at, discrepancy_count, source,
                          substr(report_text, 1, 200) as preview
                   FROM scan_ai_reports ORDER BY generated_at DESC LIMIT ?""",
                (limit,)
            ).fetchall()
        return {"ok": True, "reports": [dict(r) for r in rows]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/api/scan/ai-reports/{report_id}")
def api_scan_ai_report_detail(report_id: int):
    """Devuelve un informe IA concreto por id."""
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM scan_ai_reports WHERE id = ? LIMIT 1",
                (report_id,)
            ).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Informe no encontrado"}, status_code=404)
        return {"ok": True, "report": dict(row)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/api/scan/ai-reports/latest")
def api_scan_ai_report_latest():
    """Devuelve el último informe IA completo."""
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM scan_ai_reports ORDER BY generated_at DESC LIMIT 1"
            ).fetchone()
        if not row:
            return {"ok": True, "report": None}
        return {"ok": True, "report": dict(row)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/api/scan/ai-analyze-now")
def api_scan_ai_analyze_now():
    """Lanza el análisis IA de discrepancias manualmente."""
    if _nmap_complement_lock.is_set():
        return JSONResponse({"ok": False, "error": "Scan en curso, espera"})
    threading.Thread(target=run_secondary_scan_with_ai, daemon=True).start()
    return JSONResponse({"ok": True, "status": "analyzing"})

@router.post("/scan")
def scan_now():
    """Lanza un scan en background. nmap puede tardar 30-90s."""
    if _scan_running.is_set():
        return JSONResponse({"ok": False, "error": "Ya hay un scan en curso"}, status_code=409)
    _scan_running.set()

    def _run():
        try:
            run_scan(cfg("scan_cidr", SCAN_CIDR))
        except Exception as e:
            print(f"[scan_now] Error: {e}")
        finally:
            _scan_running.clear()

    threading.Thread(target=_run, daemon=True).start()
    return JSONResponse({"ok": True, "status": "scanning"})


@router.get("/api/scans")
def api_scans(limit: int = 100, days: int | None = None, trace: str | None = None):
    """
    Historial de scans con hosts aparecidos/desaparecidos.
    Usa 2 queries agregadas en lugar de N queries en bucle
    para evitar bloqueos en SQLite con muchos scans acumulados.
    """
    _t0 = time.perf_counter()

    try:
        days = int(days) if days is not None else None
    except Exception:
        days = None

    with db() as conn:
        params = []
        where = []

        if days and days > 0:
            cutoff_iso = (utc_now() - timedelta(days=days)).isoformat()
            where.append("started_at >= ?")
            params.append(cutoff_iso)

        sql = """
            SELECT id, started_at, finished_at, cidr, online_hosts, offline_hosts, new_hosts,
                   events_sent, discord_sent, discord_error, COALESCE(notes,'') AS notes
            FROM scans
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(min(limit, 500))

        rows = conn.execute(sql, tuple(params)).fetchall()
        scans_list = [dict(r) for r in rows]

        if not scans_list:
            ms = round((time.perf_counter() - _t0) * 1000, 1)
            print(f"[trace][scans][table] trace={trace or '-'} days={days} rows=0 ms={ms}")
            return scans_list

        dates = [
            (s["started_at"], s["finished_at"])
            for s in scans_list
            if s["started_at"] and s["finished_at"]
        ]
        if not dates:
            for s in scans_list:
                s["appeared"] = []
                s["disappeared"] = []
            ms = round((time.perf_counter() - _t0) * 1000, 1)
            print(f"[trace][scans][table] trace={trace or '-'} days={days} rows={len(scans_list)} ms={ms}")
            return scans_list

        min_date = min(d[0] for d in dates)
        max_date = max(d[1] for d in dates)

        appeared_rows = conn.execute("""
            SELECT e.ip, e.at,
                   COALESCE(h.manual_name, h.nmap_hostname, h.dns_name, e.ip) AS name
            FROM host_events e
            LEFT JOIN hosts h ON h.ip = e.ip
            WHERE (
                  e.event_type = 'new'
                  OR e.event_type = 'new_silent'
                  OR (
                      e.event_type = 'status'
                      AND e.old_value = 'offline'
                      AND e.new_value IN ('online', 'online_silent')
                  )
              )
              AND e.at BETWEEN ? AND ?
        """, (min_date, max_date)).fetchall()

        disappeared_rows = conn.execute("""
            SELECT e.ip, e.at,
                   COALESCE(h.manual_name, h.nmap_hostname, h.dns_name, e.ip) AS name
            FROM host_events e
            LEFT JOIN hosts h ON h.ip = e.ip
            WHERE e.event_type = 'status' AND e.new_value = 'offline'
              AND e.at BETWEEN ? AND ?
        """, (min_date, max_date)).fetchall()

    for scan in scans_list:
        scan["appeared"] = []
        scan["disappeared"] = []

    for r in appeared_rows:
        for scan in scans_list:
            if scan["started_at"] and scan["finished_at"]:
                if scan["started_at"] <= r["at"] <= scan["finished_at"]:
                    scan["appeared"].append({"ip": r["ip"], "name": r["name"]})
                    break

    for r in disappeared_rows:
        for scan in scans_list:
            if scan["started_at"] and scan["finished_at"]:
                if scan["started_at"] <= r["at"] <= scan["finished_at"]:
                    scan["disappeared"].append({"ip": r["ip"], "name": r["name"]})
                    break

    ms = round((time.perf_counter() - _t0) * 1000, 1)
    print(f"[trace][scans][table] trace={trace or '-'} days={days} rows={len(scans_list)} ms={ms}")
    return scans_list

@router.get("/api/scans/chart")
def api_scans_chart(days: int = 7, trace: str | None = None):
    _t0 = time.perf_counter()
    days = int(days or 7)
    if days not in (1, 7, 30):
        days = 7

    bucket_minutes = SCAN_CHART_BUCKETS.get(days, SCAN_CHART_BUCKETS[7])
    cutoff_iso = (utc_now() - timedelta(days=days)).isoformat()

    with db() as conn:
        cache_rows = conn.execute(
            "SELECT COUNT(*) c FROM scans_chart_cache"
        ).fetchone()["c"]
        if not cache_rows:
            rebuild_scans_chart_cache(conn)

        rows = conn.execute(
            """
            SELECT bucket_start, bucket_minutes, online_avg, offline_avg, sample_count, updated_at
            FROM scans_chart_cache
            WHERE bucket_minutes=? AND bucket_start >= ?
            ORDER BY bucket_start ASC
            """,
            (bucket_minutes, cutoff_iso),
        ).fetchall()

        total_scans = conn.execute(
            """
            SELECT COUNT(*) c
            FROM scans
            WHERE started_at >= ?
              AND COALESCE(notes, '') NOT LIKE '[degraded]%'
            """,
            (cutoff_iso,),
        ).fetchone()["c"]

    payload = {
        "ok": True,
        "days": days,
        "bucket_minutes": bucket_minutes,
        "total_scans": total_scans,
        "points": [dict(r) for r in rows],
    }
    ms = round((time.perf_counter() - _t0) * 1000, 1)
    print(f"[trace][scans][chart] trace={trace or '-'} days={days} points={len(payload['points'])} bucket={bucket_minutes}ms ms={ms}")
    return payload


@router.post("/api/scans/ui-trace")
def api_scans_ui_trace(payload: Dict[str, Any] = Body(...), request: Request = None):
    trace = str(payload.get("trace") or "-")
    days = payload.get("days")
    total_ms = payload.get("total_ms")
    table_ms = payload.get("table_ms")
    chart_ms = payload.get("chart_ms")
    rows = payload.get("rows")
    points = payload.get("points")
    ip = request.client.host if request and request.client else "-"
    print(
        f"[trace][scans][ui] trace={trace} ip={ip} days={days} "
        f"total_ms={total_ms} table_ms={table_ms} chart_ms={chart_ms} rows={rows} points={points}"
    )
    return {"ok": True}


@router.patch("/api/scans/{scan_id}/notes")
def api_scan_notes(scan_id: int, payload: Dict[str, Any] = Body(...)):
    with db() as conn:
        conn.execute("UPDATE scans SET notes=? WHERE id=?", (payload.get("notes", ""), scan_id))
    return {"ok": True}


def _format_interval_duration(start_iso: str, end_iso: str | None = None) -> str:
    try:
        from utils import parse_iso
        start_dt = parse_iso(start_iso)
        end_dt = parse_iso(end_iso) if end_iso else utc_now()
        if not start_dt or not end_dt:
            return human_since(start_iso)
        total = max(0, int((end_dt - start_dt).total_seconds()))
        days, rem = divmod(total, 86400)
        hours, rem = divmod(rem, 3600)
        minutes, seconds = divmod(rem, 60)
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}m")
        if not parts:
            parts.append(f"{seconds}s")
        return ' '.join(parts[:3])
    except Exception:
        return human_since(start_iso)


@router.get("/api/hosts/{ip}/scan-history")
def api_host_scan_history(ip: str, limit: int = 100):
    with db() as conn:
        host = conn.execute("SELECT ip, status, first_seen FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)

        interval_rows = conn.execute(
            """
            SELECT status, started_at, ended_at
            FROM host_availability_intervals
            WHERE ip=?
            ORDER BY started_at ASC
            """,
            (ip,),
        ).fetchall()

        events = conn.execute("""
            SELECT at, event_type, old_value, new_value
            FROM host_events WHERE ip=? AND event_type IN ('status','new')
            ORDER BY at ASC
        """, (ip,)).fetchall()

    intervals = []
    if interval_rows:
        for row in interval_rows:
            end_iso = row["ended_at"] or None
            intervals.append({
                "status": row["status"],
                "from": row["started_at"],
                "from_local": to_local_str(row["started_at"]),
                "to": end_iso,
                "to_local": to_local_str(end_iso) if end_iso else "ahora",
                "duration": _format_interval_duration(row["started_at"], end_iso),
            })
        intervals.reverse()
        return {"ok": True, "ip": ip, "intervals": intervals[:limit]}

    cur_status, cur_since = None, None
    for e in events:
        if e["event_type"] == "new":
            cur_status, cur_since = "online", e["at"]
        elif e["event_type"] == "status":
            if cur_status and cur_since:
                intervals.append({
                    "status": cur_status, "from": cur_since,
                    "from_local": to_local_str(cur_since),
                    "to": e["at"], "to_local": to_local_str(e["at"]),
                    "duration": _format_interval_duration(cur_since, e["at"]),
                })
            cur_status, cur_since = e["new_value"], e["at"]
    if cur_status and cur_since:
        intervals.append({
            "status": cur_status, "from": cur_since,
            "from_local": to_local_str(cur_since),
            "to": None, "to_local": "ahora",
            "duration": _format_interval_duration(cur_since, None),
        })
    intervals.reverse()
    return {"ok": True, "ip": ip, "intervals": intervals[:limit]}


@router.get("/api/oui/{mac}")
def api_oui(mac: str):
    return {"ok": True, "mac": mac, "vendor": oui_lookup(mac)}


@router.post("/api/hosts/{ip}/ping")
def api_ping(ip: str):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)
    try:
        result = subprocess.run(
            ["ping", "-c", "3", "-W", "2", ip], capture_output=True, text=True, timeout=10
        )
        output   = result.stdout
        m        = re.search(r"rtt min/avg/max/mdev = [\d.]+/([\d.]+)/", output)
        avg_ms   = float(m.group(1)) if m else None
        loss_m   = re.search(r"(\d+)% packet loss", output)
        loss_pct = int(loss_m.group(1)) if loss_m else 100
        return {"ok": True, "ip": ip, "alive": loss_pct < 100, "avg_ms": avg_ms,
                "loss_pct": loss_pct, "output": output.strip()}
    except subprocess.TimeoutExpired:
        return {"ok": True, "ip": ip, "alive": False, "avg_ms": None, "loss_pct": 100, "output": "Timeout"}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)




def _run_manual_fingerprint(ip: str) -> Tuple[Dict[str, Any], bool]:
    return _run_manual_fingerprint_impl(ip)


def api_fingerprint_legacy(ip: str):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)
    try:
        fp, os_completed = _run_manual_fingerprint(ip)

        with db() as conn:
            row = conn.execute(
                """
                SELECT ip, mac, vendor, router_hostname, dns_name, nmap_hostname,
                       ip_assignment, device_type, device_confidence, device_source, device_evidence
                FROM hosts WHERE ip=?
                """,
                (ip,),
            ).fetchone()

        current_vendor = ""
        mac_addr = ""
        if row:
            current_vendor = row["vendor"] or ""
            mac_addr = row["mac"] or ""
            if not current_vendor and mac_addr:
                current_vendor = oui_lookup(mac_addr)

        new_vendor = current_vendor
        port_clues = fingerprint_port_clues({int(p) for p in fp["open_ports"]})
        os_str = (fp["os_guess"] or "").lower()
        hostname = (fp["hostname"] or "").strip()

        if not new_vendor:
            for k, v in [
                ("apple", "Apple"),
                ("macos", "Apple"),
                ("ios", "Apple"),
                ("windows", "Microsoft (Windows)"),
                ("android", "Android device"),
                ("linux", "Linux device"),
                ("cisco", "Cisco"),
            ]:
                if k in os_str:
                    new_vendor = v
                    break

        if not new_vendor:
            hn = hostname.lower()
            for k, v in [
                ("iphone", "Apple"),
                ("ipad", "Apple"),
                ("macbook", "Apple"),
                ("raspberry", "Raspberry Pi"),
                ("synology", "Synology"),
                ("diskstation", "Synology"),
                ("qnap", "QNAP"),
                ("ubnt", "Ubiquiti"),
                ("unifi", "Ubiquiti"),
                ("fritz", "AVM Fritz!Box"),
                ("hikvision", "IP Camera"),
                ("samsung", "Samsung/Android"),
                ("android", "Android device"),
            ]:
                if k in hn:
                    new_vendor = v
                    break

        classification = _classify_with_fingerprint(
            row,
            fp,
            new_vendor or current_vendor or "",
            fingerprint_kind="fingerprint_manual",
        )
        now_iso = utc_now_iso()

        with db() as conn:
            if new_vendor and new_vendor != current_vendor:
                conn.execute("UPDATE hosts SET vendor=? WHERE ip=?", (new_vendor, ip))
            if hostname:
                cur = conn.execute("SELECT nmap_hostname FROM hosts WHERE ip=?", (ip,)).fetchone()
                if cur and (cur["nmap_hostname"] or "") != hostname:
                    conn.execute("UPDATE hosts SET nmap_hostname=? WHERE ip=?", (hostname, ip))
            _persist_device_classification(conn, ip, classification, now_iso)

        classification["device_updated_at"] = now_iso
        classification["device_updated_at_local"] = to_local_str(now_iso)

        return {
            "ok": True,
            "ip": ip,
            "vendor": new_vendor or current_vendor or "",
            "vendor_updated": bool(new_vendor and new_vendor != current_vendor),
            "os_guess": fp["os_guess"],
            "device_type": fp["device_type"],
            "open_ports": fp["open_ports"],
            "services": fp["services"],
            "port_clues": port_clues,
            "hostname": hostname,
            "raw_lines": fp["raw_lines"],
            "classification": classification,
            "os_scan_completed": os_completed,
            "fingerprint_mode": "manual_fast",
        }
    except subprocess.TimeoutExpired:
        return JSONResponse({"ok": False, "error": "Timeout en fingerprint manual rápido"}, status_code=408)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
