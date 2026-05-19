#!/usr/bin/env python3
"""
check_startup.py — Auditor IPs
Pre-flight del proyecto para validar imports, dependencias, herramientas del
sistema y criterios mínimos de despliegue.

Objetivo de esta versión:
- separar claramente configuración de despliegue vs bootstrap funcional
- validar el runtime Docker sin asumir que toda la config viva en .env
- mantener la utilidad del script tanto dentro del contenedor como en host

Uso recomendado:
    docker compose run --rm auditor_ips python check_startup.py
    python check_startup.py
    python check_startup.py --verbose
"""

from __future__ import annotations

import importlib
import ipaddress
import os
import stat
import subprocess
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse

OK = "\033[92m✅\033[0m"
ERR = "\033[91m❌\033[0m"
WARN = "\033[93m⚠️ \033[0m"
INFO = "\033[94mℹ️ \033[0m"

errors = 0
warnings = 0

BASE_DIR = Path(__file__).resolve().parent
VERBOSE = "--verbose" in sys.argv


def ok(msg: str) -> None:
    print(f"  {OK}  {msg}")


def err(msg: str) -> None:
    global errors
    errors += 1
    print(f"  {ERR}  {msg}")


def warn(msg: str) -> None:
    global warnings
    warnings += 1
    print(f"  {WARN} {msg}")


def info(msg: str) -> None:
    print(f"  {INFO} {msg}")


def section(title: str) -> None:
    print(f"\n─── {title} ─{'─' * max(1, 56 - len(title))}")


def print_exception() -> None:
    if VERBOSE:
        traceback.print_exc()


def env_str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def validate_ip(value: str, label: str) -> None:
    try:
        ipaddress.ip_address(value)
        ok(f"{label} válida: {value}")
    except ValueError:
        err(f"{label} inválida: {value}")


def validate_cidr_list(raw: str, label: str) -> None:
    cidrs = [c.strip() for c in raw.split(",") if c.strip()]
    if not cidrs:
        warn(f"{label} vacío")
        return
    for cidr in cidrs:
        try:
            ipaddress.ip_network(cidr, strict=False)
            ok(f"{label} válido: {cidr}")
        except ValueError:
            err(f"{label} inválido: {cidr}")


def validate_url(value: str, label: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        ok(f"{label} válida: {value}")
    else:
        warn(f"{label} con formato inesperado: {value}")


def check_dir_state(path_str: str, label: str, *, required: bool, writable: bool = False, readable: bool = False) -> None:
    p = Path(path_str)
    if not p.exists():
        if required:
            if str(p) == "/data":
                warn(f"{label} no existe aún ({p}) — normal en primer run si el volumen no está montado todavía")
            else:
                err(f"{label} no existe: {p}")
        else:
            info(f"{label} no existe: {p} (módulo opcional o aún no inicializado)")
        return

    if not p.is_dir():
        err(f"{label} existe pero no es un directorio: {p}")
        return

    ok(f"{label}: {p}")

    if readable:
        if os.access(p, os.R_OK):
            ok(f"{label} legible")
        else:
            warn(f"{label} no es legible")

    if writable:
        if os.access(p, os.W_OK):
            ok(f"{label} escribible")
        else:
            warn(f"{label} no es escribible")


section("Dependencias Python")

REQUIRED_PACKAGES = [
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("apscheduler", "apscheduler"),
    ("dateutil", "python-dateutil"),
    ("jinja2", "jinja2"),
    ("openpyxl", "openpyxl"),
    ("dns", "dnspython"),
    ("starlette", "starlette"),
    ("aiofiles", "aiofiles"),
]

for module_name, package_name in REQUIRED_PACKAGES:
    try:
        importlib.import_module(module_name)
        ok(package_name)
    except ImportError:
        err(f"{package_name} NO instalado — revisa requirements.txt")
        print_exception()

section("Módulos locales")

sys.path.insert(0, str(BASE_DIR))

LOCAL_MODULES = [
    "utils",
    "database",
    "config",
    "auth_middleware",
    "routers.__init__",
    "routers.auth",
    "routers.alerts",
    "routers.hosts",
    "routers.quality",
    "routers.scans",
    "routers.services",
    "routers.router_ssh",
    "routers.config_api",
    "routers.daily_report",
    "routers.export_scheduler",
    "routers.scripts_status",
    "main",
]

for module_name in LOCAL_MODULES:
    try:
        importlib.import_module(module_name)
        ok(module_name)
    except Exception as exc:
        err(f"{module_name} — {exc}")
        print_exception()

section("Runtime de despliegue")

db_path = env_str("DB_PATH", "/data/auditor.db")
port_raw = env_str("PORT", "9909")
tls_cert_ip = env_str("TLS_CERT_IP", "")
server_ip = env_str("SERVER_IP", "")
effective_tls_ip = tls_cert_ip or server_ip

scripts_status_dir = env_str("SCRIPTS_STATUS_DIR", "/data/scripts_status")
scripts_prompts_dir = env_str("SCRIPTS_PROMPTS_DIR", "/data/scripts_prompts")
auditor_docs_dir = env_str("AUDITOR_DOCS_DIR", "/data/auditor_docs")
exports_dir = env_str("EXPORTS_DIR", "/data/exports")

ok(f"DB_PATH = {db_path}")

db_dir = Path(db_path).parent if Path(db_path).parent.as_posix() else Path(".")
if db_dir.exists():
    if db_dir.is_dir():
        ok(f"Directorio de BD existe: {db_dir}")
        if os.access(db_dir, os.W_OK):
            ok(f"Directorio de BD escribible")
        else:
            warn(f"Directorio de BD no es escribible: {db_dir}")
    else:
        err(f"La ruta padre de DB_PATH no es un directorio: {db_dir}")
else:
    if str(db_dir) == "/data":
        warn("Directorio /data no existe aún — normal si el volumen no está montado en un primer run")
    else:
        err(f"Directorio de BD no existe: {db_dir}")

try:
    port = int(port_raw)
    if 1 <= port <= 65535:
        ok(f"PORT = {port}")
    else:
        err(f"PORT fuera de rango: {port}")
except ValueError:
    err(f"PORT no es un entero válido: {port_raw!r}")

if effective_tls_ip:
    label = "TLS_CERT_IP" if tls_cert_ip else "SERVER_IP (compat)"
    validate_ip(effective_tls_ip, label)
else:
    info("TLS_CERT_IP/SERVER_IP no configurada — el certificado solo usará SANs por defecto")

check_dir_state("/data", "Volumen persistente /data", required=False, writable=True)
check_dir_state(scripts_status_dir, "SCRIPTS_STATUS_DIR", required=False, readable=True)
check_dir_state(scripts_prompts_dir, "SCRIPTS_PROMPTS_DIR", required=False, readable=True)
check_dir_state(auditor_docs_dir, "AUDITOR_DOCS_DIR", required=False, readable=True)
check_dir_state(exports_dir, "EXPORTS_DIR", required=False, writable=True)

section("Bootstrap funcional por entorno")

info("Estos valores NO se consideran críticos de despliegue.")
info("Se validan como semilla inicial/fallback; la fuente real de verdad puede acabar en SQLite/UI.")

scan_cidr = env_str("SCAN_CIDR", "192.168.1.0/24")
scan_interval_raw = env_str("SCAN_INTERVAL_SECONDS", "900")
dns_server = env_str("DNS_SERVER", "")
discord = env_str("DISCORD_WEBHOOK_URL", "")

validate_cidr_list(scan_cidr, "SCAN_CIDR")

try:
    scan_interval = int(scan_interval_raw)
    if scan_interval < 30:
        warn(f"SCAN_INTERVAL_SECONDS={scan_interval} es muy bajo (mínimo práctico recomendado: 60)")
    else:
        ok(f"SCAN_INTERVAL_SECONDS = {scan_interval}s")
except ValueError:
    err(f"SCAN_INTERVAL_SECONDS no es un entero válido: {scan_interval_raw!r}")

if dns_server:
    validate_ip(dns_server, "DNS_SERVER")
else:
    info("DNS_SERVER no configurado — se usará resolución por defecto")

if discord:
    if discord.startswith("https://discord.com/api/webhooks/"):
        ok("DISCORD_WEBHOOK_URL configurado")
    else:
        warn("DISCORD_WEBHOOK_URL con formato inesperado")
else:
    info("DISCORD_WEBHOOK_URL no configurado (opcional)")

router_host = env_str("ROUTER_SSH_HOST", "")
router_port_raw = env_str("ROUTER_SSH_PORT", "")
router_user = env_str("ROUTER_SSH_USER", "")
router_key = env_str("ROUTER_SSH_KEY", "")

if router_host or router_port_raw or router_user or router_key:
    info("Parámetros Router SSH detectados en entorno (bootstrap o despliegue actual)")
    if router_host:
        validate_ip(router_host, "ROUTER_SSH_HOST")
    else:
        warn("ROUTER_SSH_HOST vacío pero otros parámetros SSH están definidos")

    if router_port_raw:
        try:
            router_port = int(router_port_raw)
            if 1 <= router_port <= 65535:
                ok(f"ROUTER_SSH_PORT = {router_port}")
            else:
                err(f"ROUTER_SSH_PORT fuera de rango: {router_port}")
        except ValueError:
            err(f"ROUTER_SSH_PORT no es un entero válido: {router_port_raw!r}")
    else:
        warn("ROUTER_SSH_PORT vacío")

    if router_user:
        ok(f"ROUTER_SSH_USER = {router_user}")
    else:
        warn("ROUTER_SSH_USER vacío")

    if router_key:
        key_path = Path(router_key)
        if not key_path.exists():
            alt = Path("/data/ssh") / key_path.name
            if alt.exists():
                key_path = alt
                ok(f"Router SSH key encontrada en fallback gestionado por app: {alt}")
            else:
                warn(f"Router SSH key no encontrada: {router_key}")
        if key_path.exists():
            mode = stat.S_IMODE(key_path.stat().st_mode)
            if mode & 0o077:
                warn(f"Router SSH key con permisos {oct(mode)} — recomendado 0o600")
            else:
                ok(f"Router SSH key lista: {key_path} (permisos {oct(mode)})")
    else:
        info("ROUTER_SSH_KEY no configurada")
else:
    info("Router SSH no configurado por entorno (opcional)")

ai_provider = env_str("AI_PROVIDER", "")
ollama_url = env_str("OLLAMA_URL", "")
ollama_model = env_str("OLLAMA_MODEL", "")

if ai_provider:
    ok(f"AI_PROVIDER = {ai_provider}")
else:
    info("AI_PROVIDER no configurado — la app usará su default o la BD")

if ollama_url:
    validate_url(ollama_url, "OLLAMA_URL")
else:
    info("OLLAMA_URL no configurada — la app usará su default o la BD")

if ollama_model:
    ok(f"OLLAMA_MODEL = {ollama_model}")
else:
    info("OLLAMA_MODEL no configurado — la app usará su default o la BD")

section("Herramientas del sistema")

TOOLS = [
    ("nmap", ["nmap", "--version"], True),
    ("ping", ["ping", "-c1", "-W1", "127.0.0.1"], False),
    ("arping", ["arping", "-h"], False),
    ("ssh", ["ssh", "-V"], False),
    ("openssl", ["openssl", "version"], True),
    ("ip", ["ip", "-V"], True),
]

for name, command, required in TOOLS:
    try:
        subprocess.run(command, capture_output=True, timeout=5, check=False)
        ok(f"{name} disponible")
    except FileNotFoundError:
        if required:
            err(f"{name} NO encontrado — revísalo en la imagen Docker")
        else:
            warn(f"{name} no encontrado — funcionalidad asociada limitada")
    except Exception as exc:
        warn(f"{name} — {exc}")

section("Ficheros de la aplicación")

APP_PATHS = [
    "main.py",
    "auth_middleware.py",
    "database.py",
    "utils.py",
    "config.py",
    "entrypoint.sh",
    "requirements.txt",
    "manifest.json",
    "sw.js",
    "templates/index.html",
    "templates/login.html",
    "static",
    "static/js/app.js",
    "static/js/auth.js",
    "static/js/config.js",
    "static/js/dashboard.js",
    "static/js/hosts.js",
    "static/js/quality.js",
    "static/js/scans.js",
    "static/js/scripts.js",
    "static/js/services.js",
    "routers/__init__.py",
    "routers/auth.py",
    "routers/alerts.py",
    "routers/config_api.py",
    "routers/daily_report.py",
    "routers/export_scheduler.py",
    "routers/hosts.py",
    "routers/quality.py",
    "routers/router_ssh.py",
    "routers/scans.py",
    "routers/scripts_status.py",
    "routers/services.py",
]

for relative_path in APP_PATHS:
    full_path = BASE_DIR / relative_path
    if full_path.exists():
        ok(relative_path)
    else:
        err(f"No encontrado: {relative_path}")

print()
print("═" * 72)
if errors == 0 and warnings == 0:
    print(f"  {OK}  Todo correcto — runtime listo para arrancar")
elif errors == 0:
    print(f"  {WARN} {warnings} advertencia(s) — puede arrancar, pero conviene revisar los warnings")
else:
    print(f"  {ERR}  {errors} error(es), {warnings} advertencia(s) — corrige los errores antes de arrancar")
print("═" * 72)
print()

sys.exit(0 if errors == 0 else 1)
