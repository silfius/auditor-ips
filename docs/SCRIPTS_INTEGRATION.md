# Integración de scripts y automatizaciones

Auditor IPs puede observar automatizaciones ejecutadas en otros procesos o equipos. No necesita asumir control remoto sobre cron, systemd o el Programador de tareas.

## 1. Métodos soportados

| Método | Uso recomendado |
|---|---|
| Agente API | Hosts remotos y envío inmediato autenticado |
| Fichero `.status.json` | Scripts locales o estados sincronizados a una carpeta persistente |
| Integración manual mediante API | Wrappers propios que ya gestionan HTTP y secretos |

El agente API es la opción preferida cuando el host remoto puede alcanzar Auditor IPs por HTTPS.

## 2. Identidad estable

Cada automatización se identifica por la combinación:

```text
host_name + script_name
```

Usa nombres técnicos estables. No cambies `script_name` en cada ejecución y no reutilices un mismo par para procesos diferentes.

## 3. Agente API remoto

### Crear el agente

1. Entra en Configuración → Procesos/Automatizaciones.
2. Crea un agente para el host remoto.
3. Copia el token mostrado una sola vez.
4. Guárdalo en un fichero restringido del host remoto.

### Instalar el helper Linux

Desde un clon del repositorio en el host remoto:

```bash
python3 scripts/install_auditor_agent.py \
  --server-url https://IP_O_DNS:9909 \
  --host-name NOMBRE_HOST
```

Consulta las opciones reales:

```bash
python3 scripts/install_auditor_agent.py --help
```

Evita pasar el token en la línea de comandos. Usa el prompt interactivo o `--token-file`.

### Enviar un estado

Tras instalar el helper:

```bash
auditor-agent-send-status nombre_script completed 0 "mensaje opcional" /ruta/al/log.log
```

El agente solo envía estado y log al servidor; no habilita ejecución remota desde Auditor IPs.

## 4. Integración mediante `.status.json`

La carpeta host que se monte o sincronice como estado de scripts debe corresponder con `/data/scripts_status` dentro del contenedor.

Estructura recomendada:

```text
<RUTA_ESTADOS>/
└── NOMBRE_HOST/
    └── nombre_script/
        └── nombre_script.status.json
```

No se prescribe una ruta absoluta del host: configúrala según tu instalación y evita directorios temporales.

### Ejemplo mínimo

```json
{
  "script_name": "backup_nocturno",
  "host_name": "servidor-01",
  "status": "success",
  "message": "Backup completado",
  "start_time": "2026-07-18T02:00:00+02:00",
  "end_time": "2026-07-18T02:08:12+02:00",
  "updated_at": "2026-07-18T02:08:12+02:00",
  "exit_code": 0
}
```

### Estados recomendados

- `running`: ejecución activa;
- `success`, `ok` o `completed`: final correcto;
- `error` o `failed`: final con error;
- `missed`: ejecución esperada no observada;
- `stalled`: ejecución sin heartbeat reciente;
- `controlled_stop`: parada prevista.

Para máxima interoperabilidad, publica el mismo valor en `status` y `state`.

## 5. Programación declarada

Auditor IPs no modifica el programador real. El script puede declarar:

```json
{
  "cron_expr": "22 7 * * *",
  "cron_source": "systemd timer"
}
```

Actualiza esos campos cuando cambie la programación efectiva.

## 6. Progreso y heartbeat

Para procesos largos:

```json
{
  "status": "running",
  "heartbeat": "2026-07-18T02:05:00+02:00",
  "updated_at": "2026-07-18T02:05:00+02:00",
  "step_current": 3,
  "step_total": 5,
  "step_name": "Comprimiendo",
  "progress_percent": 60,
  "progress_text": "3/5 Comprimiendo"
}
```

Actualiza el heartbeat con una frecuencia proporcional a la duración del proceso; 30–60 segundos es razonable para tareas de varios minutos.

## 7. Logs y artefactos

Campos opcionales:

```json
{
  "log_file": "/ruta/al/log-actual.log",
  "artifact_file": "/ruta/al/resultado.tar.gz",
  "artifact_size_bytes": 209715200
}
```

Las rutas deben ser útiles desde el entorno que consume el estado. No publiques credenciales, parámetros secretos o URLs con token.

## 8. Escritura atómica

No escribas directamente sobre el JSON final. Usa un temporal en el mismo sistema de archivos y reemplázalo al terminar:

```text
nombre_script.status.json.tmp → nombre_script.status.json
```

Esto evita lecturas parciales.

Ejemplo Python:

```python
import json
import os
from pathlib import Path

final = Path("nombre_script.status.json")
temporary = final.with_suffix(final.suffix + ".tmp")
temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.replace(temporary, final)
```

## 9. Seguridad

- Guarda tokens con permisos restringidos.
- No incluyas secretos en JSON ni logs.
- Valida TLS; usa una CA local de confianza en lugar de desactivar la verificación de forma permanente.
- Rota un token si aparece en consola, captura o log.
- Limita el agente a envío de estado.
- Aplica retención a logs y artefactos.

## 10. Checklist

- `host_name` y `script_name` son estables.
- Existe `status` o `state`.
- Se publican `updated_at` o `heartbeat`.
- `exit_code` refleja el resultado real.
- Los procesos largos publican progreso.
- El JSON es UTF-8 válido y se escribe atómicamente.
- Los logs no contienen secretos.
- La hora y zona horaria del host son correctas.
- El token puede rotarse sin modificar el script principal.
