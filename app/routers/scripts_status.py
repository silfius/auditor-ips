"""
scripts_status.py — Procesos programados + Log en vivo + Docs + Análisis IA
Sesión 13: Ollama (gemma2:2b)
Sesión 14: Gemini Flash + selector de proveedor desde Config → IA (BD via cfg())

Proveedor activo: cfg("ai_provider")  →  "gemini" | "ollama"
API key Gemini:   cfg("ai_gemini_key")
Modelo Gemini:    cfg("ai_gemini_model")
"""

import os
import json
import urllib.request
import urllib.error
import re
import threading
import socket
import secrets
import hashlib
from pathlib import Path
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Request, Query
from config import cfg
from database import db

# ── Debug counters — contadores de llamadas a Gemini ─────────────────────────
_gemini_lock      = threading.Lock()
_gemini_calls     = []   # lista de dicts con info de cada llamada

def _cfg_timeout_seconds(key: str, fallback: int, min_value: int, max_value: int) -> int:
    try:
        raw = cfg(key, str(fallback))
        value = int(float(raw))
    except Exception:
        value = fallback
    return max(min_value, min(max_value, value))


def _script_ai_cloud_timeout() -> int:
    return _cfg_timeout_seconds("script_ai_cloud_timeout_seconds", 30, 5, 300)


def _script_ai_local_timeout() -> int:
    return _cfg_timeout_seconds("script_ai_local_timeout_seconds", 180, 30, 900)


def _gemini_log(call_type: str, endpoint: str, status: str, extra: str = ""):
    """Registra cada llamada a la API de Gemini con timestamp, tipo y origen."""
    import traceback
    entry = {
        "ts":        datetime.now().isoformat(timespec="seconds"),
        "type":      call_type,   # "generate" | "status_test" | "status_ping"
        "endpoint":  endpoint,
        "status":    status,      # "ok" | "429" | "error:XXX"
        "extra":     extra,
        "stack":     traceback.format_stack(limit=6),
    }
    with _gemini_lock:
        _gemini_calls.append(entry)
        # Mantener solo los últimos 200
        if len(_gemini_calls) > 200:
            _gemini_calls.pop(0)
    print(f"[GEMINI-DEBUG] {entry['ts']} type={call_type} status={status} {extra}", flush=True)

router = APIRouter()

# ── Directorios ───────────────────────────────────────────────────────────────
SCRIPTS_STATUS_DIR         = os.getenv("SCRIPTS_STATUS_DIR", "/data/scripts_status")
SCRIPTS_AGENT_STATUS_DIR   = os.getenv("SCRIPTS_AGENT_STATUS_DIR", "/data/agent_scripts_status")
SCRIPTS_PROMPTS_DIR        = os.getenv("SCRIPTS_PROMPTS_DIR", "/data/scripts_prompts")
SCRIPTS_AUDITDOC_DIR = os.getenv("SCRIPTS_AUDITDOC_DIR", "/data/auditor_docs")

# ── Fallbacks de entorno (usados antes de que cfg() cargue la BD) ─────────────
_ENV_PROVIDER     = os.getenv("AI_PROVIDER",    "gemini")
_ENV_GEMINI_KEY   = os.getenv("GEMINI_API_KEY", "")
_ENV_GEMINI_MODEL  = os.getenv("GEMINI_MODEL",    "gemini-2.0-flash")
_ENV_OLLAMA_URL    = os.getenv("OLLAMA_URL",      "http://localhost:11434")
_ENV_OLLAMA_MODEL  = os.getenv("OLLAMA_MODEL",    "gemma2:2b")
_ENV_MISTRAL_KEY   = os.getenv("MISTRAL_API_KEY", "")
_ENV_MISTRAL_MODEL = os.getenv("MISTRAL_MODEL",   "mistral-small-latest")

# ── Whitelist docs ────────────────────────────────────────────────────────────
PROCESS_DOCS = {
    "Automatizaciones.md",
    "PROMPT.md",
    "PROMPT para nuevo script.md",
    "PROMPT para dashboard.md",
}
README_DOCS  = {"README.md"}
ALLOWED_DOCS = PROCESS_DOCS | README_DOCS


# ─────────────────────────────────────────────────────────────────────────────
# Helpers: leer config dinámica desde BD (con fallback a .env)
# ─────────────────────────────────────────────────────────────────────────────

def _ai_provider() -> str:
    try:
        from config import cfg
        return cfg("ai_provider", _ENV_PROVIDER).lower()
    except Exception:
        return _ENV_PROVIDER.lower()

def _gemini_key() -> str:
    try:
        from config import cfg
        return cfg("ai_gemini_key", _ENV_GEMINI_KEY)
    except Exception:
        return _ENV_GEMINI_KEY

def _gemini_model() -> str:
    try:
        from config import cfg
        return cfg("ai_gemini_model", _ENV_GEMINI_MODEL)
    except Exception:
        return _ENV_GEMINI_MODEL

def _ollama_url() -> str:
    return _ENV_OLLAMA_URL

def _ollama_model() -> str:
    return _ENV_OLLAMA_MODEL

def _mistral_key() -> str:
    try:
        from config import cfg
        return cfg("ai_mistral_key", _ENV_MISTRAL_KEY)
    except Exception:
        return _ENV_MISTRAL_KEY

def _mistral_model() -> str:
    try:
        from config import cfg
        return cfg("ai_mistral_model", _ENV_MISTRAL_MODEL)
    except Exception:
        return _ENV_MISTRAL_MODEL


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de ficheros
# ─────────────────────────────────────────────────────────────────────────────

def _status_dir() -> Path:
    return Path(SCRIPTS_STATUS_DIR)


def _agent_status_dir() -> Path:
    return Path(SCRIPTS_AGENT_STATUS_DIR)


def _status_dirs() -> list[Path]:
    dirs: list[Path] = []
    for d in [_status_dir(), _agent_status_dir()]:
        if d not in dirs:
            dirs.append(d)
    return dirs


def _status_file_host_from_path(
    path: Path,
    base_dir: Path | None = None,
    subdir_source: str = "status_dir_subdir",
    root_source: str = "local_status_dir",
) -> tuple[str, str]:
    """
    Convención fase 2:
    - /data/scripts_status/script.status.json => host local
    - /data/scripts_status/HostRemoto/script.status.json => HostRemoto
    No ejecuta nada remoto; solo lee ficheros ya sincronizados/montados.
    """
    try:
        rel = path.relative_to(base_dir or _status_dir())
        if len(rel.parts) >= 2:
            return rel.parts[0], subdir_source
    except Exception:
        pass
    return "", root_source


def _read_status_files() -> list[dict]:
    results = []
    for d in _status_dirs():
        if not d.exists():
            continue
        is_agent_dir = d == _agent_status_dir()
        subdir_source = "agent_api" if is_agent_dir else "status_dir_subdir"
        root_source = "agent_api" if is_agent_dir else "local_status_dir"

        for f in sorted(d.rglob("*.status.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                host_from_path, source_from_path = _status_file_host_from_path(
                    f,
                    base_dir=d,
                    subdir_source=subdir_source,
                    root_source=root_source,
                )
                data.setdefault("_file", f.name)
                data["_status_path"] = str(f)
                data["_status_base_dir"] = str(d)
                data["_status_host_from_path"] = host_from_path
                data["_status_source_from_path"] = source_from_path
                results.append(data)
            except Exception:
                pass
    return results

def _script_name_from_file(filename: str) -> str:
    return Path(filename).name.replace(".status.json", "")

def _local_automation_host() -> str:
    return (os.getenv("AUDITOR_AUTOMATION_HOST", "") or socket.gethostname() or "Local").strip()


def _status_host_meta(item: dict) -> tuple[str, str]:
    host_name = (
        item.get("host_name")
        or item.get("host")
        or item.get("hostname")
        or item.get("source_host")
        or item.get("_status_host_from_path")
        or _local_automation_host()
    )
    host_source = (
        item.get("host_source")
        or item.get("source")
        or item.get("origin")
        or item.get("_status_source_from_path")
        or "local_status_dir"
    )
    return str(host_name or "Local").strip(), str(host_source or "local_status_dir").strip()


def _safe_host_segment(host: str) -> str:
    host = (host or "").strip()
    if not host or host in ("Local", _local_automation_host()):
        return ""
    if "/" in host or "\\" in host or ".." in host:
        return ""
    return host


def _status_path_for_script(name: str, host: str = "") -> Path:
    d = _status_dir()
    host_seg = _safe_host_segment(host)
    return (d / host_seg / f"{name}.status.json") if host_seg else (d / f"{name}.status.json")


def _find_log_file(name: str, host: str = "") -> Path | None:
    host_seg = _safe_host_segment(host)

    roots = []
    for d in _status_dirs():
        roots.append(d / host_seg if host_seg else d)
        if host_seg:
            roots.append(d)

    for root in roots:
        if not root.exists():
            continue
        for ext in [".log", f".{name}.log"]:
            p = root / f"{name}{ext}"
            if p.exists():
                return p
        candidates = list(root.glob(f"*{name}*.log"))
        if candidates:
            return candidates[0]
    return None

def _tail_file(path: Path, lines: int = 100) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            buf = bytearray()
            found = 0
            pos = size
            chunk = 4096
            while pos > 0 and found <= lines:
                read_size = min(chunk, pos)
                pos -= read_size
                f.seek(pos)
                buf[:0] = f.read(read_size)
                found = buf.count(b"\n")
            text = buf.decode("utf-8", errors="replace")
            return "\n".join(text.splitlines()[-lines:])
    except Exception as e:
        return f"[Error leyendo log: {e}]"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers de scheduling / cron
# ─────────────────────────────────────────────────────────────────────────────

_SCRIPT_CRON_OVERRIDES = {
    "backup_secundario_rclone": {"cron_expr": "10 * * * *", "source": "host_crontab"},
    "backup_onedrive": {"cron_expr": "0 2 * * *", "source": "user_crontab"},
    "clean_old_logs": {"cron_expr": "0 1 * * *", "source": "user_crontab"},
    "monitor_files_disaster": {"cron_expr": "35 * * * *", "source": "user_crontab"},
    "sync_whatsapp_clean_names": {"cron_expr": "*/5 * * * *", "source": "user_crontab"},
    "monitor_watchdog": {"cron_expr": "*/15 * * * *", "source": "user_crontab"},
    "backup_vm_linux": {"cron_expr": "0 0 * * *", "source": "root_crontab"},
    "serverwindows_wakeonland": {"cron_expr": "0 7 * * *", "source": "user_crontab"},
    "renew_letsencrypt": {"cron_expr": "0 3 1 * *", "source": "root_crontab"},
}


def _local_tzinfo():
    """Zona horaria local de la app/servidor para calcular próximos cron."""
    tz_name = os.getenv("TZ", "Europe/Madrid") or "Europe/Madrid"
    try:
        from config import cfg
        tz_name = cfg("app_tz", tz_name) or tz_name
    except Exception:
        pass
    try:
        return ZoneInfo(tz_name)
    except Exception:
        try:
            return datetime.now().astimezone().tzinfo or timezone.utc
        except Exception:
            return timezone.utc


def _cron_field_values(field: str, min_value: int, max_value: int) -> tuple[set[int], bool]:
    """
    Devuelve (valores, is_wildcard) para un campo cron.
    Soporta:
      *          → cualquier valor
      */N        → cada N
      A          → valor exacto
      A,B,C      → lista
      A-B        → rango
      A-B/N      → rango con step
    """
    field = (field or "").strip()
    if not field:
        return set(), False

    values: set[int] = set()
    is_wildcard = field == "*"

    for raw_part in field.split(","):
        part = raw_part.strip()
        if not part:
            continue

        step = 1
        if "/" in part:
            base, step_str = part.split("/", 1)
            step = max(1, int(step_str))
        else:
            base = part

        if base in ("", "*"):
            start, end = min_value, max_value
        elif "-" in base:
            left, right = base.split("-", 1)
            start, end = int(left), int(right)
        else:
            start = end = int(base)

        start = max(min_value, start)
        end = min(max_value, end)
        values.update(range(start, end + 1, step))

    return values, is_wildcard


def _cron_matches(dt_obj: datetime, cron_expr: str) -> bool:
    """Comprueba si un datetime local coincide con una expresión cron de 5 campos."""
    parts = (cron_expr or "").split()
    if len(parts) != 5:
        return False

    minute_vals, minute_any = _cron_field_values(parts[0], 0, 59)
    hour_vals, hour_any = _cron_field_values(parts[1], 0, 23)
    dom_vals, dom_any = _cron_field_values(parts[2], 1, 31)
    month_vals, month_any = _cron_field_values(parts[3], 1, 12)
    dow_vals, dow_any = _cron_field_values(parts[4], 0, 7)

    cron_dow = (dt_obj.weekday() + 1) % 7  # lunes=1 ... sábado=6, domingo=0

    if not minute_any and dt_obj.minute not in minute_vals:
        return False
    if not hour_any and dt_obj.hour not in hour_vals:
        return False
    if not month_any and dt_obj.month not in month_vals:
        return False

    dom_match = True if dom_any else dt_obj.day in dom_vals
    dow_match = True if dow_any else (cron_dow in dow_vals or (cron_dow == 0 and 7 in dow_vals))

    if dom_any and dow_any:
        return True
    if dom_any:
        return dow_match
    if dow_any:
        return dom_match
    return dom_match or dow_match


def _compute_next_run_from_cron(cron_expr: str, now_local: datetime | None = None) -> datetime | None:
    """
    Calcula la siguiente ejecución para un cron de 5 campos.
    Búsqueda minuto a minuto; suficiente para el número pequeño de jobs monitorizados.
    """
    if not cron_expr:
        return None

    tzinfo = _local_tzinfo()
    if now_local is None:
        now_local = datetime.now(tzinfo)
    else:
        if now_local.tzinfo is None:
            now_local = now_local.replace(tzinfo=tzinfo)
        else:
            now_local = now_local.astimezone(tzinfo)

    candidate = now_local.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = candidate + timedelta(days=370)

    while candidate <= limit:
        if _cron_matches(candidate, cron_expr):
            return candidate
        candidate += timedelta(minutes=1)

    return None


def _resolve_next_run(item: dict) -> tuple[str | None, str | None, str | None]:
    """
    Devuelve (next_run, cron_expr, cron_source).
    Prioriza cron_expr real si existe; si no, usa expected_start como fallback legado.
    """
    name = item.get("name") or item.get("script") or ""
    cron_expr = (item.get("cron_expr") or "").strip()
    cron_source = None

    if cron_expr:
        cron_source = "status_json"
    else:
        try:
            with db() as _conn:
                row = _conn.execute(
                    "SELECT cron_expr, cron_source FROM monitored_scripts WHERE script_name=?",
                    (name,),
                ).fetchone()
            if row and str(row["cron_expr"] or "").strip():
                cron_expr = str(row["cron_expr"] or "").strip()
                cron_source = str(row["cron_source"] or "").strip() or "config_ui"
        except Exception:
            pass

        if not cron_expr:
            override = _SCRIPT_CRON_OVERRIDES.get(name)
            if override:
                cron_expr = override.get("cron_expr", "").strip()
                cron_source = override.get("source")

    if cron_expr:
        try:
            next_dt = _compute_next_run_from_cron(cron_expr)
            if next_dt:
                return next_dt.strftime("%Y-%m-%d %H:%M:%S"), cron_expr, cron_source
        except Exception:
            # Cron informativo inválido: no debe romper la vista de Automatizaciones.
            pass

    expected = (item.get("expected_start") or "").strip()
    if expected:
        try:
            h, m = map(int, expected.split(":"))
            now_local = datetime.now(_local_tzinfo())
            candidate = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
            if candidate <= now_local:
                candidate += timedelta(days=1)
            return candidate.strftime("%Y-%m-%d %H:%M:%S"), None, "expected_start"
        except Exception:
            pass

    return None, cron_expr or None, cron_source



# ─────────────────────────────────────────────────────────────────────────────
# Prompt — Extracción rica de datos del log estructurado
# ─────────────────────────────────────────────────────────────────────────────

def _parse_log_executions(log_text: str) -> list:
    """
    Parsea el log estructurado de monitor_lib.sh/py y extrae cada ejecución
    con sus pasos, tiempos por paso, errores y duración total.
    """
    import re
    executions = []
    current = None

    for line in log_text.splitlines():
        # Inicio de ejecución
        m = re.match(r'\[MONITOR\] Inicio: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', line)
        if m:
            current = {
                "start":    m.group(1),
                "end":      None,
                "duration": None,
                "steps":    [],
                "errors":   [],
                "warnings": [],
                "fin_ok":   False,
            }
            continue

        if current is None:
            continue

        # Paso individual
        m = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[PASO (\d+)/(\d+)\] (.+)', line)
        if m:
            current["steps"].append({
                "ts":    m.group(1),
                "num":   int(m.group(2)),
                "total": int(m.group(3)),
                "label": m.group(4),
            })
            continue

        # Fin exitoso
        m = re.match(r'\[MONITOR\] Fin: (\S+ \S+) \| Duración: (\d+)s', line)
        if m:
            current["end"]      = m.group(1)
            current["duration"] = int(m.group(2))
            current["fin_ok"]   = True
            executions.append(current)
            current = None
            continue

        # Error explícito del monitor
        m = re.match(r'\[MONITOR\] ERROR: (.+)', line)
        if m:
            current["errors"].append(m.group(1))
            continue

        # Líneas con ERROR/FATAL que no son del monitor
        if re.search(r'\bERROR\b|\bFATAL\b', line, re.IGNORECASE):
            if "[MONITOR]" not in line:
                current["errors"].append(line.strip())

        # WARN
        if re.search(r'\bWARN\b|\bWARNING\b', line):
            if "[MONITOR] WARN" in line or "[MONITOR]" not in line:
                current["warnings"].append(line.strip())

    # Ejecución sin cerrar (script en marcha o abortado)
    if current:
        executions.append(current)

    return executions


def _format_duration(secs) -> str:
    if secs is None:
        return "?"
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    m, s = divmod(secs, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


def _build_analysis_prompt(script_name: str, status: dict, log_text: str) -> str:
    from datetime import datetime as _dt

    # ── Datos del status.json ─────────────────────────────────────────────────
    state      = status.get("status", "?")
    exit_code  = status.get("exit_code")
    duration   = status.get("duration_seconds")
    start_time = status.get("start_time", "?")
    end_time   = status.get("end_time", "?")
    expected   = status.get("expected_start", "")
    raw_errors = status.get("error_messages", [])

    # Distinguir alertas funcionales de errores reales
    is_functional_alert = (status.get("error") is True and exit_code == 0)
    is_real_error       = (status.get("error") is True and exit_code not in (0, None))
    is_missed           = (state == "missed")
    is_stalled          = (state == "stalled")

    # Filtrar ruido interno del monitor
    _NOISE = ("[MONITOR] ERROR: Ejecución completada con alertas",)
    real_error_msgs = [e for e in raw_errors
                       if not any(e.startswith(n) for n in _NOISE)]

    # ── Parseo estructurado del log ───────────────────────────────────────────
    executions = _parse_log_executions(log_text)

    exec_summary_parts = []
    for i, ex in enumerate(executions, 1):
        n_steps = len(ex["steps"])
        total   = ex["steps"][0]["total"] if ex["steps"] else "?"
        dur_str = _format_duration(ex["duration"])
        status_str = "✓ Completada" if ex["fin_ok"] else "✗ Incompleta/abortada"

        # Tiempos por paso (solo los que tardaron > 10s)
        step_times = []
        for j in range(1, len(ex["steps"])):
            try:
                t0 = _dt.strptime(ex["steps"][j-1]["ts"], "%Y-%m-%d %H:%M:%S")
                t1 = _dt.strptime(ex["steps"][j]["ts"],   "%Y-%m-%d %H:%M:%S")
                delta = int((t1 - t0).total_seconds())
                if delta > 10:
                    step_times.append(
                        f"    · {ex['steps'][j-1]['label']}: {_format_duration(delta)}"
                    )
            except Exception:
                pass

        step_list = "\n".join(
            f"  {s['num']}/{s['total']}: {s['label']}" for s in ex["steps"]
        )
        times_block = ("\n  Tiempos destacados:\n" + "\n".join(step_times)) if step_times else ""
        err_block   = ("\n  Errores:\n" + "\n".join(f"  ✗ {e}" for e in ex["errors"][:5])) \
                      if ex["errors"] else ""
        warn_block  = ("\n  Avisos:\n" + "\n".join(f"  ⚠ {w}" for w in ex["warnings"][:3])) \
                      if ex["warnings"] else ""

        exec_summary_parts.append(
            f"── Ejecución {i}: {ex['start']} | Duración: {dur_str} | {status_str}\n"
            f"  Pasos: {n_steps}/{total}\n"
            f"{step_list}"
            f"{times_block}{err_block}{warn_block}"
        )

    exec_summary = "\n\n".join(exec_summary_parts) if exec_summary_parts else log_text

    # ── Tendencias entre ejecuciones ──────────────────────────────────────────
    trend_lines = []
    if len(executions) >= 2:
        durs = [e["duration"] for e in executions if e["duration"] is not None]
        if len(durs) >= 2:
            diff = durs[-1] - durs[-2]
            pct  = int(abs(diff) * 100 / durs[-2]) if durs[-2] else 0
            if abs(diff) > 30:
                arrow = "⬆️ aumentó" if diff > 0 else "⬇️ disminuyó"
                trend_lines.append(
                    f"Duración {arrow} {_format_duration(abs(diff))} ({pct}%) "
                    f"respecto a la ejecución anterior."
                )
        totals = [e["steps"][0]["total"] if e["steps"] else None for e in executions]
        totals = [t for t in totals if t is not None]
        if len(totals) >= 2 and totals[-1] != totals[-2]:
            diff_t = totals[-1] - totals[-2]
            trend_lines.append(
                f"Volumen procesado cambió de {totals[-2]} a {totals[-1]} elementos "
                f"({'+' if diff_t > 0 else ''}{diff_t})."
            )

    trend_ctx = ("\nTendencias:\n" + "\n".join(f"  · {t}" for t in trend_lines)) \
                if trend_lines else ""

    # ── Estado ───────────────────────────────────────────────────────────────
    if is_missed:
        state_ctx = "⚠️ MISSED — El script NO arrancó en su hora prevista"
    elif is_stalled:
        state_ctx = "⚠️ STALLED — Bloqueado sin actualizar estado"
    elif is_real_error:
        state_ctx = f"❌ ERROR — Falló con exit_code={exit_code}"
    elif is_functional_alert:
        state_ctx = "⚠️ ALERTA FUNCIONAL — Terminó OK (exit_code=0) pero detectó condiciones de alerta"
    else:
        state_ctx = "✅ COMPLETADO — Sin errores"

    error_ctx = ("\nAlertas/errores reportados:\n" +
                 "\n".join(f"  · {e}" for e in real_error_msgs[:5])) \
                if real_error_msgs else ""

    return f"""Eres un experto en sistemas Linux y administración de servidores. \
Analiza la siguiente información de un script automatizado y responde SIEMPRE en español, \
usando los datos concretos que aparecen (nombres, tiempos, cantidades reales).

══════════════════════════════════════════
SCRIPT: {script_name}
Hora prevista: {expected or '—'}  |  Inicio: {start_time}  |  Fin: {end_time}
Duración: {_format_duration(duration)}  |  Exit code: {exit_code if exit_code is not None else '—'}
Estado: {state_ctx}{error_ctx}{trend_ctx}
══════════════════════════════════════════
EJECUCIONES EN EL LOG:
{exec_summary}
══════════════════════════════════════════
INSTRUCCIONES:
- Responde con las 4 secciones Markdown siguientes.
- Usa nombres concretos del log (VMs, ficheros, pasos), no genéricos.
- Si el script terminó con exit_code=0, NO lo trates como fallo aunque error=true.
- Si no hay problemas reales, dilo claramente en "Alertas".

## ¿Qué ocurrió?
(Qué procesó el script, cuántos elementos, resultado. Menciona los nombres reales.)

## Detalles técnicos
(Pasos que tardaron más, cambios respecto a ejecuciones anteriores, elementos nuevos o eliminados.)

## Alertas o problemas
(Errores reales o anomalías. Si todo fue bien → "Ninguna anomalía detectada.")

## Recomendación
(Una acción concreta basada en los datos observados.)"""


# ─────────────────────────────────────────────────────────────────────────────
# Endpoint — Análisis IA
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/api/scripts/analyze/{name}")
def analyze_script_with_ai(name: str, lines: int = 200, host: str = Query("", max_length=120)):
    """Analiza el log con el proveedor IA activo (Gemini, Mistral u Ollama)."""
    status_path = _status_path_for_script(name, host)
    status = {}
    if status_path.exists():
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    log_path = _find_log_file(name, host)
    log_text = "(log no disponible)"
    if log_path:
        log_text = _tail_file(log_path, lines=lines) or "(log vacío)"

    prompt = _build_analysis_prompt(name, status, log_text)
    analysis, model_used = _ai_generate(prompt)

    return {
        "name":           name,
        "host_name":      host or "Local",
        "provider":       _ai_provider(),
        "model":          model_used,
        "analysis":       analysis,
        "log_lines_used": lines,
        "analyzed_at":    datetime.now(timezone.utc).isoformat(),
    }

def _gemini_generate(prompt: str) -> str:
    key   = _gemini_key()
    model = _gemini_model()

    if not key:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY no configurada. Guárdala en Config → IA o en el .env."
        )

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={key[:8]}…"
    )
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 512},
    }).encode("utf-8")

    real_url = url.replace(key[:8] + "…", key)
    req = urllib.request.Request(
        real_url, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_script_ai_cloud_timeout()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            _gemini_log("generate", "generateContent", "ok", f"model={model}")
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        _gemini_log("generate", "generateContent", f"{e.code}", body[:80])
        detail = f"Gemini error {e.code}: {body[:300]}"
        if e.code == 429:
            detail = f"Gemini saturado o límite alcanzado (429). Reintenta más tarde. Detalle: {body[:220]}"
        raise HTTPException(status_code=(429 if e.code == 429 else 502), detail=detail)
    except urllib.error.URLError as e:
        _gemini_log("generate", "generateContent", "url_error", str(e.reason))
        raise HTTPException(status_code=503, detail=f"Gemini no accesible: {e.reason}")
    except (KeyError, IndexError) as e:
        _gemini_log("generate", "generateContent", "parse_error", str(e))
        raise HTTPException(status_code=502, detail=f"Respuesta inesperada de Gemini: {e}")
    except Exception as e:
        _gemini_log("generate", "generateContent", "exception", str(e))
        raise HTTPException(status_code=500, detail=f"Error llamando a Gemini: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Proveedor: Ollama
# ─────────────────────────────────────────────────────────────────────────────

def _ollama_generate(prompt: str) -> str:
    payload = json.dumps({
        "model": _ollama_model(),
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": 256},
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{_ollama_url()}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_script_ai_local_timeout()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("response", "").strip()
    except urllib.error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Ollama no disponible: {e.reason}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error llamando a Ollama: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Proveedor: Mistral
# ─────────────────────────────────────────────────────────────────────────────

def _mistral_generate(prompt: str) -> str:
    key   = _mistral_key()
    model = _mistral_model()

    if not key:
        raise HTTPException(
            status_code=503,
            detail="MISTRAL_API_KEY no configurada. Guárdala en Config → IA o en el .env."
        )

    payload = json.dumps({
        "model":       model,
        "messages":    [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens":  800,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.mistral.ai/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_script_ai_cloud_timeout()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            raw = data["choices"][0]["message"]["content"].strip()
            # Limpiar wrappers ```markdown ... ``` que Mistral añade a veces
            raw = re.sub(r'^```(?:markdown)?\s*', '', raw, flags=re.IGNORECASE)
            raw = re.sub(r'\s*```\s*$', '', raw).strip()
            return raw
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        detail = f"Mistral error {e.code}: {body[:300]}"
        if e.code == 429:
            detail = f"Mistral saturado o límite alcanzado (429). Reintenta más tarde. Detalle: {body[:220]}"
        raise HTTPException(status_code=(429 if e.code == 429 else 502), detail=detail)
    except urllib.error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Mistral no accesible: {e.reason}")
    except (KeyError, IndexError) as e:
        raise HTTPException(status_code=502, detail=f"Respuesta inesperada de Mistral: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error llamando a Mistral: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Router IA
# ─────────────────────────────────────────────────────────────────────────────

def _ai_generate(prompt: str) -> tuple[str, str]:
    """Devuelve (texto_respuesta, modelo_usado)."""
    provider = _ai_provider()
    if provider == "gemini":
        return _gemini_generate(prompt), _gemini_model()
    elif provider == "mistral":
        return _mistral_generate(prompt), _mistral_model()
    elif provider == "ollama":
        return _ollama_generate(prompt), _ollama_model()
    else:
        raise HTTPException(
            status_code=500,
            detail=f"ai_provider desconocido: '{provider}'. Usa 'gemini', 'mistral' u 'ollama'."
        )




# ─────────────────────────────────────────────────────────────────────────────
# Agente remoto de automatizaciones — recepción de status/log
# ─────────────────────────────────────────────────────────────────────────────

def _automation_agent_token() -> str:
    try:
        from config import cfg
        return str(cfg("automation_agent_token", os.getenv("AUTOMATION_AGENT_TOKEN", "")) or "").strip()
    except Exception:
        return str(os.getenv("AUTOMATION_AGENT_TOKEN", "") or "").strip()


def _automation_agent_token_hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _automation_agent_new_token() -> str:
    return secrets.token_urlsafe(32)


def _automation_agent_token_prefix(token: str) -> str:
    return str(token or "")[:10]


def _automation_agent_client_ip(request: Request) -> str:
    try:
        return request.client.host if request.client else ""
    except Exception:
        return ""


def _automation_agent_extract_token(request: Request) -> str:
    auth = str(request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return str(request.headers.get("x-automation-agent-token") or "").strip()


def _automation_agent_audit(
    host_name: str,
    request: Request,
    action: str,
    ok: bool,
    detail: dict | str | None = None,
) -> None:
    try:
        if isinstance(detail, dict):
            detail_text = json.dumps(detail, ensure_ascii=False, sort_keys=True)
        else:
            detail_text = str(detail or "")
        with db() as conn:
            conn.execute("""
                INSERT INTO automation_agent_events(at, host_name, ip, action, ok, detail)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                datetime.now(timezone.utc).isoformat(),
                str(host_name or ""),
                _automation_agent_client_ip(request),
                str(action or ""),
                1 if ok else 0,
                detail_text[:4000],
            ))
    except Exception:
        pass


def _automation_agent_get_row(host_name: str):
    try:
        with db() as conn:
            return conn.execute(
                "SELECT * FROM automation_agents WHERE host_name=?",
                (host_name,),
            ).fetchone()
    except Exception:
        return None


def _automation_agent_mark_seen(host_name: str, request: Request, script_name: str) -> None:
    try:
        now = datetime.now(timezone.utc).isoformat()
        with db() as conn:
            conn.execute("""
                UPDATE automation_agents
                SET last_seen_at=?, last_seen_ip=?, last_status_script=?, updated_at=?
                WHERE host_name=?
            """, (
                now,
                _automation_agent_client_ip(request),
                script_name,
                now,
                host_name,
            ))
    except Exception:
        pass


def _automation_agent_check_auth(request: Request, host_name: str) -> dict:
    token = _automation_agent_extract_token(request)
    if not token:
        _automation_agent_audit(host_name, request, "auth_failed", False, "token ausente")
        raise HTTPException(status_code=403, detail="Token de agente inválido")

    row = _automation_agent_get_row(host_name)
    if row:
        if not bool(row["enabled"]) or row["revoked_at"]:
            _automation_agent_audit(host_name, request, "auth_failed", False, "agente revocado o deshabilitado")
            raise HTTPException(status_code=403, detail="Agente revocado o deshabilitado")

        expected_hash = str(row["token_hash"] or "")
        incoming_hash = _automation_agent_token_hash(token)
        if secrets.compare_digest(incoming_hash, expected_hash):
            return {"mode": "host_token", "host_name": host_name}

        _automation_agent_audit(host_name, request, "auth_failed", False, "token de host inválido")
        raise HTTPException(status_code=403, detail="Token de agente inválido")

    # Compatibilidad con bloque anterior: token global.
    expected = _automation_agent_token()
    if not expected:
        _automation_agent_audit(host_name, request, "auth_failed", False, "sin token global ni agente registrado")
        raise HTTPException(status_code=403, detail="automation_agent_token no configurado o agente no registrado")

    if not secrets.compare_digest(token, expected):
        _automation_agent_audit(host_name, request, "auth_failed", False, "token global inválido")
        raise HTTPException(status_code=403, detail="Token de agente inválido")

    return {"mode": "global_token", "host_name": host_name}

def _safe_agent_segment(value: str, label: str) -> str:
    value = str(value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail=f"{label} obligatorio")
    if len(value) > 120:
        raise HTTPException(status_code=400, detail=f"{label} demasiado largo")
    if "/" in value or "\\" in value or ".." in value:
        raise HTTPException(status_code=400, detail=f"{label} inválido")
    if not re.match(r"^[A-Za-z0-9_.-]+$", value):
        raise HTTPException(status_code=400, detail=f"{label} solo permite letras, números, punto, guion y guion bajo")
    return value


def _normalize_agent_status(payload: dict) -> dict:
    host_name = _safe_agent_segment(
        payload.get("host_name") or payload.get("host") or payload.get("host_id"),
        "host_name"
    )
    script_name = _safe_agent_segment(
        payload.get("script_name") or payload.get("name"),
        "script_name"
    )

    status = str(payload.get("status") or payload.get("state") or "unknown").strip().lower()
    allowed_status = {"running", "started", "completed", "ok", "failed", "error", "missed", "stalled", "unknown"}
    if status not in allowed_status:
        status = "unknown"

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    item = {
        "host_name": host_name,
        "host_source": "agent_api",
        "script_name": script_name,
        "status": status,
        "start_time": payload.get("start_time") or payload.get("last_run") or now,
        "end_time": payload.get("end_time"),
        "exit_code": payload.get("exit_code"),
        "step_current": payload.get("step_current"),
        "step_total": payload.get("step_total"),
        "step_label": payload.get("step_label") or "",
        "progress_pct": payload.get("progress_pct"),
        "duration_seconds": payload.get("duration_seconds"),
        "error": bool(payload.get("error", False)),
        "error_messages": payload.get("error_messages") or payload.get("errors") or [],
        "updated_at": now,
    }

    if item["status"] in ("completed", "ok") and item["exit_code"] is None:
        item["exit_code"] = 0
    if item["status"] in ("failed", "error") and item["exit_code"] in (None, 0):
        item["exit_code"] = 1
    if item["status"] == "ok":
        item["status"] = "completed"

    return item


@router.get("/api/scripts/automation-agents")
def list_automation_agents():
    """Lista agentes API configurados sin exponer tokens reales."""
    with db() as conn:
        rows = conn.execute("""
            SELECT id, host_name, token_prefix, enabled, notes,
                   created_at, updated_at, last_seen_at, last_seen_ip,
                   last_status_script, revoked_at
            FROM automation_agents
            ORDER BY host_name COLLATE NOCASE ASC
        """).fetchall()
    return {"ok": True, "agents": [dict(r) for r in rows]}


@router.post("/api/scripts/automation-agents")
async def create_automation_agent(request: Request):
    """Crea un agente y devuelve el token una sola vez."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    host_name = _safe_agent_segment(
        payload.get("host_name") or payload.get("host") or payload.get("host_id"),
        "host_name"
    )
    notes = str(payload.get("notes") or "")[:1000]
    enabled = 1 if payload.get("enabled", True) else 0
    token = _automation_agent_new_token()
    now = datetime.now(timezone.utc).isoformat()

    try:
        with db() as conn:
            conn.execute("""
                INSERT INTO automation_agents
                    (host_name, token_hash, token_prefix, enabled, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                host_name,
                _automation_agent_token_hash(token),
                _automation_agent_token_prefix(token),
                enabled,
                notes,
                now,
                now,
            ))
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"No se pudo crear el agente: {e}")

    _automation_agent_audit(host_name, request, "agent_created", True, {"enabled": enabled})
    return {
        "ok": True,
        "host_name": host_name,
        "token": token,
        "token_prefix": _automation_agent_token_prefix(token),
        "warning": "Guarda este token ahora; no se volverá a mostrar.",
    }


@router.put("/api/scripts/automation-agents/{host_name}")
async def update_automation_agent(host_name: str, request: Request):
    """Actualiza metadatos básicos del agente."""
    host_name = _safe_agent_segment(host_name, "host_name")
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    updates = []
    params = []

    if "enabled" in payload:
        updates.append("enabled=?")
        params.append(1 if payload.get("enabled") else 0)
        if payload.get("enabled"):
            updates.append("revoked_at=NULL")

    if "notes" in payload:
        updates.append("notes=?")
        params.append(str(payload.get("notes") or "")[:1000])

    if not updates:
        return {"ok": True, "host_name": host_name, "updated": []}

    updates.append("updated_at=?")
    params.append(datetime.now(timezone.utc).isoformat())
    params.append(host_name)

    with db() as conn:
        cur = conn.execute(
            f"UPDATE automation_agents SET {', '.join(updates)} WHERE host_name=?",
            params,
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agente no encontrado")

    _automation_agent_audit(host_name, request, "agent_updated", True, payload)
    return {"ok": True, "host_name": host_name}


@router.post("/api/scripts/automation-agents/{host_name}/rotate")
def rotate_automation_agent_token(host_name: str, request: Request):
    """Rota el token del agente y devuelve el nuevo token una sola vez."""
    host_name = _safe_agent_segment(host_name, "host_name")
    token = _automation_agent_new_token()
    now = datetime.now(timezone.utc).isoformat()

    with db() as conn:
        cur = conn.execute("""
            UPDATE automation_agents
            SET token_hash=?, token_prefix=?, enabled=1, revoked_at=NULL, updated_at=?
            WHERE host_name=?
        """, (
            _automation_agent_token_hash(token),
            _automation_agent_token_prefix(token),
            now,
            host_name,
        ))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agente no encontrado")

    _automation_agent_audit(host_name, request, "agent_token_rotated", True, {"token_prefix": _automation_agent_token_prefix(token)})
    return {
        "ok": True,
        "host_name": host_name,
        "token": token,
        "token_prefix": _automation_agent_token_prefix(token),
        "warning": "Guarda este token ahora; no se volverá a mostrar.",
    }


@router.delete("/api/scripts/automation-agents/{host_name}")
def revoke_automation_agent(host_name: str, request: Request):
    """Revoca/deshabilita el agente sin borrar su histórico."""
    host_name = _safe_agent_segment(host_name, "host_name")
    now = datetime.now(timezone.utc).isoformat()

    with db() as conn:
        cur = conn.execute("""
            UPDATE automation_agents
            SET enabled=0, revoked_at=?, updated_at=?
            WHERE host_name=?
        """, (now, now, host_name))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Agente no encontrado")

    _automation_agent_audit(host_name, request, "agent_revoked", True, {})
    return {"ok": True, "host_name": host_name, "revoked_at": now}


@router.get("/api/scripts/automation-agents/events")
def list_automation_agent_events(limit: int = 100, include_status: bool = False):
    """Auditoría mínima de agentes API.

    Por defecto oculta recepciones OK repetitivas (`status_received`) para que
    la vista muestre cambios, errores y acciones relevantes.
    """
    limit = max(1, min(int(limit or 100), 500))
    where = ""
    params: list[object] = []
    if not include_status:
        where = "WHERE NOT (action = 'status_received' AND COALESCE(ok, 0) = 1)"
    params.append(limit)

    with db() as conn:
        rows = conn.execute(f"""
            SELECT id, at, host_name, ip, action, ok, detail
            FROM automation_agent_events
            {where}
            ORDER BY id DESC
            LIMIT ?
        """, params).fetchall()
    return {"ok": True, "events": [dict(r) for r in rows], "filtered_status_received": not include_status}


@router.post("/api/automation-agents/status")
async def automation_agent_status(request: Request):
    """
    Endpoint de recepción para agentes remotos.

    Seguridad:
    - ruta pública a nivel middleware para no depender de cookie;
    - protegida por token global legado o token específico por host;
    - no ejecuta comandos remotos;
    - solo escribe status/log bajo /data/agent_scripts_status/<host>/.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON inválido")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload debe ser un objeto JSON")

    item = _normalize_agent_status(payload)
    host_name = item["host_name"]
    script_name = item["script_name"]
    auth_ctx = _automation_agent_check_auth(request, host_name)

    base = _agent_status_dir() / host_name
    base.mkdir(parents=True, exist_ok=True)

    status_path = base / f"{script_name}.status.json"
    log_path = base / f"{script_name}.log"

    status_path.write_text(
        json.dumps(item, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8"
    )

    log_lines = payload.get("last_log_lines")
    if isinstance(log_lines, list):
        safe_lines = [str(x) for x in log_lines[-500:]]
        log_path.write_text("\n".join(safe_lines).rstrip() + "\n", encoding="utf-8")
    elif isinstance(payload.get("log"), str):
        log_path.write_text(str(payload.get("log"))[-200000:], encoding="utf-8")

    _automation_agent_mark_seen(host_name, request, script_name)
    _automation_agent_audit(
        host_name,
        request,
        "status_received",
        True,
        {
            "script_name": script_name,
            "auth_mode": auth_ctx.get("mode"),
            "status": item.get("status"),
            "status_path": str(status_path),
            "log_path": str(log_path) if log_path.exists() else "",
        },
    )

    return {
        "ok": True,
        "host_name": host_name,
        "script_name": script_name,
        "instance_key": f"{host_name}::{script_name}",
        "auth_mode": auth_ctx.get("mode"),
        "status_path": str(status_path),
        "log_path": str(log_path) if log_path.exists() else "",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints — scripts
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/scripts/status")
def get_scripts_status():
    items = _read_status_files()
    result = []
    for item in items:
        name = _script_name_from_file(item.get("_file", ""))
        item["name"] = name
        host_name, host_source = _status_host_meta(item)
        item["host_name"] = host_name
        item["host_source"] = host_source
        item["instance_key"] = f"{host_name}::{name}"

        # ── Normalizar campos reales del .status.json ──────────────────────
        # Los scripts usan: status, start_time, end_time, error, error_messages
        # El frontend espera: state, last_run, next_run, errors

        # state — exit_code es la fuente de verdad.
        # "error: true" en el JSON puede aparecer aunque el script completó OK
        # (p.ej. monitor_end_error con exit_code=0 cuando hay cambios detectados).
        if "state" not in item:
            raw_status = item.get("status", "")
            ec         = item.get("exit_code")
            if raw_status in ("running", "started"):
                item["state"] = "running"
            elif raw_status in ("missed", "stalled"):
                # Mantener estados específicos: la UI los representa de forma diferenciada.
                item["state"] = raw_status
            elif raw_status in ("failed", "error"):
                item["state"] = "error"
            elif ec is not None and ec != 0:
                item["state"] = "error"
            elif ec == 0:
                # exit_code 0 = OK aunque "error": true pueda contener avisos de log.
                item["state"] = "ok"
            elif raw_status == "completed":
                item["state"] = "ok"
            else:
                item["state"] = "unknown"

        # last_run — usar start_time si no hay last_run
        if not item.get("last_run") and item.get("start_time"):
            item["last_run"] = item["start_time"]

        # end_time — si falta pero tenemos start + duration, derivarlo.
        if not item.get("end_time") and item.get("start_time") and item.get("duration_seconds") is not None:
            try:
                start_dt = datetime.fromisoformat(str(item["start_time"]))
                end_dt = start_dt + timedelta(seconds=int(item["duration_seconds"]))
                item["end_time"] = end_dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

        # next_run — priorizar cron real (status_json / overrides) y
        # dejar expected_start solo como fallback legado.
        if not item.get("next_run"):
            resolved_next_run, cron_expr, cron_source = _resolve_next_run(item)
            if resolved_next_run:
                item["next_run"] = resolved_next_run
            if cron_expr:
                item["cron_expr"] = cron_expr
            if cron_source:
                item["cron_source"] = cron_source

        # errors — usar error_messages, pero filtrar avisos internos del monitor
        # que no son errores reales (aparecen aunque exit_code=0)
        _MONITOR_NOISE = (
            "[MONITOR] WARN:",
            "[MONITOR] ERROR: Ejecución completada con alertas",
        )
        raw_errors = item.get("error_messages", item.get("errors", []))
        real_errors = [
            e for e in raw_errors
            if not any(str(e).startswith(n) for n in _MONITOR_NOISE)
        ]
        item["errors"] = real_errors

        result.append(item)

    # ── Enriquecer con cfg_color, cfg_label y filtrar por monitored_scripts (S19) ──
    try:
        with db() as _conn:
            cfg_rows = _conn.execute(
                "SELECT script_name, label, color, active, "
                "COALESCE(cron_expr, '') AS cron_expr, COALESCE(cron_source, '') AS cron_source, "
                "COALESCE(host_name, '') AS host_name, COALESCE(host_source, '') AS host_source "
                "FROM monitored_scripts ORDER BY sort_order ASC, id ASC"
            ).fetchall()
        cfg_map = {
            r[0]: {
                "label": r[1],
                "color": r[2],
                "active": r[3],
                "cron_expr": r[4],
                "cron_source": r[5],
                "host_name": r[6],
                "host_source": r[7],
            }
            for r in cfg_rows
        }
        # Si hay scripts configurados, filtrar solo los activos y respetar su orden
        if cfg_map:
            active_names = [name for name, v in cfg_map.items() if v["active"]]
            active_order = {name: i for i, name in enumerate(active_names)}
            # Filtrar activos sin colapsar duplicados por host.
            result = [s for s in result if s.get("name") in active_order]
            result.sort(key=lambda s: (active_order.get(s.get("name"), 9999), str(s.get("host_name") or "")))
        # Añadir cfg_color y cfg_label a cada script del resultado
        for s in result:
            cfg = cfg_map.get(s["name"], {})
            s["cfg_color"] = cfg.get("color", "")
            s["cfg_label"] = cfg.get("label", "") or s["name"]
            s["cfg_cron_expr"] = cfg.get("cron_expr", "")
            s["cfg_cron_source"] = cfg.get("cron_source", "")
            # Si el host viene de subdirectorio o agente, preservarlo; representa un origen real.
            preserve_real_host = s.get("host_source") in ("status_dir_subdir", "agent_api")
            if not preserve_real_host and cfg.get("host_name"):
                s["host_name"] = cfg.get("host_name")
            if not preserve_real_host and cfg.get("host_source"):
                s["host_source"] = cfg.get("host_source")
            s["cfg_host_name"] = cfg.get("host_name", "")
            s["cfg_host_source"] = cfg.get("host_source", "")
            s["instance_key"] = f"{s.get('host_name') or 'Local'}::{s.get('name') or ''}"
    except Exception:
        # Degradación elegante: si falla la BD, los scripts se muestran sin color/etiqueta
        pass

    return result


@router.get("/api/scripts/log/{name}")
def get_script_log(name: str, lines: int = 100, host: str = Query("", max_length=120)):
    log_path = _find_log_file(name, host)
    if not log_path:
        raise HTTPException(status_code=404, detail=f"Log no encontrado para '{name}'")
    content = _tail_file(log_path, lines=min(lines, 500))
    return {"name": name, "host_name": host or "Local", "lines": content, "path": str(log_path)}


@router.get("/api/scripts/docs")
def list_docs():
    d = Path(SCRIPTS_PROMPTS_DIR)
    if not d.exists():
        return []
    return [
        {"name": f.name, "size": f.stat().st_size}
        for f in sorted(d.glob("*.md"))
        if f.name in PROCESS_DOCS
    ]


@router.get("/api/scripts/doc/{filename}")
def get_doc(filename: str):
    if filename not in ALLOWED_DOCS:
        raise HTTPException(status_code=403, detail="Documento no permitido")
    for base in [SCRIPTS_PROMPTS_DIR, SCRIPTS_AUDITDOC_DIR]:
        p = Path(base) / filename
        if p.exists():
            return {"name": filename, "content": p.read_text(encoding="utf-8")}
    raise HTTPException(status_code=404, detail="Documento no encontrado")


# ─────────────────────────────────────────────────────────────────────────────
# Endpoint — Estado IA (badge en UI)
# Mantiene nombre /ollama/status para compatibilidad con el frontend existente
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/scripts/ollama/status")
def ai_status(request: Request, test: bool = False):
    """
    Badge de estado IA (llamado cada 30s por el frontend).
    - test=false (por defecto): GET /v1beta/models/{model} — sin tokens, sin RPM
    - test=true  (solo desde Config → Probar conexión): hace generateContent real
    """
    caller_ip = request.client.host if request.client else "unknown"
    referer   = request.headers.get("referer", "")
    provider  = _ai_provider()

    if provider == "gemini":
        key   = _gemini_key()
        model = _gemini_model()
        if not key:
            return {"available": False, "provider": "gemini",
                    "model": model, "model_ready": False,
                    "error": "GEMINI_API_KEY no configurada"}
        try:
            if test:
                # Prueba real con generateContent (solo desde Config → Probar conexión)
                _gemini_log("status_test", "generateContent",
                            "calling", f"ip={caller_ip} ref={referer}")
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent?key={key}"
                )
                payload = json.dumps({
                    "contents": [{"parts": [{"text": "ok"}]}],
                    "generationConfig": {"maxOutputTokens": 1}
                }).encode("utf-8")
                req = urllib.request.Request(url, data=payload,
                                             headers={"Content-Type": "application/json"},
                                             method="POST")
            else:
                # Comprobación ligera: verifica modelo y key sin gastar RPM de generación
                _gemini_log("status_ping", "GET /models/{model}",
                            "calling", f"ip={caller_ip} ref={referer}")
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}?key={key}"
                )
                req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=8) as resp:
                resp.read()
            call_type = "status_test" if test else "status_ping"
            _gemini_log(call_type, "response", "ok", f"model={model}")
            return {"available": True, "provider": "gemini",
                    "model": model, "model_ready": True}
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            call_type = "status_test" if test else "status_ping"
            _gemini_log(call_type, "response", f"{e.code}", body[:80])
            return {"available": False, "provider": "gemini",
                    "model": model, "model_ready": False,
                    "error": f"HTTP Error {e.code}: {body[:200]}"}
        except Exception as e:
            _gemini_log("status_ping", "response", "exception", str(e))
            return {"available": False, "provider": "gemini",
                    "model": model, "model_ready": False, "error": str(e)}

    else:  # ollama
        url   = _ollama_url()
        model = _ollama_model()
        try:
            req = urllib.request.Request(f"{url}/api/tags", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                models = [m.get("name", "") for m in data.get("models", [])]
                model_ready = any(model in m for m in models)
                return {"available": True, "provider": "ollama",
                        "model": model, "model_ready": model_ready, "models": models}
        except Exception as e:
            return {"available": False, "provider": "ollama",
                    "model": model, "model_ready": False, "error": str(e)}


@router.get("/api/scripts/gemini/debug")
def gemini_debug():
    """Devuelve el historial de llamadas a Gemini para diagnóstico."""
    with _gemini_lock:
        calls = list(_gemini_calls)
    summary = {}
    for c in calls:
        k = c["type"]
        summary[k] = summary.get(k, 0) + 1
    return {
        "total_calls": len(calls),
        "summary":     summary,
        "calls":       calls,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Alertas por script — CRUD de reglas + motor de checks (Sesión 23)
# ─────────────────────────────────────────────────────────────────────────────

def _alert_host_name(host: str | None) -> str:
    host = str(host or "").strip()
    return host or "Local"


def _script_instance_key(host: str | None, script_name: str | None) -> str:
    return f"{_alert_host_name(host)}::{str(script_name or '').strip()}"


@router.get("/api/scripts/alert-rules")
def get_alert_rules():
    """Lista todas las reglas de alerta de scripts."""
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, COALESCE(host_name, 'Local') AS host_name, script_name,
                   alert_missed, max_hours, alert_error,
                   COALESCE(alert_running_long, 0) AS alert_running_long,
                   COALESCE(max_running_hours, 6) AS max_running_hours,
                   cooldown_min, last_fired, created_at
            FROM script_alert_rules
            ORDER BY host_name COLLATE NOCASE ASC, script_name COLLATE NOCASE ASC
            """
        ).fetchall()
    rules = []
    for r in rows:
        item = dict(r)
        item["instance_key"] = _script_instance_key(item.get("host_name"), item.get("script_name"))
        rules.append(item)
    return {"ok": True, "rules": rules}


@router.put("/api/scripts/alert-rules/{script_name}")
async def upsert_alert_rule(
    script_name: str,
    request: Request,
    host: str = Query("Local", max_length=120),
):
    """Crea o actualiza la regla de alerta para un script de un host."""
    payload      = await request.json()
    host_name    = _alert_host_name(payload.get("host_name") or host)
    alert_missed = 1 if payload.get("alert_missed", True) else 0
    max_hours    = float(payload.get("max_hours", 25))
    alert_error  = 1 if payload.get("alert_error", True) else 0
    alert_running_long = 1 if payload.get("alert_running_long", False) else 0
    max_running_hours  = float(payload.get("max_running_hours", 6))
    cooldown_min = int(payload.get("cooldown_min", 60))

    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM script_alert_rules WHERE host_name=? AND script_name=?",
            (host_name, script_name)
        ).fetchone()
        if existing:
            conn.execute("""
                UPDATE script_alert_rules
                SET alert_missed=?, max_hours=?, alert_error=?, alert_running_long=?, max_running_hours=?, cooldown_min=?
                WHERE host_name=? AND script_name=?
            """, (alert_missed, max_hours, alert_error, alert_running_long, max_running_hours, cooldown_min, host_name, script_name))
        else:
            conn.execute("""
                INSERT INTO script_alert_rules
                    (host_name, script_name, alert_missed, max_hours, alert_error, alert_running_long, max_running_hours, cooldown_min, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (host_name, script_name, alert_missed, max_hours, alert_error, alert_running_long, max_running_hours, cooldown_min,
                  datetime.now(timezone.utc).isoformat()))
    return {"ok": True, "host_name": host_name, "script_name": script_name, "instance_key": _script_instance_key(host_name, script_name)}


@router.delete("/api/scripts/alert-rules/{script_name}")
def delete_alert_rule(script_name: str, host: str = Query("Local", max_length=120)):
    """Elimina la regla de alerta de un script de un host."""
    host_name = _alert_host_name(host)
    with db() as conn:
        conn.execute(
            "DELETE FROM script_alert_rules WHERE host_name=? AND script_name=?",
            (host_name, script_name)
        )
    return {"ok": True}


def check_script_alerts() -> int:
    """
    Comprueba todos los scripts con reglas activas y dispara notificaciones
    Discord/push si se cumple alguna condición de alerta.
    Devuelve el número de alertas disparadas.
    Llamado por APScheduler cada 15 minutos.
    """
    from datetime import datetime, timezone, timedelta

    fired = 0
    status_items = get_scripts_status()
    statuses = {
        s.get("instance_key") or _script_instance_key(s.get("host_name"), s.get("name")): s
        for s in status_items
    }
    statuses_by_name = {s["name"]: s for s in status_items}

    with db() as conn:
        rules = conn.execute("SELECT * FROM script_alert_rules").fetchall()

    for rule in rules:
        name         = rule["script_name"]
        host_name    = _alert_host_name(rule["host_name"] if "host_name" in rule.keys() else "Local")
        alert_missed = bool(rule["alert_missed"])
        max_hours    = float(rule["max_hours"])
        alert_error  = bool(rule["alert_error"])
        alert_running_long = bool(rule["alert_running_long"]) if "alert_running_long" in rule.keys() else False
        max_running_hours  = float(rule["max_running_hours"]) if "max_running_hours" in rule.keys() else 6.0
        cooldown_min = int(rule["cooldown_min"])
        last_fired   = rule["last_fired"]

        # Cooldown — no spamear
        if last_fired:
            try:
                lf = datetime.fromisoformat(last_fired)
                if lf.tzinfo is None:
                    lf = lf.replace(tzinfo=timezone.utc)
                if (datetime.now(timezone.utc) - lf).total_seconds() < cooldown_min * 60:
                    continue
            except Exception:
                pass

        instance_key = _script_instance_key(host_name, name)
        s = statuses.get(instance_key)
        if not s and host_name == "Local":
            # Compatibilidad con datos previos sin instance_key.
            s = statuses_by_name.get(name)
        if not s:
            continue  # script sin status.json todavía

        msgs = []

        # ── Condición 1: sin ejecutarse hace más de max_hours ─────────────────
        if alert_missed and max_hours > 0:
            last_run_str = s.get("last_run") or s.get("start_time")
            if last_run_str:
                try:
                    last_run = datetime.fromisoformat(last_run_str)
                    if last_run.tzinfo is None:
                        last_run = last_run.replace(tzinfo=timezone.utc)
                    hours_ago = (datetime.now(timezone.utc) - last_run).total_seconds() / 3600
                    if hours_ago >= max_hours:
                        label = s.get("cfg_label") or name
                        host_label = s.get("host_name") or host_name
                        msgs.append(
                            f"⏰ **Script sin ejecutarse**: `{label}` en `{host_label}`\n"
                            f"Última ejecución hace **{hours_ago:.1f}h** "
                            f"(límite configurado: {max_hours}h)"
                        )
                except Exception:
                    pass
            else:
                # Nunca se ha ejecutado
                label = s.get("cfg_label") or name
                host_label = s.get("host_name") or host_name
                msgs.append(
                    f"⏰ **Script nunca ejecutado**: `{label}` en `{host_label}`\n"
                    f"No existe registro de ejecución y el límite es {max_hours}h."
                )

        # ── Condición 2b: ejecución demasiado larga ───────────────────────────
        if alert_running_long and max_running_hours > 0 and s.get("state") == "running":
            started_str = s.get("start_time") or s.get("last_run")
            if started_str:
                try:
                    started = datetime.fromisoformat(str(started_str).replace(" ", "T"))
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=timezone.utc)
                    running_hours = (datetime.now(timezone.utc) - started).total_seconds() / 3600
                    if running_hours >= max_running_hours:
                        label = s.get("cfg_label") or name
                        host_label = s.get("host_name") or host_name
                        step = s.get("step_label") or ""
                        detail = f"\nPaso actual: {step}" if step else ""
                        msgs.append(
                            f"⏳ **Script en ejecución demasiado tiempo**: `{label}` en `{host_label}`\n"
                            f"Lleva **{running_hours:.1f}h** ejecutándose "
                            f"(límite configurado: {max_running_hours}h){detail}"
                        )
                except Exception:
                    pass

        # ── Condición 2: última ejecución terminó con error ───────────────────
        if alert_error and s.get("state") in ("error", "missed", "stalled"):
            label     = s.get("cfg_label") or name
            host_label = s.get("host_name") or host_name
            state     = s.get("state")
            ec        = s.get("exit_code", "?")
            err_list  = s.get("errors", []) or s.get("error_messages", [])
            err_short = err_list[0][:120] if err_list else "sin detalle"

            title = {
                "missed": "⏰ **Script no arrancó**",
                "stalled": "⏸️ **Script bloqueado**",
            }.get(state, "❌ **Script con error**")

            if state == "error":
                msgs.append(
                    f"{title}: `{label}` en `{host_label}`\n"
                    f"Exit code: `{ec}` — {err_short}"
                )
            else:
                msgs.append(
                    f"{title}: `{label}` en `{host_label}`\n"
                    f"Estado: `{state}` — {err_short}"
                )

        if not msgs:
            continue

        # ── Disparar notificaciones ───────────────────────────────────────────
        full_msg = "\n\n".join(msgs)
        header   = f"🔔 **Alerta de proceso — Auditor IPs**\n"
        _send_script_alert(header + full_msg)
        fired += 1

        # Actualizar last_fired
        with db() as conn:
            conn.execute(
                "UPDATE script_alert_rules SET last_fired=? WHERE host_name=? AND script_name=?",
                (datetime.now(timezone.utc).isoformat(), host_name, name)
            )

    if fired:
        print(f"[script_alerts] {fired} alerta(s) disparada(s)", flush=True)
    return fired


def _send_script_alert(msg: str) -> None:
    """Envía la alerta por Discord, push y/o email según la configuración activa."""
    from config import cfg

    # Discord alertas
    if str(cfg("notify_script_alerts", "1") or "1") == "1":
        try:
            from routers.scans import discord_notify
            ok, err = discord_notify(msg, channel="alerts")
            if not ok and err:
                print(f"[script_alerts] Discord error: {err}", flush=True)
        except Exception as e:
            print(f"[script_alerts] Discord error: {e}", flush=True)

    # Push (web push PWA): conserva su configuración propia.
    try:
        from routers.scans import send_push_notification
        send_push_notification("⚙️ Alerta de proceso", msg[:200])
    except Exception as e:
        print(f"[script_alerts] Push error: {e}", flush=True)

    # Email
    if str(cfg("notify_email", "0") or "0") == "1" and str(cfg("email_script_alerts", "1") or "1") == "1":
        try:
            from routers.config_api import send_email
            ok, err = send_email("⚙️ Alerta de proceso — Auditor IPs", msg)
            if not ok and err:
                print(f"[script_alerts] Email error: {err}", flush=True)
        except Exception as e:
            print(f"[script_alerts] Email error: {e}", flush=True)
