# Configuración

## Responsabilidades

La configuración se divide en dos capas:

- **Host y runtime:** Docker, red, puerto, almacenamiento, identidad y TLS. La gestionan los instaladores o `.env`/Compose.
- **Aplicación:** administrador, idioma, zona horaria, módulos, retención y notificaciones. Se gestiona desde el asistente web inicial y la interfaz.

## Ficheros y persistencia

### Linux

| Elemento | Ubicación habitual |
|---|---|
| Configuración local | `.env` |
| Runtime | `docker-compose.yml` |
| Estado del instalador | `install_state.json` |
| Base y certificados | `DATA_DIR`, normalmente `./data` |
| Exportaciones | `EXPORTS_HOST_DIR` |
| Backups | `BACKUPS_HOST_DIR` |
| Diagnósticos | `DIAGNOSTICS_HOST_DIR` |
| Backups de upgrade | `upgrade_backups/` |

### Windows

| Elemento | Ubicación |
|---|---|
| Configuración local | `<InstallRoot>\.env` |
| Runtime | `<InstallRoot>\docker-compose.yml` |
| Estado del instalador | `<InstallRoot>\.auditor-ips-windows-state.json` |
| Base y certificados | volumen Docker `auditor_ips_data` |
| Exportaciones | `EXPORTS_HOST_DIR` |
| Backups | `BACKUPS_HOST_DIR` |
| Diagnósticos | `DIAGNOSTICS_HOST_DIR` |

Las carpetas operativas Windows deben quedar fuera de `InstallRoot`.

## Variables principales

La referencia completa está en [INSTALLATION_MANUAL.md](INSTALLATION_MANUAL.md#6-variables-principales). Las variables de mayor impacto son:

- `AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME`;
- `PORT`;
- `SERVER_IP`, `TLS_CERT_IP` y `TLS_CERT_DNS`;
- `NETWORK_INTERFACE` y `SCAN_CIDR`;
- `DATA_DIR` en Linux o `DATA_VOLUME` en Windows;
- `EXPORTS_HOST_DIR`, `BACKUPS_HOST_DIR` y `DIAGNOSTICS_HOST_DIR`;
- `PLATFORM_PROFILE` y `DISCOVERY_MODE` en instalaciones Windows.

## Cambios manuales

Antes de editar:

```bash
docker compose config --quiet
```

Después de editar:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Comprueba:

```text
https://127.0.0.1:PUERTO/api/system/healthz
```

No edites directamente:

- la base SQLite activa;
- certificados privados;
- `install_state.json` o `.auditor-ips-windows-state.json`;
- manifiestos de backup;
- ficheros bajo `app/` sin reconstruir la imagen.

## Identidad

Cada site necesita identidad y cookie únicas. No copies un `.env` completo entre instalaciones sin regenerar:

- `AUDITOR_INSTANCE_ID`;
- `SESSION_COOKIE_NAME`;
- rutas persistentes;
- IP, CIDR y SAN TLS.

## Contraseña de administrador

La contraseña inicial no se guarda en `.env`. El primer administrador se crea desde el asistente web inicial.

## Secretos

No publiques `.env`, bases de datos, backups, tokens, webhooks, claves API o certificados privados. Para compartir una incidencia, genera un diagnóstico redactado y revísalo antes de adjuntarlo.
