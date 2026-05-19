"""
utils.py — Auditor IPs
Funciones de utilidad puras: fechas, MACs, WoL, red, PWA icons.

Sin imports de database.py ni de config.py para evitar dependencias circulares.
Donde se necesita APP_TZ o DB_PATH, los routers los pasan como argumento
o los importan directamente de config.py.
"""

import os
import re
import socket
import struct
import zlib
import ipaddress
from datetime import datetime, timezone
from typing import Optional

from dateutil import tz as _tz


# ══════════════════════════════════════════════════════════════
#  Timezone
# ══════════════════════════════════════════════════════════════

def get_app_tz(tz_name: str = "Europe/Madrid"):
    """Devuelve el objeto tzinfo para la timezone configurada."""
    return _tz.gettz(tz_name)


# ══════════════════════════════════════════════════════════════
#  Fechas UTC
# ══════════════════════════════════════════════════════════════

def utc_now() -> datetime:
    """Datetime UTC con timezone-aware."""
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """ISO 8601 UTC. Ejemplo: '2026-03-04T12:00:00+00:00'"""
    return utc_now().isoformat()


def parse_iso(dt_iso: Optional[str]) -> Optional[datetime]:
    """Parsea un string ISO 8601 a datetime timezone-aware. Devuelve None si falla."""
    if not dt_iso:
        return None
    try:
        return datetime.fromisoformat(dt_iso.replace("Z", "+00:00"))
    except Exception:
        return None


def to_local_str(dt_iso: Optional[str], tz_name: str = "Europe/Madrid") -> str:
    """Convierte ISO UTC a string local formateado. Devuelve '' si dt_iso es None."""
    dt = parse_iso(dt_iso)
    if not dt:
        return ""
    app_tz = get_app_tz(tz_name)
    return dt.astimezone(app_tz).strftime("%Y-%m-%d %H:%M:%S")


def human_since(dt_iso: Optional[str]) -> str:
    """
    Devuelve tiempo relativo legible desde dt_iso hasta ahora.
    Ejemplos: '5s', '10m', '3h', '7d'.
    """
    dt = parse_iso(dt_iso)
    if not dt:
        return ""
    delta = utc_now() - dt
    secs = max(0, int(delta.total_seconds()))
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hours = mins // 60
    if hours < 48:
        return f"{hours}h"
    return f"{hours // 24}d"


# ══════════════════════════════════════════════════════════════
#  MACs y red
# ══════════════════════════════════════════════════════════════

def normalize_mac(mac: str) -> str:
    """
    Normaliza una MAC a formato XX:XX:XX:XX:XX:XX en mayúsculas.
    Devuelve '' si el formato no es válido.
    """
    mac = (mac or "").strip().upper().replace("-", ":")
    if re.match(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", mac):
        return mac
    return ""


def compute_broadcast_from_cidr(cidr: str) -> str:
    """Calcula la dirección broadcast de un CIDR. Devuelve '255.255.255.255' si falla."""
    try:
        net = ipaddress.ip_network(cidr, strict=False)
        return str(net.broadcast_address)
    except Exception:
        return "255.255.255.255"


def send_wol(mac: str, broadcast_ip: str, port: int = 9) -> None:
    """
    Envía un magic packet Wake-on-LAN a broadcast_ip:port.
    Lanza ValueError si la MAC es inválida.
    """
    mac = normalize_mac(mac)
    if not mac:
        raise ValueError("MAC inválida o vacía")
    mac_bytes = bytes.fromhex(mac.replace(":", ""))
    packet = b"\xff" * 6 + mac_bytes * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.sendto(packet, (broadcast_ip, port))
    finally:
        s.close()


def parse_cidr_list(raw: str) -> list[str]:
    """
    Parsea SCAN_CIDR que puede ser un único CIDR o una lista separada por comas.
    Elimina duplicados y valida cada entrada.
    Ejemplos:
      '192.168.1.0/24'            → ['192.168.1.0/24']
      '192.168.1.0/24,10.0.0.0/8' → ['192.168.1.0/24', '10.0.0.0/8']
    """
    results = []
    seen: set[str] = set()
    for part in raw.split(","):
        cidr = part.strip()
        if not cidr or cidr in seen:
            continue
        try:
            # Valida que sea un CIDR correcto
            ipaddress.ip_network(cidr, strict=False)
            results.append(cidr)
            seen.add(cidr)
        except ValueError:
            pass  # Ignorar entradas inválidas silenciosamente
    return results or ["192.168.1.0/24"]


# ══════════════════════════════════════════════════════════════
#  PWA Icons
# ══════════════════════════════════════════════════════════════

def generate_pwa_icons(static_dir: str = "static") -> None:
    """
    Genera iconos PNG mínimos para la PWA si no existen.
    Fondo oscuro con círculo del color de acento (#4dffb5).
    """
    os.makedirs(static_dir, exist_ok=True)
    for size in (192, 512):
        path = os.path.join(static_dir, f"icon-{size}.png")
        if os.path.exists(path):
            continue
        try:
            w = h = size
            color = (77, 255, 181)   # #4dffb5 accent
            bg    = (26, 31, 38)     # dark background
            r     = size // 4

            rows = []
            for y in range(h):
                row = []
                for x in range(w):
                    cx, cy = w // 2, h // 2
                    dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                    row.extend(color if dist < r else bg)
                rows.append(bytes([0] + row))  # filter byte

            raw = b"".join(rows)
            compressed = zlib.compress(raw)

            def _chunk(tag: bytes, data: bytes) -> bytes:
                c = tag + data
                crc = zlib.crc32(c) & 0xFFFFFFFF
                return struct.pack(">I", len(data)) + c + struct.pack(">I", crc)

            ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
            png = (
                b"\x89PNG\r\n\x1a\n"
                + _chunk(b"IHDR", ihdr)
                + _chunk(b"IDAT", compressed)
                + _chunk(b"IEND", b"")
            )
            with open(path, "wb") as f:
                f.write(png)
        except Exception as e:
            print(f"[PWA] Icon generation failed for size {size}: {e}")
