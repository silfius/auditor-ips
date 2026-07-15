# Instalación de Auditor IPs

## Objetivo

La vía recomendada es un asistente guiado. No es necesario conocer Docker, certificados o notación CIDR: el instalador detecta el host, explica cada decisión y valida el resultado.

## Requisito inicial

Para clonar el repositorio debe existir Git:

```bash
git --version
```

Después:

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
./install.sh
```

Si Git no está instalado, utiliza el gestor de paquetes de tu distribución para instalarlo y repite el proceso.

## Qué hace `install.sh`

1. Detecta distribución y arquitectura.
2. Comprueba Python, Docker, Docker Compose, Curl, OpenSSL e iproute2.
3. Muestra los componentes ausentes.
4. Solicita autorización antes de instalar paquetes o usar `sudo`.
5. Comprueba Docker, espacio libre, escritura y red.
6. Inicia el asistente Python.
7. Genera `.env` y `docker-compose.yml`.
8. Construye, arranca y valida el servicio.
9. Comprueba `healthz` y el certificado TLS.
10. Genera un resumen de instalación.

Nunca instala paquetes de forma silenciosa.

## Preflight sin instalar

```bash
./install.sh --check
```

Clasifica cada comprobación como `OK`, `WARN` o `ERROR`.

## Instalación automática de dependencias

En Debian, Ubuntu, Linux Mint, Arch y Manjaro, el asistente puede instalar dependencias bajo autorización:

```bash
./install.sh --install-deps
```

Si el usuario actual no puede acceder a Docker, el asistente puede utilizar `sudo docker`. Añadir el usuario al grupo `docker` es opcional y requiere abrir una nueva sesión para ser efectivo.

## Perfil recomendado

El asistente:

- detecta interfaces IPv4;
- marca la ruta por defecto y las interfaces virtuales;
- permite seleccionar la interfaz conectada a la LAN;
- propone la IP y el CIDR de esa interfaz;
- calcula cuántas direcciones se escanearán;
- detecta DNS LAN, públicas y loopback;
- descarta dominios de búsqueda raíz o no válidos antes de generar Compose;
- propone DNS privadas adecuadas;
- valida puerto, IP, CIDR, rutas y espacio;
- explica `network_mode: host`, `NET_RAW` y `NET_ADMIN`;
- propone construir, arrancar y validar la aplicación.

## Perfil avanzado

```bash
./install.sh --profile advanced
```

Permite revisar todos los parámetros, rutas, DNS, identidad del contenedor, cookie y TLS.

## Instalación no interactiva

Para pruebas controladas:

```bash
./install.sh --yes --install-deps \
  --port 9909 \
  --server-ip 192.168.1.20 \
  --tls-ip 192.168.1.20 \
  --tls-dns auditips.local \
  --scan-cidr 192.168.1.0/24 \
  --data-dir ./data \
  --exports-dir ./exports \
  --backups-dir ./data/backups
```

No uses `--yes` cuando exista configuración manual que deba revisarse.

## Instalación de sistema

```bash
./install.sh --system-install
```

Utiliza `/opt/auditor-ips`. Requiere permisos administrativos para crear y mantener esa ruta.

## Resultado esperado

La instalación solo se declara correcta si:

- Compose es válido;
- el build termina;
- el contenedor arranca;
- `/api/system/healthz` responde;
- el certificado contiene localhost, la IP y el DNS configurados.

Después abre:

```text
https://IP_DEL_SERVIDOR:PUERTO/login
```

El primer administrador se crea en el asistente web inicial.

## Docker existente y Compose ausente

La autorización permite instalar paquetes ausentes; no autoriza a sustituir una instalación Docker existente sin una confirmación adicional.
El asistente intenta instalar primero el plugin Compose de la distribución. Si fuera necesaria una migración a los paquetes oficiales de Docker, muestra los conflictos y solicita permiso específico.
