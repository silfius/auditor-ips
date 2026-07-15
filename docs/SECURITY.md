# Seguridad

## Exposición

Auditor IPs está diseñado para LAN o VPN. No lo expongas directamente a Internet.

## Capacidades del contenedor

Usa `network_mode: host`, `NET_RAW` y `NET_ADMIN` para descubrimiento, ICMP, ARP y diagnósticos. Estas capacidades amplían el acceso del contenedor a la red del host; instala únicamente desde el repositorio oficial y mantén el host actualizado.

## Secretos

No publiques `.env`, bases de datos, backups, logs sin revisar, cookies, sesiones, certificados privados, claves SSH, tokens, webhooks ni API keys.

## Docker

El grupo `docker` equivale prácticamente a privilegios administrativos. El instalador explica esta implicación y puede usar `sudo docker` sin añadir al usuario al grupo.

## TLS

La instalación genera una CA local y un certificado limitado a localhost, la IP y los nombres configurados. Instala la CA solo en dispositivos de confianza.

## Diagnósticos redactados

`./install.sh --diagnose` no incorpora la base de datos ni claves privadas. Redacta valores sensibles del entorno, salidas de Compose y logs, y verifica el paquete antes de entregarlo.
