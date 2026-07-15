# Backup y restauración

## Contenido mínimo

- base de datos y certificados de `data/`;
- `.env`;
- `docker-compose.yml`;
- exportaciones necesarias;
- manifiesto con fecha, tamaño y hash.

## Backup seguro

Para un backup en caliente de SQLite, usa la función de backup de la aplicación o el flujo de upgrade. No copies por separado `auditor.db`, `auditor.db-wal` y `auditor.db-shm` mientras la aplicación escribe.

Para una copia manual completa:

```bash
docker compose down
tar -czf auditor-ips-backup.tar.gz data exports .env docker-compose.yml
docker compose up -d
curl -kfsS https://127.0.0.1:9909/api/system/healthz
```

## Restauración

1. Detén el stack.
2. Conserva una copia del estado actual.
3. Restaura datos, `.env` y Compose del mismo backup.
4. Arranca el stack.
5. Comprueba `healthz` e integridad desde la UI.

Los backups pueden contener inventario de red, tokens y claves. No los publiques.
