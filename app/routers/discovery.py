"""
routers/discovery.py — helper canónico de discovery networks.

Objetivo:
- mantener compatibilidad con el modelo actual (scan_cidr + secondary_networks)
- permitir convivir con el schema nuevo (discovery_scanners + discovery_scanner_networks)
- ofrecer una lectura unificada para backend/UI
- dejar quality fuera de esta capa
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from config import cfg, SCAN_CIDR
from database import db
from utils import utc_now_iso


router = APIRouter()


def _split_cidrs(raw: str) -> List[str]:
    return [c.strip() for c in str(raw or "").split(",") if c and c.strip()]


def _setting(key: str, default: str = "") -> str:
    """
    Lee primero desde la tabla settings para evitar desalineaciones entre la BD y
    caches/config cargadas en memoria durante la transición.
    """
    try:
        with db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            if row and row[0] is not None:
                return str(row[0])
    except Exception:
        pass
    try:
        return str(cfg(key, default) or default)
    except Exception:
        return str(default)


def _normalize_method(raw: str) -> str:
    value = (raw or "").strip().lower()
    if value in {"router", "nmap", "router+nmap"}:
        return value
    if value in {"router_nmap", "router+nmap", "router+nmap "}:
        return "router+nmap"
    if value == "none":
        return "nmap"
    return "router" if value == "router" else "nmap"


def _normalize_source(raw: str) -> str:
    value = (raw or "").strip().lower()
    if value in {"legacy", "schema", "auto"}:
        return value
    return "legacy"


def _schema_has_rows() -> bool:
    try:
        with db() as conn:
            row = conn.execute("SELECT 1 FROM discovery_scanners LIMIT 1").fetchone()
            return bool(row)
    except Exception:
        return False


def get_discovery_runtime_source_setting() -> str:
    return _normalize_source(_setting("discovery_runtime_source", "legacy"))


def _int_or_none(value: Any) -> int | None:
    try:
        if value is None or str(value).strip() == "":
            return None
        return int(value)
    except Exception:
        return None


def _load_router_profiles(active_only: bool = False) -> List[Dict[str, Any]]:
    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT id, name, host, port, user, key_path, router_type, notes, enabled,
                       created_at, updated_at
                FROM router_profiles
                ORDER BY id ASC
                """
            ).fetchall()
    except Exception:
        return []

    profiles: List[Dict[str, Any]] = []
    for row in rows:
        item = {
            "id": row["id"],
            "name": (row["name"] or "").strip(),
            "host": (row["host"] or "").strip(),
            "port": int(row["port"] or 22),
            "user": (row["user"] or "").strip(),
            "key_path": (row["key_path"] or "").strip(),
            "router_type": (row["router_type"] or "").strip(),
            "notes": (row["notes"] or "").strip(),
            "enabled": int(row["enabled"] or 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if active_only and item["enabled"] != 1:
            continue
        profiles.append(item)
    return profiles


def _router_profiles_by_id(active_only: bool = False) -> Dict[int, Dict[str, Any]]:
    return {int(p["id"]): p for p in _load_router_profiles(active_only=active_only)}


def _current_legacy_router_profile_id() -> int | None:
    host = (_setting("router_ssh_host", "") or "").strip()
    user = (_setting("router_ssh_user", "") or "").strip()
    key_path = (_setting("router_ssh_key", "") or "").strip()
    port = _int_or_none(_setting("router_ssh_port", "22")) or 22
    if not any([host, user, key_path]):
        return None
    try:
        with db() as conn:
            row = conn.execute(
                """
                SELECT id
                FROM router_profiles
                WHERE host=? AND port=? AND user=? AND key_path=?
                ORDER BY id ASC LIMIT 1
                """,
                (host, port, user, key_path),
            ).fetchone()
        return int(row["id"]) if row else None
    except Exception:
        return None


def _router_profile_name(profile_id: Any, profiles_by_id: Dict[int, Dict[str, Any]] | None = None) -> str:
    pid = _int_or_none(profile_id)
    if not pid:
        return ""
    profiles_by_id = profiles_by_id or _router_profiles_by_id(active_only=False)
    profile = profiles_by_id.get(pid) or {}
    return (profile.get("name") or "").strip()


def _normalize_networks_payload(raw: Any) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []

    if isinstance(raw, str):
        raw_lines = [x.strip() for x in raw.replace(";", "\n").splitlines()]
        raw = [line for line in raw_lines if line]

    if not isinstance(raw, list):
        raw = []

    for entry in raw:
        if isinstance(entry, dict):
            cidr = str(entry.get("cidr") or "").strip()
            label = str(entry.get("label") or "").strip()
            enabled = int(entry.get("enabled", 1) or 0)
        else:
            line = str(entry or "").strip()
            if not line:
                continue
            if "|" in line:
                cidr, label = [part.strip() for part in line.split("|", 1)]
            else:
                cidr, label = line, ""
            enabled = 1

        if not cidr:
            continue

        items.append({
            "cidr": cidr,
            "label": label,
            "enabled": enabled,
            "sort_order": len(items),
        })

    return items


def _replace_scanner_networks(conn, scanner_id: int, networks: List[Dict[str, Any]]) -> None:
    conn.execute("DELETE FROM discovery_scanner_networks WHERE scanner_id=?", (scanner_id,))
    now = utc_now_iso()
    for idx, net in enumerate(networks):
        cidr = str(net.get("cidr") or "").strip()
        if not cidr:
            continue
        conn.execute(
            """
            INSERT INTO discovery_scanner_networks
                (scanner_id, cidr, label, enabled, sort_order, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                scanner_id,
                cidr,
                str(net.get("label") or "").strip(),
                int(net.get("enabled", 1) or 0),
                int(net.get("sort_order", idx) or idx),
                net.get("created_at") or now,
                now,
            ),
        )


def _normalize_scanner_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    method = _normalize_method(payload.get("method") or "nmap")
    router_profile_id = _int_or_none(payload.get("router_profile_id"))
    if method not in {"router", "router+nmap"}:
        router_profile_id = None

    name = str(payload.get("name") or "").strip()
    interface = str(payload.get("interface") or "").strip()
    enabled = int(payload.get("enabled", 1) or 0)
    networks = _normalize_networks_payload(payload.get("networks") or payload.get("networks_raw") or [])

    if not name:
        name = interface or (networks[0].get("label") if networks else "") or "Nuevo escáner"

    return {
        "name": name,
        "interface": interface,
        "method": method,
        "router_profile_id": router_profile_id,
        "enabled": enabled,
        "networks": networks,
    }


def _load_schema_scanners(active_only: bool = False) -> List[Dict[str, Any]]:
    """
    Lee el nuevo schema si está poblado.

    Devuelve una lista de scanners con estructura:
    {
      id, name, interface, method, router_profile_id, enabled, sort_order,
      created_at, updated_at, origin, networks:[...]
    }
    """
    try:
        with db() as conn:
            scanner_rows = conn.execute(
                """
                SELECT id, name, interface, method, router_profile_id, enabled,
                       sort_order, created_at, updated_at
                FROM discovery_scanners
                ORDER BY sort_order ASC, id ASC
                """
            ).fetchall()
            if not scanner_rows:
                return []

            net_rows = conn.execute(
                """
                SELECT id, scanner_id, cidr, label, enabled, sort_order, created_at, updated_at
                FROM discovery_scanner_networks
                ORDER BY scanner_id ASC, sort_order ASC, id ASC
                """
            ).fetchall()
    except Exception:
        return []

    nets_by_scanner: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for row in net_rows:
        item = {
            "id": row["id"],
            "scanner_id": row["scanner_id"],
            "cidr": (row["cidr"] or "").strip(),
            "label": (row["label"] or "").strip(),
            "enabled": int(row["enabled"] or 0),
            "sort_order": int(row["sort_order"] or 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "origin": "discovery_scanner_networks",
        }
        if active_only and item["enabled"] != 1:
            continue
        if not item["cidr"]:
            continue
        nets_by_scanner[row["scanner_id"]].append(item)

    profiles_by_id = _router_profiles_by_id(active_only=False)

    scanners: List[Dict[str, Any]] = []
    for row in scanner_rows:
        router_profile_id = _int_or_none(row["router_profile_id"])
        item = {
            "id": row["id"],
            "name": (row["name"] or "").strip(),
            "interface": (row["interface"] or "").strip(),
            "method": _normalize_method(row["method"] or "nmap"),
            "router_profile_id": router_profile_id,
            "router_profile_name": _router_profile_name(router_profile_id, profiles_by_id),
            "enabled": int(row["enabled"] or 0),
            "sort_order": int(row["sort_order"] or 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "origin": "discovery_scanners",
            "networks": list(nets_by_scanner.get(row["id"], [])),
        }
        if active_only and item["enabled"] != 1:
            continue
        if active_only and not item["networks"]:
            continue
        scanners.append(item)

    return scanners


def _load_legacy_scanners(active_only: bool = False) -> List[Dict[str, Any]]:
    """
    Proyección del modelo actual al nuevo contrato de scanners.

    - Un scanner primario derivado de scan_cidr + primary_net_interface
    - 0..N scanners secundarios agrupados por interfaz usando secondary_networks
    """
    scanners: List[Dict[str, Any]] = []

    primary_label = (_setting("primary_net_label", "") or "").strip()
    primary_iface = (_setting("primary_net_interface", "") or "").strip()
    primary_name = primary_label or "Scanner principal"
    primary_method = _normalize_method(_setting("scan_primary_source", "router"))
    profiles_by_id = _router_profiles_by_id(active_only=False)
    active_legacy_router_profile_id = _current_legacy_router_profile_id()

    primary_networks = []
    for idx, cidr in enumerate(_split_cidrs(_setting("scan_cidr", SCAN_CIDR)), start=1):
        primary_networks.append({
            "id": f"legacy:primary-net:{idx}",
            "scanner_id": "legacy:primary",
            "cidr": cidr,
            "label": primary_label,
            "enabled": 1,
            "sort_order": idx - 1,
            "created_at": "",
            "updated_at": "",
            "origin": "settings",
        })

    if primary_networks or not active_only:
        scanners.append({
            "id": "legacy:primary",
            "name": primary_name,
            "interface": primary_iface,
            "method": primary_method,
            "router_profile_id": active_legacy_router_profile_id if primary_method in {"router", "router+nmap"} else None,
            "router_profile_name": _router_profile_name(active_legacy_router_profile_id, profiles_by_id) if primary_method in {"router", "router+nmap"} else "",
            "enabled": 1,
            "sort_order": 0,
            "created_at": "",
            "updated_at": "",
            "origin": "settings",
            "networks": primary_networks,
        })

    secondary_method = _normalize_method(_setting("scan_secondary_source", "nmap"))
    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    try:
        with db() as conn:
            rows = conn.execute(
                """
                SELECT id, label, cidr, interface, enabled, created_at
                FROM secondary_networks
                ORDER BY id ASC
                """
            ).fetchall()
    except Exception:
        rows = []

    for row in rows:
        enabled = int(row["enabled"] or 0)
        if active_only and enabled != 1:
            continue
        cidr = (row["cidr"] or "").strip()
        if not cidr:
            continue
        iface = (row["interface"] or "").strip()
        group_key = iface or f"__noiface__:{row['id']}"
        grouped[group_key].append({
            "id": row["id"],
            "scanner_id": None,
            "cidr": cidr,
            "label": (row["label"] or "").strip(),
            "enabled": enabled,
            "sort_order": len(grouped[group_key]),
            "created_at": row["created_at"],
            "updated_at": row["created_at"],
            "origin": "secondary_networks",
        })

    sort_order = 1
    for group_key, nets in grouped.items():
        iface = "" if group_key.startswith("__noiface__:") else group_key
        scanner_id = f"legacy:secondary:{sort_order}"
        for net in nets:
            net["scanner_id"] = scanner_id
        scanner_name = iface or (nets[0].get("label") or f"Scanner secundario {sort_order}")
        scanners.append({
            "id": scanner_id,
            "name": scanner_name,
            "interface": iface,
            "method": secondary_method,
            "router_profile_id": active_legacy_router_profile_id if secondary_method in {"router", "router+nmap"} else None,
            "router_profile_name": _router_profile_name(active_legacy_router_profile_id, profiles_by_id) if secondary_method in {"router", "router+nmap"} else "",
            "enabled": 1 if any(int(n.get("enabled", 0) or 0) == 1 for n in nets) else 0,
            "sort_order": sort_order,
            "created_at": nets[0].get("created_at", ""),
            "updated_at": nets[0].get("updated_at", ""),
            "origin": "secondary_networks",
            "networks": nets,
        })
        sort_order += 1

    return scanners


def get_discovery_source() -> str:
    desired = get_discovery_runtime_source_setting()
    has_schema = _schema_has_rows()

    if desired == "schema" and has_schema:
        return "schema"
    if desired == "auto" and has_schema:
        return "schema"
    return "legacy"


def get_discovery_scanners(active_only: bool = False) -> List[Dict[str, Any]]:
    """
    Devuelve la fuente canónica de scanners.

    D3:
    - El schema nuevo puede estar sembrado pero no activo todavía.
    - La fuente efectiva depende de discovery_runtime_source.
    """
    if get_discovery_source() == "schema":
        schema_scanners = _load_schema_scanners(active_only=active_only)
        if schema_scanners:
            return schema_scanners
    return _load_legacy_scanners(active_only=active_only)


def get_discovery_networks(active_only: bool = False) -> List[Dict[str, Any]]:
    """
    Devuelve una vista lógica única de las redes de discovery.

    Para compatibilidad con consumidores legacy:
    - las redes del primer scanner visible se marcan como "primary"
    - las del resto se marcan como "secondary"
    """
    scanners = get_discovery_scanners(active_only=active_only)
    networks: List[Dict[str, Any]] = []

    primary_scanner_id = scanners[0]["id"] if scanners else None

    for scanner in scanners:
        scanner_is_primary = scanner["id"] == primary_scanner_id
        for idx, net in enumerate(scanner.get("networks", []), start=1):
            networks.append({
                "id": net.get("id"),
                "db_id": net.get("id") if isinstance(net.get("id"), int) else None,
                "kind": "primary" if scanner_is_primary else "secondary",
                "origin": net.get("origin") or scanner.get("origin") or "unknown",
                "cidr": net.get("cidr", ""),
                "interface": scanner.get("interface", ""),
                "label": net.get("label", "") or scanner.get("name", ""),
                "enabled": int(net.get("enabled", 0) or 0) if scanner.get("enabled", 1) else 0,
                "created_at": net.get("created_at", ""),
                "updated_at": net.get("updated_at", ""),
                "scanner_id": scanner.get("id"),
                "scanner_name": scanner.get("name", ""),
                "scanner_method": scanner.get("method", "nmap"),
                "router_profile_id": scanner.get("router_profile_id"),
                "router_profile_name": scanner.get("router_profile_name", ""),
                "scanner_sort_order": scanner.get("sort_order", 0),
                "network_sort_order": net.get("sort_order", idx - 1),
            })

    if active_only:
        networks = [n for n in networks if int(n.get("enabled", 0) or 0) == 1]

    return networks


def get_primary_discovery_cidrs() -> List[str]:
    return [
        n["cidr"]
        for n in get_discovery_networks(active_only=True)
        if n.get("kind") == "primary" and n.get("cidr")
    ]


def get_secondary_discovery_networks() -> List[Dict[str, Any]]:
    return [
        {
            "id": n.get("db_id"),
            "label": n.get("label", ""),
            "cidr": n.get("cidr", ""),
            "interface": n.get("interface", ""),
            "enabled": int(n.get("enabled", 0) or 0),
        }
        for n in get_discovery_networks(active_only=True)
        if n.get("kind") == "secondary" and n.get("cidr")
    ]

def get_discovery_scan_jobs(active_only: bool = True) -> List[Dict[str, Any]]:
    """
    Aplana el modelo canónico de discovery a jobs ejecutables por red.

    Cada job representa una red concreta de un scanner activo:
    {
      scanner_id, scanner_name, scanner_method, router_profile_id,
      cidr, interface, label, enabled, kind,
      scanner_sort_order, network_sort_order
    }
    """
    jobs: List[Dict[str, Any]] = []
    scanners = get_discovery_scanners(active_only=active_only)
    primary_scanner_id = scanners[0]["id"] if scanners else None

    for scanner in scanners:
        scanner_enabled = int(scanner.get("enabled", 0) or 0) == 1
        if active_only and not scanner_enabled:
            continue

        for net in scanner.get("networks", []) or []:
            net_enabled = int(net.get("enabled", 0) or 0) == 1
            if active_only and not net_enabled:
                continue

            cidr = (net.get("cidr") or "").strip()
            if not cidr:
                continue

            jobs.append({
                "scanner_id": scanner.get("id"),
                "scanner_name": scanner.get("name", ""),
                "scanner_method": scanner.get("method", "nmap"),
                "router_profile_id": scanner.get("router_profile_id"),
                "router_profile_name": scanner.get("router_profile_name", ""),
                "cidr": cidr,
                "label": (net.get("label") or scanner.get("name") or "").strip(),
                "interface": (scanner.get("interface") or "").strip(),
                "enabled": int(net.get("enabled", 0) or 0) if scanner_enabled else 0,
                "kind": "primary" if scanner.get("id") == primary_scanner_id else "secondary",
                "scanner_sort_order": int(scanner.get("sort_order", 0) or 0),
                "network_sort_order": int(net.get("sort_order", 0) or 0),
                "origin": net.get("origin") or scanner.get("origin") or "unknown",
            })

    jobs.sort(key=lambda j: (j.get("scanner_sort_order", 0), j.get("network_sort_order", 0), str(j.get("cidr") or "")))
    return jobs


def get_discovery_legacy_projection(active_only: bool = False) -> Dict[str, Any]:
    """
    Proyecta el contrato canónico a la forma legacy esperada por parte de la app:
    - scan_cidr
    - primary_net_interface
    - primary_net_label
    - secondary_networks
    """
    scanners = get_discovery_scanners(active_only=active_only)
    primary = scanners[0] if scanners else None

    primary_networks = primary.get("networks", []) if primary else []
    scan_cidr = ",".join(
        (n.get("cidr") or "").strip()
        for n in primary_networks
        if (n.get("cidr") or "").strip()
    )

    primary_label = ""
    if primary:
        primary_label = (primary.get("name") or "").strip()
        if not primary_label and primary_networks:
            primary_label = (primary_networks[0].get("label") or "").strip()

    secondaries = get_secondary_discovery_networks()

    return {
        "source": get_discovery_source(),
        "scan_cidr": scan_cidr,
        "primary_net_interface": (primary.get("interface") or "").strip() if primary else "",
        "primary_net_label": primary_label,
        "secondary_networks": secondaries,
        "discovery_networks": get_discovery_networks(active_only=active_only),
        "discovery_scanners": scanners,
    }




def _router_profile_seed_payload() -> Dict[str, Any] | None:
    enabled = (_setting("router_enabled", "0") or "0").strip() == "1"
    host = (_setting("router_ssh_host", "") or "").strip()
    user = (_setting("router_ssh_user", "") or "").strip()
    key_path = (_setting("router_ssh_key", "") or "").strip()
    port_raw = (_setting("router_ssh_port", "22") or "22").strip()
    notes = "Sembrado inicial desde configuración legacy de Router SSH"

    if not enabled and not any([host, user, key_path]):
        return None
    try:
        port = int(port_raw or "22")
    except Exception:
        port = 22

    name = (_setting("primary_net_label", "") or "").strip() or host or "Router principal"
    return {
        "name": name,
        "host": host,
        "port": port,
        "user": user,
        "key_path": key_path,
        "router_type": "",
        "notes": notes,
        "enabled": 1 if enabled or host else 0,
    }


def _ensure_seeded_router_profile(conn) -> int | None:
    payload = _router_profile_seed_payload()
    if not payload:
        return None

    row = conn.execute(
        '''
        SELECT id
        FROM router_profiles
        WHERE host=? AND port=? AND user=? AND key_path=?
        ORDER BY id ASC LIMIT 1
        ''',
        (payload["host"], payload["port"], payload["user"], payload["key_path"]),
    ).fetchone()
    if row:
        return row["id"]

    now = utc_now_iso()
    conn.execute(
        '''
        INSERT INTO router_profiles
            (name, host, port, user, key_path, router_type, notes, enabled, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ''',
        (
            payload["name"],
            payload["host"],
            payload["port"],
            payload["user"],
            payload["key_path"],
            payload["router_type"],
            payload["notes"],
            payload["enabled"],
            now,
            now,
        ),
    )
    new_row = conn.execute("SELECT last_insert_rowid()").fetchone()
    return int(new_row[0]) if new_row else None


def seed_discovery_schema_from_legacy(overwrite: bool = False, include_router_profile: bool = True) -> Dict[str, Any]:
    """
    Siembra discovery_scanners / discovery_scanner_networks desde el modelo legacy
    actual, pero NO cambia la fuente efectiva mientras discovery_runtime_source
    siga en 'legacy'.

    overwrite=False:
    - si ya hay scanners en schema, no hace nada

    overwrite=True:
    - borra scanners/networks del schema nuevo y vuelve a sembrar
    - no elimina router_profiles ya existentes
    """
    legacy_scanners = _load_legacy_scanners(active_only=False)

    with db() as conn:
        existing_scanners = conn.execute("SELECT COUNT(*) FROM discovery_scanners").fetchone()[0]
        existing_networks = conn.execute("SELECT COUNT(*) FROM discovery_scanner_networks").fetchone()[0]
        existing_profiles = conn.execute("SELECT COUNT(*) FROM router_profiles").fetchone()[0]

        if (existing_scanners or existing_networks) and not overwrite:
            return {
                "ok": True,
                "seeded": False,
                "reason": "schema_not_empty",
                "runtime_source": get_discovery_source(),
                "runtime_source_setting": get_discovery_runtime_source_setting(),
                "existing": {
                    "router_profiles": int(existing_profiles or 0),
                    "discovery_scanners": int(existing_scanners or 0),
                    "discovery_scanner_networks": int(existing_networks or 0),
                },
            }

        if overwrite:
            conn.execute("DELETE FROM discovery_scanner_networks")
            conn.execute("DELETE FROM discovery_scanners")

        router_profile_id = _ensure_seeded_router_profile(conn) if include_router_profile else None

        scanners_inserted = 0
        networks_inserted = 0

        for scanner in legacy_scanners:
            method = _normalize_method(scanner.get("method") or "nmap")
            use_router = method in {"router", "router+nmap"}

            now = utc_now_iso()
            conn.execute(
                '''
                INSERT INTO discovery_scanners
                    (name, interface, method, router_profile_id, enabled, sort_order, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                ''',
                (
                    (scanner.get("name") or "").strip(),
                    (scanner.get("interface") or "").strip(),
                    method,
                    router_profile_id if use_router else None,
                    int(scanner.get("enabled", 1) or 0),
                    int(scanner.get("sort_order", 0) or 0),
                    scanner.get("created_at") or now,
                    scanner.get("updated_at") or now,
                ),
            )
            scanner_row = conn.execute("SELECT last_insert_rowid()").fetchone()
            new_scanner_id = int(scanner_row[0])
            scanners_inserted += 1

            for net in scanner.get("networks", []):
                conn.execute(
                    '''
                    INSERT INTO discovery_scanner_networks
                        (scanner_id, cidr, label, enabled, sort_order, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?)
                    ''',
                    (
                        new_scanner_id,
                        (net.get("cidr") or "").strip(),
                        (net.get("label") or "").strip(),
                        int(net.get("enabled", 1) or 0),
                        int(net.get("sort_order", 0) or 0),
                        net.get("created_at") or now,
                        net.get("updated_at") or now,
                    ),
                )
                networks_inserted += 1

        final_profiles = conn.execute("SELECT COUNT(*) FROM router_profiles").fetchone()[0]
        final_scanners = conn.execute("SELECT COUNT(*) FROM discovery_scanners").fetchone()[0]
        final_networks = conn.execute("SELECT COUNT(*) FROM discovery_scanner_networks").fetchone()[0]

    return {
        "ok": True,
        "seeded": True,
        "runtime_source": get_discovery_source(),
        "runtime_source_setting": get_discovery_runtime_source_setting(),
        "inserted": {
            "router_profile_seeded": 1 if router_profile_id else 0,
            "discovery_scanners": scanners_inserted,
            "discovery_scanner_networks": networks_inserted,
        },
        "totals": {
            "router_profiles": int(final_profiles or 0),
            "discovery_scanners": int(final_scanners or 0),
            "discovery_scanner_networks": int(final_networks or 0),
        },
    }


@router.get("/api/discovery/scanners")
def api_discovery_scanners_list():
    return {
        "ok": True,
        "source": get_discovery_source(),
        "runtime_source_setting": get_discovery_runtime_source_setting(),
        "scanners": get_discovery_scanners(active_only=False),
        "router_profiles": _load_router_profiles(active_only=False),
    }


@router.post("/api/discovery/scanners")
def api_discovery_scanners_create(payload: Dict[str, Any] = Body(...)):
    normalized = _normalize_scanner_payload(payload or {})
    if not normalized["networks"]:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Debes indicar al menos una red CIDR"})

    with db() as conn:
        row = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM discovery_scanners").fetchone()
        sort_order = int(row[0] or 0)
        now = utc_now_iso()
        conn.execute(
            """
            INSERT INTO discovery_scanners
                (name, interface, method, router_profile_id, enabled, sort_order, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (
                normalized["name"],
                normalized["interface"],
                normalized["method"],
                normalized["router_profile_id"],
                normalized["enabled"],
                sort_order,
                now,
                now,
            ),
        )
        new_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        _replace_scanner_networks(conn, new_id, normalized["networks"])

    return {"ok": True, "id": new_id}


@router.put("/api/discovery/scanners/{scanner_id}")
def api_discovery_scanners_update(scanner_id: int, payload: Dict[str, Any] = Body(...)):
    normalized = _normalize_scanner_payload(payload or {})
    if not normalized["networks"]:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Debes indicar al menos una red CIDR"})

    with db() as conn:
        row = conn.execute("SELECT id FROM discovery_scanners WHERE id=?", (scanner_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"ok": False, "error": "Escáner no encontrado"})
        now = utc_now_iso()
        conn.execute(
            """
            UPDATE discovery_scanners
            SET name=?, interface=?, method=?, router_profile_id=?, enabled=?, updated_at=?
            WHERE id=?
            """,
            (
                normalized["name"],
                normalized["interface"],
                normalized["method"],
                normalized["router_profile_id"],
                normalized["enabled"],
                now,
                scanner_id,
            ),
        )
        _replace_scanner_networks(conn, scanner_id, normalized["networks"])

    return {"ok": True, "id": scanner_id}


@router.delete("/api/discovery/scanners/{scanner_id}")
def api_discovery_scanners_delete(scanner_id: int):
    with db() as conn:
        row = conn.execute("SELECT id FROM discovery_scanners WHERE id=?", (scanner_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"ok": False, "error": "Escáner no encontrado"})
        conn.execute("DELETE FROM discovery_scanner_networks WHERE scanner_id=?", (scanner_id,))
        conn.execute("DELETE FROM discovery_scanners WHERE id=?", (scanner_id,))
    return {"ok": True}


def get_discovery_networks_for_template() -> Dict[str, Any]:
    """
    Mantiene la semántica actual de la plantilla:
    - primary_nets: primarias visibles, deduplicadas contra CIDR secundarias
    - secondary_nets: filas compat derivadas
    - scan_cidr: raw/proyección compatible
    """
    projection = get_discovery_legacy_projection(active_only=True)
    networks = projection["discovery_networks"]
    secondaries = [n for n in networks if n.get("kind") == "secondary"]
    sec_cidrs = {(n.get("cidr") or "").strip() for n in secondaries if (n.get("cidr") or "").strip()}

    primary_nets = [
        {
            "cidr": n.get("cidr", ""),
            "label": n.get("label", ""),
            "interface": n.get("interface", ""),
        }
        for n in networks
        if n.get("kind") == "primary"
        and (n.get("cidr") or "").strip()
        and (n.get("cidr") or "").strip() not in sec_cidrs
    ]

    return {
        "scan_cidr": projection["scan_cidr"] or _setting("scan_cidr", SCAN_CIDR),
        "primary_nets": primary_nets,
        "secondary_nets": projection["secondary_networks"],
        "discovery_networks": networks,
        "discovery_scanners": projection["discovery_scanners"],
    }
