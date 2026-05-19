#!/usr/bin/env python3
"""
Instalador del agente cliente de Auditor IPs.

Instala un helper local para enviar estados de scripts remotos a:
POST /api/automation-agents/status

No ejecuta comandos remotos desde Auditor IPs.
El agente solo envía estado/logs hacia el servidor.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import shlex
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


HELPER_SCRIPT = r'''#!/usr/bin/env bash

CONFIG_FILE="${AUDITOR_AGENT_CONFIG:-/etc/auditor-ips-agent/agent.env}"

if [ -r "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

AUDITOR_URL="${AUDITOR_URL:-https://127.0.0.1:9909}"
AUDITOR_AGENT_HOST="${AUDITOR_AGENT_HOST:-$(hostname)}"
AUDITOR_AGENT_TOKEN_FILE="${AUDITOR_AGENT_TOKEN_FILE:-}"
AUDITOR_AGENT_TOKEN="${AUDITOR_AGENT_TOKEN:-}"
AUDITOR_AGENT_VERIFY_TLS="${AUDITOR_AGENT_VERIFY_TLS:-0}"

SCRIPT_NAME="${1:-}"
STATUS="${2:-completed}"
EXIT_CODE="${3:-0}"
STEP_LABEL="${4:-}"
LOG_FILE="${5:-}"

if [ -z "$SCRIPT_NAME" ]; then
  echo "[ERROR] Uso: auditor-agent-send-status <script_name> <status> <exit_code> <step_label> [log_file]" >&2
  exit 2
fi

if [ -z "$AUDITOR_AGENT_TOKEN" ] && [ -n "$AUDITOR_AGENT_TOKEN_FILE" ] && [ -r "$AUDITOR_AGENT_TOKEN_FILE" ]; then
  AUDITOR_AGENT_TOKEN="$(cat "$AUDITOR_AGENT_TOKEN_FILE")"
fi

if [ -z "$AUDITOR_AGENT_TOKEN" ]; then
  echo "[ERROR] Falta AUDITOR_AGENT_TOKEN o AUDITOR_AGENT_TOKEN_FILE" >&2
  exit 3
fi

NOW="$(date '+%Y-%m-%d %H:%M:%S')"
DURATION="${AUDITOR_AGENT_DURATION_SECONDS:-0}"
PROGRESS="${AUDITOR_AGENT_PROGRESS_PCT:-100}"

LOG_JSON="[]"
if [ -n "$LOG_FILE" ] && [ -r "$LOG_FILE" ]; then
  LOG_JSON="$(tail -n 80 "$LOG_FILE" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin], ensure_ascii=False))')"
fi

python3 - "$AUDITOR_URL" "$AUDITOR_AGENT_TOKEN" "$AUDITOR_AGENT_HOST" "$SCRIPT_NAME" "$STATUS" "$EXIT_CODE" "$NOW" "$DURATION" "$PROGRESS" "$STEP_LABEL" "$LOG_JSON" "$AUDITOR_AGENT_VERIFY_TLS" <<'PY'
import json
import ssl
import sys
import urllib.request

url, token, host, script, status, exit_code, now, duration, progress, step_label, log_json, verify_tls = sys.argv[1:]

payload = {
    "host_name": host,
    "script_name": script,
    "status": status,
    "exit_code": int(exit_code),
    "start_time": now,
    "end_time": now,
    "duration_seconds": int(float(duration or 0)),
    "progress_pct": int(float(progress or 0)),
    "step_label": step_label,
    "last_log_lines": json.loads(log_json or "[]"),
}

req = urllib.request.Request(
    url.rstrip("/") + "/api/automation-agents/status",
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    },
    method="POST",
)

ctx = ssl.create_default_context() if str(verify_tls) == "1" else ssl._create_unverified_context()

try:
    with urllib.request.urlopen(req, context=ctx, timeout=20) as res:
        body = res.read().decode("utf-8", errors="replace")
        print(body)
except Exception as e:
    print(f"[ERROR] No se pudo enviar estado a Auditor IPs: {e}", file=sys.stderr)
    sys.exit(1)
PY
'''

SERVICE_TEMPLATE = """[Unit]
Description=Auditor IPs agent heartbeat
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile={config_file}
ExecStart={helper_path} agent_heartbeat completed 0 heartbeat
"""

TIMER_TEMPLATE = """[Unit]
Description=Auditor IPs agent heartbeat timer

[Timer]
OnBootSec=2min
OnUnitActiveSec={heartbeat_minutes}min
AccuracySec=30s
Unit=auditor-ips-agent-heartbeat.service

[Install]
WantedBy=timers.target
"""


def log(msg: str = "") -> None:
    print(msg, flush=True)


def section(title: str, subtitle: str = "") -> None:
    log("")
    log(f"== {title} ==")
    if subtitle:
        log(f"  {subtitle}")


def shell_quote(value: str) -> str:
    return shlex.quote(str(value))


def write_text(path: Path, content: str, mode: int | None = None, dry_run: bool = False) -> None:
    if dry_run:
        log(f"DRY-RUN escribir {path}")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if mode is not None:
        path.chmod(mode)
    log(f"Escrito {path}")


def make_symlink(src: Path, dst: Path, dry_run: bool = False) -> None:
    if dry_run:
        log(f"DRY-RUN enlazar {dst} -> {src}")
        return

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(src)
    log(f"Enlace creado {dst} -> {src}")


def run_cmd(cmd: list[str], check: bool = False) -> subprocess.CompletedProcess:
    log("+ " + " ".join(shlex.quote(c) for c in cmd))
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def systemctl_available() -> bool:
    return shutil.which("systemctl") is not None and Path("/run/systemd/system").exists()


def normalize_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        raise ValueError("server-url vacío")
    if not (url.startswith("https://") or url.startswith("http://")):
        raise ValueError("server-url debe empezar por http:// o https://")
    return url


def safe_host_name(host: str) -> str:
    host = (host or "").strip()
    if not host:
        host = socket.gethostname()
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    cleaned = "".join(c for c in host if c in allowed)
    if not cleaned:
        raise ValueError("host-name inválido")
    if len(cleaned) > 120:
        raise ValueError("host-name demasiado largo")
    return cleaned


def read_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token.strip()

    if args.token_file:
        token_path = Path(args.token_file).expanduser()
        if not token_path.exists():
            raise FileNotFoundError(f"No existe token-file: {token_path}")
        return token_path.read_text(encoding="utf-8").strip()

    if args.yes:
        raise RuntimeError("En modo --yes debes indicar --token o --token-file")

    token = getpass.getpass("Token del agente creado en Auditor IPs: ").strip()
    if not token:
        raise RuntimeError("Token vacío")
    return token


def send_test_status(server_url: str, host_name: str, token: str, verify_tls: bool) -> None:
    section("Prueba de envío", "Envía un estado agent_install_check al servidor Auditor IPs.")

    payload = {
        "host_name": host_name,
        "script_name": "agent_install_check",
        "status": "completed",
        "exit_code": 0,
        "start_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "end_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "duration_seconds": 0,
        "progress_pct": 100,
        "step_label": "install_check",
        "last_log_lines": ["Auditor IPs agent installer test OK"],
    }

    req = urllib.request.Request(
        server_url.rstrip("/") + "/api/automation-agents/status",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    ctx = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as res:
            body = res.read().decode("utf-8", errors="replace")
            log(f"Respuesta servidor: {body}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} enviando prueba: {body[:500]}") from e
    except Exception as e:
        raise RuntimeError(f"No se pudo enviar prueba al servidor: {e}") from e


def write_config(args: argparse.Namespace, server_url: str, host_name: str, token: str) -> tuple[Path, Path]:
    config_dir = Path(args.config_dir).expanduser()
    install_dir = Path(args.install_dir).expanduser()

    token_file = config_dir / "token"
    config_file = config_dir / "agent.env"
    helper_path = install_dir / "auditor_agent_send_status.sh"

    env_content = "\n".join([
        "# Auditor IPs agent config",
        f"AUDITOR_URL={shell_quote(server_url)}",
        f"AUDITOR_AGENT_HOST={shell_quote(host_name)}",
        f"AUDITOR_AGENT_TOKEN_FILE={shell_quote(str(token_file))}",
        f"AUDITOR_AGENT_VERIFY_TLS={'1' if args.verify_tls else '0'}",
        "",
    ])

    section("Escritura de ficheros", "Instala helper, configuración local y token con permisos restringidos.")

    write_text(helper_path, HELPER_SCRIPT, mode=0o755, dry_run=args.dry_run)
    write_text(config_file, env_content, mode=0o600, dry_run=args.dry_run)
    write_text(token_file, token + "\n", mode=0o600, dry_run=args.dry_run)

    if not args.no_symlink:
        link_path = Path(args.bin_dir).expanduser() / "auditor-agent-send-status"
        make_symlink(helper_path, link_path, dry_run=args.dry_run)

    return config_file, helper_path


def write_systemd(args: argparse.Namespace, config_file: Path, helper_path: Path) -> None:
    if not args.systemd:
        log("Omitido systemd/timer porque no se indicó --systemd")
        return

    systemd_dir = Path(args.systemd_dir).expanduser()
    service_path = systemd_dir / "auditor-ips-agent-heartbeat.service"
    timer_path = systemd_dir / "auditor-ips-agent-heartbeat.timer"

    section("Systemd heartbeat", "Crea un timer opcional que envía una señal periódica al servidor.")

    service = SERVICE_TEMPLATE.format(
        config_file=str(config_file),
        helper_path=str(helper_path),
    )
    timer = TIMER_TEMPLATE.format(heartbeat_minutes=args.heartbeat_minutes)

    write_text(service_path, service, mode=0o644, dry_run=args.dry_run)
    write_text(timer_path, timer, mode=0o644, dry_run=args.dry_run)

    real_systemd_dir = Path("/etc/systemd/system")
    if args.dry_run:
        return

    if systemd_dir == real_systemd_dir and systemctl_available():
        run_cmd(["systemctl", "daemon-reload"])
        run_cmd(["systemctl", "enable", "--now", "auditor-ips-agent-heartbeat.timer"])
        log("Timer habilitado: auditor-ips-agent-heartbeat.timer")
    else:
        log("Systemd escrito, pero no se ejecuta systemctl por usar systemd-dir no estándar o no haber systemd activo.")


def write_summary(args: argparse.Namespace, server_url: str, host_name: str, config_file: Path, helper_path: Path) -> None:
    install_dir = Path(args.install_dir).expanduser()
    summary_path = install_dir / "agent_install_summary.md"

    content = "\n".join([
        "# Auditor IPs - resumen de instalación del agente",
        "",
        f"- Fecha UTC: {datetime.now(timezone.utc).isoformat()}",
        f"- Servidor: {server_url}",
        f"- Host agente: {host_name}",
        f"- Helper: {helper_path}",
        f"- Configuración: {config_file}",
        f"- Verificación TLS estricta: {'sí' if args.verify_tls else 'no'}",
        f"- Systemd heartbeat: {'sí' if args.systemd else 'no'}",
        "",
        "## Uso manual",
        "",
        "```bash",
        "auditor-agent-send-status nombre_script completed 0 'mensaje opcional' /ruta/al/log.log",
        "```",
        "",
        "## Variables útiles",
        "",
        "- `AUDITOR_AGENT_DURATION_SECONDS`",
        "- `AUDITOR_AGENT_PROGRESS_PCT`",
        "- `AUDITOR_AGENT_CONFIG`",
        "",
        "## Seguridad",
        "",
        "- El token queda guardado en el fichero `token` con permisos 600.",
        "- No compartas capturas o logs donde aparezca el token.",
        "- Si sospechas exposición, rota el token desde Auditor IPs.",
        "",
    ])

    write_text(summary_path, content, mode=0o644, dry_run=args.dry_run)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Instala el agente cliente de Auditor IPs.")
    parser.add_argument("--server-url", default="", help="URL del servidor Auditor IPs, por ejemplo https://192.168.1.253:9909")
    parser.add_argument("--host-name", default="", help="Nombre del agente registrado en Auditor IPs")
    parser.add_argument("--token", default="", help="Token del agente. Preferible usar --token-file o prompt interactivo.")
    parser.add_argument("--token-file", default="", help="Fichero desde el que leer el token del agente.")
    parser.add_argument("--install-dir", default="/opt/auditor-ips-agent", help="Directorio de instalación del helper.")
    parser.add_argument("--config-dir", default="/etc/auditor-ips-agent", help="Directorio de configuración local.")
    parser.add_argument("--bin-dir", default="/usr/local/bin", help="Directorio donde crear el enlace auditor-agent-send-status.")
    parser.add_argument("--systemd-dir", default="/etc/systemd/system", help="Directorio systemd para servicio/timer.")
    parser.add_argument("--heartbeat-minutes", type=int, default=15, help="Intervalo del heartbeat systemd.")
    parser.add_argument("--systemd", action="store_true", help="Instala timer systemd de heartbeat.")
    parser.add_argument("--no-symlink", action="store_true", help="No crea enlace en bin-dir.")
    parser.add_argument("--no-test", action="store_true", help="No envía prueba agent_install_check al servidor.")
    parser.add_argument("--verify-tls", action="store_true", help="Verifica certificado TLS. Por defecto se permite autofirmado local.")
    parser.add_argument("--check-only", action="store_true", help="Solo valida argumentos y token, no escribe ficheros.")
    parser.add_argument("--dry-run", action="store_true", help="Muestra acciones sin escribir.")
    parser.add_argument("--yes", action="store_true", help="Modo no interactivo.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        section("Auditor IPs - instalador de agente cliente")

        server_url = normalize_url(args.server_url or ("" if args.yes else input("URL servidor Auditor IPs [https://127.0.0.1:9909]: ").strip() or "https://127.0.0.1:9909"))
        host_name = safe_host_name(args.host_name or socket.gethostname())
        token = read_token(args)

        if args.heartbeat_minutes < 1 or args.heartbeat_minutes > 1440:
            raise ValueError("heartbeat-minutes debe estar entre 1 y 1440")

        log(f"Servidor      : {server_url}")
        log(f"Host agente   : {host_name}")
        log(f"Install dir   : {args.install_dir}")
        log(f"Config dir    : {args.config_dir}")
        log(f"Systemd       : {'sí' if args.systemd else 'no'}")
        log(f"Verificar TLS : {'sí' if args.verify_tls else 'no'}")

        if args.check_only:
            log("check-only OK")
            return 0

        config_file, helper_path = write_config(args, server_url, host_name, token)
        write_systemd(args, config_file, helper_path)
        write_summary(args, server_url, host_name, config_file, helper_path)

        if not args.no_test and not args.dry_run:
            send_test_status(server_url, host_name, token, args.verify_tls)
        else:
            log("Omitida prueba de envío por --no-test o --dry-run")

        log("")
        log("Instalación del agente completada.")
        log("Uso: auditor-agent-send-status nombre_script completed 0 'mensaje' /ruta/log.log")
        return 0

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
