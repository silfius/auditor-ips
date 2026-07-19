# Instalador Windows

Este directorio contiene el asistente Windows validado para una instalación permanente y separa cada acción operativa en un script explícito.

## Requisitos

Consulta [`../PREREQUISITES.md`](../PREREQUISITES.md). Resumen:

- Windows 11 23H2+, build 22631 o superior;
- arquitectura AMD64/x86-64;
- Docker Desktop abierto;
- backend WSL2 y contenedores Linux;
- WSL 2.1.5 o posterior;
- `docker.exe`, Compose V2 y `curl.exe` en `PATH`.

El instalador no instala Docker Desktop, WSL, Git ni otras dependencias; tampoco reinicia Windows o abre el firewall automáticamente.

## Validación

En un clon Git:

```powershell
.\installers\windows\validate-windows.cmd
```

La validación comprueba parseo, contratos, mocks y staging del payload. Si el clon no está en una unidad cuya raíz sea escribible, la prueba real de raíz usa una unidad fija escribible disponible; el contrato de resolución de raíz se prueba siempre de forma simulada.

En un ZIP de release, si existe `BUNDLE_MANIFEST.sha256` en la raíz del paquete, también se verifican todos sus hashes.

## Instalación nueva

```powershell
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

Ejemplo no interactivo:

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

La instalación:

1. valida plataforma, Docker, WSL2, puerto y rutas;
2. copia el repositorio a un staging hermano;
3. verifica cada archivo por SHA-256;
4. genera `.env` y Compose;
5. activa el directorio permanente;
6. construye y arranca;
7. comprueba health, SAN TLS y bind mounts.

El directorio final debe estar ausente o vacío y no puede estar abierto por otro proceso durante la activación.

## Almacenamiento

- Base de datos y certificados: volumen Docker `auditor_ips_data`.
- Perfil declarado: `PLATFORM_PROFILE=windows_desktop` y `DISCOVERY_MODE=l3_compat`.
- Código y configuración: `InstallRoot`.
- Exportaciones, backups y diagnósticos: rutas externas al código.

Las rutas deben pertenecer a unidades locales fijas. Se rechazan UNC, TEMP, Descargas, unidades extraíbles y rutas operativas dentro del directorio de instalación.

## Reubicar una instalación existente

```powershell
.\installers\windows\migrate-installation.ps1
```

Detecta la instalación activa mediante las etiquetas Compose, copia y verifica contenido persistente, reutiliza `auditor_ips_data` y revierte el runtime anterior si falla la activación. La carpeta de origen no se borra automáticamente.

Este comando reubica; no actualiza la versión del producto.

## Diagnóstico

Desde la instalación permanente:

```powershell
.\installers\windows\diagnose.ps1
```

El ZIP se guarda en `DIAGNOSTICS_HOST_DIR`. Se excluyen la base de datos y las claves privadas y se redactan secretos en `.env`, Compose y logs.

## Firewall

PowerShell elevado:

```powershell
.\installers\windows\firewall.ps1 -Port 9909
```

Retirada:

```powershell
.\installers\windows\firewall.ps1 -Port 9909 -Remove
```

## Desinstalación

Conservar volumen, configuración y carpetas operativas:

```powershell
.\installers\windows\uninstall.ps1 -Yes
```

Eliminar también `.env`, Compose y el estado local:

```powershell
.\installers\windows\uninstall.ps1 -RemoveConfiguration -Yes
```

Eliminar el volumen interno requiere autorización explícita:

```powershell
.\installers\windows\uninstall.ps1 -PurgeData -Yes
```

Exportaciones, backups y diagnósticos se conservan siempre; no hay una opción automática para borrarlos.

## Capacidades no implementadas

Este release Windows no incluye:

- instalación automática de Docker Desktop, WSL o Git;
- upgrade de versión;
- rollback de versión;
- eliminación automática de carpetas operativas;
- detección dinámica de perfiles alternativos de descubrimiento.

No documentes esas acciones como parámetros de `install.ps1`.
