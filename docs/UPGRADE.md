# Actualización y rollback

## Linux — flujo soportado

Desde la instalación Git existente:

```bash
./install.sh --upgrade
```

El asistente:

1. lee la configuración local;
2. crea un backup SQLite consistente;
3. ejecuta `PRAGMA quick_check`;
4. guarda `.env`, Compose, estado y hashes;
5. registra el commit anterior;
6. actualiza con `git pull --ff-only`;
7. reconcilia la plantilla Compose;
8. reconstruye y arranca;
9. exige health y TLS válidos;
10. conserva el backup para rollback.

### Compose modificado manualmente

Si `docker-compose.yml` no coincide con el generado por el instalador, el modo interactivo permite conservarlo, regenerarlo o cancelar. El modo `--yes` se detiene para evitar perder cambios.

### Rollback Linux

```bash
./install.sh --rollback
```

El rollback valida manifiesto, hashes y `PRAGMA quick_check` antes de restaurar. Sustituye SQLite de forma atómica y utiliza un contenedor auxiliar cuando el host no puede escribir directamente en el directorio persistente.

No uses `chmod -R 777` para resolver permisos.

## Windows — estado actual

Windows no implementa upgrade ni rollback de versión en este release. La instalación, migración y desinstalación se ejecutan mediante scripts separados, pero ninguno cambia automáticamente a una versión nueva.

`migrate-installation.ps1` sirve únicamente para reubicar una instalación provisional activa en una ruta permanente. Conserva el volumen y dispone de rollback operativo de la migración, pero no cambia de versión.

Antes de actualizar manualmente una instalación Windows:

1. crea y verifica un backup desde la aplicación;
2. conserva `auditor_ips_data`;
3. copia las carpetas de backups, exportaciones y diagnósticos a otro destino;
4. conserva `.env`, Compose y el estado Windows;
5. revisa las notas de la nueva versión.

No se documenta un procedimiento manual de sustitución como soportado hasta que exista un contrato de upgrade Windows validado.

## Precauciones comunes

- Conserva backups fuera del servidor.
- No borres `upgrade_backups/` hasta validar Linux.
- No elimines `auditor_ips_data` durante una actualización Windows.
- No actualices editando directamente ficheros bajo `app/` sin reconstruir la imagen.
- Comprueba login, health, TLS y datos después de cualquier cambio.
