# Guía de integración de scripts externos con Auditor IPs

Fecha: 2026-05-29  
Estado: borrador operativo V1  
Ámbito: Automatizaciones / Procesos / scripts monitorizados

## 1. Objetivo

Esta guía explica cómo preparar un script externo para que Auditor IPs pueda monitorizarlo sin ejecutarlo.

Auditor IPs no debe modificar crontabs, tareas programadas ni ejecutar scripts remotos. Su función es observar estados, logs y metadatos publicados por cada script.

La integración se basa en que cada script genere un fichero `.status.json` con información de estado.

## 2. Principio principal

Cada automatización se identifica por:

    host_name + script_name

Ejemplo:

    SERVERCENTRALWI::backup_immich_windows

Esto permite tener el mismo nombre de script en diferentes hosts sin mezclar estados.

## 3. Ubicación recomendada de los estados

Auditor IPs debe recibir los `.status.json` en la carpeta monitorizada.

En el host Linux de Auditor IPs:

    /SERVER/Logs_scripts_General/

Dentro del contenedor, normalmente se ve como:

    /data/scripts_status/

Para máxima compatibilidad, se recomienda escribir el JSON en dos ubicaciones:

### 3.1. Copia principal en raíz

    /SERVER/Logs_scripts_General/backup_immich_windows.status.json

### 3.2. Copia estructurada por host y script

    /SERVER/Logs_scripts_General/SERVERCENTRALWI/backup_immich_windows/backup_immich_windows.status.json

La copia en raíz ayuda a asistentes o importadores simples.  
La copia estructurada facilita orden, logs por host/script y trazabilidad.

## 4. Nombre del fichero

El fichero debe llamarse:

    <script_name>.status.json

Ejemplo:

    backup_immich_windows.status.json

El valor interno `script_name` debe coincidir con el nombre técnico usado por Auditor IPs.

## 5. Campos mínimos recomendados

Un `.status.json` funcional debería incluir al menos:

    {
      "name": "backup_immich_windows",
      "script_name": "backup_immich_windows",
      "host_name": "SERVERCENTRALWI",
      "instance_key": "SERVERCENTRALWI::backup_immich_windows",
      "status": "success",
      "state": "success",
      "message": "Backup completado correctamente",
      "start_time": "2026-05-29T20:21:27+02:00",
      "end_time": "2026-05-29T20:27:15+02:00",
      "heartbeat": "2026-05-29T20:27:15+02:00",
      "last_heartbeat": "2026-05-29T20:27:15+02:00",
      "updated_at": "2026-05-29T20:27:15+02:00",
      "exit_code": 0
    }

## 6. Estados admitidos

Auditor IPs debe aceptar estos estados habituales:

    running
    started
    success
    ok
    completed
    error
    failed
    missed
    stalled
    controlled_stop

Recomendación:

- Durante la ejecución: `status=running`, `state=running`.
- Al terminar bien: `status=success`, `state=success` u `ok`.
- Al terminar mal: `status=error`, `state=error`, `exit_code` distinto de 0.

Auditor IPs normaliza `success`, `ok` y `completed` como estado OK.

## 7. Cron real informado

Auditor IPs no lee ni modifica el Programador de tareas, crontab ni systemd timers reales.

Cada script debe informar su programación real mediante:

    "cron_expr": "22 7 * * *",
    "cron_source": "windows_task_scheduler"

Ejemplos de `cron_source`:

    windows_task_scheduler
    ServerLinuxAuxiliar / root crontab
    ServerLinuxAuxiliar / crontab usuario cpueyo
    systemd timer
    agente externo

Si se cambia la hora real del script, también debe actualizarse el valor publicado en el `.status.json`.

## 8. Logs

Se recomienda publicar la ruta del log más reciente:

    "log_file": "\\\\192.168.1.253\\Logs_procesos\\SERVERCENTRALWI\\backup_immich_windows\\logs\\backup_immich_windows_20260529-202127.log"

Reglas:

- No escribir contraseñas, tokens, webhooks ni claves en claro.
- Enmascarar parámetros sensibles.
- El log debe ser legible para diagnóstico humano.
- Mantener un histórico razonable o aplicar retención.

## 9. Campos de backup o artefactos generados

Para scripts de backup, se recomienda publicar:

    "backup_file": "\\\\192.168.1.253\\AlmacenExt\\Backups_Completos\\SERVIDOR\\VM_linux\\VM_Immich_Backup.7z",
    "backup_size_mb": 200.5

Si el destino usa un fichero único por proceso, el `backup_file` debe apuntar al fichero fijo final.

Ejemplo:

    VM_Immich_Backup.7z

No es obligatorio guardar un backup por día si la política del entorno es mantener una única copia actual por VM/proceso.

## 10. Progreso por fases

Para scripts largos se recomienda publicar fases de ejecución.

Auditor IPs puede mostrar el punto actual si el script publica:

    step_current
    step_total
    step_name
    progress_percent
    progress_text

Ejemplo:

    {
      "status": "running",
      "state": "running",
      "message": "Comprimiendo backup cifrado (6/8)",
      "step_current": 6,
      "step_total": 8,
      "step_name": "Comprimiendo backup cifrado",
      "progress_percent": 75,
      "progress_text": "6/8 Comprimiendo backup cifrado"
    }

### 10.1. Recomendación de fases para backups Docker

Ejemplo para un backup de Immich:

    1/8 Validando entorno
    2/8 Comprobando Docker
    3/8 Parando servicio principal
    4/8 Generando dump PostgreSQL
    5/8 Copiando configuración
    6/8 Comprimiendo backup cifrado
    7/8 Moviendo backup a destino final
    8/8 Arrancando servicio y limpiando staging

Estas fases no tienen que ser exactas para todos los scripts. Lo importante es que sean estables, entendibles y útiles para saber dónde está bloqueado el proceso.

## 11. Heartbeat

Mientras el script está ejecutando, debe actualizar:

    heartbeat
    last_heartbeat
    updated_at

Recomendación:

    cada 30-60 segundos

Esto permite a Auditor IPs detectar procesos bloqueados o sin señal reciente.

## 12. Escritura atómica del JSON

El `.status.json` debe escribirse de forma atómica:

1. Crear un fichero temporal.
2. Escribir JSON completo.
3. Reemplazar el fichero final.

Ejemplo conceptual:

    status.tmp -> status.json

Esto evita que Auditor IPs lea un JSON incompleto mientras el script lo está escribiendo.

## 13. Ejemplo de ciclo de vida

### Inicio

    status = running
    state = running
    start_time = ahora
    step_current = 1
    step_total = 8
    step_name = Validando entorno
    progress_percent = 12

### Durante la ejecución

    heartbeat = ahora
    updated_at = ahora
    step_current = 6
    step_name = Comprimiendo backup cifrado
    progress_percent = 75

### Final correcto

    status = success
    state = success
    end_time = ahora
    exit_code = 0
    step_current = 8
    step_total = 8
    step_name = Backup completado
    progress_percent = 100

### Final con error

    status = error
    state = error
    end_time = ahora
    exit_code = código real
    message = descripción corta del fallo
    step_current = fase donde falló
    step_name = nombre de la fase donde falló

## 14. Checklist para integrar un script

Antes de dar un script de alta en Auditor IPs:

- El script genera `<script_name>.status.json`.
- El JSON contiene `script_name`.
- El JSON contiene `host_name`.
- El JSON contiene `status` o `state`.
- El JSON contiene `heartbeat` o `updated_at`.
- Si tiene programación, publica `cron_expr`.
- Si tiene programación, publica `cron_source`.
- Si genera log, publica `log_file`.
- Si genera backup, publica `backup_file` y `backup_size_mb`.
- Si es largo, publica `step_current`, `step_total`, `step_name` y `progress_percent`.
- No hay secretos en JSON ni logs.
- El JSON se escribe de forma atómica.
- La copia en raíz existe si se quiere máxima compatibilidad.
- La copia estructurada por host/script existe si se quiere orden operativo.

## 15. Errores habituales

### 15.1. El script aparece como Local

Causa probable:

- Falta `host_name`.
- El asistente no está leyendo el JSON completo.
- Solo se deduce el host por ruta y el fichero está en raíz.

Solución:

    añadir "host_name": "NOMBRE_HOST"

### 15.2. El estado aparece como Desconocido

Causa probable:

- `state` contiene un valor no normalizado.
- Falta `exit_code`.
- El script publica `success` pero Auditor IPs no lo normaliza.

Valores recomendados:

    running
    success
    error

### 15.3. La próxima ejecución no cuadra

Causa probable:

- El Programador de tareas o crontab real cambió.
- El `.env` o configuración del wrapper sigue publicando el cron antiguo.

Solución:

    actualizar cron_expr en la configuración del script y regenerar el .status.json.

### 15.4. El script aparece duplicado

Causa probable:

- Existe copia en raíz y copia en subcarpeta.
- Auditor IPs no está deduplicando por `host_name + script_name`.

Solución esperada en Auditor IPs:

    deduplicar por instance_key.

### 15.5. No se ven fases

Causa probable:

- El script no publica `step_current`, `step_total` o `step_name`.
- Auditor IPs no está pintando esos campos.
- El navegador tiene caché de JS.

Solución:

    publicar campos de progreso y recargar sin caché.

## 16. Buenas prácticas para Windows

- Usar rutas UNC para destinos de red.
- No depender de unidades mapeadas si la tarea se ejecuta sin sesión interactiva.
- Ejecutar el Programador de tareas con un usuario que tenga acceso a:
  - Docker Desktop;
  - rutas UNC de backup;
  - rutas UNC de logs;
  - carpeta del script.
- Publicar `cron_source=windows_task_scheduler`.
- Sincronizar manualmente `cron_expr` cuando cambie la tarea.
- No usar comandos Linux en CMD, como `grep`, `tail` o `clear`.

## 17. Buenas prácticas para Linux

- Usar rutas absolutas.
- Publicar `cron_source` con el origen real:
  - root crontab;
  - crontab de usuario;
  - systemd timer;
  - script lanzado por otro scheduler.
- Validar JSON con:

    python3 -m json.tool /ruta/script.status.json

- Validar detección en Auditor IPs desde el contenedor si procede.

## 18. Validación rápida en Auditor IPs

En el host Linux:

    python3 -m json.tool /SERVER/Logs_scripts_General/<script_name>.status.json

Dentro del contenedor:

    docker compose exec -T auditor_ips sh -lc 'ls -l /data/scripts_status'

Para comprobar estados desde backend, usar el entorno PRE y las funciones internas del router solo en desarrollo.

## 19. Criterio de documentación para nuevas integraciones

Cada integración nueva debe documentar:

- nombre técnico del script;
- host;
- ruta real del script;
- scheduler real;
- cron informado;
- ruta de logs;
- ruta del `.status.json`;
- fases publicadas si existen;
- política de backup o retención;
- comandos de validación;
- recuperación básica ante fallo.

## 20. Ejemplo aplicado: Immich Windows

Nombre técnico:

    backup_immich_windows

Host:

    SERVERCENTRALWI

Scheduler:

    Windows Task Scheduler

Cron informado:

    22 7 * * *

Destino del backup:

    \\192.168.1.253\AlmacenExt\Backups_Completos\SERVIDOR\VM_linux\VM_Immich_Backup.7z

Estados publicados:

    /SERVER/Logs_scripts_General/backup_immich_windows.status.json
    /SERVER/Logs_scripts_General/SERVERCENTRALWI/backup_immich_windows/backup_immich_windows.status.json

Fases publicadas:

    1/8 Validando entorno
    2/8 Comprobando Docker
    3/8 Parando immich-server
    4/8 Generando dump PostgreSQL
    5/8 Copiando configuración
    6/8 Comprimiendo backup cifrado
    7/8 Moviendo backup a destino final
    8/8 Arrancando immich-server y limpiando staging

Resultado esperado:

    Auditor IPs muestra estado OK, próxima ejecución, log, programación y progreso por fases durante la ejecución.
