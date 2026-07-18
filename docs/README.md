# Documentación de Auditor IPs

Este directorio contiene la documentación operativa pública. Los documentos se organizan por responsabilidad para que una instrucción tenga una única fuente de verdad.

## Jerarquía canónica

| Necesidad | Documento canónico |
|---|---|
| Elegir método de instalación | [`INSTALL.md`](INSTALL.md) |
| Requisitos de plataforma | [`../installers/PREREQUISITES.md`](../installers/PREREQUISITES.md) |
| Instalación detallada y manual | [`INSTALLATION_MANUAL.md`](INSTALLATION_MANUAL.md) |
| Contrato específico de Windows | [`../installers/windows/README.md`](../installers/windows/README.md) |
| Uso de la aplicación | [`USER_MANUAL.md`](USER_MANUAL.md) |
| Configuración local | [`CONFIGURATION.md`](CONFIGURATION.md) |
| Actualización y rollback | [`UPGRADE.md`](UPGRADE.md) |
| Backup y restauración | [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) |
| Seguridad | [`SECURITY.md`](SECURITY.md) |
| Diagnóstico de incidencias | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| Integración de automatizaciones | [`SCRIPTS_INTEGRATION.md`](SCRIPTS_INTEGRATION.md) |

## Reglas de mantenimiento

- `README.md` ofrece solo el acceso rápido; no duplica procedimientos extensos.
- `INSTALL.md` ayuda a escoger una vía y enlaza el procedimiento detallado.
- `INSTALLATION_MANUAL.md` define el flujo completo y las variables comunes.
- Los README de plataforma documentan únicamente parámetros presentes en sus scripts.
- `USER_MANUAL.md` explica el producto después de instalarlo; no replica el instalador.
- Las diferencias Linux/Windows se declaran de forma explícita.
- No se documenta una función futura como si estuviera disponible.
- No se incluyen rutas, nombres, IP o capturas procedentes de entornos privados.

Los contratos se verifican con:

```bash
python3 scripts/test_documentation_contracts.py --root .
```

## Documentos no normativos

`CHANGELOG.md`, `SNAPSHOT_REVIEW.md`, `SNAPSHOT_MANIFEST.json` y notas históricas bajo `app/` registran publicaciones o evolución técnica. No sustituyen las guías operativas anteriores. La fecha y el commit de cada evidencia determinan su alcance.
