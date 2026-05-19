"""
config.py — Auditor IPs
Settings runtime-mutables cargados desde la BD y sobreescritos por .env.
Rate limiter en memoria para el endpoint de login.

Los routers importan: cfg(), save_setting(), load_settings(), login_rate_limiter
"""

import json
import os
import threading
import time
from collections import defaultdict
from typing import Any, Dict, List

# ══════════════════════════════════════════════════════════════
#  Variables de entorno (valores por defecto)
# ══════════════════════════════════════════════════════════════

DB_PATH               = os.getenv("DB_PATH",               "/data/auditor.db")
SCAN_CIDR             = os.getenv("SCAN_CIDR",             "192.168.1.0/24")
SCAN_INTERVAL_SECONDS = int(os.getenv("SCAN_INTERVAL_SECONDS", "900"))
DNS_SERVER            = os.getenv("DNS_SERVER",            "").strip()

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
NOTIFY_NEW          = os.getenv("NOTIFY_NEW",    "1").strip() == "1"
NOTIFY_ONLINE       = os.getenv("NOTIFY_ONLINE", "0").strip() == "1"
NOTIFY_OFFLINE      = os.getenv("NOTIFY_OFFLINE","0").strip() == "1"
NOTIFY_MAC_CHANGE   = os.getenv("NOTIFY_MAC_CHANGE","0").strip() == "1"

RETENTION_DAYS = int(os.getenv("SCAN_RETENTION_DAYS", "14"))
WOL_PORT       = int(os.getenv("WOL_PORT", "9"))
WOL_BROADCAST  = os.getenv("WOL_BROADCAST", "").strip()

ROUTER_SSH_HOST = os.getenv("ROUTER_SSH_HOST", "192.168.1.1").strip()
ROUTER_SSH_PORT = int(os.getenv("ROUTER_SSH_PORT", "22"))
ROUTER_SSH_USER = os.getenv("ROUTER_SSH_USER", "").strip()
ROUTER_SSH_KEY  = os.getenv("ROUTER_SSH_KEY",  "").strip()


# ══════════════════════════════════════════════════════════════
#  Settings runtime (_cfg)
# ══════════════════════════════════════════════════════════════

_cfg: Dict[str, Any] = {}
_cfg_lock = threading.Lock()

# Módulos opcionales gobernables por instalador/configuración.
# Default conservador: todo activo para no cambiar comportamiento existente.
OPTIONAL_MODULE_DEFAULTS: Dict[str, bool] = {
    "services": True,
    "automation": True,
    "agents": True,
    "syncthing": True,
    "quality": True,
    "notifications": True,
    "ai": True,
    "exports": True,
}


def cfg_defaults() -> Dict[str, Any]:
    """Valores por defecto derivados de variables de entorno."""
    return {
        "scan_cidr":           SCAN_CIDR,
        "scan_interval":       str(SCAN_INTERVAL_SECONDS),
        "dns_server":          DNS_SERVER,
        "discord_webhook":     DISCORD_WEBHOOK_URL,
        "discord_webhook_info": "",
        "discord_webhook_alerts": "",
        "discord_info_fallback_to_alerts": "1",
        "notify_new":          "1" if NOTIFY_NEW else "0",
        "notify_online":       "1" if NOTIFY_ONLINE else "0",
        "notify_offline":      "1" if NOTIFY_OFFLINE else "0",
        "notify_mac_change":   "1" if NOTIFY_MAC_CHANGE else "0",
        "notify_service_down": "1",
        "notify_syncthing_stalled": "0",
        "notify_quality_degraded": "1",
        "notify_script_alerts": "1",
        "push_new":            "1",
        "push_offline":        "1",
        "push_online":         "0",
        "push_service_down":   "1",
        "push_mac_change":     "1",
        "retention_days":      str(RETENTION_DAYS),
        "retention_module_days": "",
        "wol_port":            str(WOL_PORT),
        "wol_broadcast":       WOL_BROADCAST,
        "app_tz":              "Europe/Madrid",
        "theme":               "dark",
        "page_title":          "Auditor IPs",
        "accent_color":        "#4dffb5",
        "accent_color2":       "#375a7f",
        "vapid_public_key":    "",
        "backup_enabled":      "1",
        "backup_keep":         "7",
        # Frontend refresh
        "frontend_refresh_interval_seconds": "30",
        "frontend_dashboard_refresh_interval_seconds": "60",
        # Frontend data limits
        "frontend_history_limit": "5000",
        "frontend_detail_history_limit": "20000",
        "frontend_table_rows_limit": "2000",
        "frontend_export_rows_limit": "5000",
        # Operational timeouts
        "service_check_timeout_seconds": "8",
        "service_info_timeout_seconds": "6",
        "script_ai_cloud_timeout_seconds": "30",
        "script_ai_local_timeout_seconds": "180",
        "script_ai_frontend_timeout_seconds": "135",
        "script_report_timeout_seconds": "120",
        "script_alert_check_interval_seconds": "60",
        "wol_tracker_timeout_seconds": "120",
        # Syncthing Control
        "syncthing_refresh_interval_seconds": "60",
        "syncthing_snapshot_retention_days": "14",
        "syncthing_stalled_threshold_minutes": "60",
        "syncthing_stalled_alert_cooldown_minutes": "120",
        "syncthing_alert_persistence_minutes": "20",
        "syncthing_store_file_names": "0",
        "syncthing_file_name_retention_days": "7",
        # Router SSH
        "router_enabled":      "0",
        "router_ssh_host":     ROUTER_SSH_HOST,
        "router_ssh_port":     str(ROUTER_SSH_PORT),
        "router_ssh_user":     ROUTER_SSH_USER,
        "router_ssh_key":      ROUTER_SSH_KEY,
        # Auth
        "auth_sections":       "config,alertas",
        "initial_setup_wizard_completed": "0",
        "initial_setup_wizard_completed_at": "",
        "initial_setup_wizard_version": "2",
        # Pestañas ocultas legacy (csv de tab IDs: services,quality,groups,alerts,scripts)
        "hidden_tabs":         "",
        # Módulos opcionales habilitados/deshabilitados por instalador/configuración.
        # JSON object. Vacío o ausente equivale a todos activos.
        "enabled_modules":     json.dumps(OPTIONAL_MODULE_DEFAULTS, sort_keys=True),
        # Idioma de la interfaz
        "ui_lang":             "es",
        # WoL sin autenticación
        "wol_public":          "0",
        # SMTP email
        "smtp_enabled":        "0",
        "smtp_host":           "",
        "smtp_port":           "587",
        "smtp_tls":            "starttls",
        "smtp_user":           "",
        "smtp_pass":           "",
        "smtp_to":             "",
        "smtp_from":           "",
        # IA local / cloud
        "ai_provider":         os.getenv("AI_PROVIDER",    "gemini"),
        "ai_gemini_key":       os.getenv("GEMINI_API_KEY", ""),
        "ai_gemini_model":     os.getenv("GEMINI_MODEL",   "gemini-2.0-flash"),
        "ai_mistral_key":      os.getenv("MISTRAL_API_KEY", ""),
        "ai_mistral_model":    os.getenv("MISTRAL_MODEL",  "mistral-small-latest"),
        "automation_agent_token": os.getenv("AUTOMATION_AGENT_TOKEN", ""),
        "ai_ollama_url":       os.getenv("OLLAMA_URL",     "http://localhost:11434"),
        "ai_ollama_model":     os.getenv("OLLAMA_MODEL",   "gemma2:2b"),
        # Scan extras
        "scan_on_boot":        "0",
        "primary_net_interface": "",
        "primary_net_label":   "",
        # Notificaciones email por evento
        "notify_email":        "0",
        "email_new":           "0",
        "email_online":        "0",
        "email_offline":       "0",
        "email_mac_change":    "0",
        "email_service_down":  "0",
        "email_syncthing_stalled": "0",
        "email_quality_degraded": "0",
        "email_script_alerts": "1",
    }


def optional_module_defaults() -> Dict[str, bool]:
    """Devuelve el catálogo de módulos opcionales y su estado por defecto."""
    return dict(OPTIONAL_MODULE_DEFAULTS)


def _boolish_module_value(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    raw = str(value).strip().lower()
    if raw in {"1", "true", "yes", "on", "enabled", "activo", "activa"}:
        return True
    if raw in {"0", "false", "no", "off", "disabled", "deshabilitado", "deshabilitada"}:
        return False
    return default


def enabled_modules_map() -> Dict[str, bool]:
    """
    Lee el setting enabled_modules.

    Formato recomendado:
        {"services": true, "automation": false, ...}

    Compatibilidad defensiva:
    - vacío/ausente: todos los módulos opcionales activos;
    - lista JSON: se interpreta como lista de módulos activos;
    - CSV: se interpreta como lista de módulos activos.
    """
    values = optional_module_defaults()

    # Evita depender de la BD cuando el helper se usa en pruebas unitarias,
    # scripts auxiliares o fases muy tempranas de arranque. En runtime normal,
    # load_settings() ya habrá poblado _cfg con el valor persistido.
    with _cfg_lock:
        raw_value = _cfg.get("enabled_modules")

    if raw_value is None:
        raw_value = cfg_defaults().get("enabled_modules", "")

    raw = str(raw_value or "").strip()
    if not raw:
        return values

    try:
        payload = json.loads(raw)
    except Exception:
        payload = None

    if isinstance(payload, dict):
        for key, value in payload.items():
            module_id = str(key or "").strip()
            if module_id in values:
                values[module_id] = _boolish_module_value(value, values[module_id])
        return values

    if isinstance(payload, list):
        enabled = {str(item or "").strip() for item in payload if str(item or "").strip()}
        for key in values:
            values[key] = key in enabled
        return values

    # Fallback CSV: "services,quality,syncthing"
    if "," in raw:
        enabled = {item.strip() for item in raw.split(",") if item.strip()}
        for key in values:
            values[key] = key in enabled

    return values


def module_enabled(module_id: str, default: bool = True) -> bool:
    """Comprueba si un módulo opcional está activo."""
    key = str(module_id or "").strip()
    if not key:
        return default
    return bool(enabled_modules_map().get(key, default))




def load_settings() -> None:
    """
    Carga settings desde la BD en _cfg, con fallback a cfg_defaults().
    Siembra en la BD las keys que falten.
    Import local de database.db() para evitar dependencia circular al nivel de módulo.
    """
    global _cfg
    from database import db  # import local — evita ciclo database ↔ config

    defaults = cfg_defaults()
    with _cfg_lock:
        _cfg = dict(defaults)
        try:
            with db() as conn:
                rows = conn.execute("SELECT key, value FROM settings").fetchall()
                for r in rows:
                    _cfg[r["key"]] = r["value"]
                # Sembrar keys que no existan todavía
                for k, v in defaults.items():
                    conn.execute(
                        "INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)", (k, v)
                    )
        except Exception:
            pass  # Si la BD no está lista, usamos los defaults


def _db_get_setting(key: str) -> Any:
    """
    Lee una clave concreta directamente desde la BD.

    Se usa como red de seguridad cuando _cfg aún no se ha cargado o quedó
    desincronizado respecto a settings.
    """
    from database import db  # import local

    try:
        with db() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key=?",
                (key,),
            ).fetchone()
            if row is None:
                return None
            try:
                return row["value"]
            except Exception:
                return row[0]
    except Exception:
        return None


def cfg(key: str, default: Any = None) -> Any:
    """
    Lee un setting priorizando el cache en memoria, con fallback robusto a BD y
    por último a los defaults derivados de entorno.

    Esto evita que el runtime vea None cuando la tabla settings sí tiene valor
    pero _cfg aún no se ha cargado o quedó desincronizado.
    """
    with _cfg_lock:
        if key in _cfg:
            return _cfg[key]

    db_value = _db_get_setting(key)
    if db_value is not None:
        with _cfg_lock:
            _cfg[key] = db_value
        return db_value

    defaults = cfg_defaults()
    if key in defaults:
        value = defaults[key]
        with _cfg_lock:
            _cfg.setdefault(key, value)
        return value

    return default


def save_setting(key: str, value: str) -> None:
    """
    Persiste un setting en BD y actualiza el cache.

    La escritura en BD se hace primero y el cache se sincroniza después para
    minimizar desalineaciones entre runtime y settings persistidos.
    """
    from database import db  # import local

    normalized = "" if value is None else str(value)

    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)",
            (key, normalized),
        )

    with _cfg_lock:
        _cfg[key] = normalized


# ══════════════════════════════════════════════════════════════
#  Rate limiter de login (en memoria)
# ══════════════════════════════════════════════════════════════
#
#  Protección antes de que Fail2ban entre en juego (sesión 12).
#  Límite: MAX_ATTEMPTS intentos fallidos en WINDOW_SECONDS → 429.
#  No persiste entre reinicios — aceptable para LAN.
#  Thread-safe mediante lock.

_LOGIN_MAX_ATTEMPTS = 10      # intentos fallidos permitidos
_LOGIN_WINDOW_SECS  = 300     # ventana de tiempo (5 minutos)
_LOGIN_BAN_SECS     = 300     # duración del bloqueo tras superar el límite

_login_attempts: Dict[str, List[float]] = defaultdict(list)
_login_banned:   Dict[str, float]       = {}   # ip → timestamp de desbloqueo
_login_lock      = threading.Lock()


def login_check_and_record(ip: str, success: bool) -> bool:
    """
    Comprueba si la IP está bloqueada y registra el intento.

    - Si success=True, limpia el historial de la IP (login correcto).
    - Si success=False, añade timestamp al historial y evalúa bloqueo.

    Devuelve True si la IP está BLOQUEADA (debe rechazarse con 429).
    """
    now = time.monotonic()
    with _login_lock:
        # ¿Está baneada?
        if ip in _login_banned:
            if now < _login_banned[ip]:
                return True  # Sigue bloqueada
            else:
                del _login_banned[ip]
                _login_attempts[ip] = []

        if success:
            _login_attempts[ip] = []
            return False

        # Registrar fallo — limpiar intentos fuera de la ventana
        attempts = [t for t in _login_attempts[ip] if now - t < _LOGIN_WINDOW_SECS]
        attempts.append(now)
        _login_attempts[ip] = attempts

        if len(attempts) >= _LOGIN_MAX_ATTEMPTS:
            _login_banned[ip] = now + _LOGIN_BAN_SECS
            return True

        return False


def login_retry_after(ip: str) -> int:
    """
    Devuelve los segundos que quedan de bloqueo para la IP.
    Devuelve 0 si no está bloqueada.
    """
    now = time.monotonic()
    with _login_lock:
        if ip in _login_banned:
            remaining = _login_banned[ip] - now
            return max(0, int(remaining))
    return 0
