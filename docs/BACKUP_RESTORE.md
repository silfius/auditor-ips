# Backup y restauración

## Qué guardar

Como mínimo:

- carpeta `data/`;
- fichero `.env`;
- `docker-compose.yml` adaptado;
- certificados locales si se usan;
- documentación local de despliegue.

## Backup básico

```bash
mkdir -p backups
tar -czf backups/auditor-ips-data-$(date +%Y%m%d-%H%M%S).tar.gz data .env docker-compose.yml
```

## Restauración básica

1. Detén el stack.
2. Restaura `data/`, `.env` y `docker-compose.yml`.
3. Arranca de nuevo.
4. Comprueba `/api/system/healthz`.

```bash
docker compose down
docker compose up -d
curl -k https://127.0.0.1:9909/api/system/healthz
```

## Recomendaciones

- Guarda backups fuera del servidor principal.
- Prueba restauraciones periódicamente.
- No publiques backups: pueden contener datos de red, tokens, claves o históricos.
