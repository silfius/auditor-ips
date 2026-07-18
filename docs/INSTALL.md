# Instalación rápida

Este documento ayuda a elegir el método correcto para crear un nuevo site. El procedimiento detallado y la referencia de variables están en [INSTALLATION_MANUAL.md](INSTALLATION_MANUAL.md).

## Elegir método

| Escenario | Método recomendado |
|---|---|
| Servidor Linux permanente | Asistente Linux |
| Servidor Windows 11 con Docker Desktop | Asistente Windows |
| Despliegue controlado por un administrador con experiencia en Compose | Instalación manual |
| Traslado de una instalación Windows provisional ya activa | Migrador Windows |

Antes de empezar, revisa los [prerrequisitos](../installers/PREREQUISITES.md).

## Asistente Linux

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

Comprobación previa:

```bash
./install.sh --check
```

El asistente puede instalar dependencias con autorización explícita:

```bash
./install.sh --install-deps
```

## Asistente Windows

Docker Desktop y WSL deben estar instalados y operativos antes de ejecutar Auditor IPs.

```powershell
git clone https://github.com/silfius/auditor-ips.git
Set-Location auditor-ips
.\installers\windows\install.ps1 -CheckOnly
.\installers\windows\install.ps1
```

Acciones independientes:

```powershell
# Diagnóstico desde la instalación permanente
.\installers\windows\diagnose.ps1

# Regla de firewall privada; requiere PowerShell elevado
.\installers\windows\firewall.ps1 -Port 9909

# Desinstalar runtime conservando volumen y carpetas operativas
.\installers\windows\uninstall.ps1 -Yes
```

El instalador Windows no instala dependencias y no implementa upgrade o rollback de versión. Diagnóstico, firewall, migración y desinstalación se ejecutan mediante sus scripts separados.

## Migrar una instalación Windows provisional

Cuando ya existe un contenedor `auditor_ips` asociado a una carpeta provisional:

```powershell
.\installers\windows\migrate-installation.ps1
```

Este flujo reubica la instalación y conserva `auditor_ips_data`; no es un actualizador de versión.

## Instalación manual

- Linux: usa `.env.example` y `docker-compose.yml.example` de la raíz.
- Windows: usa `installers/windows/env.windows.example` y `installers/windows/docker-compose.windows.yml.example`.

Consulta [INSTALLATION_MANUAL.md](INSTALLATION_MANUAL.md) antes de editar Compose directamente.

## Resultado esperado

La instalación se considera correcta únicamente si:

- `docker compose config` es válido;
- la imagen se construye o existe una imagen válida;
- el contenedor arranca;
- `/api/system/healthz` responde por HTTPS;
- el certificado contiene la IP y DNS configurados;
- en Windows, los bind mounts de exportaciones, backups y diagnósticos quedan verificados.

El primer administrador se crea desde el asistente web inicial, no desde `.env`.
