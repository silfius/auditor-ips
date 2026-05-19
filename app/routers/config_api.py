"""
routers/config_api.py — Auditor IPs
Settings, backup/restore BD, push notifications, VAPID,
TLS info, export XLSX y test Discord.

Scheduler se inyecta desde main.py vía set_scheduler().
"""

import base64
import csv
import html as _html
import io
import ipaddress
import json as _json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse, Response

from config import cfg, cfg_defaults, save_setting, DB_PATH, SCAN_CIDR, SCAN_INTERVAL_SECONDS
from database import db
from routers.discovery import (
    get_discovery_legacy_projection,
    get_discovery_networks,
    get_discovery_runtime_source_setting,
    get_discovery_scanners,
    get_discovery_source,
    get_secondary_discovery_networks,
    seed_discovery_schema_from_legacy,
)
from utils import utc_now_iso, to_local_str, human_since, get_app_tz, normalize_mac

router = APIRouter()

_scheduler_ref: Any = None


def set_scheduler(sched: Any) -> None:
    global _scheduler_ref
    _scheduler_ref = sched
    _reschedule_export()          # arrancar job de export si está configurado


def _get_scheduler():
    return _scheduler_ref

_SECRET_SETTING_KEYS = {
    "discord_webhook",
    "discord_webhook_info",
    "discord_webhook_alerts",
    "smtp_pass",
    "ai_gemini_key",
    "ai_mistral_key",
    "vapid_private_key",
    "router_ssh_key",
    "automation_agent_token",
}


def _configured_flag_name(key: str) -> str:
    return f"{key}_configured"


def _sanitize_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """
    Devuelve una copia segura de settings para exponer en la API:
    - nunca devuelve secretos reales
    - añade flags *_configured para que la UI sepa si ya existe un valor guardado
    - mantiene compatibilidad con aliases legacy de la UI
    """
    safe = dict(settings)

    for key in _SECRET_SETTING_KEYS:
        raw = str(safe.get(key, "") or "")
        safe[_configured_flag_name(key)] = bool(raw)
        if key in safe:
            safe[key] = ""

    if "theme" in safe and "ui_theme" not in safe:
        safe["ui_theme"] = safe.get("theme")
    if "scan_secondary_interval_h" in safe and "scan_secondary_interval_hours" not in safe:
        safe["scan_secondary_interval_hours"] = safe.get("scan_secondary_interval_h")
    if "scan_secondary_ai" in safe and "scan_secondary_ai_enabled" not in safe:
        safe["scan_secondary_ai_enabled"] = safe.get("scan_secondary_ai")

    return safe


def _preserve_existing_secret_values(normalized: Dict[str, Any]) -> Dict[str, Any]:
    """
    Si la UI envía vacío para secretos, preservamos el valor actual guardado.
    Esto evita borrar claves por accidente al no devolver secretos en GET /api/settings.
    """
    preserved = dict(normalized)
    for key in _SECRET_SETTING_KEYS:
        if key not in preserved:
            continue
        incoming = preserved.get(key)
        if incoming is None:
            preserved[key] = cfg(key, "")
            continue
        if isinstance(incoming, str) and incoming.strip() == "":
            preserved[key] = cfg(key, "")
    return preserved

# ═══════════════════════════════════════════════════════════════
#  Settings
# ═══════════════════════════════════════════════════════════════

def _normalize_enabled_modules_payload(value: Any) -> str:
    """Normaliza enabled_modules para persistirlo siempre como JSON válido."""
    try:
        if isinstance(value, (dict, list)):
            return _json.dumps(value, sort_keys=True)
        raw = str(value or "").strip()
        if not raw:
            return "{}"
        parsed = _json.loads(raw)
        if isinstance(parsed, (dict, list)):
            return _json.dumps(parsed, sort_keys=True)
        return raw
    except Exception:
        return str(value or "")



@router.get("/api/settings")
def api_get_settings():
    from config import _cfg
    settings = _sanitize_settings(dict(_cfg))

    # Discovery: preferimos la proyección canónica si existe schema nuevo.
    # Así la UI puede seguir leyendo campos legacy sin depender de cómo estén
    # persistidos internamente los scanners.
    try:
        projection = get_discovery_legacy_projection(active_only=False)
        settings["scan_cidr"] = projection.get("scan_cidr", settings.get("scan_cidr", ""))
        settings["primary_net_interface"] = projection.get("primary_net_interface", settings.get("primary_net_interface", ""))
        settings["primary_net_label"] = projection.get("primary_net_label", settings.get("primary_net_label", ""))
        settings["secondary_networks"] = projection.get("secondary_networks", [])
        settings["discovery_networks"] = projection.get("discovery_networks", [])
        settings["discovery_scanners"] = projection.get("discovery_scanners", [])
        settings["discovery_source"] = projection.get("source", get_discovery_source())
        settings["discovery_runtime_source"] = get_discovery_runtime_source_setting()
    except Exception:
        try:
            settings["secondary_networks"] = get_secondary_discovery_networks()
        except Exception:
            settings["secondary_networks"] = []
        try:
            settings["discovery_networks"] = get_discovery_networks(active_only=False)
        except Exception:
            settings["discovery_networks"] = []
        try:
            settings["discovery_scanners"] = get_discovery_scanners(active_only=False)
        except Exception:
            settings["discovery_scanners"] = []
        settings["discovery_source"] = "legacy"
        settings["discovery_runtime_source"] = get_discovery_runtime_source_setting()

    return {"ok": True, "settings": settings}


@router.get("/api/config/discovery/scanners")
def api_discovery_scanners_list():
    """
    Vista runtime canónica de discovery.
    - Si el schema nuevo está poblado, devuelve discovery_scanners reales
    - Si no, proyecta el modelo legacy al mismo contrato
    """
    try:
        scanners = get_discovery_scanners(active_only=False)
        projection = get_discovery_legacy_projection(active_only=False)
        return {
            "ok": True,
            "source": get_discovery_source(),
            "scanners": scanners,
            "legacy_projection": {
                "scan_cidr": projection.get("scan_cidr", ""),
                "primary_net_interface": projection.get("primary_net_interface", ""),
                "primary_net_label": projection.get("primary_net_label", ""),
                "secondary_networks": projection.get("secondary_networks", []),
            },
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/config/discovery/seed-legacy")
def api_discovery_seed_legacy(payload: Dict[str, Any] = Body(default={})):
    """
    Siembra el schema nuevo desde el modelo legacy sin cambiar la fuente efectiva
    mientras discovery_runtime_source siga en 'legacy'.
    """
    overwrite = bool(payload.get("overwrite", False))
    include_router_profile = bool(payload.get("include_router_profile", True))
    try:
        result = seed_discovery_schema_from_legacy(
            overwrite=overwrite,
            include_router_profile=include_router_profile,
        )
        return result
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.put("/api/settings")
def api_put_settings(request: Request, payload: Dict[str, Any] = Body(...)):
    alias_map = {
        "ui_theme": "theme",
        "scan_secondary_interval_hours": "scan_secondary_interval_h",
        "scan_secondary_ai_enabled": "scan_secondary_ai",
    }
    normalized = {}
    for k, v in payload.items():
        normalized[alias_map.get(k, k)] = v

    normalized = _preserve_existing_secret_values(normalized)

    if "enabled_modules" in normalized:
        normalized["enabled_modules"] = _normalize_enabled_modules_payload(normalized.get("enabled_modules"))

    allowed = set(cfg_defaults().keys()) | {
        "primary_net_label", "hidden_tabs", "ui_lang", "wol_public",
        "smtp_enabled", "smtp_host", "smtp_port", "smtp_tls",
        "smtp_user", "smtp_pass", "smtp_to", "smtp_from",
        "scan_cidr", "scan_interval", "scan_on_boot",
        "dns_server", "retention_days", "retention_module_days", "wol_port", "wol_broadcast",
        "primary_net_interface", "primary_net_label",
        "scan_primary_source", "scan_secondary_source", "scan_secondary_interval_h", "scan_secondary_ai",
        "router_enabled", "router_ssh_host", "router_ssh_port",
        "router_ssh_user", "router_ssh_key",
        "notify_new", "notify_online", "notify_offline", "notify_mac_change",
        "notify_service_down", "notify_syncthing_stalled", "notify_quality_degraded", "notify_script_alerts", "notify_email",
        "email_new", "email_online", "email_offline", "email_mac_change", "email_service_down",
        "email_syncthing_stalled", "email_quality_degraded", "email_script_alerts",
        "push_new", "push_offline", "push_online", "push_service_down", "push_mac_change",
        "discord_webhook", "discord_webhook_info", "discord_webhook_alerts", "discord_info_fallback_to_alerts",
        "automation_agent_token",
        "backup_enabled", "backup_keep",
        "ai_provider", "ai_gemini_key", "ai_gemini_model",
        "ai_mistral_key", "ai_mistral_model",
        "ai_ollama_url", "ai_ollama_model",
        "theme", "page_title", "accent_color", "accent_color2", "app_tz",
        "auth_sections",
        "discovery_runtime_source",
        "syncthing_file_event_retention_days",
        "script_alert_check_interval_seconds",
    }
    updated = []
    for k, v in normalized.items():
        if k not in allowed:
            continue
        save_setting(k, str(v))
        updated.append(k)

    if updated:
        from auth_middleware import get_client_ip, log_action
        from routers.auth import _current_username

        label_map = {
            "ui_lang": "Idioma",
            "app_tz": "Zona horaria",
            "theme": "Tema",
            "ui_theme": "Tema",
            "accent_color": "Color principal",
            "accent_color2": "Color secundario",
            "page_title": "Título de página",
            "frontend_refresh_interval_seconds": "Refresco frontend",
            "frontend_dashboard_refresh_interval_seconds": "Refresco dashboard",
            "frontend_history_limit": "Límite histórico frontend",
            "frontend_detail_history_limit": "Límite histórico detalle frontend",
            "frontend_table_rows_limit": "Límite filas tabla frontend",
            "frontend_export_rows_limit": "Límite export frontend",
            "service_check_timeout_seconds": "Timeout checks servicios",
            "service_info_timeout_seconds": "Timeout info servicios",
            "script_ai_cloud_timeout_seconds": "Timeout IA cloud scripts",
            "script_ai_local_timeout_seconds": "Timeout IA local scripts",
            "script_ai_frontend_timeout_seconds": "Timeout frontend IA scripts",
            "script_report_timeout_seconds": "Timeout informes scripts",
            "script_alert_check_interval_seconds": "Intervalo comprobación alertas scripts",
            "wol_tracker_timeout_seconds": "Timeout seguimiento WoL",
            "ui_animation": "Animación UI",
            "hidden_tabs": "Secciones visibles",
            "enabled_modules": "Módulos habilitados",
            "scan_cidr": "Red principal",
            "scan_interval": "Intervalo de escaneo",
            "scan_on_boot": "Escaneo al iniciar",
            "primary_net_label": "Nombre de red principal",
            "primary_net_interface": "Interfaz de red principal",
            "scan_primary_source": "Fuente primaria",
            "scan_secondary_source": "Fuente secundaria",
            "scan_secondary_interval_h": "Intervalo red secundaria",
            "scan_secondary_ai": "IA en red secundaria",
            "router_enabled": "Router habilitado",
            "router_ssh_host": "Host SSH router",
            "router_ssh_port": "Puerto SSH router",
            "router_ssh_user": "Usuario SSH router",
            "router_ssh_key": "Clave SSH router",
            "discord_webhook": "Webhook Discord legacy",
            "discord_webhook_info": "Webhook Discord informativo",
            "discord_webhook_alerts": "Webhook Discord alertas",
            "discord_info_fallback_to_alerts": "Discord info usa alertas como fallback",
            "smtp_enabled": "SMTP habilitado",
            "smtp_host": "Servidor SMTP",
            "smtp_port": "Puerto SMTP",
            "smtp_tls": "TLS SMTP",
            "smtp_user": "Usuario SMTP",
            "smtp_pass": "Contraseña SMTP",
            "smtp_to": "Destinatario SMTP",
            "smtp_from": "Remitente SMTP",
            "notify_new": "Aviso host nuevo",
            "notify_online": "Aviso host online",
            "notify_offline": "Aviso host offline",
            "notify_mac_change": "Aviso cambio MAC",
            "notify_service_down": "Aviso servicio caído",
            "notify_syncthing_stalled": "Aviso Syncthing atascos/errores de carpeta",
            "notify_quality_degraded": "Aviso calidad degradada",
            "notify_script_alerts": "Aviso procesos/automatizaciones",
            "notify_email": "Canal email",
            "email_new": "Email host nuevo",
            "email_online": "Email host online",
            "email_offline": "Email host offline",
            "email_mac_change": "Email cambio MAC",
            "email_service_down": "Email servicio caído",
            "email_syncthing_stalled": "Email Syncthing atascos/errores de carpeta",
            "email_quality_degraded": "Email calidad degradada",
            "email_script_alerts": "Email procesos/automatizaciones",
            "backup_enabled": "Backups habilitados",
            "backup_keep": "Retención de backups",
            "wol_public": "WoL público",
            "wol_port": "Puerto WoL",
            "wol_broadcast": "Broadcast WoL",
            "ai_provider": "Proveedor IA",
            "ai_gemini_key": "API key Gemini",
            "ai_gemini_model": "Modelo Gemini",
            "ai_mistral_key": "API key Mistral",
            "ai_mistral_model": "Modelo Mistral",
            "ai_ollama_url": "URL Ollama",
            "ai_ollama_model": "Modelo Ollama",
            "auth_sections": "Secciones protegidas",
            "discovery_runtime_source": "Fuente runtime discovery",
            "syncthing_refresh_interval_seconds": "Syncthing intervalo de refresco",
            "syncthing_snapshot_retention_days": "Syncthing retención snapshots",
            "syncthing_stalled_threshold_minutes": "Syncthing umbral posible atasco",
            "syncthing_stalled_alert_cooldown_minutes": "Syncthing cooldown alerta posible atasco",
            "syncthing_alert_persistence_minutes": "Syncthing persistencia antes de alertar",
            "syncthing_transfer_active_threshold_bps": "Syncthing velocidad mínima transferencia real",
            "syncthing_transfer_active_min_delta_bytes": "Syncthing tamaño mínimo transferencia real",
            "syncthing_store_file_names": "Syncthing guardar nombres de archivos",
            "syncthing_file_event_retention_days": "Syncthing retención eventos de archivos",
            "syncthing_file_name_retention_days": "Syncthing retención nombres de archivos",
        }

        labels = [label_map.get(k, k) for k in updated]
        preview = labels[:4]
        summary = ", ".join(preview)
        if len(labels) > 4:
            summary += f" (+{len(labels) - 4})"

        username = _current_username(request)
        log_action(
            DB_PATH,
            get_client_ip(request),
            "Configuración guardada",
            authed=bool(username),
            username=username,
            detail={
                "summary": summary,
                "updated_keys": updated,
                "updated_labels": labels,
            },
        )

    if "scan_interval" in updated or "scan_cidr" in updated:
        new_interval = int(cfg("scan_interval", SCAN_INTERVAL_SECONDS))
        sched = _get_scheduler()
        if sched:
            try:
                sched.reschedule_job("scan_job", trigger="interval", seconds=new_interval)
            except Exception:
                from routers.scans import run_scan
                sched.add_job(
                    lambda: run_scan(cfg("scan_cidr", SCAN_CIDR)),
                    "interval", seconds=new_interval,
                    id="scan_job", replace_existing=True,
                )

    if "syncthing_refresh_interval_seconds" in updated:
        sched = _get_scheduler()
        if sched:
            from routers import syncthing_control as r_syncthing_control
            st_interval = r_syncthing_control.get_syncthing_refresh_interval_seconds()
            try:
                sched.reschedule_job(
                    "syncthing_overview_cache_job",
                    trigger="interval",
                    seconds=st_interval,
                )
                sched.modify_job(
                    "syncthing_overview_cache_job",
                    max_instances=2,
                    coalesce=True,
                    misfire_grace_time=30,
                )
            except Exception:
                sched.add_job(
                    r_syncthing_control.refresh_syncthing_overview_cache,
                    "interval",
                    seconds=st_interval,
                    id="syncthing_overview_cache_job",
                    replace_existing=True,
                    max_instances=2,
                    coalesce=True,
                    misfire_grace_time=30,
                )

    scan_job_settings = {
        "scan_primary_source",
        "scan_secondary_source",
        "scan_secondary_interval_h",
        "scan_secondary_ai",
        "router_enabled",
    }
    if scan_job_settings & set(updated):
        from routers.scans import reconfigure_scan_jobs

        reconfigure_scan_jobs()

    from config import _cfg
    return {"ok": True, "updated": updated, "settings": _sanitize_settings(dict(_cfg))}


def _wol_primary_cidrs() -> list[str]:
    return [c.strip() for c in str(cfg("scan_cidr", SCAN_CIDR) or "").split(",") if c.strip()]


def _wol_ip_in_any_primary(ip: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip)
    except Exception:
        return False
    for cidr in _wol_primary_cidrs():
        try:
            if ip_obj in ipaddress.ip_network(cidr, strict=False):
                return True
        except Exception:
            continue
    return False


def _wol_display_status(ip: str, status: str, router_seen: Any) -> str:
    status = (status or "").strip() or "offline"
    router_primary = (
        cfg("router_enabled", "0") == "1"
        and (cfg("scan_primary_source", "router") or "router").strip().lower() == "router"
    )
    if router_primary and _wol_ip_in_any_primary(ip) and status in ("online", "online_silent"):
        if not bool(router_seen):
            return "offline"
    return status


def _wol_display_name(row: Dict[str, Any]) -> str:
    for key in ("manual_name", "router_hostname", "nmap_hostname", "dns_name", "ip"):
        value = str(row.get(key, "") or "").strip()
        if value:
            return value
    return ""


@router.get("/api/config/wol-public/hosts")
def api_config_wol_public_hosts():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT h.ip,
                   COALESCE(h.mac, '') AS mac,
                   COALESCE(h.manual_name, '') AS manual_name,
                   COALESCE(h.router_hostname, '') AS router_hostname,
                   COALESCE(h.nmap_hostname, '') AS nmap_hostname,
                   COALESCE(h.dns_name, '') AS dns_name,
                   COALESCE(h.status, 'offline') AS status,
                   COALESCE(h.router_seen, 0) AS router_seen,
                   COALESCE(p.enabled, 0) AS public_enabled,
                   COALESCE(p.public_label, '') AS public_label,
                   COALESCE(p.sort_order, 0) AS sort_order
            FROM hosts h
            LEFT JOIN public_wol_hosts p ON p.host_ip = h.ip
            ORDER BY h.ip ASC
            """
        ).fetchall()

    items = []
    for row in rows:
        item = dict(row)
        item["wol_ready"] = bool(normalize_mac(item.get("mac") or ""))
        item["public_enabled"] = bool(item.get("public_enabled"))
        item["display_name"] = _wol_display_name(item) or item["ip"]
        item["status"] = _wol_display_status(item["ip"], item.get("status") or "offline", item.get("router_seen"))
        item["hostname"] = item.get("nmap_hostname") or ""
        try:
            item["sort_order"] = int(item.get("sort_order") or 0)
        except Exception:
            item["sort_order"] = 0
        item["public_label"] = str(item.get("public_label") or "").strip()
        items.append(item)

    items.sort(
        key=lambda h: (
            0 if h.get("public_enabled") else 1,
            int(h.get("sort_order") or 0) if h.get("public_enabled") else 0,
            str(h.get("display_name") or h.get("ip") or "").lower(),
            str(h.get("ip") or ""),
        )
    )
    return {"ok": True, "items": items}


@router.put("/api/config/wol-public")
def api_config_wol_public_save(payload: Dict[str, Any] = Body(...)):
    wol_public = 1 if str(payload.get("wol_public", "0")) in ("1", "true", "True") else 0
    requested_hosts = payload.get("hosts") or []
    now = utc_now_iso()

    deduped: Dict[str, Dict[str, Any]] = {}
    for raw in requested_hosts:
        if not isinstance(raw, dict):
            continue
        ip = str(raw.get("ip") or "").strip()
        if not ip:
            continue
        deduped[ip] = {
            "ip": ip,
            "public_label": str(raw.get("public_label") or "").strip(),
            "sort_order": raw.get("sort_order", 0),
        }

    save_setting("wol_public", str(wol_public))

    skipped = []
    saved_ips = []

    with db() as conn:
        existing_hosts = {
            row["ip"]: dict(row)
            for row in conn.execute(
                "SELECT ip, COALESCE(mac, '') AS mac FROM hosts WHERE ip IN ({})".format(
                    ",".join("?" for _ in deduped)
                ),
                tuple(deduped.keys()),
            ).fetchall()
        } if deduped else {}

        for ip, item in deduped.items():
            host = existing_hosts.get(ip)
            if not host:
                skipped.append(ip)
                continue
            if not normalize_mac(host.get("mac") or ""):
                skipped.append(ip)
                continue
            try:
                sort_order = int(item.get("sort_order") or 0)
            except Exception:
                sort_order = 0
            conn.execute(
                """
                INSERT INTO public_wol_hosts (host_ip, public_label, sort_order, enabled, created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(host_ip) DO UPDATE SET
                    public_label = excluded.public_label,
                    sort_order = excluded.sort_order,
                    enabled = 1,
                    updated_at = excluded.updated_at
                """,
                (ip, item["public_label"], sort_order, now, now),
            )
            saved_ips.append(ip)

        if saved_ips:
            placeholders = ",".join("?" for _ in saved_ips)
            conn.execute(
                f"DELETE FROM public_wol_hosts WHERE host_ip NOT IN ({placeholders})",
                tuple(saved_ips),
            )
        else:
            conn.execute("DELETE FROM public_wol_hosts")

    return {
        "ok": True,
        "wol_public": wol_public,
        "saved": saved_ips,
        "skipped": skipped,
    }


@router.get("/api/scan/detection-config")
def api_get_detection_config():
    return {
        "ok": True,
        "config": {
            "scan_primary_source": cfg("scan_primary_source", "router"),
            "scan_secondary_source": cfg("scan_secondary_source", "none"),
            "scan_secondary_interval_hours": cfg("scan_secondary_interval_h", "2"),
            "scan_secondary_ai_enabled": cfg("scan_secondary_ai", "0"),
        },
    }


@router.put("/api/scan/detection-config")
def api_put_detection_config(payload: Dict[str, Any] = Body(...)):
    mapped = {
        "scan_primary_source": payload.get("scan_primary_source", cfg("scan_primary_source", "router")),
        "scan_secondary_source": payload.get("scan_secondary_source", cfg("scan_secondary_source", "none")),
        "scan_secondary_interval_h": payload.get("scan_secondary_interval_hours", payload.get("scan_secondary_interval_h", cfg("scan_secondary_interval_h", "2"))),
        "scan_secondary_ai": payload.get("scan_secondary_ai_enabled", payload.get("scan_secondary_ai", cfg("scan_secondary_ai", "0"))),
    }
    return api_put_settings(mapped)


@router.get("/api/ai/test")
def api_ai_test():
    provider = cfg("ai_provider", "gemini").strip().lower() or "gemini"
    timeout = 12
    try:
        if provider == "gemini":
            api_key = cfg("ai_gemini_key", "").strip()
            model = cfg("ai_gemini_model", "gemini-2.0-flash").strip() or "gemini-2.0-flash"
            if not api_key:
                return JSONResponse({"ok": False, "error": "Falta la API key de Gemini"}, status_code=400)
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}"
            payload = _json.dumps({"contents": [{"parts": [{"text": "ping"}]}]}).encode()
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                _json.loads(resp.read().decode("utf-8", errors="replace"))
            return {"ok": True, "provider": "Gemini", "model": model}

        if provider == "mistral":
            api_key = cfg("ai_mistral_key", "").strip()
            model = cfg("ai_mistral_model", "mistral-small-latest").strip() or "mistral-small-latest"
            if not api_key:
                return JSONResponse({"ok": False, "error": "Falta la API key de Mistral"}, status_code=400)
            url = "https://api.mistral.ai/v1/chat/completions"
            payload = _json.dumps({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 4}).encode()
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                _json.loads(resp.read().decode("utf-8", errors="replace"))
            return {"ok": True, "provider": "Mistral", "model": model}

        if provider == "ollama":
            base_url = (cfg("ai_ollama_url", "http://localhost:11434") or "http://localhost:11434").rstrip("/")
            model = cfg("ai_ollama_model", "gemma2:2b").strip() or "gemma2:2b"
            url = f"{base_url}/api/generate"
            payload = _json.dumps({"model": model, "prompt": "ping", "stream": False}).encode()
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                _json.loads(resp.read().decode("utf-8", errors="replace"))
            return {"ok": True, "provider": "Ollama", "model": model}

        return JSONResponse({"ok": False, "error": f"Proveedor IA no soportado: {provider}"}, status_code=400)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            detail = str(e)
        return JSONResponse({"ok": False, "error": detail or str(e)}, status_code=502)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/settings/test-discord")
def api_test_discord(payload: Dict[str, Any] | None = Body(None)):
    channel = str((payload or {}).get("channel") or "alerts").strip().lower()
    if channel not in ("alerts", "info"):
        channel = "alerts"

    from routers.scans import discord_notify, discord_webhook_for_channel

    webhook = discord_webhook_for_channel(channel)
    if not webhook:
        label = "informativo" if channel == "info" else "de alertas"
        return JSONResponse({"ok": False, "error": f"No hay webhook Discord {label} configurado"}, status_code=400)

    label = "informativo" if channel == "info" else "alertas"
    ok, err = discord_notify(f"🧪 **Test Auditor IPs** — Discord {label} funcionando ✅", channel=channel)
    return {"ok": ok, "error": err or None, "channel": channel}


# ── SMTP email ────────────────────────────────────────────────

def send_email(subject: str, body: str) -> tuple[bool, str]:
    """
    Envía un email usando la configuración SMTP almacenada en BD.
    Devuelve (ok, error_msg).
    Usa solo stdlib: smtplib + email.
    """
    import smtplib
    import ssl
    from email.message import EmailMessage

    enabled = cfg("smtp_enabled", "0")
    if enabled != "1":
        return False, "SMTP no habilitado"

    host     = cfg("smtp_host",  "").strip()
    port     = int(cfg("smtp_port", "587") or 587)
    tls_mode = cfg("smtp_tls",   "starttls")
    user     = cfg("smtp_user",  "").strip()
    password = cfg("smtp_pass",  "")
    to_addr  = cfg("smtp_to",    "").strip()
    from_addr= cfg("smtp_from",  "").strip() or user

    if not host or not to_addr:
        return False, "Faltan host SMTP o dirección destinatario"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = from_addr
    msg["To"]      = to_addr
    msg.set_content(body)

    try:
        if tls_mode == "ssl":
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) as s:
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        elif tls_mode == "starttls":
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                s.starttls(context=ssl.create_default_context())
                s.ehlo()
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        else:  # none
            with smtplib.SMTP(host, port, timeout=15) as s:
                if user and password:
                    s.login(user, password)
                s.send_message(msg)
        return True, ""
    except Exception as e:
        return False, str(e)


@router.post("/api/settings/test-smtp")
def api_test_smtp():
    """Envía un email de prueba con la configuración SMTP actual."""
    ok, err = send_email(
        subject="🧪 Test Auditor IPs — SMTP funcionando",
        body="Este es un mensaje de prueba del sistema de alertas de Auditor IPs.\n\nSi recibes este correo, la configuración SMTP es correcta."
    )
    return {"ok": ok, "error": err or None}


# ═══════════════════════════════════════════════════════════════
#  Backup / Restore
# ═══════════════════════════════════════════════════════════════

BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH), "backups")


_HISTORY_TABLES = {
    "scans",
    "scan_results",
    "router_scans",
    "router_scan_history",
    "host_latency",
    "host_events",
    "host_availability_intervals",
    "host_uptime",
    "service_checks",
    "quality_history",
    "quality_checks",
    "scan_ai_reports",
    "daily_reports",
    "audit_log",
    "automation_agent_events",
    "syncthing_folder_snapshots",
    "syncthing_transfer_snapshots",
    "syncthing_remote_transfer_snapshots",
    "syncthing_file_events",
}


_RETENTION_MODULES = [
    {
        "id": "scans",
        "label": "Scans e inventario de router",
        "description": "Ejecuciones de escaneo, histórico de router y reportes IA asociados.",
        "default_days": 60,
        "tables": ["scans", "router_scans", "router_scan_history", "scan_ai_reports"],
    },
    {
        "id": "hosts",
        "label": "Hosts, eventos y disponibilidad",
        "description": "Eventos de hosts, latencia e intervalos de disponibilidad.",
        "default_days": 90,
        "tables": ["host_events", "host_latency", "host_availability_intervals", "host_uptime"],
    },
    {
        "id": "quality",
        "label": "Calidad de red",
        "description": "Mediciones históricas de calidad, latencia y pérdida de paquetes.",
        "default_days": 60,
        "tables": ["quality_checks", "quality_history"],
    },
    {
        "id": "services",
        "label": "Servicios y aplicaciones",
        "description": "Checks históricos de servicios monitorizados.",
        "default_days": 60,
        "tables": ["service_checks"],
    },
    {
        "id": "automation_agents",
        "label": "Automatizaciones y agentes API",
        "description": "Eventos recibidos desde agentes API y auditoría operativa relacionada.",
        "default_days": 90,
        "tables": ["automation_agent_events"],
    },
    {
        "id": "syncthing",
        "label": "Syncthing Control",
        "description": "Snapshots, transferencias y eventos de archivos/carpetas observados.",
        "default_days": 30,
        "tables": [
            "syncthing_folder_snapshots",
            "syncthing_transfer_snapshots",
            "syncthing_remote_transfer_snapshots",
            "syncthing_file_events",
        ],
    },
    {
        "id": "audit",
        "label": "Auditoría",
        "description": "Registro histórico de acciones y accesos.",
        "default_days": 180,
        "tables": ["audit_log"],
    },
    {
        "id": "reports",
        "label": "Informes generados",
        "description": "Informes diarios generados por IA.",
        "default_days": 180,
        "tables": ["daily_reports"],
    },
]


def _retention_module_default_days() -> Dict[str, int]:
    out: Dict[str, int] = {}
    for spec in _RETENTION_MODULES:
        mid = str(spec.get("id") or "").strip()
        if not mid:
            continue
        try:
            days = int(spec.get("default_days") or 60)
        except Exception:
            days = 60
        out[mid] = max(1, min(3650, days))
    return out


def _retention_module_days_from_settings() -> Dict[str, int]:
    policy = _retention_module_default_days()
    raw = str(cfg("retention_module_days", "") or "").strip()
    if not raw:
        return policy

    try:
        data = _json.loads(raw)
    except Exception:
        return policy

    if not isinstance(data, dict):
        return policy

    valid_ids = set(policy.keys())
    for key, value in data.items():
        mid = str(key or "").strip()
        if mid not in valid_ids:
            continue
        try:
            days = int(value)
        except Exception:
            continue
        policy[mid] = max(1, min(3650, days))

    return policy


def _retention_module_days_from_payload(payload: Dict[str, Any]) -> Dict[str, int]:
    policy = _retention_module_days_from_settings()
    raw = (payload or {}).get("module_days")

    if not isinstance(raw, dict):
        return policy

    valid_ids = set(policy.keys())
    for key, value in raw.items():
        mid = str(key or "").strip()
        if mid not in valid_ids:
            continue
        try:
            days = int(value)
        except Exception:
            continue
        policy[mid] = max(1, min(3650, days))

    return policy


def _save_retention_module_days(raw_policy: Any) -> Dict[str, int]:
    defaults = _retention_module_default_days()
    if not isinstance(raw_policy, dict):
        raw_policy = {}

    cleaned: Dict[str, int] = {}
    for mid, default_days in defaults.items():
        value = raw_policy.get(mid, default_days)
        try:
            days = int(value)
        except Exception:
            days = default_days
        cleaned[mid] = max(1, min(3650, days))

    save_setting("retention_module_days", _json.dumps(cleaned, sort_keys=True))
    return cleaned


def _bytes_or_zero(path: str) -> int:
    try:
        return os.path.getsize(path) if os.path.exists(path) else 0
    except Exception:
        return 0


def _dir_size_bytes(path: str) -> int:
    total = 0
    if not os.path.isdir(path):
        return 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except Exception:
                pass
    return total


def _quote_sqlite_identifier(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'



_CLEANUP_TABLE_DATE_COLUMNS = {
    "host_events": "at",
    "audit_log": "at",
    "automation_agent_events": "at",
    "host_uptime": "date",
    "daily_reports": "generated_at",
}


_CLEANUP_DATE_COLUMN_PRIORITY = [
    "observed_at",
    "checked_at",
    "created_at",
    "updated_at",
    "event_time",
    "scan_time",
    "started_at",
    "finished_at",
    "generated_at",
    "timestamp",
    "time",
    "date",
]


def _cleanup_date_column(cur, table: str) -> str:
    cols = [r["name"] for r in cur.execute(f"PRAGMA table_info({_quote_sqlite_identifier(table)})").fetchall()]
    lower_map = {c.lower(): c for c in cols}

    explicit_col = _CLEANUP_TABLE_DATE_COLUMNS.get(table)
    if explicit_col and explicit_col.lower() in lower_map:
        return lower_map[explicit_col.lower()]

    for wanted in _CLEANUP_DATE_COLUMN_PRIORITY:
        if wanted in lower_map:
            return lower_map[wanted]

    for c in cols:
        lc = c.lower()
        if lc.endswith("_at") or "time" in lc or "date" in lc:
            return c

    return ""



def _create_safety_db_backup(reason: str = "cleanup") -> Dict[str, Any]:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    app_tz = get_app_tz()
    safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "_", reason or "backup").strip("_") or "backup"
    ts = datetime.now(app_tz).strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(BACKUP_DIR, f"auditor_{safe_reason}_{ts}.db")

    src_conn = sqlite3.connect(DB_PATH)
    dst_conn = sqlite3.connect(dest)
    try:
        src_conn.backup(dst_conn)
    finally:
        src_conn.close()
        dst_conn.close()

    return {
        "filename": os.path.basename(dest),
        "path": dest,
        "size_bytes": os.path.getsize(dest),
    }



@router.post("/api/db/vacuum")
def api_db_vacuum():
    """
    Compacta físicamente la BD SQLite con backup previo obligatorio.
    Útil después de limpiar muchos históricos.
    """
    try:
        before_size = _bytes_or_zero(DB_PATH) + _bytes_or_zero(DB_PATH + "-wal") + _bytes_or_zero(DB_PATH + "-shm")
        backup_info = _create_safety_db_backup("vacuum_before")

        with sqlite3.connect(DB_PATH, isolation_level=None) as conn:
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            conn.execute("VACUUM")
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass

        after_size = _bytes_or_zero(DB_PATH) + _bytes_or_zero(DB_PATH + "-wal") + _bytes_or_zero(DB_PATH + "-shm")
        return {
            "ok": True,
            "backup": backup_info,
            "before_bytes": before_size,
            "after_bytes": after_size,
            "freed_bytes": max(0, before_size - after_size),
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/db/cleanup-run")
def api_db_cleanup_run(payload: Dict[str, Any] = Body(default={})):
    """
    Ejecuta limpieza de históricos con backup previo obligatorio.
    No toca maestros, configuración, hosts, servicios, Syncthing nodes ni backups.
    """
    try:
        from datetime import timezone, timedelta

        keep_days = max(1, min(3650, int((payload or {}).get("days", 60) or 60)))
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=keep_days)).replace(microsecond=0).isoformat()

        backup_info = _create_safety_db_backup("cleanup_history")

        deleted = []
        total_deleted = 0
        skipped = []

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            existing_tables = {
                r["name"] for r in cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }

            for table in sorted(_HISTORY_TABLES):
                if table not in existing_tables:
                    continue

                date_col = _cleanup_date_column(cur, table)
                if not date_col:
                    skipped.append({"table": table, "reason": "sin columna de fecha clara"})
                    continue

                qtable = _quote_sqlite_identifier(table)
                qcol = _quote_sqlite_identifier(date_col)

                before = int(cur.execute(f"SELECT COUNT(*) FROM {qtable}").fetchone()[0] or 0)
                cur.execute(
                    f"""
                    DELETE FROM {qtable}
                    WHERE {qcol} IS NOT NULL
                      AND {qcol} <> ''
                      AND {qcol} < ?
                    """,
                    (cutoff_iso,),
                )
                removed = max(0, int(cur.rowcount or 0))
                after = max(0, before - removed)
                total_deleted += removed

                deleted.append({
                    "table": table,
                    "date_column": date_col,
                    "rows_before": before,
                    "rows_deleted": removed,
                    "rows_after": after,
                })

            conn.commit()

        deleted.sort(key=lambda x: x["rows_deleted"], reverse=True)

        return {
            "ok": True,
            "days": keep_days,
            "cutoff_iso": cutoff_iso,
            "backup": backup_info,
            "total_rows_deleted": total_deleted,
            "tables": deleted,
            "skipped": skipped,
            "note": "Limpieza aplicada. Para reducir el tamaño físico del .db hará falta una compactación/VACUUM separada.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/db/retention-estimate")
def api_db_retention_estimate(days: Optional[int] = None):
    """
    Estima retención por módulo sin borrar nada.
    Si no se pasa days, usa la política persistente por módulo.
    """
    try:
        from datetime import timezone, timedelta

        module_days = _retention_module_days_from_settings()
        global_days = None
        if days is not None:
            global_days = max(1, min(3650, int(days or 60)))

        modules = []
        total_rows = 0
        total_delete = 0
        total_supported_delete = 0

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            existing_tables = {
                r["name"] for r in cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }

            for spec in _RETENTION_MODULES:
                module_id = str(spec.get("id") or "")
                keep_days = global_days if global_days is not None else module_days.get(module_id, int(spec.get("default_days") or 60))
                keep_days = max(1, min(3650, int(keep_days or 60)))
                cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=keep_days)).replace(microsecond=0).isoformat()

                module_rows = 0
                module_delete = 0
                module_supported_delete = 0
                tables = []
                skipped = []

                for table in spec.get("tables", []):
                    if table not in existing_tables:
                        skipped.append({"table": table, "reason": "tabla no existe"})
                        continue

                    qtable = _quote_sqlite_identifier(table)
                    rows_total = int(cur.execute(f"SELECT COUNT(*) FROM {qtable}").fetchone()[0] or 0)
                    module_rows += rows_total

                    date_col = _cleanup_date_column(cur, table)
                    if not date_col:
                        skipped.append({"table": table, "rows": rows_total, "reason": "sin columna de fecha clara"})
                        continue

                    qcol = _quote_sqlite_identifier(date_col)
                    rows_delete = int(cur.execute(
                        f"""
                        SELECT COUNT(*)
                        FROM {qtable}
                        WHERE {qcol} IS NOT NULL
                          AND {qcol} <> ''
                          AND {qcol} < ?
                        """,
                        (cutoff_iso,),
                    ).fetchone()[0] or 0)

                    cleanup_supported = table in _HISTORY_TABLES
                    module_delete += rows_delete
                    if cleanup_supported:
                        module_supported_delete += rows_delete

                    tables.append({
                        "table": table,
                        "date_column": date_col,
                        "rows_total": rows_total,
                        "rows_delete": rows_delete,
                        "rows_after": max(0, rows_total - rows_delete),
                        "cleanup_supported": cleanup_supported,
                    })

                tables.sort(key=lambda x: x["rows_delete"], reverse=True)

                total_rows += module_rows
                total_delete += module_delete
                total_supported_delete += module_supported_delete

                modules.append({
                    "id": spec.get("id"),
                    "label": spec.get("label"),
                    "description": spec.get("description"),
                    "default_days": spec.get("default_days"),
                    "days": keep_days,
                    "rows_total": module_rows,
                    "rows_delete": module_delete,
                    "rows_delete_supported": module_supported_delete,
                    "rows_after": max(0, module_rows - module_delete),
                    "tables": tables,
                    "skipped": skipped,
                })

        return {
            "ok": True,
            "days": global_days,
            "module_days": module_days,
            "cutoff_iso": "",
            "total_rows": total_rows,
            "total_rows_delete": total_delete,
            "total_rows_delete_supported": total_supported_delete,
            "total_rows_after": max(0, total_rows - total_delete),
            "modules": modules,
            "note": "Estimación por módulo no destructiva. Algunas tablas aparecen como inventariadas aunque la limpieza global actual todavía no las borre.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/db/retention-policy")
def api_db_retention_policy_save(payload: Dict[str, Any] = Body(default={})):
    """
    Guarda la política persistente de días por módulo.
    No borra datos.
    """
    try:
        policy = _save_retention_module_days((payload or {}).get("module_days") or {})
        return {"ok": True, "module_days": policy}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/db/retention-run")
def api_db_retention_run(payload: Dict[str, Any] = Body(default={})):
    """
    Ejecuta limpieza por módulos seleccionados con backup previo obligatorio.
    Solo borra tablas históricas soportadas y nunca toca tablas maestras/configuración.
    """
    try:
        from datetime import timezone, timedelta

        body = payload or {}
        module_days = _retention_module_days_from_payload(body)
        global_days = body.get("days", None)

        raw_modules = body.get("modules") or []
        if isinstance(raw_modules, str):
            raw_modules = [raw_modules]
        requested_ids = {str(x).strip() for x in raw_modules if str(x).strip()}

        specs_by_id = {str(spec.get("id")): spec for spec in _RETENTION_MODULES}
        unknown_ids = sorted(x for x in requested_ids if x not in specs_by_id)
        selected_specs = [specs_by_id[x] for x in sorted(requested_ids) if x in specs_by_id]

        if not selected_specs:
            return JSONResponse({
                "ok": False,
                "error": "Selecciona al menos un módulo válido para limpiar.",
                "unknown_modules": unknown_ids,
            }, status_code=400)

        backup_info = _create_safety_db_backup("retention_modules")

        modules_result = []
        deleted_tables = []
        skipped = []
        seen_tables = set()
        total_deleted = 0

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            existing_tables = {
                r["name"] for r in cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }

            for spec in selected_specs:
                module_id = str(spec.get("id") or "")
                if global_days is not None:
                    keep_days = max(1, min(3650, int(global_days or 60)))
                else:
                    keep_days = module_days.get(module_id, int(spec.get("default_days") or 60))
                    keep_days = max(1, min(3650, int(keep_days or 60)))
                cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=keep_days)).replace(microsecond=0).isoformat()

                module_deleted = 0
                module_tables = []

                for table in spec.get("tables", []):
                    if table in seen_tables:
                        continue
                    seen_tables.add(table)

                    if table not in existing_tables:
                        skipped.append({"module": spec.get("id"), "table": table, "reason": "tabla no existe"})
                        continue

                    if table not in _HISTORY_TABLES:
                        skipped.append({"module": spec.get("id"), "table": table, "reason": "tabla no soportada para limpieza"})
                        continue

                    date_col = _cleanup_date_column(cur, table)
                    if not date_col:
                        skipped.append({"module": spec.get("id"), "table": table, "reason": "sin columna de fecha clara"})
                        continue

                    qtable = _quote_sqlite_identifier(table)
                    qcol = _quote_sqlite_identifier(date_col)

                    before = int(cur.execute(f"SELECT COUNT(*) FROM {qtable}").fetchone()[0] or 0)
                    cur.execute(
                        f"""
                        DELETE FROM {qtable}
                        WHERE {qcol} IS NOT NULL
                          AND {qcol} <> ''
                          AND {qcol} < ?
                        """,
                        (cutoff_iso,),
                    )
                    removed = max(0, int(cur.rowcount or 0))
                    after = max(0, before - removed)

                    total_deleted += removed
                    module_deleted += removed

                    row = {
                        "module": spec.get("id"),
                        "table": table,
                        "date_column": date_col,
                        "rows_before": before,
                        "rows_deleted": removed,
                        "rows_after": after,
                        "days": keep_days,
                        "cutoff_iso": cutoff_iso,
                    }
                    module_tables.append(row)
                    deleted_tables.append(row)

                modules_result.append({
                    "id": spec.get("id"),
                    "label": spec.get("label"),
                    "rows_deleted": module_deleted,
                    "days": keep_days,
                    "cutoff_iso": cutoff_iso,
                    "tables": sorted(module_tables, key=lambda x: x["rows_deleted"], reverse=True),
                })

            conn.commit()

        deleted_tables.sort(key=lambda x: x["rows_deleted"], reverse=True)

        return {
            "ok": True,
            "days": global_days,
            "module_days": module_days,
            "cutoff_iso": "",
            "backup": backup_info,
            "requested_modules": sorted(requested_ids),
            "unknown_modules": unknown_ids,
            "total_rows_deleted": total_deleted,
            "modules": modules_result,
            "tables": deleted_tables,
            "skipped": skipped,
            "note": "Limpieza por módulos aplicada. Para reducir el tamaño físico del .db hará falta una compactación/VACUUM separada.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


_HOST_INACTIVE_RELATED_TABLES = [
    ("host_events", "ip"),
    ("host_latency", "ip"),
    ("host_availability_intervals", "ip"),
    ("host_uptime", "ip"),
    ("public_wol_hosts", "host_ip"),
]


def _bool_from_any(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "si", "sí"}


def _chunked(items, size: int = 400):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _inactive_hosts_cutoff(days: int) -> str:
    from datetime import timezone, timedelta
    keep_days = max(1, min(3650, int(days or 90)))
    return (datetime.now(timezone.utc) - timedelta(days=keep_days)).replace(microsecond=0).isoformat()


def _inactive_hosts_candidates(cur, days: int, include_known: bool = False) -> Dict[str, Any]:
    keep_days = max(1, min(3650, int(days or 90)))
    cutoff_iso = _inactive_hosts_cutoff(keep_days)

    where = [
        "last_seen IS NOT NULL",
        "TRIM(COALESCE(last_seen, '')) <> ''",
        "last_seen < ?",
        "COALESCE(status, '') NOT IN ('online', 'online_silent')",
    ]
    params = [cutoff_iso]

    if not include_known:
        where.append("COALESCE(known, 0) = 0")

    sql = f"""
        SELECT ip, mac, manual_name, nmap_hostname, dns_name, status,
               known, first_seen, last_seen, last_change
        FROM hosts
        WHERE {' AND '.join(where)}
        ORDER BY last_seen ASC
    """
    rows = [dict(r) for r in cur.execute(sql, params).fetchall()]
    ips = [r["ip"] for r in rows if r.get("ip")]

    return {
        "days": keep_days,
        "cutoff_iso": cutoff_iso,
        "include_known": bool(include_known),
        "hosts": rows,
        "ips": ips,
    }


def _inactive_hosts_related_counts(cur, ips) -> Dict[str, int]:
    existing_tables = {
        r["name"] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }

    counts: Dict[str, int] = {}
    if not ips:
        for table, _ in _HOST_INACTIVE_RELATED_TABLES:
            if table in existing_tables:
                counts[table] = 0
        return counts

    for table, column in _HOST_INACTIVE_RELATED_TABLES:
        if table not in existing_tables:
            continue
        total = 0
        qtable = _quote_sqlite_identifier(table)
        qcol = _quote_sqlite_identifier(column)
        for part in _chunked(list(ips)):
            placeholders = ",".join("?" for _ in part)
            total += int(cur.execute(
                f"SELECT COUNT(*) FROM {qtable} WHERE {qcol} IN ({placeholders})",
                part,
            ).fetchone()[0] or 0)
        counts[table] = total

    return counts


@router.get("/api/hosts/inactive-cleanup-estimate")
def api_hosts_inactive_cleanup_estimate(days: int = 90, include_known: int = 0):
    """
    Estima hosts inactivos candidatos a borrado.
    Criterio conservador:
    - last_seen real anterior al plazo;
    - host no online;
    - por defecto, solo hosts no conocidos.
    """
    try:
        keep_days = max(1, min(3650, int(days or 90)))
        include_known_bool = _bool_from_any(include_known, False)

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            data = _inactive_hosts_candidates(cur, keep_days, include_known_bool)
            ips = data["ips"]
            related = _inactive_hosts_related_counts(cur, ips)

        total_related = sum(int(v or 0) for v in related.values())

        return {
            "ok": True,
            "days": data["days"],
            "cutoff_iso": data["cutoff_iso"],
            "include_known": data["include_known"],
            "hosts_count": len(ips),
            "related_rows_delete": total_related,
            "related_tables": related,
            "sample_hosts": data["hosts"][:80],
            "note": "No borra nada. La ejecución real crea backup previo obligatorio.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/api/hosts/inactive-cleanup-run")
def api_hosts_inactive_cleanup_run(payload: Dict[str, Any] = Body(default={})):
    """
    Borra hosts inactivos con backup previo obligatorio.
    No toca configuración, tipos, responsables, servicios, Syncthing ni backups.
    """
    try:
        body = payload or {}
        keep_days = max(1, min(3650, int(body.get("days", 90) or 90)))
        include_known_bool = _bool_from_any(body.get("include_known"), False)

        backup_info = _create_safety_db_backup("hosts_inactive_cleanup")

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            data = _inactive_hosts_candidates(cur, keep_days, include_known_bool)
            ips = data["ips"]
            related_before = _inactive_hosts_related_counts(cur, ips)

            deleted_tables = []
            if ips:
                existing_tables = {
                    r["name"] for r in cur.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    ).fetchall()
                }

                for table, column in _HOST_INACTIVE_RELATED_TABLES:
                    if table not in existing_tables:
                        continue
                    removed = 0
                    qtable = _quote_sqlite_identifier(table)
                    qcol = _quote_sqlite_identifier(column)
                    for part in _chunked(list(ips)):
                        placeholders = ",".join("?" for _ in part)
                        cur.execute(
                            f"DELETE FROM {qtable} WHERE {qcol} IN ({placeholders})",
                            part,
                        )
                        removed += max(0, int(cur.rowcount or 0))
                    deleted_tables.append({
                        "table": table,
                        "column": column,
                        "rows_deleted": removed,
                    })

                deleted_hosts = 0
                for part in _chunked(list(ips)):
                    placeholders = ",".join("?" for _ in part)
                    cur.execute(f"DELETE FROM hosts WHERE ip IN ({placeholders})", part)
                    deleted_hosts += max(0, int(cur.rowcount or 0))
            else:
                deleted_hosts = 0

            conn.commit()

        return {
            "ok": True,
            "days": data["days"],
            "cutoff_iso": data["cutoff_iso"],
            "include_known": data["include_known"],
            "backup": backup_info,
            "hosts_deleted": deleted_hosts,
            "related_rows_deleted": sum(int(t.get("rows_deleted") or 0) for t in deleted_tables),
            "related_tables_before": related_before,
            "tables": sorted(deleted_tables, key=lambda x: x["rows_deleted"], reverse=True),
            "note": "Limpieza aplicada. Para reducir tamaño físico del .db puede ejecutarse VACUUM aparte.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/db/cleanup-estimate")
def api_db_cleanup_estimate(days: int = 60):
    """
    Estima limpieza de históricos sin borrar nada.
    Devuelve filas actuales, filas afectadas y filas restantes por tabla.
    """
    try:
        keep_days = max(1, min(3650, int(days or 60)))
        cutoff_dt = datetime.now(get_app_tz()).astimezone().replace(microsecond=0)
        # Usamos UTC ISO para comparar con columnas ISO con offset.
        from datetime import timezone, timedelta
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=keep_days)).replace(microsecond=0).isoformat()

        estimates = []
        total_rows = 0
        total_delete = 0
        skipped = []

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            existing_tables = {
                r["name"] for r in cur.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }

            for table in sorted(_HISTORY_TABLES):
                if table not in existing_tables:
                    continue

                qtable = _quote_sqlite_identifier(table)
                rows_total = int(cur.execute(f"SELECT COUNT(*) FROM {qtable}").fetchone()[0] or 0)
                total_rows += rows_total

                date_col = _cleanup_date_column(cur, table)
                if not date_col:
                    skipped.append({"table": table, "rows": rows_total, "reason": "sin columna de fecha clara"})
                    continue

                qcol = _quote_sqlite_identifier(date_col)
                rows_delete = int(cur.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM {qtable}
                    WHERE {qcol} IS NOT NULL
                      AND {qcol} <> ''
                      AND {qcol} < ?
                    """,
                    (cutoff_iso,),
                ).fetchone()[0] or 0)

                total_delete += rows_delete
                estimates.append({
                    "table": table,
                    "date_column": date_col,
                    "rows_total": rows_total,
                    "rows_delete": rows_delete,
                    "rows_after": max(0, rows_total - rows_delete),
                })

        estimates.sort(key=lambda x: x["rows_delete"], reverse=True)

        return {
            "ok": True,
            "days": keep_days,
            "cutoff_iso": cutoff_iso,
            "total_history_rows": total_rows,
            "total_rows_delete": total_delete,
            "total_rows_after": max(0, total_rows - total_delete),
            "tables": estimates,
            "skipped": skipped,
            "note": "Estimación no destructiva. El tamaño físico del fichero .db no bajará hasta ejecutar VACUUM/compactación.",
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/db/storage-summary")
def api_db_storage_summary():
    """Resumen no destructivo de tamaño de BD, backups, disco y filas por tabla."""
    try:
        data_dir = os.path.dirname(DB_PATH)
        db_size = _bytes_or_zero(DB_PATH)
        wal_size = _bytes_or_zero(DB_PATH + "-wal")
        shm_size = _bytes_or_zero(DB_PATH + "-shm")
        backups_size = _dir_size_bytes(BACKUP_DIR)
        backup_count = 0
        if os.path.isdir(BACKUP_DIR):
            backup_count = len([
                f for f in os.listdir(BACKUP_DIR)
                if f.startswith("auditor_") and f.endswith(".db")
            ])

        disk = shutil.disk_usage(data_dir)

        table_rows = []
        page_size = 0
        page_count = 0
        freelist_count = 0

        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            page_size = int(cur.execute("PRAGMA page_size").fetchone()[0] or 0)
            page_count = int(cur.execute("PRAGMA page_count").fetchone()[0] or 0)
            freelist_count = int(cur.execute("PRAGMA freelist_count").fetchone()[0] or 0)

            tables = [
                r["name"] for r in cur.execute(
                    """
                    SELECT name
                    FROM sqlite_master
                    WHERE type='table'
                      AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                    """
                ).fetchall()
            ]

            for table in tables:
                rows = 0
                try:
                    rows = int(cur.execute(f"SELECT COUNT(*) FROM {_quote_sqlite_identifier(table)}").fetchone()[0] or 0)
                except Exception:
                    rows = 0
                table_rows.append({
                    "table": table,
                    "rows": rows,
                    "category": "history" if table in _HISTORY_TABLES else "core",
                })

        table_rows.sort(key=lambda x: x["rows"], reverse=True)

        return {
            "ok": True,
            "db_path": DB_PATH,
            "backup_dir": BACKUP_DIR,
            "files": {
                "db_bytes": db_size,
                "wal_bytes": wal_size,
                "shm_bytes": shm_size,
                "sqlite_total_bytes": db_size + wal_size + shm_size,
                "backups_bytes": backups_size,
                "backup_count": backup_count,
            },
            "sqlite": {
                "page_size": page_size,
                "page_count": page_count,
                "freelist_count": freelist_count,
                "freelist_bytes": page_size * freelist_count,
            },
            "disk": {
                "path": data_dir,
                "total_bytes": disk.total,
                "used_bytes": disk.used,
                "free_bytes": disk.free,
            },
            "table_rows": table_rows,
        }
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)



def run_backup() -> Dict[str, Any]:
    """Crea copia de seguridad de la BD con la SQLite backup API."""
    if cfg("backup_enabled", "1") != "1":
        return {"ok": True, "skipped": True}
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        app_tz = get_app_tz()
        ts   = datetime.now(app_tz).strftime("%Y%m%d_%H%M%S")
        dest = os.path.join(BACKUP_DIR, f"auditor_{ts}.db")
        src_conn = sqlite3.connect(DB_PATH)
        dst_conn = sqlite3.connect(dest)
        src_conn.backup(dst_conn)
        src_conn.close()
        dst_conn.close()
        size_kb = round(os.path.getsize(dest) / 1024, 1)
        keep    = int(cfg("backup_keep", "7"))
        all_bak = sorted(
            [f for f in os.listdir(BACKUP_DIR) if f.startswith("auditor_") and f.endswith(".db")],
            reverse=True,
        )
        removed = []
        for old in all_bak[keep:]:
            os.remove(os.path.join(BACKUP_DIR, old))
            removed.append(old)
        return {"ok": True, "file": dest, "size_kb": size_kb, "removed": removed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/api/backup/run")
def api_backup_run():
    return run_backup()


@router.post("/api/backup/prune")
def api_backup_prune(payload: Dict[str, Any] = Body(default={})):
    """Elimina backups antiguos respetando backup_keep, sin tocar la BD activa."""
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)

        raw_keep = payload.get("backup_keep", cfg("backup_keep", "7")) if isinstance(payload, dict) else cfg("backup_keep", "7")
        keep = max(1, min(30, int(raw_keep or 7)))
        save_setting("backup_keep", str(keep))

        files = sorted(
            [f for f in os.listdir(BACKUP_DIR) if f.startswith("auditor_") and f.endswith(".db")],
            reverse=True,
        )
        removed = []
        freed_bytes = 0
        for old in files[keep:]:
            path = os.path.join(BACKUP_DIR, old)
            try:
                size = os.path.getsize(path)
                os.remove(path)
                removed.append(old)
                freed_bytes += size
            except Exception:
                pass
        return {"ok": True, "keep": keep, "removed": removed, "removed_count": len(removed), "freed_bytes": freed_bytes}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/backup/list")
def api_backup_list():
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        files = sorted(
            [f for f in os.listdir(BACKUP_DIR) if f.startswith("auditor_") and f.endswith(".db")],
            reverse=True,
        )
        backups = []
        for f in files:
            path = os.path.join(BACKUP_DIR, f)
            stat = os.stat(path)
            backups.append({
                "filename": f,
                "size_bytes": stat.st_size,
                "size_kb":  round(stat.st_size / 1024, 1),
                "created":  datetime.fromtimestamp(stat.st_mtime, tz=get_app_tz()).strftime("%Y-%m-%d %H:%M:%S"),
            })
        return {"ok": True, "backups": backups, "backup_dir": BACKUP_DIR}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/backup/download/{filename}")
def api_backup_download(filename: str):
    if "/" in filename or "\\" in filename or not filename.endswith(".db"):
        return JSONResponse({"ok": False, "error": "Nombre inválido"}, status_code=400)
    path = os.path.join(BACKUP_DIR, filename)
    if not os.path.isfile(path):
        return JSONResponse({"ok": False, "error": "Archivo no encontrado"}, status_code=404)
    return FileResponse(path, filename=filename, media_type="application/octet-stream")


@router.delete("/api/backup/{filename}")
def api_backup_delete(filename: str):
    if "/" in filename or "\\" in filename or not filename.endswith(".db"):
        return JSONResponse({"ok": False, "error": "Nombre inválido"}, status_code=400)
    path = os.path.join(BACKUP_DIR, filename)
    if not os.path.isfile(path):
        return JSONResponse({"ok": False, "error": "Archivo no encontrado"}, status_code=404)
    os.remove(path)
    return {"ok": True}


@router.get("/api/db/backup")
def db_backup_download():
    """Descarga el fichero .db completo en vivo."""
    app_tz   = get_app_tz(cfg("app_tz", "Europe/Madrid"))
    tmp      = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    shutil.copy2(DB_PATH, tmp.name)
    filename = f"auditor_ips_backup_{datetime.now(app_tz).strftime('%Y%m%d_%H%M%S')}.db"
    return FileResponse(
        tmp.name, media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        filename=filename,
    )


@router.post("/api/db/restore")
async def db_restore(request: Request):
    """Restaura la BD desde un fichero .db subido por formulario."""
    from fastapi import UploadFile
    form = await request.form()
    file: UploadFile = form.get("file")
    if not file:
        return JSONResponse({"ok": False, "error": "No se recibió fichero"}, status_code=400)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    try:
        content = await file.read()
        if not content.startswith(b"SQLite format 3"):
            return JSONResponse({"ok": False, "error": "No es una BD SQLite válida"}, status_code=400)
        with open(tmp.name, "wb") as f:
            f.write(content)
        shutil.copy2(tmp.name, DB_PATH)
        return {"ok": True, "message": "BD restaurada. Recarga la página."}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════
#  Push notifications
# ═══════════════════════════════════════════════════════════════

@router.post("/api/push/subscribe")
def api_push_subscribe(payload: Dict[str, Any] = Body(...)):
    endpoint = (payload.get("endpoint") or "").strip()
    p256dh   = (payload.get("p256dh")   or "").strip()
    auth     = (payload.get("auth")     or "").strip()
    if not endpoint or not p256dh or not auth:
        return JSONResponse({"ok": False, "error": "Faltan campos"}, status_code=400)
    with db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at)
            VALUES (?,?,?,?)
        """, (endpoint, p256dh, auth, utc_now_iso()))
    return {"ok": True}


@router.post("/api/push/unsubscribe")
def api_push_unsubscribe(payload: Dict[str, Any] = Body(...)):
    endpoint = (payload.get("endpoint") or "").strip()
    with db() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
    return {"ok": True}


@router.get("/api/push/vapid-key")
def api_push_vapid_key():
    return {"ok": True, "key": cfg("vapid_public_key", "")}


@router.post("/api/push/generate-vapid")
def api_generate_vapid():
    """Genera un par de claves VAPID con openssl y las persiste en settings."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            key_path = os.path.join(tmp, "vapid.pem")
            subprocess.run(
                ["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key_path],
                check=True, capture_output=True,
            )
            priv_der = subprocess.run(
                ["openssl", "ec", "-in", key_path, "-outform", "DER"],
                check=True, capture_output=True,
            ).stdout
            pub_der = subprocess.run(
                ["openssl", "ec", "-in", key_path, "-pubout", "-outform", "DER"],
                check=True, capture_output=True,
            ).stdout

        def b64u(b: bytes) -> str:
            return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

        pub_key  = b64u(pub_der[-65:])
        priv_key = b64u(priv_der[-32:])

        with db() as conn:
            conn.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_public_key',?)",  (pub_key,))
            conn.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_private_key',?)", (priv_key,))

        from config import _cfg
        _cfg["vapid_public_key"]  = pub_key
        _cfg["vapid_private_key"] = priv_key

        return {"ok": True, "public_key": pub_key}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ═══════════════════════════════════════════════════════════════
#  TLS
# ═══════════════════════════════════════════════════════════════

@router.get("/api/tls/ca.crt")
def download_ca():
    ca_path = "/data/certs/ca.crt"
    if not os.path.exists(ca_path):
        return JSONResponse(
            {"error": "Certificado CA no generado aún. Espera al primer arranque."},
            status_code=404,
        )
    return FileResponse(
        ca_path, media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="AuditorIPs-CA.crt"'},
    )


@router.get("/tls-info", response_class=HTMLResponse)
def tls_info(request: Request):
    host = request.headers.get("host", "192.168.1.x:9909")
    base = f"https://{host}"
    html = f"""<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Instalar certificado — Auditor IPs</title>
<style>
  body{{font-family:sans-serif;max-width:500px;margin:40px auto;padding:20px;background:#1a1a2e;color:#eee}}
  h2{{color:#4dffb5}}
  a.btn{{display:block;background:#4dffb5;color:#000;padding:14px;border-radius:10px;
         text-align:center;text-decoration:none;font-weight:700;font-size:1.1rem;margin:20px 0}}
  ol{{line-height:2.2rem}}
  code{{background:rgba(255,255,255,.1);padding:2px 6px;border-radius:4px}}
</style></head><body>
<h2>📱 Instalar certificado de seguridad</h2>
<p>Para eliminar el aviso <strong>"No seguro"</strong> en tu móvil Android:</p>
<a class=btn href="{base}/api/tls/ca.crt">⬇️ Descargar certificado CA</a>
<ol>
  <li>Pulsa el botón de arriba para descargar <code>AuditorIPs-CA.crt</code></li>
  <li>Ve a <strong>Ajustes → Seguridad → Más ajustes → Instalar desde almacenamiento</strong></li>
  <li>Selecciona el fichero descargado</li>
  <li>Ponle un nombre (ej: <em>AuditorIPs CA</em>) y confirma</li>
  <li>Reinicia Chrome y accede a <code>{base}</code></li>
</ol>
<p style="opacity:.6;font-size:.85rem">El certificado es local y solo válido en tu red.</p>
<p><a href="/" style="color:#4dffb5">← Volver a Auditor IPs</a></p>
</body></html>"""
    return HTMLResponse(html)



def _report_html_escape(value: Any) -> str:
    return _html.escape("" if value is None else str(value), quote=True)


def _report_status_label(status: str) -> str:
    labels = {
        "online": "Online",
        "online_silent": "Online silencioso",
        "offline": "Offline",
        "unknown": "Desconocido",
        "ok": "OK",
        "up": "OK",
        "down": "Caído",
        "error": "Error",
        "warning": "Aviso",
        "degraded": "Degradado",
        "syncing": "Sincronizando",
        "scanning": "Escaneando",
        "standby": "Standby",
        "stalled": "Posible atasco",
    }
    return labels.get(str(status or "").strip().lower(), str(status or "") or "—")


@router.get("/api/export/report/html", response_class=HTMLResponse)
def api_export_report_html(date_from: str = "", date_to: str = ""):
    """
    Informe HTML imprimible.
    Base V4 para exportación PDF mediante Imprimir / Guardar como PDF desde navegador.
    Permite filtrar datos históricos con date_from/date_to en formato YYYY-MM-DD.
    """
    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid"))
    generated_at = datetime.now(app_tz)

    range_error = ""
    try:
        report_from_date = datetime.strptime(date_from, "%Y-%m-%d").date() if date_from else (generated_at - timedelta(days=7)).date()
        report_to_date = datetime.strptime(date_to, "%Y-%m-%d").date() if date_to else generated_at.date()
        if report_from_date > report_to_date:
            report_from_date, report_to_date = report_to_date, report_from_date
    except ValueError:
        range_error = "Rango de fechas inválido; se muestran los últimos 7 días."
        report_from_date = (generated_at - timedelta(days=7)).date()
        report_to_date = generated_at.date()

    report_from = report_from_date.strftime("%Y-%m-%d")
    report_to = report_to_date.strftime("%Y-%m-%d")
    iso_from = f"{report_from}T00:00:00"
    iso_to = f"{report_to}T23:59:59"
    report_range_label = f"{report_from} → {report_to}"

    with db() as conn:
        hosts = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes,
                   COALESCE(t.name,'') AS type_name,
                   COALESCE(t.icon,'') AS type_icon,
                   h.first_seen, h.last_seen, h.last_change, h.status, h.known, h.last_latency_ms
            FROM hosts h
            LEFT JOIN host_types t ON t.id = h.type_id
            ORDER BY
                CASE WHEN h.status='online' THEN 0
                     WHEN h.status='online_silent' THEN 1
                     WHEN h.status='offline' THEN 2
                     ELSE 3 END,
                h.ip
        """).fetchall()

        scans = conn.execute("""
            SELECT id, started_at, finished_at, cidr, online_hosts, offline_hosts,
                   new_hosts, events_sent, discord_sent, discord_error
            FROM scans
            WHERE started_at BETWEEN ? AND ?
            ORDER BY id DESC
            LIMIT 100
        """, (iso_from, iso_to)).fetchall()

        services = conn.execute("""
            SELECT s.name, s.host, s.port, s.protocol, s.service_type,
                   sc.status, sc.latency_ms, sc.checked_at, sc.error
            FROM services s
            LEFT JOIN service_checks sc ON sc.id = (
                SELECT id
                FROM service_checks
                WHERE service_id=s.id AND checked_at BETWEEN ? AND ?
                ORDER BY checked_at DESC
                LIMIT 1
            )
            ORDER BY s.name COLLATE NOCASE ASC
        """, (iso_from, iso_to)).fetchall()

        uptime = conn.execute("""
            SELECT u.ip,
                   COALESCE(h.manual_name, h.nmap_hostname, h.dns_name, u.ip) AS name,
                   SUM(u.online_seconds) AS online_seconds,
                   SUM(u.offline_seconds) AS offline_seconds
            FROM host_uptime u
            LEFT JOIN hosts h ON h.ip = u.ip
            WHERE u.date BETWEEN ? AND ?
            GROUP BY u.ip
            ORDER BY u.ip
        """, (report_from, report_to)).fetchall()

    total_hosts = len(hosts)
    online_hosts = sum(1 for h in hosts if h["status"] in {"online", "online_silent"})
    offline_hosts = sum(1 for h in hosts if h["status"] == "offline")
    known_hosts = sum(1 for h in hosts if h["known"])

    service_total = len(services)
    service_ok = sum(1 for srow in services if str(srow["status"] or "").lower() in {"ok", "up"})
    service_bad = sum(1 for srow in services if str(srow["status"] or "").lower() in {"down", "error"})

    def _safe_report_call(fn):
        try:
            data = fn()
            return data if isinstance(data, dict) else {"ok": False, "error": "Respuesta no válida"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    try:
        from routers import quality as r_quality
        from routers import syncthing_control as r_syncthing_control
        from routers import system_health as r_system_health

        quality_summary = _safe_report_call(r_quality.api_quality_summary)
        syncthing_overview = _safe_report_call(lambda: r_syncthing_control.api_syncthing_overview(refresh=False))
        system_health = _safe_report_call(r_system_health.api_system_health)
    except Exception as exc:
        quality_summary = {"ok": False, "error": str(exc)}
        syncthing_overview = {"ok": False, "error": str(exc)}
        system_health = {"ok": False, "error": str(exc)}

    syn_summary = syncthing_overview.get("summary") if isinstance(syncthing_overview, dict) else {}
    syn_summary = syn_summary if isinstance(syn_summary, dict) else {}

    system_overall = str(system_health.get("overall") or ("ok" if system_health.get("ok") else "unknown"))
    quality_overall = str(quality_summary.get("overall") or "unknown")
    syn_nodes_total = int(syn_summary.get("nodes_total") or 0)
    syn_nodes_syncing = int(syn_summary.get("nodes_syncing") or 0)
    syn_folders_error = int(syn_summary.get("folders_error") or 0)
    syn_stalled = int(syn_summary.get("folders_stalled_candidate") or 0)

    def _report_fmt_bytes(value: Any) -> str:
        try:
            n = float(value or 0)
        except Exception:
            return "0 B"
        units = ["B", "KB", "MB", "GB", "TB", "PB"]
        idx = 0
        while n >= 1024 and idx < len(units) - 1:
            n /= 1024
            idx += 1
        if idx == 0:
            return f"{int(n)} {units[idx]}"
        return f"{n:.1f} {units[idx]}"

    def _report_css_token(value: Any) -> str:
        return re.sub(r"[^a-z0-9_-]+", "-", str(value or "unknown").strip().lower()).strip("-") or "unknown"

    def tr_hosts():
        rows = []
        for h in hosts:
            name = h["manual_name"] or h["nmap_hostname"] or h["dns_name"] or ""
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(h["ip"])}</td>
                <td>{_report_html_escape(h["mac"] or "")}</td>
                <td>{_report_html_escape(name)}</td>
                <td>{_report_html_escape((h["type_icon"] or "") + " " + (h["type_name"] or ""))}</td>
                <td><span class="badge badge-{_report_html_escape(h["status"] or "unknown")}">{_report_html_escape(_report_status_label(h["status"]))}</span></td>
                <td>{_report_html_escape("Sí" if h["known"] else "No")}</td>
                <td>{_report_html_escape(to_local_str(h["last_seen"]) if h["last_seen"] else "")}</td>
                <td class="num">{_report_html_escape(h["last_latency_ms"] if h["last_latency_ms"] is not None else "")}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="8" class="muted">Sin hosts.</td></tr>'

    def tr_scans():
        rows = []
        for r in scans:
            rows.append(f"""
              <tr>
                <td class="num">{_report_html_escape(r["id"])}</td>
                <td>{_report_html_escape(to_local_str(r["started_at"]) if r["started_at"] else "")}</td>
                <td>{_report_html_escape(to_local_str(r["finished_at"]) if r["finished_at"] else "")}</td>
                <td>{_report_html_escape(r["cidr"] or "")}</td>
                <td class="num">{_report_html_escape(r["online_hosts"] or 0)}</td>
                <td class="num">{_report_html_escape(r["offline_hosts"] or 0)}</td>
                <td class="num">{_report_html_escape(r["new_hosts"] or 0)}</td>
                <td>{_report_html_escape(r["discord_error"] or "")}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="8" class="muted">Sin ejecuciones.</td></tr>'

    def tr_services():
        rows = []
        for svc in services:
            status = str(svc["status"] or "unknown").lower()
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(svc["name"])}</td>
                <td>{_report_html_escape(svc["host"])}</td>
                <td class="num">{_report_html_escape(svc["port"])}</td>
                <td>{_report_html_escape(svc["protocol"])}</td>
                <td><span class="badge badge-{_report_html_escape(status)}">{_report_html_escape(_report_status_label(status))}</span></td>
                <td class="num">{_report_html_escape(svc["latency_ms"] if svc["latency_ms"] is not None else "")}</td>
                <td>{_report_html_escape(to_local_str(svc["checked_at"]) if svc["checked_at"] else "")}</td>
                <td>{_report_html_escape(svc["error"] or "")}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="8" class="muted">Sin servicios.</td></tr>'

    def tr_uptime():
        rows = []
        for u in uptime:
            online = int(u["online_seconds"] or 0)
            offline = int(u["offline_seconds"] or 0)
            total = online + offline
            pct = round(online * 100 / total, 1) if total > 0 else ""
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(u["ip"])}</td>
                <td>{_report_html_escape(u["name"] or "")}</td>
                <td class="num">{_report_html_escape(round(online / 3600, 2))}</td>
                <td class="num">{_report_html_escape(round(offline / 3600, 2))}</td>
                <td class="num">{_report_html_escape(pct)}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="5" class="muted">Sin datos de uptime recientes.</td></tr>'

    def tr_system_health():
        rows = []
        names = [
            ("database", "Base de datos"),
            ("storage", "Almacenamiento"),
            ("scheduler", "Scheduler"),
            ("scans", "Escaneos"),
            ("quality", "Calidad"),
            ("services", "Servicios"),
            ("automations", "Automatizaciones"),
            ("agents", "Agentes"),
            ("syncthing", "Syncthing"),
            ("ai", "IA"),
            ("notifications", "Notificaciones"),
        ]
        for key, label in names:
            item = system_health.get(key) if isinstance(system_health, dict) else {}
            item = item if isinstance(item, dict) else {}
            status = str(item.get("status") or ("ok" if item.get("ok") else "unknown"))
            msg = item.get("message") or ""
            detail = ""
            if key == "database":
                detail = f"{_report_fmt_bytes(item.get('size_bytes'))} · {item.get('latency_ms', '—')} ms"
            elif key == "storage":
                detail = f"{item.get('used_pct', '—')}% usado · libre {_report_fmt_bytes(item.get('free_bytes'))}"
            elif key == "scheduler":
                detail = f"{item.get('job_count', '—')} jobs · {item.get('state', '—')}"
            elif key == "scans":
                detail = f"{item.get('scans_today', '—')} hoy · último hace {((item.get('latest') or {}).get('age_seconds', '—'))} s"
            elif key == "quality":
                detail = f"{item.get('targets_active', '—')}/{item.get('targets_total', '—')} destinos · errores 24h: {item.get('errors_24h', '—')}"
            elif key == "services":
                detail = f"{item.get('services_enabled', '—')}/{item.get('services_total', '—')} activos · errores 24h: {item.get('errors_24h', '—')}"
            elif key == "syncthing":
                detail = f"{item.get('nodes_enabled', '—')}/{item.get('nodes_total', '—')} nodos · eventos 24h: {item.get('file_events_24h', '—')}"
            elif key == "ai":
                detail = f"{item.get('provider', '—')} · informes scan: {item.get('scan_reports', '—')}"
            else:
                detail = msg or ("OK" if item.get("ok") else "—")

            rows.append(f"""
              <tr>
                <td>{_report_html_escape(label)}</td>
                <td><span class="badge badge-{_report_html_escape(_report_css_token(status))}">{_report_html_escape(_report_status_label(status))}</span></td>
                <td>{_report_html_escape(msg or "—")}</td>
                <td>{_report_html_escape(detail)}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="4" class="muted">Sin datos de salud.</td></tr>'

    def tr_quality_targets():
        targets = quality_summary.get("targets") if isinstance(quality_summary, dict) else []
        targets = targets if isinstance(targets, list) else []
        rows = []
        for t in targets:
            last = t.get("last") if isinstance(t, dict) else {}
            last = last if isinstance(last, dict) else {}
            status = str(last.get("status") or ("disabled" if not t.get("enabled") else "unknown"))
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(t.get("name") or "")}</td>
                <td>{_report_html_escape(t.get("host") or "")}</td>
                <td>{_report_html_escape("Sí" if t.get("enabled") else "No")}</td>
                <td><span class="badge badge-{_report_html_escape(_report_css_token(status))}">{_report_html_escape(_report_status_label(status))}</span></td>
                <td class="num">{_report_html_escape(last.get("latency_ms") if last.get("latency_ms") is not None else "")}</td>
                <td class="num">{_report_html_escape(last.get("packet_loss") if last.get("packet_loss") is not None else "")}</td>
                <td>{_report_html_escape(to_local_str(last.get("checked_at")) if last.get("checked_at") else "")}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="7" class="muted">Sin destinos de calidad.</td></tr>'

    def tr_syncthing_nodes():
        nodes = syncthing_overview.get("nodes") if isinstance(syncthing_overview, dict) else []
        nodes = nodes if isinstance(nodes, list) else []
        rows = []
        for node in nodes:
            status = str(node.get("relevantState") or node.get("status") or "unknown")
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(node.get("name") or "")}</td>
                <td><span class="badge badge-{_report_html_escape(_report_css_token(status))}">{_report_html_escape(node.get("relevantStateLabel") or _report_status_label(status))}</span></td>
                <td>{_report_html_escape(node.get("version") or "")}</td>
                <td class="num">{_report_html_escape(round(float(node.get("rxBytesPerSecond") or 0), 1))}</td>
                <td class="num">{_report_html_escape(round(float(node.get("txBytesPerSecond") or 0), 1))}</td>
                <td>{_report_html_escape(to_local_str(node.get("checked_at")) if node.get("checked_at") else "")}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="6" class="muted">Sin nodos Syncthing.</td></tr>'

    def tr_syncthing_folders():
        folders = syncthing_overview.get("folders") if isinstance(syncthing_overview, dict) else []
        folders = folders if isinstance(folders, list) else []
        interesting = [
            f for f in folders
            if str(f.get("status") or "").lower() in {"syncing", "scanning", "error"}
            or int(f.get("needBytes") or 0) > 0
            or int(f.get("errors") or 0) > 0
            or bool(f.get("stalled_candidate"))
        ][:12]
        rows = []
        for f in interesting:
            status = str(f.get("status") or "unknown")
            rows.append(f"""
              <tr>
                <td>{_report_html_escape(f.get("node_name") or "")}</td>
                <td>{_report_html_escape(f.get("label") or f.get("id") or "")}</td>
                <td><span class="badge badge-{_report_html_escape(_report_css_token(status))}">{_report_html_escape(_report_status_label(status))}</span></td>
                <td>{_report_html_escape("Sí" if f.get("stalled_candidate") else "No")}</td>
                <td class="num">{_report_html_escape(_report_fmt_bytes(f.get("needBytes")))}</td>
                <td class="num">{_report_html_escape(f.get("needFiles") or 0)}</td>
                <td class="num">{_report_html_escape(f.get("errors") or 0)}</td>
              </tr>
            """)
        return "\n".join(rows) or '<tr><td colspan="7" class="muted">Sin carpetas Syncthing con actividad, errores o pendiente relevante.</td></tr>'

    html = f"""<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Auditor IPs · Informe HTML</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #0f172a; color: #e5e7eb; }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 28px; }}
    h1 {{ margin: 0 0 4px; font-size: 1.8rem; }}
    h2 {{ margin-top: 28px; border-bottom: 1px solid #334155; padding-bottom: 6px; font-size: 1.15rem; }}
    .muted {{ color: #94a3b8; }}
    .top {{ display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 22px; }}
    .actions {{ display: flex; gap: 8px; flex-wrap: wrap; }}
    button, a.btn {{ background: #2563eb; color: white; border: 0; border-radius: 8px; padding: 8px 12px; text-decoration: none; cursor: pointer; }}
    .cards {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }}
    .card {{ background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 14px; }}
    .card .label {{ color: #94a3b8; font-size: .78rem; }}
    .card .value {{ font-size: 1.45rem; font-weight: 700; margin-top: 4px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 10px; font-size: .84rem; }}
    th, td {{ border-bottom: 1px solid #334155; padding: 7px 8px; text-align: left; vertical-align: top; }}
    th {{ color: #93c5fd; background: #111827; position: sticky; top: 0; }}
    .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    .badge {{ display: inline-block; padding: 2px 7px; border-radius: 999px; background: #475569; color: white; font-size: .74rem; }}
    .badge-online, .badge-ok, .badge-up, .badge-standby {{ background: #166534; }}
    .badge-online_silent, .badge-warning, .badge-degraded, .badge-scanning, .badge-syncing {{ background: #92400e; }}
    .badge-offline, .badge-down, .badge-error, .badge-stalled {{ background: #991b1b; }}
    .badge-unknown, .badge-disabled {{ background: #475569; }}
    @media print {{
      body {{ background: white; color: #111827; }}
      main {{ max-width: none; padding: 0; }}
      .actions {{ display: none; }}
      .card {{ border-color: #d1d5db; background: white; }}
      th {{ color: #111827; background: #f3f4f6; }}
      th, td {{ border-bottom-color: #d1d5db; }}
      h2 {{ page-break-after: avoid; }}
      table {{ page-break-inside: auto; }}
      tr {{ page-break-inside: avoid; page-break-after: auto; }}
    }}
    @media (max-width: 900px) {{
      .cards {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .top {{ flex-direction: column; }}
    }}
  </style>
</head>
<body>
<main>
  <div class="top">
    <div>
      <h1>Auditor IPs · Informe HTML</h1>
      <div class="muted">Generado el {_report_html_escape(generated_at.strftime("%d/%m/%Y %H:%M:%S"))}</div>
      <div class="muted">Rango histórico: {_report_html_escape(report_range_label)}</div>
      <div class="muted">{_report_html_escape(range_error)}</div>
    </div>
    <div class="actions">
      <button onclick="window.print()">Imprimir / Guardar PDF</button>
      <a class="btn" href="/">Volver</a>
    </div>
  </div>

  <section class="cards">
    <div class="card"><div class="label">Hosts totales</div><div class="value">{total_hosts}</div></div>
    <div class="card"><div class="label">Hosts online</div><div class="value">{online_hosts}</div></div>
    <div class="card"><div class="label">Hosts offline</div><div class="value">{offline_hosts}</div></div>
    <div class="card"><div class="label">Servicios OK / total</div><div class="value">{service_ok}/{service_total}</div></div>
    <div class="card"><div class="label">Salud global</div><div class="value">{_report_html_escape(_report_status_label(system_overall))}</div></div>
    <div class="card"><div class="label">Calidad de red</div><div class="value">{_report_html_escape(_report_status_label(quality_overall))}</div></div>
    <div class="card"><div class="label">Syncthing nodos</div><div class="value">{syn_nodes_total}</div></div>
    <div class="card"><div class="label">Syncthing avisos</div><div class="value">{syn_nodes_syncing + syn_folders_error + syn_stalled}</div></div>
  </section>

  <h2>Salud del sistema</h2>
  <table>
    <thead><tr><th>Subsistema</th><th>Estado</th><th>Mensaje</th><th>Detalle</th></tr></thead>
    <tbody>{tr_system_health()}</tbody>
  </table>

  <h2>Calidad de red</h2>
  <table>
    <thead><tr><th>Destino</th><th>Host</th><th>Activo</th><th>Estado</th><th class="num">Latencia ms</th><th class="num">Pérdida %</th><th>Último check</th></tr></thead>
    <tbody>{tr_quality_targets()}</tbody>
  </table>

  <h2>Syncthing Control</h2>
  <table>
    <thead><tr><th>Nodo</th><th>Estado relevante</th><th>Versión</th><th class="num">RX B/s</th><th class="num">TX B/s</th><th>Último check</th></tr></thead>
    <tbody>{tr_syncthing_nodes()}</tbody>
  </table>

  <h2>Syncthing · carpetas con actividad o avisos</h2>
  <table>
    <thead><tr><th>Nodo</th><th>Carpeta</th><th>Estado</th><th>Posible atasco</th><th class="num">Pendiente</th><th class="num">Ficheros</th><th class="num">Errores</th></tr></thead>
    <tbody>{tr_syncthing_folders()}</tbody>
  </table>

  <h2>Inventario de hosts</h2>
  <table>
    <thead><tr><th>IP</th><th>MAC</th><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Conocido</th><th>Última vez</th><th class="num">Latencia ms</th></tr></thead>
    <tbody>{tr_hosts()}</tbody>
  </table>

  <h2>Ejecuciones de escaneo del rango</h2>
  <table>
    <thead><tr><th>ID</th><th>Inicio</th><th>Fin</th><th>Rango</th><th class="num">Online</th><th class="num">Offline</th><th class="num">Nuevos</th><th>Error Discord</th></tr></thead>
    <tbody>{tr_scans()}</tbody>
  </table>

  <h2>Servicios monitorizados</h2>
  <table>
    <thead><tr><th>Nombre</th><th>Host</th><th class="num">Puerto</th><th>Protocolo</th><th>Estado</th><th class="num">Latencia ms</th><th>Último check</th><th>Error</th></tr></thead>
    <tbody>{tr_services()}</tbody>
  </table>

  <h2>Uptime del rango</h2>
  <table>
    <thead><tr><th>IP</th><th>Nombre</th><th class="num">Online h</th><th class="num">Offline h</th><th class="num">Uptime %</th></tr></thead>
    <tbody>{tr_uptime()}</tbody>
  </table>
</main>
</body>
</html>"""

    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Content-Disposition": f'inline; filename="auditor_ips_report_{generated_at.strftime("%Y%m%d_%H%M%S")}.html"',
        },
    )


# ═══════════════════════════════════════════════════════════════
#  Export XLSX
# ═══════════════════════════════════════════════════════════════

@router.get("/export.xlsx")
def export_xlsx():
    try:
        from openpyxl import Workbook
        from openpyxl.utils import get_column_letter
    except ImportError:
        return JSONResponse({"ok": False, "error": "openpyxl no instalado"}, status_code=500)

    app_tz = get_app_tz(cfg("app_tz", "Europe/Madrid"))

    with db() as conn:
        host_rows = conn.execute("""
            SELECT h.ip, h.mac, h.nmap_hostname, h.dns_name, h.manual_name, h.notes,
                   COALESCE(t.name,'') AS type_name,
                   h.first_seen, h.last_seen, h.last_change, h.status
            FROM hosts h LEFT JOIN host_types t ON t.id = h.type_id
            ORDER BY h.status DESC, h.last_seen DESC
        """).fetchall()
        scan_rows = conn.execute("""
            SELECT id, started_at, finished_at, cidr, online_hosts, offline_hosts,
                   new_hosts, events_sent, discord_sent, discord_error
            FROM scans ORDER BY id DESC LIMIT 500
        """).fetchall()
        uptime_rows = conn.execute("""
            SELECT ip, date, online_seconds, offline_seconds
            FROM host_uptime ORDER BY ip ASC, date ASC
        """).fetchall()
        svc_rows = conn.execute("""
            SELECT s.name, s.host, s.port, s.protocol, s.service_type,
                   sc.status, sc.latency_ms, sc.checked_at, sc.error
            FROM services s
            LEFT JOIN service_checks sc ON sc.id = (
                SELECT id FROM service_checks WHERE service_id=s.id ORDER BY checked_at DESC LIMIT 1
            )
            ORDER BY s.name
        """).fetchall()

    wb = Workbook()

    # ── Hosts ──────────────────────────────────────────────────
    ws = wb.active
    ws.title = "Hosts"
    hdr = ["IP", "MAC", "Hostname", "DNS", "Nombre manual", "Tipo", "Notas",
           "Primera vez", "Última vez", "Último cambio", "Visto hace", "Estado"]
    ws.append(hdr)
    for r in host_rows:
        ws.append([
            r["ip"], r["mac"] or "", r["nmap_hostname"] or "", r["dns_name"] or "",
            r["manual_name"] or "", r["type_name"] or "", r["notes"] or "",
            to_local_str(r["first_seen"]), to_local_str(r["last_seen"]),
            to_local_str(r["last_change"]), human_since(r["last_seen"]),
            r["status"] or "",
        ])
    for col in range(1, len(hdr) + 1):
        ws.column_dimensions[get_column_letter(col)].width = 20

    # ── Ejecuciones ────────────────────────────────────────────
    ws2 = wb.create_sheet("Ejecuciones")
    hdr2 = ["ID", "Inicio", "Fin", "Rango", "Online", "Offline",
            "Nuevos", "Eventos", "Discord", "Error Discord"]
    ws2.append(hdr2)
    for r in scan_rows:
        ws2.append([
            r["id"], to_local_str(r["started_at"]), to_local_str(r["finished_at"]),
            r["cidr"] or "", r["online_hosts"] or 0, r["offline_hosts"] or 0,
            r["new_hosts"] or 0, r["events_sent"] or 0,
            "SI" if r["discord_sent"] else "NO", r["discord_error"] or "",
        ])
    for col in range(1, len(hdr2) + 1):
        ws2.column_dimensions[get_column_letter(col)].width = 20

    # ── Uptime ─────────────────────────────────────────────────
    ws3 = wb.create_sheet("Uptime")
    hdr3 = ["IP", "Fecha", "Online (h)", "Offline (h)", "Uptime %"]
    ws3.append(hdr3)
    for r in uptime_rows:
        total = r["online_seconds"] + r["offline_seconds"]
        pct   = round(r["online_seconds"] * 100 / total, 1) if total > 0 else ""
        ws3.append([
            r["ip"], r["date"],
            round(r["online_seconds"]  / 3600, 2),
            round(r["offline_seconds"] / 3600, 2),
            pct,
        ])
    for col in range(1, len(hdr3) + 1):
        ws3.column_dimensions[get_column_letter(col)].width = 16

    # ── Servicios ──────────────────────────────────────────────
    ws4 = wb.create_sheet("Servicios")
    hdr4 = ["Nombre", "Host", "Puerto", "Protocolo", "Tipo",
            "Estado", "Latencia (ms)", "Último check", "Error"]
    ws4.append(hdr4)
    for r in svc_rows:
        ws4.append([
            r["name"], r["host"], r["port"], r["protocol"], r["service_type"] or "",
            r["status"] or "", r["latency_ms"] or "",
            to_local_str(r["checked_at"]) if r["checked_at"] else "",
            r["error"] or "",
        ])
    for col in range(1, len(hdr4) + 1):
        ws4.column_dimensions[get_column_letter(col)].width = 18

    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    filename = f"auditor_ips_{datetime.now(app_tz).strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(
        bio,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ═══════════════════════════════════════════════════════════════
#  Exportación programada a Excel
# ═══════════════════════════════════════════════════════════════

def _build_hosts_xlsx(output_dir: str) -> str:
    """
    Genera hosts_network_data--YYYY-MM-DD.xlsx en output_dir.
    Devuelve la ruta completa del fichero generado.
    """
    try:
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter as gcl
        import openpyxl
    except ImportError:
        raise RuntimeError("openpyxl no instalado")

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filename = f"hosts_network_data--{date_str}.xlsx"
    filepath = str(Path(output_dir) / filename)

    with db() as conn:
        # Columnas opcionales: se leen con COALESCE para no fallar si no existen en la BD
        col_info = {row[1] for row in conn.execute("PRAGMA table_info(hosts)").fetchall()}
        _opt = lambda col: f"h.{col}" if col in col_info else f"'' AS {col}"
        query = f"""
            SELECT h.ip, h.mac,
                   {_opt('vendor')},
                   h.nmap_hostname AS hostname, h.manual_name, h.dns_name,
                   h.status,
                   {_opt('known')},
                   COALESCE(t.name,'') AS type_name,
                   h.notes, h.first_seen, h.last_seen,
                   {_opt('open_ports')},
                   {_opt('router_hostname')},
                   {_opt('router_lease_type')},
                   {_opt('tags')}
            FROM hosts h LEFT JOIN host_types t ON t.id = h.type_id
            ORDER BY
                CASE WHEN h.status='online'        THEN 0
                     WHEN h.status='online_silent' THEN 1
                     ELSE 2 END,
                h.ip
        """
        hosts = conn.execute(query).fetchall()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Hosts"
    ws.sheet_view.showGridLines = False

    # Estilos
    HEADER_FILL = PatternFill("solid", fgColor="0F172A")
    ONLINE_FILL = PatternFill("solid", fgColor="14532D")
    SILENT_FILL = PatternFill("solid", fgColor="713F12")
    OFFLIN_FILL = PatternFill("solid", fgColor="3B0764")
    DEFLT_FILL  = PatternFill("solid", fgColor="1E293B")
    WHITE_FONT  = Font(color="FFFFFF", name="Calibri", size=10)
    HEADER_FONT = Font(color="38BDF8", bold=True, name="Calibri", size=10)
    CENTER = Alignment(horizontal="center", vertical="center")
    LEFT   = Alignment(horizontal="left",   vertical="center")
    THIN   = Side(style="thin", color="334155")
    BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

    COLUMNS = [
        ("IP", 14), ("MAC", 18), ("Fabricante", 22), ("Hostname", 22),
        ("Nombre manual", 22), ("DNS", 22), ("Estado", 14), ("Conocido", 9),
        ("Tipo", 16), ("Notas", 30), ("Primera vez", 18), ("Última vez", 18),
        ("Puertos", 28), ("Hostname DHCP", 20), ("Lease tipo", 12), ("Etiquetas", 24),
    ]

    # Fila título
    ws.merge_cells(f"A1:{gcl(len(COLUMNS))}1")
    c = ws["A1"]
    c.value     = f"Auditor IPs — Inventario de hosts  ·  {datetime.now().strftime('%d/%m/%Y %H:%M')}"
    c.font      = Font(color="38BDF8", bold=True, name="Calibri", size=13)
    c.fill      = HEADER_FILL
    c.alignment = CENTER
    ws.row_dimensions[1].height = 24

    # Cabecera
    for ci, (header, width) in enumerate(COLUMNS, 1):
        cell = ws.cell(row=2, column=ci, value=header)
        cell.font = HEADER_FONT; cell.fill = HEADER_FILL
        cell.alignment = CENTER; cell.border = BORDER
        ws.column_dimensions[gcl(ci)].width = width
    ws.row_dimensions[2].height = 18
    ws.freeze_panes = "A3"

    STATUS_FILLS = {"online": ONLINE_FILL, "online_silent": SILENT_FILL, "offline": OFFLIN_FILL}
    STATUS_LABELS = {
        "online": "Online", "online_silent": "Silent",
        "offline": "Offline", "unknown": "Unknown",
    }

    for ri, h in enumerate(hosts, 3):
        status   = h["status"] or "unknown"
        row_fill = STATUS_FILLS.get(status, DEFLT_FILL)
        values   = [
            h["ip"], h["mac"] or "", h["vendor"] or "",
            h["hostname"] or "", h["manual_name"] or "", h["dns_name"] or "",
            STATUS_LABELS.get(status, status),
            "Sí" if h["known"] else "No",
            h["type_name"] or "", h["notes"] or "",
            to_local_str(h["first_seen"]) if h["first_seen"] else "",
            to_local_str(h["last_seen"])  if h["last_seen"]  else "",
            h["open_ports"] or "", h["router_hostname"] or "",
            h["router_lease_type"] or "", h["tags"] or "",
        ]
        WIDE_COLS = {4, 5, 6, 10, 13, 16}
        for ci, value in enumerate(values, 1):
            cell = ws.cell(row=ri, column=ci, value=value)
            cell.fill = row_fill; cell.font = WHITE_FONT
            cell.alignment = LEFT if ci in WIDE_COLS else CENTER
            cell.border = BORDER
        ws.row_dimensions[ri].height = 15

    # Hoja resumen
    ws2 = wb.create_sheet("Resumen")
    ws2.sheet_view.showGridLines = False
    total   = len(hosts)
    online  = sum(1 for h in hosts if h["status"] == "online")
    silent  = sum(1 for h in hosts if h["status"] == "online_silent")
    offline = sum(1 for h in hosts if h["status"] == "offline")
    known   = sum(1 for h in hosts if h["known"])
    for ri, (k, v) in enumerate([
        ("Generado el",  datetime.now().strftime("%d/%m/%Y %H:%M")),
        ("", ""),
        ("Total hosts",  total),   ("Online",       online),
        ("Silent",       silent),  ("Offline",      offline),
        ("Conocidos",    known),   ("Desconocidos", total - known),
    ], 1):
        ck = ws2.cell(row=ri, column=1, value=k)
        cv = ws2.cell(row=ri, column=2, value=v)
        ck.font = Font(color="38BDF8", bold=True, name="Calibri", size=10)
        cv.font = Font(color="FFFFFF", name="Calibri", size=10)
        ck.fill = cv.fill = HEADER_FILL
        ck.alignment = cv.alignment = LEFT
    ws2.column_dimensions["A"].width = 18
    ws2.column_dimensions["B"].width = 22
    wb.active = ws

    wb.save(filepath)

    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                     ("export_xlsx_last_run", datetime.now().isoformat()))
        conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                     ("export_xlsx_last_file", filename))

    print(f"[export] Generado: {filepath} ({len(hosts)} hosts)")
    return filepath


def _reschedule_export():
    """Registra o actualiza el job de exportación según la configuración actual."""
    sched = _get_scheduler()
    if sched is None:
        return

    JOB_ID = "export_xlsx_job"
    try:
        sched.remove_job(JOB_ID)
    except Exception:
        pass

    with db() as conn:
        def _s(k, d=""):
            r = conn.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
            return r["value"] if r else d
        enabled   = _s("export_xlsx_enabled",  "0") == "1"
        out_path  = _s("export_xlsx_path",      "/data/exports")
        frequency = _s("export_xlsx_frequency", "weekly")
        day       = int(_s("export_xlsx_day",   "0"))
        hour      = int(_s("export_xlsx_hour",  "6"))

    if not enabled:
        return

    def _job():
        try:
            _build_hosts_xlsx(out_path)
        except Exception as e:
            print(f"[export] Error en exportación programada: {e}")

    DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    if frequency == "daily":
        sched.add_job(_job, "cron", hour=hour, minute=0,
                      id=JOB_ID, replace_existing=True)
        print(f"[export] Job diario a las {hour:02d}:00")
    elif frequency == "weekly":
        sched.add_job(_job, "cron", day_of_week=day, hour=hour, minute=0,
                      id=JOB_ID, replace_existing=True)
        print(f"[export] Job semanal: {DIAS[day]} a las {hour:02d}:00")
    elif frequency == "monthly":
        sched.add_job(_job, "cron", day=day, hour=hour, minute=0,
                      id=JOB_ID, replace_existing=True)
        print(f"[export] Job mensual: día {day} a las {hour:02d}:00")


# Alias público por si main.py lo llama directamente
reschedule_export = _reschedule_export


@router.get("/api/export/xlsx/config")
def get_export_config():
    with db() as conn:
        def _s(k, d=""):
            r = conn.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
            return r["value"] if r else d
        return {
            "enabled":   _s("export_xlsx_enabled",  "0") == "1",
            "path":      _s("export_xlsx_path",      "/data/exports"),
            "frequency": _s("export_xlsx_frequency", "weekly"),
            "day":       int(_s("export_xlsx_day",   "0")),
            "hour":      int(_s("export_xlsx_hour",  "6")),
            "last_run":  _s("export_xlsx_last_run",  ""),
            "last_file": _s("export_xlsx_last_file", ""),
        }


@router.put("/api/export/xlsx/config")
def save_export_config(payload: Dict[str, Any] = Body(...)):
    freq = payload.get("frequency", "weekly")
    if freq not in {"daily", "weekly", "monthly"}:
        return JSONResponse(status_code=400, content={"error": "Frecuencia inválida"})
    hour = int(payload.get("hour", 6))
    day  = int(payload.get("day",  0))
    if not (0 <= hour <= 23):
        return JSONResponse(status_code=400, content={"error": "Hora fuera de rango (0-23)"})

    with db() as conn:
        for k, v in [
            ("export_xlsx_enabled",   "1" if payload.get("enabled") else "0"),
            ("export_xlsx_path",      str(payload.get("path", "/data/exports")).strip()),
            ("export_xlsx_frequency", freq),
            ("export_xlsx_day",       str(day)),
            ("export_xlsx_hour",      str(hour)),
        ]:
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, v))

    _reschedule_export()
    return {"ok": True}


@router.post("/api/export/xlsx/now")
def export_xlsx_now():
    with db() as conn:
        r = conn.execute("SELECT value FROM settings WHERE key='export_xlsx_path'").fetchone()
        out_path = r["value"] if r else "/data/exports"
    try:
        filepath = _build_hosts_xlsx(out_path)
        return {"ok": True, "file": Path(filepath).name, "path": filepath}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ═══════════════════════════════════════════════════════════════
#  Config Procesos — Scripts monitorizados (S17)
# ═══════════════════════════════════════════════════════════════

SCRIPTS_STATUS_DIR: str = os.getenv("SCRIPTS_STATUS_DIR", "/data/scripts_status")

def _validate_script_cron_expr(expr: str) -> tuple[bool, str]:
    """
    Valida cron clásico de 5 campos usado solo para calcular próxima ejecución.
    No modifica el crontab real del servidor.
    """
    expr = (expr or "").strip()
    if not expr:
        return True, ""

    parts = expr.split()
    if len(parts) != 5:
        return False, "Cron inválido: debe tener 5 campos, ejemplo: 35 * * * *"

    ranges = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]

    for field, (lo, hi) in zip(parts, ranges):
        if not re.fullmatch(r"[0-9*/,\-]+", field):
            return False, f"Campo cron inválido: {field}"

        for raw_part in field.split(","):
            part = raw_part.strip()
            if not part:
                return False, "Cron inválido: campo vacío"

            if "/" in part:
                base, step = part.split("/", 1)
                if not step.isdigit() or int(step) <= 0:
                    return False, f"Step cron inválido: {part}"
            else:
                base = part

            if base in ("", "*"):
                continue

            if "-" in base:
                a, b = base.split("-", 1)
                if not (a.isdigit() and b.isdigit()):
                    return False, f"Rango cron inválido: {part}"
                a, b = int(a), int(b)
                if a > b or a < lo or b > hi:
                    return False, f"Rango cron fuera de límites: {part}"
            else:
                if not base.isdigit():
                    return False, f"Valor cron inválido: {part}"
                v = int(base)
                if v < lo or v > hi:
                    return False, f"Valor cron fuera de límites: {part}"

    return True, ""



@router.get("/api/config/scripts/available")
def api_scripts_available():
    """Lista los .status.json disponibles en el volumen (para autocompletar al añadir)."""
    try:
        if not os.path.isdir(SCRIPTS_STATUS_DIR):
            return {"ok": True, "files": []}
        files = sorted([
            f.replace(".status.json", "")
            for f in os.listdir(SCRIPTS_STATUS_DIR)
            if f.endswith(".status.json")
        ])
        return {"ok": True, "files": files}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.get("/api/config/scripts")
def api_scripts_list():
    """Lista los scripts monitorizados configurados en BD."""
    with db() as conn:
        rows = conn.execute(
            "SELECT id, script_name, label, description, color, active, sort_order, created_at, "
            "COALESCE(cron_expr, '') AS cron_expr, COALESCE(cron_source, '') AS cron_source, "
            "COALESCE(host_name, 'Local') AS host_name, COALESCE(host_source, 'local_status_dir') AS host_source "
            "FROM monitored_scripts ORDER BY sort_order ASC, id ASC"
        ).fetchall()
    return {"ok": True, "scripts": [dict(r) for r in rows]}


@router.post("/api/config/scripts")
def api_scripts_create(payload: Dict[str, Any] = Body(...)):
    """Añade un nuevo script monitorizado."""
    script_name = (payload.get("script_name") or "").strip()
    if not script_name:
        return JSONResponse(status_code=400, content={"ok": False, "error": "script_name requerido"})
    label       = (payload.get("label") or "").strip()
    description = (payload.get("description") or "").strip()
    color       = (payload.get("color") or "").strip()
    active      = int(payload.get("active", 1))
    sort_order  = int(payload.get("sort_order", 0))
    cron_expr   = (payload.get("cron_expr") or "").strip()
    cron_source = (payload.get("cron_source") or "").strip()
    host_name   = (payload.get("host_name") or "Local").strip()
    host_source = (payload.get("host_source") or "local_status_dir").strip()
    cron_ok, cron_error = _validate_script_cron_expr(cron_expr)
    if not cron_ok:
        return JSONResponse(status_code=400, content={"ok": False, "error": cron_error})
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO monitored_scripts "
                "(script_name, label, description, color, active, sort_order, created_at, cron_expr, cron_source, host_name, host_source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (script_name, label, description, color, active, sort_order, utc_now_iso(), cron_expr, cron_source, host_name, host_source)
            )
            new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"ok": True, "id": new_id}
    except Exception as e:
        if "UNIQUE" in str(e):
            return JSONResponse(status_code=409, content={"ok": False, "error": f"'{script_name}' ya existe"})
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.put("/api/config/scripts/{script_id}")
def api_scripts_update(script_id: int, payload: Dict[str, Any] = Body(...)):
    """Actualiza un script monitorizado."""
    with db() as conn:
        row = conn.execute("SELECT id FROM monitored_scripts WHERE id=?", (script_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"ok": False, "error": "No encontrado"})
        if "cron_expr" in payload:
            cron_ok, cron_error = _validate_script_cron_expr(str(payload.get("cron_expr") or ""))
            if not cron_ok:
                return JSONResponse(status_code=400, content={"ok": False, "error": cron_error})

        fields, vals = [], []
        for col in ("script_name", "label", "description", "color", "sort_order", "cron_expr", "cron_source", "host_name", "host_source"):
            if col in payload:
                fields.append(f"{col}=?")
                vals.append((payload[col] or "").strip() if isinstance(payload[col], str) else payload[col])
        if "active" in payload:
            fields.append("active=?")
            vals.append(int(payload["active"]))
        if not fields:
            return {"ok": True, "updated": 0}
        vals.append(script_id)
        conn.execute(f"UPDATE monitored_scripts SET {', '.join(fields)} WHERE id=?", vals)
    return {"ok": True}


@router.delete("/api/config/scripts/{script_id}")
def api_scripts_delete(script_id: int):
    """Elimina un script monitorizado."""
    with db() as conn:
        cur = conn.execute("DELETE FROM monitored_scripts WHERE id=?", (script_id,))
    if cur.rowcount == 0:
        return JSONResponse(status_code=404, content={"ok": False, "error": "No encontrado"})
    return {"ok": True}


@router.post("/api/config/scripts/reorder")
def api_scripts_reorder(payload: Dict[str, Any] = Body(...)):
    """Actualiza sort_order de varios scripts de una vez. payload: {ids: [1,3,2,...]}"""
    ids = payload.get("ids") or []
    with db() as conn:
        for order, sid in enumerate(ids):
            conn.execute("UPDATE monitored_scripts SET sort_order=? WHERE id=?", (order, sid))
    return {"ok": True}


@router.post("/api/config/scripts/import-all")
def api_scripts_import_all():
    """
    Importa todos los .status.json del volumen a monitored_scripts (INSERT OR IGNORE).
    Devuelve cuántos se añadieron y cuántos ya existían.
    """
    try:
        if not os.path.isdir(SCRIPTS_STATUS_DIR):
            return JSONResponse(status_code=404, content={"ok": False, "error": "Directorio no encontrado"})
        files = sorted([
            f.replace(".status.json", "")
            for f in os.listdir(SCRIPTS_STATUS_DIR)
            if f.endswith(".status.json")
        ])
        added, skipped = 0, 0
        with db() as conn:
            existing = {r[0] for r in conn.execute("SELECT script_name FROM monitored_scripts").fetchall()}
            for i, name in enumerate(files):
                if name in existing:
                    skipped += 1
                    continue
                label = name.replace("_", " ").title()
                conn.execute(
                    "INSERT OR IGNORE INTO monitored_scripts "
                    "(script_name, label, description, color, active, sort_order, created_at, cron_expr, cron_source, host_name, host_source) "
                    "VALUES (?, ?, ?, ?, 1, ?, ?, '', '', ?, ?)",
                    (name, label, "", "", i, utc_now_iso(), "Local", "local_status_dir")
                )
                added += 1
        return {"ok": True, "added": added, "skipped": skipped, "total": len(files)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


# ═══════════════════════════════════════════════════════════════
#  Redes secundarias (Config → Redes — Sesión 21)
# ═══════════════════════════════════════════════════════════════

@router.get("/api/config/networks")
def api_networks_list():
    """Lista las redes secundarias configuradas."""
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, cidr, interface, enabled, created_at "
            "FROM secondary_networks ORDER BY id ASC"
        ).fetchall()
    return {"ok": True, "networks": [dict(r) for r in rows]}


@router.post("/api/config/networks")
def api_networks_create(payload: Dict[str, Any] = Body(...)):
    """Añade una red secundaria."""
    cidr      = (payload.get("cidr") or "").strip()
    label     = (payload.get("label") or "").strip()
    interface = (payload.get("interface") or "").strip()
    enabled   = int(payload.get("enabled", 1))
    if not cidr:
        return JSONResponse(status_code=400, content={"ok": False, "error": "cidr requerido"})
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO secondary_networks (label, cidr, interface, enabled, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (label, cidr, interface, enabled, utc_now_iso())
            )
            new_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"ok": True, "id": new_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.put("/api/config/networks/{net_id}")
def api_networks_update(net_id: int, payload: Dict[str, Any] = Body(...)):
    """Actualiza una red secundaria."""
    with db() as conn:
        row = conn.execute("SELECT id FROM secondary_networks WHERE id=?", (net_id,)).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"ok": False, "error": "No encontrado"})
        fields, vals = [], []
        for col in ("label", "cidr", "interface"):
            if col in payload:
                fields.append(f"{col}=?")
                vals.append((payload[col] or "").strip())
        if "enabled" in payload:
            fields.append("enabled=?")
            vals.append(int(payload["enabled"]))
        if not fields:
            return {"ok": True, "updated": 0}
        vals.append(net_id)
        conn.execute(f"UPDATE secondary_networks SET {', '.join(fields)} WHERE id=?", vals)
    return {"ok": True}


@router.delete("/api/config/networks/{net_id}")
def api_networks_delete(net_id: int):
    """Elimina una red secundaria."""
    with db() as conn:
        cur = conn.execute("DELETE FROM secondary_networks WHERE id=?", (net_id,))
    if cur.rowcount == 0:
        return JSONResponse(status_code=404, content={"ok": False, "error": "No encontrado"})
    return {"ok": True}


@router.get("/api/config/network/interfaces")
def api_network_interfaces():
    """
    Detecta las interfaces de red activas del host con su IP y CIDR.
    Usa 'ip -j addr' (formato JSON del sistema) disponible en cualquier Linux moderno.
    """
    import subprocess, json as _json
    try:
        out = subprocess.run(
            ["ip", "-j", "addr"],
            capture_output=True, text=True, timeout=5
        )
        ifaces = _json.loads(out.stdout)
        result = []
        for iface in ifaces:
            name = iface.get("ifname", "")
            if not name or name == "lo" or name.startswith(("docker", "br-", "veth", "virbr")):
                continue
            operstate = (iface.get("operstate") or "").upper()
            flags = iface.get("flags", [])
            is_up = operstate == "UP" or "UP" in flags
            addrs = []
            for addr in iface.get("addr_info", []):
                if addr.get("family") == "inet":   # solo IPv4
                    addrs.append(f"{addr['local']}/{addr['prefixlen']}")
            if not is_up and not addrs:
                continue
            result.append({
                "name":    name,
                "state":   iface.get("operstate", "UNKNOWN"),
                "mac":     iface.get("address", ""),
                "addrs":   addrs,
            })
        return {"ok": True, "interfaces": result}
    except Exception as e:
        return {"ok": False, "interfaces": [], "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  Archivos estáticos PWA
# ═══════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════
#  Discrepancias nmap / router
# ═══════════════════════════════════════════════════════════════

@router.get("/api/scan/discrepancies")
def api_discrepancies_list():
    """Lista de IPs vistas por nmap pero no por el router."""
    try:
        with db() as conn:
            rows = conn.execute("""
                SELECT d.id, d.ip, d.mac, d.first_seen, d.last_seen, d.times_seen,
                       d.accepted, d.accepted_at, d.note,
                       h.manual_name, h.nmap_hostname, h.router_hostname, h.vendor
                FROM scan_discrepancies d
                LEFT JOIN hosts h ON h.ip = d.ip
                ORDER BY d.accepted ASC, d.times_seen DESC
            """).fetchall()
        return {"ok": True, "discrepancies": [dict(r) for r in rows]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/api/scan/discrepancies/{disc_id}/accept")
def api_discrepancy_accept(disc_id: int, payload: Dict[str, Any] = Body(default={})):
    """Marca una discrepancia como aceptada."""
    note = (payload.get("note") or "").strip()
    try:
        with db() as conn:
            conn.execute("""
                UPDATE scan_discrepancies
                SET accepted=1, accepted_at=?, note=?
                WHERE id=?
            """, (utc_now_iso(), note or None, disc_id))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.delete("/api/scan/discrepancies/{disc_id}")
def api_discrepancy_delete(disc_id: int):
    """Elimina una discrepancia."""
    try:
        with db() as conn:
            conn.execute("DELETE FROM scan_discrepancies WHERE id=?", (disc_id,))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/api/scan/discrepancies/accept-all")
def api_discrepancy_accept_all():
    """Acepta todas las discrepancias pendientes."""
    try:
        now = utc_now_iso()
        with db() as conn:
            conn.execute("UPDATE scan_discrepancies SET accepted=1, accepted_at=? WHERE accepted=0", (now,))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════
#  Documentación integrada (README / Roadmap / guías)
# ═══════════════════════════════════════════════════════════════

# Rutas donde buscar los ficheros de documentación
_DOC_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

_DOC_SEARCH_DIRS = [
    "/DOC_ONLINE",
    os.path.join(_DOC_ROOT, "DOC_ONLINE"),
    "/Documentacion",
    "/app/Documentacion",
    os.path.join(_DOC_ROOT, "Documentacion"),
    "/data/DOC_ONLINE",
    "/data/auditor_docs",
]

_DOC_FILES = {
    "readme":     ["README.md", "readme.md"],
    "roadmap":    ["ROADMAP_Auditor_IPs.txt", "ROADMAP.md", "roadmap.md"],
    "estado":     ["ESTADO_ACTUAL_Auditor_IPs.txt"],
    "indice":     ["INDICE_Auditor_IPs.txt"],
    "prompt":     ["PROMPT_Auditor_IPs.txt"],
    "checklist":  ["CHECKLIST_CIERRE_BLOQUE.md"],
    "decisiones": ["DECISIONES_Y_ERRORES.md"],
    "redes":      ["configuracion_redes.md", "redes.md"],
}


def _find_doc(name: str) -> Optional[str]:
    """Busca el fichero de documentación por nombre canónico. Devuelve la ruta o None."""
    candidates = _DOC_FILES.get(name, [f"{name}.md", name])
    for d in _DOC_SEARCH_DIRS:
        for fname in candidates:
            p = os.path.join(d, fname)
            if os.path.isfile(p):
                return p
    return None


@router.get("/api/docs/{doc_name}")
def api_get_doc(doc_name: str):
    """
    Devuelve el contenido de un fichero de documentación en formato Markdown.
    doc_name: readme | roadmap | redes (o cualquier nombre sin extensión)
    """
    # Seguridad: solo nombres de fichero simples, sin slashes
    if "/" in doc_name or "\\" in doc_name or ".." in doc_name:
        return JSONResponse({"ok": False, "error": "Nombre inválido"}, status_code=400)

    path = _find_doc(doc_name)
    if not path:
        return JSONResponse({"ok": False, "error": f"Documento '{doc_name}' no encontrado"}, status_code=404)

    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"ok": True, "name": doc_name, "content": content, "path": path}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/docs")
def api_list_docs():
    """Lista los documentos disponibles."""
    docs = []
    for name, candidates in _DOC_FILES.items():
        path = _find_doc(name)
        if path:
            size = os.path.getsize(path)
            docs.append({"name": name, "filename": os.path.basename(path), "size": size})
    return {"ok": True, "docs": docs}


@router.get("/manifest.json")
def serve_manifest():
    return FileResponse(
        "manifest.json",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@router.get("/sw.js")
def serve_sw():
    return FileResponse(
        "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


# ══════════════════════════════════════════════════════════════
#  Exportación histórica por rango de fechas (Sesión 24)
# ══════════════════════════════════════════════════════════════

@router.get("/api/export/history")
def api_export_history(date_from: str = "", date_to: str = ""):
    """
    Genera y descarga un Excel con tres hojas:
      - Uptime        (host_uptime por día)
      - Latencia      (host_latency, muestra reducida por host/día)
      - Servicios     (service_checks)
    Parámetros: date_from y date_to en formato YYYY-MM-DD.
    Si se omiten, devuelve los últimos 30 días.
    """
    from datetime import datetime, timedelta
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        return JSONResponse({"error": "openpyxl no instalado"}, status_code=500)

    # ── Calcular rango ────────────────────────────────────────
    try:
        dt_from = datetime.strptime(date_from, "%Y-%m-%d") if date_from else datetime.utcnow() - timedelta(days=30)
        dt_to   = datetime.strptime(date_to,   "%Y-%m-%d") if date_to   else datetime.utcnow()
    except ValueError:
        return JSONResponse({"error": "Formato de fecha inválido. Usa YYYY-MM-DD"}, status_code=400)

    str_from = dt_from.strftime("%Y-%m-%d")
    str_to   = dt_to.strftime("%Y-%m-%d")
    # Para latencia y servicios (ISO timestamps) necesitamos el límite superior al final del día
    iso_to   = dt_to.strftime("%Y-%m-%d") + "T23:59:59"
    iso_from = dt_from.strftime("%Y-%m-%d") + "T00:00:00"

    # ── Estilos comunes ────────────────────────────────────────
    HDR_FILL  = PatternFill("solid", fgColor="0F172A")
    ROW_FILL  = PatternFill("solid", fgColor="1E293B")
    ALT_FILL  = PatternFill("solid", fgColor="172033")
    HDR_FONT  = Font(color="38BDF8", bold=True, name="Calibri", size=10)
    ROW_FONT  = Font(color="FFFFFF", name="Calibri", size=10)
    CENTER    = Alignment(horizontal="center", vertical="center")
    LEFT      = Alignment(horizontal="left",   vertical="center")
    THIN      = Side(style="thin", color="334155")
    BORDER    = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

    def _title_row(ws, text, ncols):
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
        c = ws.cell(row=1, column=1, value=text)
        c.font = Font(color="38BDF8", bold=True, name="Calibri", size=12)
        c.fill = HDR_FILL
        c.alignment = CENTER
        ws.row_dimensions[1].height = 22

    def _header_row(ws, cols, row=2):
        for i, (label, width) in enumerate(cols, start=1):
            c = ws.cell(row=row, column=i, value=label)
            c.font = HDR_FONT; c.fill = HDR_FILL
            c.alignment = CENTER; c.border = BORDER
            ws.column_dimensions[get_column_letter(i)].width = width
        ws.row_dimensions[row].height = 16
        ws.freeze_panes = ws.cell(row=3, column=1)

    def _data_row(ws, row_idx, values, aligns=None):
        fill = ROW_FILL if row_idx % 2 == 1 else ALT_FILL
        for i, v in enumerate(values, start=1):
            c = ws.cell(row=row_idx, column=i, value=v)
            c.font = ROW_FONT; c.fill = fill
            c.alignment = (aligns[i-1] if aligns else CENTER)
            c.border = BORDER
        ws.row_dimensions[row_idx].height = 14

    wb = Workbook()

    # ══ Hoja 1: Uptime ════════════════════════════════════════
    ws1 = wb.active
    ws1.title = "Uptime"
    ws1.sheet_view.showGridLines = False

    with db() as conn:
        uptime_rows = conn.execute("""
            SELECT u.ip, COALESCE(h.manual_name, h.nmap_hostname, h.dns_name, u.ip) as name,
                   u.date, u.online_seconds, u.offline_seconds
            FROM host_uptime u
            LEFT JOIN hosts h ON h.ip = u.ip
            WHERE u.date BETWEEN ? AND ?
            ORDER BY u.ip, u.date
        """, (str_from, str_to)).fetchall()

    UCOLS = [("IP",14),("Nombre",22),("Fecha",12),("Online (s)",12),("Offline (s)",12),
             ("Online %",10),("Online (h:m)",12)]
    _title_row(ws1, f"Uptime  ·  {str_from} → {str_to}  ·  {len(uptime_rows)} registros", len(UCOLS))
    _header_row(ws1, UCOLS)
    for idx, r in enumerate(uptime_rows, start=1):
        total = (r["online_seconds"] or 0) + (r["offline_seconds"] or 0)
        pct   = round(r["online_seconds"] * 100 / total, 1) if total > 0 else 0
        secs  = r["online_seconds"] or 0
        hm    = f"{secs//3600}h {(secs%3600)//60}m"
        _data_row(ws1, idx+2,
                  [r["ip"], r["name"], r["date"],
                   r["online_seconds"], r["offline_seconds"], pct, hm],
                  [CENTER,LEFT,CENTER,CENTER,CENTER,CENTER,CENTER])

    # ══ Hoja 2: Latencia ══════════════════════════════════════
    ws2 = wb.create_sheet("Latencia")
    ws2.sheet_view.showGridLines = False

    with db() as conn:
        # Muestra reducida: promedio/min/max por host y hora para no generar ficheros enormes
        lat_rows = conn.execute("""
            SELECT l.ip, COALESCE(h.manual_name, h.nmap_hostname, h.dns_name, l.ip) as name,
                   strftime('%Y-%m-%d %H:00', l.scanned_at) as hour_bucket,
                   COUNT(*) as samples,
                   ROUND(AVG(l.latency_ms),1) as avg_ms,
                   ROUND(MIN(l.latency_ms),1) as min_ms,
                   ROUND(MAX(l.latency_ms),1) as max_ms
            FROM host_latency l
            LEFT JOIN hosts h ON h.ip = l.ip
            WHERE l.scanned_at BETWEEN ? AND ?
              AND l.latency_ms IS NOT NULL
            GROUP BY l.ip, hour_bucket
            ORDER BY l.ip, hour_bucket
        """, (iso_from, iso_to)).fetchall()

    LCOLS = [("IP",14),("Nombre",22),("Hora",18),("Muestras",10),
             ("Avg ms",10),("Min ms",10),("Max ms",10)]
    _title_row(ws2, f"Latencia (agrupada por hora)  ·  {str_from} → {str_to}  ·  {len(lat_rows)} registros", len(LCOLS))
    _header_row(ws2, LCOLS)
    for idx, r in enumerate(lat_rows, start=1):
        _data_row(ws2, idx+2,
                  [r["ip"], r["name"], r["hour_bucket"],
                   r["samples"], r["avg_ms"], r["min_ms"], r["max_ms"]],
                  [CENTER,LEFT,CENTER,CENTER,CENTER,CENTER,CENTER])

    # ══ Hoja 3: Servicios ═════════════════════════════════════
    ws3 = wb.create_sheet("Servicios")
    ws3.sheet_view.showGridLines = False

    with db() as conn:
        svc_rows = conn.execute("""
            SELECT s.name as svc_name, s.host, s.port, s.protocol,
                   sc.checked_at, sc.status, sc.latency_ms, sc.error
            FROM service_checks sc
            JOIN services s ON s.id = sc.service_id
            WHERE sc.checked_at BETWEEN ? AND ?
            ORDER BY s.name, sc.checked_at DESC
        """, (iso_from, iso_to)).fetchall()

    SCOLS = [("Servicio",20),("Host",18),("Puerto",8),("Protocolo",10),
             ("Comprobado",18),("Estado",10),("Latencia ms",12),("Error",40)]
    _title_row(ws3, f"Servicios  ·  {str_from} → {str_to}  ·  {len(svc_rows)} registros", len(SCOLS))
    _header_row(ws3, SCOLS)
    for idx, r in enumerate(svc_rows, start=1):
        _data_row(ws3, idx+2,
                  [r["svc_name"], r["host"], r["port"], r["protocol"],
                   r["checked_at"], r["status"], r["latency_ms"], r["error"] or ""],
                  [LEFT,LEFT,CENTER,CENTER,CENTER,CENTER,CENTER,LEFT])

    # ══ Generar en memoria y devolver como descarga ════════════
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    fname = f"auditor_historico_{str_from}_{str_to}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
