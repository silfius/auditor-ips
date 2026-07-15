// ════════════════════════════════════════════════════════
//  dashboard.js — Auditor IPs  (Sesión 27 — rewrite)
//  Layout: CSS Grid 12 columnas — sin .row de Bootstrap
//  Widgets: grafica · kpis · servicios · automatizaciones · syncthing · eventos · offline
// ════════════════════════════════════════════════════════
$(function () {

  // ── Estado global ─────────────────────────────────────────────────────────
  let dashChart  = null;
  let _dashRange = 1;

  function _perfTraceId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function _perfRound(ms) {
    return Math.round(Number(ms || 0) * 10) / 10;
  }

  let _dashIncidentStreakMin = 3;

  function _dashFmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
  }

  function _dashFmtRate(bytesPerSecond) {
    return `${_dashFmtBytes(bytesPerSecond)}/s`;
  }

  function _dashFmtTime(value) {
    if (!value) return '—';
    if (typeof window.fmtTime === 'function') return window.fmtTime(value);
    return '—';
  }

  function _dashFmtDate(value) {
    if (!value) return '—';
    if (typeof window.fmtDate === 'function') return window.fmtDate(value);
    return '—';
  }

  function _dashFmtDateTime(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') return window.fmtDateTime(value);
    return '—';
  }

  function _dashIsIncidentPoint(point) {
    return !!point && (point.latency_ms == null || Number(point.packet_loss || 0) > 0);
  }

  function _dashBuildIncidentTsSet(points) {
    const ts = new Set();
    const rows = Array.isArray(points) ? points : [];
    let start = -1;

    for (let i = 0; i < rows.length; i++) {
      if (_dashIsIncidentPoint(rows[i])) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if ((i - start) >= _dashIncidentStreakMin) {
          for (let j = start; j < i; j++) {
            if (rows[j]?.checked_at) ts.add(rows[j].checked_at);
          }
        }
        start = -1;
      }
    }

    if (start >= 0 && (rows.length - start) >= _dashIncidentStreakMin) {
      for (let j = start; j < rows.length; j++) {
        if (rows[j]?.checked_at) ts.add(rows[j].checked_at);
      }
    }

    return ts;
  }

  const DASH_QUALITY_MARKERS_KEY = 'auditor-dash-quality-markers';
  let _dashShowQualityMarkers = localStorage.getItem(DASH_QUALITY_MARKERS_KEY) !== '0';
  let _dashLastDashboardPayload = null;
  let _dashLastQualityPayload = null;

  function _ensureDashQualityMarkersToggle() {
    const host = document.querySelector('.dash-widget-actions.dash-chart-controls');
    if (!host) return;

    let wrap = document.getElementById('dashQualityMarkersWrap');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.id = 'dashQualityMarkersWrap';
      wrap.className = 'small-muted d-inline-flex align-items-center gap-2 ms-2';
      wrap.style.cssText = 'font-size:.74rem;cursor:pointer;user-select:none;';
      wrap.innerHTML = `
        <input class="form-check-input mt-0" type="checkbox" id="dashQualityMarkersToggle">
        <span>${window.t ? window.t('dash.show_incidents') : 'Mostrar incidencias en racha'}</span>
      `;
      const btnGroup = host.querySelector('.btn-group');
      if (btnGroup) host.insertBefore(wrap, btnGroup);
      else host.appendChild(wrap);
    }

    const input = document.getElementById('dashQualityMarkersToggle');
    if (input) input.checked = !!_dashShowQualityMarkers;
  }

  $(document).off('change', '#dashQualityMarkersToggle').on('change', '#dashQualityMarkersToggle', function () {
    _dashShowQualityMarkers = !!this.checked;
    try { localStorage.setItem(DASH_QUALITY_MARKERS_KEY, _dashShowQualityMarkers ? '1' : '0'); } catch (_) {}
    if (_dashLastDashboardPayload && _dashLastQualityPayload) {
      _renderDashboard(_dashLastDashboardPayload, _dashLastQualityPayload);
    } else if (typeof window.loadDashboard === 'function') {
      window.loadDashboard();
    }
  });

  // Caché de datos quality por rango (igual que quality.js)
  const _dashQCache = {};


  function _setTextIfChanged(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const next = String(value ?? '');
    if (el.textContent !== next) el.textContent = next;
  }

  function _setHtmlIfChanged(id, html) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  const DASH_PROC_VIEW_KEY = 'auditor-dash-proc-view';
  let _dashProcView = localStorage.getItem(DASH_PROC_VIEW_KEY) || 'compact';

  function _syncProcViewButtons() {
    document.querySelectorAll('.dash-proc-view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === _dashProcView);
    });
  }

  function _procStateMeta(rawState) {
    const st = String(rawState || 'unknown').toLowerCase();
    const map = {
      ok:      { dot: '#4dffb5', pill: 'ok',      label: 'OK',          icon: 'bi-check2-circle' },
      success: { dot: '#4dffb5', pill: 'ok',      label: 'OK',          icon: 'bi-check2-circle' },
      error:   { dot: '#ff6b6b', pill: 'bad',     label: 'Error',       icon: 'bi-x-circle' },
      failed:  { dot: '#ff6b6b', pill: 'bad',     label: 'Error',       icon: 'bi-x-circle' },
      missed:  { dot: '#ff8a65', pill: 'warn',    label: 'Missed',      icon: 'bi-exclamation-circle' },
      stalled: { dot: '#ffc107', pill: 'warn',    label: 'Stalled',     icon: 'bi-pause-circle' },
      running: { dot: '#66c2ff', pill: 'neutral', label: 'Running',     icon: 'bi-arrow-repeat' },
      unknown: { dot: 'rgba(255,255,255,.28)', pill: 'neutral', label: 'Desconocido', icon: 'bi-question-circle' },
    };
    return map[st] || map.unknown;
  }

  function _dashProcT(key, fallback) {
    return window.t ? window.t(key, fallback) : fallback;
  }

  function _dashStT(key, fallback) {
    return window.t ? window.t(key, fallback) : fallback;
  }

  function _procStateLabel(state, fallback) {
    const st = String(state || 'unknown').toLowerCase();
    const keyMap = {
      ok: 'dash.proc.state_ok',
      error: 'dash.proc.state_error',
      failed: 'dash.proc.state_error',
      missed: 'dash.proc.state_missed',
      stalled: 'dash.proc.state_stalled',
      running: 'dash.proc.state_running',
      unknown: 'dash.proc.state_unknown',
    };
    return _dashProcT(keyMap[st] || 'dash.proc.state_unknown', fallback || 'Unknown');
  }

  function _renderProcesosHtml(scripts) {
    if (!scripts.length) {
      return _emptyDashState('bi-cpu', _dashProcT('dash.proc.empty_title', 'Sin automatizaciones'), _dashProcT('dash.proc.empty_sub', 'No hay procesos configurados para mostrar en el dashboard.'));
    }

    if (_dashProcView === 'detail') {
      return `<div class="dash-proc-grid is-detail">${scripts.map(s => {
        const meta = _procStateMeta(s.state);
        const label = esc(s.cfg_label || s.label || s.name || '—');
        const color = s.cfg_color || meta.dot;
        const startIso = s.start_time || s.last_run || '';
        const nextIso = s.next_run || '';
        const durationS = Number.isFinite(Number(s.duration_seconds)) ? Number(s.duration_seconds) : null;
        const endIso = s.end_time || s.finished_at || s.ended_at || _calcEndIso(startIso, durationS);
        const ago = startIso ? _fmtAgo(startIso) : '—';
        const errorLine = Array.isArray(s.errors) && s.errors.length
          ? `<div class="dash-proc-sub is-danger"><i class="bi bi-exclamation-triangle"></i> ${esc(String(s.errors[0]).slice(0, 120))}</div>`
          : '';
        return `<article class="dash-proc-card" style="--proc-color:${color}">
          <div class="dash-proc-top">
            <span class="dash-proc-dot"></span>
            <div class="dash-proc-main">
              <div class="dash-proc-title">
                <span>${label}</span>
                <span class="dash-pill ${meta.pill}"><i class="bi ${meta.icon}"></i>${_procStateLabel(s.state, meta.label)}</span>
                ${s.exit_code != null ? `<span class="dash-pill neutral">exit ${esc(String(s.exit_code))}</span>` : ''}
              </div>
              <div class="dash-proc-sub">${esc(s.name || '')}${s.cfg_label ? ` · ${esc(s.name || '')}` : ''}</div>
              ${errorLine}
            </div>
            <div class="dash-proc-ago">${esc(ago)}</div>
          </div>
          <div class="dash-proc-times">
            <div class="dash-proc-time"><span class="dash-proc-time-label">${_dashProcT('dash.proc.start', 'Inicio')}</span><span class="dash-proc-time-value">${esc(_fmtDateTime(startIso))}</span></div>
            <div class="dash-proc-time"><span class="dash-proc-time-label">${_dashProcT('dash.proc.next', 'Próxima')}</span><span class="dash-proc-time-value">${esc(_fmtDateTime(nextIso))}</span></div>
            <div class="dash-proc-time"><span class="dash-proc-time-label">${_dashProcT('dash.proc.end', 'Fin')}</span><span class="dash-proc-time-value">${esc(_fmtDateTime(endIso))}</span></div>
            <div class="dash-proc-time"><span class="dash-proc-time-label">${_dashProcT('dash.proc.duration', 'Duración')}</span><span class="dash-proc-time-value">${esc(_fmtDuration(durationS))}</span></div>
          </div>
        </article>`;
      }).join('')}</div>`;
    }

    return `<div class="dash-proc-compact">${scripts.map(s => {
      const meta = _procStateMeta(s.state);
      const label = esc(s.cfg_label || s.label || s.name || '—');
      const color = s.cfg_color || meta.dot;
      const startIso = s.start_time || s.last_run || '';
      const nextIso = s.next_run || '';
      const durationS = Number.isFinite(Number(s.duration_seconds)) ? Number(s.duration_seconds) : null;
      const ago = startIso ? _fmtAgo(startIso) : '—';
      const chips = [
        startIso ? `<span class="dash-proc-chip"><i class="bi bi-play-circle"></i>${esc(_fmtDateTime(startIso))}</span>` : '',
        nextIso ? `<span class="dash-proc-chip"><i class="bi bi-clock-history"></i>${esc(_fmtDateTime(nextIso))}</span>` : '',
        `<span class="dash-proc-chip"><i class="bi bi-stopwatch"></i>${esc(_fmtDuration(durationS))}</span>`,
      ].filter(Boolean).join('');
      const errorLine = Array.isArray(s.errors) && s.errors.length
        ? `<div class="dash-proc-row-note"><i class="bi bi-exclamation-triangle"></i> ${esc(String(s.errors[0]).slice(0, 110))}</div>`
        : '';
      return `<article class="dash-proc-row" style="--proc-color:${color}">
        <div class="dash-proc-row-head">
          <div class="dash-proc-row-title">
            <span class="dash-proc-row-dot"></span>
            <span class="dash-proc-row-name">${label}</span>
            <span class="dash-pill ${meta.pill}"><i class="bi ${meta.icon}"></i>${_procStateLabel(s.state, meta.label)}</span>
            ${s.exit_code != null ? `<span class="dash-pill neutral">exit ${esc(String(s.exit_code))}</span>` : ''}
          </div>
          <span class="dash-proc-row-ago">${esc(ago)}</span>
        </div>
        <div class="dash-proc-row-sub">${esc((s.cfg_label && s.name && s.cfg_label !== s.name) ? s.name : (s.step_label || _dashProcT('dash.proc.last_monitored', 'Última ejecución monitorizada desde el dashboard')))}</div>
        <div class="dash-proc-row-chips">${chips}</div>
        ${errorLine}
      </article>`;
    }).join('')}</div>`;
  }

  window.loadDashboard = async function loadDashboard() {
    const el = document.getElementById('dashLastUpdate');
    if (el) el.textContent = window.t?.('status.loading', 'Cargando…') || 'Cargando…';
    try {
      const qCached = _dashQCache[_dashRange];
      const [resD, resQ] = await Promise.all([
        fetch(`/api/dashboard?days=${_dashRange}&_=${Date.now()}`, { cache: 'no-store' }),
        qCached ? Promise.resolve(null) : fetch(`/api/quality/history?days=${_dashRange}&_=${Date.now()}`, { cache: 'no-store' }),
      ]);

      if (!resD.ok) {
        if (el) el.textContent = `${window.t?.('dashboard.error_prefix', 'Error:') || 'Error:'} HTTP ${resD.status}`;
        return;
      }

      const d = await resD.json();
      let q = qCached;
      if (!q) {
        q = (resQ && resQ.ok) ? await resQ.json() : { ok: false, targets: [] };
        if (q?.ok) _dashQCache[_dashRange] = q;
      }

      if (!d?.ok) {
        if (el) el.textContent = d?.error || window.t?.('dashboard.no_data_first_scan', 'Sin datos — realiza un primer escaneo') || 'Sin datos — realiza un primer escaneo';
        return;
      }

      _renderDashboard(d, q);
    } catch (e) {
      console.error('[Dashboard]', e);
      const el2 = document.getElementById('dashLastUpdate');
      if (el2) el2.textContent = (window.t?.('dashboard.error_prefix', 'Error:') || 'Error:') + ' ' + e.message;
    }
  };

  const _dashLossVLinesPlugin = {
    id: 'dashLossVLines',
    afterDatasetsDraw(chart) {
      try {
        const lossIdx    = chart.config._lossIndexes    || [];
        const timeoutIdx = chart.config._timeoutIndexes || [];
        if (!lossIdx.length && !timeoutIdx.length) return;
        const ctx  = chart.ctx;
        const x    = chart.scales.x;
        const area = chart.chartArea;
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,60,60,0.85)';
        for (const i of timeoutIdx) {
          const xp = x.getPixelForValue(i);
          if (!isFinite(xp)) continue;
          ctx.beginPath();
          ctx.moveTo(xp, area.top);
          ctx.lineTo(xp, area.bottom);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255,193,7,0.7)';
        ctx.lineWidth = 1;
        for (const i of lossIdx) {
          const xp = x.getPixelForValue(i);
          if (!isFinite(xp)) continue;
          ctx.beginPath();
          ctx.moveTo(xp, area.top);
          ctx.lineTo(xp, area.bottom);
          ctx.stroke();
        }
        ctx.restore();
      } catch(e) {}
    }
  };

  function _emptyDashState(icon, title, text) {
    return `<div class="dash-empty-state">
      <i class="bi ${icon}"></i>
      <div>
        <strong>${esc(title)}</strong>
        <div>${esc(text)}</div>
      </div>
    </div>`;
  }

  function _renderDashboard(d, q) {
    try {
      _dashLastDashboardPayload = d;
      _dashLastQualityPayload = q;
      _ensureDashQualityMarkersToggle();
      _setTextIfChanged('dashLastUpdate', 'Actualizado: ' + _dashFmtTime(new Date()));

      // KPIs
      _setTextIfChanged('dKpiOnline', d.hosts.online);
      _setTextIfChanged('dKpiOffline', d.hosts.offline);
      _setTextIfChanged('dKpiUnknown', d.hosts.unknown);
      _setTextIfChanged('dKpiUptime', d.uptime_avg_7d  != null ? d.uptime_avg_7d  + '%'   : '—');
      _setTextIfChanged('dKpiLatency', d.latency_avg_ms != null ? d.latency_avg_ms + 'ms' : '—');
      _setTextIfChanged('dKpiScans', d.scans_today);

      // Servicios
      const svcs  = d.services.list || [];
      const badge = d.services.down > 0
        ? `<span class="dash-pill bad">${d.services.down} caído${d.services.down > 1 ? 's' : ''}</span>`
        : `<span class="dash-pill ok">${d.services.up} arriba</span>`;
      _setHtmlIfChanged('dSvcBadge', badge);
      _setHtmlIfChanged('dSvcList', svcs.length
        ? `<div class="dash-list-stack">${svcs.map(s => {
            const st   = (s.last_status || 'unknown').toLowerCase();
            const url  = s.access_url  || `http://${s.host}:${s.port}`;
            const icon = (typeof SVC_TYPE_ICONS !== 'undefined' && SVC_TYPE_ICONS[s.service_type]) || '🔌';
            const tone = st === 'up' ? 'ok' : (st === 'down' ? 'bad' : 'neutral');
            const latency = s.last_latency != null ? `${s.last_latency}ms` : '—';
            const checkedAt = s.last_checked
              ? _dashFmtTime(s.last_checked)
              : 'Sin check';
            return `<div class="dash-list-card">
              <div class="dash-list-icon ${st === 'down' ? 'is-danger' : ''}">${icon}</div>
              <div class="dash-list-main">
                <div class="dash-list-title">
                  <a href="${esc(url)}" target="_blank">${esc(s.name)}</a>
                  <span class="dash-pill ${tone}">${esc(st === 'up' ? 'OK' : st === 'down' ? 'DOWN' : st || '—')}</span>
                </div>
                <div class="dash-list-sub">${esc(s.host)}:${esc(String(s.port))} · ${esc(s.service_type || 'servicio')} · último check ${esc(checkedAt)}</div>
              </div>
              <div class="dash-list-side">
                <span class="dash-latency-pill">${esc(latency)}</span>
              </div>
            </div>`;
          }).join('')}</div>`
        : _emptyDashState('bi-hdd-rack', 'Sin servicios configurados', 'Añade servicios monitorizados para verlos aquí.'));

      // Eventos
      const EVENT_CFG = {
        new:              { pill: 'ep-new',    label: 'NUEVO',  desc: h => `${h} detectado por primera vez` },
        status:           { pill: 'ep-status', label: v => (v || '').toUpperCase(), desc: (h, v) => `${h} → ${v}` },
        mac:              { pill: 'ep-mac',    label: 'MAC',    desc: (h, v) => `${h} cambió MAC → ${v || '?'}` },
        ip_change:        { pill: 'ep-other',  label: 'IP',     desc: (h, v) => `Cambio IP: ${v || '?'}` },
        ip_change_arrived:{ pill: 'ep-other',  label: 'IP',     desc: (h, v) => `Nueva IP: ${v || '?'}` },
        new_silent:       { pill: 'ep-new',    label: 'SILENT', desc: h => `${h} visto por router (no nmap)` },
        delete:           { pill: 'ep-status', label: 'DEL',    desc: h => `${h} eliminado` },
      };

      const relevant = (d.recent_events || []).filter(e => {
        if (e.event_type === 'status') {
          const v = (e.new_value || '').toLowerCase();
          return v !== 'online' && v !== 'online_silent';
        }
        if (['notes', 'manual', 'type', 'known', 'wol'].includes(e.event_type)) return false;
        return true;
      });

      _setHtmlIfChanged('dEventList', relevant.length
        ? `<div class="dash-list-stack">${relevant.map(e => {
            const cfg  = EVENT_CFG[e.event_type];
            const pill = cfg ? cfg.pill : 'ep-other';
            const lbl  = cfg
              ? (typeof cfg.label === 'function' ? cfg.label(e.new_value) : cfg.label)
              : e.event_type.toUpperCase().slice(0, 8);
            let desc;
            if (cfg?.desc) {
              try { desc = cfg.desc(e.host_name, e.new_value); }
              catch { desc = e.host_name || 'Host'; }
            } else {
              desc = `${e.host_name || 'Host'}${e.new_value ? ` → ${e.new_value}` : ''}`;
            }
            return `<div class="dash-list-card">
              <div class="dash-list-icon ${pill === 'ep-status' ? 'is-warning' : ''}">
                <i class="bi bi-activity"></i>
              </div>
              <div class="dash-list-main">
                <div class="dash-list-title">
                  <span class="event-pill ${pill}">${esc(lbl)}</span>
                  <span>${esc(desc)}</span>
                </div>
                <div class="dash-list-sub">${esc(e.host_name || 'Host')} · ${esc(e.event_type || 'evento')}</div>
              </div>
              <div class="dash-list-side">
                <span>${esc(e.at_local || '—')}</span>
              </div>
            </div>`;
          }).join('')}</div>`
        : _emptyDashState('bi-activity', 'Sin eventos relevantes', 'No ha habido cambios importantes en las últimas 24 horas.'));

      // Offline
      _setHtmlIfChanged('dOfflineList', d.long_offline.length
        ? `<div class="dash-list-stack">${d.long_offline.map(h => `
            <div class="dash-list-card">
              <div class="dash-list-icon is-danger"><i class="bi bi-wifi-off"></i></div>
              <div class="dash-list-main">
                <div class="dash-list-title">${esc(h.name)}</div>
                <div class="dash-list-sub">Host sin respuesta continuada</div>
              </div>
              <div class="dash-list-side">
                <span class="dash-pill bad">${esc(h.ago)}</span>
              </div>
            </div>
          `).join('')}</div>`
        : _emptyDashState('bi-check2-circle', 'Sin hosts críticos offline', 'Ahora mismo no hay equipos destacados por caída prolongada.'));

      _renderQualityChart(q);

    } catch (e) {
      console.error('[Dashboard render]', e);
    }
  }

  function _renderQualityChart(q) {
    _dashIncidentStreakMin = Math.max(2, parseInt(q?.incident_streak_min, 10) || _dashIncidentStreakMin || 3);
    _ensureDashQualityMarkersToggle();
    const ctx = document.getElementById('dashChart');
    if (!ctx) return;

    const showMarkers = !!_dashShowQualityMarkers;
    const targets  = (q?.ok && q.targets) ? q.targets : [];
    const PALETTE  = ['#4e91d4', '#f0ad4e', '#5cb85c', '#d9534f', '#9b59b6', '#1abc9c'];
    const allTsSet = new Set();
    targets.forEach(t => (t.data || []).forEach(c => allTsSet.add(c.checked_at)));
    const allTs = [...allTsSet].sort();
    const incidentTsSets = targets.map(t => _dashBuildIncidentTsSet(t.data || []));

    const datasets = targets.map((t, i) => {
      const m = {};
      (t.data || []).forEach(c => { m[c.checked_at] = c; });
      return {
        label: t.name || t.host,
        data:  allTs.map(ts => { const c = m[ts]; return c ? (c.latency_ms ?? null) : null; }),
        borderColor:     PALETTE[i % PALETTE.length],
        backgroundColor: 'transparent',
        borderWidth:     1.5,
        pointRadius: allTs.map(ts => {
          const c = m[ts];
          if (!c) return 0;
          if (showMarkers && incidentTsSets[i].has(ts)) return 4;
          return (allTs.length > 200 ? 0 : 1);
        }),
        pointBackgroundColor: allTs.map(ts => {
          const c = m[ts];
          if (!c) return 'transparent';
          if (showMarkers && incidentTsSets[i].has(ts)) return 'rgba(255,193,7,0.92)';
          return PALETTE[i % PALETTE.length];
        }),
        tension:  0.2,
        spanGaps: true,
      };
    });

    // Compute incident streak indexes for vertical line plugin
    const _dashTimeoutIdx = [];
    const _dashLossIdx    = [];
    if (showMarkers && targets.length > 0) {
      allTs.forEach((ts, i) => {
        if (incidentTsSets.some(set => set.has(ts))) _dashLossIdx.push(i);
      });
    }

    const labels = allTs.map(ts => {
      try {
        const dt = new Date(ts);
        return _dashRange === 1
          ? _dashFmtTime(dt)
          : _dashFmtDate(dt);
      } catch { return ts; }
    });

    const sub = document.getElementById('dashChartSubtitle');
    if (sub) {
      const total = targets.reduce((a, t) => a + (t.data || []).length, 0);
      const rangeText = _dashRange === 1
        ? (window.t?.('dashboard.range_today', 'hoy') || 'hoy')
        : (window.t?.('dashboard.range_last_days', 'últimos {days} días', { days: _dashRange }) || `últimos ${_dashRange} días`);
      sub.textContent = window.t?.('dashboard.quality_subtitle', '{range} · {total} checks · {targets} destinos', {
        range: rangeText,
        total,
        targets: targets.length
      }) || `${rangeText} · ${total} checks · ${targets.length} destinos`;
    }

    const maxTicks = _dashRange === 1 ? 8 : (_dashRange === 7 ? 7 : 10);
    const chartCfg = {
      plugins: [_dashLossVLinesPlugin],
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: targets.length > 1, labels: { color: 'rgba(255,255,255,0.7)', font: { size: 10 } } },
          tooltip: {
            callbacks: {
              title: items => labels[items[0].dataIndex] || '',
              label: item => {
                const t  = targets[item.datasetIndex];
                const ts = allTs[item.dataIndex];
                const c  = ts && t ? (t.data || []).find(d => d.checked_at === ts) : null;
                if (!c) return `${item.dataset.label}: N/A`;
                if (c.latency_ms == null) return `${item.dataset.label}: ⏱ Timeout`;
                let txt = `${item.dataset.label}: ${c.latency_ms}ms`;
                if (c.packet_loss > 0) txt += ` (pérdida ${c.packet_loss}%)`;
                return txt;
              },
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 }, maxRotation: 0, maxTicksLimit: maxTicks } },
          y: { suggestedMin: 0, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 }, callback: v => v + 'ms' } }
        }
      }
    };

    if (dashChart) {
      // Update suave — sin destroy (evita parpadeo)
      dashChart.data    = chartCfg.data;
      dashChart.options = chartCfg.options;
      dashChart.config._lossIndexes    = _dashLossIdx;
      dashChart.config._timeoutIndexes = _dashTimeoutIdx;
      dashChart.update('none');
    } else {
      dashChart = new Chart(ctx, chartCfg);
      dashChart.config._lossIndexes    = _dashLossIdx;
      dashChart.config._timeoutIndexes = _dashTimeoutIdx;
    }
    dashChart.resize();
  }

  // Range selector — invalida caché del nuevo rango para forzar datos frescos
  $(document).on('click', '.dash-range-btn', function () {
    $('.dash-range-btn').removeClass('active');
    $(this).addClass('active');
    const newRange = parseInt($(this).data('range')) || 1;
    if (newRange !== _dashRange) {
      // Destruir chart al cambiar rango para que se cree con nueva escala temporal
      if (dashChart) { dashChart.destroy(); dashChart = null; }
      delete _dashQCache[newRange];  // forzar fetch fresco del nuevo rango
    }
    _dashRange = newRange;
    loadDashboard();
  });

  $('#dashRefresh').on('click', loadDashboard);
  document.getElementById('dashboard-tab').addEventListener('shown.bs.tab', loadDashboard);

  let _dashMainRefreshTimer = null;
  function _dashRefreshMs(scope) {
    return window.getFrontendRefreshMs(scope);
  }
  function _startDashboardMainRefreshTimer() {
    if (_dashMainRefreshTimer) clearInterval(_dashMainRefreshTimer);
    _dashMainRefreshTimer = setInterval(() => {
      if (document.getElementById('dashboardView')?.classList.contains('show')) loadDashboard();
    }, _dashRefreshMs('dashboard'));
  }

  setTimeout(loadDashboard, 500);
  _startDashboardMainRefreshTimer();
  document.addEventListener('frontendrefreshsettingschange', _startDashboardMainRefreshTimer);


  // ══════════════════════════════════════════════════════════
  //  LAYOUT — CSS Grid 12 columnas
  //
  //  Cada .dash-widget-wrap es hijo DIRECTO de #dashSortableContainer.
  //  El tamaño se controla exclusivamente con grid-column: span N.
  //
  //  Por qué esto funciona y el sistema anterior no:
  //  - Antes: cada widget vivía dentro de <div class="row"><div class="col-...">
  //    Bootstrap .row tiene margin: -12px que hace que el elemento desborde
  //    su flex-basis, rompiendo el flex-wrap. Solo el primer widget se veía bien.
  //  - Ahora: CSS Grid gestiona la colocación. span N = exactamente N/12 del ancho.
  //    No hay márgenes negativos, no hay cálculos de flex-basis, no hay bugs.
  //
  //  SortableJS reordena los nodos DOM. El grid reposiciona automáticamente.
  // ══════════════════════════════════════════════════════════

  const WIDGET_LABELS = {
    grafica:   '📈 ' + (window.t ? window.t('dash.network_quality') : 'Calidad de red'),
    kpis:      '📊 KPIs',
    servicios: '⚙️ Servicios',
    system_health: '🩺 Salud sistema',
    procesos:  '🤖 Automatizaciones',
    syncthing: '🔁 Syncthing',
    eventos:   '📋 Eventos',
    offline:   '🔴 Offline',
  };

  // Spans por defecto (de 12 columnas):
  // grafica(8) + offline(4)                    → fila 1
  // kpis(12)                                   → fila 2 (full)
  // servicios(4) + automatizaciones(4) + syncthing(6) + eventos(4) → filas inferiores
  const WIDGET_DEFAULT_COLS = {
    grafica:   8,
    kpis:      12,
    servicios: 4,
    system_health: 6,
    procesos:  4,
    syncthing: 6,
    eventos:   4,
    offline:   4,
  };

  function _dashModuleEnabled(moduleId) {
    return typeof window.moduleEnabled === 'function' ? window.moduleEnabled(moduleId, true) : true;
  }

  const WIDGET_MODULES = {
    grafica: 'quality',
    servicios: 'services',
    procesos: 'automation',
    syncthing: 'syncthing',
  };

  function _dashWidgetAllowed(widgetId) {
    const moduleId = WIDGET_MODULES[widgetId];
    return moduleId ? _dashModuleEnabled(moduleId) : true;
  }

  let _dashLayout = {};
  let _editMode   = false;
  let _layoutFetched = false;  // true once loadDashLayout() has completed at least once

  async function loadDashLayout() {
    try {
      const res  = await fetch('/api/dashboard/layout');
      const d    = await res.json();
      const raw  = d.layout || '{}';
      _dashLayout = typeof raw === 'string' ? (JSON.parse(raw) || {}) : (raw || {});
    } catch { _dashLayout = {}; }
    _layoutFetched = true;
    applyDashLayout();
  }

  async function saveDashLayout() {
    const container = document.getElementById('dashSortableContainer');
    const order = container
      ? Array.from(container.querySelectorAll(':scope > .dash-widget-wrap[data-widget-id]'))
          .map(el => el.dataset.widgetId)
      : [];
    const payload = { ..._dashLayout };
    if (order.length) payload.widget_order = order;
    await fetch('/api/dashboard/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: payload })
    });
  }

  function applyDashLayout() {
    document.querySelectorAll('#dashSortableContainer > .dash-widget-wrap[data-widget-id]')
      .forEach(el => {
        const key    = el.dataset.widgetId;
        const hidden = _dashLayout[key] === false || !_dashWidgetAllowed(key);
        el.style.display = hidden ? 'none' : '';
        if (!hidden) {
          const cols = _dashLayout[`${key}_cols`] || WIDGET_DEFAULT_COLS[key] || 12;
          _applyWidgetCols(el, cols);
        }
      });
  }

  /**
   * Ajusta el ancho del widget cambiando grid-column: span N directamente en
   * el .dash-widget-wrap. El elemento ES el hijo del grid — sin parentElement.
   */
  function _applyWidgetCols(el, cols) {
    const c = Math.max(1, Math.min(12, parseInt(cols) || 12));
    el.style.gridColumn = `span ${c}`;
    el.dataset.cols = c;
    el.querySelectorAll('.dash-width-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.cols) === c);
    });
  }

  // ── Modo edición ──────────────────────────────────────────────────────────
  function renderWidgetToggles() {
    const wrap = document.getElementById('widgetToggles');
    if (!wrap) return;
    const hidden = Object.entries(WIDGET_LABELS).filter(([k]) => _dashLayout[k] === false && _dashWidgetAllowed(k));
    if (!hidden.length) {
      wrap.innerHTML = '<span class="small-muted" style="font-size:.75rem">Todos los widgets son visibles.</span>';
      return;
    }
    wrap.innerHTML = '<span class="small-muted me-1" style="font-size:.75rem">Ocultos:</span>';
    hidden.forEach(([key, label]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-outline-secondary';
      btn.innerHTML = `<i class="bi bi-eye me-1"></i>${label}`;
      btn.addEventListener('click', async () => {
        _dashLayout[key] = true;
        applyDashLayout();
        renderWidgetToggles();
        await saveDashLayout();
      });
      wrap.appendChild(btn);
    });
  }

  // ── SortableJS sobre el grid container ────────────────────────────────────
  let _sortableInst = null;

  function _applyWidgetOrder(order) {
    if (!order?.length) return;
    const c = document.getElementById('dashSortableContainer');
    if (!c) return;
    order.forEach(id => {
      const el = c.querySelector(`:scope > .dash-widget-wrap[data-widget-id="${id}"]`);
      if (el) c.appendChild(el);
    });
  }

  function _initSortable() {
    const c = document.getElementById('dashSortableContainer');
    if (!c || typeof Sortable === 'undefined') return;
    if (_sortableInst) { _sortableInst.destroy(); _sortableInst = null; }
    _sortableInst = Sortable.create(c, {
      animation:  150,
      ghostClass: 'sortable-ghost',
      dragClass:  'sortable-drag',
      draggable:  '.dash-widget-wrap',
      handle:     '.dash-drag-icon',
      disabled:   true,
      onEnd: async () => {
        const order = Array.from(c.querySelectorAll(':scope > .dash-widget-wrap[data-widget-id]'))
          .map(el => el.dataset.widgetId).filter(Boolean);
        _dashLayout.widget_order = order;
        await saveDashLayout();
      }
    });
  }

  (async () => {
    try {
      const res    = await fetch('/api/dashboard/layout');
      const data   = await res.json();
      const raw    = data.layout || '{}';
      const layout = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(layout.widget_order)) _applyWidgetOrder(layout.widget_order);
    } catch { /* sin orden guardado, usar el del HTML */ }
    _initSortable();
  })();

  function enterEditMode() {
    _editMode = true;
    document.getElementById('dashSortableContainer')?.classList.add('dash-edit-mode');
    document.getElementById('dashCustomPanel').style.display = '';
    const btn = document.getElementById('dashCustomize');
    btn.classList.remove('btn-outline-secondary');
    btn.classList.add('btn-warning');
    renderWidgetToggles();
    _sortableInst?.option('disabled', false);
  }

  function exitEditMode() {
    _editMode = false;
    document.getElementById('dashSortableContainer')?.classList.remove('dash-edit-mode');
    document.getElementById('dashCustomPanel').style.display = 'none';
    const btn = document.getElementById('dashCustomize');
    btn.classList.remove('btn-warning');
    btn.classList.add('btn-outline-secondary');
    saveDashLayout();
    _sortableInst?.option('disabled', true);
  }

  document.getElementById('dashCustomize')?.addEventListener('click', function () {
    if (window.APP_CONFIG?.auth_enabled && !window.APP_CONFIG?.is_admin) {
      if (typeof window.openLoginModal === 'function') window.openLoginModal();
      else window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      return;
    }
    if (_editMode) exitEditMode(); else enterEditMode();
  });
  document.getElementById('dashCustomizeDone')?.addEventListener('click', exitEditMode);

  $(document).on('click', '.dash-width-btn', function () {
    const key  = $(this).data('widget');
    const cols = parseInt($(this).data('cols'));
    _dashLayout[`${key}_cols`] = cols;
    const el = document.querySelector(`#dashSortableContainer > .dash-widget-wrap[data-widget-id="${key}"]`);
    if (el) _applyWidgetCols(el, cols);
  });

  $(document).on('click', '.dash-widget-hide-btn', async function () {
    const key = $(this).data('widget');
    _dashLayout[key] = false;
    applyDashLayout();
    renderWidgetToggles();
    await saveDashLayout();
  });

  document.getElementById('dashboard-tab')?.addEventListener('shown.bs.tab', loadDashLayout);
  if (document.getElementById('dashboardView')?.classList.contains('show')) loadDashLayout();

  window._getDashLayout = () => _dashLayout;
  window._setDashLayout = l  => { _dashLayout = l; };


  // ══════════════════════════════════════════════════════════
  //  WIDGET AUTOMATIZACIONES — GET /api/scripts/status
  //  Devuelve array directo de scripts con:
  //    name, state (ok|error|missed|stalled|running|unknown),
  //    cfg_label, cfg_color, last_run, next_run, errors, exit_code
  // ══════════════════════════════════════════════════════════

    

  let _systemHealthShowAll = false;

  function _systemHealthMeta(rawStatus) {
    const st = String(rawStatus || 'unknown').toLowerCase();
    const map = {
      ok:       { pill: 'ok',      icon: 'bi-check2-circle',       label: 'OK' },
      warning:  { pill: 'warn',    icon: 'bi-exclamation-triangle', label: 'Aviso' },
      error:    { pill: 'bad',     icon: 'bi-x-circle',            label: 'Error' },
      unknown:  { pill: 'neutral', icon: 'bi-question-circle',     label: 'Desconocido' },
      disabled: { pill: 'neutral', icon: 'bi-dash-circle',         label: 'Desactivado' },
    };
    return map[st] || map.unknown;
  }

  function _systemHealthCard(icon, status, title, subtitle, sideHtml, opts) {
    const meta = _systemHealthMeta(status);
    const iconTone = meta.pill === 'bad' ? 'is-danger' : (meta.pill === 'warn' ? 'is-warning' : '');
    const target = opts?.target ? String(opts.target) : '';
    const tooltip = opts?.tooltip ? String(opts.tooltip) : (subtitle || title || '');
    const classes = ['dash-list-card', 'dash-health-card'];
    if (target) classes.push('is-clickable');
    return `<div class="${classes.join(' ')}" data-health-status="${esc(String(status || 'unknown'))}" ${target ? `data-health-target="${esc(target)}"` : ''} title="${esc(tooltip)}">
      <div class="dash-list-icon ${iconTone}"><i class="bi ${icon}"></i></div>
      <div class="dash-list-main">
        <div class="dash-list-title">
          <span>${esc(title)}</span>
          <span class="dash-pill ${meta.pill}"><i class="bi ${meta.icon}"></i>${esc(meta.label)}</span>
        </div>
        <div class="dash-list-sub">${esc(subtitle || '—')}</div>
      </div>
      ${sideHtml ? `<div class="dash-list-side">${sideHtml}</div>` : ''}
    </div>`;
  }

  function _systemHealthRank(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'error') return 0;
    if (st === 'warning') return 1;
    if (st === 'unknown') return 2;
    if (st === 'disabled') return 3;
    return 4;
  }

  function _systemHealthIsAlarm(status) {
    const st = String(status || 'unknown').toLowerCase();
    return st === 'error' || st === 'warning' || st === 'unknown';
  }

  function _systemHealthOpenTarget(target) {
    const t = String(target || '').toLowerCase();

    const click = (selector) => {
      const el = document.querySelector(selector);
      if (el) el.click();
    };

    const openConfig = (section) => {
      const modalEl = document.getElementById('configModal');
      if (!modalEl || !window.bootstrap?.Modal) return;
      window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
      setTimeout(() => click(`.cfg-nav-btn[data-section="${section}"]`), 80);
    };

    const openInfra = (subtabSelector, loader) => {
      click('#infra-tab');
      setTimeout(() => {
        click(subtabSelector);
        if (loader && typeof window[loader] === 'function') window[loader](false);
      }, 80);
    };

    if (t === 'quality') {
      click('#quality-tab');
      return;
    }
    if (t === 'services') {
      openInfra('#infra-apps-tab', 'loadServices');
      return;
    }
    if (t === 'automations') {
      openInfra('#infra-auto-tab', null);
      return;
    }
    if (t === 'syncthing') {
      openInfra('#infra-syncthing-tab', 'loadSyncthingControl');
      return;
    }
    if (t === 'agents') {
      openConfig('scripts');
      return;
    }
    if (t === 'ai') {
      openConfig('ai');
      return;
    }
    if (t === 'notifications') {
      openConfig('notifications');
      return;
    }
    if (t === 'database' || t === 'storage' || t === 'backups') {
      openConfig('backup');
      return;
    }
    if (t === 'scheduler' || t === 'scans') {
      click('#tab-hosts');
      setTimeout(() => click('#hosts-scans-tab'), 80);
      return;
    }
    openConfig('system_health');
  }

  function _renderSystemHealthHtml(data) {
    const app = data?.app || {};
    const database = data?.database || {};
    const storage = data?.storage || {};
    const backups = data?.backups || {};
    const uptime = Number(app.uptime_seconds || 0);

    const entries = [];
    const addCard = (target, icon, status, title, subtitle, sideHtml, tooltip) => {
      entries.push({
        target,
        status: status || 'unknown',
        title,
        html: _systemHealthCard(icon, status || 'unknown', title, subtitle, sideHtml, { target, tooltip }),
      });
    };

    addCard(
      'system_health',
      'bi-cpu',
      app.name ? 'ok' : 'unknown',
      'Aplicación',
      `Uptime ${_fmtDuration(uptime)} · Python ${app.python || '—'}`,
      data?.generated_at ? `<span>${esc(_fmtDateTime(data.generated_at))}</span>` : '',
      `Aplicación viva. Generado ${data?.generated_at ? _fmtDateTime(data.generated_at) : '—'}.`
    );

    addCard(
      'database',
      'bi-database-check',
      database.status || 'unknown',
      'Base de datos',
      `SQLite ${_dashFmtBytes(database.size_bytes)} · WAL ${_dashFmtBytes(database.wal_bytes)} · ${database.latency_ms ?? '—'} ms`,
      database.sqlite?.freelist_bytes ? `<span class="dash-latency-pill">${esc(_dashFmtBytes(database.sqlite.freelist_bytes))} libre</span>` : '',
      `BD ${database.status || 'desconocida'}. Tamaño ${_dashFmtBytes(database.size_bytes)}. Latencia ${database.latency_ms ?? '—'} ms.`
    );

    addCard(
      'storage',
      'bi-device-hdd',
      storage.status || 'unknown',
      'Almacenamiento',
      `${storage.used_pct ?? '—'}% usado · ${_dashFmtBytes(storage.free_bytes)} libres`,
      `<span class="dash-latency-pill">${esc(_dashFmtBytes(storage.used_bytes))}</span>`,
      `Uso de /data ${storage.used_pct ?? '—'}%. Aviso ${storage.warning_pct ?? '—'}%, error ${storage.error_pct ?? '—'}%.`
    );

    const latestBackup = backups.latest?.mtime ? _fmtDateTime(backups.latest.mtime) : 'Sin backup detectado';
    addCard(
      'backups',
      'bi-archive',
      backups.status || 'unknown',
      'Backups',
      `${backups.count || 0} backup${Number(backups.count || 0) === 1 ? '' : 's'} · ${latestBackup}`,
      backups.latest?.size_bytes ? `<span class="dash-latency-pill">${esc(_dashFmtBytes(backups.latest.size_bytes))}</span>` : '',
      backups.latest?.filename ? `Último backup ${backups.latest.filename}, ${latestBackup}.` : 'No se detecta backup disponible.'
    );

    const scheduler = data?.scheduler || {};
    const scanJob = scheduler.scan_job || {};
    addCard(
      'scheduler',
      'bi-clock-history',
      scheduler.status || 'unknown',
      'Scheduler',
      `${scheduler.state || '—'} · ${Number(scheduler.job_count || 0)} jobs · ${scheduler.scan_job_present ? 'scan activo' : 'scan no registrado'}`,
      scanJob.next_run_time ? `<span>${esc(_fmtDateTime(scanJob.next_run_time))}</span>` : '',
      scheduler.scan_job_present ? `Scheduler ${scheduler.state || '—'} con ${Number(scheduler.job_count || 0)} jobs.` : 'scan_job no está registrado.'
    );

    const scans = data?.scans || {};
    const latestScan = scans.latest || {};
    const scanAge = latestScan.age_seconds != null ? _fmtDuration(latestScan.age_seconds) : '—';
    const scanDuration = latestScan.duration_seconds != null ? _fmtDuration(latestScan.duration_seconds) : '—';
    addCard(
      'scans',
      'bi-radar',
      scans.status || 'unknown',
      'Scans',
      `${Number(scans.scans_today || 0)} hoy · último hace ${scanAge} · duración ${scanDuration}`,
      latestScan.online_hosts != null ? `<span class="dash-latency-pill">${esc(String(latestScan.online_hosts))} online</span>` : '',
      `Último scan hace ${scanAge}. Sin finalizar: ${Number(scans.unfinished_count || 0)}.`
    );

    const quality = data?.quality || {};
    addCard(
      'quality',
      'bi-activity',
      quality.status || 'unknown',
      'Calidad',
      `${Number(quality.targets_active || 0)} destinos activos · ${Number(quality.errors_24h || 0)} avisos 24h`,
      quality.latest?.age_seconds != null ? `<span>${esc(_fmtDuration(quality.latest.age_seconds))}</span>` : '',
      `${Number(quality.errors_24h || 0)} avisos de calidad en 24h. Último destino: ${quality.latest?.target_name || quality.latest?.host || '—'}.`
    );

    const services = data?.services || {};
    addCard(
      'services',
      'bi-hdd-network',
      services.status || 'unknown',
      'Servicios',
      `${Number(services.services_enabled || 0)} activos · ${Number(services.errors_24h || 0)} avisos 24h`,
      services.latest?.age_seconds != null ? `<span>${esc(_fmtDuration(services.latest.age_seconds))}</span>` : '',
      `${Number(services.errors_24h || 0)} avisos de servicios en 24h. Último: ${services.latest?.name || services.latest?.host || '—'}.`
    );

    const automations = data?.automations || {};
    const autoCounts = automations.status_counts || {};
    const autoIssues = Number(autoCounts.error || 0) + Number(autoCounts.missed || 0) + Number(autoCounts.stalled || 0);
    addCard(
      'automations',
      'bi-terminal',
      automations.status || 'unknown',
      'Automatizaciones',
      `${Number(automations.scripts_active || 0)} scripts activos · ${autoIssues} incidencias`,
      automations.latest_status_age_seconds != null ? `<span>${esc(_fmtDuration(automations.latest_status_age_seconds))}</span>` : '',
      `Errores ${Number(autoCounts.error || 0)}, missed ${Number(autoCounts.missed || 0)}, stalled ${Number(autoCounts.stalled || 0)}, running ${Number(autoCounts.running || 0)}.`
    );

    const agents = data?.agents || {};
    addCard(
      'agents',
      'bi-shield-check',
      agents.status || 'unknown',
      'Agentes API',
      `${Number(agents.agents_enabled || 0)} habilitados · ${Number(agents.agents_stale || 0)} sin señal`,
      agents.latest_seen_age_seconds != null ? `<span>${esc(_fmtDuration(agents.latest_seen_age_seconds))}</span>` : '',
      `${Number(agents.agents_stale || 0)} agentes sin señal. Fallos auth 24h: ${Number(agents.auth_failed_24h || 0)}.`
    );

    const syncthing = data?.syncthing || {};
    addCard(
      'syncthing',
      'bi-arrow-left-right',
      syncthing.status || 'unknown',
      'Syncthing',
      `${Number(syncthing.nodes_enabled || 0)} nodos · ${Number(syncthing.folder_errors_24h || 0)} errores 24h · ${Number(syncthing.stalled_alerts || 0)} atascos`,
      syncthing.cache_age_seconds != null ? `<span>${esc(_fmtDuration(syncthing.cache_age_seconds))}</span>` : '',
      `Caché hace ${syncthing.cache_age_seconds != null ? _fmtDuration(syncthing.cache_age_seconds) : '—'}. Errores carpeta 24h: ${Number(syncthing.folder_errors_24h || 0)}. Atascos: ${Number(syncthing.stalled_alerts || 0)}.`
    );

    const ai = data?.ai || {};
    addCard(
      'ai',
      'bi-stars',
      ai.status || 'unknown',
      'IA',
      ai.configured ? `${ai.provider || 'Proveedor configurado'} · ${Number(ai.scan_reports || 0)} informes de scan` : 'Sin proveedor IA configurado',
      ai.latest_age_seconds != null ? `<span>${esc(_fmtDuration(ai.latest_age_seconds))}</span>` : '',
      ai.configured ? `Proveedor IA ${ai.provider || 'configurado'}. Último informe hace ${ai.latest_age_seconds != null ? _fmtDuration(ai.latest_age_seconds) : '—'}.` : 'IA desactivada.'
    );

    const notifications = data?.notifications || {};
    addCard(
      'notifications',
      'bi-bell',
      notifications.status || 'unknown',
      'Notificaciones',
      `${notifications.discord_configured ? 'Discord configurado' : 'Discord no configurado'} · ${Number(notifications.alerts_enabled || 0) + Number(notifications.script_rules_enabled || 0)} reglas activas`,
      notifications.latest_scan_discord_error ? '<span class="dash-latency-pill">error reciente</span>' : '',
      `Discord ${notifications.discord_configured ? 'configurado' : 'no configurado'}. Reglas activas: ${Number(notifications.alerts_enabled || 0) + Number(notifications.script_rules_enabled || 0)}.`
    );

    entries.sort((a, b) => _systemHealthRank(a.status) - _systemHealthRank(b.status) || String(a.title).localeCompare(String(b.title)));
    const alarms = entries.filter(item => _systemHealthIsAlarm(item.status));
    const visible = _systemHealthShowAll ? entries : alarms;
    const hiddenCount = Math.max(0, entries.length - visible.length);

    const toggle = `<button type="button" class="btn btn-outline-secondary btn-sm py-0 px-2" id="dashSystemHealthInlineToggle">${_systemHealthShowAll ? 'Ver solo alarmas' : `Ver todo (${hiddenCount})`}</button>`;
    const header = alarms.length
      ? `<div class="dash-health-compact-head"><span>${alarms.length} subsistema${alarms.length === 1 ? '' : 's'} con aviso/error</span>${toggle}</div>`
      : `<div class="dash-health-compact-head"><span>Sin alarmas activas</span>${toggle}</div>`;

    const body = visible.length
      ? visible.map(item => item.html).join('')
      : _emptyDashState('bi-check2-circle', 'Sin alarmas activas', 'Todo lo visible en Salud sistema está OK o desactivado.');

    return `<div class="dash-list-stack">${header}${body}</div>`;
  }

  async function loadSystemHealthWidget() {
    const $list = $('#dSystemHealthList');
    if (!$list.length) return;

    const loadingHtml = `<div class="small-muted" style="font-size:.82rem">${_dashProcT('status.loading', 'Cargando…')}</div>`;
    const hadContent = String($list.html() || '').trim().length > 0;
    if (!hadContent && $list.html() !== loadingHtml) $list.html(loadingHtml);

    const refreshBtn = document.getElementById('dashSystemHealthRefresh');
    const refreshIcon = refreshBtn?.querySelector('i');
    refreshBtn?.classList.add('disabled');
    refreshIcon?.classList.add('spin-icon');

    try {
      const res = await fetch(`/api/system/health?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const meta = _systemHealthMeta(data.overall || (data.ok ? 'ok' : 'error'));
      const badgeHtml = `<span class="dash-pill ${meta.pill}"><i class="bi ${meta.icon}"></i>${esc(meta.label)}</span>`;
      const badge = document.getElementById('dSystemHealthBadge');
      if (badge && badge.innerHTML !== badgeHtml) badge.innerHTML = badgeHtml;

      const html = _renderSystemHealthHtml(data);
      if ($list.html() !== html) $list.html(html);

      const toggleBtn = document.getElementById('dashSystemHealthToggle');
      if (toggleBtn) {
        toggleBtn.innerHTML = _systemHealthShowAll
          ? '<i class="bi bi-funnel"></i>'
          : '<i class="bi bi-list-ul"></i>';
        toggleBtn.title = _systemHealthShowAll ? 'Ver solo alarmas' : 'Ver todos los estados';
      }
    } catch (e) {
      const badge = document.getElementById('dSystemHealthBadge');
      if (badge && badge.innerHTML !== '') badge.innerHTML = '';
      const unavailableHtml = _emptyDashState('bi-exclamation-diamond', 'Salud del sistema no disponible', 'No se pudo cargar /api/system/health.');
      if ($list.html() !== unavailableHtml) $list.html(unavailableHtml);
      console.warn('[System health dashboard widget]', e.message);
    } finally {
      refreshBtn?.classList.remove('disabled');
      refreshIcon?.classList.remove('spin-icon');
    }
  }


  async function loadProcesosWidget() {
    const $list = $('#dProcesosList');
    if (!$list.length || !_dashModuleEnabled('automation')) return;

    const loadingHtml = `<div class="small-muted" style="font-size:.82rem">${_dashProcT('status.loading', 'Cargando…')}</div>`;
    const hadContent = String($list.html() || '').trim().length > 0;
    if (!hadContent && $list.html() !== loadingHtml) $list.html(loadingHtml);

    const refreshBtn = document.getElementById('dashSyncthingRefresh');
    refreshBtn?.classList.add('disabled');
    const refreshIcon = refreshBtn?.querySelector('i');
    refreshIcon?.classList.add('spin-icon');

    try {
      const res = await fetch(`/api/scripts/status?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data    = await res.json();
      const scripts = Array.isArray(data) ? data : (data.scripts || data.statuses || []);

      const nErr = scripts.filter(s => ['error', 'missed', 'stalled', 'failed'].includes((s.state || '').toLowerCase())).length;
      const badge = document.getElementById('dProcesosBadge');
      const badgeHtml = !scripts.length
        ? ''
        : (nErr > 0
            ? `<span class="dash-pill bad">${nErr} ${_dashProcT('dash.proc.badge_errors', 'errores')}</span>`
            : `<span class="dash-pill ok">${_dashProcT('dash.proc.badge_ok', 'OK')}</span>`);
      if (badge && badge.innerHTML !== badgeHtml) badge.innerHTML = badgeHtml;

      const procesosHtml = _renderProcesosHtml(scripts);
      if ($list.html() !== procesosHtml) $list.html(procesosHtml);
      _syncProcViewButtons();
    } catch (e) {
      const badge = document.getElementById('dProcesosBadge');
      if (badge && badge.innerHTML !== '') badge.innerHTML = '';
      const unavailableHtml = _emptyDashState('bi-exclamation-diamond', _dashProcT('dash.proc.unavailable_title', 'Automatizaciones no disponibles'), _dashProcT('dash.proc.unavailable_sub', 'No se pudo cargar el estado de los procesos programados.'));
      if ($list.html() !== unavailableHtml) $list.html(unavailableHtml);
      console.warn('[Procesos widget]', e.message);
    }
  }

  async function loadSyncthingWidget(force) {
    const $list = $('#dSyncthingList');
    if (!_dashModuleEnabled('syncthing')) return;
    const refreshBtn = document.getElementById('dashSyncthingRefresh');
    const refreshIcon = refreshBtn?.querySelector('i');
    if (!$list.length) return;

    const loadingHtml = `<div class="small-muted" style="font-size:.82rem">${_dashProcT('status.loading', 'Cargando…')}</div>`;
    if ($list.html() !== loadingHtml) $list.html(loadingHtml);

    try {
      const url = force ? `/api/syncthing/overview?refresh=1&_=${Date.now()}` : `/api/syncthing/overview?_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const summary = data.summary || {};

      const nodesTotal = Number(summary.nodes_total || 0);
      const nodesOnline = Number(summary.nodes_online || 0);
      const nodesError = Number(summary.nodes_error || 0);
      const nodesSyncing = Number(summary.nodes_syncing || 0);
      const nodesTransferring = Number(summary.nodes_transferring || 0);
      const foldersTotal = Number(summary.folders_total || 0);
      const foldersStalled = Number(summary.folders_stalled_candidate || 0);
      const needBytes = Number(summary.needBytes || 0);
      const rx = Number(summary.rxBytesPerSecond || 0);
      const tx = Number(summary.txBytesPerSecond || 0);

      const badge = document.getElementById('dSyncthingBadge');
      const alerts = nodesError + foldersStalled;
      const badgeHtml = alerts > 0
        ? `<span class="dash-pill bad">${alerts} ${alerts === 1 ? _dashStT('dash.syncthing.alert_one', 'alerta') : _dashStT('dash.syncthing.alert_many', 'alertas')}</span>`
        : (nodesTransferring > 0
            ? `<span class="dash-pill neutral"><i class="bi bi-activity"></i>${nodesTransferring} ${_dashStT('dash.syncthing.transferring_short', 'transf.')}</span>`
            : `<span class="dash-pill ok">OK</span>`);
      if (badge && badge.innerHTML !== badgeHtml) badge.innerHTML = badgeHtml;

      const cacheNote = data.cache_status === 'stale_after_error' || data.cache_error
        ? `<div class="dash-list-card">
            <div class="dash-list-icon is-warning"><i class="bi bi-exclamation-triangle"></i></div>
            <div class="dash-list-main">
              <div class="dash-list-title">${esc(_dashStT('dash.syncthing.cache_error_title', 'Caché con error previo'))}</div>
              <div class="dash-list-sub">${esc(data.cache_error || _dashStT('dash.syncthing.cache_error_sub', 'El último refresco backend falló; se conserva la caché anterior.'))}</div>
            </div>
          </div>`
        : '';

      const html = nodesTotal > 0
        ? `<div class="dash-list-stack">
            ${cacheNote}
            <div class="dash-list-card">
              <div class="dash-list-icon ${nodesError > 0 ? 'is-danger' : ''}"><i class="bi bi-hdd-network"></i></div>
              <div class="dash-list-main">
                <div class="dash-list-title">
                  <span>${nodesOnline}/${nodesTotal} ${esc(_dashStT('dash.syncthing.nodes_online', 'nodos online'))}</span>
                  ${nodesSyncing > 0 ? `<span class="dash-pill neutral">${nodesSyncing} ${esc(_dashStT('dash.syncthing.syncing', 'sincronizando'))}</span>` : ''}
                </div>
                <div class="dash-list-sub">${foldersTotal} ${esc(_dashStT('dash.syncthing.folders', 'carpetas'))} · ${foldersStalled} ${esc(_dashStT('dash.syncthing.possible_stalls', 'posibles atascos'))}</div>
              </div>
            </div>
            <div class="dash-list-card">
              <div class="dash-list-icon ${needBytes > 0 ? 'is-warning' : ''}"><i class="bi bi-database-down"></i></div>
              <div class="dash-list-main">
                <div class="dash-list-title">${esc(_dashStT('dash.syncthing.pending', 'Pendiente'))}: ${esc(_dashFmtBytes(needBytes))}</div>
                <div class="dash-list-sub">${esc(_dashStT('dash.syncthing.cached_transfer', 'Transferencia actual cacheada'))}</div>
              </div>
              <div class="dash-list-side">
                <span class="dash-latency-pill">↓ ${esc(_dashFmtRate(rx))}</span>
                <span class="dash-latency-pill">↑ ${esc(_dashFmtRate(tx))}</span>
              </div>
            </div>
            <div class="dash-list-card">
              <div class="dash-list-icon"><i class="bi bi-clock-history"></i></div>
              <div class="dash-list-main">
                <div class="dash-list-title">${esc(_dashStT('dash.syncthing.last_refresh', 'Último refresco'))}</div>
                <div class="dash-list-sub">${esc(_dashFmtDateTime(summary.last_refresh || data.cache_refreshed_at || ''))}</div>
              </div>
              <div class="dash-list-side">
                <button class="btn btn-outline-info btn-sm py-0 px-2" type="button" id="dashSyncthingOpenInline">${esc(_dashStT('common.view', 'Ver'))}</button>
              </div>
            </div>
          </div>`
        : _emptyDashState('bi-arrow-repeat', _dashStT('dash.syncthing.empty_title', 'Syncthing sin nodos'), _dashStT('dash.syncthing.empty_sub', 'Configura nodos en Configuración → Syncthing Control.'));

      if ($list.html() !== html) $list.html(html);
    } catch (e) {
      const badge = document.getElementById('dSyncthingBadge');
      if (badge && badge.innerHTML !== '') badge.innerHTML = '';
      const unavailableHtml = _emptyDashState('bi-exclamation-diamond', _dashStT('dash.syncthing.unavailable_title', 'Syncthing no disponible'), _dashStT('dash.syncthing.unavailable_sub', 'No se pudo cargar el resumen cacheado de Syncthing Control.'));
      if ($list.html() !== unavailableHtml) $list.html(unavailableHtml);
      console.warn('[Syncthing dashboard widget]', e.message);
    } finally {
      refreshBtn?.classList.remove('disabled');
      refreshIcon?.classList.remove('spin-icon');
    }
  }

  function openSyncthingControlFromDashboard() {
    try {
      const infraTab = document.getElementById('infra-tab');
      const syncTab = document.getElementById('infra-syncthing-tab');
      if (infraTab && window.bootstrap?.Tab) bootstrap.Tab.getOrCreateInstance(infraTab).show();
      window.setTimeout(() => {
        if (syncTab && window.bootstrap?.Tab) bootstrap.Tab.getOrCreateInstance(syncTab).show();
        if (typeof window.loadSyncthingControl === 'function') window.loadSyncthingControl(false);
      }, 80);
    } catch (e) {
      console.warn('[Syncthing dashboard open]', e.message);
    }
  }

  function _fmtAgo(isoStr) {
    try {
      const s = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
      if (s < 60)    return `${s}s`;
      if (s < 3600)  return `${Math.floor(s / 60)}m`;
      if (s < 86400) return `${Math.floor(s / 3600)}h`;
      return `${Math.floor(s / 86400)}d`;
    } catch { return '—'; }
  }

  function _fmtDateTime(isoStr) {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return '—';
      return _dashFmtDateTime(d);
    } catch { return '—'; }
  }

  function _fmtDuration(secs) {
    if (secs == null || Number.isNaN(secs)) return '—';
    const total = Math.max(0, Math.round(Number(secs)));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function _calcEndIso(startIso, durationSecs) {
    if (!startIso || durationSecs == null || Number.isNaN(durationSecs)) return '';
    try {
      const start = new Date(startIso);
      if (isNaN(start.getTime())) return '';
      return new Date(start.getTime() + (Number(durationSecs) * 1000)).toISOString();
    } catch { return ''; }
  }

  
  $(document).on('click', '.dash-proc-view-btn', function () {
    const nextView = String($(this).data('view') || 'compact');
    if (nextView === _dashProcView) return;
    _dashProcView = nextView;
    localStorage.setItem(DASH_PROC_VIEW_KEY, _dashProcView);
    _syncProcViewButtons();
    loadProcesosWidget();
  });

  _syncProcViewButtons();
  $('#dashProcesosRefresh').on('click', loadProcesosWidget);

  document.addEventListener('langchange', function () {
    if (document.getElementById('dashboardView')?.classList.contains('show')) {
      loadDashboard();
      loadSystemHealthWidget();
      loadProcesosWidget();
      loadSyncthingWidget(false);
    }
  });

  document.addEventListener('timezonechange', function () {
    if (document.getElementById('dashboardView')?.classList.contains('show')) {
      loadDashboard();
      loadSystemHealthWidget();
      loadProcesosWidget();
      loadSyncthingWidget(false);
    }
  });
  $('#dashSyncthingRefresh').on('click', () => loadSyncthingWidget(true));
  $('#dashSystemHealthRefresh').on('click', loadSystemHealthWidget);
  $('#dashSystemHealthToggle').on('click', function () {
    _systemHealthShowAll = !_systemHealthShowAll;
    loadSystemHealthWidget();
  });
  $(document).on('click', '#dashSystemHealthInlineToggle', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    _systemHealthShowAll = !_systemHealthShowAll;
    loadSystemHealthWidget();
  });
  $(document).on('click', '.dash-health-card.is-clickable', function () {
    _systemHealthOpenTarget(this.dataset.healthTarget);
  });
  $('#dashRefresh').on('click', loadSystemHealthWidget);
  $(document).on('click', '#dashSyncthingOpen, #dashSyncthingOpenInline', openSyncthingControlFromDashboard);

  document.getElementById('dashboard-tab')?.addEventListener('shown.bs.tab', () => {
    loadSystemHealthWidget();
    loadProcesosWidget();
    loadSyncthingWidget(false);
  });
  if (document.getElementById('dashboardView')?.classList.contains('show')) {
    loadSystemHealthWidget();
    loadProcesosWidget();
    loadSyncthingWidget(false);
  }
  let _dashProcesosRefreshTimer = null;
  let _dashSystemRefreshTimer = null;
  let _dashSyncthingRefreshTimer = null;

  function _startDashboardWidgetRefreshTimers() {
    if (_dashProcesosRefreshTimer) clearInterval(_dashProcesosRefreshTimer);
    if (_dashSystemRefreshTimer) clearInterval(_dashSystemRefreshTimer);
    if (_dashSyncthingRefreshTimer) clearInterval(_dashSyncthingRefreshTimer);

    _dashProcesosRefreshTimer = setInterval(() => {
      if (document.getElementById('dashboardView')?.classList.contains('show')) loadProcesosWidget();
    }, _dashRefreshMs('normal'));

    _dashSystemRefreshTimer = setInterval(() => {
      if (document.getElementById('dashboardView')?.classList.contains('show')) loadSystemHealthWidget();
    }, _dashRefreshMs('dashboard'));

    _dashSyncthingRefreshTimer = setInterval(() => {
      if (document.getElementById('dashboardView')?.classList.contains('show')) loadSyncthingWidget(false);
    }, _dashRefreshMs('dashboard'));
  }

  _startDashboardWidgetRefreshTimers();
  document.addEventListener('frontendrefreshsettingschange', _startDashboardWidgetRefreshTimers);
  document.addEventListener('modulegatingchange', () => {
    applyDashLayout();
    if (document.getElementById('dashboardView')?.classList.contains('show')) {
      loadDashboard();
      loadSystemHealthWidget();
      loadProcesosWidget();
      loadSyncthingWidget(false);
    }
  });

}); // end $(function)
