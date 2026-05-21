"""
routers/alerts.py — Auditor IPs
CRUD de alertas programables y test manual.
"""

from typing import Any, Dict

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from config import cfg
from database import db
from utils import utc_now_iso

router = APIRouter()

# discord_notify se importa localmente desde scans para evitar ciclos;
# aquí lo re-importamos desde el módulo de scans cuando lo necesitemos
# a través de una función auxiliar privada.
def _discord_notify(msg: str):
    """Wrapper local para notificaciones Discord de alertas."""
    from routers.scans import discord_notify
    return discord_notify(msg, channel="alerts")


@router.get("/api/alerts")
def api_alerts_list():
    """Lista todas las alertas con nombre del tipo si filter_mode='type_id'."""
    with db() as conn:
        rows = conn.execute("""
            SELECT a.id, a.name, a.trigger_type, a.filter_mode, a.filter_value,
                   a.action, a.cooldown_minutes, a.enabled, a.last_fired, a.created_at,
                   COALESCE(a.min_down_minutes, 0) AS min_down_minutes,
                   CASE WHEN a.filter_mode='type_id' THEN t.name ELSE NULL END AS type_name
            FROM alerts a
            LEFT JOIN host_types t ON t.id = CAST(a.filter_value AS INTEGER)
            ORDER BY a.id
        """).fetchall()
    return {"ok": True, "alerts": [dict(r) for r in rows]}


@router.post("/api/alerts")
def api_alert_create(payload: Dict[str, Any] = Body(...)):
    name     = (payload.get("name") or "").strip()
    ttype    = (payload.get("trigger_type") or "").strip()
    fmode    = (payload.get("filter_mode") or "all").strip()
    fvalue   = (payload.get("filter_value") or "").strip() or None
    if fmode == "mac" and fvalue:
        fvalue = fvalue.upper().replace("-", ":")
    action   = (payload.get("action") or "discord").strip()
    cooldown = int(payload.get("cooldown_minutes") or 0)
    min_down = int(payload.get("min_down_minutes") or 0)
    enabled  = 1 if payload.get("enabled", True) else 0

    if not name:
        return JSONResponse({"ok": False, "error": "Nombre vacío"}, status_code=400)
    valid_types = {"new_host", "offline", "online", "status_change", "ip_change", "mac_change", "offline_for"}
    if ttype not in valid_types:
        return JSONResponse({"ok": False, "error": f"trigger_type inválido: {ttype}"}, status_code=400)
    if fmode not in {"all", "ip", "mac", "type_id"}:
        return JSONResponse({"ok": False, "error": f"filter_mode inválido: {fmode}"}, status_code=400)
    if fmode in {"ip", "mac", "type_id"} and not fvalue:
        return JSONResponse({"ok": False, "error": "filter_value requerido"}, status_code=400)

    with db() as conn:
        conn.execute("""
            INSERT INTO alerts
                (name, trigger_type, filter_mode, filter_value, action,
                 cooldown_minutes, min_down_minutes, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (name, ttype, fmode, fvalue, action, cooldown, min_down, enabled, utc_now_iso()))
    return {"ok": True}


@router.put("/api/alerts/{alert_id}")
def api_alert_update(alert_id: int, payload: Dict[str, Any] = Body(...)):
    name     = (payload.get("name") or "").strip()
    ttype    = (payload.get("trigger_type") or "").strip()
    fmode    = (payload.get("filter_mode") or "all").strip()
    fvalue   = (payload.get("filter_value") or "").strip() or None
    if fmode == "mac" and fvalue:
        fvalue = fvalue.upper().replace("-", ":")
    action   = (payload.get("action") or "discord").strip()
    cooldown = int(payload.get("cooldown_minutes") or 0)
    min_down = int(payload.get("min_down_minutes") or 0)
    enabled  = 1 if payload.get("enabled", True) else 0

    with db() as conn:
        row = conn.execute("SELECT id FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Alerta no encontrada"}, status_code=404)
        valid_types = {"new_host", "offline", "online", "status_change", "ip_change", "mac_change", "offline_for"}
        if ttype not in valid_types:
            return JSONResponse({"ok": False, "error": f"trigger_type inválido: {ttype}"}, status_code=400)
        if fmode not in {"all", "ip", "mac", "type_id"}:
            return JSONResponse({"ok": False, "error": f"filter_mode inválido: {fmode}"}, status_code=400)
        if fmode in {"ip", "mac", "type_id"} and not fvalue:
            return JSONResponse({"ok": False, "error": "filter_value requerido"}, status_code=400)
        conn.execute("""
            UPDATE alerts
            SET name=?, trigger_type=?, filter_mode=?, filter_value=?,
                action=?, cooldown_minutes=?, min_down_minutes=?, enabled=?
            WHERE id=?
        """, (name, ttype, fmode, fvalue, action, cooldown, min_down, enabled, alert_id))
    return {"ok": True}


@router.delete("/api/alerts/{alert_id}")
def api_alert_delete(alert_id: int):
    with db() as conn:
        row = conn.execute("SELECT id FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Alerta no encontrada"}, status_code=404)
        conn.execute("DELETE FROM alerts WHERE id=?", (alert_id,))
    return {"ok": True}


@router.post("/api/alerts/{alert_id}/toggle")
def api_alert_toggle(alert_id: int):
    with db() as conn:
        row = conn.execute("SELECT id, enabled FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Alerta no encontrada"}, status_code=404)
        new_state = 0 if row["enabled"] else 1
        conn.execute("UPDATE alerts SET enabled=? WHERE id=?", (new_state, alert_id))
    return {"ok": True, "enabled": bool(new_state)}


@router.post("/api/alerts/{alert_id}/test")
def api_alert_test(alert_id: int):
    """Dispara la alerta manualmente para verificar que Discord funciona."""
    with db() as conn:
        row = conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not row:
            return JSONResponse({"ok": False, "error": "Alerta no encontrada"}, status_code=404)
        msg = (f"🧪 **Test alerta: {row['name']}**\n"
               "Esta es una prueba manual del sistema de alertas de Auditor IPs.")
        from routers.scans import discord_webhook_for_channel
        if discord_webhook_for_channel("alerts"):
            ok, err = _discord_notify(msg)
            return {"ok": ok, "message": msg, "discord_error": err}
        return {"ok": True, "message": msg, "note": "Discord de alertas no configurado"}
