# Manual de instalación

Este es el documento canónico para instalar un nuevo site de Auditor IPs. Los requisitos de plataforma están centralizados en [`installers/PREREQUISITES.md`](../installers/PREREQUISITES.md); los documentos de actualización, backup y resolución de problemas no duplican este procedimiento.

## 1. Modelos de despliegue

### Linux nativo

Es la opción recomendada para un servidor permanente. El contenedor usa red host y capacidades `NET_ADMIN` y `NET_RAW`, lo que ofrece la integración LAN más completa admitida por el proyecto.

### Windows 11 con Docker Desktop

Usa Docker Desktop, backend WSL2 y contenedores Linux. El puerto se publica mediante red bridge. La aplicación, TLS, automatizaciones, backups y escaneo IP funcionan, pero no se garantiza la misma visibilidad ARP/MAC que en Linux.

El instalador registra:

```text
PLATFORM_PROFILE=windows_desktop
DISCOVERY_MODE=l3_compat
```

El instalador no detecta ni registra perfiles alternativos de descubrimiento en este release.

## 2. Asistente Linux

### Inicio

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

El asistente:

1. identifica distribución y arquitectura;
2. comprueba Git, Python, Curl, OpenSSL, iproute2, Docker y Compose;
3. solicita autorización antes de instalar dependencias o usar `sudo`;
4. propone interfaz, IP, CIDR, DNS, puerto y rutas;
5. genera `.env` y `docker-compose.yml`;
6. construye y arranca el servicio;
7. exige health HTTPS y SAN TLS válidos.

### Preflight

```bash
./install.sh --check
```

### Dependencias

```bash
./install.sh --install-deps
```

En distribuciones no reconocidas, el asistente informa de los requisitos sin modificar paquetes. `--yes` no autoriza retirar paquetes Docker conflictivos.

### Perfiles

```bash
./install.sh --profile recommended
./install.sh --profile advanced
```

El perfil avanzado permite revisar identidad, cookie, TLS, DNS, rutas y parámetros técnicos.

### Instalación de sistema

```bash
./install.sh --system-install
```

Usa `/opt/auditor-ips` y requiere permisos administrativos. La instalación en el clon actual es adecuada para pruebas y entornos administrados por el usuario.

### Instalación no interactiva

Ejemplo para un entorno controlado:

```bash
./install.sh --yes --install-deps \
  --port 9909 \
  --server-ip 192.168.1.20 \
  --tls-ip 192.168.1.20 \
  --tls-dns auditips.local \
  --scan-cidr 192.168.1.0/24 \
  --data-dir ./data \
  --exports-dir ./exports \
  --backups-dir ./data/backups \
  --diagnostics-dir ./diagnostics
```

No uses `--yes` cuando deban revisarse cambios manuales o propuestas de paquetes.

## 3. Asistente Windows

### Requisitos previos

Antes de clonar:

```powershell
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
```

El último comando debe devolver `linux`. Docker Desktop debe estar abierto y usar backend WSL2.

### Clonar y comprobar

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips
.\installers\windows\install.ps1 -CheckOnly
```

El instalador no instala Docker Desktop, WSL, Git ni actualizaciones. Si falta una dependencia, se detiene antes de escribir la instalación.

### Instalación interactiva

```powershell
.\installers\windows\install.ps1
```

El asistente solicita:

- directorio permanente de instalación;
- rutas externas de exportaciones, backups y diagnósticos;
- IP del servidor y red CIDR;
- puerto HTTPS y nombre DNS.

Después copia el paquete a un staging hermano, verifica cada archivo mediante SHA-256, valida Compose, activa el destino, construye, arranca y comprueba health, SAN TLS y bind mounts.

Valores típicos:

```text
Instalación:    E:\AuditorIps_Automate
Exportaciones:  E:\AuditorIps_AutomateData\exports
Backups:        E:\AuditorIps_AutomateData\backups
Diagnósticos:   E:\AuditorIps_AutomateData\diagnostics
Datos internos: volumen Docker auditor_ips_data
```

El directorio final debe estar ausente o vacío. No mantengas una ventana del Explorador ni una terminal situada dentro de él durante la promoción final.

### Instalación no interactiva

```powershell
.\installers\windows\install.ps1 `
  -InstallRoot 'E:\AuditorIps_Automate' `
  -ExportsRoot 'E:\AuditorIps_AutomateData\exports' `
  -BackupsRoot 'E:\AuditorIps_AutomateData\backups' `
  -DiagnosticsRoot 'E:\AuditorIps_AutomateData\diagnostics' `
  -ServerIp '192.168.1.40' `
  -ScanCidr '192.168.1.0/24' `
  -Port 9909 `
  -DnsName 'auditips.local' `
  -Yes
```

`-Yes` acepta la configuración propuesta; no instala software, no modifica el firewall y no autoriza borrar el volumen.

### Firewall

Abre PowerShell como administrador:

```powershell
.\installers\windows\firewall.ps1 -Port 9909
```

La regla creada se limita al perfil privado, dirección entrante y TCP. Para retirarla:

```powershell
.\installers\windows\firewall.ps1 -Port 9909 -Remove
```

### Acciones Windows disponibles

| Acción | Comando |
|---|---|
| Preflight | `.\installers\windows\install.ps1 -CheckOnly` |
| Instalación nueva | `.\installers\windows\install.ps1` |
| Reubicación de instalación existente | `.\installers\windows\migrate-installation.ps1` |
| Diagnóstico | `.\installers\windows\diagnose.ps1` |
| Firewall | `.\installers\windows\firewall.ps1` |
| Desinstalación | `.\installers\windows\uninstall.ps1` |
| Validación técnica | `.\installers\windows\validate-windows.cmd` |

No hay acciones Windows de instalación de dependencias, upgrade o rollback de versión en este release.

## 4. Instalación manual en Linux

Copia las plantillas públicas:

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
```

Edita ambos archivos y valida:

```bash
docker compose config --quiet
docker compose build
docker compose up -d
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

La plantilla Linux usa:

- `network_mode: host`;
- `NET_ADMIN` y `NET_RAW`;
- bind mount para `DATA_DIR`;
- rutas host para exportaciones y backups.

La instalación manual no genera automáticamente `install_state.json` ni aplica las salvaguardas del asistente. Documenta cualquier desviación local.

## 5. Instalación manual en Windows

Copia las plantillas específicas:

```powershell
Copy-Item .\installers\windows\env.windows.example .\.env
Copy-Item .\installers\windows\docker-compose.windows.yml.example .\docker-compose.yml
```

Edita `.env` y crea las rutas indicadas. Los valores de `AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME` deben ser únicos y no vacíos en una instalación real.

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
curl.exe -k --fail https://127.0.0.1:9909/api/system/healthz
```

La plantilla Windows:

- publica `${PORT}:${PORT}`;
- usa el volumen lógico `auditor_data`, cuyo nombre físico predeterminado es `auditor_ips_data`;
- monta exportaciones, backups y diagnósticos desde el host;
- no usa `network_mode: host`.

La instalación manual no ofrece staging transaccional, validación de bind mounts ni fichero de estado Windows. Usa el asistente salvo que necesites controlar Compose directamente.

## 6. Variables principales

| Variable | Linux | Windows | Finalidad |
|---|---:|---:|---|
| `PORT` | Sí | Sí | Puerto HTTPS |
| `AUDITOR_CONTAINER_NAME` | Sí | Sí | Nombre del contenedor |
| `AUDITOR_INSTANCE_ID` | Sí | Sí | Identidad única del site |
| `SESSION_COOKIE_NAME` | Sí | Sí | Evita colisiones de sesión |
| `SESSION_COOKIE_SECURE` | Sí | Sí | Cookie solo por HTTPS |
| `SESSION_COOKIE_SAMESITE` | Sí | Sí | Política SameSite |
| `DB_PATH` | Sí | Sí | Ruta SQLite dentro del contenedor |
| `DATA_DIR` | Sí | No | Persistencia mediante bind mount Linux |
| `DATA_VOLUME` | No | Sí | Volumen Docker persistente Windows |
| `EXPORTS_HOST_DIR` | Sí | Sí | Exportaciones visibles en el host |
| `BACKUPS_HOST_DIR` | Sí | Sí | Backups visibles en el host |
| `DIAGNOSTICS_HOST_DIR` | Sí | Sí | Paquetes de diagnóstico |
| `TLS_CERT_IP` | Sí | Sí | IP incluida en el certificado |
| `TLS_CERT_DNS` | Sí | Sí | DNS incluido en el certificado |
| `SERVER_IP` | Sí | Sí | IP anunciada a los clientes |
| `NETWORK_INTERFACE` | Sí | Vacía | Interfaz LAN Linux |
| `SCAN_CIDR` | Sí | Sí | Red o redes a auditar |
| `DOCKER_DNS` | Opcional | Opcional | DNS del contenedor |
| `DOCKER_DNS_SEARCH` | Opcional | Opcional | Dominios de búsqueda |
| `PLATFORM_PROFILE` | No generado | `windows_desktop` | Metadato del perfil Windows |
| `DISCOVERY_MODE` | No generado | `l3_compat` | Capacidad declarada por el instalador Windows |
| `INSTALLATION_PROFILE` | Sí | Sí | Perfil de instalación |
| `SCAN_RETENTION_DAYS` | Sí | Sí | Retención predeterminada |

No publiques el `.env` real.

## 7. Identidad y múltiples sites

Cada site debe tener un `AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME` únicos. El nombre de contenedor y el proyecto Compose también deben evitar colisiones.

El instalador Windows actual utiliza de forma intencional `auditor_ips` y `auditor_ips_data`; por tanto, admite una instalación activa por contexto Docker con esos valores. Para múltiples sites en el mismo host, utiliza Linux con parámetros avanzados o una instalación manual cuidadosamente aislada.

## 8. TLS y primer acceso

La primera ejecución genera una CA local y un certificado de servidor. Accede usando una IP o DNS incluido en los SAN configurados:

```text
https://IP_DEL_SERVIDOR:PUERTO/login
```

Instala la CA únicamente en dispositivos de confianza. Nunca distribuyas `ca.key` ni `server.key`.

En una base nueva, el navegador inicia el asistente para crear el primer administrador y configurar idioma, zona horaria, red, módulos, retención y notificaciones.

## 9. Validación final

Una instalación solo se cierra como correcta si:

```text
Compose válido
build correcto
contenedor iniciado
healthz HTTPS correcto
SAN TLS correctos
bind mounts correctos cuando corresponda
```

Comandos de apoyo:

```bash
docker compose ps
docker compose logs --tail 150
```

```powershell
curl.exe -k --fail https://127.0.0.1:9909/api/system/healthz
```

## 10. Mantenimiento

- [Actualización y rollback](UPGRADE.md)
- [Backup y restauración](BACKUP_RESTORE.md)
- [Configuración](CONFIGURATION.md)
- [Seguridad](SECURITY.md)
- [Solución de problemas](TROUBLESHOOTING.md)

No improvises una actualización Windows con parámetros no implementados. Conserva siempre `auditor_ips_data` y las carpetas operativas antes de sustituir una instalación.
