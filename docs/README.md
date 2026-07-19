# Documentación de Auditor IPs

La documentación se organiza por responsabilidad para que cada pregunta tenga una única fuente de verdad.

## Empezar una instalación

Lee los documentos en este orden:

1. [`INSTALL.md`](INSTALL.md): punto de entrada y elección del método.
2. [`../installers/PREREQUISITES.md`](../installers/PREREQUISITES.md): requisitos obligatorios de Linux o Windows.
3. Una sola vía de instalación:
   - asistida: [`../installers/README.md`](../installers/README.md);
   - manual: [`INSTALLATION_MANUAL.md`](INSTALLATION_MANUAL.md).
4. [`CONFIGURATION.md`](CONFIGURATION.md): cambios posteriores al despliegue.

## Jerarquía canónica

| Necesidad | Documento canónico |
|---|---|
| Elegir método de instalación | [`INSTALL.md`](INSTALL.md) |
| Comprobar requisitos de plataforma | [`../installers/PREREQUISITES.md`](../installers/PREREQUISITES.md) |
| Ejecutar un asistente | [`../installers/README.md`](../installers/README.md) |
| Usar el asistente Windows | [`../installers/windows/README.md`](../installers/windows/README.md) |
| Configurar manualmente `.env` y Compose | [`INSTALLATION_MANUAL.md`](INSTALLATION_MANUAL.md) |
| Usar la aplicación | [`USER_MANUAL.md`](USER_MANUAL.md) |
| Cambiar configuración local | [`CONFIGURATION.md`](CONFIGURATION.md) |
| Actualizar o hacer rollback | [`UPGRADE.md`](UPGRADE.md) |
| Crear o restaurar backups | [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) |
| Revisar seguridad | [`SECURITY.md`](SECURITY.md) |
| Diagnosticar incidencias | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| Integrar automatizaciones | [`SCRIPTS_INTEGRATION.md`](SCRIPTS_INTEGRATION.md) |

## Límites entre documentos

- `INSTALL.md` orienta; no contiene un Compose completo.
- `PREREQUISITES.md` define hardware, sistema, software, red y permisos; no instala.
- `installers/README.md` documenta únicamente asistentes y sus comandos.
- `INSTALLATION_MANUAL.md` documenta únicamente la vía manual y contiene los ejemplos completos.
- `CONFIGURATION.md` explica cambios posteriores, no repite la instalación.
- `USER_MANUAL.md` empieza después del primer acceso.
- Las diferencias Linux/Windows se declaran de forma explícita.
- No se documenta una función futura como si estuviera disponible.
- No se incluyen rutas, nombres, IP o capturas procedentes de entornos privados.

Los contratos se verifican con:

```bash
python3 scripts/test_documentation_contracts.py --root .
```

## Documentos no normativos

`CHANGELOG.md`, `SNAPSHOT_REVIEW.md`, `SNAPSHOT_MANIFEST.json` y notas históricas bajo `app/` registran publicaciones o evolución técnica. No sustituyen las guías operativas anteriores. La fecha y el commit de cada evidencia determinan su alcance.
