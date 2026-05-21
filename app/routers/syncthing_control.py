"""
routers/syncthing_control.py — Auditor IPs

Control centralizado de nodos Syncthing vía API REST.
Fase 1:
- solo lectura sobre Syncthing
- CRUD local de nodos
- API keys guardadas en BD local y nunca devueltas en claro
- soporte de verify_tls=false para certificados autofirmados
"""

import hashlib
import json
import os
import ssl
import threading
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

from config import cfg
from database import db
from utils import utc_now_iso

router = APIRouter()

_syncthing_refresh_lock = threading.Lock()


# ══════════════════════════════════════════════════════════════
#  Schema local
# ══════════════════════════════════════════════════════════════

def ensure_syncthing_schema() -> None:
    with db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            api_base_url TEXT NOT NULL,
            gui_url TEXT NOT NULL DEFAULT '',
            api_key TEXT NOT NULL DEFAULT '',
            verify_tls INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            timeout_s REAL NOT NULL DEFAULT 8.0,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_nodes_enabled "
            "ON syncthing_nodes(enabled, name)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_syncthing_nodes_api_base_url_unique "
            "ON syncthing_nodes(lower(api_base_url))"
        )
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_folder_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER NOT NULL,
            folder_id TEXT NOT NULL,
            node_name TEXT NOT NULL DEFAULT '',
            folder_label TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT '',
            need_bytes INTEGER NOT NULL DEFAULT 0,
            need_files INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            local_bytes INTEGER NOT NULL DEFAULT 0,
            global_bytes INTEGER NOT NULL DEFAULT 0,
            state_changed TEXT NOT NULL DEFAULT '',
            observed_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_folder_snapshots_lookup "
            "ON syncthing_folder_snapshots(node_id, folder_id, observed_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_folder_snapshots_observed "
            "ON syncthing_folder_snapshots(observed_at)"
        )

        # Syncthing Control — estado de alertas por carpeta para evitar spam.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_stalled_alert_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER NOT NULL,
            folder_id TEXT NOT NULL,
            node_name TEXT NOT NULL DEFAULT '',
            folder_label TEXT NOT NULL DEFAULT '',
            last_state TEXT NOT NULL DEFAULT '',
            last_alert_at TEXT NOT NULL DEFAULT '',
            last_recovered_at TEXT NOT NULL DEFAULT '',
            first_issue_at TEXT NOT NULL DEFAULT '',
            last_error TEXT NOT NULL DEFAULT '',
            alert_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_syncthing_stalled_alert_state_key "
            "ON syncthing_stalled_alert_state(node_id, folder_id)"
        )
        _stalled_alert_cols = set()
        for _row in conn.execute("PRAGMA table_info(syncthing_stalled_alert_state)").fetchall():
            try:
                _stalled_alert_cols.add(str(_row["name"]))
            except Exception:
                _stalled_alert_cols.add(str(_row[1]))
        if "first_issue_at" not in _stalled_alert_cols:
            conn.execute(
                "ALTER TABLE syncthing_stalled_alert_state "
                "ADD COLUMN first_issue_at TEXT NOT NULL DEFAULT ''"
            )

        # Syncthing Control — histórico de transferencia por nodo.
        # Guarda deltas calculados desde contadores acumulados de Syncthing; no consulta endpoints pesados.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_transfer_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER NOT NULL,
            node_name TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            connected_devices INTEGER NOT NULL DEFAULT 0,
            disconnected_devices INTEGER NOT NULL DEFAULT 0,
            rx_total_bytes INTEGER NOT NULL DEFAULT 0,
            tx_total_bytes INTEGER NOT NULL DEFAULT 0,
            rx_delta_bytes INTEGER NOT NULL DEFAULT 0,
            tx_delta_bytes INTEGER NOT NULL DEFAULT 0,
            interval_seconds INTEGER NOT NULL DEFAULT 0,
            rx_bps REAL NOT NULL DEFAULT 0,
            tx_bps REAL NOT NULL DEFAULT 0,
            observed_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_transfer_snapshots_lookup "
            "ON syncthing_transfer_snapshots(node_id, observed_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_transfer_snapshots_observed "
            "ON syncthing_transfer_snapshots(observed_at)"
        )

        # Syncthing Control — último cambio de estado relevante por servidor.
        # No cuenta escaneos ni microactividad como cambio relevante.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_node_relevant_state (
            node_id INTEGER PRIMARY KEY,
            node_name TEXT NOT NULL DEFAULT '',
            relevant_state TEXT NOT NULL DEFAULT '',
            relevant_state_label TEXT NOT NULL DEFAULT '',
            previous_relevant_state TEXT NOT NULL DEFAULT '',
            relevant_state_changed_at TEXT NOT NULL DEFAULT '',
            observed_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )
        """)

        # Syncthing Control — histórico de transferencia por dispositivo remoto.
        # Permite identificar flujos hacia/desde remotos aunque no estén dados de alta como nodos Auditor.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_remote_transfer_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER NOT NULL,
            node_name TEXT NOT NULL DEFAULT '',
            remote_device_id TEXT NOT NULL DEFAULT '',
            remote_device_name TEXT NOT NULL DEFAULT '',
            connected INTEGER NOT NULL DEFAULT 0,
            rx_total_bytes INTEGER NOT NULL DEFAULT 0,
            tx_total_bytes INTEGER NOT NULL DEFAULT 0,
            rx_delta_bytes INTEGER NOT NULL DEFAULT 0,
            tx_delta_bytes INTEGER NOT NULL DEFAULT 0,
            interval_seconds INTEGER NOT NULL DEFAULT 0,
            rx_bps REAL NOT NULL DEFAULT 0,
            tx_bps REAL NOT NULL DEFAULT 0,
            observed_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_remote_transfer_snapshots_lookup "
            "ON syncthing_remote_transfer_snapshots(node_id, remote_device_id, observed_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_remote_transfer_snapshots_observed "
            "ON syncthing_remote_transfer_snapshots(observed_at)"
        )

        # Syncthing Control — histórico global de archivos observados.
        # No guarda rutas completas locales; el nombre visible depende de la política de privacidad.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_file_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id INTEGER NOT NULL,
            node_name TEXT NOT NULL DEFAULT '',
            event_id INTEGER NOT NULL,
            global_id INTEGER NOT NULL DEFAULT 0,
            event_type TEXT NOT NULL DEFAULT '',
            event_time TEXT NOT NULL DEFAULT '',
            observed_at TEXT NOT NULL DEFAULT '',
            folder_id TEXT NOT NULL DEFAULT '',
            folder_label TEXT NOT NULL DEFAULT '',
            item_name TEXT NOT NULL DEFAULT '',
            item_hash TEXT NOT NULL DEFAULT '',
            item_type TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            confirmation TEXT NOT NULL DEFAULT 'observed',
            origin_device_id TEXT NOT NULL DEFAULT '',
            origin_node_id INTEGER NOT NULL DEFAULT 0,
            origin_node_name TEXT NOT NULL DEFAULT '',
            origin_device_name TEXT NOT NULL DEFAULT '',
            origin_confidence TEXT NOT NULL DEFAULT '',
            origin_source TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_syncthing_file_events_node_event "
            "ON syncthing_file_events(node_id, event_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_file_events_time "
            "ON syncthing_file_events(event_time, observed_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_syncthing_file_events_folder "
            "ON syncthing_file_events(folder_id, node_id, event_time)"
        )

        existing_file_event_cols = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(syncthing_file_events)").fetchall()
        }
        for col_name, col_sql in (
            ("origin_device_id", "TEXT NOT NULL DEFAULT ''"),
            ("origin_node_id", "INTEGER NOT NULL DEFAULT 0"),
            ("origin_node_name", "TEXT NOT NULL DEFAULT ''"),
            ("origin_device_name", "TEXT NOT NULL DEFAULT ''"),
            ("origin_confidence", "TEXT NOT NULL DEFAULT ''"),
            ("origin_source", "TEXT NOT NULL DEFAULT ''"),
        ):
            if col_name not in existing_file_event_cols:
                conn.execute(f"ALTER TABLE syncthing_file_events ADD COLUMN {col_name} {col_sql}")

        conn.execute("""
        CREATE TABLE IF NOT EXISTS syncthing_overview_cache (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            summary_json TEXT NOT NULL DEFAULT '{}',
            nodes_json TEXT NOT NULL DEFAULT '[]',
            folders_json TEXT NOT NULL DEFAULT '[]',
            results_json TEXT NOT NULL DEFAULT '[]',
            refreshed_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'empty',
            error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)


# ══════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════

def _cfg_int(key: str, default: int, min_value: int, max_value: int) -> int:
    try:
        value = int(str(cfg(key, str(default)) or default).strip())
    except Exception:
        value = default
    return max(min_value, min(max_value, value))


def get_syncthing_refresh_interval_seconds() -> int:
    return _cfg_int("syncthing_refresh_interval_seconds", 60, 30, 3600)


def get_syncthing_snapshot_retention_days() -> int:
    return _cfg_int("syncthing_snapshot_retention_days", 14, 1, 90)


def get_syncthing_stalled_threshold_minutes() -> int:
    return _cfg_int("syncthing_stalled_threshold_minutes", 60, 15, 1440)


def get_syncthing_stalled_alert_cooldown_minutes() -> int:
    return _cfg_int("syncthing_stalled_alert_cooldown_minutes", 120, 15, 1440)


def _cfg_bool(key: str, default: bool = False) -> bool:
    raw = cfg(key, "1" if default else "0")
    return str(raw or "").strip().lower() in {"1", "true", "yes", "y", "si", "sí", "on"}


def _fmt_bytes_short(value: Any) -> str:
    n = max(0, _to_int(value))
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{n} B"


def get_syncthing_transfer_active_threshold_bps() -> int:
    # Evita marcar como transferencia real el tráfico mínimo de control/keepalive.
    return _cfg_int("syncthing_transfer_active_threshold_bps", 1024, 1, 104857600)


def get_syncthing_transfer_active_min_delta_bytes() -> int:
    # Evita mostrar micro-deltas, keepalive o comprobaciones mínimas como transferencia útil.
    return _cfg_int("syncthing_transfer_active_min_delta_bytes", 1048576, 0, 1073741824)


def get_syncthing_file_name_retention_days() -> int:
    # Retención del nombre visible, no de la ruta completa.
    return _cfg_int("syncthing_file_name_retention_days", 7, 1, 90)


def get_syncthing_file_event_retention_days() -> int:
    # Retención técnica configurable del histórico global de eventos.
    return _cfg_int("syncthing_file_event_retention_days", 5, 1, 365)


def get_syncthing_store_file_names() -> bool:
    return _cfg_bool("syncthing_store_file_names", False)


def _clean_url(value: Any) -> str:
    return str(value or "").strip().rstrip("/")


def _clean_syncthing_url(value: Any, *, required: bool, field_label: str) -> Tuple[str, Optional[str]]:
    raw = str(value or "").strip()
    if not raw:
        return ("", f"{field_label} es obligatoria.") if required else ("", None)

    # Correcciones conservadoras de errores frecuentes de escritura.
    raw = raw.replace("https.//", "https://").replace("http.//", "http://")
    raw = raw.replace("https:/", "https://", 1) if raw.startswith("https:/") and not raw.startswith("https://") else raw
    raw = raw.replace("http:/", "http://", 1) if raw.startswith("http:/") and not raw.startswith("http://") else raw

    if "://" not in raw:
        raw = f"https://{raw}"

    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        return "", f"{field_label} debe empezar por http:// o https://."
    if not parsed.netloc:
        return "", f"{field_label} no contiene host válido."

    clean = raw.rstrip("/")
    return clean, None


def _clean_text(value: Any, max_len: int = 500) -> str:
    return str(value or "").strip()[:max_len]


def _as_bool_int(value: Any, default: bool = False) -> int:
    if value is None:
        return 1 if default else 0
    if isinstance(value, bool):
        return 1 if value else 0
    return 1 if str(value).strip().lower() in {"1", "true", "yes", "y", "si", "sí", "on"} else 0


def _as_timeout(value: Any) -> float:
    try:
        n = float(value)
    except Exception:
        n = 8.0
    return max(2.0, min(n, 60.0))


def _mask_secret(value: Any) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    if len(raw) <= 8:
        return "••••"
    return f"{raw[:4]}••••{raw[-4:]}"


def _row_public(row: Any) -> Dict[str, Any]:
    item = dict(row)
    api_key = item.pop("api_key", "") or ""
    item["api_key_configured"] = bool(api_key)
    item["api_key_masked"] = _mask_secret(api_key)
    item["verify_tls"] = bool(item.get("verify_tls"))
    item["enabled"] = bool(item.get("enabled"))
    return item


def _load_node(node_id: int) -> Optional[Dict[str, Any]]:
    ensure_syncthing_schema()
    with db() as conn:
        row = conn.execute("SELECT * FROM syncthing_nodes WHERE id=?", (node_id,)).fetchone()
    return dict(row) if row else None


def _error_count(errors_value: Any) -> int:
    if errors_value is None:
        return 0
    if isinstance(errors_value, list):
        return len(errors_value)
    if isinstance(errors_value, dict):
        nested = errors_value.get("errors")
        if nested is not None and nested is not errors_value:
            return _error_count(nested)
        return len(errors_value)
    try:
        return int(errors_value or 0)
    except Exception:
        return 1 if str(errors_value or "").strip() else 0


def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _utc_dt_from_iso(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None



def _save_transfer_snapshots(nodes: List[Dict[str, Any]], observed_at: str) -> None:
    """
    Guarda snapshots de transferencia por nodo y enriquece el overview con deltas.
    Usa contadores acumulados ya obtenidos desde /rest/system/connections.
    """
    if not nodes:
        return

    observed_dt = _utc_dt_from_iso(observed_at) or datetime.now(timezone.utc)
    cutoff = (observed_dt - timedelta(days=get_syncthing_snapshot_retention_days())).replace(microsecond=0).isoformat()
    min_spacing_seconds = 20

    with db() as conn:
        for node in nodes:
            node_id = _to_int(node.get("id"))
            if not node_id:
                continue

            rx_total = _to_int(node.get("inBytesTotal"))
            tx_total = _to_int(node.get("outBytesTotal"))

            last = conn.execute(
                """
                SELECT rx_total_bytes, tx_total_bytes, observed_at
                FROM syncthing_transfer_snapshots
                WHERE node_id=?
                ORDER BY observed_at DESC
                LIMIT 1
                """,
                (node_id,),
            ).fetchone()

            interval_seconds = 0
            rx_delta = 0
            tx_delta = 0
            if last:
                last_dt = _utc_dt_from_iso(last["observed_at"])
                if last_dt:
                    interval_seconds = max(0, int((observed_dt - last_dt).total_seconds()))
                if interval_seconds > 0:
                    # Los contadores pueden reiniciarse si Syncthing o la conexión se reinicia.
                    rx_delta = max(0, rx_total - _to_int(last["rx_total_bytes"]))
                    tx_delta = max(0, tx_total - _to_int(last["tx_total_bytes"]))

            rx_bps = (rx_delta / interval_seconds) if interval_seconds > 0 else 0.0
            tx_bps = (tx_delta / interval_seconds) if interval_seconds > 0 else 0.0
            transfer_threshold_bps = get_syncthing_transfer_active_threshold_bps()
            transfer_min_delta_bytes = get_syncthing_transfer_active_min_delta_bytes()
            total_bps = rx_bps + tx_bps
            total_delta_bytes = rx_delta + tx_delta
            is_transferring = bool(
                interval_seconds >= min_spacing_seconds
                and total_bps >= transfer_threshold_bps
                and total_delta_bytes >= transfer_min_delta_bytes
            )

            node["rxDeltaBytes"] = rx_delta
            node["txDeltaBytes"] = tx_delta
            node["totalDeltaBytes"] = total_delta_bytes
            node["transferIntervalSeconds"] = interval_seconds
            node["rxBytesPerSecond"] = round(rx_bps, 2)
            node["txBytesPerSecond"] = round(tx_bps, 2)
            node["totalBytesPerSecond"] = round(total_bps, 2)
            node["transferActiveThresholdBps"] = transfer_threshold_bps
            node["transferActiveMinDeltaBytes"] = transfer_min_delta_bytes
            node["isTransferring"] = is_transferring
            node["transferStatus"] = "transferring" if is_transferring else "idle"
            if is_transferring:
                node["transferring_since_observed"] = observed_at

            too_soon = bool(last and interval_seconds and interval_seconds < min_spacing_seconds)
            if too_soon:
                continue

            conn.execute(
                """
                INSERT INTO syncthing_transfer_snapshots
                    (node_id, node_name, status, connected_devices, disconnected_devices,
                     rx_total_bytes, tx_total_bytes, rx_delta_bytes, tx_delta_bytes,
                     interval_seconds, rx_bps, tx_bps, observed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    node_id,
                    str(node.get("name") or ""),
                    str(node.get("status") or ""),
                    _to_int(node.get("connected_devices")),
                    _to_int(node.get("disconnected_devices")),
                    rx_total,
                    tx_total,
                    rx_delta,
                    tx_delta,
                    interval_seconds,
                    float(rx_bps),
                    float(tx_bps),
                    observed_at,
                ),
            )

            for remote in node.get("remoteTransferDevices") or []:
                if not isinstance(remote, dict):
                    continue
                remote_device_id = str(remote.get("remote_device_id") or "").strip()
                if not remote_device_id:
                    continue

                remote_rx_total = _to_int(remote.get("rxTotalBytes"))
                remote_tx_total = _to_int(remote.get("txTotalBytes"))

                remote_last = conn.execute(
                    """
                    SELECT rx_total_bytes, tx_total_bytes, observed_at
                    FROM syncthing_remote_transfer_snapshots
                    WHERE node_id=? AND remote_device_id=?
                    ORDER BY observed_at DESC
                    LIMIT 1
                    """,
                    (node_id, remote_device_id),
                ).fetchone()

                remote_interval_seconds = 0
                remote_rx_delta = 0
                remote_tx_delta = 0
                if remote_last:
                    remote_last_dt = _utc_dt_from_iso(remote_last["observed_at"])
                    if remote_last_dt:
                        remote_interval_seconds = max(0, int((observed_dt - remote_last_dt).total_seconds()))
                    if remote_interval_seconds > 0:
                        remote_rx_delta = max(0, remote_rx_total - _to_int(remote_last["rx_total_bytes"]))
                        remote_tx_delta = max(0, remote_tx_total - _to_int(remote_last["tx_total_bytes"]))

                remote_rx_bps = (remote_rx_delta / remote_interval_seconds) if remote_interval_seconds > 0 else 0.0
                remote_tx_bps = (remote_tx_delta / remote_interval_seconds) if remote_interval_seconds > 0 else 0.0
                remote_total_bps = remote_rx_bps + remote_tx_bps
                remote_total_delta_bytes = remote_rx_delta + remote_tx_delta
                remote_transferring = bool(
                    remote_interval_seconds >= min_spacing_seconds
                    and remote_total_bps >= transfer_threshold_bps
                    and remote_total_delta_bytes >= transfer_min_delta_bytes
                )

                remote["rxDeltaBytes"] = remote_rx_delta
                remote["txDeltaBytes"] = remote_tx_delta
                remote["totalDeltaBytes"] = remote_total_delta_bytes
                remote["transferIntervalSeconds"] = remote_interval_seconds
                remote["rxBytesPerSecond"] = round(remote_rx_bps, 2)
                remote["txBytesPerSecond"] = round(remote_tx_bps, 2)
                remote["totalBytesPerSecond"] = round(remote_total_bps, 2)
                remote["transferActiveMinDeltaBytes"] = transfer_min_delta_bytes
                remote["isTransferring"] = remote_transferring

                remote_too_soon = bool(remote_last and remote_interval_seconds and remote_interval_seconds < min_spacing_seconds)
                if remote_too_soon:
                    continue

                conn.execute(
                    """
                    INSERT INTO syncthing_remote_transfer_snapshots
                        (node_id, node_name, remote_device_id, remote_device_name, connected,
                         rx_total_bytes, tx_total_bytes, rx_delta_bytes, tx_delta_bytes,
                         interval_seconds, rx_bps, tx_bps, observed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        node_id,
                        str(node.get("name") or ""),
                        remote_device_id,
                        str(remote.get("remote_device_name") or remote_device_id[:12]),
                        1 if remote.get("connected") else 0,
                        remote_rx_total,
                        remote_tx_total,
                        remote_rx_delta,
                        remote_tx_delta,
                        remote_interval_seconds,
                        float(remote_rx_bps),
                        float(remote_tx_bps),
                        observed_at,
                    ),
                )

        conn.execute(
            "DELETE FROM syncthing_transfer_snapshots WHERE observed_at < ?",
            (cutoff,),
        )
        conn.execute(
            "DELETE FROM syncthing_remote_transfer_snapshots WHERE observed_at < ?",
            (cutoff,),
        )


def _node_relevant_state(node: Dict[str, Any], folders: List[Dict[str, Any]]) -> Tuple[str, str]:
    """
    Estado relevante para columna 'Último cambio de estado'.

    Reglas:
    - Posible atasco prevalece.
    - Error incluye error/offline de nodo o errores de carpetas.
    - Sincronizando exige sincronización real/pendiente o transferencia real.
    - Escaneando no cuenta como cambio relevante; cae a Standby salvo que haya error/pendiente/atasco.
    """
    node_status = str(node.get("status") or "").lower()
    node_id = _to_int(node.get("id"))
    node_folders = [f for f in folders if _to_int(f.get("node_id")) == node_id]

    if any(bool(f.get("stalled_candidate")) for f in node_folders):
        return "stalled", "Posible atasco"

    if node_status in {"error", "offline"} or any(str(f.get("status") or "").lower() == "error" for f in node_folders):
        return "error", "Error"

    has_syncing_folder = any(
        str(f.get("status") or "").lower() == "syncing"
        and (
            _to_int(f.get("needBytes")) > 0
            or _to_int(f.get("needFiles")) > 0
            or _to_int(f.get("syncing_minutes_observed")) > 0
        )
        for f in node_folders
    )
    if bool(node.get("isTransferring")) or node_status == "syncing" or has_syncing_folder:
        return "syncing", "Sincronizando"

    return "standby", "Standby"


def _enrich_nodes_with_relevant_state(nodes: List[Dict[str, Any]], folders: List[Dict[str, Any]], observed_at: str) -> None:
    if not nodes:
        return

    with db() as conn:
        for node in nodes:
            node_id = _to_int(node.get("id"))
            if not node_id:
                continue

            state, label = _node_relevant_state(node, folders)
            node_name = str(node.get("name") or "")[:255]

            row = conn.execute(
                """
                SELECT relevant_state, relevant_state_changed_at
                FROM syncthing_node_relevant_state
                WHERE node_id=?
                """,
                (node_id,),
            ).fetchone()

            if not row:
                changed_at = observed_at
                conn.execute(
                    """
                    INSERT INTO syncthing_node_relevant_state
                        (node_id, node_name, relevant_state, relevant_state_label,
                         previous_relevant_state, relevant_state_changed_at,
                         observed_at, updated_at)
                    VALUES (?, ?, ?, ?, '', ?, ?, ?)
                    """,
                    (node_id, node_name, state, label, changed_at, observed_at, observed_at),
                )
            elif str(row["relevant_state"] or "") != state:
                changed_at = observed_at
                conn.execute(
                    """
                    UPDATE syncthing_node_relevant_state
                    SET node_name=?,
                        previous_relevant_state=relevant_state,
                        relevant_state=?,
                        relevant_state_label=?,
                        relevant_state_changed_at=?,
                        observed_at=?,
                        updated_at=?
                    WHERE node_id=?
                    """,
                    (node_name, state, label, changed_at, observed_at, observed_at, node_id),
                )
            else:
                changed_at = str(row["relevant_state_changed_at"] or observed_at)
                conn.execute(
                    """
                    UPDATE syncthing_node_relevant_state
                    SET node_name=?,
                        relevant_state_label=?,
                        observed_at=?,
                        updated_at=?
                    WHERE node_id=?
                    """,
                    (node_name, label, observed_at, observed_at, node_id),
                )

            node["relevantState"] = state
            node["relevantStateLabel"] = label
            node["relevantStateChangedAt"] = changed_at
            node["lastRelevantStateChangeAt"] = changed_at


def _file_event_hash(folder_id: str, item_path: str) -> str:
    raw = f"{folder_id}\n{item_path}".encode("utf-8", errors="ignore")
    return hashlib.sha256(raw).hexdigest()


def _file_event_public_name(item_path: str, store_names: bool) -> str:
    if not store_names:
        return ""
    clean = str(item_path or "").replace("\\", "/").strip("/")
    if not clean:
        return ""
    return os.path.basename(clean)[:255]


def _device_prefix_maps(results: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Mapa conservador por prefijo de deviceID. Syncthing expone modifiedBy como prefijo corto.
    """
    out: Dict[str, Dict[str, Any]] = {}

    def put(device_id: Any, name: Any, node_id: int = 0, node_name: str = "") -> None:
        raw = str(device_id or "").strip()
        if not raw:
            return
        prefix = raw.split("-")[0][:7]
        if not prefix:
            return
        out[prefix] = {
            "device_id": prefix,
            "device_name": str(name or prefix)[:255],
            "node_id": int(node_id or 0),
            "node_name": str(node_name or "")[:255],
        }

    for result in results:
        node = result.get("node") or {}
        try:
            node_id = int(node.get("id") or 0)
        except Exception:
            node_id = 0
        node_name = str(node.get("name") or "")[:255]
        put(node.get("myID"), node_name, node_id, node_name)

    for result in results:
        for dev in result.get("devices") or []:
            if not isinstance(dev, dict):
                continue
            put(dev.get("deviceID"), dev.get("name") or dev.get("deviceID"))

    # Los nodos monitorizados prevalecen sobre nombres conocidos de configuración.
    for result in results:
        node = result.get("node") or {}
        try:
            node_id = int(node.get("id") or 0)
        except Exception:
            node_id = 0
        node_name = str(node.get("name") or "")[:255]
        put(node.get("myID"), node_name, node_id, node_name)

    return out


def _disk_event_origin_candidates(results: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Indexa LocalChangeDetected/RemoteChangeDetected por hash de carpeta+path.

    No se usa como evento final por sí solo: solo sirve para enriquecer ItemFinished.
    """
    devices = _device_prefix_maps(results)
    out: Dict[str, List[Dict[str, Any]]] = {}

    for result in results:
        observed_node = result.get("node") or {}
        try:
            observed_node_id = int(observed_node.get("id") or 0)
        except Exception:
            observed_node_id = 0
        observed_node_name = str(observed_node.get("name") or "")[:255]
        observed_my_id = str(observed_node.get("myID") or "").split("-")[0][:7]

        for event in result.get("disk_events") or []:
            if not isinstance(event, dict):
                continue

            event_type = str(event.get("type") or "").strip()
            if event_type not in {"LocalChangeDetected", "RemoteChangeDetected"}:
                continue

            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            folder_id = str(data.get("folder") or data.get("folderID") or "").strip()
            item_path = str(data.get("item") or data.get("path") or "").strip()
            if not folder_id or not item_path:
                continue

            modified_by = str(data.get("modifiedBy") or "").split("-")[0][:7]
            if event_type == "LocalChangeDetected":
                origin_device_id = modified_by or observed_my_id
                origin_node_id = observed_node_id
                origin_node_name = observed_node_name
                origin_device_name = observed_node_name
                confidence = "probable_local"
                source = "LocalChangeDetected"
            else:
                origin_device_id = modified_by
                known = devices.get(origin_device_id, {}) if origin_device_id else {}
                origin_node_id = int(known.get("node_id") or 0)
                origin_node_name = str(known.get("node_name") or "")[:255]
                origin_device_name = str(known.get("device_name") or origin_device_id or "")[:255]
                confidence = "probable_remote"
                source = "RemoteChangeDetected"

            event_dt = _utc_dt_from_iso(event.get("time"))
            key = _file_event_hash(folder_id, item_path)
            out.setdefault(key, []).append({
                "event_dt": event_dt,
                "event_time": str(event.get("time") or ""),
                "action": str(data.get("action") or "")[:80],
                "origin_device_id": origin_device_id[:80],
                "origin_node_id": origin_node_id,
                "origin_node_name": origin_node_name,
                "origin_device_name": origin_device_name,
                "origin_confidence": confidence,
                "origin_source": source,
            })

    return out


def _match_file_event_origin(
    candidates: Dict[str, List[Dict[str, Any]]],
    item_hash: str,
    event_time: Any,
) -> Dict[str, Any]:
    event_dt = _utc_dt_from_iso(event_time)
    matches = candidates.get(item_hash) or []
    if not matches:
        return {}

    if not event_dt:
        return matches[-1]

    best: Optional[Dict[str, Any]] = None
    best_delta = 999999999.0
    for cand in matches:
        cand_dt = cand.get("event_dt")
        if not cand_dt:
            continue
        delta = abs((event_dt - cand_dt).total_seconds())
        if delta < best_delta:
            best = cand
            best_delta = delta

    # Ventana amplia pero finita: evita asociar cambios antiguos no relacionados.
    if best and best_delta <= 6 * 3600:
        return best
    return {}


def _save_file_events(results: List[Dict[str, Any]], observed_at: str) -> Dict[str, int]:
    """
    Persiste eventos ItemFinished ya leídos desde /rest/events.

    Política de privacidad:
    - nunca guarda la ruta completa local del archivo;
    - si syncthing_store_file_names=0, item_name queda vacío;
    - si está activo, guarda solo basename y purga nombres visibles antiguos;
    - item_hash permite correlación conservadora sin exponer ruta;
    - origen probable solo se rellena si hay evento de disco correlacionado.
    """
    store_names = get_syncthing_store_file_names()
    inserted = 0
    skipped = 0
    origin_candidates = _disk_event_origin_candidates(results)

    observed_dt = _utc_dt_from_iso(observed_at) or datetime.now(timezone.utc)
    event_cutoff = (observed_dt - timedelta(days=get_syncthing_file_event_retention_days())).replace(microsecond=0).isoformat()
    name_cutoff = (observed_dt - timedelta(days=get_syncthing_file_name_retention_days())).replace(microsecond=0).isoformat()

    folder_labels: Dict[Tuple[int, str], str] = {}
    for result in results:
        for folder in result.get("folders") or []:
            try:
                node_id = int(folder.get("node_id") or 0)
            except Exception:
                node_id = 0
            folder_id = str(folder.get("id") or "").strip()
            if node_id and folder_id:
                folder_labels[(node_id, folder_id)] = str(folder.get("label") or folder_id)[:255]

    with db() as conn:
        for result in results:
            node = result.get("node") or {}
            try:
                node_id = int(node.get("id") or 0)
            except Exception:
                node_id = 0
            if not node_id:
                skipped += 1
                continue
            node_name = str(node.get("name") or "")[:255]

            for event in result.get("events") or []:
                if not isinstance(event, dict):
                    skipped += 1
                    continue

                event_type = str(event.get("type") or "").strip()
                if event_type != "ItemFinished":
                    skipped += 1
                    continue

                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                folder_id = str(data.get("folder") or "").strip()
                item_path = str(data.get("item") or "").strip()
                if not folder_id or not item_path:
                    skipped += 1
                    continue

                event_id = _to_int(event.get("id"))
                if event_id <= 0:
                    skipped += 1
                    continue

                item_hash = _file_event_hash(folder_id, item_path)
                origin = _match_file_event_origin(origin_candidates, item_hash, event.get("time") or observed_at)

                before = conn.total_changes
                conn.execute(
                    """
                    INSERT OR IGNORE INTO syncthing_file_events
                        (node_id, node_name, event_id, global_id, event_type,
                         event_time, observed_at, folder_id, folder_label,
                         item_name, item_hash, item_type, action, error,
                         confirmation, origin_device_id, origin_node_id,
                         origin_node_name, origin_device_name, origin_confidence,
                         origin_source, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed',
                            ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        node_id,
                        node_name,
                        event_id,
                        _to_int(event.get("globalID")),
                        event_type[:80],
                        str(event.get("time") or observed_at)[:80],
                        observed_at,
                        folder_id[:255],
                        folder_labels.get((node_id, folder_id), folder_id)[:255],
                        _file_event_public_name(item_path, store_names),
                        item_hash,
                        str(data.get("type") or "")[:80],
                        str(data.get("action") or "")[:80],
                        str(data.get("error") or "")[:1000],
                        str(origin.get("origin_device_id") or "")[:80],
                        int(origin.get("origin_node_id") or 0),
                        str(origin.get("origin_node_name") or "")[:255],
                        str(origin.get("origin_device_name") or "")[:255],
                        str(origin.get("origin_confidence") or "")[:80],
                        str(origin.get("origin_source") or "")[:80],
                        observed_at,
                    ),
                )
                if conn.total_changes > before:
                    inserted += 1

        conn.execute("DELETE FROM syncthing_file_events WHERE observed_at < ?", (event_cutoff,))
        if not store_names:
            conn.execute("UPDATE syncthing_file_events SET item_name='' WHERE item_name<>''")
        else:
            conn.execute("UPDATE syncthing_file_events SET item_name='' WHERE observed_at < ?", (name_cutoff,))

    return {"inserted": inserted, "skipped": skipped}


def _save_folder_snapshots(folders: List[Dict[str, Any]], observed_at: str) -> None:
    if not folders:
        return

    observed_dt = _utc_dt_from_iso(observed_at) or datetime.now(timezone.utc)
    cutoff = (observed_dt - timedelta(days=get_syncthing_snapshot_retention_days())).replace(microsecond=0).isoformat()
    min_spacing_seconds = 300

    with db() as conn:
        for f in folders:
            node_id = _to_int(f.get("node_id"))
            folder_id = str(f.get("id") or "").strip()
            if not node_id or not folder_id:
                continue

            status = str(f.get("status") or "")
            need_bytes = _to_int(f.get("needBytes"))
            need_files = _to_int(f.get("needFiles"))
            errors = _to_int(f.get("errors"))

            last = conn.execute(
                """
                SELECT status, need_bytes, need_files, errors, observed_at
                FROM syncthing_folder_snapshots
                WHERE node_id=? AND folder_id=?
                ORDER BY observed_at DESC
                LIMIT 1
                """,
                (node_id, folder_id),
            ).fetchone()

            if last:
                last_dt = _utc_dt_from_iso(last["observed_at"])
                same_values = (
                    str(last["status"] or "") == status
                    and _to_int(last["need_bytes"]) == need_bytes
                    and _to_int(last["need_files"]) == need_files
                    and _to_int(last["errors"]) == errors
                )
                too_soon = bool(last_dt and (observed_dt - last_dt).total_seconds() < min_spacing_seconds)
                if same_values and too_soon:
                    continue

            conn.execute(
                """
                INSERT INTO syncthing_folder_snapshots
                    (node_id, folder_id, node_name, folder_label, status, state,
                     need_bytes, need_files, errors, local_bytes, global_bytes,
                     state_changed, observed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    node_id,
                    folder_id,
                    str(f.get("node_name") or ""),
                    str(f.get("label") or f.get("id") or ""),
                    status,
                    str(f.get("state") or ""),
                    need_bytes,
                    need_files,
                    errors,
                    _to_int(f.get("localBytes")),
                    _to_int(f.get("globalBytes")),
                    str(f.get("stateChanged") or ""),
                    observed_at,
                ),
            )

        conn.execute(
            "DELETE FROM syncthing_folder_snapshots WHERE observed_at < ?",
            (cutoff,),
        )


def _enrich_folders_with_history(folders: List[Dict[str, Any]], now_iso: str, threshold_minutes: Optional[int] = None) -> None:
    if not folders:
        return

    now_dt = _utc_dt_from_iso(now_iso) or datetime.now(timezone.utc)
    if threshold_minutes is None:
        threshold_minutes = get_syncthing_stalled_threshold_minutes()
    since_cutoff = (now_dt - timedelta(hours=24)).replace(microsecond=0).isoformat()

    with db() as conn:
        for folder in folders:
            node_id = _to_int(folder.get("node_id"))
            folder_id = str(folder.get("id") or "").strip()
            if not node_id or not folder_id:
                continue

            rows = conn.execute(
                """
                SELECT status, need_bytes, errors, state_changed, observed_at
                FROM syncthing_folder_snapshots
                WHERE node_id=? AND folder_id=? AND observed_at>=?
                ORDER BY observed_at DESC
                LIMIT 288
                """,
                (node_id, folder_id, since_cutoff),
            ).fetchall()

            syncing_since: Optional[datetime] = None
            samples = len(rows)
            last_relevant_activity_at = ""
            last_relevant_activity_reason = ""

            # Última actividad relevante histórica:
            # - sincronización real con pendiente
            # - error
            # - evento real de archivo/carpeta observado por Syncthing
            # Se excluyen standby, scanning, paused y estados sin pendiente.
            for row in rows:
                status = str(row["status"] or "").lower()
                need_bytes = _to_int(row["need_bytes"])
                errors = _to_int(row["errors"])
                observed = _utc_dt_from_iso(row["observed_at"])
                state_changed = str(row["state_changed"] or "")

                reason = ""
                if status == "error" or errors > 0:
                    reason = "error"
                elif status == "syncing" and need_bytes > 0:
                    reason = "syncing"

                if reason:
                    relevant_dt = _utc_dt_from_iso(state_changed) or observed
                    last_relevant_activity_at = relevant_dt.isoformat() if relevant_dt else (state_changed or str(row["observed_at"] or ""))
                    last_relevant_activity_reason = reason
                    break

            file_event_row = conn.execute(
                """
                SELECT observed_at, event_time, 0 AS shared_fallback
                FROM syncthing_file_events
                WHERE node_id=? AND folder_id=?
                ORDER BY observed_at DESC
                LIMIT 1
                """,
                (node_id, folder_id),
            ).fetchone()
            if not file_event_row:
                file_event_row = conn.execute(
                    """
                    SELECT observed_at, event_time, 1 AS shared_fallback
                    FROM syncthing_file_events
                    WHERE folder_id=?
                    ORDER BY observed_at DESC
                    LIMIT 1
                    """,
                    (folder_id,),
                ).fetchone()
            if file_event_row:
                file_event_at_raw = str(file_event_row["observed_at"] or file_event_row["event_time"] or "")
                file_event_dt = _utc_dt_from_iso(file_event_at_raw)
                current_relevant_dt = _utc_dt_from_iso(last_relevant_activity_at)
                if file_event_dt and (not current_relevant_dt or file_event_dt > current_relevant_dt):
                    last_relevant_activity_at = file_event_dt.isoformat()
                    last_relevant_activity_reason = "file_event_shared" if _to_int(file_event_row["shared_fallback"]) else "file_event"
                elif file_event_at_raw and not last_relevant_activity_at:
                    last_relevant_activity_at = file_event_at_raw
                    last_relevant_activity_reason = "file_event_shared" if _to_int(file_event_row["shared_fallback"]) else "file_event"

            # Tiempo observado en sincronización actual continua.
            for row in rows:
                status = str(row["status"] or "").lower()
                need_bytes = _to_int(row["need_bytes"])
                observed = _utc_dt_from_iso(row["observed_at"])
                if status == "syncing" and need_bytes > 0 and observed:
                    syncing_since = observed
                    continue
                break

            minutes = 0
            if folder.get("status") == "syncing" and _to_int(folder.get("needBytes")) > 0 and syncing_since:
                minutes = max(0, int((now_dt - syncing_since).total_seconds() // 60))

            folder["history_samples_24h"] = samples
            folder["syncing_since_observed"] = syncing_since.isoformat() if syncing_since else ""
            folder["syncing_minutes_observed"] = minutes
            folder["stalled_candidate"] = bool(minutes >= threshold_minutes)
            folder["stalled_threshold_minutes"] = threshold_minutes
            folder["lastRelevantActivityAt"] = last_relevant_activity_at
            folder["lastRelevantActivityReason"] = last_relevant_activity_reason


def _folder_has_syncthing_error(folder: Dict[str, Any]) -> bool:
    errors_count = _to_int(folder.get("errors"))
    status = str(folder.get("status") or "").strip().lower()
    state = str(folder.get("state") or "").strip().lower()
    status_fetch_error = bool(folder.get("statusFetchError"))

    if status_fetch_error and status in {"", "unknown"} and state in {"", "unknown"}:
        # Error de lectura del estado, no error confirmado por Syncthing.
        return False

    return bool(
        errors_count > 0
        or status in {"error", "failed"}
        or state in {"error", "failed"}
    )


def _notify_syncthing_stalled_alerts(folders: List[Dict[str, Any]], observed_at: str) -> Dict[str, Any]:
    """
    Envía Discord para posibles atascos o errores reales de carpeta Syncthing,
    solo si persisten durante la ventana configurada, con cooldown por nodo+carpeta.

    La activación depende de Configuración → Notificaciones: notify_syncthing_stalled.
    """
    result = {"enabled": False, "sent": 0, "cooldown": 0, "errors": 0, "folder_errors": 0, "stalled": 0, "pending": 0}
    if not folders:
        return result

    discord_enabled = _cfg_bool("notify_syncthing_stalled", False)
    email_enabled = _cfg_bool("notify_email", False) and _cfg_bool("email_syncthing_stalled", False)

    if not discord_enabled and not email_enabled:
        return result

    result["enabled"] = True
    from routers.scans import discord_webhook_for_channel
    if discord_enabled and not discord_webhook_for_channel("alerts"):
        result["skipped_no_webhook"] = True
        if not email_enabled:
            return result

    cooldown_minutes = get_syncthing_stalled_alert_cooldown_minutes()
    persistence_minutes = _to_int(cfg("syncthing_alert_persistence_minutes", "20"))
    if persistence_minutes < 0:
        persistence_minutes = 20
    result["cooldown"] = cooldown_minutes
    result["persistence_minutes"] = persistence_minutes
    now_dt = _utc_dt_from_iso(observed_at) or datetime.now(timezone.utc)

    with db() as conn:
        for folder in folders:
            node_id = _to_int(folder.get("node_id"))
            folder_id = str(folder.get("id") or "").strip()
            if not node_id or not folder_id:
                continue

            remote_devices_offline = bool(folder.get("remoteDevicesOffline"))
            if remote_devices_offline:
                result["remote_offline_skipped"] = _to_int(result.get("remote_offline_skipped")) + 1
                continue

            is_error = _folder_has_syncthing_error(folder)
            is_stalled = bool(folder.get("stalled_candidate"))
            issue_state = "error" if is_error else ("stalled" if is_stalled else "ok")
            node_name = str(folder.get("node_name") or f"Nodo {node_id}")
            folder_label = str(folder.get("label") or folder_id)
            now_iso = observed_at

            row = conn.execute(
                """
                SELECT last_state, last_alert_at, first_issue_at
                FROM syncthing_stalled_alert_state
                WHERE node_id=? AND folder_id=?
                """,
                (node_id, folder_id),
            ).fetchone()

            if issue_state == "ok":
                if row and str(row["last_state"] or "") in {"stalled", "error"}:
                    conn.execute(
                        """
                        UPDATE syncthing_stalled_alert_state
                        SET last_state='ok', first_issue_at='', last_recovered_at=?, updated_at=?
                        WHERE node_id=? AND folder_id=?
                        """,
                        (now_iso, now_iso, node_id, folder_id),
                    )
                continue

            previous_state = str(row["last_state"] or "") if row else ""
            row_first_issue_at = str(row["first_issue_at"] or "") if row else ""
            first_issue_at = row_first_issue_at if previous_state == issue_state else ""
            if not first_issue_at:
                first_issue_at = now_iso

            first_issue_dt = _utc_dt_from_iso(first_issue_at) or now_dt
            active_minutes = max(0.0, (now_dt - first_issue_dt).total_seconds() / 60.0)

            if persistence_minutes > 0 and active_minutes < persistence_minutes:
                result["pending"] += 1
                conn.execute(
                    """
                    INSERT INTO syncthing_stalled_alert_state
                        (node_id, folder_id, node_name, folder_label, last_state,
                         first_issue_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(node_id, folder_id) DO UPDATE SET
                        node_name=excluded.node_name,
                        folder_label=excluded.folder_label,
                        last_state=excluded.last_state,
                        first_issue_at=excluded.first_issue_at,
                        updated_at=excluded.updated_at
                    """,
                    (node_id, folder_id, node_name, folder_label, issue_state, first_issue_at, now_iso),
                )
                continue

            last_alert_dt = _utc_dt_from_iso(row["last_alert_at"]) if row else None
            if last_alert_dt and cooldown_minutes > 0:
                elapsed_minutes = (now_dt - last_alert_dt).total_seconds() / 60.0
                if elapsed_minutes < cooldown_minutes:
                    conn.execute(
                        """
                        INSERT INTO syncthing_stalled_alert_state
                            (node_id, folder_id, node_name, folder_label, last_state,
                             first_issue_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(node_id, folder_id) DO UPDATE SET
                            node_name=excluded.node_name,
                            folder_label=excluded.folder_label,
                            last_state=excluded.last_state,
                            first_issue_at=excluded.first_issue_at,
                            updated_at=excluded.updated_at
                        """,
                        (node_id, folder_id, node_name, folder_label, issue_state, first_issue_at, now_iso),
                    )
                    continue

            minutes = _to_int(folder.get("syncing_minutes_observed"))
            threshold = _to_int(folder.get("stalled_threshold_minutes")) or get_syncthing_stalled_threshold_minutes()
            need_bytes = _to_int(folder.get("needBytes"))
            need_files = _to_int(folder.get("needFiles"))
            folder_errors = _to_int(folder.get("errors"))
            status = str(folder.get("status") or "—")
            state = str(folder.get("state") or "—")

            if is_error:
                result["folder_errors"] += 1
                msg = (
                    "🚨 **Syncthing Control · error de carpeta**\n"
                    f"- Nodo: **{node_name}**\n"
                    f"- Carpeta: **{folder_label}** (`{folder_id}`)\n"
                    f"- Estado: **{status}** / **{state}**\n"
                    f"- Errores reportados: **{folder_errors}**\n"
                    f"- Pendiente: **{_fmt_bytes_short(need_bytes)}** · **{need_files} ficheros**\n"
                    f"- Persistencia confirmada: **{int(active_minutes)} min** (umbral **{persistence_minutes} min**)\n"
                    f"- Cooldown: **{cooldown_minutes} min**"
                )
            else:
                result["stalled"] += 1
                msg = (
                    "⚠️ **Syncthing Control · posible atasco**\n"
                    f"- Nodo: **{node_name}**\n"
                    f"- Carpeta: **{folder_label}** (`{folder_id}`)\n"
                    f"- Observado sincronizando: **{minutes} min**\n"
                    f"- Umbral configurado: **{threshold} min**\n"
                    f"- Pendiente: **{_fmt_bytes_short(need_bytes)}** · **{need_files} ficheros**\n"
                    f"- Persistencia confirmada: **{int(active_minutes)} min** (umbral **{persistence_minutes} min**)\n"
                    f"- Cooldown: **{cooldown_minutes} min**"
                )

            ok = False
            err = ""

            if discord_enabled:
                try:
                    from routers.scans import discord_notify
                    ok, err = discord_notify(msg, channel="alerts")
                except Exception as exc:
                    err = repr(exc)

                if ok:
                    result["sent"] += 1
                else:
                    result["errors"] += 1

            if email_enabled:
                try:
                    from routers.config_api import send_email
                    email_ok, email_err = send_email("🔁 Syncthing Control — alerta Auditor IPs", msg)
                    if email_ok:
                        result["sent"] += 1
                    elif email_err:
                        result["errors"] += 1
                except Exception:
                    result["errors"] += 1

            conn.execute(
                """
                INSERT INTO syncthing_stalled_alert_state
                    (node_id, folder_id, node_name, folder_label, last_state,
                     first_issue_at, last_alert_at, last_error, alert_count, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(node_id, folder_id) DO UPDATE SET
                    node_name=excluded.node_name,
                    folder_label=excluded.folder_label,
                    last_state=excluded.last_state,
                    first_issue_at=excluded.first_issue_at,
                    last_alert_at=excluded.last_alert_at,
                    last_error=excluded.last_error,
                    alert_count=syncthing_stalled_alert_state.alert_count + 1,
                    updated_at=excluded.updated_at
                """,
                (node_id, folder_id, node_name, folder_label, issue_state, first_issue_at, now_iso, str(err or "")[:1000], now_iso),
            )

    return result


def _need_item_public(item: Any) -> Dict[str, Any]:
    if not isinstance(item, dict):
        return {}
    return {
        "name": str(item.get("name") or ""),
        "size": _to_int(item.get("size")),
        "type": str(item.get("type") or ""),
        "modified": str(item.get("modified") or ""),
        "modifiedBy": str(item.get("modifiedBy") or ""),
        "deleted": bool(item.get("deleted")),
        "ignored": bool(item.get("ignored")),
        "invalid": bool(item.get("invalid")),
        "mustRescan": bool(item.get("mustRescan")),
        "sequence": _to_int(item.get("sequence")),
    }


def _need_payload_public(raw: Any, per_group_limit: int = 80) -> Dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    out: Dict[str, Any] = {
        "progress": [],
        "queued": [],
        "rest": [],
        "counts": {"progress": 0, "queued": 0, "rest": 0, "total": 0},
        "bytes": {"progress": 0, "queued": 0, "rest": 0, "total": 0},
        "error": "",
    }

    for key in ("progress", "queued", "rest"):
        items = data.get(key) if isinstance(data.get(key), list) else []
        public = [_need_item_public(x) for x in items]
        public = [x for x in public if x.get("name")]
        out["counts"][key] = len(public)
        out["bytes"][key] = sum(_to_int(x.get("size")) for x in public)
        out[key] = public[:per_group_limit]

    out["counts"]["total"] = out["counts"]["progress"] + out["counts"]["queued"] + out["counts"]["rest"]
    out["bytes"]["total"] = out["bytes"]["progress"] + out["bytes"]["queued"] + out["bytes"]["rest"]
    return out


def _http_json(node: Dict[str, Any], path: str, query: Optional[Dict[str, Any]] = None) -> Tuple[Optional[Any], Optional[str]]:
    base = _clean_url(node.get("api_base_url"))
    if not base:
        return None, "URL API vacía"

    url = f"{base}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)

    headers = {"User-Agent": "AuditorIPs-SyncthingControl/1.0"}
    api_key = str(node.get("api_key") or "").strip()
    if api_key:
        headers["X-API-Key"] = api_key

    req = urllib.request.Request(url, headers=headers)
    timeout = _as_timeout(node.get("timeout_s"))
    ctx = None
    if url.lower().startswith("https://") and not bool(node.get("verify_tls")):
        ctx = ssl._create_unverified_context()

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(10 * 1024 * 1024).decode("utf-8", errors="replace")
            if not body.strip():
                return {}, None
            return json.loads(body), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return None, str(e.reason)[:180]
    except Exception as e:
        return None, str(e)[:180]


def _device_name_map(devices: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for dev in devices if isinstance(devices, list) else []:
        if not isinstance(dev, dict):
            continue
        dev_id = str(dev.get("deviceID") or "").strip()
        if not dev_id:
            continue
        out[dev_id] = str(dev.get("name") or dev_id[:12]).strip()
    return out


def _folder_status(
    folder: Dict[str, Any],
    db_status: Dict[str, Any],
    devices_by_id: Dict[str, str],
    connected_device_ids: Optional[set] = None,
) -> Dict[str, Any]:
    folder_id = str(folder.get("id") or "").strip()
    state = str(db_status.get("state") or "").strip() or "unknown"
    paused = bool(folder.get("paused"))
    need_bytes = _to_int(db_status.get("needBytes"))
    need_files = _to_int(db_status.get("needFiles"))
    need_dirs = _to_int(db_status.get("needDirectories"))
    need_deletes = _to_int(db_status.get("needDeletes"))
    err_count = _error_count(db_status.get("errors"))

    state_l = state.lower()
    status_fetch_error = bool(db_status.get("_status_fetch_error"))
    has_pending = need_bytes > 0 or need_files > 0 or need_dirs > 0 or need_deletes > 0
    is_scanning = (
        state_l.startswith("scan")
        or "scann" in state_l
        or "escan" in state_l
    )

    if paused:
        status = "paused"
    elif status_fetch_error:
        # Fallo puntual consultando /rest/db/status de esta carpeta.
        # No debe convertirse en error real de carpeta ni disparar Discord.
        status = "unknown"
    elif err_count > 0:
        status = "error"
    elif is_scanning:
        # La API de Syncthing suele devolver estados técnicos en inglés,
        # aunque la GUI esté traducida. Si el estado indica escaneo,
        # debe prevalecer sobre el pendiente.
        status = "scanning"
    elif has_pending:
        status = "syncing"
    elif state_l != "idle":
        # Otros estados no-idle conservadores: cleaning, preparing, etc.
        status = "scanning"
    else:
        status = "standby"

    connected_device_ids = connected_device_ids or set()
    folder_devices: List[Dict[str, Any]] = []
    remote_devices_total = 0
    remote_devices_connected = 0
    for dev in folder.get("devices") or []:
        dev_id = str((dev or {}).get("deviceID") or "").strip()
        if dev_id:
            is_connected = dev_id in connected_device_ids
            remote_devices_total += 1
            if is_connected:
                remote_devices_connected += 1
            folder_devices.append({
                "device_id": dev_id,
                "name": devices_by_id.get(dev_id, dev_id[:12]),
                "connected": is_connected,
            })

    remote_devices_offline = remote_devices_total > 0 and remote_devices_connected == 0

    return {
        "node_id": None,
        "id": folder_id,
        "label": str(folder.get("label") or folder_id),
        "path": str(folder.get("path") or ""),
        "type": str(folder.get("type") or ""),
        "paused": paused,
        "state": state,
        "status": status,
        "needBytes": need_bytes,
        "needFiles": need_files,
        "needDirectories": need_dirs,
        "needDeletes": need_deletes,
        "globalBytes": _to_int(db_status.get("globalBytes")),
        "localBytes": _to_int(db_status.get("localBytes")),
        "errors": err_count,
        "statusFetchError": status_fetch_error,
        "stateChanged": str(db_status.get("stateChanged") or ""),
        "rescanIntervalS": _to_int(folder.get("rescanIntervalS")),
        "fsWatcherEnabled": bool(folder.get("fsWatcherEnabled")),
        "devices": folder_devices,
        "remoteDevicesTotal": remote_devices_total,
        "remoteDevicesConnected": remote_devices_connected,
        "remoteDevicesOffline": remote_devices_offline,
    }


def _probe_node(node: Dict[str, Any]) -> Dict[str, Any]:
    public = _row_public(node)
    node_id = int(node["id"])

    errors: List[str] = []

    system_status, err = _http_json(node, "/rest/system/status")
    if err:
        return {
            "node": public,
            "status": "offline",
            "ok": False,
            "error": err,
            "folders": [],
            "devices": [],
            "connections": {},
            "errors": [],
            "summary": {
                "folders_total": 0,
                "folders_syncing": 0,
                "folders_standby": 0,
                "folders_paused": 0,
                "folders_error": 0,
                "needBytes": 0,
                "needFiles": 0,
            },
            "checked_at": utc_now_iso(),
        }

    system_version, err = _http_json(node, "/rest/system/version")
    if err:
        system_version = {}

    folders_cfg, err = _http_json(node, "/rest/config/folders")
    if err:
        errors.append(f"folders: {err}")
        folders_cfg = []

    devices_cfg, err = _http_json(node, "/rest/config/devices")
    if err:
        errors.append(f"devices: {err}")
        devices_cfg = []

    connections, err = _http_json(node, "/rest/system/connections")
    if err:
        errors.append(f"connections: {err}")
        connections = {}

    active_errors, err = _http_json(node, "/rest/system/error")
    if err:
        errors.append(f"errors: {err}")
        active_errors = {"errors": []}

    events, err = _http_json(node, "/rest/events", {"limit": 50})
    if err:
        events = []

    disk_events, err = _http_json(node, "/rest/events/disk", {"limit": 100, "since": 0})
    if err:
        disk_events = []

    devices_by_id = _device_name_map(devices_cfg)
    conns = connections if isinstance(connections, dict) else {}
    raw_conns = conns.get("connections") if isinstance(conns.get("connections"), dict) else {}
    connected_device_ids = {
        str(dev_id or "").strip()
        for dev_id, conn in raw_conns.items()
        if str(dev_id or "").strip() and isinstance(conn, dict) and bool(conn.get("connected"))
    }
    folders: List[Dict[str, Any]] = []

    for folder in folders_cfg if isinstance(folders_cfg, list) else []:
        if not isinstance(folder, dict):
            continue
        folder_id = str(folder.get("id") or "").strip()
        db_status: Dict[str, Any] = {}
        if folder_id:
            raw_status, st_err = _http_json(node, "/rest/db/status", {"folder": folder_id})
            if st_err:
                db_status = {"state": "unknown", "errors": 0, "_status_fetch_error": True}
                errors.append(f"db/status {folder_id}: {st_err}")
            elif isinstance(raw_status, dict):
                db_status = raw_status

        item = _folder_status(folder, db_status, devices_by_id, connected_device_ids)
        item["node_id"] = node_id
        item["node_name"] = public["name"]
        folders.append(item)

    folder_counts = {
        "folders_total": len(folders),
        "folders_syncing": sum(1 for f in folders if f["status"] == "syncing"),
        "folders_scanning": sum(1 for f in folders if f["status"] == "scanning"),
        "folders_standby": sum(1 for f in folders if f["status"] == "standby"),
        "folders_paused": sum(1 for f in folders if f["status"] == "paused"),
        "folders_error": sum(1 for f in folders if f["status"] == "error"),
        "needBytes": sum(_to_int(f.get("needBytes")) for f in folders),
        "needFiles": sum(_to_int(f.get("needFiles")) for f in folders),
    }

    active_error_count = _error_count(active_errors.get("errors") if isinstance(active_errors, dict) else active_errors)
    if active_error_count > 0 or folder_counts["folders_error"] > 0 or errors:
        status = "error"
    elif folder_counts["folders_syncing"] > 0:
        status = "syncing"
    elif folder_counts.get("folders_scanning", 0) > 0:
        status = "scanning"
    else:
        status = "standby"

    connected_devices = 0
    disconnected_devices = 0
    total_in_bytes = 0
    total_out_bytes = 0
    remote_transfer_devices: List[Dict[str, Any]] = []
    for dev_id, conn in raw_conns.items():
        if not isinstance(conn, dict):
            continue
        remote_device_id = str(dev_id or "").strip()
        connected = bool(conn.get("connected"))
        rx_total = _to_int(conn.get("inBytesTotal"))
        tx_total = _to_int(conn.get("outBytesTotal"))

        if connected:
            connected_devices += 1
        else:
            disconnected_devices += 1
        total_in_bytes += rx_total
        total_out_bytes += tx_total

        if remote_device_id:
            remote_transfer_devices.append({
                "remote_device_id": remote_device_id,
                "remote_device_name": devices_by_id.get(remote_device_id, remote_device_id[:12]),
                "connected": connected,
                "rxTotalBytes": rx_total,
                "txTotalBytes": tx_total,
            })

    return {
        "node": {
            **public,
            "status": status,
            "version": str((system_version or {}).get("version") or (system_status or {}).get("version") or ""),
            "uptime": _to_int((system_status or {}).get("uptime")),
            "myID": str((system_status or {}).get("myID") or ""),
            "checked_at": utc_now_iso(),
            "connected_devices": connected_devices,
            "disconnected_devices": disconnected_devices,
            "inBytesTotal": total_in_bytes,
            "outBytesTotal": total_out_bytes,
            "remoteTransferDevices": remote_transfer_devices,
        },
        "status": status,
        "ok": True,
        "error": "; ".join(errors),
        "folders": folders,
        "devices": devices_cfg if isinstance(devices_cfg, list) else [],
        "connections": connections if isinstance(connections, dict) else {},
        "errors": active_errors.get("errors") if isinstance(active_errors, dict) else active_errors,
        "events": events if isinstance(events, list) else [],
        "disk_events": disk_events if isinstance(disk_events, list) else [],
        "summary": folder_counts,
        "checked_at": utc_now_iso(),
    }



def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: Any, fallback: Any) -> Any:
    try:
        return json.loads(str(raw or ""))
    except Exception:
        return fallback


def _read_syncthing_overview_cache() -> Optional[Dict[str, Any]]:
    ensure_syncthing_schema()
    with db() as conn:
        row = conn.execute(
            """
            SELECT summary_json, nodes_json, folders_json, results_json,
                   refreshed_at, status, error
            FROM syncthing_overview_cache
            WHERE id=1
            """
        ).fetchone()

    if not row:
        return None

    summary = _json_loads(row["summary_json"], {})
    if isinstance(summary, dict) and row["refreshed_at"]:
        summary.setdefault("last_refresh", row["refreshed_at"])
        summary.setdefault("refresh_interval_seconds", get_syncthing_refresh_interval_seconds())

    return {
        "ok": True,
        "cached": True,
        "cache_status": str(row["status"] or "cached"),
        "cache_error": str(row["error"] or ""),
        "cache_refreshed_at": str(row["refreshed_at"] or ""),
        "summary": summary if isinstance(summary, dict) else {},
        "nodes": _json_loads(row["nodes_json"], []),
        "folders": _json_loads(row["folders_json"], []),
        "results": _json_loads(row["results_json"], []),
    }


def _write_syncthing_overview_cache(data: Dict[str, Any], status: str = "ok", error: str = "") -> None:
    ensure_syncthing_schema()
    now = utc_now_iso()
    refreshed_at = str((data.get("summary") or {}).get("last_refresh") or now)
    with db() as conn:
        conn.execute(
            """
            INSERT INTO syncthing_overview_cache
                (id, summary_json, nodes_json, folders_json, results_json,
                 refreshed_at, status, error, created_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                summary_json=excluded.summary_json,
                nodes_json=excluded.nodes_json,
                folders_json=excluded.folders_json,
                results_json=excluded.results_json,
                refreshed_at=excluded.refreshed_at,
                status=excluded.status,
                error=excluded.error,
                updated_at=excluded.updated_at
            """,
            (
                _json_dumps(data.get("summary") or {}),
                _json_dumps(data.get("nodes") or []),
                _json_dumps(data.get("folders") or []),
                _json_dumps(data.get("results") or []),
                refreshed_at,
                status,
                error,
                now,
                now,
            ),
        )


def _mark_syncthing_cache_error(error: str) -> None:
    ensure_syncthing_schema()
    with db() as conn:
        conn.execute(
            """
            UPDATE syncthing_overview_cache
            SET status='stale_after_error', error=?, updated_at=?
            WHERE id=1
            """,
            (str(error or "")[:1000], utc_now_iso()),
        )


def _build_syncthing_overview_live() -> Dict[str, Any]:
    ensure_syncthing_schema()
    with db() as conn:
        rows = conn.execute("""
            SELECT *
            FROM syncthing_nodes
            WHERE enabled=1
            ORDER BY name COLLATE NOCASE ASC
        """).fetchall()

    results = [_probe_node(dict(row)) for row in rows]
    nodes = [r.get("node", {}) for r in results]
    folders = []
    for result in results:
        folders.extend(result.get("folders") or [])

    observed_at = utc_now_iso()
    _save_folder_snapshots(folders, observed_at)
    _enrich_folders_with_history(folders, observed_at)
    stalled_alerts = _notify_syncthing_stalled_alerts(folders, observed_at)
    _save_transfer_snapshots(nodes, observed_at)
    _enrich_nodes_with_relevant_state(nodes, folders, observed_at)
    file_events = _save_file_events(results, observed_at)

    active_transfer_nodes = [n for n in nodes if n.get("isTransferring")]

    summary = {
        "nodes_total": len(nodes),
        "nodes_online": sum(1 for n in nodes if n.get("status") in {"standby", "syncing", "error"}),
        "nodes_offline": sum(1 for n in nodes if n.get("status") == "offline"),
        "nodes_syncing": sum(1 for n in nodes if n.get("status") == "syncing"),
        "nodes_transferring": len(active_transfer_nodes),
        "nodes_error": sum(1 for n in nodes if n.get("status") == "error"),
        "rxBytesPerSecond": round(sum(float(n.get("rxBytesPerSecond") or 0) for n in active_transfer_nodes), 2),
        "txBytesPerSecond": round(sum(float(n.get("txBytesPerSecond") or 0) for n in active_transfer_nodes), 2),
        "transferActiveThresholdBps": get_syncthing_transfer_active_threshold_bps(),
        "transferActiveMinDeltaBytes": get_syncthing_transfer_active_min_delta_bytes(),
        "folders_total": len(folders),
        "folders_syncing": sum(1 for f in folders if f.get("status") == "syncing"),
        "folders_scanning": sum(1 for f in folders if f.get("status") == "scanning"),
        "folders_standby": sum(1 for f in folders if f.get("status") == "standby"),
        "folders_paused": sum(1 for f in folders if f.get("status") == "paused"),
        "folders_error": sum(1 for f in folders if f.get("status") == "error"),
        "folders_stalled_candidate": sum(1 for f in folders if f.get("stalled_candidate")),
        "stalledAlertsEnabled": bool(stalled_alerts.get("enabled")),
        "stalledAlertsSent": _to_int(stalled_alerts.get("sent")),
        "stalledAlertsErrors": _to_int(stalled_alerts.get("errors")),
        "stalledAlertsFolderErrors": _to_int(stalled_alerts.get("folder_errors")),
        "stalledAlertsStalled": _to_int(stalled_alerts.get("stalled")),
        "stalledAlertsSkippedNoWebhook": bool(stalled_alerts.get("skipped_no_webhook")),
        "stalledAlertCooldownMinutes": get_syncthing_stalled_alert_cooldown_minutes(),
        "fileEventsInserted": _to_int(file_events.get("inserted")),
        "fileEventsSkipped": _to_int(file_events.get("skipped")),
        "storeFileNames": get_syncthing_store_file_names(),
        "fileNameRetentionDays": get_syncthing_file_name_retention_days(),
        "needBytes": sum(_to_int(f.get("needBytes")) for f in folders),
        "needFiles": sum(_to_int(f.get("needFiles")) for f in folders),
        "last_refresh": observed_at,
        "refresh_interval_seconds": get_syncthing_refresh_interval_seconds(),
    }

    return {
        "ok": True,
        "cached": False,
        "cache_status": "fresh",
        "cache_error": "",
        "cache_refreshed_at": observed_at,
        "summary": summary,
        "nodes": nodes,
        "folders": folders,
        "results": results,
    }


def refresh_syncthing_overview_cache(force: bool = False) -> Dict[str, Any]:
    ensure_syncthing_schema()

    acquired = _syncthing_refresh_lock.acquire(blocking=False)
    if not acquired:
        cached = _read_syncthing_overview_cache()
        if cached:
            cached["refresh_in_progress"] = True
            return cached
        return {"ok": False, "error": "Refresco Syncthing ya en curso", "refresh_in_progress": True}

    try:
        data = _build_syncthing_overview_live()
        _write_syncthing_overview_cache(data, status="ok", error="")
        return data
    except Exception as exc:
        cached = _read_syncthing_overview_cache()
        if cached:
            _mark_syncthing_cache_error(str(exc))
            cached["cache_status"] = "stale_after_error"
            cached["cache_error"] = str(exc)
            return cached
        return {"ok": False, "error": str(exc)}
    finally:
        _syncthing_refresh_lock.release()

# ══════════════════════════════════════════════════════════════
#  API local de nodos
# ══════════════════════════════════════════════════════════════



def _transfer_chart_bucket_minutes(hours: int) -> int:
    if hours <= 24:
        return 5
    if hours <= 168:
        return 30
    return 120


@router.get("/api/syncthing/transfer-chart")
def api_syncthing_transfer_chart(
    node_id: int = Query(0),
    hours: int = Query(24, ge=1, le=720),
):
    """
    Serie agregada para gráficas Syncthing.
    Evita depender de límites por filas crudas y devuelve buckets acotados.
    """
    ensure_syncthing_schema()

    safe_hours = max(1, min(int(hours or 24), 720))
    bucket_minutes = _transfer_chart_bucket_minutes(safe_hours)
    bucket_seconds = bucket_minutes * 60
    now_dt = datetime.now(timezone.utc)
    since_dt = (now_dt - timedelta(hours=safe_hours)).replace(microsecond=0)
    since = since_dt.isoformat()

    where = "WHERE observed_at >= ?"
    params: List[Any] = [since]
    if node_id > 0:
        where += " AND node_id = ?"
        params.append(node_id)

    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT node_id, node_name, rx_delta_bytes, tx_delta_bytes,
                   interval_seconds, rx_bps, tx_bps, observed_at
            FROM syncthing_transfer_snapshots
            {where}
            ORDER BY observed_at ASC
            """,
            tuple(params),
        ).fetchall()

    buckets: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        observed = _utc_dt_from_iso(row["observed_at"])
        if not observed:
            continue
        bucket_ts = int(observed.timestamp() // bucket_seconds) * bucket_seconds
        current = buckets.get(bucket_ts)
        if not current:
            current = {
                "bucket_ts": bucket_ts,
                "observed_at": datetime.fromtimestamp(bucket_ts, tz=timezone.utc).isoformat(),
                "rx_bps_sum": 0.0,
                "tx_bps_sum": 0.0,
                "rx_bps_max": 0.0,
                "tx_bps_max": 0.0,
                "total_bps_max": 0.0,
                "rx_delta_bytes": 0,
                "tx_delta_bytes": 0,
                "samples": 0,
            }
            buckets[bucket_ts] = current

        row_rx_bps = float(row["rx_bps"] or 0)
        row_tx_bps = float(row["tx_bps"] or 0)
        current["rx_bps_sum"] += row_rx_bps
        current["tx_bps_sum"] += row_tx_bps
        current["rx_bps_max"] = max(float(current.get("rx_bps_max") or 0), row_rx_bps)
        current["tx_bps_max"] = max(float(current.get("tx_bps_max") or 0), row_tx_bps)
        current["total_bps_max"] = max(float(current.get("total_bps_max") or 0), row_rx_bps + row_tx_bps)
        current["rx_delta_bytes"] += int(row["rx_delta_bytes"] or 0)
        current["tx_delta_bytes"] += int(row["tx_delta_bytes"] or 0)
        current["samples"] += 1

    points = []
    for item in sorted(buckets.values(), key=lambda v: v["bucket_ts"]):
        samples = max(1, int(item["samples"] or 0))
        rx_bps = float(item.get("rx_bps_max") or 0)
        tx_bps = float(item.get("tx_bps_max") or 0)
        total_bps = float(item.get("total_bps_max") or (rx_bps + tx_bps))
        points.append({
            "observed_at": item["observed_at"],
            "rx_bps": round(rx_bps, 2),
            "tx_bps": round(tx_bps, 2),
            "total_bps": round(total_bps, 2),
            "rx_delta_bytes": int(item["rx_delta_bytes"] or 0),
            "tx_delta_bytes": int(item["tx_delta_bytes"] or 0),
            "total_delta_bytes": int(item["rx_delta_bytes"] or 0) + int(item["tx_delta_bytes"] or 0),
            "samples": samples,
        })

    raw_max_rx_bps = max((float(row["rx_bps"] or 0) for row in rows), default=0.0)
    raw_max_tx_bps = max((float(row["tx_bps"] or 0) for row in rows), default=0.0)
    raw_max_total_bps = max(((float(row["rx_bps"] or 0) + float(row["tx_bps"] or 0)) for row in rows), default=0.0)
    raw_max_rx_delta_bytes = max((int(row["rx_delta_bytes"] or 0) for row in rows), default=0)
    raw_max_tx_delta_bytes = max((int(row["tx_delta_bytes"] or 0) for row in rows), default=0)
    raw_max_total_delta_bytes = max(((int(row["rx_delta_bytes"] or 0) + int(row["tx_delta_bytes"] or 0)) for row in rows), default=0)
    raw_total_rx_delta_bytes = sum(int(row["rx_delta_bytes"] or 0) for row in rows)
    raw_total_tx_delta_bytes = sum(int(row["tx_delta_bytes"] or 0) for row in rows)
    raw_total_delta_bytes = raw_total_rx_delta_bytes + raw_total_tx_delta_bytes

    summary = {
        "samples": len(points),
        "raw_samples": len(rows),
        "node_id": node_id,
        "hours": safe_hours,
        "bucket_minutes": bucket_minutes,
        "first_observed_at": points[0]["observed_at"] if points else "",
        "last_observed_at": points[-1]["observed_at"] if points else "",
        "max_rx_bps": round(raw_max_rx_bps, 2),
        "max_tx_bps": round(raw_max_tx_bps, 2),
        "max_total_bps": round(raw_max_total_bps, 2),
        "max_rx_delta_bytes": raw_max_rx_delta_bytes,
        "max_tx_delta_bytes": raw_max_tx_delta_bytes,
        "max_total_delta_bytes": raw_max_total_delta_bytes,
        "total_rx_delta_bytes": raw_total_rx_delta_bytes,
        "total_tx_delta_bytes": raw_total_tx_delta_bytes,
        "total_delta_bytes": raw_total_delta_bytes,
    }

    return {"ok": True, "summary": summary, "points": points}


@router.get("/api/syncthing/transfer-history")
def api_syncthing_transfer_history(
    node_id: int = Query(0),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(300, ge=10, le=1000),
):
    """
    Histórico local de transferencia Syncthing por nodo.
    Devuelve snapshots ya limitados para alimentar gráficas sin cargar series grandes.
    """
    ensure_syncthing_schema()
    now_dt = datetime.now(timezone.utc)
    since = (now_dt - timedelta(hours=max(1, min(int(hours or 24), 720)))).replace(microsecond=0).isoformat()

    where = "WHERE observed_at >= ?"
    params: List[Any] = [since]
    if node_id > 0:
        where += " AND node_id = ?"
        params.append(node_id)

    params.append(max(10, min(int(limit or 300), 1000)))

    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT node_id, node_name, status, connected_devices, disconnected_devices,
                   rx_total_bytes, tx_total_bytes, rx_delta_bytes, tx_delta_bytes,
                   interval_seconds, rx_bps, tx_bps, observed_at
            FROM syncthing_transfer_snapshots
            {where}
            ORDER BY observed_at DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()

    transfer_threshold_bps = get_syncthing_transfer_active_threshold_bps()
    transfer_min_delta_bytes = get_syncthing_transfer_active_min_delta_bytes()
    items = []
    for row in reversed(rows):
        rx_bps = float(row["rx_bps"] or 0)
        tx_bps = float(row["tx_bps"] or 0)
        total_bps = rx_bps + tx_bps
        rx_delta_bytes = int(row["rx_delta_bytes"] or 0)
        tx_delta_bytes = int(row["tx_delta_bytes"] or 0)
        total_delta_bytes = rx_delta_bytes + tx_delta_bytes
        interval_seconds = int(row["interval_seconds"] or 0)
        is_transferring = bool(
            interval_seconds >= 20
            and total_bps >= transfer_threshold_bps
            and total_delta_bytes >= transfer_min_delta_bytes
        )
        items.append({
            "node_id": int(row["node_id"] or 0),
            "node_name": str(row["node_name"] or ""),
            "status": str(row["status"] or ""),
            "connected_devices": int(row["connected_devices"] or 0),
            "disconnected_devices": int(row["disconnected_devices"] or 0),
            "rx_total_bytes": int(row["rx_total_bytes"] or 0),
            "tx_total_bytes": int(row["tx_total_bytes"] or 0),
            "rx_delta_bytes": rx_delta_bytes,
            "tx_delta_bytes": tx_delta_bytes,
            "total_delta_bytes": total_delta_bytes,
            "interval_seconds": interval_seconds,
            "rx_bps": round(rx_bps, 2),
            "tx_bps": round(tx_bps, 2),
            "total_bps": round(total_bps, 2),
            "transfer_active_threshold_bps": transfer_threshold_bps,
            "transfer_active_min_delta_bytes": transfer_min_delta_bytes,
            "transferring": is_transferring,
            "observed_at": str(row["observed_at"] or ""),
        })

    summary = {
        "samples": len(items),
        "node_id": node_id,
        "hours": hours,
        "max_rx_bps": round(max((float(i["rx_bps"]) for i in items), default=0.0), 2),
        "max_tx_bps": round(max((float(i["tx_bps"]) for i in items), default=0.0), 2),
        "max_total_bps": round(max((float(i["total_bps"]) for i in items), default=0.0), 2),
        "transfer_active_threshold_bps": transfer_threshold_bps,
        "transfer_active_min_delta_bytes": transfer_min_delta_bytes,
        "transferring_samples": sum(1 for i in items if i.get("transferring")),
        "last_observed_at": items[-1]["observed_at"] if items else "",
    }

    return {"ok": True, "summary": summary, "items": items}


@router.get("/api/syncthing/file-events")
def api_syncthing_file_events(
    q: str = Query("", max_length=120),
    node_id: int = Query(0),
    folder_id: str = Query("", max_length=255),
    event_type: str = Query("", max_length=80),
    action: str = Query("", max_length=80),
    confirmation: str = Query("", max_length=40),
    hours: int = Query(168),
    limit: int = Query(200),
):
    """
    Histórico global de archivos Syncthing observado desde eventos ItemFinished.

    No expone rutas completas. item_name puede venir vacío por política de privacidad.
    """
    ensure_syncthing_schema()

    safe_hours = max(1, min(int(hours or 168), 24 * 90))
    safe_limit = max(1, min(int(limit or 200), 1000))
    since = (datetime.now(timezone.utc) - timedelta(hours=safe_hours)).replace(microsecond=0).isoformat()

    clauses = ["observed_at >= ?"]
    params: List[Any] = [since]

    if node_id:
        clauses.append("node_id = ?")
        params.append(int(node_id))
    if folder_id:
        clauses.append("folder_id = ?")
        params.append(folder_id.strip())
    if event_type:
        clauses.append("event_type = ?")
        params.append(event_type.strip())
    if action:
        clauses.append("action = ?")
        params.append(action.strip())
    if confirmation:
        clauses.append("confirmation = ?")
        params.append(confirmation.strip())

    query = str(q or "").strip()
    if query:
        like = f"%{query}%"
        clauses.append("(node_name LIKE ? OR folder_label LIKE ? OR item_name LIKE ? OR item_hash LIKE ? OR origin_node_name LIKE ? OR origin_device_name LIKE ? OR origin_device_id LIKE ?)")
        params.extend([like, like, like, like, like, like, like])

    where_sql = " AND ".join(clauses)

    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT id, node_id, node_name, event_id, global_id, event_type,
                   event_time, observed_at, folder_id, folder_label,
                   item_name, item_hash, item_type, action, error, confirmation,
                   origin_device_id, origin_node_id, origin_node_name,
                   origin_device_name, origin_confidence, origin_source
            FROM syncthing_file_events
            WHERE {where_sql}
            ORDER BY COALESCE(NULLIF(event_time, ''), observed_at) DESC, id DESC
            LIMIT ?
            """,
            (*params, safe_limit),
        ).fetchall()

        node_rows = conn.execute(
            """
            SELECT node_id, node_name, COUNT(*) AS total
            FROM syncthing_file_events
            WHERE observed_at >= ?
            GROUP BY node_id, node_name
            ORDER BY node_name COLLATE NOCASE ASC
            """,
            (since,),
        ).fetchall()

        folder_rows = conn.execute(
            """
            SELECT folder_id, folder_label, COUNT(*) AS total
            FROM syncthing_file_events
            WHERE observed_at >= ?
            GROUP BY folder_id, folder_label
            ORDER BY folder_label COLLATE NOCASE ASC
            """,
            (since,),
        ).fetchall()

        type_rows = conn.execute(
            """
            SELECT event_type, action, confirmation, COUNT(*) AS total
            FROM syncthing_file_events
            WHERE observed_at >= ?
            GROUP BY event_type, action, confirmation
            ORDER BY total DESC
            """,
            (since,),
        ).fetchall()

    items = [dict(row) for row in rows]
    return {
        "ok": True,
        "items": items,
        "summary": {
            "total_returned": len(items),
            "hours": safe_hours,
            "limit": safe_limit,
            "store_file_names": get_syncthing_store_file_names(),
            "file_name_retention_days": get_syncthing_file_name_retention_days(),
        },
        "filters": {
            "nodes": [dict(row) for row in node_rows],
            "folders": [dict(row) for row in folder_rows],
            "types": [dict(row) for row in type_rows],
        },
    }


@router.get("/api/syncthing/nodes")
def api_syncthing_nodes():
    ensure_syncthing_schema()
    with db() as conn:
        rows = conn.execute("""
            SELECT *
            FROM syncthing_nodes
            ORDER BY enabled DESC, name COLLATE NOCASE ASC
        """).fetchall()
    return {"ok": True, "nodes": [_row_public(r) for r in rows]}


@router.post("/api/syncthing/nodes")
def api_syncthing_node_create(payload: Dict[str, Any] = Body(...)):
    ensure_syncthing_schema()

    name = _clean_text(payload.get("name"), 120)
    api_base_url, api_url_error = _clean_syncthing_url(payload.get("api_base_url"), required=True, field_label="URL API")
    gui_url, gui_url_error = _clean_syncthing_url(payload.get("gui_url"), required=False, field_label="URL GUI")
    if api_url_error:
        return JSONResponse({"ok": False, "error": api_url_error}, status_code=400)
    if gui_url_error:
        return JSONResponse({"ok": False, "error": gui_url_error}, status_code=400)
    api_key = _clean_text(payload.get("api_key"), 500)
    verify_tls = _as_bool_int(payload.get("verify_tls"), default=False)
    enabled = _as_bool_int(payload.get("enabled"), default=True)
    timeout_s = _as_timeout(payload.get("timeout_s"))
    notes = _clean_text(payload.get("notes"), 1000)
    now = utc_now_iso()

    if not name or not api_base_url:
        return JSONResponse({"ok": False, "error": "Nombre y URL API son obligatorios"}, status_code=400)
    if not api_key:
        return JSONResponse({"ok": False, "error": "API key obligatoria"}, status_code=400)

    with db() as conn:
        existing = conn.execute(
            """
            SELECT id, name
            FROM syncthing_nodes
            WHERE lower(api_base_url)=lower(?)
            LIMIT 1
            """,
            (api_base_url,),
        ).fetchone()
        if existing:
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"Ya existe un nodo Syncthing con esa URL API: {existing['name']} (id {existing['id']})",
                },
                status_code=409,
            )

        cur = conn.execute("""
            INSERT INTO syncthing_nodes
                (name, api_base_url, gui_url, api_key, verify_tls, enabled, timeout_s, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (name, api_base_url, gui_url, api_key, verify_tls, enabled, timeout_s, notes, now, now))
        node_id = cur.lastrowid
        _invalidate_syncthing_overview_cache(conn)

    return {"ok": True, "id": node_id}


@router.put("/api/syncthing/nodes/{node_id}")
def api_syncthing_node_update(node_id: int, payload: Dict[str, Any] = Body(...)):
    ensure_syncthing_schema()
    current = _load_node(node_id)
    if not current:
        return JSONResponse({"ok": False, "error": "Nodo Syncthing no encontrado"}, status_code=404)

    name = _clean_text(payload.get("name", current["name"]), 120)
    api_base_url, api_url_error = _clean_syncthing_url(payload.get("api_base_url", current["api_base_url"]), required=True, field_label="URL API")
    gui_url, gui_url_error = _clean_syncthing_url(payload.get("gui_url", current.get("gui_url", "")), required=False, field_label="URL GUI")
    if api_url_error:
        return JSONResponse({"ok": False, "error": api_url_error}, status_code=400)
    if gui_url_error:
        return JSONResponse({"ok": False, "error": gui_url_error}, status_code=400)
    incoming_key = payload.get("api_key", None)
    api_key = current.get("api_key", "")
    if incoming_key is not None and str(incoming_key).strip():
        api_key = _clean_text(incoming_key, 500)
    verify_tls = _as_bool_int(payload.get("verify_tls", current.get("verify_tls")), default=bool(current.get("verify_tls")))
    enabled = _as_bool_int(payload.get("enabled", current.get("enabled")), default=bool(current.get("enabled")))
    timeout_s = _as_timeout(payload.get("timeout_s", current.get("timeout_s")))
    notes = _clean_text(payload.get("notes", current.get("notes", "")), 1000)

    if not name or not api_base_url:
        return JSONResponse({"ok": False, "error": "Nombre y URL API son obligatorios"}, status_code=400)

    with db() as conn:
        existing = conn.execute(
            """
            SELECT id, name
            FROM syncthing_nodes
            WHERE lower(api_base_url)=lower(?) AND id<>?
            LIMIT 1
            """,
            (api_base_url, node_id),
        ).fetchone()
        if existing:
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"Ya existe otro nodo Syncthing con esa URL API: {existing['name']} (id {existing['id']})",
                },
                status_code=409,
            )

        conn.execute("""
            UPDATE syncthing_nodes
            SET name=?, api_base_url=?, gui_url=?, api_key=?, verify_tls=?,
                enabled=?, timeout_s=?, notes=?, updated_at=?
            WHERE id=?
        """, (name, api_base_url, gui_url, api_key, verify_tls, enabled, timeout_s, notes, utc_now_iso(), node_id))
        _invalidate_syncthing_overview_cache(conn)

    return {"ok": True}


@router.delete("/api/syncthing/nodes/{node_id}")
def api_syncthing_node_delete(node_id: int):
    ensure_syncthing_schema()
    with db() as conn:
        row = conn.execute("SELECT id FROM syncthing_nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Nodo Syncthing no encontrado"}, status_code=404)
        conn.execute("DELETE FROM syncthing_nodes WHERE id=?", (node_id,))
        conn.execute(
            """
            UPDATE syncthing_overview_cache
            SET status='stale_after_node_delete',
                error='',
                nodes_json='[]',
                folders_json='[]',
                results_json='[]',
                updated_at=?
            WHERE id=1
            """,
            (utc_now_iso(),),
        )
    return {"ok": True}


@router.post("/api/syncthing/nodes/{node_id}/probe")
def api_syncthing_node_probe(node_id: int):
    node = _load_node(node_id)
    if not node:
        return JSONResponse({"ok": False, "error": "Nodo Syncthing no encontrado"}, status_code=404)
    return {"ok": True, "result": _probe_node(node)}


@router.get("/api/syncthing/overview")
def api_syncthing_overview(refresh: bool = Query(False)):
    if refresh:
        return refresh_syncthing_overview_cache(force=True)

    cached = _read_syncthing_overview_cache()
    if cached:
        return cached

    return refresh_syncthing_overview_cache(force=True)



def _snapshot_need_bucket(value: Any) -> int:
    """
    Agrupa bytes pendientes para compactación visual.

    Evita que pequeñas variaciones internas generen filas repetidas en el modal.
    La BD conserva todas las muestras; esto solo afecta a la respuesta visual.
    """
    n = _to_int(value)
    if n <= 0:
        return 0
    mb = 1024 * 1024
    gb = 1024 * mb
    if n >= gb:
        return round(n / (100 * mb))  # buckets de ~100 MB
    if n >= mb:
        return round(n / mb)          # buckets de ~1 MB
    return 1


def _snapshot_compact_key(item: Dict[str, Any]) -> Tuple[Any, ...]:
    """
    Clave de compactación visual del histórico.

    No incluye observed_at ni id. Tampoco incluye need_bytes/need_files ni
    local_bytes, porque generan muchas filas de progreso visualmente repetidas.
    Si varias muestras consecutivas tienen el mismo estado visual y el mismo
    tamaño global, el modal solo enseña la más reciente.
    """
    return (
        str(item.get("status") or ""),
        str(item.get("state") or ""),
        _to_int(item.get("errors")),
        _snapshot_need_bucket(item.get("global_bytes")),
    )


def _compact_consecutive_snapshots(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    compacted: List[Dict[str, Any]] = []
    last_key: Optional[Tuple[Any, ...]] = None

    for item in items:
        key = _snapshot_compact_key(item)
        if compacted and key == last_key:
            compacted[-1] = item
        else:
            compacted.append(item)
            last_key = key

    return compacted


@router.get("/api/syncthing/folders/{node_id}/{folder_id:path}/history")
def api_syncthing_folder_history(
    node_id: int,
    folder_id: str,
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(360, ge=10, le=1000),
):
    """
    Histórico local de una carpeta Syncthing.

    Solo lee snapshots locales ya capturados por Auditor IPs.
    No consulta ni modifica Syncthing remoto.
    """
    ensure_syncthing_schema()

    folder_id = str(folder_id or "").strip()
    if not folder_id:
        return JSONResponse({"ok": False, "error": "folder_id obligatorio"}, status_code=400)

    now_dt = datetime.now(timezone.utc)
    since = (now_dt - timedelta(hours=hours)).replace(microsecond=0).isoformat()

    with db() as conn:
        node = conn.execute(
            "SELECT * FROM syncthing_nodes WHERE id=?",
            (node_id,),
        ).fetchone()

        rows = conn.execute(
            """
            SELECT
                id, node_id, folder_id, node_name, folder_label,
                status, state, need_bytes, need_files, errors,
                local_bytes, global_bytes, state_changed, observed_at
            FROM syncthing_folder_snapshots
            WHERE node_id=? AND folder_id=? AND observed_at>=?
            ORDER BY observed_at ASC
            LIMIT ?
            """,
            (node_id, folder_id, since, limit),
        ).fetchall()

    raw_items = [dict(r) for r in rows]
    items = _compact_consecutive_snapshots(raw_items)
    latest = raw_items[-1] if raw_items else None
    first = items[0] if items else None

    current_need: Dict[str, Any] = {
        "progress": [],
        "queued": [],
        "rest": [],
        "counts": {"progress": 0, "queued": 0, "rest": 0, "total": 0},
        "bytes": {"progress": 0, "queued": 0, "rest": 0, "total": 0},
        "error": "",
    }
    if node:
        raw_need, need_err = _http_json(dict(node), "/rest/db/need", {"folder": folder_id})
        if need_err:
            current_need["error"] = need_err
        else:
            current_need = _need_payload_public(raw_need)

    status_counts: Dict[str, int] = {}
    max_need_bytes = 0
    max_need_files = 0
    for item in raw_items:
        status = str(item.get("status") or "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1
        max_need_bytes = max(max_need_bytes, _to_int(item.get("need_bytes")))
        max_need_files = max(max_need_files, _to_int(item.get("need_files")))

    syncing_minutes = 0
    if latest and latest.get("status") == "syncing" and _to_int(latest.get("need_bytes")) > 0:
        start_dt = None
        for item in reversed(raw_items):
            item_dt = _utc_dt_from_iso(item.get("observed_at"))
            if item.get("status") == "syncing" and _to_int(item.get("need_bytes")) > 0 and item_dt:
                start_dt = item_dt
                continue
            break
        if start_dt:
            syncing_minutes = max(0, int((now_dt - start_dt).total_seconds() // 60))

    return {
        "ok": True,
        "node": _row_public(node) if node else {"id": node_id},
        "folder_id": folder_id,
        "hours": hours,
        "limit": limit,
        "summary": {
            "samples": len(items),
            "raw_samples": len(raw_items),
            "first_observed_at": first.get("observed_at") if first else "",
            "last_observed_at": latest.get("observed_at") if latest else "",
            "latest_status": latest.get("status") if latest else "",
            "latest_need_bytes": _to_int(latest.get("need_bytes")) if latest else 0,
            "latest_need_files": _to_int(latest.get("need_files")) if latest else 0,
            "max_need_bytes": max_need_bytes,
            "max_need_files": max_need_files,
            "syncing_minutes_observed": syncing_minutes,
            "status_counts": status_counts,
            "current_need_files": _to_int(current_need.get("counts", {}).get("total")),
            "current_need_bytes": _to_int(current_need.get("bytes", {}).get("total")),
        },
        "current_need": current_need,
        "snapshots": items,
    }
