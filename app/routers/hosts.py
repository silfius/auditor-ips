"""
routers/hosts.py — Auditor IPs
CRUD de hosts y tipos, tags, WoL, uptime, latencia, búsqueda global, dashboard.
"""

import csv
import io
import ipaddress
import json
import re
import subprocess
from datetime import datetime, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

from auth_middleware import auth_enabled, validate_session, SESSION_COOKIE
from config import cfg, DB_PATH, SCAN_CIDR, WOL_PORT, module_enabled
from database import db
from host_classification import decode_device_evidence, classify_host_device
from device_enrichment import classify_with_fingerprint, has_manual_fingerprint_source
from fingerprint_utils import derive_vendor_from_fingerprint
from scan_enrichment_runners import run_manual_fingerprint
from utils import (
    utc_now, utc_now_iso, parse_iso, to_local_str, human_since, get_app_tz,
    normalize_mac, compute_broadcast_from_cidr, send_wol,
)

router     = APIRouter()
templates  = Jinja2Templates(directory="templates")


# Importadas desde scans para evitar duplicación
def _add_event(conn, ip, event_type, old, new):
    from routers.scans import add_event
    add_event(conn, ip, event_type, old, new)


def _record_availability_transition(conn, ip, old_status, new_status, at_iso):
    from routers.scans import record_availability_transition
    record_availability_transition(conn, ip, old_status, new_status, at_iso)


def _oui_lookup(mac: str) -> str:
    from routers.scans import oui_lookup
    return oui_lookup(mac)


def _primary_cidrs() -> List[str]:
    return [c.strip() for c in cfg("scan_cidr", SCAN_CIDR).split(",") if c.strip()]


def _ip_in_any_primary(ip: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip)
    except Exception:
        return False
    for cidr in _primary_cidrs():
        try:
            if ip_obj in ipaddress.ip_network(cidr, strict=False):
                return True
        except Exception:
            continue
    return False


def _display_status(ip: str, status: str, router_seen: Any, last_seen: Any = None) -> str:
    status = (status or "").strip()
    router_primary = (
        cfg("router_enabled", "0") == "1"
        and (cfg("scan_primary_source", "router") or "router").strip().lower() == "router"
    )
    if not (router_primary and _ip_in_any_primary(ip)):
        return status

    if status in ("online", "online_silent"):
        if not _boolish(router_seen):
            return "offline"
        return status

    if status == "offline" and not _boolish(router_seen) and last_seen:
        try:
            from routers.scans import is_scan_running
            last_seen_dt = parse_iso(last_seen)
            if is_scan_running() and last_seen_dt:
                age_seconds = max(0.0, (utc_now() - last_seen_dt).total_seconds())
                if age_seconds < 300:
                    return "online_silent"
        except Exception:
            pass

    return status


def _host_display_name(row: Dict[str, Any]) -> str:
    for key in ("manual_name", "router_hostname", "nmap_hostname", "dns_name", "ip"):
        val = str(row.get(key, "") or "").strip()
        if val:
            return val
    return ""


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    txt = str(value or "").strip().lower()
    return txt in ("1", "true", "yes", "y", "si", "sí", "on")


def _normalize_owner_color(value: Any) -> str:
    txt = str(value or "").strip()
    if not txt:
        return ""
    if re.fullmatch(r"#[0-9a-fA-F]{6}", txt):
        return txt.lower()
    return ""


def _host_owner_rows(conn) -> List[Dict[str, Any]]:
    rows = conn.execute("""
        SELECT o.id, o.name, o.color, o.enabled, o.notes, o.created_at, o.updated_at,
               COUNT(h.ip) AS hosts_total,
               SUM(CASE WHEN h.status IN ('online','online_silent') THEN 1 ELSE 0 END) AS hosts_online,
               SUM(CASE WHEN h.status='offline' THEN 1 ELSE 0 END) AS hosts_offline
        FROM host_owners o
        LEFT JOIN hosts h ON h.owner_id=o.id
        GROUP BY o.id
        ORDER BY o.enabled DESC, o.name COLLATE NOCASE ASC
    """).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"] or "",
            "color": r["color"] or "",
            "enabled": _boolish(r["enabled"]),
            "notes": r["notes"] or "",
            "created_at": r["created_at"] or "",
            "updated_at": r["updated_at"] or "",
            "hosts_total": int(r["hosts_total"] or 0),
            "hosts_online": int(r["hosts_online"] or 0),
            "hosts_offline": int(r["hosts_offline"] or 0),
        }
        for r in rows
    ]


def _normalize_availability_status(value: Any) -> str:
    txt = str(value or "").strip().lower()
    if txt in ("online", "online_silent"):
        return "online"
    if txt == "offline":
        return "offline"
    return txt


def _parse_availability_intervals(rows: List[Any]) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for row in rows or []:
        started_at = row["started_at"]
        ended_at = row["ended_at"]
        start_dt = parse_iso(started_at)
        end_dt = parse_iso(ended_at) if ended_at else utc_now()
        if not start_dt or not end_dt:
            continue
        parsed.append({
            "status": str(row["status"] or "unknown").strip().lower() or "unknown",
            "started_at": started_at,
            "ended_at": ended_at,
            "start": start_dt,
            "end": end_dt,
        })
    parsed.sort(key=lambda item: item["start"])
    return parsed


def _status_from_intervals_at_point(intervals: List[Dict[str, Any]], point_dt: datetime) -> str | None:
    for interval in intervals:
        if interval["start"] <= point_dt < interval["end"]:
            return interval["status"]
    return None


def _is_mac_manual_event(old_value: Any, new_value: Any) -> bool:
    old_txt = str(old_value or "").strip().upper()
    new_txt = str(new_value or "").strip().upper()
    return old_txt.startswith("MAC:") or new_txt.startswith("MAC:")


def _is_relevant_host_event(event_type: Any, old_value: Any = None, new_value: Any = None) -> bool:
    et = str(event_type or "").strip().lower()
    old_norm = _normalize_availability_status(old_value)
    new_norm = _normalize_availability_status(new_value)

    if et == "status":
        return old_norm in ("online", "offline") and new_norm in ("online", "offline") and old_norm != new_norm
    if et in ("new", "new_silent", "mac", "ip_change", "ip_change_arrived", "delete"):
        return True
    if et == "manual" and _is_mac_manual_event(old_value, new_value):
        return True
    if et in ("notes", "type", "known", "wol", "wol_public", "manual"):
        return False
    return True


def _host_event_label(event_type: Any, new_value: Any = None) -> str:
    et = str(event_type or "").strip().lower()
    nv = str(new_value or "").strip()
    if et == "new":
        return "Nuevo"
    if et == "new_silent":
        return "Silent"
    if et == "status":
        return f"Estado: {nv or '—'}"
    if et == "mac":
        return "MAC"
    if et == "ip_change":
        return "Cambio IP"
    if et == "ip_change_arrived":
        return "Nueva IP"
    if et == "delete":
        return "Eliminado"
    if et == "manual" and _is_mac_manual_event(None, new_value):
        return "MAC"
    return (et or "evento").replace("_", " ").title()


def _host_event_summary(event_type: Any, old_value: Any = None, new_value: Any = None) -> str:
    et = str(event_type or "").strip().lower()
    old_txt = str(old_value or "").strip()
    new_txt = str(new_value or "").strip()

    if et == "new":
        return "Detectado por primera vez"
    if et == "new_silent":
        return "Detectado solo por router"
    if et == "status":
        return f"Estado → {new_txt or '—'}"
    if et == "mac":
        return f"MAC: {old_txt or '—'} → {new_txt or '—'}"
    if et == "ip_change":
        return f"IP: {old_txt or '—'} → {new_txt or '—'}"
    if et == "ip_change_arrived":
        return f"Nueva IP: {new_txt or '—'}"
    if et == "delete":
        return "Host eliminado"
    if et == "manual" and _is_mac_manual_event(old_txt, new_txt):
        if str(new_txt).upper() == "MAC:CLEARED":
            return "MAC limpiada manualmente"
        return f"MAC: {old_txt or '—'} → {new_txt or '—'}"
    if old_txt or new_txt:
        return f"{old_txt or '—'} → {new_txt or '—'}"
    return _host_event_label(et, new_txt)


def _extract_nmap_ports(output: str) -> List[str]:
    ports: List[str] = []
    for line in (output or '').splitlines():
        line = line.strip()
        if not re.match(r'^\d+/(tcp|udp)\s+', line):
            continue
        parts = re.split(r'\s+', line, maxsplit=2)
        if len(parts) >= 2:
            port = parts[0]
            state = parts[1]
            service = parts[2] if len(parts) >= 3 else ''
            ports.append(f"{port} {state} {service}".strip())
    return ports[:12]


def _parse_nmap_fingerprint(output: str) -> Dict[str, Any]:
    text = output or ''
    def _match(pattern: str) -> str:
        m = re.search(pattern, text, re.MULTILINE)
        return (m.group(1).strip() if m else '')

    return {
        'device_type': _match(r'^Device type:\s*(.+)$'),
        'running': _match(r'^Running:\s*(.+)$'),
        'os_details': _match(r'^OS details:\s*(.+)$'),
        'service_info': _match(r'^Service Info:\s*(.+)$'),
        'network_distance': _match(r'^Network Distance:\s*(.+)$'),
        'mac_vendor': _match(r'^MAC Address:\s*[0-9A-F:]+\s*\((.+)\)$'),
        'ports': _extract_nmap_ports(text),
    }


def _build_topbar_networks_from_schema(conn) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    try:
        rows = conn.execute(
            """
            SELECT COALESCE(s.name, '') AS scanner_name,
                   COALESCE(n.label, '') AS network_label,
                   COALESCE(n.cidr, '') AS cidr,
                   COALESCE(n.interface, s.interface, '') AS interface_name,
                   COALESCE(s.enabled, 1) AS scanner_enabled,
                   COALESCE(n.enabled, 1) AS network_enabled
            FROM discovery_scanners s
            JOIN discovery_scanner_networks n ON n.scanner_id = s.id
            ORDER BY COALESCE(s.sort_order, s.id) ASC,
                     COALESCE(n.sort_order, n.id) ASC
            """
        ).fetchall()
    except Exception:
        return []

    seen: set[tuple[str, str]] = set()
    for r in rows:
        if not _boolish(r["scanner_enabled"]) or not _boolish(r["network_enabled"]):
            continue
        cidr = str(r["cidr"] or "").strip()
        if not cidr:
            continue
        label = str(r["network_label"] or "").strip() or str(r["scanner_name"] or "").strip() or "Red"
        key = (label, cidr)
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "label": label,
            "cidr": cidr,
            "interface": str(r["interface_name"] or "").strip(),
        })
    return items


def _build_topbar_networks_legacy(primary_cidr_raw: str, primary_net_label: str, sec_nets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    sec_rows = [dict(r) if not isinstance(r, dict) else r for r in (sec_nets or [])]
    sec_cidrs = {(str(r.get("cidr") or "").strip()) for r in sec_rows if str(r.get("cidr") or "").strip()}
    items: List[Dict[str, Any]] = []
    for c in str(primary_cidr_raw or "").split(','):
        cidr = c.strip()
        if not cidr or cidr in sec_cidrs:
            continue
        items.append({"label": (primary_net_label or '').strip() or 'Principal', "cidr": cidr, "interface": ''})
    for r in sec_rows:
        cidr = str(r.get("cidr") or "").strip()
        if not cidr:
            continue
        items.append({
            "label": str(r.get("label") or "").strip() or 'Secundaria',
            "cidr": cidr,
            "interface": str(r.get("interface") or "").strip(),
        })
    return items


def _fetch_public_wol_hosts(conn) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT p.host_ip AS ip,
               COALESCE(p.public_label, '') AS public_label,
               COALESCE(p.sort_order, 0) AS sort_order,
               COALESCE(h.mac, '') AS mac,
               COALESCE(h.manual_name, '') AS manual_name,
               COALESCE(h.router_hostname, '') AS router_hostname,
               COALESCE(h.nmap_hostname, '') AS nmap_hostname,
               COALESCE(h.dns_name, '') AS dns_name,
               COALESCE(h.status, 'offline') AS status,
               COALESCE(h.router_seen, 0) AS router_seen,
               COALESCE(h.device_type, 'unknown') AS device_type
        FROM public_wol_hosts p
        JOIN hosts h ON h.ip = p.host_ip
        WHERE COALESCE(p.enabled, 1) = 1
        ORDER BY COALESCE(p.sort_order, 0) ASC, p.host_ip ASC
        """
    ).fetchall()

    items: List[Dict[str, Any]] = []
    for r in rows:
        row = dict(r)
        mac = normalize_mac(row.get("mac") or "")
        status = _display_status(row["ip"], row.get("status") or "offline", row.get("router_seen"))
        items.append({
            "ip": row["ip"],
            "name": (row.get("public_label") or "").strip() or _host_display_name(row) or row["ip"],
            "status": status or "offline",
            "device_type": row.get("device_type") or "unknown",
            "wol_ready": bool(mac),
        })
    return items




def _public_wol_allowed(conn, ip: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM public_wol_hosts WHERE host_ip=? AND COALESCE(enabled,1)=1",
        (ip,),
    ).fetchone()
    return bool(row)


def _coerce_probe_payload(payload: Any) -> Dict[str, Any]:
    if isinstance(payload, JSONResponse):
        try:
            raw = payload.body.decode("utf-8") if isinstance(payload.body, (bytes, bytearray)) else str(payload.body)
            data = json.loads(raw or "{}")
        except Exception:
            data = {"ok": False, "error": "Error comprobando estado"}
        if "ok" not in data:
            data["ok"] = False
        return data
    if isinstance(payload, dict):
        return payload
    return {"ok": False, "error": "Error comprobando estado"}

def _send_host_wol(ip: str):
    with db() as conn:
        row = conn.execute("SELECT ip, mac FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return None, JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        mac = row["mac"] or ""
    mac_n = normalize_mac(mac)
    if not mac_n:
        return None, JSONResponse({"ok": False, "error": "No hay MAC válida para este host"}, status_code=400)

    broadcast_ip = (cfg("wol_broadcast", "") or compute_broadcast_from_cidr(cfg("scan_cidr", SCAN_CIDR)))
    try:
        send_wol(mac_n, broadcast_ip, int(cfg("wol_port", WOL_PORT)))
    except Exception as e:
        return None, JSONResponse({"ok": False, "error": f"WOL falló: {e}"}, status_code=500)

    return {
        "ok": True,
        "ip": ip,
        "mac": mac_n,
        "broadcast": broadcast_ip,
        "port": int(cfg("wol_port", WOL_PORT)),
    }, None


def _ping_host_once(ip: str, count: int = 1, timeout_s: int = 2) -> Dict[str, Any]:
    try:
        result = subprocess.run(
            ["ping", "-c", str(max(1, int(count))), "-W", str(max(1, int(timeout_s))), ip],
            capture_output=True,
            text=True,
            timeout=max(3, int(count) * (int(timeout_s) + 1)),
        )
        output = (result.stdout or result.stderr or "").strip()
        m = re.search(r"rtt min/avg/max/mdev = [\d.]+/([\d.]+)/", output)
        avg_ms = float(m.group(1)) if m else None
        loss_m = re.search(r"(\d+)% packet loss", output)
        loss_pct = int(loss_m.group(1)) if loss_m else 100
        return {
            "alive": loss_pct < 100,
            "avg_ms": avg_ms,
            "loss_pct": loss_pct,
            "output": output,
        }
    except subprocess.TimeoutExpired:
        return {"alive": False, "avg_ms": None, "loss_pct": 100, "output": "Timeout"}


def _persist_wol_probe_online(ip: str, avg_ms: Any = None) -> Dict[str, Any]:
    now = utc_now_iso()
    with db() as conn:
        row = conn.execute(
            "SELECT ip, status, last_seen, last_change, COALESCE(router_seen,0) AS router_seen, last_latency_ms FROM hosts WHERE ip=?",
            (ip,),
        ).fetchone()
        if row is None:
            return {"exists": False, "updated": False, "display_status": "offline", "raw_status": ""}

        old_status = (row["status"] or "").strip() or "offline"
        updated = False
        if old_status != "online":
            _add_event(conn, ip, "status", old_status, "online")
            _record_availability_transition(conn, ip, old_status, "online", now)
            conn.execute(
                """
                UPDATE hosts
                SET status='online',
                    router_seen=1,
                    last_seen=?,
                    last_change=?,
                    last_latency_ms=COALESCE(?, last_latency_ms)
                WHERE ip=?
                """,
                (now, now, avg_ms, ip),
            )
            updated = True
        else:
            conn.execute(
                """
                UPDATE hosts
                SET router_seen=1,
                    last_seen=?,
                    last_latency_ms=COALESCE(?, last_latency_ms)
                WHERE ip=?
                """,
                (now, avg_ms, ip),
            )

        refreshed = conn.execute(
            "SELECT status, last_seen, last_change, COALESCE(router_seen,0) AS router_seen, last_latency_ms FROM hosts WHERE ip=?",
            (ip,),
        ).fetchone()

    return {
        "exists": True,
        "updated": updated,
        "raw_status": (refreshed["status"] if refreshed else old_status) or old_status,
        "display_status": _display_status(ip, (refreshed["status"] if refreshed else old_status) or old_status, refreshed["router_seen"] if refreshed else row["router_seen"], refreshed["last_seen"] if refreshed else row["last_seen"]),
        "last_seen": refreshed["last_seen"] if refreshed else row["last_seen"],
        "last_seen_local": to_local_str(refreshed["last_seen"] if refreshed else row["last_seen"]),
        "last_change": refreshed["last_change"] if refreshed else row["last_change"],
        "last_change_local": to_local_str(refreshed["last_change"] if refreshed else row["last_change"]),
        "last_latency_ms": refreshed["last_latency_ms"] if refreshed else row["last_latency_ms"],
    }


def _probe_wol_status(ip: str) -> Dict[str, Any] | JSONResponse:
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)

    probe = _ping_host_once(ip, count=1, timeout_s=2)
    host_state: Dict[str, Any]
    if probe["alive"]:
        host_state = _persist_wol_probe_online(ip, probe.get("avg_ms"))
        if not host_state.get("exists"):
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
    else:
        with db() as conn:
            row = conn.execute(
                "SELECT status, last_seen, last_change, COALESCE(router_seen,0) AS router_seen, last_latency_ms FROM hosts WHERE ip=?",
                (ip,),
            ).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        raw_status = (row["status"] or "").strip() or "offline"
        host_state = {
            "exists": True,
            "updated": False,
            "raw_status": raw_status,
            "display_status": _display_status(ip, raw_status, row["router_seen"], row["last_seen"]),
            "last_seen": row["last_seen"],
            "last_seen_local": to_local_str(row["last_seen"]),
            "last_change": row["last_change"],
            "last_change_local": to_local_str(row["last_change"]),
            "last_latency_ms": row["last_latency_ms"],
        }

    return {
        "ok": True,
        "ip": ip,
        "alive": probe["alive"],
        "avg_ms": probe.get("avg_ms"),
        "loss_pct": probe.get("loss_pct"),
        "output": probe.get("output") or "",
        "host_status": host_state.get("display_status"),
        "host_status_raw": host_state.get("raw_status"),
        "last_seen": host_state.get("last_seen"),
        "last_seen_local": host_state.get("last_seen_local"),
        "last_change": host_state.get("last_change"),
        "last_change_local": host_state.get("last_change_local"),
        "last_latency_ms": host_state.get("last_latency_ms"),
        "db_updated": bool(host_state.get("updated")),
    }


# ══════════════════════════════════════════════════════════════
#  Home page
# ══════════════════════════════════════════════════════════════

@router.get("/", response_class=HTMLResponse)
def home(request: Request):
    token    = request.cookies.get(SESSION_COOKIE)
    enabled  = auth_enabled(DB_PATH)
    username = validate_session(DB_PATH, token) if enabled else None
    app_tz   = get_app_tz(cfg("app_tz", "Europe/Madrid"))

    with db() as conn:
        types = conn.execute("SELECT id, name, icon FROM host_types ORDER BY name ASC").fetchall()
        owners = _host_owner_rows(conn)
        rows  = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes,
                   h.first_seen, h.last_seen, h.last_change, h.status,
                   h.type_id, h.owner_id, h.known,
                   COALESCE(t.name,'') AS type_name, COALESCE(t.icon,'') AS type_icon,
                   COALESCE(o.name,'') AS owner_name, COALESCE(o.color,'') AS owner_color,
                   COALESCE(o.enabled,1) AS owner_enabled,
                   h.last_latency_ms, COALESCE(h.vendor,'') AS vendor, COALESCE(h.tags,'') AS tags,
                   COALESCE(h.router_hostname,'') AS router_hostname,
                   COALESCE(h.ip_assignment,'') AS ip_assignment,
                   h.dhcp_lease_expires, COALESCE(h.router_seen,0) AS router_seen,
                   COALESCE(h.device_type,'unknown') AS device_type,
                   COALESCE(h.device_confidence,0) AS device_confidence,
                   COALESCE(h.device_source,'') AS device_source,
                   h.device_updated_at
            FROM hosts h
            LEFT JOIN host_types t ON t.id = h.type_id
            LEFT JOIN host_owners o ON o.id = h.owner_id
            ORDER BY h.status DESC, h.last_seen DESC
        """).fetchall()
        alerts_count = conn.execute("SELECT COUNT(*) c FROM alerts WHERE enabled=1").fetchone()["c"]
        # Secondary networks for host color-coding in the template
        sec_nets = conn.execute(
            "SELECT id, label, cidr, interface, enabled FROM secondary_networks WHERE enabled=1 ORDER BY id ASC"
        ).fetchall()

    from auth_middleware import SESSION_TTL_HOURS
    auth_sections = [s.strip() for s in cfg("auth_sections", "config,alertas").split(",") if s.strip()]

    # Build topbar network entries preferring schema discovery scanners.
    primary_cidr_raw  = cfg("scan_cidr", SCAN_CIDR)
    primary_net_label = cfg("primary_net_label", "") or ""
    sec_cidrs         = {(r["cidr"] or "").strip() for r in sec_nets}
    primary_nets = [
        {"cidr": c.strip(), "label": primary_net_label}
        for c in primary_cidr_raw.split(",")
        if c.strip() and c.strip() not in sec_cidrs
    ]
    topbar_networks = _build_topbar_networks_from_schema(conn)
    if not topbar_networks:
        topbar_networks = _build_topbar_networks_legacy(primary_cidr_raw, primary_net_label, [dict(r) for r in sec_nets])

    hosts = []
    for r in rows:
        hosts.append({
            "ip": r["ip"], "mac": r["mac"] or "",
            "nmap_hostname": r["nmap_hostname"] or "", "dns_name": r["dns_name"] or "",
            "manual_name": r["manual_name"] or "", "notes": r["notes"] or "",
            "type_id": r["type_id"], "type_name": r["type_name"] or "",
            "type_icon": r["type_icon"] or "",
            "owner_id": r["owner_id"], "owner_name": r["owner_name"] or "",
            "owner_color": r["owner_color"] or "", "owner_enabled": _boolish(r["owner_enabled"]),
            "last_latency_ms": r["last_latency_ms"],
            "vendor": r["vendor"] or "", "tags": r["tags"] or "",
            "last_change_raw": r["last_change"] or "",
            "first_seen": to_local_str(r["first_seen"]),
            "last_seen":  to_local_str(r["last_seen"]),
            "last_change": to_local_str(r["last_change"]),
            "seen_ago": human_since(r["last_seen"]),
            "status": _display_status(r["ip"], r["status"] or "", r["router_seen"], r["last_seen"]),
            "raw_status": r["status"] or "",
            "known": _boolish(r["known"]),
            "router_hostname": r["router_hostname"] or "",
            "ip_assignment": r["ip_assignment"] or "",
            "dhcp_lease_expires": r["dhcp_lease_expires"] or "",
            "router_seen": _boolish(r["router_seen"]),
            "device_type": (r["device_type"] or "unknown"),
            "device_confidence": float(r["device_confidence"] or 0.0),
            "device_source": r["device_source"] or "",
            "device_updated_at": r["device_updated_at"] or "",
        })

    return templates.TemplateResponse("index.html", {
        "request":           request,
        "hosts":             hosts,
        "types":             [dict(t) for t in types],
        "owners":            owners,
        "scan_cidr":         primary_cidr_raw,
        "primary_nets":      primary_nets,
        "secondary_nets":    [dict(r) for r in sec_nets],
        "primary_net_label": primary_net_label,
        "topbar_networks":    topbar_networks,
        "alerts_count":      alerts_count,
        "auth_enabled":      enabled,
        "is_logged_in":      bool(username),
        "is_admin":          bool(username) or not enabled,
        "router_enabled":    cfg("router_enabled", "0") == "1",
        "frontend_refresh_interval_seconds": cfg("frontend_refresh_interval_seconds", "30"),
        "frontend_dashboard_refresh_interval_seconds": cfg("frontend_dashboard_refresh_interval_seconds", "60"),
        "frontend_history_limit": cfg("frontend_history_limit", "5000"),
        "frontend_detail_history_limit": cfg("frontend_detail_history_limit", "20000"),
        "frontend_table_rows_limit": cfg("frontend_table_rows_limit", "2000"),
        "frontend_export_rows_limit": cfg("frontend_export_rows_limit", "5000"),
        "service_check_timeout_seconds": cfg("service_check_timeout_seconds", "8"),
        "service_info_timeout_seconds": cfg("service_info_timeout_seconds", "6"),
        "script_ai_cloud_timeout_seconds": cfg("script_ai_cloud_timeout_seconds", "30"),
        "script_ai_local_timeout_seconds": cfg("script_ai_local_timeout_seconds", "180"),
        "script_ai_frontend_timeout_seconds": cfg("script_ai_frontend_timeout_seconds", "135"),
        "script_report_timeout_seconds": cfg("script_report_timeout_seconds", "120"),
        "wol_tracker_timeout_seconds": cfg("wol_tracker_timeout_seconds", "120"),
        "current_user":      username or "",
        "auth_sections":     auth_sections,
        "session_ttl":       SESSION_TTL_HOURS,
    })


# ══════════════════════════════════════════════════════════════
#  Hosts CRUD
# ══════════════════════════════════════════════════════════════

@router.get("/api/hosts")
def api_hosts():
    """Listado base de hosts para frontend/prefetch."""
    with db() as conn:
        types = conn.execute("SELECT id, name, icon FROM host_types ORDER BY name ASC").fetchall()
        owners = _host_owner_rows(conn)
        rows = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes,
                   h.first_seen, h.last_seen, h.last_change, h.status,
                   h.type_id, h.owner_id, h.known,
                   COALESCE(t.name,'') AS type_name, COALESCE(t.icon,'') AS type_icon,
                   COALESCE(o.name,'') AS owner_name, COALESCE(o.color,'') AS owner_color,
                   COALESCE(o.enabled,1) AS owner_enabled,
                   h.last_latency_ms, COALESCE(h.vendor,'') AS vendor, COALESCE(h.tags,'') AS tags,
                   COALESCE(h.router_hostname,'') AS router_hostname,
                   COALESCE(h.ip_assignment,'') AS ip_assignment,
                   h.dhcp_lease_expires, COALESCE(h.router_seen,0) AS router_seen,
                   COALESCE(h.device_type,'unknown') AS device_type,
                   COALESCE(h.device_confidence,0) AS device_confidence,
                   COALESCE(h.device_source,'') AS device_source,
                   h.device_updated_at
            FROM hosts h
            LEFT JOIN host_types t ON t.id = h.type_id
            LEFT JOIN host_owners o ON o.id = h.owner_id
            ORDER BY h.status DESC, h.last_seen DESC
        """).fetchall()

    hosts = []
    for r in rows:
        hosts.append({
            "ip": r["ip"], "mac": r["mac"] or "",
            "nmap_hostname": r["nmap_hostname"] or "", "dns_name": r["dns_name"] or "",
            "manual_name": r["manual_name"] or "", "notes": r["notes"] or "",
            "type_id": r["type_id"], "type_name": r["type_name"] or "",
            "type_icon": r["type_icon"] or "",
            "owner_id": r["owner_id"], "owner_name": r["owner_name"] or "",
            "owner_color": r["owner_color"] or "", "owner_enabled": _boolish(r["owner_enabled"]),
            "last_latency_ms": r["last_latency_ms"],
            "vendor": r["vendor"] or "", "tags": r["tags"] or "",
            "last_change_raw": r["last_change"] or "",
            "first_seen": to_local_str(r["first_seen"]),
            "last_seen": to_local_str(r["last_seen"]),
            "last_change": to_local_str(r["last_change"]),
            "seen_ago": human_since(r["last_seen"]),
            "status": _display_status(r["ip"], r["status"] or "", r["router_seen"], r["last_seen"]),
            "raw_status": r["status"] or "",
            "known": _boolish(r["known"]),
            "router_hostname": r["router_hostname"] or "",
            "ip_assignment": r["ip_assignment"] or "",
            "dhcp_lease_expires": r["dhcp_lease_expires"] or "",
            "router_seen": _boolish(r["router_seen"]),
            "device_type": (r["device_type"] or "unknown"),
            "device_confidence": float(r["device_confidence"] or 0.0),
            "device_source": r["device_source"] or "",
            "device_updated_at": r["device_updated_at"] or "",
        })

    return {"ok": True, "hosts": hosts, "types": [dict(t) for t in types], "owners": owners}


@router.get("/api/status")
def api_status():
    with db() as conn:
        host_rows = conn.execute("SELECT ip, status, known, COALESCE(router_seen,0) AS router_seen, mac, manual_name, nmap_hostname, first_seen, last_seen FROM hosts").fetchall()
        online = 0
        offline = 0
        unknown = 0
        for r in host_rows:
            disp = _display_status(r["ip"], r["status"] or "", r["router_seen"], r["last_seen"])
            if disp in ("online", "online_silent"):
                online += 1
                if not _boolish(r["known"]):
                    unknown += 1
            else:
                offline += 1
        recent_new = [
            {"ip": r["ip"], "mac": r["mac"], "manual_name": r["manual_name"], "nmap_hostname": r["nmap_hostname"], "known": r["known"]}
            for r in sorted(host_rows, key=lambda x: x["first_seen"] or '', reverse=True)
            if (r["status"] or '') in ('online', 'online_silent')
        ][:10]
        last_scan = conn.execute(
            "SELECT started_at, finished_at, new_hosts FROM scans ORDER BY id DESC LIMIT 1"
        ).fetchone()
        types = conn.execute("SELECT id, name, icon FROM host_types ORDER BY name ASC").fetchall()

    try:
        scan_interval = max(30, int(cfg("scan_interval", "900") or 900))
    except Exception:
        scan_interval = 900

    next_scan_at = None
    next_scan_in_s = None
    server_now = utc_now_iso()
    try:
        if last_scan and last_scan["finished_at"]:
            finished_dt = datetime.fromisoformat(str(last_scan["finished_at"]).replace("Z", "+00:00"))
            next_scan_dt = finished_dt + timedelta(seconds=scan_interval)
            next_scan_at = next_scan_dt.isoformat()
            try:
                now_dt = datetime.fromisoformat(str(server_now).replace("Z", "+00:00"))
                next_scan_in_s = max(0, int((next_scan_dt - now_dt).total_seconds()))
            except Exception:
                next_scan_in_s = None
    except Exception:
        next_scan_at = None
        next_scan_in_s = None

    return {
        "ok": True, "online": online, "offline": offline,
        "unknown_online": unknown, "total": online + offline,
        "scan_interval": scan_interval,
        "next_scan_at": next_scan_at,
        "next_scan_in_s": next_scan_in_s,
        "server_now": server_now,
        "last_scan": {
            "started_at": last_scan["started_at"] if last_scan else None,
            "finished_at": last_scan["finished_at"] if last_scan else None,
            "new_hosts":  last_scan["new_hosts"] if last_scan else 0,
        } if last_scan else None,
        "recent_new": recent_new,
        "types": [dict(t) for t in types],
    }


@router.get("/api/dashboard")
def api_dashboard(days: int = 14):
    services_module_enabled = module_enabled("services")
    try:
        with db() as conn:
            total_hosts   = conn.execute("SELECT COUNT(*) c FROM hosts").fetchone()["c"]
            online_hosts  = conn.execute("SELECT COUNT(*) c FROM hosts WHERE status='online'").fetchone()["c"]
            offline_hosts = conn.execute("SELECT COUNT(*) c FROM hosts WHERE status='offline'").fetchone()["c"]
            unknown_hosts = conn.execute("SELECT COUNT(*) c FROM hosts WHERE status='online' AND known=0").fetchone()["c"]

            try:
                uptime_avg = conn.execute("""
                    SELECT AVG(pct) avg FROM (
                        SELECT ip, SUM(online_seconds)*100.0/(SUM(online_seconds)+SUM(offline_seconds)) AS pct
                        FROM host_uptime WHERE date >= date('now','-7 days')
                        GROUP BY ip HAVING SUM(online_seconds)+SUM(offline_seconds) > 0
                    )
                """).fetchone()["avg"]
            except Exception:
                uptime_avg = None

            try:
                lat_avg = conn.execute(
                    "SELECT AVG(last_latency_ms) avg FROM hosts WHERE status='online' AND last_latency_ms IS NOT NULL"
                ).fetchone()["avg"]
                top_lat = conn.execute("""
                    SELECT ip, COALESCE(manual_name,nmap_hostname,dns_name,ip) AS name, last_latency_ms
                    FROM hosts WHERE status='online' AND last_latency_ms IS NOT NULL
                    ORDER BY last_latency_ms DESC LIMIT 5
                """).fetchall()
            except Exception:
                lat_avg = None; top_lat = []

            if services_module_enabled:
                try:
                    svcs = conn.execute("""
                        SELECT s.id, s.name, s.host, s.port, s.service_type, s.access_url,
                               sl.status AS last_status, sc.latency_ms AS last_latency
                        FROM services s
                        LEFT JOIN service_last_status sl ON sl.service_id = s.id
                        LEFT JOIN service_checks sc ON sc.id = (
                            SELECT id FROM service_checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1)
                        WHERE s.enabled=1 ORDER BY s.name
                    """).fetchall()
                except Exception:
                    svcs = []
            else:
                svcs = []

            svc_up   = sum(1 for s in svcs if s["last_status"] == "up")
            svc_down = sum(1 for s in svcs if s["last_status"] in ("down", "timeout"))

            try:
                dash_cutoff = (utc_now() - timedelta(days=max(1, int(days)))).strftime('%Y-%m-%dT%H:%M:%S')
                if int(days) == 1:
                    recent_scans = conn.execute("""
                        SELECT finished_at AS day, online_hosts AS avg_online,
                               offline_hosts AS avg_offline,
                               online_hosts AS max_online, online_hosts AS min_online
                        FROM scans WHERE substr(started_at,1,19) >= ?
                        ORDER BY started_at ASC
                    """, (dash_cutoff,)).fetchall()
                else:
                    recent_scans = conn.execute("""
                        SELECT date(substr(started_at,1,10)) day,
                               ROUND(AVG(online_hosts),1) avg_online,
                               ROUND(AVG(offline_hosts),1) avg_offline,
                               MAX(online_hosts) max_online, MIN(online_hosts) min_online
                        FROM scans WHERE substr(started_at,1,19) >= ?
                        GROUP BY day ORDER BY day ASC
                    """, (dash_cutoff,)).fetchall()
            except Exception:
                recent_scans = []

            try:
                recent_events = conn.execute("""
                    SELECT e.ip, e.at, e.event_type, e.new_value,
                           COALESCE(h.manual_name,h.nmap_hostname,h.dns_name,e.ip) AS host_name
                    FROM host_events e LEFT JOIN hosts h ON h.ip=e.ip
                    WHERE e.at >= datetime('now','-24 hours')
                      AND e.event_type IN ('status','new','ip_change','mac')
                    ORDER BY e.at DESC LIMIT 25
                """).fetchall()
            except Exception:
                recent_events = []

            try:
                long_offline = conn.execute("""
                    SELECT ip, COALESCE(manual_name,nmap_hostname,dns_name,ip) AS name, last_change
                    FROM hosts WHERE status='offline' ORDER BY last_change ASC LIMIT 8
                """).fetchall()
            except Exception:
                long_offline = []

            scans_today = conn.execute(
                "SELECT COUNT(*) c FROM scans WHERE started_at >= date('now')"
            ).fetchone()["c"]

    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    return {
        "ok": True,
        "hosts": {"total": total_hosts, "online": online_hosts,
                  "offline": offline_hosts, "unknown": unknown_hosts},
        "uptime_avg_7d": round(uptime_avg, 1) if uptime_avg else None,
        "latency_avg_ms": round(lat_avg, 1) if lat_avg else None,
        "top_latency": [dict(r) for r in top_lat],
        "services": {"total": len(svcs), "up": svc_up, "down": svc_down,
                     "enabled": services_module_enabled,
                     "disabled": not services_module_enabled,
                     "list": [dict(s) for s in svcs]},
        "recent_scans": [dict(r) for r in recent_scans],
        "recent_events": [{"ip": r["ip"], "at_local": to_local_str(r["at"]),
                           "event_type": r["event_type"], "new_value": r["new_value"],
                           "host_name": r["host_name"]} for r in recent_events],
        "long_offline": [{"ip": r["ip"], "name": r["name"],
                          "since": to_local_str(r["last_change"]),
                          "ago": human_since(r["last_change"])} for r in long_offline],
        "scans_today": scans_today,
    }


@router.get("/api/hosts/{ip}/detail")
def host_detail(ip: str):
    with db() as conn:
        host = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes, h.type_id,
                   h.owner_id,
                   h.first_seen, h.last_seen, h.last_change, h.status, h.known, h.last_latency_ms,
                   COALESCE(t.name,'') AS type_name,
                   COALESCE(o.name,'') AS owner_name, COALESCE(o.color,'') AS owner_color,
                   COALESCE(o.enabled,1) AS owner_enabled,
                   COALESCE(h.vendor,'') AS vendor,
                   COALESCE(h.tags,'') AS tags,
                   COALESCE(h.router_hostname,'') AS router_hostname,
                   COALESCE(h.ip_assignment,'') AS ip_assignment,
                   h.dhcp_lease_expires, COALESCE(h.router_seen,0) AS router_seen,
                   COALESCE(h.device_type,'unknown') AS device_type,
                   COALESCE(h.device_confidence,0) AS device_confidence,
                   COALESCE(h.device_source,'') AS device_source,
                   COALESCE(h.device_evidence,'[]') AS device_evidence,
                   h.device_updated_at
            FROM hosts h
            LEFT JOIN host_types t ON t.id = h.type_id
            LEFT JOIN host_owners o ON o.id = h.owner_id
            WHERE h.ip=?
        """, (ip,)).fetchone()
        if host is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        events = conn.execute("""
            SELECT at, event_type, old_value, new_value FROM host_events
            WHERE ip=? ORDER BY id DESC LIMIT 100
        """, (ip,)).fetchall()
        latest_interval = conn.execute("""
            SELECT status, started_at, ended_at
            FROM host_availability_intervals
            WHERE ip=?
            ORDER BY CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END ASC, started_at DESC, id DESC
            LIMIT 1
        """, (ip,)).fetchone()

    h = dict(host)
    h["raw_status"] = h.get("status") or ""
    h["status"] = _display_status(h.get("ip"), h.get("status") or "", h.get("router_seen"), h.get("last_seen"))
    h["first_seen_local"] = to_local_str(h.get("first_seen"))
    h["last_seen_local"] = to_local_str(h.get("last_seen"))
    h["last_change_raw"] = h.get("last_change") or ""
    h["last_change_local"] = to_local_str(h.get("last_change"))
    h["seen_ago"] = human_since(h.get("last_seen"))
    h["known"] = _boolish(h.get("known"))
    h["owner_enabled"] = _boolish(h.get("owner_enabled"))
    h["device_type"] = (h.get("device_type") or "unknown").strip() or "unknown"
    try:
        h["device_confidence"] = float(h.get("device_confidence") or 0.0)
    except Exception:
        h["device_confidence"] = 0.0
    h["device_source"] = h.get("device_source") or ""
    h["device_evidence"] = decode_device_evidence(h.get("device_evidence"))
    h["device_updated_at_local"] = to_local_str(h.get("device_updated_at"))

    h["current_interval_status"] = ""
    h["current_interval_started_at"] = ""
    h["current_interval_started_at_local"] = ""
    if latest_interval:
        h["current_interval_status"] = str(latest_interval["status"] or "").strip().lower()
        h["current_interval_started_at"] = latest_interval["started_at"] or ""
        h["current_interval_started_at_local"] = to_local_str(latest_interval["started_at"])

    all_events = []
    for e in events:
        item = {
            "at": e["at"],
            "at_local": to_local_str(e["at"]),
            "event_type": e["event_type"],
            "old_value": e["old_value"] or "",
            "new_value": e["new_value"] or "",
        }
        item["relevant"] = _is_relevant_host_event(item["event_type"], item["old_value"], item["new_value"])
        item["label"] = _host_event_label(item["event_type"], item["new_value"])
        item["summary"] = _host_event_summary(item["event_type"], item["old_value"], item["new_value"])
        all_events.append(item)

    relevant_events = [e for e in all_events if e.get("relevant")]
    last_relevant = relevant_events[0] if relevant_events else None
    if last_relevant:
        h["last_relevant_change_at"] = last_relevant["at"]
        h["last_relevant_change_at_local"] = last_relevant["at_local"]
        h["last_relevant_change_kind"] = last_relevant["event_type"]
        h["last_relevant_change_label"] = last_relevant["label"]
        h["last_relevant_change_text"] = last_relevant["summary"]
        h["last_change_display"] = f"{last_relevant['summary']} · {last_relevant['at_local']}"
    else:
        h["last_relevant_change_at"] = h.get("last_change")
        h["last_relevant_change_at_local"] = h.get("last_change_local")
        h["last_relevant_change_kind"] = ""
        h["last_relevant_change_label"] = "Último cambio"
        h["last_relevant_change_text"] = "Sin cambios relevantes recientes"
        h["last_change_display"] = h.get("last_change_local") or "—"

    return {
        "ok": True,
        "host": h,
        "events": relevant_events,
        "events_relevant_count": len(relevant_events),
        "events_all_count": len(all_events),
        "events_all": all_events,
    }


@router.put("/api/hosts/{ip}")
def update_host(ip: str, payload: Dict[str, Any] = Body(...)):
    manual_name = (payload.get("manual_name") or "").strip()
    notes       = (payload.get("notes") or "").strip()
    type_id     = payload.get("type_id", None)
    owner_present = "owner_id" in payload
    owner_id_raw = payload.get("owner_id", None)
    owner_id = None
    known       = payload.get("known", None)
    if type_id is not None:
        try:
            type_id = int(type_id)
        except Exception:
            return JSONResponse({"ok": False, "error": "type_id inválido"}, status_code=400)
    if owner_present and owner_id_raw not in (None, ""):
        try:
            owner_id = int(owner_id_raw)
        except Exception:
            return JSONResponse({"ok": False, "error": "owner_id inválido"}, status_code=400)
    with db() as conn:
        if owner_present and owner_id is not None:
            owner_row = conn.execute("SELECT id FROM host_owners WHERE id=?", (owner_id,)).fetchone()
            if not owner_row:
                return JSONResponse({"ok": False, "error": "Responsable no encontrado"}, status_code=404)
        row = conn.execute(
            "SELECT ip, manual_name, notes, type_id, owner_id, known FROM hosts WHERE ip=?", (ip,)
        ).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        if (row["manual_name"] or "") != (manual_name or ""):
            _add_event(conn, ip, "manual", row["manual_name"], manual_name)
        if (row["notes"] or "") != (notes or ""):
            _add_event(conn, ip, "notes", row["notes"], notes)
        if type_id is not None and row["type_id"] != type_id:
            _add_event(conn, ip, "type", str(row["type_id"] or ""), str(type_id))
        if owner_present and (row["owner_id"] or None) != owner_id:
            _add_event(conn, ip, "owner", str(row["owner_id"] or ""), str(owner_id or ""))
        if known is not None:
            known_int = 1 if known else 0
            if (row["known"] or 0) != known_int:
                _add_event(conn, ip, "known", str(row["known"] or 0), str(known_int))
        extra_clause = ""
        params: list = [manual_name or None, notes or None, type_id]
        if owner_present:
            extra_clause += ", owner_id=?"
            params.append(owner_id)
        if known is not None:
            extra_clause += ", known=?"
            params.append(1 if known else 0)
        params.append(ip)
        conn.execute(
            f"UPDATE hosts SET manual_name=?, notes=?, type_id=COALESCE(?,type_id){extra_clause} WHERE ip=?",
            params,
        )
    return {"ok": True}


@router.post("/api/hosts/{ip}/known")
def toggle_known(ip: str, payload: Dict[str, Any] = Body(...)):
    known = _boolish(payload.get("known", True))
    with db() as conn:
        row = conn.execute("SELECT ip, known FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        prev_known = _boolish(row["known"])
        if prev_known != known:
            _add_event(conn, ip, "known", "1" if prev_known else "0", "1" if known else "0")
            conn.execute("UPDATE hosts SET known=? WHERE ip=?", (1 if known else 0, ip))
    return {"ok": True, "ip": ip, "known": known}


@router.delete("/api/hosts/{ip}")
def delete_host(ip: str):
    with db() as conn:
        row = conn.execute("SELECT ip FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        _add_event(conn, ip, "delete", None, "deleted")
        conn.execute("DELETE FROM hosts WHERE ip=?", (ip,))
    return {"ok": True, "ip": ip}


@router.post("/api/hosts/{ip}/clear-mac")
def clear_host_mac(ip: str):
    with db() as conn:
        row = conn.execute("SELECT ip, mac FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        old_mac = row["mac"] or ""
        if old_mac:
            _add_event(conn, ip, "manual", f"MAC:{old_mac}", "MAC:cleared")
        conn.execute("UPDATE hosts SET mac=NULL, vendor=NULL WHERE ip=?", (ip,))
    return {"ok": True, "ip": ip, "old_mac": old_mac}


@router.post("/api/hosts/{ip}/ping")
def ping_host(ip: str):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)

    with db() as conn:
        row = conn.execute("SELECT ip FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)

    probe = _ping_host_once(ip, count=1, timeout_s=2)
    host_state: Dict[str, Any] | None = None
    if probe.get('alive'):
        host_state = _persist_wol_probe_online(ip, probe.get('avg_ms'))

    lines = [ln for ln in str(probe.get('output') or '').splitlines() if ln.strip()]
    return {
        "ok": True,
        "ip": ip,
        "alive": bool(probe.get('alive')),
        "avg_ms": probe.get('avg_ms'),
        "loss_pct": probe.get('loss_pct'),
        "lines": lines[:12],
        "host_status": host_state.get('display_status') if host_state else None,
        "point_in_time": True,
        "packet_count": 1,
    }


@router.post("/api/hosts/{ip}/fingerprint")
def fingerprint_host(ip: str):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)

    with db() as conn:
        host_row = conn.execute(
            """
            SELECT ip, mac, nmap_hostname, dns_name, router_hostname,
                   COALESCE(vendor, '') AS vendor,
                   COALESCE(ip_assignment, '') AS ip_assignment,
                   COALESCE(device_type, 'unknown') AS device_type,
                   COALESCE(device_confidence, 0) AS device_confidence,
                   COALESCE(device_source, '') AS device_source
            FROM hosts WHERE ip=?
            """,
            (ip,),
        ).fetchone()
        if host_row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)

    # Usar el mismo pipeline que el enriquecimiento automático:
    # dos pasadas nmap (servicios + OS) + clasificación enriquecida con señales de puertos/OS.
    try:
        fp, os_completed = run_manual_fingerprint(ip)
    except FileNotFoundError:
        return JSONResponse({"ok": False, "error": "nmap no está disponible en el runtime"}, status_code=500)
    except subprocess.TimeoutExpired:
        return JSONResponse({"ok": False, "error": "La identificación tardó demasiado"}, status_code=504)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Error ejecutando nmap: {e}"}, status_code=500)

    # derive_vendor_from_fingerprint usa una función oui_lookup; pasamos la existente del módulo.
    _, new_vendor, _ = derive_vendor_from_fingerprint(host_row, fp, _oui_lookup)

    classification = classify_with_fingerprint(
        host_row,
        fp,
        new_vendor or (host_row["vendor"] or ""),
        fingerprint_kind="fingerprint_manual",
    )

    # summary compatible con el frontend existente (campos que ya se mostraban)
    summary = {
        "device_type": fp.get("device_type") or "",
        "running": fp.get("os_guess") or "",
        "os_details": fp.get("os_guess") or "",
        "os_cpe": fp.get("os_cpe") or "",
        "service_info": ", ".join(
            f"{s['port']}/{s['proto']} {s['name']}"
            for s in (fp.get("services") or [])
            if s.get("name")
        ) or "",
        "network_distance": "",
        "mac_vendor": new_vendor or (host_row["vendor"] or ""),
        "ports": [
            f"{s['port']}/tcp open {s['name']} {s.get('version','')}" .strip()
            for s in (fp.get("services") or [])
        ][:12],
    }

    return {
        "ok": True,
        "ip": ip,
        "summary": summary,
        "classification": classification,
        "output_lines": fp.get("raw_lines") or [],
        "returncode": 0,
        "os_completed": os_completed,
        "point_in_time": True,
        "applied": False,
    }


@router.post("/api/hosts/{ip}/apply-classification")
def apply_classification(ip: str, payload: Dict[str, Any] = Body(...)):
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return JSONResponse({"ok": False, "error": "IP inválida"}, status_code=400)

    device_type = str(payload.get("device_type") or "unknown").strip() or "unknown"
    device_confidence = float(payload.get("device_confidence") or 0.0)
    device_source = str(payload.get("device_source") or "fingerprint_manual").strip()
    device_evidence = payload.get("device_evidence") or []
    if not isinstance(device_evidence, list):
        device_evidence = []
    try:
        device_evidence_json = json.dumps(device_evidence)
    except Exception:
        device_evidence_json = "[]"

    now = utc_now_iso()
    with db() as conn:
        row = conn.execute("SELECT ip FROM hosts WHERE ip=?", (ip,)).fetchone()
        if row is None:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)
        conn.execute(
            """
            UPDATE hosts
            SET device_type=?,
                device_confidence=?,
                device_source=?,
                device_evidence=?,
                device_updated_at=?
            WHERE ip=?
            """,
            (device_type, device_confidence, device_source,
             device_evidence_json, now, ip),
        )

    return {
        "ok": True,
        "ip": ip,
        "device_type": device_type,
        "device_confidence": device_confidence,
        "device_source": device_source,
        "applied": True,
    }


@router.post("/api/hosts/bulk-clear-mac")
def bulk_clear_old_macs(payload: Dict[str, Any] = Body(...)):
    days   = int(payload.get("days", 30))
    cutoff = (utc_now() - timedelta(days=days)).isoformat()
    with db() as conn:
        rows = conn.execute(
            "SELECT ip, mac FROM hosts WHERE status='offline' AND (last_seen < ? OR last_seen IS NULL) AND mac IS NOT NULL",
            (cutoff,),
        ).fetchall()
        cleared = []
        for row in rows:
            _add_event(conn, row["ip"], "manual", f"MAC:{row['mac']}", "MAC:cleared")
            conn.execute("UPDATE hosts SET mac=NULL, vendor=NULL WHERE ip=?", (row["ip"],))
            cleared.append(row["ip"])
    return {"ok": True, "cleared": cleared, "count": len(cleared)}


@router.get("/wol", response_class=HTMLResponse)
def public_wol_page(request: Request):
    if cfg("wol_public", "0") != "1":
        return JSONResponse({"ok": False, "error": "WoL público deshabilitado"}, status_code=404)

    with db() as conn:
        items = _fetch_public_wol_hosts(conn)

    return templates.TemplateResponse("wol_public.html", {
        "request": request,
        "wol_hosts": items,
    })


@router.get("/api/public/wol/hosts")
def api_public_wol_hosts(probe_ip: str | None = Query(default=None)):
    if cfg("wol_public", "0") != "1":
        return JSONResponse({"ok": False, "error": "WoL público deshabilitado"}, status_code=404)

    probe_payload: Dict[str, Any] | None = None
    probe_ip = (probe_ip or "").strip()

    if probe_ip:
        try:
            ipaddress.ip_address(probe_ip)
        except ValueError:
            probe_payload = {"ok": False, "error": "IP inválida"}
        else:
            with db() as conn:
                allowed = _public_wol_allowed(conn, probe_ip)
            if not allowed:
                probe_payload = {"ok": False, "error": "Equipo no autorizado para WoL público"}
            else:
                probe_payload = _coerce_probe_payload(_probe_wol_status(probe_ip))

    with db() as conn:
        items = _fetch_public_wol_hosts(conn)

    payload: Dict[str, Any] = {"ok": True, "hosts": items}
    if probe_payload is not None:
        payload["probe"] = probe_payload
    return payload


@router.post("/api/public/wol/{ip}/wake")
def api_public_wol_wake(ip: str):
    if cfg("wol_public", "0") != "1":
        return JSONResponse({"ok": False, "error": "WoL público deshabilitado"}, status_code=404)

    with db() as conn:
        allowed = conn.execute(
            "SELECT host_ip FROM public_wol_hosts WHERE host_ip=? AND COALESCE(enabled,1)=1",
            (ip,),
        ).fetchone()
    if not allowed:
        return JSONResponse({"ok": False, "error": "Equipo no autorizado para WoL público"}, status_code=403)

    payload, error = _send_host_wol(ip)
    if error:
        return error

    with db() as conn:
        _add_event(conn, ip, "wol_public", None, f"public page wake mac={payload['mac']}")

    return payload


@router.post("/api/public/wol/{ip}/status")
def api_public_wol_status(ip: str):
    if cfg("wol_public", "0") != "1":
        return JSONResponse({"ok": False, "error": "WoL público deshabilitado"}, status_code=404)

    with db() as conn:
        allowed = conn.execute(
            "SELECT host_ip FROM public_wol_hosts WHERE host_ip=? AND COALESCE(enabled,1)=1",
            (ip,),
        ).fetchone()
    if not allowed:
        return JSONResponse({"ok": False, "error": "Equipo no autorizado para WoL público"}, status_code=403)

    return _probe_wol_status(ip)


@router.post("/api/hosts/{ip}/wol")
def wol_host(ip: str):
    payload, error = _send_host_wol(ip)
    if error:
        return error
    with db() as conn:
        _add_event(conn, ip, "wol", None, f"sent to {payload['broadcast']}:{payload['port']} mac={payload['mac']}")
    return payload


@router.post("/api/hosts/{ip}/wol/status")
def api_host_wol_status(ip: str):
    return _probe_wol_status(ip)


@router.post("/api/wol/fixed")
def wol_fixed(payload: Dict[str, Any] = Body(...)):
    mac   = normalize_mac(payload.get("mac") or "")
    label = (payload.get("label") or "").strip()
    if not mac:
        return JSONResponse({"ok": False, "error": "MAC inválida o vacía"}, status_code=400)
    broadcast_ip = (cfg("wol_broadcast", "") or
                    compute_broadcast_from_cidr(cfg("scan_cidr", SCAN_CIDR)))
    try:
        send_wol(mac, broadcast_ip, int(cfg("wol_port", WOL_PORT)))
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"WOL falló: {e}"}, status_code=500)
    return {"ok": True, "label": label, "mac": mac, "broadcast": broadcast_ip,
            "port": int(cfg("wol_port", WOL_PORT))}



# ══════════════════════════════════════════════════════════════
#  Responsables de hosts
# ══════════════════════════════════════════════════════════════

@router.get("/api/host-owners")
def api_host_owners():
    with db() as conn:
        return {"ok": True, "owners": _host_owner_rows(conn)}


@router.post("/api/host-owners")
def api_host_owner_create(payload: Dict[str, Any] = Body(...)):
    import sqlite3 as _sqlite3
    name = (payload.get("name") or "").strip()
    color = _normalize_owner_color(payload.get("color"))
    notes = (payload.get("notes") or "").strip()
    enabled = 1 if _boolish(payload.get("enabled", True)) else 0
    now = utc_now_iso()
    if not name:
        return JSONResponse({"ok": False, "error": "Nombre vacío"}, status_code=400)
    with db() as conn:
        try:
            conn.execute(
                "INSERT INTO host_owners (name, color, enabled, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (name, color, enabled, notes, now, now),
            )
        except _sqlite3.IntegrityError:
            return JSONResponse({"ok": False, "error": "Ese responsable ya existe"}, status_code=400)
    return {"ok": True}


@router.put("/api/host-owners/{owner_id}")
def api_host_owner_update(owner_id: int, payload: Dict[str, Any] = Body(...)):
    import sqlite3 as _sqlite3
    name = (payload.get("name") or "").strip()
    color = _normalize_owner_color(payload.get("color"))
    notes = (payload.get("notes") or "").strip()
    enabled = 1 if _boolish(payload.get("enabled", True)) else 0
    if not name:
        return JSONResponse({"ok": False, "error": "Nombre vacío"}, status_code=400)
    with db() as conn:
        row = conn.execute("SELECT id FROM host_owners WHERE id=?", (owner_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Responsable no encontrado"}, status_code=404)
        try:
            conn.execute(
                "UPDATE host_owners SET name=?, color=?, enabled=?, notes=?, updated_at=? WHERE id=?",
                (name, color, enabled, notes, utc_now_iso(), owner_id),
            )
        except _sqlite3.IntegrityError:
            return JSONResponse({"ok": False, "error": "Ese responsable ya existe"}, status_code=400)
    return {"ok": True}


@router.delete("/api/host-owners/{owner_id}")
def api_host_owner_delete(owner_id: int):
    with db() as conn:
        row = conn.execute("SELECT id FROM host_owners WHERE id=?", (owner_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Responsable no encontrado"}, status_code=404)
        conn.execute("UPDATE hosts SET owner_id=NULL WHERE owner_id=?", (owner_id,))
        conn.execute("DELETE FROM host_owners WHERE id=?", (owner_id,))
    return {"ok": True}


# ══════════════════════════════════════════════════════════════
#  Tipos, tags, búsqueda
# ══════════════════════════════════════════════════════════════

@router.get("/api/types")
def api_types():
    with db() as conn:
        rows = conn.execute("SELECT id, name, icon FROM host_types ORDER BY name ASC").fetchall()
    return {"ok": True, "types": [dict(r) for r in rows]}


@router.post("/api/types")
def api_type_create(payload: Dict[str, Any] = Body(...)):
    import sqlite3 as _sqlite3
    name = (payload.get("name") or "").strip()
    icon = (payload.get("icon") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "Nombre vacío"}, status_code=400)
    with db() as conn:
        try:
            conn.execute("INSERT INTO host_types (name, icon, created_at) VALUES (?,?,?)",
                         (name, icon, utc_now_iso()))
        except _sqlite3.IntegrityError:
            return JSONResponse({"ok": False, "error": "Ese tipo ya existe"}, status_code=400)
    return {"ok": True}


@router.put("/api/types/{type_id}")
def api_type_update(type_id: int, payload: Dict[str, Any] = Body(...)):
    import sqlite3 as _sqlite3
    name = (payload.get("name") or "").strip()
    icon = (payload.get("icon") or "").strip()
    if not name:
        return JSONResponse({"ok": False, "error": "Nombre vacío"}, status_code=400)
    with db() as conn:
        row = conn.execute("SELECT id FROM host_types WHERE id=?", (type_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Tipo no encontrado"}, status_code=404)
        try:
            conn.execute("UPDATE host_types SET name=?, icon=? WHERE id=?", (name, icon, type_id))
        except _sqlite3.IntegrityError:
            return JSONResponse({"ok": False, "error": "Ese tipo ya existe"}, status_code=400)
    return {"ok": True}


@router.delete("/api/types/{type_id}")
def api_type_delete(type_id: int):
    with db() as conn:
        row = conn.execute("SELECT id, name FROM host_types WHERE id=?", (type_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Tipo no encontrado"}, status_code=404)
        if row["name"] == "Por defecto":
            return JSONResponse({"ok": False, "error": "No se puede borrar 'Por defecto'"}, status_code=400)
        default_id = conn.execute("SELECT id FROM host_types WHERE name='Por defecto' LIMIT 1").fetchone()
        if default_id:
            conn.execute("UPDATE hosts SET type_id=? WHERE type_id=?", (default_id["id"], type_id))
        conn.execute("DELETE FROM host_types WHERE id=?", (type_id,))
    return {"ok": True}


@router.get("/api/tags")
def api_tags_list():
    with db() as conn:
        rows = conn.execute(
            "SELECT COALESCE(tags,'') AS tags FROM hosts WHERE tags IS NOT NULL AND tags != ''"
        ).fetchall()
    tag_set: set = set()
    for r in rows:
        for t in (r["tags"] or "").split(","):
            t = t.strip()
            if t:
                tag_set.add(t)
    return {"ok": True, "tags": sorted(tag_set)}


@router.post("/api/hosts/{ip}/tags")
def api_host_tags_update(ip: str, payload: Dict[str, Any] = Body(...)):
    raw  = (payload.get("tags") or "").strip()
    tags = sorted({t.strip().lower() for t in raw.split(",") if t.strip()})
    with db() as conn:
        conn.execute("UPDATE hosts SET tags=? WHERE ip=?", (",".join(tags), ip))
    return {"ok": True, "tags": ",".join(tags)}


@router.get("/api/search")
def api_global_search(q: str = "", limit: int = Query(20, ge=1, le=50)):
    q = (q or "").strip()
    if len(q) < 2:
        return {"ok": True, "results": [], "query": q}

    like = f"%{q}%"
    q_lc = q.lower()

    def category_match(*terms: str) -> int:
        return 1 if any(term in q_lc for term in terms) else 0

    modules = {
        "services": module_enabled("services"),
        "automation": module_enabled("automation"),
        "agents": module_enabled("agents"),
        "quality": module_enabled("quality"),
        "syncthing": module_enabled("syncthing"),
    }

    want_services = modules["services"] and category_match("servicio", "servicios", "aplicacion", "aplicación", "aplicaciones", "apps")
    want_automation = modules["automation"] and category_match("script", "scripts", "automatizacion", "automatización", "automatizaciones", "proceso", "procesos", "cron")
    want_agents = modules["agents"] and category_match("agente", "agentes", "api")
    want_quality = modules["quality"] and category_match("calidad", "quality", "latencia", "red")
    want_syncthing = modules["syncthing"] and category_match("syncthing", "sincronizacion", "sincronización", "carpeta", "carpetas", "folder", "folders", "nodo", "nodos")
    want_events = category_match("evento", "eventos", "historial", "cambio", "cambios")
    want_scans = category_match("scan", "scans", "escaneo", "escaneos", "ejecucion", "ejecución", "ejecuciones")

    results: List[Dict[str, Any]] = []
    seen = set()
    per_kind_limit = max(3, min(12, int(limit)))

    def add_result(kind: str, icon: str, title: str, subtitle: str = "", status: str = "",
                   action: str = "", extra: Dict[str, Any] | None = None):
        title = str(title or "").strip()
        subtitle = str(subtitle or "").strip()
        if not title:
            return
        key = (kind, title.lower(), subtitle.lower(), action)
        if key in seen:
            return
        seen.add(key)
        row = {
            "type": kind,
            "kind": kind,
            "icon": icon,
            "title": title,
            "name": title,
            "subtitle": subtitle,
            "status": status or "",
            "action": action or "",
        }
        if extra:
            row.update(extra)
        results.append(row)

    with db() as conn:
        for r in conn.execute("""
            SELECT h.ip, h.mac,
                   COALESCE(h.manual_name,'') manual_name,
                   COALESCE(h.nmap_hostname,'') nmap_hostname,
                   COALESCE(h.router_hostname,'') router_hostname,
                   COALESCE(h.dns_name,'') dns_name,
                   COALESCE(h.notes,'') notes,
                   COALESCE(h.tags,'') tags,
                   COALESCE(h.vendor,'') vendor,
                   COALESCE(h.device_type,'') device_type,
                   COALESCE(t.name,'') type_name,
                   h.status,
                   COALESCE(t.icon,'') type_icon
            FROM hosts h
            LEFT JOIN host_types t ON t.id = h.type_id
            WHERE h.ip LIKE ? OR h.mac LIKE ? OR h.manual_name LIKE ? OR h.nmap_hostname LIKE ?
               OR h.router_hostname LIKE ? OR h.dns_name LIKE ? OR h.notes LIKE ? OR h.tags LIKE ?
               OR h.vendor LIKE ? OR h.device_type LIKE ? OR t.name LIKE ?
            ORDER BY
              CASE WHEN h.ip LIKE ? THEN 0 ELSE 1 END,
              h.status DESC,
              h.ip
            LIMIT ?
        """, (like, like, like, like, like, like, like, like, like, like, like, like, per_kind_limit)).fetchall():
            label = r["manual_name"] or r["nmap_hostname"] or r["router_hostname"] or r["dns_name"] or r["ip"]
            subtitle = " · ".join([x for x in [r["ip"], r["mac"], r["type_name"] or r["device_type"], r["vendor"]] if x])
            add_result("host", "bi-pc-display", label, subtitle, r["status"] or "", f"openHost:{r['ip']}", {"ip": r["ip"], "mac": r["mac"] or ""})

        if modules["services"]:
            for r in conn.execute("""
                SELECT s.id, s.name, s.host, s.port, COALESCE(s.protocol,'tcp') protocol,
                       COALESCE(s.service_type,'') service_type,
                       COALESCE(s.service_url,'') service_url,
                       COALESCE(s.access_url,'') access_url,
                       COALESCE(s.notes,'') notes,
                       COALESCE(ls.status,'unknown') last_status
                FROM services s
                LEFT JOIN service_last_status ls ON ls.service_id = s.id
                WHERE ? = 1 OR s.name LIKE ? OR s.host LIKE ? OR CAST(s.port AS TEXT) LIKE ?
                   OR s.service_type LIKE ? OR s.service_url LIKE ? OR s.access_url LIKE ?
                   OR s.notes LIKE ?
                ORDER BY s.enabled DESC, s.name COLLATE NOCASE
                LIMIT ?
            """, (want_services, like, like, like, like, like, like, like, per_kind_limit)).fetchall():
                subtitle = f"{r['host']}:{r['port']} · {r['protocol']} · {r['service_type'] or 'servicio'}"
                add_result("service", "bi-hdd-rack", r["name"], subtitle, r["last_status"] or "unknown", "openTab:infra-apps", {"id": r["id"], "host": r["host"], "port": r["port"]})

        if modules["automation"]:
            for r in conn.execute("""
                SELECT id, script_name, label, description, active, cron_expr, cron_source, host_name
                FROM monitored_scripts
                WHERE ? = 1 OR script_name LIKE ? OR label LIKE ? OR description LIKE ?
                   OR cron_expr LIKE ? OR cron_source LIKE ? OR host_name LIKE ?
                ORDER BY active DESC, sort_order ASC, label COLLATE NOCASE
                LIMIT ?
            """, (want_automation, like, like, like, like, like, like, per_kind_limit)).fetchall():
                title = r["label"] or r["script_name"]
                subtitle = " · ".join([x for x in [r["script_name"], r["host_name"], r["cron_expr"]] if x])
                add_result("automation", "bi-cpu", title, subtitle, "active" if int(r["active"] or 0) else "disabled", "openTab:infra-auto", {"id": r["id"], "script_name": r["script_name"]})

        if modules["agents"]:
            for r in conn.execute("""
                SELECT id, host_name, enabled, revoked_at, last_seen_at, last_seen_ip, last_status_script, notes
                FROM automation_agents
                WHERE ? = 1 OR host_name LIKE ? OR last_seen_ip LIKE ? OR last_status_script LIKE ? OR notes LIKE ?
                ORDER BY enabled DESC, last_seen_at DESC
                LIMIT ?
            """, (want_agents, like, like, like, like, per_kind_limit)).fetchall():
                state = "revoked" if r["revoked_at"] else ("enabled" if int(r["enabled"] or 0) else "disabled")
                subtitle = " · ".join([x for x in [r["last_seen_ip"], r["last_status_script"], r["last_seen_at"]] if x])
                add_result("agent", "bi-shield-check", r["host_name"], subtitle, state, "openConfig:scripts", {"id": r["id"]})

        if modules["quality"]:
            for r in conn.execute("""
                SELECT qt.id, qt.name, qt.host, qt.enabled, qt.interface,
                       COALESCE(qc.status,'unknown') latest_status,
                       qc.checked_at, qc.latency_ms, qc.packet_loss
                FROM quality_targets qt
                LEFT JOIN (
                    SELECT c.*
                    FROM quality_checks c
                    JOIN (
                        SELECT target_id, MAX(checked_at) checked_at
                        FROM quality_checks
                        GROUP BY target_id
                    ) latest ON latest.target_id = c.target_id AND latest.checked_at = c.checked_at
                ) qc ON qc.target_id = qt.id
                WHERE ? = 1 OR qt.name LIKE ? OR qt.host LIKE ? OR qt.interface LIKE ?
                ORDER BY qt.enabled DESC, qt.name COLLATE NOCASE
                LIMIT ?
            """, (want_quality, like, like, like, per_kind_limit)).fetchall():
                subtitle = " · ".join([x for x in [r["host"], r["interface"], r["checked_at"]] if x])
                add_result("quality", "bi-wifi", r["name"], subtitle, r["latest_status"] or "unknown", "openTab:quality", {"id": r["id"], "host": r["host"]})

        if modules["syncthing"]:
            for r in conn.execute("""
                SELECT id, name, gui_url, enabled, notes, updated_at
                FROM syncthing_nodes
                WHERE ? = 1 OR name LIKE ? OR gui_url LIKE ? OR notes LIKE ?
                ORDER BY enabled DESC, name COLLATE NOCASE
                LIMIT ?
            """, (want_syncthing, like, like, like, per_kind_limit)).fetchall():
                subtitle = " · ".join([x for x in [r["gui_url"], r["updated_at"]] if x])
                add_result("syncthing_node", "bi-arrow-repeat", r["name"], subtitle, "enabled" if int(r["enabled"] or 0) else "disabled", "openTab:infra-syncthing", {"id": r["id"]})

        if modules["syncthing"]:
            for r in conn.execute("""
                SELECT fs.node_id, fs.node_name, fs.folder_id, fs.folder_label, fs.status, fs.state,
                       fs.errors, fs.need_bytes, fs.need_files, fs.observed_at
                FROM syncthing_folder_snapshots fs
                JOIN (
                    SELECT node_id, folder_id, MAX(observed_at) observed_at
                    FROM syncthing_folder_snapshots
                    GROUP BY node_id, folder_id
                ) latest
                  ON latest.node_id = fs.node_id
                 AND latest.folder_id = fs.folder_id
                 AND latest.observed_at = fs.observed_at
                WHERE ? = 1 OR fs.node_name LIKE ? OR fs.folder_id LIKE ? OR fs.folder_label LIKE ?
                   OR fs.status LIKE ? OR fs.state LIKE ?
                ORDER BY fs.observed_at DESC
                LIMIT ?
            """, (want_syncthing, like, like, like, like, like, per_kind_limit)).fetchall():
                subtitle = f"{r['node_name']} · {r['folder_id']} · {r['state']} · pendientes {r['need_files']} ficheros"
                add_result("syncthing_folder", "bi-folder-symlink", r["folder_label"] or r["folder_id"], subtitle, r["status"] or "unknown", "openTab:infra-syncthing", {"node_id": r["node_id"], "folder_id": r["folder_id"]})

        for r in conn.execute("""
            SELECT id, ip, at, event_type, old_value, new_value
            FROM host_events
            WHERE ? = 1 OR ip LIKE ? OR event_type LIKE ? OR old_value LIKE ? OR new_value LIKE ?
            ORDER BY at DESC
            LIMIT ?
        """, (want_events, like, like, like, like, min(8, per_kind_limit))).fetchall():
            title = f"{r['ip']} · {r['event_type']}"
            subtitle = f"{(r['at'] or '')[:19]} · {r['old_value'] or '—'} → {r['new_value'] or '—'}"
            add_result("host_event", "bi-clock-history", title, subtitle, "event", f"openHost:{r['ip']}", {"id": r["id"], "ip": r["ip"]})

        for r in conn.execute("""
            SELECT id, started_at, cidr, online_hosts, offline_hosts, new_hosts
            FROM scans
            WHERE ? = 1 OR cidr LIKE ? OR started_at LIKE ? OR notes LIKE ?
            ORDER BY started_at DESC
            LIMIT ?
        """, (want_scans, like, like, like, min(6, per_kind_limit))).fetchall():
            add_result(
                "scan",
                "bi-radar",
                f"Scan #{r['id']} · {r['cidr']}",
                f"{(r['started_at'] or '')[:16]} · {r['online_hosts']} online · {r['offline_hosts']} offline · {r['new_hosts']} nuevos",
                "info",
                "openTab:hosts-scans",
                {"id": r["id"]},
            )

    return {"ok": True, "results": results[:limit], "query": q}



# ══════════════════════════════════════════════════════════════
#  Uptime y latencia
# ══════════════════════════════════════════════════════════════

@router.get("/api/hosts/{ip}/uptime")
def api_host_uptime(ip: str, days: int = 30):
    days = max(1, min(90, int(days)))
    now = utc_now()
    start = now - timedelta(days=days)
    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid"))

    with db() as conn:
        interval_rows = conn.execute(
            """
            SELECT status, started_at, COALESCE(ended_at, ?) AS ended_at
            FROM host_availability_intervals
            WHERE ip = ?
              AND started_at < ?
              AND COALESCE(ended_at, ?) > ?
            ORDER BY started_at ASC
            """,
            (
                now.isoformat(),
                ip,
                now.isoformat(),
                now.isoformat(),
                start.isoformat(),
            ),
        ).fetchall()

    intervals = _parse_availability_intervals(interval_rows)
    daily_map: Dict[str, Dict[str, Any]] = {}

    for interval in intervals:
        seg_start = max(interval["start"], start)
        seg_end = min(interval["end"], now)
        if seg_end <= seg_start:
            continue

        cursor = seg_start
        while cursor < seg_end:
            local_cursor = cursor.astimezone(app_tz)
            next_midnight_local = (local_cursor + timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            chunk_end = min(seg_end, next_midnight_local.astimezone(seg_end.tzinfo))
            chunk_secs = max(0, int((chunk_end - cursor).total_seconds()))
            if chunk_secs <= 0:
                break

            day_key = local_cursor.strftime("%Y-%m-%d")
            bucket = daily_map.setdefault(
                day_key,
                {"date": day_key, "online_seconds": 0, "offline_seconds": 0},
            )

            status = str(interval["status"] or "unknown").strip().lower()
            if status in ("online", "online_silent"):
                bucket["online_seconds"] += chunk_secs
            else:
                bucket["offline_seconds"] += chunk_secs

            cursor = chunk_end

    rows = [daily_map[k] for k in sorted(daily_map.keys())]
    total_online = sum(r["online_seconds"] for r in rows)
    total_offline = sum(r["offline_seconds"] for r in rows)
    total = total_online + total_offline
    pct = round(total_online * 100 / total, 1) if total > 0 else None

    return {
        "ok": True,
        "ip": ip,
        "days": days,
        "uptime_pct": pct,
        "total_online_h": round(total_online / 3600, 1),
        "total_offline_h": round(total_offline / 3600, 1),
        "daily": [
            {
                "date": r["date"],
                "online_h": round(r["online_seconds"] / 3600, 2),
                "offline_h": round(r["offline_seconds"] / 3600, 2),
                "pct": round(r["online_seconds"] * 100 / (r["online_seconds"] + r["offline_seconds"]), 1)
                if (r["online_seconds"] + r["offline_seconds"]) > 0 else None,
            }
            for r in rows
        ],
    }


@router.get("/api/hosts/{ip}/latency")
def api_host_latency(ip: str, hours: int = 24, limit: int = 200):
    hours = max(1, int(hours))
    limit = max(1, int(limit))
    cutoff = (utc_now() - timedelta(hours=hours)).isoformat()
    with db() as conn:
        rows = conn.execute("""
            SELECT scanned_at, latency_ms FROM host_latency
            WHERE ip=? AND scanned_at >= ? ORDER BY scanned_at ASC LIMIT ?
        """, (ip, cutoff, limit)).fetchall()
        host = conn.execute("SELECT last_latency_ms FROM hosts WHERE ip=?", (ip,)).fetchone()
    hist = [dict(r) for r in rows]
    return {"ok": True, "ip": ip, "hours": hours, "history": hist, "data": hist,
            "last_latency_ms": host["last_latency_ms"] if host else None}


@router.get("/api/hosts/{ip}/timeline")
def api_host_timeline(ip: str, range: str = "day", date: str = ""):
    if range not in ("day", "week", "month"):
        range = "day"

    now = utc_now()
    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid")) or utc_now().tzinfo
    utc_tz = utc_now().tzinfo
    if date:
        try:
            from datetime import datetime as _dt
            raw_date = str(date or "").strip()
            anchor = _dt.fromisoformat(raw_date)
            if anchor.tzinfo is None:
                anchor = anchor.replace(tzinfo=app_tz)
            else:
                anchor = anchor.astimezone(app_tz)
            start_local = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
            end_local = start_local + timedelta(days=1)
            start = start_local.astimezone(utc_tz)
            end = end_local.astimezone(utc_tz)
            buckets, step = 24, timedelta(hours=1)
        except Exception:
            return JSONResponse({"ok": False, "error": "Fecha inválida"}, status_code=400)
    elif range == "week":
        end = now
        start = now - timedelta(days=7)
        buckets, step = 28, timedelta(hours=6)
    elif range == "month":
        end = now
        start = now - timedelta(days=30)
        buckets, step = 30, timedelta(days=1)
    else:
        end = now
        start = now - timedelta(days=1)
        buckets, step = 24, timedelta(hours=1)

    with db() as conn:
        host = conn.execute("SELECT status FROM hosts WHERE ip=?", (ip,)).fetchone()
        if not host:
            return JSONResponse({"ok": False, "error": "IP no encontrada"}, status_code=404)

        interval_rows = conn.execute(
            """
            SELECT status, started_at, COALESCE(ended_at, ?) AS ended_at
            FROM host_availability_intervals
            WHERE ip = ?
              AND started_at < ?
              AND COALESCE(ended_at, ?) > ?
            ORDER BY started_at ASC
            """,
            (
                end.isoformat(),
                ip,
                end.isoformat(),
                end.isoformat(),
                start.isoformat(),
            ),
        ).fetchall()

        events = conn.execute("""
            SELECT at, event_type, new_value
            FROM host_events
            WHERE ip=? AND event_type IN ('new','status') AND at >= ?
            ORDER BY at ASC
        """, (ip, start.isoformat())).fetchall()
        prev = conn.execute("""
            SELECT at, event_type, new_value
            FROM host_events
            WHERE ip=? AND event_type IN ('new','status') AND at < ?
            ORDER BY at DESC LIMIT 1
        """, (ip, start.isoformat())).fetchone()

    changes = []
    for e in events:
        dt = parse_iso(e["at"])
        if not dt:
            continue
        if e["event_type"] == "new":
            changes.append((dt, "online"))
        else:
            changes.append((dt, e["new_value"] or "unknown"))

    legacy_status = (
        "online"
        if prev and prev["event_type"] == "new"
        else ((prev["new_value"] if prev else None) or host["status"] or "unknown")
    )
    idx = 0
    segments = []
    parsed_intervals = _parse_availability_intervals(interval_rows)

    precise_intervals = []
    if range == "day" or date:
        cursor = start
        for interval in parsed_intervals:
            seg_start = max(interval["start"], start)
            seg_end = min(interval["end"], end)
            if seg_end <= seg_start:
                continue
            if cursor < seg_start:
                precise_intervals.append({
                    "status": "unknown",
                    "start": cursor.isoformat(),
                    "end": seg_start.isoformat(),
                })
            precise_intervals.append({
                "status": interval["status"],
                "start": seg_start.isoformat(),
                "end": seg_end.isoformat(),
            })
            cursor = max(cursor, seg_end)
        if cursor < end:
            precise_intervals.append({
                "status": "unknown",
                "start": cursor.isoformat(),
                "end": end.isoformat(),
            })

    bucket_start = start
    while bucket_start < end and len(segments) < buckets:
        bucket_end = min(bucket_start + step, end)
        while idx < len(changes) and changes[idx][0] < bucket_end:
            if changes[idx][0] >= bucket_start:
                legacy_status = changes[idx][1]
            idx += 1

        bucket_status = legacy_status
        if parsed_intervals:
            probe_point = bucket_end - timedelta(microseconds=1)
            if probe_point < bucket_start:
                probe_point = bucket_start
            interval_status = _status_from_intervals_at_point(parsed_intervals, probe_point)
            if interval_status:
                bucket_status = interval_status

        segments.append({"time": bucket_start.isoformat(), "status": bucket_status})
        bucket_start = bucket_end

    online = sum(1 for s in segments if s["status"] in ("online", "online_silent"))
    offline = sum(1 for s in segments if s["status"] == "offline")
    return {
        "ok": True,
        "ip": ip,
        "range": range,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "segments": segments,
        "intervals": precise_intervals,
        "stats": {
            "online": online,
            "offline": offline,
            "unknown": max(0, len(segments) - online - offline),
        },
    }


# ══════════════════════════════════════════════════════════════
#  Dashboard layout
# ══════════════════════════════════════════════════════════════

@router.get("/api/dashboard/layout")
def api_dashboard_layout_get():
    with db() as conn:
        row = conn.execute("SELECT layout FROM dashboard_layout WHERE id=1").fetchone()
    return {"ok": True, "layout": row["layout"] if row else "{}"}


@router.put("/api/dashboard/layout")
def api_dashboard_layout_put(payload: Dict[str, Any] = Body(...)):
    import json
    layout = json.dumps(payload.get("layout", {}))
    with db() as conn:
        conn.execute("""
            INSERT INTO dashboard_layout (id, layout, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET layout=excluded.layout, updated_at=excluded.updated_at
        """, (layout, utc_now_iso()))
    return {"ok": True}


# ══════════════════════════════════════════════════════════════
#  Export CSV / XLSX
# ══════════════════════════════════════════════════════════════

@router.get("/export.csv")
def export_csv():
    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid"))
    from datetime import datetime as _dt
    with db() as conn:
        rows = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes,
                   COALESCE(t.name,'') AS type_name, COALESCE(t.icon,'') AS type_icon,
                   h.first_seen, h.last_seen, h.last_change, h.status, h.known, h.last_latency_ms
            FROM hosts h LEFT JOIN host_types t ON t.id = h.type_id
            ORDER BY h.status DESC, h.last_seen DESC
        """).fetchall()
    sio    = io.StringIO()
    writer = csv.writer(sio)
    writer.writerow(["IP","MAC","Hostname","DNS","Nombre manual","Tipo","Icono","Notas",
                     "Primera vez","Última vez","Último cambio","Visto hace","Estado","Conocido","Latencia (ms)"])
    for r in rows:
        writer.writerow([
            r["ip"], r["mac"] or "", r["nmap_hostname"] or "", r["dns_name"] or "",
            r["manual_name"] or "", r["type_name"] or "", r["type_icon"] or "", r["notes"] or "",
            to_local_str(r["first_seen"]), to_local_str(r["last_seen"]),
            to_local_str(r["last_change"]), human_since(r["last_seen"]),
            r["status"] or "", "SI" if r["known"] else "NO", r["last_latency_ms"] or "",
        ])
    sio.seek(0)
    filename = f"auditor_ips_{_dt.now(app_tz).strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([sio.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/api/db/reset")
def reset_db():
    with db() as conn:
        conn.execute("DELETE FROM host_events")
        conn.execute("DELETE FROM hosts")
        conn.execute("DELETE FROM scans")
    return {"ok": True, "message": "Base de datos reseteada."}
