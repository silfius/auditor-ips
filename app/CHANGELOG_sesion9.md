# CHANGELOG — Sesión 9: Refactorización a paquete de routers

## Objetivo
Partir el monolito `main.py` (4 280 líneas) en módulos independientes,
manteniendo funcionalidad 100% idéntica y añadiendo las mejoras acordadas.

---

## Estructura resultante

```
/app/
├── main.py              259 líneas  ← orquestador puro
├── database.py          349 líneas  ← db(), init_db(), migraciones
├── utils.py             198 líneas  ← helpers sin dependencias cruzadas
├── config.py            193 líneas  ← cfg(), load_settings(), rate-limiter login
└── routers/
    ├── __init__.py       14 líneas
    ├── scans.py        1236 líneas  ← motor nmap, discord, push, OUI, fingerprint
    ├── hosts.py         651 líneas  ← CRUD hosts, tipos, WoL, dashboard, CSV
    ├── config_api.py    456 líneas  ← settings, backup, push, VAPID, XLSX
    ├── quality.py       390 líneas  ← calidad de conexión + scheduler
    ├── services.py      378 líneas  ← servicios TCP/HTTP + scheduler
    ├── router_ssh.py    296 líneas  ← integración router SSH
    ├── auth.py          263 líneas  ← autenticación, sesiones, audit log
    └── alerts.py        126 líneas  ← alertas programables

TOTAL: 4 809 líneas  (vs 4 280 original, +12% por docstrings y separación)
```

---

## Cambios funcionales incluidos

### 1. SSH `StrictHostKeyChecking` persistente
- `routers/scans.py → _ssh_run()`: primera conexión usa `accept-new` y guarda
  el fingerprint en `/data/ssh_known_hosts`. Las conexiones siguientes usan
  `StrictHostKeyChecking=yes`.
- Nuevo endpoint `POST /api/router/test/reset-known-hosts` en `router_ssh.py`:
  elimina el fichero para forzar re-aceptación tras cambio de router.

### 2. Multi-CIDR
- `utils.py → parse_cidr_list(raw)`: acepta `"192.168.1.0/24,10.0.0.0/8"`,
  valida cada entrada y devuelve lista limpia.
- `routers/scans.py → run_scan(cidr_raw)`: si se detectan múltiples CIDRs
  los escanea en paralelo con `ThreadPoolExecutor` y consolida los resultados.
- El campo `scan_cidr` en settings ya acepta múltiples CIDRs por coma.

### 3. Rate limiter de login
- `config.py → login_check_and_record(ip, success)` y `login_retry_after(ip)`:
  10 intentos fallidos en 5 min → bloqueo de 5 min, respuesta 429 con
  `Retry-After`. Thread-safe, sin dependencias externas.
- `routers/auth.py → POST /api/auth/login`: integra el rate limiter.

### 4. `/docs` y `/redoc` públicos
- `main.py`: `FastAPI(docs_url="/docs", redoc_url="/redoc")`.
- `AuditMiddleware`: rutas `/docs`, `/redoc`, `/openapi.json` bypass completo
  (ni enforce de auth ni audit log).

### 5. Backup automático mejorado
- `routers/config_api.py`: `run_backup()` usa la SQLite backup API (copia
  consistente, sin bloquear escrituras). Nuevos endpoints:
  - `GET  /api/backup/list`
  - `GET  /api/backup/download/{filename}`
  - `DELETE /api/backup/{filename}`
- Scheduler: job diario a las 03:00 UTC.

---

## Arquitectura de dependencias (sin ciclos)

```
utils.py          ← solo stdlib + python-dateutil
    ↑
database.py       ← stdlib + utils
    ↑
config.py         ← stdlib + database
    ↑
routers/*.py      ← importan libremente database, utils, config
                     imports circulares evitados con imports locales
                     dentro de funciones donde necesario
```

---

## Cómo hacer el despliegue

1. Detener el contenedor:
   ```bash
   docker compose down
   ```

2. Sustituir ficheros:
   ```
   main.py          → /app/main.py
   database.py      → /app/database.py
   utils.py         → /app/utils.py
   config.py        → /app/config.py
   routers/         → /app/routers/  (carpeta completa)
   ```

3. Arrancar:
   ```bash
   docker compose up -d
   docker compose logs -f auditor_ips
   ```

4. Verificar:
   - La app arranca en <5s
   - `/docs` accesible sin login
   - Primer scan automático a los 3s del arranque
   - `GET /api/router/status` devuelve `"enabled": true/false`

---

## Ficheros NO modificados
- `auth_middleware.py` — sin cambios
- `templates/`         — sin cambios
- `static/`            — sin cambios
- `docker-compose.yml` — sin cambios
- `Dockerfile`         — sin cambios
