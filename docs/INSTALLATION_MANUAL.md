# Instalación manual con Docker Compose

Esta guía documenta únicamente la vía manual. Para los asistentes, consulta [installers/README.md](../installers/README.md).

La instalación manual permite controlar `.env`, `docker-compose.yml`, rutas y ciclo de arranque, pero no ofrece todas las salvaguardas de los asistentes:

- no hay staging transaccional;
- no se detectan automáticamente todos los valores de red;
- no se genera un estado completo del instalador;
- no existe rollback automático de una instalación inicial fallida;
- el operador debe validar persistencia, TLS y firewall.

Antes de empezar, completa los [prerrequisitos de la plataforma](../installers/PREREQUISITES.md).

## Valores que debes decidir

Prepara esta ficha antes de editar archivos:

| Valor | Ejemplo Linux | Ejemplo Windows |
|---|---|---|
| IP fija del servidor | `192.168.1.20` | `192.168.1.40` |
| Red a auditar | `192.168.1.0/24` | `192.168.1.0/24` |
| Puerto HTTPS | `9909` | `9909` |
| DNS local | `auditips.local` | `auditips.local` |
| Identidad del site | `auditor_casa_01` | `auditor_casa_win_01` |
| Cookie de sesión | `auditor_session_casa_01` | `auditor_session_casa_win_01` |
| Datos persistentes | `./data` | volumen `auditor_ips_data` |
| Exportaciones | `./exports` | `E:/AuditorIpsData/exports` |
| Backups | `./data/backups` | `E:/AuditorIpsData/backups` |
| Diagnósticos | `./diagnostics` | `E:/AuditorIpsData/diagnostics` |

`AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME` deben ser únicos por site.

## Linux: ejemplo completo

### 1. Clonar y comprobar

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips

uname -m
docker version
docker compose version
docker info >/dev/null
```

Identifica la interfaz conectada a la LAN:

```bash
ip -br -4 addr
ip route show default
```

En este ejemplo se usa:

```text
Interfaz: enp3s0
IP:       192.168.1.20
Red:      192.168.1.0/24
Puerto:   9909
```

### 2. Crear configuración y carpetas

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data data/backups exports diagnostics
chmod 700 data data/backups diagnostics
chmod 600 .env
```

### 3. `.env` completo de ejemplo

Edita `.env` y sustituye los valores de ejemplo por los de tu red:

```dotenv
# Identidad del site
AUDITOR_CONTAINER_NAME=auditor_ips
AUDITOR_INSTANCE_ID=auditor_casa_01
SESSION_COOKIE_NAME=auditor_session_casa_01
SESSION_COOKIE_SECURE=1
SESSION_COOKIE_SAMESITE=strict

# Servicio
PORT=9909
DB_PATH=/data/auditor.db

# Persistencia Linux
DATA_DIR=./data
EXPORTS_HOST_DIR=./exports
BACKUPS_HOST_DIR=./data/backups
DIAGNOSTICS_HOST_DIR=./diagnostics

# Acceso y certificado
SERVER_IP=192.168.1.20
TLS_CERT_IP=192.168.1.20
TLS_CERT_DNS=auditips.local

# Red a auditar
NETWORK_INTERFACE=enp3s0
SCAN_CIDR=192.168.1.0/24

# DNS opcional del contenedor
DOCKER_DNS=
DOCKER_DNS_SEARCH=

# Sesiones y retención
SESSION_TTL_HOURS=8
SCAN_RETENTION_DAYS=14
INSTALLATION_PROFILE=manual

# Notificaciones opcionales
DISCORD_WEBHOOK_URL=
NOTIFY_NEW=1
NOTIFY_ONLINE=0
NOTIFY_OFFLINE=0
NOTIFY_MAC_CHANGE=0
```

Notas:

- `SERVER_IP` debe ser accesible desde los clientes.
- `TLS_CERT_IP` debe coincidir con la IP usada en el navegador.
- `TLS_CERT_DNS` añade el nombre al certificado, pero no crea el registro DNS.
- `DIAGNOSTICS_HOST_DIR` es usado por las herramientas de diagnóstico del host.
- No publiques el `.env` real.

### 4. `docker-compose.yml` completo de ejemplo

El contenido canónico parte de `docker-compose.yml.example`:

```yaml
services:
  auditor_ips:
    build:
      context: ./app
      dockerfile: dockerfile
    container_name: ${AUDITOR_CONTAINER_NAME:-auditor_ips}
    network_mode: "host"
    cap_add:
      - NET_ADMIN
      - NET_RAW
    env_file:
      - .env
    environment:
      PORT: ${PORT:-9909}
      DB_PATH: ${DB_PATH:-/data/auditor.db}
      AUDITOR_INSTANCE_ID: ${AUDITOR_INSTANCE_ID:-}
      SESSION_COOKIE_NAME: ${SESSION_COOKIE_NAME:-}
      SESSION_COOKIE_SECURE: ${SESSION_COOKIE_SECURE:-1}
      SESSION_COOKIE_SAMESITE: ${SESSION_COOKIE_SAMESITE:-strict}
      TLS_CERT_IP: ${TLS_CERT_IP:-}
      TLS_CERT_DNS: ${TLS_CERT_DNS:-auditips.local}
      SERVER_IP: ${SERVER_IP:-}
      SCRIPTS_STATUS_DIR: /data/scripts_status
      SCRIPTS_PROMPTS_DIR: /data/scripts_prompts
      EXPORTS_DIR: /data/exports
    volumes:
      - ${DATA_DIR:-./data}:/data
      - ${EXPORTS_HOST_DIR:-./exports}:/data/exports
      - ${BACKUPS_HOST_DIR:-./data/backups}:/data/backups
    restart: unless-stopped
```

#### DNS interno opcional

Si el contenedor debe resolver nombres internos y el DNS predeterminado de Docker no sirve, añade valores YAML explícitos bajo el servicio:

```yaml
    dns:
      - 192.168.1.1
    dns_search:
      - home.arpa
```

No pongas un DNS público si necesitas resolver nombres privados de la LAN.

### 5. Validar y arrancar

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

Si falla:

```bash
docker compose logs --tail 200
```

### 6. DNS local y acceso

Para usar `https://auditips.local:9909`, crea un registro en tu DNS local:

```text
auditips.local -> 192.168.1.20
```

Como prueba temporal en un cliente, puede usarse su archivo `hosts`. El nombre debe coincidir exactamente con `TLS_CERT_DNS`.

Acceso directo por IP:

```text
https://192.168.1.20:9909/login
```

### 7. Firewall Linux

Permite el puerto solo desde la LAN o VPN. El comando exacto depende del firewall del sistema. No abras `9909` a Internet.

## Windows: ejemplo completo

### 1. Comprobar Docker Desktop y WSL2

En PowerShell:

```powershell
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
```

El último comando debe devolver:

```text
linux
```

### 2. Clonar y preparar carpetas

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips

New-Item -ItemType Directory -Force 'E:\AuditorIpsData\exports' | Out-Null
New-Item -ItemType Directory -Force 'E:\AuditorIpsData\backups' | Out-Null
New-Item -ItemType Directory -Force 'E:\AuditorIpsData\diagnostics' | Out-Null

Copy-Item .\installers\windows\env.windows.example .\.env
Copy-Item .\installers\windows\docker-compose.windows.yml.example .\docker-compose.yml
```

Usa unidades locales fijas. No uses UNC, TEMP, Descargas ni una carpeta sincronizada con nube.

### 3. `.env` completo de ejemplo

En `.env`, Docker Compose acepta rutas Windows con `/`:

```dotenv
# Proyecto e identidad
COMPOSE_PROJECT_NAME=auditor_ips
AUDITOR_CONTAINER_NAME=auditor_ips
AUDITOR_INSTANCE_ID=auditor_casa_win_01
SESSION_COOKIE_NAME=auditor_session_casa_win_01
SESSION_COOKIE_SECURE=1
SESSION_COOKIE_SAMESITE=strict
SESSION_TTL_HOURS=8

# Servicio y persistencia
PORT=9909
DB_PATH=/data/auditor.db
DATA_VOLUME=auditor_ips_data
EXPORTS_HOST_DIR=E:/AuditorIpsData/exports
BACKUPS_HOST_DIR=E:/AuditorIpsData/backups
DIAGNOSTICS_HOST_DIR=E:/AuditorIpsData/diagnostics

# TLS y red
SERVER_IP=192.168.1.40
TLS_CERT_IP=192.168.1.40
TLS_CERT_DNS=auditips.local
NETWORK_INTERFACE=
SCAN_CIDR=192.168.1.0/24
DISCOVERY_PROBE_IP=

# Perfil Windows
PLATFORM_PROFILE=windows_desktop
DISCOVERY_MODE=l3_compat
INSTALLATION_PROFILE=manual
SCAN_RETENTION_DAYS=14

# Notificaciones opcionales
DISCORD_WEBHOOK_URL=
NOTIFY_NEW=1
NOTIFY_ONLINE=0
NOTIFY_OFFLINE=0
NOTIFY_MAC_CHANGE=0
```

No cambies `PLATFORM_PROFILE` ni `DISCOVERY_MODE` para aparentar capacidades de capa 2 que Docker Desktop no garantiza.

### 4. `docker-compose.yml` completo de ejemplo

```yaml
services:
  auditor_ips:
    build:
      context: ./app
      dockerfile: dockerfile
    container_name: ${AUDITOR_CONTAINER_NAME:-auditor_ips}
    restart: unless-stopped
    ports:
      - "${PORT:-9909}:${PORT:-9909}"
    cap_add:
      - NET_ADMIN
      - NET_RAW
    env_file:
      - .env
    environment:
      PORT: ${PORT:-9909}
      DB_PATH: ${DB_PATH:-/data/auditor.db}
      AUDITOR_INSTANCE_ID: ${AUDITOR_INSTANCE_ID:-}
      SESSION_COOKIE_NAME: ${SESSION_COOKIE_NAME:-}
      SESSION_COOKIE_SECURE: ${SESSION_COOKIE_SECURE:-1}
      SESSION_COOKIE_SAMESITE: ${SESSION_COOKIE_SAMESITE:-strict}
      TLS_CERT_IP: ${TLS_CERT_IP:-}
      TLS_CERT_DNS: ${TLS_CERT_DNS:-auditips.local}
      SERVER_IP: ${SERVER_IP:-}
      SCAN_CIDR: ${SCAN_CIDR:-192.168.1.0/24}
      NETWORK_INTERFACE: ""
      DISCOVERY_PROBE_IP: ""
      PLATFORM_PROFILE: windows_desktop
      DISCOVERY_MODE: l3_compat
      EXPORTS_DIR: /data/exports
      SCRIPTS_STATUS_DIR: /data/scripts_status
      SCRIPTS_PROMPTS_DIR: /data/scripts_prompts
    volumes:
      - type: volume
        source: auditor_data
        target: /data
      - type: bind
        source: ${EXPORTS_HOST_DIR:-./exports}
        target: /data/exports
      - type: bind
        source: ${BACKUPS_HOST_DIR:-./backups}
        target: /data/backups
      - type: bind
        source: ${DIAGNOSTICS_HOST_DIR:-./diagnostics}
        target: /data/diagnostics

volumes:
  auditor_data:
    name: ${DATA_VOLUME:-auditor_ips_data}
```

Mantén el archivo en la raíz del clon. Si mueves Compose a otro directorio, `build.context: ./app` dejará de apuntar al código y deberás corregirlo.

### 5. Validar y arrancar

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl.exe -k --fail https://127.0.0.1:9909/api/system/healthz
```

Logs:

```powershell
docker compose logs --tail 200
```

### 6. Firewall Windows

La instalación manual no crea la regla de firewall. Abre PowerShell como administrador:

```powershell
.\installers\windows\firewall.ps1 -Port 9909
```

La regla se limita al perfil privado. Para retirarla:

```powershell
.\installers\windows\firewall.ps1 -Port 9909 -Remove
```

### 7. DNS local y acceso

Crea en el DNS de la LAN:

```text
auditips.local -> 192.168.1.40
```

`TLS_CERT_DNS=auditips.local` solo incluye el nombre en el certificado; no configura el DNS del router ni de Windows.

Acceso:

```text
https://192.168.1.40:9909/login
https://auditips.local:9909/login
```

## Variables de configuración

| Variable | Linux | Windows | Finalidad |
|---|---:|---:|---|
| `PORT` | Sí | Sí | Puerto HTTPS |
| `AUDITOR_CONTAINER_NAME` | Sí | Sí | Nombre del contenedor |
| `AUDITOR_INSTANCE_ID` | Sí | Sí | Identidad única del site |
| `SESSION_COOKIE_NAME` | Sí | Sí | Evita colisiones de sesión |
| `SESSION_COOKIE_SECURE` | Sí | Sí | Cookie solo por HTTPS |
| `SESSION_COOKIE_SAMESITE` | Sí | Sí | Política SameSite |
| `DB_PATH` | Sí | Sí | Ruta SQLite dentro del contenedor |
| `DATA_DIR` | Sí | No | Bind mount persistente Linux |
| `DATA_VOLUME` | No | Sí | Volumen Docker persistente Windows |
| `EXPORTS_HOST_DIR` | Sí | Sí | Exportaciones visibles en el host |
| `BACKUPS_HOST_DIR` | Sí | Sí | Backups visibles en el host |
| `DIAGNOSTICS_HOST_DIR` | Sí | Sí | Paquetes de diagnóstico |
| `TLS_CERT_IP` | Sí | Sí | IP incluida en el certificado |
| `TLS_CERT_DNS` | Sí | Sí | DNS incluido en el certificado |
| `SERVER_IP` | Sí | Sí | IP anunciada a los clientes |
| `NETWORK_INTERFACE` | Sí | Vacía | Interfaz LAN Linux |
| `SCAN_CIDR` | Sí | Sí | Red o redes a auditar |
| `PLATFORM_PROFILE` | No | `windows_desktop` | Perfil declarado en Windows |
| `DISCOVERY_MODE` | No | `l3_compat` | Capacidad declarada en Windows |
| `SCAN_RETENTION_DAYS` | Sí | Sí | Retención inicial |

## Qué falta después de Compose

Crear los dos archivos no completa por sí solo la instalación. Revisa esta lista:

- [ ] carpetas persistentes creadas y escribibles;
- [ ] identidad y cookie únicas;
- [ ] IP del servidor estable;
- [ ] CIDR correcto;
- [ ] puerto libre;
- [ ] DNS local creado si se usa nombre;
- [ ] firewall limitado a LAN/VPN;
- [ ] `docker compose config --quiet` correcto;
- [ ] build y arranque correctos;
- [ ] healthz HTTPS correcto;
- [ ] certificado con SAN de IP y DNS esperados;
- [ ] CA local instalada solo en clientes de confianza;
- [ ] primer administrador creado en el asistente web;
- [ ] backup inicial y estrategia de copias externas definidos.

## TLS y primer acceso

La primera ejecución genera una CA local y un certificado de servidor. El navegador puede advertir que la CA no es de confianza hasta instalar `ca.crt` en los dispositivos autorizados.

Nunca distribuyas:

- `ca.key`;
- `server.key`;
- la base de datos;
- el `.env` real.

En una base nueva, el navegador inicia el asistente para crear el primer administrador y configurar idioma, zona horaria, red, módulos, retención y notificaciones.

## Mantenimiento posterior

- [Configuración](CONFIGURATION.md)
- [Actualización y rollback](UPGRADE.md)
- [Backup y restauración](BACKUP_RESTORE.md)
- [Seguridad](SECURITY.md)
- [Solución de problemas](TROUBLESHOOTING.md)

Windows no implementa upgrade ni rollback de versión en este release. Conserva `auditor_ips_data` y las carpetas operativas antes de sustituir una instalación.
