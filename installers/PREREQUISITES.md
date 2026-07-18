# Prerrequisitos de instalación

Este documento define el contrato de plataforma de Auditor IPs. Cumplir los requisitos de Docker no implica automáticamente que una plataforma esté soportada por el instalador del proyecto.

## Matriz de soporte

| Plataforma | Arquitecturas del proyecto | Runtime | Estado |
|---|---|---|---|
| Linux de 64 bits | x86_64/amd64 y arm64/aarch64 | Docker Engine y Compose V2 | Soportado |
| Windows 11 23H2+ | AMD64/x86-64 | Docker Desktop, WSL2 y contenedores Linux | Soportado |
| Windows 11 ARM64 | — | — | Fuera de alcance actual |
| Windows 10 | — | — | Fuera de alcance del instalador del proyecto |
| Windows Server | — | — | No soportado por Docker Desktop |

## Requisitos comunes

- Acceso a la LAN que se desea auditar.
- IPv4 estable o reserva DHCP para el servidor.
- Puerto HTTPS libre; el valor predeterminado es `9909`.
- Acceso saliente HTTPS para clonar el repositorio, descargar paquetes e imágenes y construir la imagen inicial.
- Almacenamiento persistente para la base, certificados y backups.
- Capacidad para ejecutar contenedores Linux.
- Git si se instala mediante `git clone`.

El proyecto considera **2 GiB libres como mínimo** y **5 GiB recomendados** en el destino de instalación, sin contar el crecimiento de backups y exportaciones.

## Windows 11 AMD64/x86-64

### Sistema y hardware

- Windows 11 de 64 bits, versión 23H2 o posterior, build `22631+`.
- Arquitectura nativa AMD64/x86-64. ARM64, x86 y emulación cruzada se rechazan.
- Procesador con SLAT, virtualización habilitada en BIOS/UEFI y al menos 8 GB de RAM.
- Servicio Windows `LanmanServer` habilitado según los requisitos de Docker Desktop.

El preflight contrasta la arquitectura expuesta por .NET, las variables nativas de Windows y `Win32_Processor`. Una discrepancia detiene la instalación antes de consultar Docker.

### Software previo

- Docker Desktop para Windows x86_64, instalado, iniciado y con licencia aceptada cuando corresponda.
- Backend WSL2 habilitado.
- WSL `2.1.5` o posterior; se recomienda la versión estable más reciente.
- Docker Desktop configurado para contenedores Linux.
- `docker.exe`, `docker compose` y `curl.exe` disponibles en `PATH`.
- Windows PowerShell 5.1. PowerShell 7 es opcional y permite una segunda ejecución del validador.

El instalador de Auditor IPs **no** instala Docker Desktop, WSL, Git ni actualizaciones del sistema; tampoco reinicia Windows.

### Red y almacenamiento

- Rutas absolutas en unidades locales fijas y con espacio suficiente.
- No se admiten rutas UNC, unidades extraíbles, ubicaciones de nube ni directorios bajo TEMP, TMP o Descargas.
- La base de datos y los certificados se guardan en el volumen Docker `auditor_ips_data`.
- Instalación, exportaciones, backups y diagnósticos deben estar en rutas permanentes; las carpetas operativas quedan fuera del directorio de código.
- La regla de firewall es independiente y requiere PowerShell elevado.

### Verificación previa

```powershell
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
.\installers\windows\install.ps1 -CheckOnly
```

La validación técnica adicional está disponible mediante:

```powershell
.\installers\windows\validate-windows.cmd
```

En un clon Git, el validador verifica scripts, contratos y pruebas sin exigir el manifiesto externo de un ZIP de release. En un paquete de release, verifica además `BUNDLE_MANIFEST.sha256` cuando está presente.

## Linux x86_64/amd64 y arm64/aarch64

### Sistema

- Linux de 64 bits con `/etc/os-release`.
- Arquitectura x86_64/amd64 o arm64/aarch64.
- Docker Engine activo y Docker Compose V2 (`docker compose`).
- `git`, `python3`, `curl`, `ca-certificates`, `openssl`, `iproute2` (`ip`) y `tar`.
- Acceso al daemon Docker con el usuario actual o mediante `sudo`.

La instalación automática de dependencias contempla familias Debian/Ubuntu/Linux Mint y Arch/Manjaro. En otras distribuciones, el asistente no modifica paquetes, pero puede continuar si los comandos requeridos ya existen.

### Permisos y firewall

- `sudo` solo es necesario para instalar dependencias, iniciar o habilitar Docker o usar `--system-install`.
- La pertenencia al grupo `docker` concede privilegios equivalentes a administración del host; no se añade al usuario sin autorización.
- Revisa las reglas del host y las implicaciones de Docker. En redes bridge, los puertos publicados pueden no seguir exclusivamente las reglas de UFW; en Linux Auditor IPs usa red host, donde Docker no crea reglas de publicación de puertos.

### Verificación previa

```bash
uname -m
. /etc/os-release && printf '%s %s\n' "$ID" "$VERSION_ID"
docker version
docker compose version
./install.sh --check
```

Para autorizar dependencias ausentes:

```bash
./install.sh --install-deps
```

`--yes` no autoriza por sí solo retirar paquetes Docker conflictivos.

## Referencias oficiales

Consultadas el 18 de julio de 2026:

- Docker Desktop para Windows: <https://docs.docker.com/desktop/setup/install/windows-install/>
- Backend WSL2 de Docker Desktop: <https://docs.docker.com/desktop/features/wsl/>
- Docker Engine: <https://docs.docker.com/engine/install/>
- Docker Engine en Ubuntu y consideraciones de firewall: <https://docs.docker.com/engine/install/ubuntu/>
- Filtrado de paquetes y firewalls de Docker: <https://docs.docker.com/engine/network/packet-filtering-firewalls/>
- Postinstalación de Docker Engine: <https://docs.docker.com/engine/install/linux-postinstall/>
- Comandos de WSL: <https://learn.microsoft.com/windows/wsl/basic-commands>
