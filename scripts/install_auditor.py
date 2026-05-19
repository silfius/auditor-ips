#!/usr/bin/env python3
"""
Instalador servidor V4 de Auditor IPs.

Objetivo:
- Linux only.
- Clonar o actualizar desde Git publico.
- Generar .env y docker-compose.yml locales desde plantillas.
- Validar Docker Compose.
- Opcionalmente construir y arrancar el stack.
- No imprimir secretos.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import platform
import re
import shutil
import socket
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_REPO_URL = "https://github.com/silfius/auditor-ips.git"
DEFAULT_BRANCH = "main"
DEFAULT_TARGET_DIR = "/opt/auditor-ips"
DEFAULT_PORT = "9909"
DEFAULT_TLS_DNS = "auditips.local"
DEFAULT_CONTAINER_NAME = "auditor_ips"


@dataclass
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def log(message: str) -> None:
    print(message, flush=True)


def run_cmd(cmd: list[str], cwd: Path | None = None, check: bool = False, capture: bool = True) -> CommandResult:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    result = CommandResult(proc.returncode, proc.stdout or "", proc.stderr or "")
    if check and result.returncode != 0:
        raise RuntimeError(
            "Comando fallido: "
            + " ".join(cmd)
            + f"\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def read_os_release() -> dict[str, str]:
    path = Path("/etc/os-release")
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for line in path.read_text(errors="replace").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key] = value.strip().strip('"')
    return data


def detect_linux_family() -> str:
    data = read_os_release()
    raw = " ".join([data.get("ID", ""), data.get("ID_LIKE", ""), data.get("NAME", "")]).lower()
    if any(token in raw for token in ["debian", "ubuntu", "linuxmint", "raspbian"]):
        return "debian"
    if any(token in raw for token in ["arch", "manjaro", "endeavouros"]):
        return "arch"
    return "unknown"


def validate_platform() -> list[str]:
    warnings: list[str] = []
    if platform.system().lower() != "linux":
        raise RuntimeError("El instalador servidor V4 solo soporta Linux.")
    if detect_linux_family() == "unknown":
        warnings.append(
            "Distribucion Linux no clasificada como Debian/Ubuntu/Arch. "
            "Se continuara, pero revisa dependencias manualmente."
        )
    return warnings


def validate_commands() -> None:
    missing = [cmd for cmd in ["git", "docker"] if not command_exists(cmd)]
    if missing:
        raise RuntimeError("Faltan comandos requeridos: " + ", ".join(missing))
    result = run_cmd(["docker", "compose", "version"], capture=True)
    if result.returncode != 0:
        raise RuntimeError("Docker Compose no esta disponible mediante 'docker compose'.")


def is_probably_virtual_interface(name: str) -> bool:
    lowered = name.lower()
    prefixes = ("lo", "docker", "br-", "veth", "virbr", "tun", "tap", "wg", "zt", "tailscale")
    return lowered.startswith(prefixes)


def detect_ipv4_candidates() -> list[dict[str, str]]:
    result = run_cmd(["ip", "-o", "-4", "addr", "show", "scope", "global"], capture=True)
    if result.returncode != 0:
        return []

    candidates: list[dict[str, str]] = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        iface = parts[1]
        cidr_value = ""
        for idx, part in enumerate(parts):
            if part == "inet" and idx + 1 < len(parts):
                cidr_value = parts[idx + 1]
                break
        if not cidr_value or is_probably_virtual_interface(iface):
            continue
        try:
            iface_ip = ipaddress.ip_interface(cidr_value)
        except ValueError:
            continue
        candidates.append({"interface": iface, "ip": str(iface_ip.ip), "cidr": str(iface_ip.network)})
    return candidates


def default_server_ip() -> str:
    candidates = detect_ipv4_candidates()
    if candidates:
        return candidates[0]["ip"]
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return ""


def default_scan_cidr() -> str:
    candidates = detect_ipv4_candidates()
    if candidates:
        return candidates[0]["cidr"]
    return "192.168.1.0/24"



def sanitize_container_name(value: str) -> str:
    # Devuelve un nombre de contenedor compatible sin ocultar la eleccion del usuario.
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    cleaned = cleaned.strip("._-")
    if not cleaned:
        cleaned = DEFAULT_CONTAINER_NAME
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$", cleaned):
        cleaned = DEFAULT_CONTAINER_NAME
    return cleaned


def ask(prompt: str, default: str, assume_yes: bool) -> str:
    if assume_yes:
        return default
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def confirm(prompt: str, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    value = input(f"{prompt} [s/N]: ").strip().lower()
    return value in {"s", "si", "y", "yes"}


def ensure_parent(path: Path, dry_run: bool) -> None:
    if dry_run:
        log(f"DRY-RUN mkdir -p {path}")
        return
    path.mkdir(parents=True, exist_ok=True)


def clone_or_update_repo(repo_url: str, branch: str, target_dir: Path, dry_run: bool) -> None:
    if target_dir.exists() and (target_dir / ".git").exists():
        log("Repositorio existente detectado. Actualizando con git fetch/pull.")
        if dry_run:
            log(f"DRY-RUN git -C {target_dir} fetch origin {branch}")
            log(f"DRY-RUN git -C {target_dir} checkout {branch}")
            log(f"DRY-RUN git -C {target_dir} pull --ff-only origin {branch}")
            return
        run_cmd(["git", "fetch", "origin", branch], cwd=target_dir, check=True)
        run_cmd(["git", "checkout", branch], cwd=target_dir, check=True)
        run_cmd(["git", "pull", "--ff-only", "origin", branch], cwd=target_dir, check=True)
        return

    if target_dir.exists() and any(target_dir.iterdir()):
        raise RuntimeError(f"La ruta destino existe y no es un repo Git vacio: {target_dir}")

    ensure_parent(target_dir.parent, dry_run)
    if dry_run:
        log(f"DRY-RUN git clone --branch {branch} {repo_url} {target_dir}")
        return
    run_cmd(["git", "clone", "--branch", branch, repo_url, str(target_dir)], check=True)


def render_env(template_text: str, overrides: dict[str, str]) -> str:
    output: list[str] = []
    seen: set[str] = set()
    for line in template_text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in overrides:
                output.append(f"{key}={overrides[key]}")
                seen.add(key)
            else:
                output.append(line)
        else:
            output.append(line)
    for key, value in overrides.items():
        if key not in seen:
            output.append(f"{key}={value}")
    return "\n".join(output).rstrip() + "\n"


def write_local_config(target_dir: Path, args: argparse.Namespace, assume_yes: bool, dry_run: bool) -> dict[str, str]:
    env_template_path = target_dir / ".env.example"
    compose_template_path = target_dir / "docker-compose.yml.example"
    if not env_template_path.exists():
        raise RuntimeError(f"No existe plantilla .env.example en {target_dir}")
    if not compose_template_path.exists():
        raise RuntimeError(f"No existe plantilla docker-compose.yml.example en {target_dir}")

    detected_ip = default_server_ip()
    detected_cidr = default_scan_cidr()

    port = ask("Puerto web", args.port, assume_yes)
    container_name_raw = ask("Nombre del contenedor", args.container_name, assume_yes)
    container_name = sanitize_container_name(container_name_raw)
    if container_name != container_name_raw:
        log(f"WARN: nombre de contenedor normalizado a {container_name}")
    tls_dns = ask("DNS local para certificado", args.tls_dns, assume_yes)
    tls_ip = ask("IP para certificado TLS", args.tls_ip or detected_ip, assume_yes)
    server_ip = ask("SERVER_IP", args.server_ip or detected_ip, assume_yes)
    scan_cidr = ask("Red principal a auditar CIDR", args.scan_cidr or detected_cidr, assume_yes)

    env_overrides = {
        "AUDITOR_CONTAINER_NAME": container_name,
        "PORT": port,
        "DB_PATH": "/data/auditor.db",
        "DATA_DIR": args.data_dir,
        "EXPORTS_HOST_DIR": args.exports_dir,
        "TLS_CERT_IP": tls_ip,
        "TLS_CERT_DNS": tls_dns,
        "SERVER_IP": server_ip,
        "SCAN_CIDR": scan_cidr,
        "SESSION_TTL_HOURS": str(args.session_ttl_hours),
        "SCAN_RETENTION_DAYS": str(args.scan_retention_days),
    }

    env_path = target_dir / ".env"
    compose_path = target_dir / "docker-compose.yml"

    if env_path.exists() and not args.force_config:
        log(".env ya existe. No se sobrescribe.")
    else:
        rendered_env = render_env(env_template_path.read_text(), env_overrides)
        if dry_run:
            log(f"DRY-RUN escribir {env_path}")
        else:
            env_path.write_text(rendered_env)
            try:
                env_path.chmod(0o600)
            except OSError:
                pass
            log(f"Escrito {env_path}")

    if compose_path.exists() and not args.force_config:
        log("docker-compose.yml ya existe. No se sobrescribe.")
    else:
        if dry_run:
            log(f"DRY-RUN copiar {compose_template_path} -> {compose_path}")
        else:
            shutil.copy2(compose_template_path, compose_path)
            log(f"Escrito {compose_path}")

    for rel in ["data", "exports"]:
        target = target_dir / rel
        if dry_run:
            log(f"DRY-RUN mkdir -p {target}")
        else:
            target.mkdir(parents=True, exist_ok=True)

    return env_overrides


def write_install_state(target_dir: Path, args: argparse.Namespace, dry_run: bool, effective_config: dict[str, str]) -> None:
    git_head = ""
    result = run_cmd(["git", "rev-parse", "--short", "HEAD"], cwd=target_dir, capture=True)
    if result.returncode == 0:
        git_head = result.stdout.strip()

    effective_port = effective_config.get("PORT", args.port)
    effective_container_name = effective_config.get("AUDITOR_CONTAINER_NAME", args.container_name)

    state = {
        "installed_at": datetime.now(timezone.utc).isoformat(),
        "repo_url": args.repo_url,
        "branch": args.branch,
        "git_head": git_head,
        "target_dir": str(target_dir),
        "container_name": effective_container_name,
        "port": effective_port,
        "tls_cert_ip": effective_config.get("TLS_CERT_IP", ""),
        "tls_cert_dns": effective_config.get("TLS_CERT_DNS", ""),
        "server_ip": effective_config.get("SERVER_IP", ""),
        "scan_cidr": effective_config.get("SCAN_CIDR", ""),
        "data_dir": effective_config.get("DATA_DIR", ""),
        "exports_host_dir": effective_config.get("EXPORTS_HOST_DIR", ""),
        "no_start": bool(args.no_start),
    }

    summary = [
        "# Auditor IPs - resumen de instalacion",
        "",
        f"- Fecha UTC: {state['installed_at']}",
        f"- Repo: {args.repo_url}",
        f"- Rama: {args.branch}",
        f"- HEAD: {git_head}",
        f"- Ruta: {target_dir}",
        f"- Puerto: {effective_port}",
        f"- Contenedor: {effective_container_name}",
        f"- TLS DNS: {effective_config.get('TLS_CERT_DNS', '')}",
        f"- TLS IP: {effective_config.get('TLS_CERT_IP', '')}",
        f"- Red principal: {effective_config.get('SCAN_CIDR', '')}",
        "",
        "## Siguientes pasos",
        "",
        "```bash",
        f"cd {target_dir}",
        "docker compose up -d",
        f"curl -k https://127.0.0.1:{effective_port}/api/system/healthz",
        "```",
        "",
    ]

    if dry_run:
        log(f"DRY-RUN escribir {target_dir / 'install_state.json'}")
        log(f"DRY-RUN escribir {target_dir / 'install_summary.md'}")
        return

    (target_dir / "install_state.json").write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    (target_dir / "install_summary.md").write_text("\n".join(summary))


def validate_compose(target_dir: Path) -> None:
    result = run_cmd(["docker", "compose", "config", "--quiet"], cwd=target_dir, capture=True)
    if result.returncode != 0:
        raise RuntimeError("docker compose config --quiet fallo.\n" + result.stdout + "\n" + result.stderr)
    log("docker compose config --quiet OK")


def build_and_start(target_dir: Path, no_start: bool) -> None:
    log("Ejecutando docker compose build")
    run_cmd(["docker", "compose", "build"], cwd=target_dir, check=True, capture=False)
    if no_start:
        log("Omitido docker compose up -d por --no-start")
        return
    log("Ejecutando docker compose up -d")
    run_cmd(["docker", "compose", "up", "-d"], cwd=target_dir, check=True, capture=False)
    log("Validando healthz")
    result = run_cmd(["bash", "-lc", "curl -kfsS https://127.0.0.1:${PORT:-9909}/api/system/healthz >/dev/null"], cwd=target_dir, capture=True)
    if result.returncode != 0:
        log("WARN: healthz no respondio correctamente. Revisar docker compose logs.")
    else:
        log("healthz OK")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Instalador servidor V4 de Auditor IPs.")
    parser.add_argument("--repo-url", default=DEFAULT_REPO_URL)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--target-dir", default=DEFAULT_TARGET_DIR)
    parser.add_argument("--port", default=DEFAULT_PORT)
    parser.add_argument("--container-name", default=DEFAULT_CONTAINER_NAME)
    parser.add_argument("--tls-dns", default=DEFAULT_TLS_DNS)
    parser.add_argument("--tls-ip", default="")
    parser.add_argument("--server-ip", default="")
    parser.add_argument("--scan-cidr", default="")
    parser.add_argument("--data-dir", default="./data")
    parser.add_argument("--exports-dir", default="./exports")
    parser.add_argument("--session-ttl-hours", type=int, default=8)
    parser.add_argument("--scan-retention-days", type=int, default=14)
    parser.add_argument("--yes", action="store_true", help="Usa defaults sin preguntar.")
    parser.add_argument("--dry-run", action="store_true", help="Muestra acciones sin escribir.")
    parser.add_argument("--check-only", action="store_true", help="Solo valida plataforma y dependencias.")
    parser.add_argument("--no-start", action="store_true", help="No ejecuta docker compose up -d.")
    parser.add_argument("--no-build", action="store_true", help="No ejecuta docker compose build.")
    parser.add_argument("--force-config", action="store_true", help="Sobrescribe .env/docker-compose.yml locales.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_dir = Path(args.target_dir).expanduser().resolve()

    log("### Auditor IPs - instalador servidor V4")
    log(f"repo_url={args.repo_url}")
    log(f"branch={args.branch}")
    log(f"target_dir={target_dir}")

    try:
        warnings = validate_platform()
        validate_commands()
        for warning in warnings:
            log("WARN: " + warning)

        candidates = detect_ipv4_candidates()
        if candidates:
            log("Redes detectadas:")
            for item in candidates:
                log(f"- {item['interface']}: {item['ip']} / {item['cidr']}")
        else:
            log("WARN: no se detectaron redes IPv4 globales con iproute2.")

        if args.check_only:
            log("check-only OK")
            return 0

        if target_dir.exists() and not args.yes:
            if not confirm(f"Continuar usando {target_dir}", args.yes):
                log("Cancelado por el usuario.")
                return 1

        clone_or_update_repo(args.repo_url, args.branch, target_dir, args.dry_run)
        effective_config = write_local_config(target_dir, args, args.yes, args.dry_run)

        if args.dry_run:
            log("dry-run OK")
            return 0

        validate_compose(target_dir)
        write_install_state(target_dir, args, args.dry_run, effective_config)

        if not args.no_build:
            build_and_start(target_dir, args.no_start)
        else:
            log("Omitido build por --no-build")

        log("Instalacion/validacion completada.")
        return 0

    except Exception as exc:
        log(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
