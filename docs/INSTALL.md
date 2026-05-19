# Instalación

## Alcance

Instalación manual inicial de Auditor IPs V4 desde repositorio público.

El instalador guiado definitivo se añadirá en una fase posterior. Mientras tanto,
este procedimiento permite validar el despliegue con Docker Compose.

## Requisitos

- Linux.
- Docker instalado.
- Docker Compose disponible.
- Usuario con permisos para Docker.
- Puerto web libre, por defecto `9909`.
- Ruta persistente para `data/`.

## Pasos

```bash
git clone <URL_PUBLICA_DEL_REPOSITORIO> auditor-ips
cd auditor-ips
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p ./data ./exports
docker compose build
docker compose up -d
curl -k https://127.0.0.1:9909/api/system/healthz
```

## Primer ajuste recomendado

Edita `.env` antes de arrancar en producción:

- `PORT`;
- `DATA_DIR`;
- `TLS_CERT_IP`;
- `TLS_CERT_DNS`;
- `PRIMARY_CIDR`;
- `ADMIN_PASSWORD_HASH`;
- opciones de notificación.

## Comprobación de salud

```bash
curl -k https://127.0.0.1:9909/api/system/healthz
```

Si usas el script incluido:

```bash
AUDITOR_BASE_URL=https://127.0.0.1:9909 scripts/smoke_system_health.sh
```
