# Prerrequisitos de instalación

Este documento responde únicamente a la pregunta: **¿está preparado el sistema para instalar Auditor IPs?**

Cumplir los requisitos de Docker no implica automáticamente que una plataforma esté soportada por el instalador del proyecto.

## Matriz de soporte del proyecto

| Plataforma | Arquitecturas | Runtime | Estado |
|---|---|---|---|
| Linux de 64 bits | x86_64/amd64 y arm64/aarch64 | Docker Engine y Compose V2 | Soportado |
| Windows 11 23H2+ | AMD64/x86-64 | Docker Desktop, WSL2 y contenedores Linux | Soportado |
| Windows 11 ARM64 | — | — | Fuera de alcance actual |
| Windows 10 | — | — | Fuera de alcance del instalador del proyecto |
| Windows Server | — | — | Fuera de alcance |

## Requisitos comunes

Antes de elegir Linux o Windows, confirma:

- acceso a la LAN que se desea auditar;
- IPv4 estable o reserva DHCP para el servidor;
- puerto HTTPS libre; el predeterminado es `9909`;
- acceso saliente HTTPS para Git, paquetes, imágenes y build inicial;
- almacenamiento persistente para base, certificados y backups;
- capacidad para ejecutar contenedores Linux;
- Git si se instala mediante `git clone`;
- copia de seguridad externa prevista desde el inicio.

El proyecto exige **2 GiB libres como mínimo** y recomienda **5 GiB libres** en el destino de instalación, sin contar el crecimiento de backups, exportaciones e imágenes Docker.

## Linux x86_64/amd64 y arm64/aarch64

### Sistema y arquitectura

- Linux de 64 bits con `/etc/os-release`;
- arquitectura x86_64/amd64 o arm64/aarch64;
- Docker Engine activo;
- Docker Compose V2, invocable como `docker compose`;
- `git`, `python3`, `curl`, `ca-certificates`, `openssl`, `iproute2` (`ip`) y `tar`;
- acceso al daemon Docker con el usuario actual o mediante `sudo`.

### Distribuciones

El asistente puede instalar dependencias con autorización explícita en:

- Debian;
- Ubuntu;
- Linux Mint;
- Arch Linux;
- Manjaro;
- derivadas razonables de esas familias.

En otras distribuciones, el asistente no modifica paquetes. La instalación sigue siendo posible si todos los comandos requeridos ya están disponibles.

### Permisos

- `sudo` solo es necesario para instalar dependencias, iniciar o habilitar Docker o usar `--system-install`;
- pertenecer al grupo `docker` equivale prácticamente a disponer de privilegios administrativos sobre el host;
- el asistente no añade al usuario al grupo Docker sin autorización;
- si se usa Docker con `sudo`, mantén ese criterio en las operaciones posteriores.

### Red y firewall

Linux usa `network_mode: host` y capacidades `NET_ADMIN` y `NET_RAW` para diagnóstico y descubrimiento LAN. El puerto configurado queda escuchando directamente en el host; revisa el firewall del sistema y limita el acceso a la LAN o VPN.

### Comprobación previa Linux

Desde el clon:

```bash
uname -m
. /etc/os-release && printf 'Distribución: %s %s\n' "$ID" "$VERSION_ID"
command -v git python3 curl openssl ip tar docker
docker version
docker compose version
docker info >/dev/null
./install.sh --check
```

Para autorizar la instalación guiada de dependencias ausentes:

```bash
./install.sh --install-deps
```

`--yes` no autoriza por sí solo retirar paquetes Docker conflictivos.

## Windows 11 AMD64/x86-64

### Sistema y hardware

- Windows 11 de 64 bits, versión 23H2 o posterior, build `22631+`;
- arquitectura nativa AMD64/x86-64;
- procesador de 64 bits con SLAT;
- virtualización habilitada en BIOS/UEFI;
- al menos 8 GB de RAM;
- servicio Windows `LanmanServer` habilitado y con inicio automático.

El instalador del proyecto rechaza ARM64, x86 y emulación cruzada.

### Software previo

Debe estar instalado y operativo antes de ejecutar Auditor IPs:

- Docker Desktop para Windows x86_64;
- backend WSL2;
- WSL `2.1.5` o posterior;
- Docker Desktop configurado para contenedores Linux;
- Git;
- `docker.exe`, `docker compose` y `curl.exe` disponibles en `PATH`;
- Windows PowerShell 5.1; PowerShell 7 es opcional.

El instalador de Auditor IPs **no** instala Docker Desktop, WSL, Git ni actualizaciones del sistema; tampoco reinicia Windows.

### Red, rutas y almacenamiento

- usa rutas absolutas en unidades locales fijas;
- no uses UNC, unidades extraíbles, carpetas sincronizadas con nube, TEMP, TMP o Descargas;
- conserva instalación, exportaciones, backups y diagnósticos en rutas permanentes;
- deja las carpetas operativas fuera del directorio de código;
- la base y los certificados viven en el volumen Docker `auditor_ips_data`;
- la regla de firewall es independiente y requiere PowerShell elevado.

### Comprobación previa Windows

En PowerShell:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
Get-Service LanmanServer
.\installers\windows\install.ps1 -CheckOnly
```

Resultado esperado:

```text
Windows 11 x64 23H2 o posterior
WSL 2.1.5 o posterior
Docker OSType: linux
LanmanServer: Running
CheckOnly: sin errores bloqueantes
```

Validación técnica adicional:

```powershell
.\installers\windows\validate-windows.cmd
```

En un clon Git, el validador no exige un manifiesto externo. En un ZIP de release, verifica `BUNDLE_MANIFEST.sha256` cuando está presente.

## Antes de continuar

No ejecutes el instalador si queda pendiente alguno de estos puntos:

- arquitectura no soportada;
- Docker o Compose no accesibles;
- Docker Desktop usando contenedores Windows;
- WSL ausente o desactualizado;
- puerto ocupado sin decidir uno alternativo;
- rutas temporales o no persistentes;
- IP del servidor inestable;
- falta de espacio mínimo;
- ausencia de una estrategia de backup.

Cuando todo sea correcto, vuelve al [punto de entrada de instalación](../docs/INSTALL.md).

## Referencias oficiales

Consultadas el 18 de julio de 2026:

- Docker Desktop para Windows: <https://docs.docker.com/desktop/setup/install/windows-install/>
- Backend WSL2 de Docker Desktop: <https://docs.docker.com/desktop/features/wsl/>
- Docker Engine: <https://docs.docker.com/engine/install/>
- Docker Compose en Linux: <https://docs.docker.com/compose/install/linux/>
- Postinstalación de Docker Engine: <https://docs.docker.com/engine/install/linux-postinstall/>
- Comandos de WSL: <https://learn.microsoft.com/windows/wsl/basic-commands>
