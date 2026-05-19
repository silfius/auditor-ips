# Actualización

## Flujo recomendado

Antes de actualizar:

1. Haz backup de `data/`.
2. Revisa cambios en `.env.example` y `docker-compose.yml.example`.
3. Actualiza el repositorio.
4. Reconstruye el contenedor.
5. Valida `/api/system/healthz`.

Ejemplo:

```bash
git pull --ff-only
docker compose build
docker compose up -d
curl -k https://127.0.0.1:9909/api/system/healthz
```

## Precauciones

- No sobrescribas `.env` sin revisar.
- No borres `data/`.
- Conserva backups antes de limpiezas o migraciones.
- Revisa el changelog antes de actualizar instalaciones en uso.
