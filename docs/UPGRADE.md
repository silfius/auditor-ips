# Actualización y rollback

## Upgrade recomendado

Desde la instalación existente:

```bash
./install.sh --upgrade
```

El asistente:

1. lee la configuración local;
2. crea un backup SQLite consistente mediante la API de SQLite;
3. ejecuta `PRAGMA quick_check`;
4. guarda `.env`, Compose, estado y hashes;
5. registra el commit anterior;
6. actualiza el repositorio con `pull --ff-only`;
7. reconcilia la nueva plantilla Compose;
8. reconstruye y arranca;
9. exige `healthz` y TLS válidos;
10. conserva el backup para rollback.

## Compose modificado manualmente

Si `docker-compose.yml` no coincide con el generado por el instalador, el upgrade interactivo permite:

- conservarlo;
- regenerarlo;
- cancelar.

El modo `--yes` se detiene ante cambios manuales para evitar perderlos.

## Rollback

```bash
./install.sh --rollback
```

Valida primero el manifiesto, los hashes y `PRAGMA quick_check`. Después restaura `.env`, Compose y la base SQLite mediante reemplazo atómico; si el fichero o directorio pertenece al contenedor, utiliza un contenedor auxiliar con los volúmenes persistentes. Solo entonces restaura el commit anterior y vuelve a validar health y TLS.

## Precauciones

- Conserva backups fuera del servidor.
- No borres `upgrade_backups/` hasta validar la nueva versión.
- No actualices editando directamente ficheros bajo `app/`.
