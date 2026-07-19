# Auditor IPs

Auditor IPs es una aplicación web self-hosted para inventariar, auditar y supervisar una red local desde un panel único.

Este repositorio público es el canal oficial de distribución para instalaciones externas. La documentación de `main` describe únicamente capacidades y comandos presentes en el propio repositorio.

## Instalar un nuevo site

Sigue este orden:

1. revisa los [prerrequisitos de Linux o Windows](installers/PREREQUISITES.md);
2. elige instalación asistida o manual en la [guía de inicio](docs/INSTALL.md);
3. completa el procedimiento de la plataforma elegida;
4. valida Compose, el contenedor, HTTPS y el primer acceso.

### Métodos disponibles

| Método | Plataforma | Recomendación |
|---|---|---|
| Asistente Linux | Linux x86-64 o ARM64 | Opción recomendada para un servidor permanente y máxima capacidad de descubrimiento LAN |
| Asistente Windows | Windows 11 x64 | Opción recomendada cuando el servidor debe ejecutarse con Docker Desktop y backend WSL2 |
| Instalación manual | Linux o Windows | Para administradores que necesitan controlar directamente `.env`, Compose, rutas y ciclo de arranque |

### Inicio rápido Linux

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh --check
./install.sh
```

### Inicio rápido Windows 11

Docker Desktop debe estar abierto, usar contenedores Linux y tener WSL2 operativo.

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

### Instalación manual

La [guía manual con Docker Compose](docs/INSTALLATION_MANUAL.md) contiene ejemplos completos y comentados de:

- `.env` para Linux y Windows;
- `docker-compose.yml` para Linux y Windows;
- carpetas persistentes;
- identidad del site y cookie;
- IP, CIDR, DNS y TLS;
- firewall, validación y primer acceso.

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

Al terminar, la aplicación queda disponible en una dirección similar a:

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

### Instalación

- [Punto de entrada](docs/INSTALL.md)
- [Prerrequisitos por plataforma](installers/PREREQUISITES.md)
- [Instalación asistida](installers/README.md)
- [Instalación manual con ejemplos completos](docs/INSTALLATION_MANUAL.md)
- [Instalador Windows](installers/windows/README.md)

### Operación

- [Manual de usuario](docs/USER_MANUAL.md)
- [Configuración](docs/CONFIGURATION.md)
- [Actualización y rollback](docs/UPGRADE.md)
- [Backup y restauración](docs/BACKUP_RESTORE.md)
- [Seguridad](docs/SECURITY.md)
- [Solución de problemas](docs/TROUBLESHOOTING.md)
- [Integración de scripts](docs/SCRIPTS_INTEGRATION.md)

Los enlaces relativos y los comandos documentados se comprueban mediante `scripts/test_documentation_contracts.py`.

## Colaboración

Usa Issues para errores o mejoras accionables y Discussions para dudas de instalación. No adjuntes `.env`, bases de datos, backups, tokens, webhooks, certificados privados ni logs sin revisar.

## Licencia

Consulta `LICENSE`.
