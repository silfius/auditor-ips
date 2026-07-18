# Solución de problemas

Empieza siempre por identificar la plataforma y conservar la salida completa del primer error. No elimines volúmenes, bases, certificados o carpetas operativas para “probar”.

## 1. Diagnóstico automático

### Linux

```bash
./install.sh --diagnose
```

### Windows

Desde la instalación permanente o el clon del repositorio:

```powershell
.\installers\windows\diagnose.ps1 -RepositoryRoot "C:\ruta\auditor-ips"
```

El diagnóstico redacta secretos conocidos y excluye la base y las claves privadas. Revísalo antes de compartirlo.

## 2. Comprobación previa

### Linux

```bash
./install.sh --check
```

Para autorizar la instalación de dependencias ausentes en familias compatibles:

```bash
./install.sh --install-deps
```

### Windows

```powershell
wsl --version
docker version
docker compose version
docker info --format '{{.OSType}}'
.\installers\windows\install.ps1 -CheckOnly
```

El instalador Windows no instala Docker Desktop, WSL, Git ni actualizaciones del sistema.

## 3. La web no responde

Desde la instalación:

```text
docker compose ps
docker compose logs --tail 150
```

Linux:

```bash
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

Windows:

```powershell
curl.exe -k https://127.0.0.1:9909/api/system/healthz
```

Comprueba además:

- que el contenedor está `Up`;
- que el puerto configurado está libre y publicado;
- que usas una IP o DNS incluida en el certificado;
- que el firewall permite el acceso desde la LAN privada;
- que Docker Desktop está iniciado en Windows.

## 4. Puerto ocupado

Linux permite indicar otro puerto:

```bash
./install.sh --port 9910
```

Windows:

```powershell
.\installers\windows\install.ps1 -Port 9910
```

Si ya existe una instalación, cambia el puerto de forma controlada en `.env` y valida Compose antes de recrear el servicio.

## 5. Docker sin permisos en Linux

El asistente puede usar `sudo docker`. Añadir el usuario al grupo `docker` es opcional y solo se aplica tras abrir una nueva sesión. Ese grupo concede privilegios equivalentes a administración del host.

No uses permisos globales como `chmod -R 777` sobre la instalación o los datos.

## 6. Docker existe pero falta Compose

En Linux, el asistente intenta instalar primero el plugin Compose compatible con la distribución. No retira una instalación Docker existente sin confirmación específica.

Ejecuta:

```bash
./install.sh --check
```

y repite de forma interactiva para revisar la propuesta.

## 7. Windows rechaza la plataforma

El contrato actual exige:

- Windows 11 AMD64/x86-64, build 22631 o posterior;
- Docker Desktop con backend WSL2;
- WSL 2.1.5 o posterior;
- contenedores Linux.

ARM64, Windows 10 y Windows Server están fuera del soporte del instalador Windows actual. Consulta [`../installers/PREREQUISITES.md`](../installers/PREREQUISITES.md).

## 8. Windows rechaza una ruta

Las rutas Windows deben ser absolutas, persistentes y estar en una unidad local fija. Se rechazan:

- UNC o recursos de red;
- unidades extraíbles;
- TEMP, TMP y Descargas;
- ubicaciones de nube;
- subcarpetas solapadas entre código y datos operativos.

Cierra ventanas del Explorador o terminales situadas en el directorio de destino si Windows informa que la carpeta está en uso.

## 9. Caracteres extraños en PowerShell

Caracteres deformados en palabras acentuadas o en guiones tipográficos indican una doble interpretación de UTF-8. Ejecuta los scripts directamente desde Windows PowerShell o PowerShell 7. Evita envolver un proceso PowerShell hijo interactivo en una tubería `Tee-Object` desde Windows PowerShell 5.1.

El problema de codificación de consola no implica corrupción de `.env`, Compose o datos, pero el log debe capturarse de nuevo o repararse antes de adjuntarlo.

## 10. Certificado no confiable

La instalación usa una CA local. El aviso inicial del navegador es esperado hasta instalar la CA en el dispositivo cliente.

- Accede por la IP o DNS configurados.
- Instala únicamente el certificado público de la CA en dispositivos de confianza.
- No compartas `ca.key` ni `server.key`.

## 11. No aparecen hosts

Revisa:

- `SERVER_IP` y `SCAN_CIDR`;
- conectividad del servidor con la LAN;
- segmentación VLAN y firewall;
- capacidades `NET_RAW` y `NET_ADMIN`;
- perfil de plataforma.

Linux con red host ofrece la capacidad de descubrimiento más completa. Windows usa Docker Desktop en bridge y registra `DISCOVERY_MODE=l3_compat`; no se garantiza visibilidad ARP/capa 2 equivalente.

## 12. No se resuelven nombres LAN

Una DNS pública normalmente no conoce nombres internos. Usa el router, Pi-hole o DNS corporativa y revisa `DOCKER_DNS` y `DOCKER_DNS_SEARCH` en Linux.

## 13. Upgrade o rollback

Linux:

```bash
./install.sh --upgrade
./install.sh --rollback
```

No borres `upgrade_backups/` si un upgrade falla.

Windows no implementa upgrade ni rollback de versión en este release. `migrate-installation.ps1` solo reubica una instalación activa.

## 14. El volumen o los datos parecen ausentes

Antes de cambiar nada:

```text
docker volume ls
docker volume inspect auditor_ips_data
docker compose config
```

No ejecutes `docker compose down -v`, `docker volume rm` ni la desinstalación con `-PurgeData` salvo que quieras eliminar definitivamente la base y los certificados.

## 15. Automatizaciones o agentes no actualizan

- comprueba URL, certificado y token;
- verifica la hora del host remoto;
- valida el JSON si se usa integración por fichero;
- revisa que `host_name` y `script_name` sean estables;
- rota el token si pudo exponerse.

Consulta [`SCRIPTS_INTEGRATION.md`](SCRIPTS_INTEGRATION.md).

## 16. Información útil al abrir una incidencia

Incluye:

- plataforma y arquitectura;
- commit o release;
- método de instalación;
- comando exacto;
- primer error completo;
- diagnóstico redactado;
- resultado de `docker compose ps`.

No adjuntes `.env`, base de datos, backups, tokens, webhooks ni claves privadas.
