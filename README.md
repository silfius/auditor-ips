# Auditor IPs

Auditor IPs es una aplicación self-hosted para monitorización LAN privada.

Permite inventariar hosts, revisar disponibilidad, diagnosticar calidad de red,
supervisar servicios internos, centralizar estados de automatizaciones, consultar
Syncthing Control en modo solo lectura y revisar la salud básica de la propia
aplicación.

## Estado

Este repositorio público procede de un snapshot saneado de Auditor IPs V4.

Antes de usarlo en producción:

1. Copia `.env.example` a `.env`.
2. Revisa `docker-compose.yml.example`.
3. Ajusta rutas, puerto, red principal y credenciales.
4. Arranca el stack con Docker Compose.
5. Comprueba la salud con `scripts/smoke_system_health.sh` o con `/api/system/healthz`.

## Requisitos

- Linux.
- Docker.
- Docker Compose.
- Permisos para ejecutar Docker.
- Acceso de escritura a la ruta de datos.
- Puerto web libre.

Distribuciones objetivo iniciales:

- Debian.
- Ubuntu.
- Arch Linux.
- Derivadas razonables de esas familias.

## Instalación guiada

```bash
python3 scripts/install_auditor.py --target-dir /opt/auditor-ips
```

Para validar sin arrancar el contenedor:

```bash
python3 scripts/install_auditor.py --target-dir /tmp/auditor-ips-test --yes --no-start
```

## Instalación rápida manual

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p ./data ./exports
docker compose build
docker compose up -d
curl -k https://127.0.0.1:9909/api/system/healthz
```

Consulta `docs/INSTALL.md` para el procedimiento completo.

## Seguridad

No publiques ni subas:

- `.env`;
- bases de datos;
- backups;
- dumps;
- logs;
- cookies;
- sesiones;
- certificados privados;
- claves SSH;
- tokens;
- webhooks;
- API keys.

## Documentación

- `docs/INSTALL.md`: instalación.
- `docs/CONFIGURATION.md`: configuración principal.
- `docs/BACKUP_RESTORE.md`: backup y restauración.
- `docs/UPGRADE.md`: actualización.
- `docs/SECURITY.md`: seguridad.
- `docs/TROUBLESHOOTING.md`: diagnóstico básico.

## Licencia

Consulta `LICENSE`.
