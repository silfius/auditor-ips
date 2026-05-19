"""
host_classification.py — Auditor IPs
Clasificación heurística conservadora de hosts detectados.

No hace I/O ni accede a la BD. Solo consume señales ya disponibles en un host
(hostnames, fabricante OUI y metadatos del router) y devuelve una propuesta
explicable con evidencias.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Mapping

DEVICE_TYPES = [
    "router",
    "printer",
    "mobile",
    "television",
    "voice assistant",
    "streaming device",
    "laptop",
    "computer",
    "server",
    "NAS",
    "repeater",
    "iot",
    "unknown",
]

_HOSTNAME_RULES = {
    "router": {
        "tokens": [
            "router", "gateway", "openwrt", "opnsense", "pfsense",
            "fritzbox", "mikrotik", "edgerouter", "unifi gateway",
            "ubiquiti gateway",
        ],
        "weight": 0.92,
        "reason": "hostname coincide con patrones típicos de router/gateway",
    },
    "printer": {
        "tokens": [
            "printer", "deskjet", "officejet", "laserjet", "epson",
            "brother", "xerox", "lexmark", "kyocera", "ricoh", "mfc",
        ],
        "weight": 0.95,
        "reason": "hostname coincide con patrones típicos de impresora",
    },
    "mobile": {
        "tokens": [
            "iphone", "ipad", "android", "pixel", "galaxy", "redmi",
            "xiaomi", "oneplus", "huawei", "phone", "smartphone",
            "movil", "telefono", "celular",
        ],
        "weight": 0.90,
        "reason": "hostname coincide con patrones típicos de móvil/tablet",
    },
    "television": {
        "tokens": [
            "smart tv", "smarttv", "android tv", "androidtv", "webos",
            "bravia", "hisense", "philips tv", "samsung tv", "lg tv",
            "oled", "qled",
        ],
        "weight": 0.90,
        "reason": "hostname coincide con patrones típicos de televisor",
    },
    "voice assistant": {
        "tokens": [
            "alexa", "echo", "homepod", "nest mini", "google home",
            "voice assistant",
        ],
        "weight": 0.95,
        "reason": "hostname coincide con patrones típicos de asistente de voz",
    },
    "streaming device": {
        "tokens": [
            "chromecast", "apple tv", "appletv", "fire tv", "firetv",
            "roku", "shield", "mi box", "mibox",
        ],
        "weight": 0.93,
        "reason": "hostname coincide con patrones típicos de streaming",
    },
    "laptop": {
        "tokens": [
            "macbook", "thinkpad", "latitude", "elitebook", "probook",
            "notebook", "laptop", "surface",
        ],
        "weight": 0.86,
        "reason": "hostname coincide con patrones típicos de portátil",
    },
    "computer": {
        "tokens": [
            "desktop", "workstation", "imac", "mini pc", "minipc",
            "intel nuc", "nuc", "pc", "ordenador",
        ],
        "weight": 0.84,
        "reason": "hostname coincide con patrones típicos de equipo de sobremesa",
    },
    "server": {
        "tokens": [
            "server", "proxmox", "esxi", "vmware", "hyperv", "docker",
            "kube", "kubernetes", "homelab", "pve",
        ],
        "weight": 0.92,
        "reason": "hostname coincide con patrones típicos de servidor/hipervisor",
    },
    "NAS": {
        "tokens": [
            "synology", "diskstation", "qnap", "truenas", "freenas",
            "asustor", "nas",
        ],
        "weight": 0.95,
        "reason": "hostname coincide con patrones típicos de NAS",
    },
    "repeater": {
        "tokens": [
            "repeater", "range extender", "rangeextender", "extender",
            "mesh", "deco", "orbi", "access point", "accesspoint",
        ],
        "weight": 0.89,
        "reason": "hostname coincide con patrones típicos de repetidor/AP mesh",
    },
    "iot": {
        "tokens": [
            "esp32", "esp8266", "shelly", "sonoff", "tuya", "tasmota",
            "smart plug", "smartplug", "aqara", "switchbot", "reolink",
            "hikvision", "wyze", "camera",
        ],
        "weight": 0.88,
        "reason": "hostname coincide con patrones típicos de IoT/cámara",
    },
}

_VENDOR_RULES = {
    "printer": {
        "tokens": ["epson", "brother", "xerox", "lexmark", "kyocera", "ricoh"],
        "weight": 0.62,
        "reason": "fabricante OUI coincide con fabricantes típicos de impresora",
    },
    "NAS": {
        "tokens": ["synology", "qnap", "asustor"],
        "weight": 0.72,
        "reason": "fabricante OUI coincide con fabricantes típicos de NAS",
    },
    "streaming device": {
        "tokens": ["roku"],
        "weight": 0.70,
        "reason": "fabricante OUI coincide con Roku",
    },
    "iot": {
        "tokens": ["shelly", "sonoff", "tuya", "aqara", "reolink", "hikvision", "wyze"],
        "weight": 0.60,
        "reason": "fabricante OUI coincide con fabricantes típicos de IoT/cámara",
    },
}

_DHCP_CATEGORIES = {"mobile", "television", "voice assistant", "streaming device", "iot"}
_STATIC_CATEGORIES = {"router", "server", "NAS", "repeater", "computer"}


def _norm_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def _compact_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _first_token_match(value: Any, tokens: Iterable[str]) -> str:
    normalized = _norm_text(value)
    compact = _compact_text(value)
    if not normalized and not compact:
        return ""
    for token in tokens:
        token_norm = _norm_text(token)
        token_compact = _compact_text(token)
        if token_norm and token_norm in normalized:
            return token
        if token_compact and len(token_compact) >= 4 and token_compact in compact:
            return token
    return ""


def _confidence_from_scores(best: float, second: float) -> float:
    margin = best - second
    if best >= 1.45 and margin >= 0.35:
        return 0.92
    if best >= 1.05 and margin >= 0.25:
        return 0.78
    if best >= 0.85 and margin >= 0.20:
        return 0.64
    return 0.0


def decode_device_evidence(raw: Any) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def classify_host_device(host: Mapping[str, Any]) -> Dict[str, Any]:
    scores: Dict[str, float] = {k: 0.0 for k in DEVICE_TYPES if k != "unknown"}
    evidences: List[Dict[str, Any]] = []

    text_fields = [
        ("router_hostname", host.get("router_hostname"), 1.00),
        ("nmap_hostname", host.get("nmap_hostname"), 0.95),
        ("dns_name", host.get("dns_name"), 0.90),
    ]

    for category, rule in _HOSTNAME_RULES.items():
        for field_name, field_value, field_multiplier in text_fields:
            matched = _first_token_match(field_value, rule["tokens"])
            if not matched:
                continue
            weight = round(rule["weight"] * field_multiplier, 2)
            scores[category] += weight
            evidences.append({
                "category": category,
                "kind": "hostname",
                "field": field_name,
                "value": str(field_value or ""),
                "matched": matched,
                "weight": weight,
                "reason": rule["reason"],
            })
            break

    vendor = host.get("vendor") or ""
    for category, rule in _VENDOR_RULES.items():
        matched = _first_token_match(vendor, rule["tokens"])
        if not matched:
            continue
        weight = round(rule["weight"], 2)
        scores[category] += weight
        evidences.append({
            "category": category,
            "kind": "vendor",
            "field": "vendor",
            "value": str(vendor),
            "matched": matched,
            "weight": weight,
            "reason": rule["reason"],
        })

    assignment = _norm_text(host.get("ip_assignment"))
    if assignment in {"dhcp", "dynamic"}:
        for category in _DHCP_CATEGORIES:
            if scores.get(category, 0.0) <= 0:
                continue
            weight = 0.10
            scores[category] += weight
            evidences.append({
                "category": category,
                "kind": "router_metadata",
                "field": "ip_assignment",
                "value": str(host.get("ip_assignment") or ""),
                "matched": assignment,
                "weight": weight,
                "reason": "el router marca el host como DHCP/dinámico, compatible con dispositivo cliente",
            })
    elif assignment in {"static", "static lease", "static dhcp", "reserved", "reservation"}:
        for category in _STATIC_CATEGORIES:
            if scores.get(category, 0.0) <= 0:
                continue
            weight = 0.12
            scores[category] += weight
            evidences.append({
                "category": category,
                "kind": "router_metadata",
                "field": "ip_assignment",
                "value": str(host.get("ip_assignment") or ""),
                "matched": assignment,
                "weight": weight,
                "reason": "el router marca el host como estático/reservado, compatible con infraestructura estable",
            })

    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best_category, best_score = ordered[0] if ordered else ("unknown", 0.0)
    second_score = ordered[1][1] if len(ordered) > 1 else 0.0
    confidence = _confidence_from_scores(best_score, second_score)

    if confidence <= 0:
        top_evidence = sorted(evidences, key=lambda item: item.get("weight", 0), reverse=True)[:6]
        return {
            "device_type": "unknown",
            "device_confidence": 0.0,
            "device_source": "heuristic_v1",
            "device_evidence": top_evidence,
        }

    chosen = [e for e in evidences if e.get("category") == best_category]
    chosen = sorted(chosen, key=lambda item: item.get("weight", 0), reverse=True)[:6]
    return {
        "device_type": best_category,
        "device_confidence": confidence,
        "device_source": "heuristic_v1",
        "device_evidence": chosen,
    }
