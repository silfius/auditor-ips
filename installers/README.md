# Instalación asistida

Este directorio documenta únicamente los asistentes. Para editar `.env` y Compose directamente, usa la [guía de instalación manual](../docs/INSTALLATION_MANUAL.md).

Prerrequisitos detallados: revisa los [requisitos de Linux o Windows](PREREQUISITES.md) antes de ejecutar cualquier asistente.

## Linux — asistente principal

El punto de entrada Linux está en la raíz del repositorio:

```bash
./install.sh --check
./install.sh
```

El asistente:

1. identifica sistema y arquitectura;
2. comprueba comandos, Docker, Compose, permisos, espacio, red y puerto;
3. solicita autorización antes de usar `sudo` o instalar dependencias;
4. propone interfaz, IP, CIDR, DNS, TLS, identidad y almacenamiento;
5. genera `.env` y `docker-compose.yml`;
6. construye y arranca;
7. valida health HTTPS y SAN TLS;
8. escribe `install_state.json` e `install_summary.md`.

Acciones disponibles:

```bash
./install.sh --check
./install.sh --install-deps
./install.sh --diagnose
./install.sh --upgrade
./install.sh --rollback
./install.sh --uninstall
```

La instalación automática de dependencias está implementada para familias Debian/Ubuntu/Linux Mint y Arch/Manjaro. En otras distribuciones, instala los requisitos manualmente y repite `./install.sh --check`.

## Windows — asistente específico

La implementación vive en [`windows/`](windows/README.md):

```powershell
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

El asistente Windows no instala Docker Desktop, WSL, Git ni actualizaciones del sistema. Firewall, diagnóstico, migración y desinstalación son acciones separadas.

## Qué vía usar

| Situación | Vía |
|---|---|
| Servidor Linux permanente | Asistente Linux |
| Windows 11 con Docker Desktop | Asistente Windows |
| Compose administrado por el operador | Instalación manual |
| Reubicación de un site Windows existente | Migrador Windows |

No existe un segundo instalador Linux bajo `installers/linux/`; el contrato público Linux sigue siendo `./install.sh`.
