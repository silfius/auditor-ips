# Configuración

## Ficheros principales

- `.env`: configuración local y secretos.
- `docker-compose.yml`: orquestación Docker local.
- `data/`: persistencia de BD, certificados, logs internos y datos de aplicación.

## Variables habituales

- `PORT`: puerto web.
- `DATA_DIR`: ruta persistente en el host.
- `TLS_CERT_IP`: IP incluida en el certificado local.
- `TLS_CERT_DNS`: nombre DNS incluido en el certificado local.
- `PRIMARY_CIDR`: red principal a auditar.
- `ADMIN_PASSWORD_HASH`: hash de contraseña de administrador.
- `SESSION_TTL_HOURS`: duración de sesión.
- `DISCORD_WEBHOOK_URL`: webhook opcional de Discord.

## Módulos

Auditor IPs incluye módulos de hosts, salud, servicios, automatizaciones,
Syncthing Control, notificaciones, backup/BD e informes.

Algunas opciones se configuran desde la UI tras iniciar sesión.
