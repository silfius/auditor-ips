# Seguridad

## Exposición

Auditor IPs está diseñado para LAN o VPN. No lo expongas directamente a Internet.

## Capacidades de red

### Linux

La plantilla usa `network_mode: host`, `NET_RAW` y `NET_ADMIN` para descubrimiento, ICMP, ARP y diagnóstico. Esto amplía el acceso del contenedor a la red del host.

### Windows

Docker Desktop usa red bridge y publica el puerto HTTPS. El contenedor mantiene capacidades Linux, pero no se afirma acceso equivalente a la NIC física ni paridad de capa 2 con Linux.

## Docker

El acceso al daemon Docker concede privilegios elevados sobre el host. En Linux, pertenecer al grupo `docker` equivale prácticamente a administración. El asistente puede usar `sudo docker` sin añadir al usuario al grupo.

En Windows, el instalador comprueba Docker Desktop y contenedores Linux, pero no cambia su configuración de seguridad.

## TLS

La instalación genera una CA local y un certificado limitado a localhost, la IP y el DNS configurados. Instala la CA solo en dispositivos de confianza.

Nunca compartas:

- `ca.key`;
- `server.key`;
- certificados privados;
- cookies o sesiones.

## Secretos

No publiques:

- `.env`;
- bases de datos;
- backups;
- logs sin revisar;
- tokens de agentes;
- webhooks;
- API keys;
- claves SSH.

## Firewall

En Windows, `firewall.ps1` crea una regla entrante TCP limitada al perfil privado y requiere elevación. El instalador no modifica el firewall automáticamente.

En Linux, revisa la política del host y la documentación de Docker. Auditor IPs usa red host, por lo que no depende de una publicación bridge de puertos.

## Diagnósticos

Linux:

```bash
./install.sh --diagnose
```

Windows:

```powershell
.\installers\windows\diagnose.ps1
```

Los diagnósticos excluyen la base de datos y claves privadas y redactan secretos conocidos. Revísalos igualmente antes de compartirlos.

## Desinstalación Windows

`-Yes` no autoriza borrar datos. El volumen solo se elimina con `-PurgeData`. Las carpetas de exportaciones, backups y diagnósticos se conservan siempre; `-RemoveConfiguration` solo retira `.env`, Compose y el estado del instalador.
