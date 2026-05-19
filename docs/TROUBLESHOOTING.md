# Solución de problemas

## El contenedor no arranca

```bash
docker compose ps
docker compose logs --tail=120 auditor_ips
```

Revisa:

- puerto ocupado;
- permisos de `data/`;
- `.env` mal formado;
- Docker sin permisos;
- falta de espacio en disco.

## La salud no responde

```bash
curl -k https://127.0.0.1:9909/api/system/healthz
```

Si falla:

- comprueba `PORT`;
- revisa logs;
- valida que el contenedor esté levantado;
- confirma que el puerto no esté bloqueado.

## Problemas de certificado

Si usas `auditips.local`, asegúrate de que:

- resuelve a la IP correcta;
- `TLS_CERT_DNS` contiene ese nombre;
- los clientes confían en la CA local si quieres evitar aviso del navegador.

## Problemas de red

Confirma que `PRIMARY_CIDR` apunta a la red correcta y que el contenedor tiene
permisos `NET_ADMIN` y `NET_RAW`.
