# Auditor IPs

Auditor IPs es una aplicación web self-hosted para inventariar, auditar y supervisar una red local desde un panel único.

Este repositorio público es el canal oficial de distribución para instalaciones externas. La documentación de `main` describe únicamente capacidades y comandos presentes en el propio repositorio.

## Instalar un nuevo site

Hay tres vías soportadas:

| Método | Plataforma | Cuándo usarlo |
|---|---|---|
| Asistente Linux | Linux x86-64 o ARM64 | Opción recomendada para un servidor permanente y máxima capacidad de descubrimiento LAN |
| Asistente Windows | Windows 11 x64 | Cuando el servidor debe ejecutarse con Docker Desktop y backend WSL2 |
| Instalación manual | Linux o Windows | Cuando se necesita controlar directamente `.env`, Compose, rutas y ciclo de arranque |

Consulta primero los [prerrequisitos](installers/PREREQUISITES.md) y la [guía de instalación](docs/INSTALL.md).

### Linux — asistente recomendado

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

Comprobación previa y mantenimiento:

```bash
./install.sh --check
./install.sh --diagnose
./install.sh --upgrade
./install.sh --rollback
./install.sh --uninstall
```

`install.sh` puede instalar dependencias en familias compatibles, pero siempre solicita autorización antes de usar `sudo` o retirar paquetes Docker conflictivos.

### Windows 11 — asistente

Requiere Docker Desktop abierto, WSL 2.1.5 o posterior, backend WSL2 y contenedores Linux. El instalador no instala estas dependencias ni reinicia Windows.

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

La regla de firewall es una acción separada y requiere PowerShell elevado:

```powershell
.\installers\windows\firewall.ps1 -Port 9909
```

Windows usa red bridge de Docker Desktop y publica el puerto HTTPS. El perfil registrado es `windows_desktop` con `DISCOVERY_MODE=l3_compat`; no se presume paridad de capa 2 con Linux.

### Instalación manual

La instalación manual está descrita paso a paso en [docs/INSTALLATION_MANUAL.md](docs/INSTALLATION_MANUAL.md). Incluye plantillas, variables, almacenamiento, TLS, validación y diferencias entre plataformas.

## Funciones principales

- descubrimiento e inventario de hosts;
- histórico de disponibilidad y eventos;
- diagnóstico de calidad de red;
- supervisión de servicios y aplicaciones internas;
- monitorización de automatizaciones locales o remotas;
- agentes API para recibir estados;
- Syncthing Control en modo de observación;
- salud interna, backups, retención y mantenimiento de la base de datos;
- informes y notificaciones opcionales.

## Primer acceso

Al terminar, el instalador muestra una dirección similar a:

```text
https://IP_DEL_SERVIDOR:9909/login
```

En una instalación limpia, el asistente web inicial crea el primer administrador y configura idioma, zona horaria, red, retención, módulos y notificaciones. Los instaladores del host no solicitan ni almacenan la contraseña del administrador de Auditor IPs.

## Seguridad

- No expongas Auditor IPs directamente a Internet.
- Limita el acceso a la LAN o a una VPN.
- Conserva `.env`, datos, backups, tokens y certificados privados fuera de Git.
- El HTTPS inicial utiliza una CA local.
- Revisa las implicaciones de Docker, `NET_RAW` y `NET_ADMIN` antes de instalar.
- En Windows, las carpetas operativas y el volumen Docker se conservan por defecto durante la desinstalación.

## Documentación

- [Instalación rápida](docs/INSTALL.md)
- [Manual de instalación](docs/INSTALLATION_MANUAL.md)
- [Prerrequisitos](installers/PREREQUISITES.md)
- [Instalador Windows](installers/windows/README.md)
- [Manual de usuario](docs/USER_MANUAL.md)
- [Actualización y rollback](docs/UPGRADE.md)
- [Backup y restauración](docs/BACKUP_RESTORE.md)
- [Configuración](docs/CONFIGURATION.md)
- [Seguridad](docs/SECURITY.md)
- [Solución de problemas](docs/TROUBLESHOOTING.md)
- [Integración de scripts](docs/SCRIPTS_INTEGRATION.md)

Los enlaces relativos y los comandos documentados se comprueban mediante `scripts/test_documentation_contracts.py`.

## Colaboración

Usa Issues para errores o mejoras accionables y Discussions para dudas de instalación. No adjuntes `.env`, bases de datos, backups, tokens, webhooks, certificados privados ni logs sin revisar.

## Licencia

Consulta `LICENSE`.
