# Instalación: punto de entrada

Este documento indica **qué comprobar** y **qué guía seguir**. No contiene la configuración manual completa; esa referencia vive en [INSTALLATION_MANUAL.md](INSTALLATION_MANUAL.md).

## Paso 1 — comprobar prerrequisitos

No continúes hasta revisar el documento de [prerrequisitos por plataforma](../installers/PREREQUISITES.md).

### Resumen Linux

- Linux de 64 bits, x86-64 o ARM64;
- Docker Engine activo;
- Docker Compose V2 (`docker compose`);
- Git, Python 3, Curl, OpenSSL, iproute2 y tar;
- acceso al daemon Docker;
- IPv4 estable, puerto HTTPS libre y almacenamiento persistente.

Comprobación rápida:

```bash
uname -m
. /etc/os-release && printf '%s %s\n' "$ID" "$VERSION_ID"
docker version
docker compose version
./install.sh --check
```

### Resumen Windows

- Windows 11 x64 23H2 o posterior;
- virtualización habilitada y 8 GB de RAM;
- WSL 2.1.5 o posterior;
- Docker Desktop iniciado con backend WSL2 y contenedores Linux;
- Git, `docker.exe`, Compose V2 y `curl.exe` en `PATH`;
- unidades locales fijas para instalación y datos.

Comprobación rápida:

```powershell
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
.\installers\windows\install.ps1 -CheckOnly
```

El último comando de Docker debe devolver `linux`.

## Paso 2 — elegir método

| Necesidad | Método | Documento |
|---|---|---|
| Instalación recomendada en un servidor Linux | Asistente Linux | [`../installers/README.md`](../installers/README.md#linux--asistente-principal) |
| Instalación recomendada en Windows 11 | Asistente Windows | [`../installers/windows/README.md`](../installers/windows/README.md) |
| Control directo de `.env`, Compose y rutas | Instalación manual | [`INSTALLATION_MANUAL.md`](INSTALLATION_MANUAL.md) |
| Reubicar una instalación Windows ya activa | Migrador Windows | [`../installers/windows/README.md`](../installers/windows/README.md#reubicar-una-instalación-existente) |

### Regla práctica

Usa el asistente salvo que necesites mantener un Compose administrado por ti. La vía manual no aporta staging transaccional, detección guiada, rollback automático ni validación completa de rutas.

## Paso 3 — ejecutar una sola guía

### Asistente Linux

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh --check
./install.sh
```

### Asistente Windows

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

### Instalación manual

No empieces copiando plantillas sin preparar antes IP, CIDR, identidad, rutas y DNS. Sigue la [instalación manual con ejemplos completos](INSTALLATION_MANUAL.md).

## Paso 4 — validación final

La instalación se considera correcta únicamente si:

- `docker compose config --quiet` es válido;
- la imagen se construye;
- el contenedor está iniciado;
- `/api/system/healthz` responde por HTTPS;
- el certificado contiene la IP y DNS previstos;
- la base y los certificados son persistentes;
- exportaciones y backups escriben en las rutas esperadas;
- el primer administrador se crea desde el asistente web.

Comandos de comprobación:

```bash
docker compose ps
docker compose logs --tail 150
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

```powershell
docker compose ps
docker compose logs --tail 150
curl.exe -k --fail https://127.0.0.1:9909/api/system/healthz
```

## Paso 5 — después de instalar

- [Configuración](CONFIGURATION.md)
- [Seguridad](SECURITY.md)
- [Backup y restauración](BACKUP_RESTORE.md)
- [Solución de problemas](TROUBLESHOOTING.md)

El instalador del host no crea ni guarda la contraseña del administrador.

### Retirar una instalación

La desinstalación pertenece al ciclo de vida posterior y no forma parte de la
configuración manual de `.env` o Compose.

Antes de retirar el servicio, crea y verifica un backup.

Linux:

```bash
./install.sh --uninstall
```

Windows:

```powershell
.\installers\windows\uninstall.ps1
```

En Windows, el volumen Docker y las carpetas operativas se conservan por
defecto. Revisa la guía específica antes de solicitar cualquier purga.
