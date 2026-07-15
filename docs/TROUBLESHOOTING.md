# Solución de problemas

## Diagnóstico automático

```bash
./install.sh --diagnose
```

Genera un paquete sin `.env` en claro, base de datos, claves ni tokens. Incluye sistema, Docker, Compose, red, disco, health y últimas líneas de log.

## Dependencias

```bash
./install.sh --check
./install.sh --install-deps
```

La instalación de paquetes siempre requiere autorización.

## Puerto ocupado

El asistente detecta el conflicto y propone un puerto libre. También puedes indicar uno:

```bash
./install.sh --port 9910
```

## Docker sin permisos

El asistente puede usar `sudo docker`. Añadir el usuario al grupo `docker` es opcional y solo se aplica tras abrir una nueva sesión.

## El servicio no supera healthz

La instalación se considera fallida y muestra `docker compose ps` y logs. Conserva el entorno y ejecuta:

```bash
./install.sh --diagnose
```

## Nombres LAN no resueltos

Revisa las DNS elegidas. Una DNS pública como `1.1.1.1` no suele conocer nombres locales; usa el router, Pi-hole o DNS LAN.

## Certificado

Comprueba que accedes usando la IP o DNS configurados. Si cambias esos valores, reinicia para que el entrypoint regenere el certificado de servidor manteniendo la CA local.

## Docker existe pero falta Compose

El asistente intenta instalar solo el plugin Compose disponible. No migra ni retira paquetes Docker existentes sin confirmación específica. Ejecuta `./install.sh --check` y repite de forma interactiva para revisar la propuesta.

## Rollback y permisos de `auditor.db`

La base puede estar creada por el proceso del contenedor y aparecer en el
host como `root:root`. El asistente no intenta sobrescribir directamente ese
fichero. Valida el backup, crea una copia temporal verificada y la sustituye
atómicamente. Si el directorio persistente tampoco es escribible desde el
host, realiza la restauración mediante un contenedor auxiliar.

No cambies permisos de todo el directorio con `chmod -R 777`. Conserva
`upgrade_backups/` y ejecuta de nuevo:

```bash
./install.sh --rollback
```
