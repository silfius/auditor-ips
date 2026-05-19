# Auditor IPs

Auditor IPs es una aplicación web self-hosted para auditar, inventariar y operar una red local desde un panel único.

Permite detectar hosts, consultar información de red, lanzar acciones operativas, revisar eventos y centralizar tareas habituales de administración LAN.

## Estado del repositorio

Este repositorio público es el canal de distribución para instalaciones externas.

El desarrollo principal se mantiene en un repositorio privado y este repositorio se actualiza mediante snapshots saneados, revisados y escaneados antes de publicarse.

## Funcionalidades principales

- Dashboard de estado general.
- Inventario de hosts detectados.
- Escaneo de red local.
- Clasificación y enriquecimiento básico de dispositivos.
- Wake-on-LAN para equipos configurados.
- Alertas y eventos.
- Exportaciones.
- Automatizaciones.
- Configuración de seguridad y usuarios admin.
- Control de servicios auxiliares cuando estén configurados.
- Integraciones opcionales según despliegue.

## Requisitos

Servidor Linux con:

- Git.
- Docker.
- Docker Compose disponible como `docker compose`.
- Acceso a la red local que se quiere auditar.
- Permisos para crear contenedores Docker.

Distribuciones esperadas:

- Debian.
- Ubuntu.
- Arch Linux o derivadas.

Otras distribuciones Linux pueden funcionar, pero pueden requerir ajustes manuales.

## Instalación recomendada

Clona el repositorio público:

```bash
git clone https://github.com/silfius/auditor-ips.git
cd auditor-ips
```

Ejecuta el instalador:

```bash
python3 scripts/install_auditor.py --target-dir /opt/auditor-ips
```

El instalador te guiará por:

- puerto web;
- nombre del contenedor;
- datos TLS locales;
- red principal a auditar;
- rutas locales de datos y exportaciones;
- construcción de la imagen Docker;
- arranque opcional del servicio.

## Instalación sin preguntas

Ejemplo para pruebas o despliegues controlados:

```bash
python3 scripts/install_auditor.py \
  --target-dir /opt/auditor-ips \
  --repo-url https://github.com/silfius/auditor-ips.git \
  --branch main \
  --port 9909 \
  --container-name auditor_ips \
  --tls-dns auditips.local \
  --tls-ip 192.168.1.253 \
  --server-ip 192.168.1.253 \
  --scan-cidr 192.168.1.0/24 \
  --data-dir ./data \
  --exports-dir ./exports \
  --yes \
  --force-config
```

Para validar sin arrancar el contenedor:

```bash
python3 scripts/install_auditor.py \
  --target-dir /tmp/auditor-ips-test \
  --yes \
  --no-start
```

## Primer acceso

Cuando el instalador termine, mostrará una URL similar a:

```text
https://IP_DEL_SERVIDOR:PUERTO/login
```

Si no hay usuarios admin, la pantalla de primera configuración te pedirá crear el primero desde el navegador.

Por seguridad, el instalador no pide ni guarda contraseñas de administrador.

## Comandos útiles

Entrar en la instalación:

```bash
cd /opt/auditor-ips
```

Ver estado:

```bash
docker compose ps
```

Ver logs:

```bash
docker compose logs -f
```

Parar:

```bash
docker compose down
```

Arrancar:

```bash
docker compose up -d
```

Validar salud:

```bash
curl -k https://127.0.0.1:9909/api/system/healthz
```

Cambia `9909` por el puerto que hayas configurado.

## Actualización manual básica

En una instalación existente:

```bash
cd /opt/auditor-ips
git pull --ff-only
docker compose build
docker compose up -d
```

Antes de actualizar una instalación con datos reales, haz copia de seguridad de la carpeta de datos.

El flujo avanzado de upgrade guiado desde el instalador está previsto como mejora posterior.

## Ficheros locales generados

El instalador crea ficheros locales que no deben subirse a Git:

- `.env`
- `docker-compose.yml`
- carpeta de datos
- carpeta de exportaciones
- certificados TLS generados
- base de datos local

El repositorio incluye plantillas públicas:

- `.env.example`
- `docker-compose.yml.example`

## Seguridad

Recomendaciones:

- No expongas Auditor IPs directamente a Internet.
- Úsalo en red local, VPN o entorno controlado.
- Cambia el puerto si ya tienes otro servicio usando el mismo.
- Crea un usuario admin fuerte en el primer acceso.
- No publiques `.env`, bases de datos, certificados ni carpetas de datos.
- Revisa los logs si el instalador no puede arrancar el contenedor.

## Solución de problemas

### El puerto no responde

```bash
docker compose ps
docker compose logs --tail 100
grep '^PORT=' .env
```

### Docker Compose falla

```bash
docker compose config --quiet
```

### Certificado TLS autofirmado

La aplicación genera certificados locales para HTTPS. El navegador puede mostrar advertencia si no has instalado la CA local.

### No aparece la pantalla de primera configuración

Comprueba que estás entrando en:

```text
https://IP_DEL_SERVIDOR:PUERTO/login
```

Si ya existe un usuario admin, se mostrará la pantalla normal de login.

## Colaboración

Este repositorio acepta:

- Issues para bugs o mejoras accionables.
- Discussions para dudas, soporte ligero e ideas.
- Pull Requests desde forks para contribuciones externas.

La rama `main` está protegida. Los cambios se publican mediante Pull Request.

## Documentación ampliada

Está previsto crear un manual completo con:

- instalación paso a paso;
- explicación de cada sección;
- ejemplos de uso;
- capturas de pantalla;
- resolución de problemas;
- guía para usuarios externos.

## Licencia

Consulta el fichero `LICENSE`.
