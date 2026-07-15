# Auditor IPs

Auditor IPs es una aplicación web self-hosted para inventariar, auditar y supervisar una red local desde un panel único.

## Repositorio público

Este repositorio es el canal oficial de distribución para instalaciones externas. El desarrollo se mantiene en un repositorio privado y se publica mediante snapshots saneados, reproducibles y escaneados antes de cada actualización.

## Funciones principales

- descubrimiento e inventario de hosts;
- histórico de disponibilidad y eventos;
- diagnóstico de calidad de red;
- supervisión de servicios y aplicaciones internas;
- monitorización de automatizaciones locales o remotas;
- agentes API para recibir estados;
- Syncthing Control en modo de observación;
- salud interna, backups, retención y mantenimiento de la base de datos;
- informes y notificaciones opcionales.

## Instalación recomendada

El usuario solo necesita clonar el repositorio y ejecutar el asistente:

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

`install.sh` comprueba el host, explica las dependencias ausentes y solicita autorización antes de instalar paquetes o usar `sudo`.

Acciones disponibles:

```bash
./install.sh --check
./install.sh --diagnose
./install.sh --upgrade
./install.sh --rollback
./install.sh --uninstall
```

El modo recomendado detecta interfaces, IP, red, DNS, rutas, puerto y capacidad del host. El modo avanzado permite revisar todos los parámetros.

## Requisitos

- Linux x86-64 o ARM64;
- Debian, Ubuntu, Linux Mint, Arch, Manjaro o derivada razonable;
- Git para clonar el repositorio;
- acceso a Internet durante la instalación;
- acceso a la LAN que se desea auditar;
- autorización `sudo` si faltan dependencias.

El asistente puede instalar Python, Docker Engine, Docker Compose V2, Curl, OpenSSL e iproute2 bajo autorización explícita. En distribuciones no reconocidas mostrará los requisitos sin modificar el sistema.

## Primer acceso

Al terminar, el instalador muestra una dirección similar a:

```text
https://IP_DEL_SERVIDOR:9909/login
```

En una instalación limpia, el asistente web inicial crea el primer administrador y configura idioma, zona horaria, red, retención, módulos y notificaciones. El instalador del host no solicita ni almacena contraseñas de administrador.

## Seguridad

- No expongas Auditor IPs directamente a Internet.
- Limita el acceso a la LAN o a una VPN.
- El contenedor usa `network_mode: host`, `NET_RAW` y `NET_ADMIN` para diagnóstico y descubrimiento LAN.
- Conserva `.env`, datos, backups, tokens y certificados privados fuera de Git.
- El HTTPS inicial usa una CA local; consulta el manual para instalarla en los clientes.

## Documentación

- [Manual de usuario](docs/USER_MANUAL.md)
- [Instalación](docs/INSTALL.md)
- [Actualización](docs/UPGRADE.md)
- [Backup y restauración](docs/BACKUP_RESTORE.md)
- [Configuración](docs/CONFIGURATION.md)
- [Seguridad](docs/SECURITY.md)
- [Solución de problemas](docs/TROUBLESHOOTING.md)
- [Integración de scripts](docs/SCRIPTS_INTEGRATION.md)

## Colaboración

Usa Issues para errores o mejoras accionables y Discussions para dudas de instalación. No adjuntes `.env`, bases de datos, backups, tokens, webhooks, certificados privados ni logs sin revisar.

## Licencia

Consulta `LICENSE`.
