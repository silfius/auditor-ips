# Configuración

## Responsabilidades

El instalador del host configura infraestructura: Docker, red, puerto, almacenamiento y TLS. El asistente web inicial configura administrador, idioma, zona horaria, módulos, retención y notificaciones.

## Ficheros locales

- `.env`: configuración local y secretos;
- `docker-compose.yml`: definición generada del runtime;
- `install_state.json`: estado y hash del Compose generado;
- `data/`: base, certificados y datos persistentes;
- `exports/`: exportaciones;
- `diagnostics/`: paquetes redactados;
- `upgrade_backups/`: backups previos a upgrades.

## Variables principales

- `PORT`;
- `DATA_DIR`;
- `EXPORTS_HOST_DIR`;
- `BACKUPS_HOST_DIR`;
- `TLS_CERT_IP` y `TLS_CERT_DNS`;
- `SERVER_IP`;
- `NETWORK_INTERFACE`;
- `SCAN_CIDR`;
- `DOCKER_DNS` y `DOCKER_DNS_SEARCH`;
- `AUDITOR_INSTANCE_ID` y `SESSION_COOKIE_NAME`.

El primer administrador no se configura mediante una contraseña en `.env`; se crea desde el asistente web inicial.
