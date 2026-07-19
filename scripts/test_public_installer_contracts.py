#!/usr/bin/env python3
"""Contratos estáticos del instalador y documentación pública."""

from __future__ import annotations

import argparse
import sqlite3
import json
import ast
import re
import subprocess
import sys
import tempfile
import types
from pathlib import Path

REQUIRED_ACTIONS = {
    "--check",
    "--diagnose",
    "--upgrade",
    "--rollback",
    "--uninstall",
}
REQUIRED_INSTALLER_FLAGS = {
    "--check-only",
    "--diagnose",
    "--upgrade",
    "--rollback",
    "--uninstall",
    "--profile",
    "--backups-dir",
    "--diagnostics-dir",
    "--scan-cidr",
    "--server-ip",
    "--tls-ip",
    "--tls-dns",
}
REQUIRED_DOCS = {
    "README.md",
    "docs/INSTALL.md",
    "docs/UPGRADE.md",
    "docs/BACKUP_RESTORE.md",
    "docs/CONFIGURATION.md",
    "docs/SECURITY.md",
    "docs/TROUBLESHOOTING.md",
    "docs/USER_MANUAL.md",
}


def parser_flags(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    flags: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Attribute) or node.func.attr != "add_argument":
            continue
        for arg in node.args:
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value.startswith("--"):
                flags.add(arg.value)
    return flags


def check_links(root: Path, path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for target in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", text):
        target = target.strip()
        if not target or "://" in target or target.startswith(("#", "mailto:")):
            continue
        local = (path.parent / target.split("#", 1)[0]).resolve()
        if not local.exists():
            errors.append(f"broken_link:{path.relative_to(root)}:{target}")
    return errors


def compile_source(path: Path) -> None:
    """Valida sintaxis sin crear .pyc ni __pycache__."""
    source = path.read_text(encoding="utf-8")
    compile(source, str(path), "exec")


def compiled_artifacts(root: Path) -> list[str]:
    artifacts: list[str] = []
    for path in root.rglob("*"):
        if path.is_dir() and path.name == "__pycache__":
            artifacts.append(path.relative_to(root).as_posix() + "/")
        elif path.is_file() and path.suffix in {".pyc", ".pyo"}:
            artifacts.append(path.relative_to(root).as_posix())
    return sorted(artifacts)


def load_installer_module(path: Path) -> types.ModuleType:
    """Carga el instalador sin escribir bytecode ni ejecutar main()."""
    name = "auditor_installer_contract"
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    try:
        source = path.read_text(encoding="utf-8")
        exec(compile(source, str(path), "exec"), module.__dict__)
    finally:
        sys.modules.pop(name, None)
    return module



def check_windows_contract(root: Path) -> list[str]:
    errors: list[str] = []
    windows = root / "installers" / "windows"
    required = {
        "README.md", "common.ps1", "storage.ps1", "install.ps1",
        "migrate-installation.ps1", "diagnose.ps1", "firewall.ps1",
        "uninstall.ps1", "env.windows.example",
        "docker-compose.windows.yml.example", "tests/validate.ps1",
        "tests/test_contracts.ps1", "tests/test_mocked.ps1",
        "tests/test_real_payload.ps1",
    }
    for rel in required:
        if not (windows / rel).is_file():
            errors.append(f"windows_missing:{rel}")

    if errors:
        return errors

    install = (windows / "install.ps1").read_text(encoding="utf-8-sig", errors="replace")
    common = (windows / "common.ps1").read_text(encoding="utf-8-sig", errors="replace")
    storage = (windows / "storage.ps1").read_text(encoding="utf-8-sig", errors="replace")
    uninstall = (windows / "uninstall.ps1").read_text(encoding="utf-8-sig", errors="replace")
    env_text = (windows / "env.windows.example").read_text(encoding="utf-8-sig", errors="replace")
    compose = (windows / "docker-compose.windows.yml.example").read_text(
        encoding="utf-8-sig", errors="replace"
    )

    for token in (
        "PLATFORM_PROFILE=windows_desktop",
        "DISCOVERY_MODE=l3_compat",
        "Assert-AuditorWindows11Amd64",
        "Wait-AuditorHealth",
        "Assert-AuditorTlsSan",
        "Assert-AuditorBindMounts",
    ):
        if token not in install:
            errors.append(f"windows_install_contract_missing:{token}")

    for token in ("22631", "RuntimeInformation"):
        if token not in common:
            errors.append(f"windows_platform_contract_missing:{token}")

    if "microsoft-standard-WSL2" not in install:
        errors.append("windows_platform_contract_missing:microsoft-standard-WSL2")

    for token in (
        "New-AuditorStagedInstallation",
        "Get-AuditorFileSha256",
        "Remove-AuditorOwnedInstallation",
    ):
        if token not in storage:
            errors.append(f"windows_storage_contract_missing:{token}")

    if "PurgeData" not in uninstall or '"volume", "rm"' not in uninstall:
        errors.append("windows_uninstall_purge_contract_missing")

    for forbidden in ("winget", "Restart-Computer", "-Upgrade", "-Rollback"):
        if forbidden in install:
            errors.append(f"windows_install_forbidden:{forbidden}")

    for token in ("PLATFORM_PROFILE=windows_desktop", "DISCOVERY_MODE=l3_compat"):
        if token not in env_text:
            errors.append(f"windows_env_missing:{token}")

    for token in ("PLATFORM_PROFILE:", "DISCOVERY_MODE:", "ports:"):
        if token not in compose:
            errors.append(f"windows_compose_missing:{token}")

    config = (root / "app" / "config.py").read_text(encoding="utf-8", errors="replace")
    discovery = (root / "app" / "scan_discovery.py").read_text(
        encoding="utf-8", errors="replace"
    )
    for token in ("PLATFORM_PROFILE", "DISCOVERY_MODE", "windows_desktop", "l3_compat"):
        if token not in config:
            errors.append(f"runtime_config_missing:{token}")

    for token in (
        'if DISCOVERY_MODE != "full":\n        return []',
        'if DISCOVERY_MODE != "full":\n        return ""',
        'if DISCOVERY_MODE != "full":\n        return {}',
    ):
        if token not in discovery:
            errors.append(
                f"runtime_discovery_guard_missing:{token.splitlines()[-1].strip()}"
            )
    return errors

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    errors: list[str] = []

    install_sh = root / "install.sh"
    installer = root / "scripts" / "install_auditor.py"
    entrypoint = root / "app" / "entrypoint.sh"
    env_example = root / ".env.example"
    compose_example = root / "docker-compose.yml.example"

    for path in [install_sh, installer, entrypoint, env_example, compose_example]:
        if not path.is_file():
            errors.append(f"missing:{path.relative_to(root)}")

    for rel in REQUIRED_DOCS:
        if not (root / rel).is_file():
            errors.append(f"missing:{rel}")

    if errors:
        for error in errors:
            print(error)
        return 1

    shell_text = install_sh.read_text(encoding="utf-8")
    for token in (
        "installed_conflicting_docker_packages",
        "remove_conflicting_docker_packages",
        "install_compose_for_existing_docker_debian",
    ):
        if token not in shell_text:
            errors.append(f"install_sh_missing_dependency_safety:{token}")
    for action in REQUIRED_ACTIONS:
        if action not in shell_text:
            errors.append(f"install_sh_missing_action:{action}")

    flags = parser_flags(installer)
    for flag in REQUIRED_INSTALLER_FLAGS:
        if flag not in flags:
            errors.append(f"installer_missing_flag:{flag}")

    all_docs = "\n".join((root / rel).read_text(encoding="utf-8", errors="replace") for rel in REQUIRED_DOCS)
    for action in REQUIRED_ACTIONS:
        if f"./install.sh {action}" not in all_docs:
            errors.append(f"docs_missing_action:{action}")

    forbidden = {
        "ADMIN_PASSWORD_HASH": "legacy admin password environment variable",
        "PRIMARY_CIDR": "legacy network variable",
        "Está previsto crear un manual completo": "stale manual claim",
        "flujo avanzado de upgrade guiado desde el instalador está previsto": "stale upgrade claim",
    }
    public_text = all_docs + "\n" + env_example.read_text(encoding="utf-8")
    for token, description in forbidden.items():
        if token in public_text:
            errors.append(f"forbidden:{description}:{token}")

    entrypoint_text = entrypoint.read_text(encoding="utf-8")
    for legacy_ip in ("192.168.1.1", "192.168.1.253", "10.0.0.1"):
        if legacy_ip in entrypoint_text:
            errors.append(f"legacy_tls_san:{legacy_ip}")
    if "TLS_CERT_IP" not in entrypoint_text or "TLS_CERT_DNS" not in entrypoint_text:
        errors.append("entrypoint_missing_configured_sans")
    if "configured_sans" not in entrypoint_text or "[ \"$expected\" = \"$actual\" ]" not in entrypoint_text:
        errors.append("entrypoint_missing_exact_san_contract")
    for stale_dns in ("auditor.local",):
        if stale_dns in entrypoint_text:
            errors.append(f"legacy_tls_dns_san:{stale_dns}")

    installer_text = installer.read_text(encoding="utf-8")
    for token in (
        "def redact_text(",
        "secret_values_from_env",
        '"config", "--no-interpolate"',
        "Diagnóstico generado y verificado",
        "unexpected = sorted(actual - expected)",
        "def clean_dns_search_domain(",
        "def validate_upgrade_backup(",
        "def restore_sqlite_atomic(",
        "def restore_sqlite_with_docker(",
        "os.replace(temporary_db, target_db)",
    ):
        if token not in installer_text:
            errors.append(f"installer_missing_security_contract:{token}")

    try:
        installer_module = load_installer_module(installer)
        clean_domain = installer_module.clean_dns_search_domain
        domain_cases = {
            ".": "",
            "~.": "",
            "~": "",
            "Global": "",
            "192.168.1.1": "",
            "local": "local",
            "home.local.": "home.local",
            "~corp.example": "corp.example",
        }
        for raw, expected in domain_cases.items():
            actual = clean_domain(raw)
            if actual != expected:
                errors.append(
                    f"dns_search_normalization:{raw!r}:{expected!r}:{actual!r}"
                )

        with tempfile.TemporaryDirectory() as temporary:
            resolv = Path(temporary) / "resolv.conf"
            resolv.write_text(
                "nameserver 127.0.0.53\n"
                "search local . ~. home.local. 192.168.1.1\n",
                encoding="utf-8",
            )
            detected = installer_module.detect_resolv_conf_dns(resolv)
            if detected.get("search") != ["local", "home.local"]:
                errors.append(
                    "dns_search_resolv_conf:"
                    + repr(detected.get("search"))
                )
    except Exception as exc:
        errors.append(f"dns_search_contract_exception:{type(exc).__name__}:{exc}")

    try:
        with tempfile.TemporaryDirectory() as temporary:
            root_tmp = Path(temporary)
            backup_dir = root_tmp / "upgrade_backups" / "20260715-000000"
            backup_db = backup_dir / "data" / "auditor.db"
            backup_db.parent.mkdir(parents=True)

            connection = sqlite3.connect(backup_db)
            connection.execute("CREATE TABLE marker(value TEXT NOT NULL)")
            connection.execute("INSERT INTO marker(value) VALUES ('before-upgrade')")
            connection.commit()
            connection.close()

            manifest = {
                "created_at": "2026-07-15T00:00:00+00:00",
                "previous_git_head": "a" * 40,
                "files": [
                    {
                        "path": "data/auditor.db",
                        "bytes": backup_db.stat().st_size,
                        "sha256": installer_module.sha256_file(backup_db),
                    }
                ],
            }
            (backup_dir / "manifest.json").write_text(
                json.dumps(manifest, indent=2) + "\n",
                encoding="utf-8",
            )
            installer_module.validate_upgrade_backup(backup_dir)

            data_dir = root_tmp / "data"
            data_dir.mkdir()
            active_db = data_dir / "auditor.db"
            connection = sqlite3.connect(active_db)
            connection.execute("CREATE TABLE marker(value TEXT NOT NULL)")
            connection.execute("INSERT INTO marker(value) VALUES ('after-upgrade')")
            connection.commit()
            connection.close()
            active_db.chmod(0o444)
            (data_dir / "auditor.db-wal").write_bytes(b"stale")
            (data_dir / "auditor.db-shm").write_bytes(b"stale")

            method = installer_module.restore_sqlite_atomic(
                backup_db,
                data_dir,
            )
            if method != "host_atomic":
                errors.append(f"rollback_restore_method:{method}")
            if installer_module.sqlite_quick_check(active_db) != "ok":
                errors.append("rollback_quick_check")

            connection = sqlite3.connect(active_db)
            marker = connection.execute(
                "SELECT value FROM marker"
            ).fetchone()[0]
            connection.close()
            if marker != "before-upgrade":
                errors.append(f"rollback_db_content:{marker}")
            if (data_dir / "auditor.db-wal").exists():
                errors.append("rollback_stale_wal")
            if (data_dir / "auditor.db-shm").exists():
                errors.append("rollback_stale_shm")

            backup_db.write_bytes(backup_db.read_bytes() + b"tamper")
            try:
                installer_module.validate_upgrade_backup(backup_dir)
            except RuntimeError:
                pass
            else:
                errors.append("rollback_manifest_tamper_not_detected")
    except Exception as exc:
        errors.append(
            f"rollback_contract_exception:{type(exc).__name__}:{exc}"
        )

    env_keys = {
        line.split("=", 1)[0]
        for line in env_example.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    }
    for key in ("BACKUPS_HOST_DIR", "DIAGNOSTICS_HOST_DIR", "NETWORK_INTERFACE", "INSTALLATION_PROFILE"):
        if key not in env_keys:
            errors.append(f"env_missing:{key}")

    compose_text = compose_example.read_text(encoding="utf-8")
    if "${BACKUPS_HOST_DIR" not in compose_text:
        errors.append("compose_missing_backup_mount")
    if 'network_mode: "host"' not in compose_text:
        errors.append("compose_missing_host_network")
    for capability in ("NET_ADMIN", "NET_RAW"):
        if capability not in compose_text:
            errors.append(f"compose_missing_capability:{capability}")

    for rel in REQUIRED_DOCS:
        errors.extend(check_links(root, root / rel))

    for artifact in compiled_artifacts(root):
        errors.append(f"compiled_artifact_forbidden:{artifact}")

    commands = [
        ["bash", "-n", str(install_sh)],
        ["bash", "-n", str(entrypoint)],
    ]
    for command in commands:
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            errors.append(f"command_failed:{' '.join(command)}:{result.stderr.strip()}")

    try:
        compile_source(installer)
    except (OSError, SyntaxError, UnicodeError) as exc:
        errors.append(f"source_compile_failed:{installer.relative_to(root)}:{exc}")

    for artifact in compiled_artifacts(root):
        errors.append(f"compiled_artifact_created:{artifact}")

    errors.extend(check_windows_contract(root))

    if errors:
        for error in errors:
            print(error)
        return 1

    print("PUBLIC_INSTALLER_CONTRACTS_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
