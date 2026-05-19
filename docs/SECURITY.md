# Seguridad

## Información sensible

No publiques:

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

## Recomendaciones

- Usa contraseña de administrador.
- No expongas la aplicación directamente a Internet.
- Restringe el acceso a la LAN o a una VPN.
- Mantén permisos restrictivos en `.env` y `data/`.
- Revisa backups antes de copiarlos fuera del entorno.
- Trata API keys de Syncthing, tokens de agentes y webhooks como secretos.

## Syncthing Control

La integración está planteada como solo lectura. No debe usarse para ejecutar
acciones remotas salvo que un bloque futuro lo implemente explícitamente.
