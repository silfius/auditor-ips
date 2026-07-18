# Backup y restauración

## Qué debe conservarse

Un backup recuperable incluye:

- base de datos SQLite;
- CA y certificados persistentes;
- `.env` y `docker-compose.yml`;
- estado del instalador cuando exista;
- exportaciones o diagnósticos que deban conservarse;
- manifiesto con fecha, tamaño y SHA-256.

Los backups pueden contener inventario de red, tokens, nombres internos y claves. No los publiques.

## Método recomendado

Usa primero la función de backup de Auditor IPs. La aplicación crea una copia SQLite consistente y evita copiar por separado `auditor.db`, `auditor.db-wal` y `auditor.db-shm` mientras hay escrituras.

Conserva al menos una copia fuera del host que ejecuta Auditor IPs.

## Linux — copia manual detenida

Desde la instalación:

```bash
docker compose down
tar -czf auditor-ips-backup.tar.gz data exports diagnostics .env docker-compose.yml
docker compose up -d
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

Ajusta las rutas si `DATA_DIR`, exportaciones, backups o diagnósticos están fuera del repositorio. No incluyas el archivo resultante dentro del mismo árbol que estás comprimiendo.

## Windows

El almacenamiento se divide entre:

- volumen Docker `auditor_ips_data`: base y certificados;
- carpetas host: exportaciones, backups y diagnósticos;
- `InstallRoot`: `.env`, Compose y estado.

El script de desinstalación conserva el volumen y las carpetas host salvo que se solicite explícitamente `-PurgeData` para el volumen. No existe una opción que borre automáticamente exportaciones, backups o diagnósticos.

Antes de sustituir o reubicar una instalación Windows:

1. crea un backup desde la aplicación;
2. copia la carpeta indicada por `BACKUPS_HOST_DIR` a otro disco o equipo;
3. conserva `.env`, `docker-compose.yml` y `.auditor-ips-windows-state.json`;
4. verifica que `docker volume inspect auditor_ips_data` responde correctamente.

## Restauración

1. Detén el stack.
2. Conserva una copia del estado actual.
3. Verifica hashes y manifiesto del backup.
4. Restaura configuración, Compose, base y certificados del mismo conjunto.
5. Arranca el stack.
6. Comprueba `healthz`, TLS, login e integridad desde la interfaz.

No mezcles una base de un backup con `.env` o certificados de otro site sin revisar identidad, cookie, rutas y SAN TLS.

## Upgrade y rollback

El upgrade Linux crea backups consistentes y dispone de rollback guiado. Consulta [UPGRADE.md](UPGRADE.md).

Windows no ofrece upgrade o rollback de versión en este release; conserva el volumen y los backups antes de cualquier sustitución manual.
