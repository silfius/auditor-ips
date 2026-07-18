#!/usr/bin/env python3
"""Contratos entre documentación pública e instaladores de Auditor IPs."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REQUIRED_FILES = {
    "README.md",
    "docs/README.md",
    "docs/INSTALL.md",
    "docs/INSTALLATION_MANUAL.md",
    "docs/USER_MANUAL.md",
    "docs/CONFIGURATION.md",
    "docs/UPGRADE.md",
    "docs/BACKUP_RESTORE.md",
    "docs/SECURITY.md",
    "docs/TROUBLESHOOTING.md",
    "docs/SCRIPTS_INTEGRATION.md",
    "installers/README.md",
    "installers/PREREQUISITES.md",
    "installers/windows/README.md",
    "installers/windows/install.ps1",
    "installers/windows/migrate-installation.ps1",
    "installers/windows/diagnose.ps1",
    "installers/windows/firewall.ps1",
    "installers/windows/uninstall.ps1",
}

NORMATIVE_DOCS = {
    "README.md",
    "docs/README.md",
    "docs/INSTALL.md",
    "docs/INSTALLATION_MANUAL.md",
    "docs/USER_MANUAL.md",
    "docs/CONFIGURATION.md",
    "docs/UPGRADE.md",
    "docs/BACKUP_RESTORE.md",
    "docs/SECURITY.md",
    "docs/TROUBLESHOOTING.md",
    "docs/SCRIPTS_INTEGRATION.md",
    "installers/README.md",
    "installers/PREREQUISITES.md",
    "installers/windows/README.md",
}

PRIVATE_MARKERS = (
    "/SERVER/",
    "DOC_ONLINE/",
    "PROMPT_Auditor_IPs",
    "INDICE_Auditor_IPs",
    "ROADMAP_Auditor_IPs",
    "DECISIONES_Y_ERRORES",
    "SERVERCENTRALWI",
    "cpueyo",
)

MOJIBAKE_MARKERS = ("ÔÇ", "├", "┬À", "Ã¡", "Ã©", "Ã³")

UNSUPPORTED_DOC_PATTERNS = {
    r"install\.ps1\s+-Upgrade\b": "windows_install_upgrade_not_implemented",
    r"install\.ps1\s+-Rollback\b": "windows_install_rollback_not_implemented",
    r"install\.ps1\s+-InstallDependencies\b": "windows_dependency_install_not_implemented",
    r"install\.ps1\s+-Uninstall\b": "windows_uninstall_is_separate_script",
    r"-PurgeHostDirectories\b": "windows_host_directory_purge_not_implemented",
    r"installers[/\\]linux[/\\]install\.sh": "duplicate_linux_entrypoint_forbidden",
    r"installers[/\\]linux[/\\]install_auditor_agent\.py": "duplicate_linux_agent_path_forbidden",
}

SCRIPT_NAMES = {
    "install.ps1",
    "migrate-installation.ps1",
    "diagnose.ps1",
    "firewall.ps1",
    "uninstall.ps1",
}

POWERSHELL_COMMON_PARAMETERS = {
    "Verbose",
    "Debug",
    "ErrorAction",
    "WarningAction",
    "InformationAction",
    "ProgressAction",
    "ErrorVariable",
    "WarningVariable",
    "InformationVariable",
    "OutVariable",
    "OutBuffer",
    "PipelineVariable",
    "WhatIf",
    "Confirm",
}


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def markdown_links(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", text)


def check_links(root: Path, path: Path) -> list[str]:
    errors: list[str] = []
    for target in markdown_links(path):
        target = target.strip().strip("<>")
        if not target or "://" in target or target.startswith(("#", "mailto:")):
            continue
        target_path = target.split("#", 1)[0]
        if not target_path:
            continue
        local = (path.parent / target_path).resolve()
        try:
            local.relative_to(root)
        except ValueError:
            errors.append(f"link_escapes_repo:{relative(path, root)}:{target}")
            continue
        if not local.exists():
            errors.append(f"broken_link:{relative(path, root)}:{target}")
    return errors


def powershell_parameters(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    match = re.search(r"(?is)\bparam\s*\((.*?)\)\s*(?:\r?\n)", text)
    if not match:
        return set()
    return set(re.findall(r"\$(\w+)", match.group(1)))


def documented_powershell_commands(text: str) -> list[tuple[str, str]]:
    commands: list[tuple[str, str]] = []
    normalized = text.replace("`\n", " ").replace("`\r\n", " ")
    pattern = re.compile(
        r"(?im)^\s*(?:\.\\|&\s+[^\s]+\\)(?:installers\\windows\\)?"
        r"(?P<script>install|migrate-installation|diagnose|firewall|uninstall)\.ps1"
        r"(?P<args>[^\r\n]*)"
    )
    for match in pattern.finditer(normalized):
        commands.append((match.group("script") + ".ps1", match.group("args")))
    return commands


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    errors: list[str] = []

    for item in sorted(REQUIRED_FILES):
        if not (root / item).is_file():
            errors.append(f"missing:{item}")

    if errors:
        print("\n".join(errors))
        return 1

    markdown_files = sorted(root.rglob("*.md"))
    for path in markdown_files:
        errors.extend(check_links(root, path))

    for item in sorted(NORMATIVE_DOCS):
        text = (root / item).read_text(encoding="utf-8", errors="replace")
        for marker in MOJIBAKE_MARKERS:
            if marker in text:
                errors.append(f"mojibake:{item}:{marker}")

    parameter_map = {
        script: powershell_parameters(root / "installers" / "windows" / script)
        for script in SCRIPT_NAMES
    }

    all_normative = ""
    for item in sorted(NORMATIVE_DOCS):
        path = root / item
        text = path.read_text(encoding="utf-8", errors="replace")
        all_normative += f"\n<!-- {item} -->\n{text}"
        for marker in PRIVATE_MARKERS:
            if marker in text:
                errors.append(f"private_reference:{item}:{marker}")
        for pattern, code in UNSUPPORTED_DOC_PATTERNS.items():
            if re.search(pattern, text, flags=re.IGNORECASE):
                errors.append(f"{code}:{item}")
        for script, arguments in documented_powershell_commands(text):
            known = parameter_map[script] | POWERSHELL_COMMON_PARAMETERS
            used = set(re.findall(r"(?<!\w)-([A-Za-z][A-Za-z0-9]+)\b", arguments))
            for parameter in sorted(used - known):
                errors.append(
                    f"unknown_windows_parameter:{item}:{script}:-{parameter}"
                )

    required_phrases = {
        "README.md": (
            "./install.sh",
            ".\\installers\\windows\\install.ps1",
            "docs/INSTALLATION_MANUAL.md",
        ),
        "docs/UPGRADE.md": (
            "Windows no implementa upgrade ni rollback de versión",
        ),
        "installers/windows/README.md": (
            "no instala Docker Desktop",
            "migrate-installation.ps1",
            "uninstall.ps1",
            "DISCOVERY_MODE=l3_compat",
        ),
        "docs/SCRIPTS_INTEGRATION.md": (
            "host_name",
            "script_name",
            "Escritura atómica",
        ),
    }
    for item, phrases in required_phrases.items():
        text = (root / item).read_text(encoding="utf-8", errors="replace")
        for phrase in phrases:
            if phrase not in text:
                errors.append(f"required_phrase_missing:{item}:{phrase}")

    if "-PurgeData" not in all_normative:
        errors.append("windows_purge_data_contract_not_documented")
    if "carpetas" not in all_normative or "operativas" not in all_normative:
        errors.append("windows_operational_directory_preservation_not_documented")

    if errors:
        for error in sorted(set(errors)):
            print(error)
        return 1

    print(f"DOCUMENTATION_FILES_CHECKED={len(markdown_files)}")
    print("DOCUMENTATION_LINKS_OK")
    print("DOCUMENTATION_PRIVATE_REFERENCES_OK")
    print("DOCUMENTATION_WINDOWS_PARAMETERS_OK")
    print("DOCUMENTATION_CONTRACTS_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
