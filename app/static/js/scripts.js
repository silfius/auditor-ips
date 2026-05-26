/**
 * scripts.js — Pestaña Procesos Programados
 * Sesión 12: vista fichas/tabla, log en vivo, docs integradas
 * Sesión 13: botón "Analizar con IA" con Ollama
 * Sesión 14: proveedor IA desde Config · fix campos reales .status.json · duración legible
 * Sesión 19: prefetch cache — muestra datos inmediatamente si ya fueron precargados
 */

$(function () {

  // ─────────────────────────────────────────────────
  // Estado
  // ─────────────────────────────────────────────────
  let spData         = [];
  let spViewMode     = localStorage.getItem('auditor-scripts-view') || 'table';
  let spHostFilter   = localStorage.getItem('auditor-scripts-host-filter') || 'all';
  let spStateFilter  = localStorage.getItem('auditor-scripts-state-filter') || 'all';
  let spSortMode     = localStorage.getItem('auditor-scripts-sort-mode') || 'priority';
  let spRefreshTimer = null;
  let spLogTimer     = null;
  let ollamaReady    = null;

  // ─────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────

  /** Convierte segundos en texto legible: 13840 → "3h 50m" */
  function humanDuration(secs) {
    if (secs == null || secs === '' || isNaN(secs)) return '—';
    secs = parseInt(secs, 10);
    if (secs < 60)   return secs + 's';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    let r = h + 'h';
    if (m) r += ' ' + m + 'm';
    if (s && h < 10) r += ' ' + s + 's';
    return r;
  }

  /** Formatea fecha/hora usando los formateadores globales configurables. */
  function fmtDate(val) {
    if (!val || val === '—') return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(val);
      return formatted && formatted !== '—' ? formatted : val;
    }
    return val;
  }

  function fmtRefreshTime() {
    const nowIso = new Date().toISOString();
    if (typeof window.fmtTime === 'function') {
      const formatted = window.fmtTime(nowIso);
      return formatted && formatted !== '—' ? formatted : '';
    }
    return '';
  }

  function spScriptHost(s) {
    return String(s?.host_name || s?.cfg_host_name || 'Local');
  }

  function spScriptKey(s) {
    return String(s?.instance_key || `${spScriptHost(s)}::${s?.name || ''}`);
  }

  function spFindScriptByKey(key) {
    return spData.find(s => spScriptKey(s) === key) || spData.find(s => s.name === key) || null;
  }

  function spStateGroup(s) {
    const state = String(s?.state || 'unknown');
    if (state === 'missed' || state === 'stalled') return 'missed';
    if (state === 'controlled_stop') return 'controlled';
    if (['ok', 'running', 'error'].includes(state)) return state;
    return 'unknown';
  }

  function spFilteredData() {
    return (spData || []).filter(s => {
      const hostOk = !spHostFilter || spHostFilter === 'all' || spScriptHost(s) === spHostFilter;
      const stateOk = !spStateFilter || spStateFilter === 'all' || spStateGroup(s) === spStateFilter;
      return hostOk && stateOk;
    });
  }

  function spDateTs(val) {
    if (!val) return 0;
    const t = Date.parse(String(val).replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }

  function spPriorityScore(s) {
    const state = String(s?.state || 'unknown');
    if (state === 'error') return 500;
    if (state === 'missed' || state === 'stalled') return 400;
    if (state === 'running') return 300;
    if (state === 'controlled_stop') return 250;
    if (state === 'unknown') return 200;
    return 100;
  }

  function spSortedData(data) {
    const arr = [...(data || [])];
    const collator = new Intl.Collator(navigator.language || 'es', { numeric: true, sensitivity: 'base' });
    const label = s => String(s?.cfg_label || s?.name || '');
    const host = s => spScriptHost(s);
    const lastTs = s => spDateTs(s?.start_time || s?.last_run);
    const nextTs = s => spDateTs(s?.next_run);

    arr.sort((a, b) => {
      if (spSortMode === 'name') {
        return collator.compare(label(a), label(b)) || collator.compare(host(a), host(b));
      }
      if (spSortMode === 'host') {
        return collator.compare(host(a), host(b)) || collator.compare(label(a), label(b));
      }
      if (spSortMode === 'last_desc') {
        return (lastTs(b) - lastTs(a)) || collator.compare(label(a), label(b));
      }
      if (spSortMode === 'next_asc') {
        const an = nextTs(a) || Number.MAX_SAFE_INTEGER;
        const bn = nextTs(b) || Number.MAX_SAFE_INTEGER;
        return (an - bn) || collator.compare(label(a), label(b));
      }
      if (spSortMode === 'duration_desc') {
        return ((Number(b?.duration_seconds) || 0) - (Number(a?.duration_seconds) || 0)) || collator.compare(label(a), label(b));
      }
      if (spSortMode === 'progress_desc') {
        return ((Number(b?.progress_pct) || 0) - (Number(a?.progress_pct) || 0)) || collator.compare(label(a), label(b));
      }

      // Prioridad por defecto: incidencias → ejecución → desconocidos → OK;
      // dentro de cada grupo, lo más reciente primero.
      return (spPriorityScore(b) - spPriorityScore(a))
        || (lastTs(b) - lastTs(a))
        || collator.compare(host(a), host(b))
        || collator.compare(label(a), label(b));
    });

    return arr;
  }

  function spDisplayData() {
    return spSortedData(spFilteredData());
  }

  function spRenderActiveFilters() {
    const parts = [];
    if (spHostFilter && spHostFilter !== 'all') parts.push(`Host: ${spHostFilter}`);

    const stateLabels = {
      ok: 'OK',
      running: 'En ejecución',
      error: 'Con errores',
      missed: 'Missed / Stalled',
      unknown: 'Desconocido',
      controlled: 'Controladas',
    };
    if (spStateFilter && spStateFilter !== 'all') {
      parts.push(`Estado: ${stateLabels[spStateFilter] || spStateFilter}`);
    }

    const sortLabels = {
      priority: 'Prioridad',
      name: 'Nombre',
      host: 'Host',
      last_desc: 'Última ejecución',
      next_asc: 'Próxima ejecución',
      duration_desc: 'Duración',
      progress_desc: 'Progreso',
    };
    if (spSortMode) {
      parts.push(`Orden: ${sortLabels[spSortMode] || spSortMode}`);
    }

    $('#sp-active-filters').text(parts.length ? parts.join(' · ') : 'Sin filtros activos');
    $('#sp-btn-clear-filters').prop('disabled', !parts.length);
  }

  let spExecutionHistory = [];

  function spHistoryEventLabel(type) {
    const map = {
      controlled_incident_marked: 'Incidencia controlada',
      controlled_incident_cleared: 'Vigilancia reactivada',
      alert_fired: 'Alerta enviada',
    };
    return map[type] || type || 'Evento';
  }

  function spControlTypeLabel(type) {
    const map = {
      controlled_stop: 'Parada controlada',
      controlled_error: 'Error controlado',
      controlled_stalled: 'Stalled controlado',
      controlled_missed: 'Missed controlado',
      false_positive: 'Falso positivo',
      maintenance: 'Mantenimiento',
      other: 'Otro',
      controlled_incident: 'Incidencia controlada',
    };
    return map[type] || type || '—';
  }

  function spHistoryStateBadge(state, rawState) {
    const s = String(state || rawState || '').toLowerCase();
    return spStateBadge(s || 'unknown');
  }

  function spHistoryFilteredSorted() {
    const q = String($('#sp-history-search').val() || '').trim().toLowerCase();
    const type = String($('#sp-history-type').val() || '').trim();
    const sort = String($('#sp-history-sort').val() || 'at_desc');

    let items = [...(spExecutionHistory || [])];
    if (type) items = items.filter(x => String(x.event_type || '') === type);
    if (q) {
      items = items.filter(x => {
        const hay = [
          x.host_name, x.script_name, x.event_type, x.state, x.raw_state,
          x.exit_code, x.reason, x.observed_start_time, x.log_source
        ].map(v => String(v || '').toLowerCase()).join(' ');
        return hay.includes(q);
      });
    }

    const collator = new Intl.Collator(navigator.language || 'es', { numeric: true, sensitivity: 'base' });
    const ts = x => Date.parse(String(x.at || '').replace(' ', 'T')) || 0;
    items.sort((a, b) => {
      if (sort === 'at_asc') return ts(a) - ts(b);
      if (sort === 'script_asc') return collator.compare(String(a.script_name || ''), String(b.script_name || ''))
        || collator.compare(String(a.host_name || ''), String(b.host_name || ''));
      if (sort === 'state_desc') return collator.compare(String(b.state || b.raw_state || ''), String(a.state || a.raw_state || ''))
        || (ts(b) - ts(a));
      if (sort === 'type_asc') return collator.compare(spHistoryEventLabel(a.event_type), spHistoryEventLabel(b.event_type))
        || (ts(b) - ts(a));
      return ts(b) - ts(a);
    });
    return items;
  }

  function spRenderExecutionHistory() {
    const wrap = document.getElementById('sp-history-table-wrap');
    if (!wrap) return;

    const items = spHistoryFilteredSorted();
    if (!items.length) {
      wrap.innerHTML = '<div class="small text-muted">Sin eventos de historial con los filtros actuales.</div>';
      return;
    }

    wrap.innerHTML = `
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Host</th>
            <th>Script</th>
            <th>Evento</th>
            <th>Estado</th>
            <th>Motivo / detalle</th>
            <th class="text-end">Log</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(ev => {
            const hasLog = ev.has_log_excerpt || ev.log_excerpt;
            const typeText = ev.control_type ? spControlTypeLabel(ev.control_type) : '';
            return `
              <tr>
                <td class="small text-nowrap">${esc(fmtDate(ev.at))}</td>
                <td class="small">${esc(ev.host_name || 'Local')}</td>
                <td class="small font-monospace">${esc(ev.script_name || '—')}</td>
                <td class="small">${esc(spHistoryEventLabel(ev.event_type))}</td>
                <td>${spHistoryStateBadge(ev.state, ev.raw_state)}</td>
                <td class="small" style="min-width:220px">
                  ${typeText ? `<span class="badge bg-info text-dark me-1">${esc(typeText)}</span>` : ''}
                  ${esc(ev.reason || '—')}
                  ${ev.log_excerpt_truncated ? '<span class="badge bg-warning text-dark ms-1">log recortado</span>' : ''}
                </td>
                <td class="small text-end text-nowrap">
                  ${hasLog ? `<button class="btn btn-sm btn-outline-secondary sp-history-log-btn" data-event-id="${esc(ev.id)}">
                    <i class="bi bi-file-text me-1"></i>Ver log
                  </button>` : '—'}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  async function spLoadExecutionHistory(includeLog) {
    const wrap = document.getElementById('sp-history-table-wrap');
    if (wrap) wrap.innerHTML = '<div class="small text-muted">Cargando historial…</div>';
    try {
      const url = `/api/scripts/execution-events?limit=200&include_log=${includeLog ? 'true' : 'false'}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      spExecutionHistory = Array.isArray(data.items) ? data.items : [];
      spRenderExecutionHistory();
    } catch (e) {
      if (wrap) wrap.innerHTML = `<div class="alert alert-warning py-2 small mb-0">No se pudo cargar el historial: ${esc(e.message || e)}</div>`;
    }
  }

  function spRenderCurrentView() {
    const data = spDisplayData();
    spRenderActiveFilters();
    spRenderKPIs(data);
    spViewMode === 'cards' ? spRenderCards(data) : spRenderTable(data);
    setTimeout(function () {
      try {
        document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
          bootstrap.Tooltip.getOrCreateInstance(el);
        });
      } catch (_) {}
    }, 0);
  }

  function spRenderHostFilter() {
    const sel = document.getElementById('sp-host-filter');
    const stateSel = document.getElementById('sp-state-filter');
    const sortSel = document.getElementById('sp-sort-mode');
    if (stateSel) stateSel.value = spStateFilter || 'all';
    if (sortSel) sortSel.value = spSortMode || 'priority';
    spRenderActiveFilters();
    if (!sel) return;

    const hosts = [...new Set(spData.map(spScriptHost).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, navigator.language || 'es', { numeric: true, sensitivity: 'base' }));

    const current = hosts.includes(spHostFilter) ? spHostFilter : 'all';
    if (current !== spHostFilter) {
      spHostFilter = current;
      localStorage.setItem('auditor-scripts-host-filter', spHostFilter);
    }

    sel.innerHTML = '<option value="all">Todos los hosts</option>' + hosts.map(h =>
      `<option value="${esc(h)}"${h === current ? ' selected' : ''}>${esc(h)}</option>`
    ).join('');
  }

  function spStateBadge(state) {
    const map = {
      ok:      '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>OK</span>',
      running: '<span class="badge bg-primary"><i class="bi bi-arrow-repeat sp-spin me-1"></i>Ejecutando</span>',
      error:   '<span class="badge bg-danger"><i class="bi bi-exclamation-triangle me-1"></i>Error</span>',
      stalled: '<span class="badge bg-warning text-dark"><i class="bi bi-clock-history me-1"></i>Stalled</span>',
      missed:  '<span class="badge bg-warning text-dark"><i class="bi bi-clock-history me-1"></i>Missed</span>',
      controlled_stop: '<span class="badge bg-info text-dark"><i class="bi bi-shield-check me-1"></i>Incidencia controlada</span>',
    };
    return map[state] || '<span class="badge bg-secondary">Desconocido</span>';
  }

  function spWatchdogHint(s, compact) {
    const enabled = s?.watchdog_enabled === true || s?.watchdog_enabled === 1 || s?.watchdog_enabled === '1';
    const wd = String(s?.watchdog_state || '').trim();
    const mode = String(s?.watchdog_mode || '').trim();
    const reason = String(s?.watchdog_reason || '').trim();
    const expected = String(s?.watchdog_expected_at || '').trim();

    if (!enabled && !wd) return '';

    const baseTitle = 'Watchdog interno: Auditor IPs revisa si el script arranca cuando toca y si queda bloqueado sin actualizar heartbeat. Ahora está en modo observación, por lo que no modifica el estado real ni dispara alertas por sí solo.';

    if (!wd) {
      return `<span class="badge bg-info text-dark px-2 py-1"
                    title="${esc(baseTitle)}"
                    data-bs-toggle="tooltip"
                    data-bs-placement="top">
        <i class="bi bi-eye me-1"></i>${compact ? 'Watchdog: obs.' : 'Watchdog observado'}
      </span>`;
    }

    const detail = [
      baseTitle,
      `Observación detectada: ${wd}`,
      reason,
      expected ? `Última ejecución esperada: ${expected}` : '',
    ].filter(Boolean).join(' · ');

    const cls = wd === 'stalled' || wd === 'missed' ? 'bg-warning text-dark' : 'bg-info text-dark';
    const label = compact ? `Watchdog: ${wd}` : `Watchdog observa: ${wd}`;

    return `<span class="badge ${cls} px-2 py-1"
                  title="${esc(detail)}"
                  data-bs-toggle="tooltip"
                  data-bs-placement="top">
      <i class="bi bi-eye me-1"></i>${esc(label)}
    </span>`;
  }

  function spWatchdogDetail(s) {
    const wd = String(s?.watchdog_state || '').trim();
    if (!wd) return '';

    const reason = String(s?.watchdog_reason || '').trim();
    const expected = String(s?.watchdog_expected_at || '').trim();
    const mode = String(s?.watchdog_mode || '').trim();
    const modeText = mode === 'observe'
      ? 'Modo observación: no modifica el estado ni dispara alertas.'
      : 'Modo activo: puede modificar el estado calculado.';

    return `<div class="alert alert-warning py-1 px-2 small mb-0 mt-1">
      <div><strong>Watchdog interno:</strong> ${esc(wd)} · ${esc(modeText)}</div>
      ${reason ? `<div>${esc(reason)}</div>` : ''}
      ${expected ? `<div>Última ejecución esperada: <strong>${esc(fmtDate(expected))}</strong></div>` : ''}
    </div>`;
  }


  function spScheduleValue(v) {
    const raw = String(v ?? '').trim();
    return raw || '—';
  }

  function spScheduleRow(label, value, opts = {}) {
    const cls = opts.mono ? 'font-monospace' : '';
    const valueCls = opts.html ? '' : 'text-info fw-semibold';
    const html = opts.html ? value : esc(spScheduleValue(value));
    return `<div class="col-12 col-md-6 col-xl-4">
      <div class="border rounded p-2 h-100">
        <div class="small text-muted mb-1">${esc(label)}</div>
        <div class="small ${cls} ${valueCls}" style="word-break:break-word">${html}</div>
      </div>
    </div>`;
  }

  function spScheduleBtn(script, tableMode) {
    const name = String(script?.name || '');
    const host = spScriptHost(script || {});
    const key = spScriptKey(script || {});
    const title = 'Ver programación completa';
    if (tableMode) {
      return `<button class="btn btn-sm btn-outline-info sp-btn-schedule"
                data-name="${esc(name)}" data-host="${esc(host)}" data-key="${esc(key)}"
                title="${esc(title)}">
                <i class="bi bi-calendar-week"></i>
              </button>`;
    }
    return `<button class="btn btn-sm btn-outline-info sp-btn-schedule"
              data-name="${esc(name)}" data-host="${esc(host)}" data-key="${esc(key)}"
              title="${esc(title)}">
              <i class="bi bi-calendar-week me-1"></i>Programación
            </button>`;
  }

  function spScheduleAlertRulesHtml(rules, script) {
    const name = String(script?.name || '');
    const host = spScriptHost(script || {});
    const matches = (rules || []).filter(r => {
      const rn = String(r?.script_name || '');
      const rh = String(r?.host_name || 'Local');
      return rn === name && (rh === host || rh === 'Local' || !rh);
    });

    if (!matches.length) {
      return '<div class="small text-muted">No hay regla de alerta específica encontrada para esta automatización.</div>';
    }

    return `<div class="table-responsive">
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th>Host</th>
            <th>Sin ejecutar</th>
            <th>Error</th>
            <th>Ejecución larga</th>
            <th>Cooldown</th>
            <th>Último aviso</th>
          </tr>
        </thead>
        <tbody>
          ${matches.map(r => `
            <tr>
              <td><code>${esc(r.host_name || 'Local')}</code></td>
              <td>${Number(r.alert_missed || 0) ? `Sí · ${esc(r.max_hours || '—')}h` : 'No'}</td>
              <td>${Number(r.alert_error || 0) ? 'Sí' : 'No'}</td>
              <td>${Number(r.alert_running_long || 0) ? `Sí · ${esc(r.max_running_hours || '—')}h` : 'No'}</td>
              <td>${esc(r.cooldown_min || '—')} min</td>
              <td>${esc(fmtDate(r.last_fired) || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }

  async function spLoadScheduleAlertRules(script) {
    const wrap = document.getElementById('sp-schedule-alerts');
    if (!wrap) return;

    wrap.innerHTML = '<div class="small text-muted">Cargando reglas de alerta…</div>';
    try {
      const res = await fetch('/api/scripts/alert-rules', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
      const rules = Array.isArray(data.rules) ? data.rules : (Array.isArray(data) ? data : []);
      wrap.innerHTML = spScheduleAlertRulesHtml(rules, script);
    } catch (e) {
      wrap.innerHTML = `<div class="small text-warning">No se pudieron cargar las reglas de alerta: ${esc(e.message || e)}</div>`;
    }
  }

  function spRenderScheduleModal(script) {
    const host = spScriptHost(script);
    const label = script?.cfg_label || script?.name || 'Automatización';
    const cronExpr = script?.cron_expr || script?.cfg_cron_expr || '';
    const cronSource = script?.cron_source || script?.cfg_cron_source || '';
    const watchdogEnabled = script?.watchdog_enabled === true || script?.watchdog_enabled === 1 || script?.watchdog_enabled === '1';

    $('#sp-schedule-modal-title').text(label);
    $('#sp-schedule-modal-subtitle').text(`${host} / ${script?.name || ''}`);
    $('#sp-schedule-config-btn').data('script-name', script?.name || '').data('script-host', host);

    const watchdogDetail = [
      watchdogEnabled ? 'Habilitado' : 'No habilitado',
      script?.watchdog_mode ? `modo ${script.watchdog_mode}` : '',
      script?.watchdog_state ? `observa ${script.watchdog_state}` : '',
      script?.watchdog_reason || '',
    ].filter(Boolean).join(' · ');

    const rawStatus = script?.raw_state ? `Estado raw: ${script.raw_state}` : '';

    $('#sp-schedule-modal-body').html(`
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle me-1"></i>
        Este modal resume la programación y configuración conocida por Auditor IPs. No ejecuta scripts ni modifica crontabs reales.
      </div>

      <div class="mb-3">
        <div class="fw-semibold mb-2"><i class="bi bi-terminal me-1"></i>Identificación</div>
        <div class="row g-2">
          ${spScheduleRow('Nombre técnico', script?.name, { mono: true })}
          ${spScheduleRow('Etiqueta visible', script?.cfg_label || script?.name)}
          ${spScheduleRow('Host', host, { mono: true })}
          ${spScheduleRow('Estado actual', `${spStateBadge(script?.state || 'unknown')} ${rawStatus ? `<span class="small text-muted ms-2">${esc(rawStatus)}</span>` : ''}`, { html: true })}
          ${spScheduleRow('Origen host', script?.host_source || script?.cfg_host_source || '—')}
          ${spScheduleRow('Clave de instancia', spScriptKey(script), { mono: true })}
        </div>
      </div>

      <div class="mb-3">
        <div class="fw-semibold mb-2"><i class="bi bi-calendar-week me-1"></i>Programación</div>
        <div class="row g-2">
          ${spScheduleRow('Cron efectivo', cronExpr || '—', { mono: true })}
          ${spScheduleRow('Origen del cron', cronSource || '—')}
          ${spScheduleRow('Próxima ejecución', fmtDate(script?.next_run))}
          ${spScheduleRow('Última ejecución / inicio', fmtDate(script?.start_time || script?.last_run))}
          ${spScheduleRow('Fin', fmtDate(script?.end_time))}
          ${spScheduleRow('Duración', humanDuration(script?.duration_seconds))}
        </div>
      </div>

      <div class="mb-3">
        <div class="fw-semibold mb-2"><i class="bi bi-eye me-1"></i>Watchdog interno</div>
        <div class="row g-2">
          ${spScheduleRow('Estado watchdog', watchdogDetail || '—')}
          ${spScheduleRow('Ejecución esperada incumplida', script?.watchdog_expected_at ? fmtDate(script.watchdog_expected_at) : '—')}
          ${spScheduleRow('Margen missed', script?.watchdog_grace_minutes ? `${script.watchdog_grace_minutes} min` : '—')}
          ${spScheduleRow('Umbral stalled', script?.watchdog_threshold_minutes ? `${script.watchdog_threshold_minutes} min` : '—')}
          ${spScheduleRow('Nota watchdog', script?.watchdog_expected_at ? 'Hay una observación de missed calculada.' : 'Sin missed detectado. La última ejecución real se muestra en Programación.')}
        </div>
      </div>

      <div class="mb-3">
        <div class="fw-semibold mb-2"><i class="bi bi-pause-circle me-1"></i>Control operativo</div>
        <div class="border rounded p-2">
          ${script?.controlled_stop ? `
            <div class="alert alert-info py-2 small mb-2">
              <div class="fw-semibold">Incidencia controlada activa</div>
              <div>Desde: ${esc(fmtDate(script.controlled_stop_at))}</div>
              <div>Tipo: ${esc(spControlTypeLabel(script.controlled_stop_type))}</div>
              <div>Motivo: ${esc(script.controlled_stop_reason || '—')}</div>
              <div class="mt-1">Mientras esté activa, Auditor IPs conserva el estado real como raw_state, guarda trazabilidad y no repite alertas por error/stalled/running_long de esta instancia.</div>
            </div>
          ` : `
            <div class="small text-muted mb-2">
              Marca la incidencia como controlada si ya has revisado el error, stalled o parada y quieres evitar nuevas alertas para esta ejecución concreta.
            </div>
          `}
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn btn-outline-info btn-sm" id="sp-controlled-stop-mark" type="button">
              <i class="bi bi-shield-check me-1"></i>Marcar incidencia controlada
            </button>
            <button class="btn btn-outline-success btn-sm" id="sp-controlled-stop-clear" type="button" ${script?.controlled_stop ? '' : 'disabled'}>
              <i class="bi bi-play-circle me-1"></i>Reactivar vigilancia normal
            </button>
          </div>
          <div class="small text-muted mt-2">
            Al marcarla se abrirá un modal para elegir el tipo e indicar el motivo.
          </div>
        </div>
      </div>

      <div class="mb-3">
        <div class="fw-semibold mb-2"><i class="bi bi-bell me-1"></i>Reglas de alerta</div>
        <div id="sp-schedule-alerts" class="border rounded p-2">
          <div class="small text-muted">Cargando reglas de alerta…</div>
        </div>
      </div>

      <div>
        <div class="fw-semibold mb-2"><i class="bi bi-gear me-1"></i>Configuración conocida</div>
        <div class="row g-2">
          ${spScheduleRow('Cron configurado', script?.cfg_cron_expr || '—', { mono: true })}
          ${spScheduleRow('Origen configurado', script?.cfg_cron_source || '—')}
          ${spScheduleRow('Host configurado', script?.cfg_host_name || '—', { mono: true })}
        </div>
      </div>
    `);
  }

  function spOpenScheduleModal(key) {
    spScheduleCurrentKey = key;
    const script = spFindScriptByKey(key);
    if (!script) {
      window.showToast?.('No se encontró la automatización seleccionada', 'warning');
      return;
    }

    spRenderScheduleModal(script);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('sp-schedule-modal')).show();
    spLoadScheduleAlertRules(script);
  }

  let spScheduleCurrentKey = null;

  async function spRefreshScheduleModalAfterChange(key) {
    try {
      const res = await fetch('/api/scripts/status', { cache: 'no-store' });
      const data = await res.json();
      spData = Array.isArray(data) ? data : [];
      spRenderHostFilter();
      spRenderHostSummary(spData);
      spRenderCurrentView();

      const refreshed = spFindScriptByKey(key);
      if (refreshed) {
        spRenderScheduleModal(refreshed);
        spLoadScheduleAlertRules(refreshed);
      }
    } catch (e) {
      window.showToast?.('No se pudo refrescar el estado: ' + (e.message || e), 'warning');
    }
  }

  async function spSetControlledStop(mark, incidentPayload) {
    const key = spScheduleCurrentKey;
    const script = spFindScriptByKey(key);
    if (!script) return;

    const name = String(script.name || '');
    const host = spScriptHost(script);
    const reason = String(incidentPayload?.reason || '').trim();
    const controlType = String(incidentPayload?.control_type || '').trim();
    if (mark && !controlType) {
      window.showToast?.('Selecciona el tipo de incidencia controlada', 'warning');
      return;
    }
    if (mark && !reason) {
      window.showToast?.('Indica un motivo para marcar la incidencia como controlada', 'warning');
      return;
    }

    const url = `/api/scripts/controlled-stops/${encodeURIComponent(name)}?host=${encodeURIComponent(host)}`;

    try {
      const res = await fetch(url, {
        method: mark ? 'POST' : 'DELETE',
        headers: mark ? { 'Content-Type': 'application/json' } : {},
        body: mark ? JSON.stringify({
          host_name: host,
          reason,
          control_type: controlType,
          start_time: script.start_time || script.last_run || ''
        }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || data.detail || `HTTP ${res.status}`);

      window.showToast?.(mark ? '✓ Incidencia marcada como controlada' : '✓ Vigilancia normal reactivada', 'success');
      await spRefreshScheduleModalAfterChange(key);
      await spLoadExecutionHistory(true);
    } catch (e) {
      window.showToast?.('✗ ' + (e.message || e), 'danger');
    }
  }

  function spAIBtn(scriptOrName, stateOrTableMode, maybeTableMode) {
    const script    = (scriptOrName && typeof scriptOrName === 'object') ? scriptOrName : null;
    const name      = script ? String(script.name || '') : String(scriptOrName || '');
    const key       = script ? spScriptKey(script) : name;
    const host      = script ? spScriptHost(script) : '';
    const state     = script ? String(script.state || '') : String(stateOrTableMode || '');
    const tableMode = script ? !!stateOrTableMode : !!maybeTableMode;

    const disabled = ollamaReady === false;
    const running  = state === 'running';
    const rawPct   = script && script.progress_pct != null ? Number(script.progress_pct) : null;
    const pct      = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, Math.round(rawPct))) : null;
    const step     = script && script.step_label ? String(script.step_label).trim() : '';

    let title = disabled ? 'IA no disponible' : 'Analizar con IA';
    if (!disabled && running) {
      const parts = [];
      if (step) parts.push(step);
      if (pct !== null) parts.push(`${pct}%`);
      title = `Analizar con IA · ejecución en curso${parts.length ? ' · ' + parts.join(' · ') : ''}`;
    }

    if (tableMode) {
      const compactText = running ? (pct !== null ? `${pct}%` : '…') : '';
      return `<button class="btn btn-sm btn-outline-info sp-btn-ai" data-name="${esc(name)}" data-host="${esc(host)}" data-key="${esc(key)}"
                title="${esc(title)}" ${disabled ? 'disabled' : ''}>
                <i class="bi bi-robot${compactText ? ' me-1' : ''}"></i>${compactText}
              </button>`;
    }

    const label = running
      ? `Analizar IA · ${pct !== null ? `${pct}%` : 'en curso'}`
      : 'Analizar con IA';

    return `<button class="btn btn-sm btn-outline-info sp-btn-ai" data-name="${esc(name)}" data-host="${esc(host)}" data-key="${esc(key)}"
              title="${esc(title)}" ${disabled ? 'disabled' : ''}>
              <i class="bi bi-robot me-1"></i>${label}
            </button>`;
  }

  // ─────────────────────────────────────────────────
  // Init al activar la pestaña
  // ─────────────────────────────────────────────────
  // Escuchar solo la subtab real de Infraestructura > Automatizaciones.
  // Evitamos depender del botón legacy oculto #scripts-tab para no duplicar init/refresh al restaurar tabs en F5.
  $(document).on('shown.bs.tab', 'button[data-bs-target="#infraAuto"], #infra-auto-tab', function () {
    spLoad();
    spCheckOllama();
    spStartRefresh();
  });
  $(document).on('hidden.bs.tab', 'button[data-bs-target="#infraAuto"], #infra-auto-tab', function () {
    spStopRefresh();
    spStopLog();
  });

  // Si la subtab ya quedó activa durante la restauración al hacer F5,
  // el shown.bs.tab puede haberse disparado antes de registrar estos listeners.
  // En ese caso, arrancamos la vista una vez al finalizar el montaje.
  setTimeout(function () {
    const infraAutoTab = document.getElementById('infra-auto-tab');
    const infraAutoPane = document.getElementById('infraAuto');
    const isActive =
      infraAutoTab?.classList.contains('active') ||
      infraAutoPane?.classList.contains('active') ||
      infraAutoPane?.classList.contains('show');

    if (isActive) {
      spLoad();
      spCheckOllama();
      spStartRefresh();
    }
  }, 0);

  // ─────────────────────────────────────────────────
  // Carga de datos
  // ─────────────────────────────────────────────────
  function spLoad() {
    // ── Prefetch cache: si el orquestador ya tiene datos, renderizar inmediatamente ──
    const cached = window._prefetch?.scripts;
    if (cached) {
      spData = cached;
      spRenderHostFilter();
      spRenderHostSummary(spData);
      spRenderCurrentView();
      $('#sp-last-refresh').text(fmtRefreshTime());
      $('#sp-error-banner').addClass('d-none');
      // Limpiar cache y refrescar en background para tener dato fresco
      delete window._prefetch.scripts;
      $.getJSON('/api/scripts/status').done(function(data) {
        spData = data || [];
        spRenderHostFilter();
        spRenderCurrentView();
        $('#sp-last-refresh').text(fmtRefreshTime());
      });
      return;
    }
    $.getJSON('/api/scripts/status')
      .done(function (data) {
        spData = data || [];
        spRenderHostFilter();
        spRenderCurrentView();
        $('#sp-last-refresh').text(fmtRefreshTime());
        $('#sp-error-banner').addClass('d-none');
      })
      .fail(function (xhr) {
        $('#sp-error-msg').text(xhr.statusText || 'Error desconocido');
        $('#sp-error-banner').removeClass('d-none');
      });
  }

  function spRefreshMs() {
    return window.getFrontendRefreshMs('normal');
  }

  function spStartRefresh() {
    spStopRefresh();
    spRefreshTimer = setInterval(function () {
      if ($('#sp-ai-modal').hasClass('show')) return;
      spLoad();
    }, spRefreshMs());
  }
  function spStopRefresh() {
    if (spRefreshTimer) { clearInterval(spRefreshTimer); spRefreshTimer = null; }
  }

  document.addEventListener('frontendrefreshsettingschange', function () {
    if (spRefreshTimer) spStartRefresh();
  });

  // ─────────────────────────────────────────────────
  // KPIs
  // ─────────────────────────────────────────────────
  function spRenderKPIs(data) {
    $('#sp-kpi-total').text(data.length);
    $('#sp-kpi-ok').text(data.filter(s => s.state === 'ok').length);
    $('#sp-kpi-running').text(data.filter(s => s.state === 'running').length);
    const errCount = data.filter(s => s.state === 'error').length;
    $('#sp-kpi-errors').text(errCount);
    $('#sp-kpi-errors-card').toggleClass('border-danger', errCount > 0);
    $('#sp-kpi-missed').text(data.filter(s => s.state === 'stalled' || s.state === 'missed').length);
  }

  function spBuildHostSummary(data) {
    const map = {};
    (data || []).forEach(s => {
      const host = spScriptHost(s);
      if (!map[host]) {
        map[host] = {
          host,
          total: 0,
          ok: 0,
          running: 0,
          error: 0,
          missed: 0,
          lastTs: 0,
          runningItems: [],
        };
      }

      const st = map[host];
      const state = String(s.state || 'unknown');
      st.total += 1;
      if (state === 'ok') st.ok += 1;
      if (state === 'running') {
        st.running += 1;
        st.runningItems.push(s.cfg_label || s.name || '');
      }
      if (state === 'error') st.error += 1;
      if (state === 'missed' || state === 'stalled') st.missed += 1;

      const t = Date.parse(String(s.start_time || s.last_run || '').replace(' ', 'T'));
      if (Number.isFinite(t) && t > st.lastTs) st.lastTs = t;
    });

    return Object.values(map).sort((a, b) => {
      const score = h => (h.error * 1000) + (h.missed * 100) + (h.running * 10);
      const diff = score(b) - score(a);
      return diff || a.host.localeCompare(b.host, navigator.language || 'es', { numeric: true, sensitivity: 'base' });
    });
  }

  function spHostSummaryClass(h) {
    if (h.error > 0) return 'border-danger';
    if (h.missed > 0) return 'border-warning';
    if (h.running > 0) return 'border-primary';
    if (h.total > 0 && h.ok === h.total) return 'border-success';
    return 'border-secondary';
  }

  function spRenderHostSummary(data) {
    const wrap = document.getElementById('sp-host-summary');
    if (!wrap) return;

    const hosts = spBuildHostSummary(data);
    if (!hosts.length) {
      wrap.innerHTML = '';
      wrap.classList.add('d-none');
      return;
    }

    wrap.classList.remove('d-none');

    const total = {
      host: 'all',
      total: (data || []).length,
      ok: (data || []).filter(s => s.state === 'ok').length,
      running: (data || []).filter(s => s.state === 'running').length,
      error: (data || []).filter(s => s.state === 'error').length,
      missed: (data || []).filter(s => s.state === 'missed' || s.state === 'stalled').length,
    };

    const card = (h, isAll) => {
      const selected = (isAll && spHostFilter === 'all') || (!isAll && spHostFilter === h.host);
      const cls = selected ? 'border-info shadow-sm' : spHostSummaryClass(h);
      const muted = selected ? 'text-info' : 'text-muted';
      const runningTitle = h.runningItems?.length ? ` title="${esc(h.runningItems.join(', '))}"` : '';
      return `
        <button type="button"
                class="card bg-transparent ${cls} sp-host-summary-card"
                data-host="${esc(isAll ? 'all' : h.host)}"
                style="min-width:180px;max-width:260px;text-align:left">
          <div class="card-body p-2">
            <div class="d-flex justify-content-between align-items-center gap-2">
              <div class="fw-semibold text-truncate">${isAll ? 'Todos los hosts' : esc(h.host)}</div>
              <span class="badge ${selected ? 'bg-info text-dark' : 'bg-secondary'}">${h.total}</span>
            </div>
            <div class="small ${muted} mt-1 d-flex flex-wrap gap-2">
              <span><i class="bi bi-check-circle text-success"></i> ${h.ok}</span>
              <span${runningTitle}><i class="bi bi-arrow-repeat text-primary"></i> ${h.running}</span>
              <span><i class="bi bi-exclamation-triangle text-danger"></i> ${h.error}</span>
              <span><i class="bi bi-clock-history text-warning"></i> ${h.missed}</span>
            </div>
          </div>
        </button>
      `;
    };

    wrap.innerHTML = `
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <div class="small text-muted">
          <i class="bi bi-hdd-network me-1"></i>Resumen por host
        </div>
        <div class="small text-muted">${hosts.length} host${hosts.length === 1 ? '' : 's'}</div>
      </div>
      <div class="d-flex flex-wrap gap-2">
        ${card(total, true)}
        ${hosts.map(h => card(h, false)).join('')}
      </div>
    `;
  }

  // ─────────────────────────────────────────────────
  // Vista fichas
  // ─────────────────────────────────────────────────
  function spRenderCards(data) {
    if (!data.length) {
      $('#sp-cards').html('<div class="col-12"><div class="alert alert-info">No se encontraron scripts monitorizados.</div></div>');
      return;
    }
    let html = '';
    data.forEach(function (s) {
      const lastRun  = fmtDate(s.start_time || s.last_run);
      const endTime  = fmtDate(s.end_time);
      const nextRun  = fmtDate(s.next_run);
      const duration = humanDuration(s.duration_seconds);
      const step     = s.step_label  || '';
      const progress = s.progress_pct != null ? s.progress_pct : null;
      const errors   = (s.state === 'error') ? (s.errors || s.error_messages || []) : [];
      const errHtml  = errors.length
        ? `<div class="alert alert-danger py-1 px-2 small mb-0 mt-1">${errors.join('<br>')}</div>` : '';
      const watchdogHtml = spWatchdogDetail(s);

      // Color y etiqueta desde Config → Procesos
      const cfgColor  = s.cfg_color  || '';
      const cfgLabel  = s.cfg_label  || s.name;
      const hostName  = spScriptHost(s);
      const accentStyle = cfgColor ? `border-left:4px solid ${cfgColor};` : '';
      const dotHtml   = cfgColor
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cfgColor};margin-right:5px;flex-shrink:0"></span>` : '';

      // Barra de progreso (solo si running o hay progress)
      let progressHtml = '';
      if (progress !== null) {
        const pct  = Math.min(100, Math.max(0, progress));
        const barColor = cfgColor && s.state !== 'error' ? cfgColor : (s.state === 'error' ? '' : '');
        const cls  = s.state === 'error' ? 'bg-danger' : (pct === 100 ? 'bg-success' : 'bg-primary');
        const barStyle = cfgColor && s.state !== 'error' ? `style="width:${pct}%;background:${cfgColor}"` : `style="width:${pct}%"`;
        progressHtml = `
          <div class="mt-1">
            <div class="d-flex justify-content-between small text-muted mb-1">
              <span>${step}</span><span>${pct}%</span>
            </div>
            <div class="progress" style="height:5px">
              <div class="progress-bar ${s.state === 'error' ? 'bg-danger' : ''}" ${barStyle}></div>
            </div>
          </div>`;
      }

      html += `
      <div class="col-12 col-md-6 col-xl-4 mb-3">
        <div class="card border-0 shadow-sm h-100" style="${accentStyle}">
          <div class="card-body d-flex flex-column gap-2">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <h6 class="card-title mb-0 text-truncate font-monospace d-flex align-items-center" title="${s.name}">
                ${dotHtml}<i class="bi bi-terminal me-1"></i>${cfgLabel !== s.name ? cfgLabel : s.name}
              </h6>
              <div class="d-flex gap-1 flex-wrap justify-content-end">
                ${spStateBadge(s.state)}
                ${spWatchdogHint(s, false)}
              </div>
            </div>
            <div class="small text-muted lh-lg">
              <div><i class="bi bi-hdd-network me-1"></i>Host: <strong>${esc(hostName)}</strong></div>
              <div><i class="bi bi-play-circle me-1"></i>Inicio: <strong>${lastRun}</strong></div>
              <div><i class="bi bi-stop-circle me-1"></i>Fin: <strong>${endTime}</strong></div>
              <div><i class="bi bi-stopwatch me-1"></i>Duración: <strong>${duration}</strong></div>
              <div><i class="bi bi-clock me-1"></i>Próxima: <strong>${nextRun}</strong></div>
            </div>
            ${progressHtml}
            ${errHtml}
            ${watchdogHtml}
            <div class="d-flex gap-2 mt-auto flex-wrap">
              <button class="btn btn-sm btn-outline-secondary sp-btn-log" data-name="${esc(s.name)}" data-host="${esc(hostName)}" data-key="${esc(spScriptKey(s))}">
                <i class="bi bi-file-text me-1"></i>Log
              </button>
              ${spScheduleBtn(s, false)}
              ${spAIBtn(s, false)}
            </div>
          </div>
        </div>
      </div>`;
    });
    $('#sp-cards').html(html);
  }

  // ─────────────────────────────────────────────────
  // Vista tabla
  // ─────────────────────────────────────────────────
  function spRenderTable(data) {
    if (!data.length) {
      $('#sp-cards').html('<div class="col-12"><div class="alert alert-info">No se encontraron scripts monitorizados.</div></div>');
      return;
    }
    let rows = '';
    data.forEach(function (s) {
      const lastRun  = fmtDate(s.start_time || s.last_run);
      const endTime  = fmtDate(s.end_time);
      const nextRun  = fmtDate(s.next_run);
      const duration = humanDuration(s.duration_seconds);
      const step     = s.step_label ? `<span class="text-muted" style="font-size:.75rem">${s.step_label}</span>` : '';
      const pct      = s.progress_pct != null ? `<span class="badge bg-secondary ms-1">${s.progress_pct}%</span>` : '';
      const cfgColor = s.cfg_color || '';
      const cfgLabel = s.cfg_label || s.name;
      const hostName = spScriptHost(s);
      const dotHtml  = cfgColor
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cfgColor};margin-right:5px;flex-shrink:0;vertical-align:middle"></span>` : '';
      const rowStyle = cfgColor ? `style="border-left:3px solid ${cfgColor}"` : '';
      const watchdogHint = spWatchdogHint(s, true);

      rows += `<tr ${rowStyle}>
        <td class="font-monospace small">${dotHtml}${cfgLabel !== s.name ? `<span title="${s.name}">${cfgLabel}</span>` : s.name}</td>
        <td class="small">${esc(hostName)}</td>
        <td>${spStateBadge(s.state)} ${watchdogHint} ${step}${pct}</td>
        <td class="small">${lastRun}</td>
        <td class="small">${endTime}</td>
        <td class="small fw-semibold">${duration}</td>
        <td class="small">${nextRun}</td>
        <td>
          <div class="d-flex gap-1">
            <button class="btn btn-sm btn-outline-secondary sp-btn-log" data-name="${esc(s.name)}" data-host="${esc(hostName)}" data-key="${esc(spScriptKey(s))}" title="${esc(window.t?.('scripts.view_log', 'Ver log') || 'Ver log')}">
              <i class="bi bi-file-text"></i>
            </button>
            ${spScheduleBtn(s, true)}
            ${spAIBtn(s, true)}
          </div>
        </td>
      </tr>`;
    });
    $('#sp-cards').html(`
      <div class="col-12">
        <div class="table-responsive">
          <table class="table table-hover align-middle small" id="spTable">
            <thead><tr>
              <th>Script</th><th>Host</th><th>Estado</th><th>Inicio</th><th>Fin</th>
              <th>Duración</th><th>Próxima</th><th>Acciones</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }

  // ─────────────────────────────────────────────────
  // Toggle vista
  // ─────────────────────────────────────────────────
  $(document).on('click', '#sp-btn-cards', function () {
    spViewMode = 'cards';
    localStorage.setItem('auditor-scripts-view', 'cards');
    $('#sp-btn-cards').addClass('active');
    $('#sp-btn-table').removeClass('active');
    spRenderCards(spDisplayData());
  });
  $(document).on('click', '#sp-btn-table', function () {
    spViewMode = 'table';
    localStorage.setItem('auditor-scripts-view', 'table');
    $('#sp-btn-table').addClass('active');
    $('#sp-btn-cards').removeClass('active');
    spRenderTable(spDisplayData());
  });

  setTimeout(function () {
    if (spViewMode === 'table') {
      $('#sp-btn-table').addClass('active');
      $('#sp-btn-cards').removeClass('active');
    } else {
      $('#sp-btn-cards').addClass('active');
      $('#sp-btn-table').removeClass('active');
    }
  }, 0);
  $(document).on('click', '#sp-btn-refresh', function () {
    spLoad();
    spCheckOllama();
  });

  $(document).on('click', '#sp-btn-clear-filters', function () {
    spHostFilter = 'all';
    spStateFilter = 'all';
    spSortMode = 'priority';

    localStorage.setItem('auditor-scripts-host-filter', spHostFilter);
    localStorage.setItem('auditor-scripts-state-filter', spStateFilter);
    localStorage.setItem('auditor-scripts-sort-mode', spSortMode);

    const hostSel = document.getElementById('sp-host-filter');
    const stateSel = document.getElementById('sp-state-filter');
    const sortSel = document.getElementById('sp-sort-mode');
    if (hostSel) hostSel.value = spHostFilter;
    if (stateSel) stateSel.value = spStateFilter;
    if (sortSel) sortSel.value = spSortMode;

    spRenderHostSummary(spData);
    spRenderCurrentView();
  });

  $(document).on('change', '#sp-host-filter', function () {
    spHostFilter = this.value || 'all';
    localStorage.setItem('auditor-scripts-host-filter', spHostFilter);
    spRenderHostSummary(spData);
    spRenderCurrentView();
  });

  $(document).on('change', '#sp-state-filter', function () {
    spStateFilter = this.value || 'all';
    localStorage.setItem('auditor-scripts-state-filter', spStateFilter);
    spRenderCurrentView();
  });

  $(document).on('change', '#sp-sort-mode', function () {
    spSortMode = this.value || 'priority';
    localStorage.setItem('auditor-scripts-sort-mode', spSortMode);
    spRenderCurrentView();
  });

  $(document).on('click', '.sp-host-summary-card', function () {
    spHostFilter = String($(this).data('host') || 'all');
    localStorage.setItem('auditor-scripts-host-filter', spHostFilter);
    const sel = document.getElementById('sp-host-filter');
    if (sel) sel.value = spHostFilter;
    spRenderHostSummary(spData);
    spRenderCurrentView();
  });

  // ─────────────────────────────────────────────────
  // Log en vivo
  // ─────────────────────────────────────────────────
  $(document).on('click', '.sp-btn-schedule', function () {
    spOpenScheduleModal($(this).data('key') || $(this).data('name'));
  });

  let spControlledIncidentTargetKey = null;

  function spReadControlledIncidentType() {
    const el = document.getElementById('sp-controlled-incident-type');
    if (!el) return '';

    const raw = String(el.value || '').trim();
    if (raw) return raw;

    const selectedText = String(el.options?.[el.selectedIndex]?.text || '').trim().toLowerCase();
    const byText = {
      'parada controlada': 'controlled_stop',
      'error controlado': 'controlled_error',
      'stalled controlado': 'controlled_stalled',
      'missed controlado': 'controlled_missed',
      'falso positivo': 'false_positive',
      'mantenimiento': 'maintenance',
      'otro': 'other',
    };
    return byText[selectedText] || '';
  }

  function spOpenControlledIncidentModal() {
    spControlledIncidentTargetKey = spScheduleCurrentKey;
    const script = spFindScriptByKey(spControlledIncidentTargetKey);
    if (!script) return;

    $('#sp-controlled-incident-subtitle').text(`${spScriptHost(script)} / ${script.cfg_label || script.name || 'Automatización'}`);
    $('#sp-controlled-incident-type').val('');
    $('#sp-controlled-incident-reason').val('');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('sp-controlled-incident-modal')).show();
    setTimeout(() => $('#sp-controlled-incident-type').trigger('focus'), 150);
  }

  function spOpenHistoryLogModal(eventId) {
    const id = Number(eventId);
    const ev = (spExecutionHistory || []).find(x => Number(x.id) === id);
    if (!ev) {
      window.showToast?.('No se encontró el evento de historial', 'warning');
      return;
    }
    if (!ev.log_excerpt) {
      spLoadExecutionHistory(true).then(() => spOpenHistoryLogModal(eventId));
      return;
    }

    $('#sp-history-log-subtitle').text(`${fmtDate(ev.at)} · ${ev.host_name || 'Local'} / ${ev.script_name || '—'} · ${spHistoryEventLabel(ev.event_type)}`);
    $('#sp-history-log-body').text(ev.log_excerpt || '(sin muestra de log)');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('sp-history-log-modal')).show();
  }

  $(document).on('click', '#sp-controlled-stop-mark', function () {
    spOpenControlledIncidentModal();
  });

  $(document).on('click', '#sp-controlled-stop-clear', function () {
    spSetControlledStop(false);
  });

  $(document).on('input change', '#sp-history-search,#sp-history-type,#sp-history-sort', function () {
    spRenderExecutionHistory();
  });

  $(document).on('click', '#sp-btn-history', function () {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('sp-history-modal')).show();
    spLoadExecutionHistory(true);
  });

  $(document).on('click', '#sp-history-refresh', function () {
    spLoadExecutionHistory(true);
  });

  $(document).on('click', '#sp-controlled-incident-confirm', async function () {
    const controlType = spReadControlledIncidentType();
    const reason = String($('#sp-controlled-incident-reason').val() || '').trim();

    if (!controlType) {
      window.showToast?.('Selecciona el tipo de incidencia controlada', 'warning');
      $('#sp-controlled-incident-type').focus();
      return;
    }
    if (!reason) {
      window.showToast?.('Indica un motivo para marcar la incidencia como controlada', 'warning');
      $('#sp-controlled-incident-reason').focus();
      return;
    }

    spScheduleCurrentKey = spControlledIncidentTargetKey || spScheduleCurrentKey;
    await spSetControlledStop(true, { control_type: controlType, reason });
    bootstrap.Modal.getInstance(document.getElementById('sp-controlled-incident-modal'))?.hide();
  });

  $(document).on('click', '.sp-history-log-btn', function () {
    spOpenHistoryLogModal(this.dataset.eventId);
  });

  $(document).on('click', '#sp-schedule-config-btn', function () {
    const scheduleModalEl = document.getElementById('sp-schedule-modal');
    const configModalEl = document.getElementById('configModal');

    try { bootstrap.Modal.getInstance(scheduleModalEl)?.hide(); } catch (_) {}

    if (!configModalEl || !window.bootstrap?.Modal) return;

    setTimeout(function () {
      const navButtons = Array.from(configModalEl.querySelectorAll('.cfg-nav-btn'));
      const panels = Array.from(configModalEl.querySelectorAll('.cfg-panel'));
      const section = 'scripts';
      const targetBtn = navButtons.find(btn => String(btn.dataset.section || '') === section);

      if (targetBtn) {
        navButtons.forEach(btn => btn.classList.remove('active'));
        targetBtn.classList.add('active');
        panels.forEach(panel => {
          panel.style.display = String(panel.dataset.panel || '') === section ? '' : 'none';
        });
      }

      bootstrap.Modal.getOrCreateInstance(configModalEl).show();

      setTimeout(function () {
        targetBtn?.click();
      }, 40);
    }, 140);
  });

  $(document).on('click', '.sp-btn-log', function () {
    spOpenLog($(this).data('key') || $(this).data('name'));
  });

  function spOpenLog(key) {
    const script = spFindScriptByKey(key);
    const name = script ? script.name : String(key || '');
    const host = script ? spScriptHost(script) : '';
    spStopLog();
    $('#sp-livelog-title').text(host ? `${host} / ${name}` : name);
    $('#sp-livelog-status').html('');
    $('#sp-livelog-body').text('Cargando…');
    $('#sp-livelog-panel').removeClass('d-none');
    spFetchLog(key);

    if (script && script.state === 'running') {
      $('#sp-livelog-status').html(' <span class="badge bg-primary"><i class="bi bi-circle-fill" style="font-size:.5rem"></i> vivo</span>');
      spLogTimer = setInterval(function () { spFetchLog(key); }, 5000);
    }
  }

  function spFetchLog(key) {
    // Primero intentar usar last_log_lines del status (ya cargado en memoria)
    const script = spFindScriptByKey(key);
    const name = script ? script.name : String(key || '');
    const host = script ? spScriptHost(script) : '';
    if (script && script.last_log_lines && script.last_log_lines.length) {
      const el = document.getElementById('sp-livelog-body');
      el.textContent = script.last_log_lines.join('\n');
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Si no, pedir al backend
    $.getJSON('/api/scripts/log/' + encodeURIComponent(name) + '?lines=100' + (host ? '&host=' + encodeURIComponent(host) : ''))
      .done(function (data) {
        const el = document.getElementById('sp-livelog-body');
        el.textContent = data.lines || '(log vacío)';
        el.scrollTop = el.scrollHeight;
        if (script && script.state !== 'running') spStopLog();
      })
      .fail(function () {
        $('#sp-livelog-body').text('Error al cargar el log.');
        spStopLog();
      });
  }

  $(document).on('click', '#sp-livelog-close', function () {
    spStopLog();
    $('#sp-livelog-panel').addClass('d-none');
  });

  function spStopLog() {
    if (spLogTimer) { clearInterval(spLogTimer); spLogTimer = null; }
    $('#sp-livelog-status').html('');
  }

  // ─────────────────────────────────────────────────
  // Ollama/IA — badge de estado
  // ─────────────────────────────────────────────────
  function spCheckOllama() {
    $.getJSON('/api/scripts/ollama/status')
      .done(function (data) {
        ollamaReady = data.available && data.model_ready;
        spUpdateOllamaBadge(data);
      })
      .fail(function () {
        ollamaReady = false;
        spUpdateOllamaBadge({ available: false });
      });
  }

  function spUpdateOllamaBadge(data) {
    let html;
    const provider = (data.provider || 'ia').toUpperCase();
    if (data.available && data.model_ready) {
      html = `<span class="badge bg-success" title="${data.model}"><i class="bi bi-robot me-1"></i>${provider} lista</span>`;
    } else if (data.available && !data.model_ready) {
      html = `<span class="badge bg-warning text-dark"><i class="bi bi-robot me-1"></i>Modelo no cargado</span>`;
    } else {
      html = `<span class="badge bg-secondary" title="${data.error || ''}"><i class="bi bi-robot me-1"></i>IA no disponible</span>`;
    }
    $('#sp-ollama-badge').html(html);
  }

  // ─────────────────────────────────────────────────
  // Análisis IA
  // ─────────────────────────────────────────────────
  $(document).on('click', '.sp-btn-ai', function () {
    spOpenAIModal($(this).data('key') || $(this).data('name'));
  });

  function spOpenAIModal(key) {
    const script = spFindScriptByKey(key);
    const name = script ? script.name : String(key || '');
    const host = script ? spScriptHost(script) : '';

    function buildLiveBanner(s) {
      if (!s || s.state !== 'running') return '';
      const pct = s.progress_pct != null && !Number.isNaN(Number(s.progress_pct))
        ? Math.max(0, Math.min(100, Number(s.progress_pct)))
        : null;
      const extra = [];
      if (pct !== null) extra.push(`${pct}%`);
      if (s.step_label) extra.push(esc(s.step_label));
      const detail = extra.length
        ? extra.join(' · ')
        : 'El script sigue ejecutándose en este momento.';
      return `
        <div class="alert alert-info py-2 px-3 mb-3">
          <div class="fw-semibold d-flex align-items-center gap-2">
            <i class="bi bi-arrow-repeat sp-spin"></i>
            <span>Ejecución en curso</span>
          </div>
          <div class="small mt-1">${detail}</div>
        </div>
      `;
    }

    const liveBanner = buildLiveBanner(script);

    $('#sp-ai-script-name').text(host ? `${host} / ${name}` : name);
    $('#sp-ai-loading').removeClass('d-none');
    $('#sp-ai-result').html(liveBanner || '').toggleClass('d-none', !liveBanner);
    $('#sp-ai-error').addClass('d-none');
    $('#sp-ai-error-msg').text('');
    $('#sp-ai-footer').text(liveBanner ? 'Leyendo estado actual y generando análisis…' : '');

    new bootstrap.Modal(document.getElementById('sp-ai-modal')).show();

    $.ajax({
      url:     '/api/scripts/analyze/' + encodeURIComponent(name) + (host ? '?host=' + encodeURIComponent(host) : ''),
      method:  'POST',
      timeout: window.getOperationalTimeoutMs('script_ai_frontend'),
    })
    .done(function (data) {
      $('#sp-ai-loading').addClass('d-none');
      $('#sp-ai-result')
        .removeClass('d-none')
        .html((liveBanner || '') + spRenderMD(data.analysis || '(Sin respuesta)'));
      const ts = data.analyzed_at ? fmtDate(data.analyzed_at) : '';
      const prov = (data.provider || '').toUpperCase();
      const runningNote = (script && script.state === 'running') ? ' · ejecución en curso' : '';
      $('#sp-ai-footer').text(`${prov} · ${data.model} · ${ts}${runningNote}`);
    })
    .fail(function (xhr) {
      $('#sp-ai-loading').addClass('d-none');
      let msg = 'Error al conectar con el análisis IA.';
      let detail = '';
      try { detail = JSON.parse(xhr.responseText).detail || ''; } catch (_) {}

      if (xhr.status === 429) {
        msg = 'Proveedor IA saturado o límite alcanzado. Reintenta en unos minutos.';
      } else if (xhr.status === 503) {
        msg = 'Proveedor IA no disponible en este momento.';
      } else if (xhr.status === 502) {
        msg = 'El proveedor IA devolvió una respuesta no válida o falló aguas arriba.';
      } else if (detail) {
        msg = detail;
      }

      if (detail && detail !== msg && xhr.status !== 429 && xhr.status !== 503 && xhr.status !== 502) {
        msg += ' Detalle: ' + detail;
      }

      $('#sp-ai-error-msg').text(msg);
      $('#sp-ai-error').removeClass('d-none');
      if (liveBanner) {
        $('#sp-ai-result').removeClass('d-none').html(liveBanner);
      }
    });
  }

  function spRenderMD(text) {
    text = text.replace(/^## (.+)$/gm, '<h6 class="ai-section-title">$1</h6>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    return text.split(/\n\n+/)
      .map(p => p.trim()).filter(Boolean)
      .map(p => p.startsWith('<h6') ? p : '<p class="mb-2">' + p.replace(/\n/g, '<br>') + '</p>')
      .join('');
  }

  // ─────────────────────────────────────────────────
  // Modal Ayuda
  // ─────────────────────────────────────────────────
  $(document).on('click', '#sp-btn-help', function () {
    spLoadDocs();
    new bootstrap.Modal(document.getElementById('sp-help-modal')).show();
  });

  function spLoadDocs() {
    $('#sp-help-tabs').html('<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-primary"></div></div>');
    $('#sp-help-panes').html('');
    $.getJSON('/api/scripts/docs')
      .done(function (docs) {
        if (!docs.length) {
          $('#sp-help-tabs').html('<div class="text-muted small px-2">Sin docs.</div>');
          return;
        }
        let tabs = '', panes = '';
        docs.forEach(function (doc, i) {
          const active = i === 0 ? 'active' : '';
          const show   = i === 0 ? 'show active' : '';
          const id     = 'sp-doc-' + i;
          tabs  += `<button class="nav-link ${active} text-start" data-bs-toggle="tab"
                            data-bs-target="#${id}" type="button"
                            style="font-size:.82rem">${doc.name}</button>`;
          panes += `<div class="tab-pane fade ${show} p-3" id="${id}">
                      <div class="text-center py-3"><div class="spinner-border spinner-border-sm text-primary"></div></div>
                    </div>`;
        });
        $('#sp-help-tabs').html(tabs);
        $('#sp-help-panes').html(panes);
        spLoadDoc(docs[0].name, '#sp-doc-0');
        docs.forEach(function (doc, i) {
          if (i === 0) return;
          $('[data-bs-target="#sp-doc-' + i + '"]').one('click', function () {
            spLoadDoc(doc.name, '#sp-doc-' + i);
          });
        });
      });
  }

  function spRenderHelpDocMD(text) {
    const raw = String(text || '');
    if (window.marked && typeof window.marked.parse === 'function') {
      return window.marked.parse(raw);
    }
    return spRenderMD(raw);
  }

  function spLoadDoc(filename, paneId) {
    $.getJSON('/api/scripts/doc/' + encodeURIComponent(filename))
      .done(function (data) {
        $(paneId).html('<div class="small lh-lg sp-help-doc">' + spRenderHelpDocMD(data.content || '') + '</div>');
      })
      .fail(function () {
        $(paneId).html('<div class="alert alert-warning">Error cargando documento.</div>');
      });
  }


  // ─────────────────────────────────────────────────────────────────────────
  // Informe Diario IA de Red
  // ─────────────────────────────────────────────────────────────────────────

  $(document).on('click', '#sp-btn-daily-report', function () {
    const modal = new bootstrap.Modal(document.getElementById('sp-daily-report-modal'));
    modal.show();
    spDailyReportLoad();
    spDailyReportLoadHistory();
  });

  $(document).on('click', '#sp-dr-btn-generate', function () {
    spDailyReportGenerate(null);
  });

  $(document).on('change', '#sp-dr-history-select', function () {
    const date = $(this).val();
    if (date) spDailyReportLoadDate(date);
  });

  function spDailyReportLoad() {
    $.getJSON('/api/daily-report/latest')
      .done(function (data) {
        if (data.analysis) {
          spDailyReportRender(data);
        } else {
          $('#sp-dr-empty').removeClass('d-none');
          $('#sp-dr-content').addClass('d-none');
          $('#sp-dr-meta').addClass('d-none');
          $('#sp-dr-date').text('—');
        }
      })
      .fail(function () {
        $('#sp-dr-empty').removeClass('d-none');
      });
  }

  function spDailyReportLoadDate(date) {
    $('#sp-dr-empty').addClass('d-none');
    $('#sp-dr-content').addClass('d-none');
    $('#sp-dr-loading').removeClass('d-none');
    $.getJSON('/api/daily-report/history?days=90')
      .done(function (history) {
        // fetch the full report for this date
        $.ajax({
          url: '/api/daily-report/generate',
          method: 'POST',
          contentType: 'application/json',
          data: JSON.stringify({ date: date }),
          timeout: window.getOperationalTimeoutMs('script_report'),
        })
        .done(function (data) {
          spDailyReportRender(data);
        })
        .fail(function (xhr) {
          $('#sp-dr-loading').addClass('d-none');
          $('#sp-dr-empty').removeClass('d-none');
        });
      });
  }

  function spDailyReportGenerate(date) {
    $('#sp-dr-empty').addClass('d-none');
    $('#sp-dr-content').addClass('d-none');
    $('#sp-dr-meta').addClass('d-none');
    $('#sp-dr-loading').removeClass('d-none');
    setBtnLoading('#sp-dr-btn-generate', true);

    $.ajax({
      url: '/api/daily-report/generate' + (date ? '?date=' + date : ''),
      method: 'POST',
      timeout: window.getOperationalTimeoutMs('script_report'),
    })
    .done(function (data) {
      spDailyReportRender(data);
      spDailyReportLoadHistory();
    })
    .fail(function (xhr) {
      $('#sp-dr-loading').addClass('d-none');
      const msg = xhr.responseJSON ? (xhr.responseJSON.detail || 'Error desconocido') : 'Error generando informe';
      $('#sp-dr-empty').removeClass('d-none').find('small').text(msg);
    })
    .always(function () {
      setBtnLoading('#sp-dr-btn-generate', false);
    });
  }

  function spDailyReportRender(data) {
    $('#sp-dr-loading').addClass('d-none');
    $('#sp-dr-empty').addClass('d-none');
    $('#sp-dr-date').text(data.report_date || '—');

    // Meta KPIs
    const meta = data.meta || {};
    if (Object.keys(meta).length) {
      const scriptsOk    = meta.scripts_ok    != null ? meta.scripts_ok    : '?';
      const scriptsTotal = meta.scripts_count != null ? meta.scripts_count : '?';
      const scriptsColor = (meta.scripts_ok === meta.scripts_count && meta.scripts_count > 0)
                           ? 'text-success' : 'text-warning';
      $('#sp-dr-online').text(meta.online_today_count != null ? meta.online_today_count : '?');
      $('#sp-dr-scans').text(meta.scans_count != null ? meta.scans_count : '?');
      $('#sp-dr-new').text(meta.new_devices != null ? meta.new_devices : '0');
      $('#sp-dr-scripts')
        .text(scriptsOk + ' / ' + scriptsTotal)
        .removeClass('text-success text-warning text-danger')
        .addClass(scriptsColor);
      $('#sp-dr-meta').removeClass('d-none');
    }

    // Análisis
    $('#sp-dr-analysis').html(spRenderMD(data.analysis || '(Sin análisis)'));
    $('#sp-dr-content').removeClass('d-none');

    // Footer
    const genAt  = data.generated_at ? fmtDate(data.generated_at) : '';
    const prov   = (data.provider || '') + (data.model ? ' · ' + data.model : '');
    $('#sp-dr-footer').text((prov ? prov + ' · ' : '') + (genAt ? 'Generado ' + genAt : ''));
  }

  function spDailyReportLoadHistory() {
    $.getJSON('/api/daily-report/history?days=14')
      .done(function (history) {
        const $sel = $('#sp-dr-history-select');
        $sel.find('option:not(:first)').remove();
        history.forEach(function (r) {
          const meta    = r.meta || {};
          const label   = r.report_date + ' (' + (meta.online_today_count || '?') + ' online)';
          $sel.append($('<option>').val(r.report_date).text(label));
        });
      });
  }


});