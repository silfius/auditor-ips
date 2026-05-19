"""
Helpers puros de fingerprint/parsing para Auditor IPs.

Este módulo no ejecuta scans ni toca la base de datos.
Solo normaliza/parsa resultados y deriva señales reutilizables.
"""

import re
import sqlite3
from typing import Any, Callable, Dict, List, Optional, Tuple


def parse_fingerprint_output(output: str) -> Dict[str, Any]:
    fp: Dict[str, Any] = {
        "open_ports": [],
        "os_guess": "",
        "os_cpe": "",
        "device_type": "",
        "hostname": "",
        "services": [],
        "raw_lines": [],
    }
    for line in output.splitlines():
        raw_line = line.rstrip()
        line = raw_line.strip()
        if line and not line.startswith("#"):
            fp["raw_lines"].append(line)
        m = re.match(r'^(\d+)/(tcp|udp)\s+open\s+(\S+)\s*(.*)', line)
        if m:
            port, proto, svc, version = m.groups()
            port_i = int(port)
            if port_i not in fp["open_ports"]:
                fp["open_ports"].append(port_i)
            fp["services"].append({
                "port": port_i,
                "proto": proto,
                "name": svc,
                "service": svc,
                "version": version.strip(),
            })
            continue
        if "OS details:" in line:
            fp["os_guess"] = line.split("OS details:", 1)[1].strip()
        elif "Running:" in line and not fp["os_guess"]:
            fp["os_guess"] = line.split("Running:", 1)[1].strip()
        elif line.startswith("OS CPE:"):
            fp["os_cpe"] = line.split("OS CPE:", 1)[1].strip()
        if "Device type:" in line:
            fp["device_type"] = line.split("Device type:", 1)[1].strip()
        if "Nmap scan report for" in line and "(" in line:
            m2 = re.search(r"for (.+?) \(", line)
            if m2:
                fp["hostname"] = m2.group(1).strip()
    fp["raw_lines"] = fp["raw_lines"][:40]
    return fp


def merge_fingerprint_parts(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    merged = {
        "open_ports": list(base.get("open_ports") or []),
        "os_guess": base.get("os_guess") or "",
        "os_cpe": base.get("os_cpe") or "",
        "device_type": base.get("device_type") or "",
        "hostname": base.get("hostname") or "",
        "services": list(base.get("services") or []),
        "raw_lines": list(base.get("raw_lines") or []),
    }
    seen_ports = {int(p) for p in merged["open_ports"]}
    for port in extra.get("open_ports") or []:
        try:
            port_i = int(port)
        except Exception:
            continue
        if port_i not in seen_ports:
            merged["open_ports"].append(port_i)
            seen_ports.add(port_i)
    seen_service_keys = {
        (s.get("port"), s.get("proto"), s.get("name"))
        for s in merged["services"]
        if isinstance(s, dict)
    }
    for svc in extra.get("services") or []:
        if not isinstance(svc, dict):
            continue
        key = (svc.get("port"), svc.get("proto"), svc.get("name"))
        if key not in seen_service_keys:
            merged["services"].append(svc)
            seen_service_keys.add(key)
    for key in ("os_guess", "os_cpe", "device_type", "hostname"):
        if not merged.get(key) and extra.get(key):
            merged[key] = extra[key]
    merged["raw_lines"] = (merged["raw_lines"] + list(extra.get("raw_lines") or []))[:40]
    return merged


def fingerprint_port_clues(ports: set[int]) -> List[str]:
    clues: List[str] = []
    if 554 in ports or 8554 in ports:
        clues.append("RTSP (cámara/NVR)")
    if 8096 in ports:
        clues.append("Jellyfin")
    if 32400 in ports:
        clues.append("Plex Media Server")
    if 8123 in ports:
        clues.append("Home Assistant")
    if 1400 in ports:
        clues.append("Sonos")
    if 631 in ports:
        clues.append("Impresora (IPP)")
    if 9100 in ports:
        clues.append("Impresora (RAW)")
    if 3306 in ports:
        clues.append("MySQL")
    if 5432 in ports:
        clues.append("PostgreSQL")
    if 6379 in ports:
        clues.append("Redis")
    if 27017 in ports:
        clues.append("MongoDB")
    if {4357, 6789} & ports:
        clues.append("UniFi Controller")
    return clues


def derive_vendor_from_fingerprint(
    row: Optional[sqlite3.Row],
    fp: Dict[str, Any],
    oui_lookup_fn: Callable[[str], str],
) -> Tuple[str, str, str]:
    current_vendor = ""
    mac_addr = ""
    if row:
        current_vendor = row["vendor"] or ""
        mac_addr = row["mac"] or ""
        if not current_vendor and mac_addr:
            current_vendor = oui_lookup_fn(mac_addr)

    new_vendor = current_vendor
    os_str = (fp.get("os_guess") or "").lower()
    hostname = (fp.get("hostname") or "").strip()

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

    return current_vendor, new_vendor, hostname
