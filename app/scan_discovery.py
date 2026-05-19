"""
scan_discovery.py — Auditor IPs

Helpers de discovery/red/router/nmap extraídos de routers/scans.py
para reducir acoplamiento antes de tocar el core delicado del motor
de escaneo.
"""

import re
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import dns.resolver
import dns.reversename

from config import cfg
from utils import utc_now


def _ssh_run(commands: List[str]) -> str:
    """Ejecuta comandos en el router via SSH con known_hosts persistente."""
    import os
    import shutil as _shutil
    import stat as _stat

    host = cfg("router_ssh_host", "192.168.1.1")
    port = int(cfg("router_ssh_port", "22") or 22)
    user = cfg("router_ssh_user", "")
    key = cfg("router_ssh_key", "")

    if not host or not user or not key:
        raise ValueError("Router SSH no configurado (host/user/key vacíos)")

    key_path = key
    if not os.path.exists(key_path):
        alt = os.path.join("/data", os.path.basename(key_path))
        if os.path.exists(alt):
            key_path = alt
        else:
            raise FileNotFoundError(
                f"Key file no encontrado: {key_path}\n"
                "Asegúrate de que el volumen está montado en docker-compose.yml."
            )

    key_mode = _stat.S_IMODE(os.stat(key_path).st_mode)
    effective_key = key_path
    if key_mode & 0o077:
        tmp_key = f"/tmp/router_key_{os.getpid()}"
        _shutil.copy2(key_path, tmp_key)
        os.chmod(tmp_key, 0o600)
        effective_key = tmp_key

    known_hosts_file = "/data/ssh_known_hosts"
    if os.path.exists(known_hosts_file):
        strict = "yes"
    else:
        strict = "accept-new"

    try:
        cmd_str = " ; echo '---SEP---' ; ".join(commands)
        ssh_cmd = [
            "ssh",
            "-i", effective_key,
            "-p", str(port),
            "-o", f"StrictHostKeyChecking={strict}",
            "-o", f"UserKnownHostsFile={known_hosts_file}",
            "-o", "ConnectTimeout=8",
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "PubkeyAuthentication=yes",
            "-o", "PasswordAuthentication=no",
            f"{user}@{host}",
            cmd_str,
        ]
        result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0 and not result.stdout.strip():
            raise RuntimeError(
                f"SSH error (rc={result.returncode}): {result.stderr.strip()[:500]}"
            )
        return result.stdout
    finally:
        if effective_key != key_path and os.path.exists(effective_key):
            os.unlink(effective_key)


def reset_ssh_known_hosts() -> bool:
    """Elimina el fichero known_hosts para forzar re-aceptación del fingerprint."""
    import os

    path = "/data/ssh_known_hosts"
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def _parse_router_arp(raw: str) -> Dict[str, Dict[str, str]]:
    result: Dict[str, Dict[str, str]] = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 6 or parts[0] == "IP":
            continue

        ip = parts[0].strip()
        flags = parts[2].strip().lower()
        mac = parts[3].strip().upper()
        iface = parts[5].strip()

        if not re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
            continue
        if iface == "eth1":
            continue

        item: Dict[str, str] = {
            "arp_flags": flags,
            "iface": iface,
        }
        if re.match(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", mac) and mac != "00:00:00:00:00:00":
            item["mac"] = mac

        result[ip] = item
    return result


def _parse_dnsmasq_leases(raw: str) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    now_ts = int(utc_now().timestamp())

    for line in raw.splitlines():
        parts = line.strip().split()
        if len(parts) < 4:
            continue

        try:
            raw_expire = int(parts[0])
            mac = parts[1].upper()
            ip = parts[2]
            hostname = parts[3] if parts[3] != "*" else ""
        except (ValueError, IndexError):
            continue

        if not re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
            continue
        if not re.match(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", mac):
            continue

        # Compatibilidad con variantes de dnsmasq:
        # - epoch Unix absoluto
        # - segundos restantes (observado en ASUS)
        if raw_expire <= 0:
            lease_secs = 0
            expires_iso = None
        elif raw_expire < 1_000_000_000:
            lease_secs = raw_expire
            expires_iso = datetime.fromtimestamp(
                now_ts + raw_expire, tz=timezone.utc
            ).isoformat()
        else:
            lease_secs = max(0, raw_expire - now_ts)
            expires_iso = datetime.fromtimestamp(
                raw_expire, tz=timezone.utc
            ).isoformat()

        result[ip] = {
            "ip": ip,
            "mac": mac,
            "hostname": hostname,
            "lease_secs": lease_secs,
            "lease_expires": expires_iso,
        }

    return result


RouterData = Dict[str, Any]

# Criterio conservador de presencia real:
# - REACHABLE / DELAY / PROBE / PERMANENT cuentan como activos
# - STALE ya no cuenta como activo para evitar "silent" por caché envejecida
_ROUTER_ACTIVE_NEIGH_STATES = {"REACHABLE", "DELAY", "PROBE", "PERMANENT"}
_ROUTER_INACTIVE_NEIGH_STATES = {"STALE", "INCOMPLETE", "FAILED"}


def _parse_router_neigh(raw: str) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    known_states = _ROUTER_ACTIVE_NEIGH_STATES | _ROUTER_INACTIVE_NEIGH_STATES | {"NOARP"}

    for line in raw.splitlines():
        parts = line.strip().split()
        if not parts:
            continue

        ip = parts[0].strip()
        if not re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
            continue

        iface = ""
        if "dev" in parts:
            try:
                iface = parts[parts.index("dev") + 1].strip()
            except Exception:
                iface = ""
        if iface == "eth1":
            continue

        mac = ""
        if "lladdr" in parts:
            try:
                cand = parts[parts.index("lladdr") + 1].strip().upper()
                if re.match(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", cand):
                    mac = cand
            except Exception:
                mac = ""

        neigh_state = ""
        for token in reversed(parts):
            token_up = token.strip().upper()
            if token_up in known_states:
                neigh_state = token_up
                break

        item: Dict[str, Any] = {
            "iface": iface,
            "neigh_state": neigh_state,
        }
        if mac:
            item["mac"] = mac
        result[ip] = item

    return result


def _router_presence_from_signals(neigh_state: str, arp_flags: str) -> Tuple[bool, str]:
    neigh = (neigh_state or "").strip().upper()
    arp = (arp_flags or "").strip().lower()

    if neigh in _ROUTER_ACTIVE_NEIGH_STATES:
        return True, f"neigh:{neigh.lower()}"
    if neigh in _ROUTER_INACTIVE_NEIGH_STATES:
        return False, f"neigh:{neigh.lower()}"
    if arp == "0x2":
        return True, "arp:complete"
    if arp == "0x0":
        return False, "arp:incomplete"
    return False, "unknown"


def _get_router_management_ip() -> str:
    host = str(cfg("router_ssh_host", "") or "").strip()
    return host if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) else ""


def fetch_router_data(include_inactive: bool = False) -> Tuple[Dict[str, RouterData], str]:
    try:
        raw = _ssh_run([
            "cat /proc/net/arp",
            "cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /var/tmp/dnsmasq.leases 2>/dev/null || true",
            "ip neigh show",
        ])
    except Exception as e:
        return {}, str(e)

    parts = raw.split("---SEP---")
    arp_raw = parts[0] if len(parts) > 0 else ""
    leases_raw = parts[1] if len(parts) > 1 else ""
    neigh_raw = parts[2] if len(parts) > 2 else ""

    arp_by_ip = _parse_router_arp(arp_raw)
    leases_by_ip = _parse_dnsmasq_leases(leases_raw)
    neigh_by_ip = _parse_router_neigh(neigh_raw)

    result: Dict[str, RouterData] = {}
    all_ips = set(arp_by_ip.keys()) | set(leases_by_ip.keys()) | set(neigh_by_ip.keys())

    for ip in sorted(all_ips, key=lambda x: tuple(int(p) for p in x.split("."))):
        arp = arp_by_ip.get(ip, {})
        lease = leases_by_ip.get(ip, {})
        neigh = neigh_by_ip.get(ip, {})

        mac = (
            (neigh.get("mac") or "")
            or (arp.get("mac") or "")
            or (lease.get("mac") or "")
        ).strip().upper()
        arp_flags = (arp.get("arp_flags") or "").strip().lower()
        neigh_state = (neigh.get("neigh_state") or "").strip().upper()
        router_active, presence_source = _router_presence_from_signals(neigh_state, arp_flags)

        item: RouterData = {
            "mac": mac,
            "router_hostname": lease.get("hostname") or "",
            "ip_assignment": "dhcp" if lease else "static",
            "dhcp_lease_secs": lease.get("lease_secs"),
            "dhcp_lease_expires": lease.get("lease_expires"),
            "router_seen": bool(router_active),
            "router_active": bool(router_active),
            "router_presence_source": presence_source,
            "neigh_state": neigh_state,
            "arp_flags": arp_flags,
        }

        if not include_inactive and not router_active:
            continue
        result[ip] = item

    router_ip = _get_router_management_ip()
    if router_ip:
        arp = arp_by_ip.get(router_ip, {})
        lease = leases_by_ip.get(router_ip, {})
        neigh = neigh_by_ip.get(router_ip, {})
        existing = result.get(router_ip, {})

        mac = (
            (existing.get("mac") or "")
            or (neigh.get("mac") or "")
            or (arp.get("mac") or "")
            or (lease.get("mac") or "")
        ).strip().upper()
        arp_flags = (existing.get("arp_flags") or arp.get("arp_flags") or "").strip().lower()
        neigh_state = (existing.get("neigh_state") or neigh.get("neigh_state") or "").strip().upper()
        presence_source = (existing.get("router_presence_source") or "").strip() or "ssh:self"

        result[router_ip] = {
            **existing,
            "mac": mac,
            "router_hostname": (existing.get("router_hostname") or lease.get("hostname") or "").strip(),
            "ip_assignment": (existing.get("ip_assignment") or ("dhcp" if lease else "static")).strip(),
            "dhcp_lease_secs": existing.get("dhcp_lease_secs", lease.get("lease_secs")),
            "dhcp_lease_expires": existing.get("dhcp_lease_expires", lease.get("lease_expires")),
            "router_seen": True,
            "router_active": True,
            "router_self": True,
            "router_presence_source": presence_source,
            "neigh_state": neigh_state,
            "arp_flags": arp_flags,
        }

    return result, ""


def resolve_ptr(ip: str) -> Optional[str]:
    try:
        rev = dns.reversename.from_address(ip)
        resolver = dns.resolver.Resolver(configure=True)
        dns_srv = cfg("dns_server", "")
        if dns_srv:
            resolver.nameservers = [dns_srv]
        ans = resolver.resolve(rev, "PTR", lifetime=2.0)
        return str(ans[0]).rstrip(".")
    except Exception:
        return None


def get_local_ips_in_cidr(cidr: str) -> List[Dict[str, Optional[str]]]:
    """
    Retorna las IPs locales del servidor que caen dentro del CIDR dado.
    nmap nunca reporta el propio host — las inyectamos manualmente.
    """
    try:
        import ipaddress as _ipa
        import json as _json

        net = _ipa.ip_network(cidr, strict=False)
        result = subprocess.run(
            ["ip", "-j", "addr"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []
        ifaces = _json.loads(result.stdout)
        local = []
        for iface in ifaces:
            name = iface.get("ifname", "")
            if not name or name == "lo" or name.startswith(("docker", "br-", "veth")):
                continue
            mac = iface.get("address", "")
            for addr_info in iface.get("addr_info", []):
                if addr_info.get("family") != "inet":
                    continue
                try:
                    ip = addr_info["local"]
                    if _ipa.ip_address(ip) in net:
                        local.append(
                            {
                                "ip": ip,
                                "mac": mac.upper() if mac else None,
                                "nmap_hostname": None,
                                "latency_ms": 0.0,
                            }
                        )
                except (KeyError, ValueError):
                    continue
        return local
    except Exception:
        return []


def auto_detect_interface(cidr: str) -> str:
    """
    Detecta la interfaz de red correcta para llegar al CIDR dado.
    Busca qué interfaz local tiene una IP dentro de ese rango.
    Retorna el nombre de interfaz o '' si no encuentra.
    """
    try:
        import ipaddress as _ipa
        import json as _json

        net = _ipa.ip_network(cidr, strict=False)
        result = subprocess.run(
            ["ip", "-j", "addr"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return ""
        ifaces = _json.loads(result.stdout)
        for iface in ifaces:
            name = iface.get("ifname", "")
            if not name or name == "lo" or name.startswith(("docker", "br-", "veth")):
                continue
            for addr_info in iface.get("addr_info", []):
                if addr_info.get("family") != "inet":
                    continue
                try:
                    local_ip = _ipa.ip_address(addr_info["local"])
                    if local_ip in net:
                        return name
                except (KeyError, ValueError):
                    continue
    except Exception:
        pass
    return ""


def run_nmap_ping_sweep(cidr: str, interface: str = "") -> str:
    """
    Ping sweep rápido.
    La interfaz se auto-detecta por CIDR si no se especifica explícitamente.
    """
    iface = interface.strip() if interface else auto_detect_interface(cidr)

    cmd = [
        "nmap",
        "-sn",
        "-n",
        "--min-rtt-timeout",
        "200ms",
        "--max-rtt-timeout",
        "1500ms",
        "--host-timeout",
        "6s",
    ]
    if iface:
        cmd += ["-e", iface]
    cmd.append(cidr)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if p.returncode != 0 and not p.stdout.strip() and p.stderr.strip():
        raise RuntimeError(p.stderr.strip())
    return p.stdout


def parse_nmap(output: str) -> List[Dict[str, Optional[str]]]:
    results: List[Dict[str, Optional[str]]] = []
    cur: Dict[str, Optional[str]] = {
        "ip": None,
        "mac": None,
        "nmap_hostname": None,
        "latency_ms": None,
    }

    re_report = re.compile(r"^Nmap scan report for (.+)$")
    re_mac = re.compile(r"^MAC Address:\s+([0-9A-Fa-f:]{17})")
    re_latency = re.compile(r"Host is up \(([0-9.]+)s latency\)")

    for line in output.splitlines():
        line = line.strip()
        m = re_report.match(line)
        if m:
            if cur.get("ip"):
                results.append(cur)
            cur = {
                "ip": None,
                "mac": None,
                "nmap_hostname": None,
                "latency_ms": None,
            }
            target = m.group(1)
            if "(" in target and target.endswith(")"):
                name, ip_part = target.rsplit("(", 1)
                cur["ip"] = ip_part.strip(" )")
                cur["nmap_hostname"] = name.strip()
            else:
                cur["ip"] = target.strip()
            continue
        m = re_mac.match(line)
        if m and cur.get("ip"):
            cur["mac"] = m.group(1).upper()
            continue
        m = re_latency.match(line)
        if m and cur.get("ip"):
            try:
                cur["latency_ms"] = round(float(m.group(1)) * 1000, 2)
            except Exception:
                pass

    if cur.get("ip"):
        results.append(cur)
    return [r for r in results if r.get("ip")]


def read_arp_cache() -> Dict[str, str]:
    try:
        p = subprocess.run(["ip", "neigh"], capture_output=True, text=True)
        out = p.stdout or ""
    except Exception:
        return {}
    arp: Dict[str, str] = {}
    for line in out.splitlines():
        parts = line.strip().split()
        if not parts:
            continue
        ip = parts[0]
        if "lladdr" in parts:
            try:
                mac = parts[parts.index("lladdr") + 1].upper().replace("-", ":")
                if re.match(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", mac):
                    arp[ip] = mac
            except Exception:
                pass
    return arp
