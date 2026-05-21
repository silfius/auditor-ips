"""
database.py — Auditor IPs
Conexión a SQLite, inicialización de tablas, purge de datos antiguos.

Sin imports de routers ni de config para evitar dependencias circulares.
Los routers importan `db`, `init_db`, `column_exists`, `purge_old_scans`.
"""

import os
import sqlite3
from datetime import timedelta
from typing import Optional

from auth_middleware import init_auth_tables, purge_expired_sessions_conn

# DB_PATH se resuelve desde la variable de entorno; config.py lo reexporta
# también, pero aquí lo leemos directamente para que database.py sea
# independiente y pueda usarse antes de que config.py cargue los settings.
DB_PATH: str = os.getenv("DB_PATH", "/data/auditor.db")


# ══════════════════════════════════════════════════════════════
#  Conexión
# ══════════════════════════════════════════════════════════════

def db() -> sqlite3.Connection:
    """Devuelve una conexión SQLite con WAL, busy_timeout y row_factory."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    """Comprueba si una columna existe en una tabla (para migraciones ALTER TABLE)."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)


# ══════════════════════════════════════════════════════════════
#  Inicialización / Migraciones
# ══════════════════════════════════════════════════════════════

def _seed_types(conn: sqlite3.Connection) -> None:
    """Crea la tabla host_types y siembra los tipos por defecto."""
    from utils import utc_now_iso  # import local para no crear ciclo al nivel de módulo

    conn.execute("""
    CREATE TABLE IF NOT EXISTS host_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )
    """)
    if not column_exists(conn, "host_types", "icon"):
        conn.execute("ALTER TABLE host_types ADD COLUMN icon TEXT NOT NULL DEFAULT ''")
    existing = {r["name"] for r in conn.execute("SELECT name FROM host_types").fetchall()}
    for name in ["Por defecto", "Servidor", "Casa", "Usuario"]:
        if name not in existing:
            conn.execute(
                "INSERT INTO host_types (name, icon, created_at) VALUES (?, ?, ?)",
                (name, "", utc_now_iso()),
            )


def init_db() -> None:
    """
    Crea todas las tablas si no existen y aplica migraciones ALTER TABLE.
    Idempotente — seguro de llamar en cada arranque.
    """
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    with db() as conn:
        _seed_types(conn)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS host_owners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS hosts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL UNIQUE,
            mac TEXT,
            nmap_hostname TEXT,
            dns_name TEXT,
            manual_name TEXT,
            notes TEXT,
            type_id INTEGER,
            owner_id INTEGER,
            first_seen TEXT,
            last_seen TEXT,
            last_change TEXT,
            status TEXT,
            known INTEGER NOT NULL DEFAULT 0
        )
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT,
            finished_at TEXT,
            cidr TEXT,
            online_hosts INTEGER,
            offline_hosts INTEGER,
            new_hosts INTEGER,
            events_sent INTEGER,
            discord_sent INTEGER,
            discord_error TEXT
        )
        """)

        conn.execute("""
        CREATE TABLE IF NOT EXISTS scans_chart_cache (
            bucket_start   TEXT NOT NULL,
            bucket_minutes INTEGER NOT NULL,
            online_avg     REAL NOT NULL DEFAULT 0,
            offline_avg    REAL NOT NULL DEFAULT 0,
            sample_count   INTEGER NOT NULL DEFAULT 0,
            updated_at     TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (bucket_start, bucket_minutes)
        )
        """)

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scans_chart_cache_minutes_start "
            "ON scans_chart_cache(bucket_minutes, bucket_start DESC)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS host_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            at TEXT NOT NULL,
            event_type TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT
        )
        """)

        # Migraciones de columnas en hosts
        for col, ddl in [
            ("manual_name",  "ALTER TABLE hosts ADD COLUMN manual_name TEXT"),
            ("notes",        "ALTER TABLE hosts ADD COLUMN notes TEXT"),
            ("last_change",  "ALTER TABLE hosts ADD COLUMN last_change TEXT"),
            ("type_id",      "ALTER TABLE hosts ADD COLUMN type_id INTEGER"),
            ("owner_id",     "ALTER TABLE hosts ADD COLUMN owner_id INTEGER"),
            ("known",        "ALTER TABLE hosts ADD COLUMN known INTEGER NOT NULL DEFAULT 0"),
            ("vendor",       "ALTER TABLE hosts ADD COLUMN vendor TEXT"),
            ("tags",         "ALTER TABLE hosts ADD COLUMN tags TEXT DEFAULT ''"),
            ("last_latency_ms", "ALTER TABLE hosts ADD COLUMN last_latency_ms REAL"),
            # Router SSH
            ("router_hostname",    "ALTER TABLE hosts ADD COLUMN router_hostname TEXT"),
            ("ip_assignment",      "ALTER TABLE hosts ADD COLUMN ip_assignment TEXT DEFAULT ''"),
            ("dhcp_lease_expires", "ALTER TABLE hosts ADD COLUMN dhcp_lease_expires TEXT"),
            ("router_seen",        "ALTER TABLE hosts ADD COLUMN router_seen INTEGER NOT NULL DEFAULT 0"),
        ]:
            if not column_exists(conn, "hosts", col):
                conn.execute(ddl)

        conn.execute("CREATE INDEX IF NOT EXISTS idx_hosts_owner_id ON hosts(owner_id)")

        # Migración columna notes en scans
        if not column_exists(conn, "scans", "notes"):
            conn.execute("ALTER TABLE scans ADD COLUMN notes TEXT DEFAULT ''")

        # Alertas
        conn.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            filter_mode TEXT NOT NULL DEFAULT 'all',
            filter_value TEXT,
            action TEXT NOT NULL DEFAULT 'discord',
            cooldown_minutes INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_fired TEXT,
            created_at TEXT NOT NULL
        )
        """)
        if not column_exists(conn, "alerts", "min_down_minutes"):
            conn.execute("ALTER TABLE alerts ADD COLUMN min_down_minutes INTEGER NOT NULL DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled)")

        # Uptime
        conn.execute("""
        CREATE TABLE IF NOT EXISTS host_uptime (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            date TEXT NOT NULL,
            online_seconds INTEGER NOT NULL DEFAULT 0,
            offline_seconds INTEGER NOT NULL DEFAULT 0,
            UNIQUE(ip, date)
        )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_uptime_ip_date ON host_uptime(ip, date)")

        # Historial fino de disponibilidad por intervalos reales
        conn.execute("""
        CREATE TABLE IF NOT EXISTS host_availability_intervals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_host_avail_ip_started ON host_availability_intervals(ip, started_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_host_avail_ip_ended ON host_availability_intervals(ip, ended_at)"
        )

        # Servicios
        conn.execute("""
        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            protocol TEXT NOT NULL DEFAULT 'tcp',
            check_interval INTEGER NOT NULL DEFAULT 60,
            enabled INTEGER NOT NULL DEFAULT 1,
            service_type TEXT,
            service_url TEXT,
            access_url TEXT,
            notes TEXT,
            created_at TEXT NOT NULL
        )
        """)
        if not column_exists(conn, "services", "access_url"):
            conn.execute("ALTER TABLE services ADD COLUMN access_url TEXT")
        if not column_exists(conn, "services", "expected_schedule_enabled"):
            conn.execute("ALTER TABLE services ADD COLUMN expected_schedule_enabled INTEGER NOT NULL DEFAULT 0")
        if not column_exists(conn, "services", "expected_schedule_days"):
            conn.execute("ALTER TABLE services ADD COLUMN expected_schedule_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7'")
        if not column_exists(conn, "services", "expected_schedule_start"):
            conn.execute("ALTER TABLE services ADD COLUMN expected_schedule_start TEXT")
        if not column_exists(conn, "services", "expected_schedule_end"):
            conn.execute("ALTER TABLE services ADD COLUMN expected_schedule_end TEXT")

        conn.execute("""
        CREATE TABLE IF NOT EXISTS service_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_id INTEGER NOT NULL,
            checked_at TEXT NOT NULL,
            status TEXT NOT NULL,
            latency_ms INTEGER,
            info TEXT,
            error TEXT
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_svc_checks ON service_checks(service_id, checked_at DESC)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS service_last_status (
            service_id INTEGER PRIMARY KEY,
            status TEXT,
            notified_at TEXT
        )
        """)

        # Syncthing Control — nodos configurados para consulta API REST solo lectura
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

        # Syncthing Control — histórico corto de carpetas para detectar posibles atascos.
        # Solo registra observaciones locales; no ejecuta acciones remotas sobre Syncthing.
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

        # Latencia hosts
        conn.execute("""
        CREATE TABLE IF NOT EXISTS host_latency (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            scanned_at TEXT NOT NULL,
            latency_ms REAL
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_latency_ip ON host_latency(ip, scanned_at DESC)"
        )

        # Settings
        conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """)

        # Push subscriptions
        conn.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """)

        # Dashboard layout
        conn.execute("""
        CREATE TABLE IF NOT EXISTS dashboard_layout (
            id INTEGER PRIMARY KEY CHECK(id=1),
            layout TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        )
        """)

        # Calidad de conexión
        conn.execute("""
        CREATE TABLE IF NOT EXISTS quality_targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            interface TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
        """)
        if not column_exists(conn, "quality_targets", "interface"):
            conn.execute("ALTER TABLE quality_targets ADD COLUMN interface TEXT NOT NULL DEFAULT ''")

        conn.execute("""
        CREATE TABLE IF NOT EXISTS quality_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_id INTEGER NOT NULL,
            checked_at TEXT NOT NULL,
            latency_ms REAL,
            packet_loss INTEGER,
            status TEXT NOT NULL DEFAULT 'ok'
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_qchk_target ON quality_checks(target_id, checked_at DESC)"
        )
        conn.execute("""
        CREATE TABLE IF NOT EXISTS quality_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),
            enabled INTEGER NOT NULL DEFAULT 0,
            alert_threshold_pct REAL NOT NULL DEFAULT 200.0,
            alert_cooldown_minutes INTEGER NOT NULL DEFAULT 30,
            quiet_start TEXT NOT NULL DEFAULT '',
            quiet_end TEXT NOT NULL DEFAULT '',
            quality_interface TEXT NOT NULL DEFAULT '',
            incident_streak_min INTEGER NOT NULL DEFAULT 3,
            last_alert_at TEXT,
            updated_at TEXT NOT NULL DEFAULT ''
        )
        """)
        conn.execute("""
            INSERT OR IGNORE INTO quality_settings
                (id, enabled, alert_threshold_pct, alert_cooldown_minutes, updated_at)
            VALUES (1, 0, 200.0, 30, '')
        """)

        if not column_exists(conn, "quality_settings", "quality_interface"):
            conn.execute("ALTER TABLE quality_settings ADD COLUMN quality_interface TEXT NOT NULL DEFAULT ''")
        if not column_exists(conn, "quality_settings", "incident_streak_min"):
            conn.execute("ALTER TABLE quality_settings ADD COLUMN incident_streak_min INTEGER NOT NULL DEFAULT 3")

        # Router SSH
        conn.execute("""
        CREATE TABLE IF NOT EXISTS router_scan_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ip          TEXT NOT NULL,
            mac         TEXT,
            scanned_at  TEXT NOT NULL,
            router_hostname  TEXT,
            ip_assignment    TEXT,
            dhcp_lease_secs  INTEGER
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rsh_ip ON router_scan_history(ip, scanned_at DESC)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS router_scans (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            scanned_at TEXT NOT NULL,
            hosts_seen INTEGER NOT NULL DEFAULT 0,
            silent_new INTEGER NOT NULL DEFAULT 0,
            error      TEXT DEFAULT ''
        )
        """)

        # Scripts monitorizados (Config → Procesos)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS monitored_scripts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            script_name TEXT NOT NULL UNIQUE,
            label       TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            color       TEXT NOT NULL DEFAULT '',
            active      INTEGER NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        )
        """)

        if not column_exists(conn, "monitored_scripts", "cron_expr"):
            conn.execute("ALTER TABLE monitored_scripts ADD COLUMN cron_expr TEXT NOT NULL DEFAULT ''")
        if not column_exists(conn, "monitored_scripts", "cron_source"):
            conn.execute("ALTER TABLE monitored_scripts ADD COLUMN cron_source TEXT NOT NULL DEFAULT ''")
        if not column_exists(conn, "monitored_scripts", "host_name"):
            conn.execute("ALTER TABLE monitored_scripts ADD COLUMN host_name TEXT NOT NULL DEFAULT 'Local'")
        if not column_exists(conn, "monitored_scripts", "host_source"):
            conn.execute("ALTER TABLE monitored_scripts ADD COLUMN host_source TEXT NOT NULL DEFAULT 'local_status_dir'")

        # Redes secundarias (Config → Redes — Sesión 21)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS secondary_networks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            label       TEXT    NOT NULL DEFAULT '',
            cidr        TEXT    NOT NULL,
            interface   TEXT    NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT    NOT NULL
        )
        """)

        # Discovery canónico (nuevo schema compatible — no sustituye aún al legacy)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS router_profiles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL UNIQUE,
            host        TEXT    NOT NULL DEFAULT '',
            port        INTEGER NOT NULL DEFAULT 22,
            user        TEXT    NOT NULL DEFAULT '',
            key_path    TEXT    NOT NULL DEFAULT '',
            router_type TEXT    NOT NULL DEFAULT '',
            notes       TEXT    NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL DEFAULT ''
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_router_profiles_enabled ON router_profiles(enabled)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS discovery_scanners (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT    NOT NULL DEFAULT '',
            interface         TEXT    NOT NULL DEFAULT '',
            method            TEXT    NOT NULL DEFAULT 'nmap',
            router_profile_id INTEGER,
            enabled           INTEGER NOT NULL DEFAULT 1,
            sort_order        INTEGER NOT NULL DEFAULT 0,
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL DEFAULT ''
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_discovery_scanners_enabled ON discovery_scanners(enabled, sort_order, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_discovery_scanners_router ON discovery_scanners(router_profile_id)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS discovery_scanner_networks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            scanner_id  INTEGER NOT NULL,
            cidr        TEXT    NOT NULL,
            label       TEXT    NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL DEFAULT '',
            UNIQUE(scanner_id, cidr)
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_discovery_scanner_networks_scanner ON discovery_scanner_networks(scanner_id, enabled, sort_order, id)"
        )


        # Discrepancias nmap/router (Sesión 21)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS scan_discrepancies (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ip           TEXT    NOT NULL,
            mac          TEXT,
            first_seen   TEXT    NOT NULL,
            last_seen    TEXT    NOT NULL,
            times_seen   INTEGER NOT NULL DEFAULT 1,
            accepted     INTEGER NOT NULL DEFAULT 0,
            accepted_at  TEXT,
            note         TEXT,
            UNIQUE(ip)
        )
        """)

        # Informes IA de verificación secundaria (Sesión 22)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS scan_ai_reports (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at       TEXT    NOT NULL,
            report_text        TEXT    NOT NULL,
            discrepancy_count  INTEGER NOT NULL DEFAULT 0,
            source             TEXT    NOT NULL DEFAULT 'nmap'
        )
        """)

        # Reglas de alerta por script (Sesión 23 / V3 multi-host)
        conn.execute("""
        CREATE TABLE IF NOT EXISTS script_alert_rules (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            host_name    TEXT    NOT NULL DEFAULT 'Local',
            script_name  TEXT    NOT NULL,
            alert_missed INTEGER NOT NULL DEFAULT 1,
            max_hours    REAL    NOT NULL DEFAULT 25,
            alert_error  INTEGER NOT NULL DEFAULT 1,
            alert_running_long INTEGER NOT NULL DEFAULT 0,
            max_running_hours  REAL    NOT NULL DEFAULT 6,
            cooldown_min INTEGER NOT NULL DEFAULT 60,
            last_fired   TEXT,
            created_at   TEXT    NOT NULL,
            UNIQUE(host_name, script_name)
        )
        """)

        # Migración desde esquema legado UNIQUE(script_name).
        # SQLite no permite eliminar UNIQUE por ALTER TABLE, así que se reconstruye
        # solo si falta host_name. Las reglas existentes pasan a host Local.
        if not column_exists(conn, "script_alert_rules", "host_name"):
            conn.execute("DROP TABLE IF EXISTS script_alert_rules_legacy_migration")
            conn.execute("ALTER TABLE script_alert_rules RENAME TO script_alert_rules_legacy_migration")
            conn.execute("""
            CREATE TABLE script_alert_rules (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                host_name    TEXT    NOT NULL DEFAULT 'Local',
                script_name  TEXT    NOT NULL,
                alert_missed INTEGER NOT NULL DEFAULT 1,
                max_hours    REAL    NOT NULL DEFAULT 25,
                alert_error  INTEGER NOT NULL DEFAULT 1,
                alert_running_long INTEGER NOT NULL DEFAULT 0,
                max_running_hours  REAL    NOT NULL DEFAULT 6,
                cooldown_min INTEGER NOT NULL DEFAULT 60,
                last_fired   TEXT,
                created_at   TEXT    NOT NULL,
                UNIQUE(host_name, script_name)
            )
            """)
            conn.execute("""
                INSERT OR IGNORE INTO script_alert_rules
                    (id, host_name, script_name, alert_missed, max_hours, alert_error,
                     alert_running_long, max_running_hours, cooldown_min, last_fired, created_at)
                SELECT id, 'Local', script_name, alert_missed, max_hours, alert_error,
                       0, 6, cooldown_min, last_fired, created_at
                FROM script_alert_rules_legacy_migration
            """)
            conn.execute("DROP TABLE IF EXISTS script_alert_rules_legacy_migration")

        if not column_exists(conn, "script_alert_rules", "alert_running_long"):
            conn.execute("ALTER TABLE script_alert_rules ADD COLUMN alert_running_long INTEGER NOT NULL DEFAULT 0")
        if not column_exists(conn, "script_alert_rules", "max_running_hours"):
            conn.execute("ALTER TABLE script_alert_rules ADD COLUMN max_running_hours REAL NOT NULL DEFAULT 6")

        # Paradas controladas de scripts: override operativo para evitar falsos stalled/running_long.
        # No modifica los .status.json generados por los scripts; solo afecta al estado efectivo en Auditor IPs.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS script_controlled_stops (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            host_name    TEXT    NOT NULL DEFAULT 'Local',
            script_name  TEXT    NOT NULL,
            reason       TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    NOT NULL,
            observed_start_time TEXT NOT NULL DEFAULT '',
            cleared_at   TEXT,
            cleared_reason TEXT NOT NULL DEFAULT ''
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_script_controlled_stops_lookup "
            "ON script_controlled_stops(host_name, script_name, cleared_at)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_script_controlled_stops_active "
            "ON script_controlled_stops(host_name, script_name) WHERE cleared_at IS NULL"
        )
        if not column_exists(conn, "script_controlled_stops", "observed_start_time"):
            conn.execute("ALTER TABLE script_controlled_stops ADD COLUMN observed_start_time TEXT NOT NULL DEFAULT ''")


        # Agentes remotos de Automatizaciones — tokens por host y auditoría mínima.
        # No guardamos tokens en claro: solo hash SHA-256 de tokens de alta entropía.
        conn.execute("""
        CREATE TABLE IF NOT EXISTS automation_agents (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            host_name          TEXT    NOT NULL UNIQUE,
            token_hash         TEXT    NOT NULL,
            token_prefix       TEXT    NOT NULL DEFAULT '',
            enabled            INTEGER NOT NULL DEFAULT 1,
            notes              TEXT    NOT NULL DEFAULT '',
            created_at         TEXT    NOT NULL,
            updated_at         TEXT    NOT NULL,
            last_seen_at       TEXT,
            last_seen_ip       TEXT,
            last_status_script TEXT,
            revoked_at         TEXT
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_automation_agents_enabled "
            "ON automation_agents(enabled, host_name)"
        )

        conn.execute("""
        CREATE TABLE IF NOT EXISTS automation_agent_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            at          TEXT    NOT NULL,
            host_name   TEXT    NOT NULL DEFAULT '',
            ip          TEXT    NOT NULL DEFAULT '',
            action      TEXT    NOT NULL,
            ok          INTEGER NOT NULL DEFAULT 0,
            detail      TEXT    NOT NULL DEFAULT ''
        )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_automation_agent_events_at "
            "ON automation_agent_events(at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_automation_agent_events_host "
            "ON automation_agent_events(host_name, at DESC)"
        )

    # Auth tables (auth_middleware.py)
    init_auth_tables(DB_PATH)


# ══════════════════════════════════════════════════════════════
#  Purge de datos antiguos
# ══════════════════════════════════════════════════════════════

def purge_old_scans(conn: sqlite3.Connection, retention_days: int) -> int:
    """
    Elimina scans y datos relacionados más antiguos que retention_days.
    Recibe la conexión activa para reutilizarla (evita deadlocks con _db_write_lock).
    Devuelve el número de scans eliminados.
    """
    from utils import utc_now  # import local para evitar ciclo al nivel de módulo

    cutoff = (utc_now() - timedelta(days=retention_days)).isoformat()
    cur = conn.execute("DELETE FROM scans WHERE started_at < ?", (cutoff,))
    conn.execute("DELETE FROM router_scan_history WHERE scanned_at < ?", (cutoff,))
    conn.execute("DELETE FROM router_scans WHERE scanned_at < ?", (cutoff,))
    purge_expired_sessions_conn(conn)
    return cur.rowcount