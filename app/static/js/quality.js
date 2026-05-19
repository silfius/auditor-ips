// ════════════════════════════════════════════════════════
//  quality.js — Auditor IPs · Calidad de conexión
//  Gráficas latencia, lossVLines plugin, export CSV
// ════════════════════════════════════════════════════════
$(function() {
  function qualityFmtTime(value) {
    if (!value) return '—';
    if (typeof window.fmtTime === 'function') {
      const formatted = window.fmtTime(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function qualityFmtDate(value) {
    if (!value) return '—';
    if (typeof window.fmtDate === 'function') {
      const formatted = window.fmtDate(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function qualityFmtDateTime(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function qualityFmtChartLabel(value) {
    if (_qualityRange === 1) return qualityFmtTime(value);
    if (_qualityRange === 7) return qualityFmtDateTime(value);
    return qualityFmtDate(value);
  }

  let _qualityRange = 1;
  let _qualityCharts = {};
  let _qualityLoadToken = 0;
  let _qualityKickoffAt = 0;
  const _qualityFetchInflight = {};

  // ── Caché de datos por rango ──────────────────────────────
  // Clave: número de días (1, 7, 30). Se rellena en paralelo al activar el tab.
  const _qualityCache = {};      // { 1: data, 7: data, 30: data }
  let   _qualityCachePending = false;

  function _perfTraceId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function _perfRound(ms) {
    return Math.round(Number(ms || 0) * 10) / 10;
  }

  let _qualityIncidentStreakMin = 3;

  function _qualityIsIncidentPoint(point) {
    return !!point && (point.latency_ms == null || Number(point.packet_loss || 0) > 0);
  }

  function _qualityBuildIncidentIndexes(points) {
    const idx = [];
    const rows = Array.isArray(points) ? points : [];
    let start = -1;

    for (let i = 0; i < rows.length; i++) {
      if (_qualityIsIncidentPoint(rows[i])) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if ((i - start) >= _qualityIncidentStreakMin) {
          for (let j = start; j < i; j++) idx.push(j);
        }
        start = -1;
      }
    }

    if (start >= 0 && (rows.length - start) >= _qualityIncidentStreakMin) {
      for (let j = start; j < rows.length; j++) idx.push(j);
    }

    return idx;
  }

  const QUALITY_MARKERS_KEY = 'auditor-quality-markers';
  let _qualityShowMarkers = localStorage.getItem(QUALITY_MARKERS_KEY) !== '0';

  function _ensureQualityMarkersToggle() {
    const info = document.getElementById('qualityRangeInfo');
    const host = info?.parentElement || document.querySelector('#qualityView .d-flex.gap-2.align-items-center.mb-3.flex-wrap');
    if (!host) return;

    let wrap = document.getElementById('qualityMarkersWrap');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.id = 'qualityMarkersWrap';
      wrap.className = 'small-muted d-inline-flex align-items-center gap-2';
      wrap.style.cssText = 'font-size:.74rem;cursor:pointer;user-select:none;';
      wrap.innerHTML = `
        <input class="form-check-input mt-0" type="checkbox" id="qualityMarkersToggle">
        <span>Mostrar incidencias en racha</span>
      `;
      if (info && info.parentElement === host) host.insertBefore(wrap, info);
      else host.appendChild(wrap);
    }

    const input = document.getElementById('qualityMarkersToggle');
    if (input) input.checked = !!_qualityShowMarkers;
  }

  $(document).off('change', '#qualityMarkersToggle').on('change', '#qualityMarkersToggle', function () {
    _qualityShowMarkers = !!this.checked;
    try { localStorage.setItem(QUALITY_MARKERS_KEY, _qualityShowMarkers ? '1' : '0'); } catch (_) {}
    loadQualityHistory().catch(() => {});
  });

  async function _fetchRange(days, trace = '') {
    if (_qualityFetchInflight[days]) {
      return _qualityFetchInflight[days];
    }

    const url = `/api/quality/history?days=${days}&_=${Date.now()}`;

    _qualityFetchInflight[days] = (async () => {
      const res  = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) _qualityCache[days] = data;
      return data;
    })().finally(() => {
      delete _qualityFetchInflight[days];
    });

    return _qualityFetchInflight[days];
  }

  async function _precacheAllRanges() {
    if (_qualityCachePending) return;
    _qualityCachePending = true;
    try {
      const ranges = (
        _qualityRange === 1
          ? [7]
          : (_qualityRange === 7 ? [30] : [])
      ).filter(days => !_qualityCache[days]);

      if (!ranges.length) return;
      await Promise.allSettled(ranges.map(days => _fetchRange(days)));
    } finally {
      _qualityCachePending = false;
    }
  }

  function _setTextIfChanged(target, value) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const next = String(value ?? '');
    if (el.textContent !== next) el.textContent = next;
  }

  function _setHtmlIfChanged(target, html) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const next = String(html ?? '');
    if (el.innerHTML !== next) el.innerHTML = next;
  }

  let _qualityHistoryRefreshTimer = null;
  let _qualityHistoryRefreshRunning = false;

  function _scheduleQualityHistoryRefresh(force = false) {
    const run = async () => {
      _qualityHistoryRefreshRunning = true;
      try {
        delete _qualityCache[_qualityRange];
        await loadQualityHistory();
      } catch (_) {
      } finally {
        _qualityHistoryRefreshRunning = false;
      }
    };

    if (force) {
      if (_qualityHistoryRefreshTimer) {
        clearTimeout(_qualityHistoryRefreshTimer);
        _qualityHistoryRefreshTimer = null;
      }
      run();
      return;
    }

    if (_qualityHistoryRefreshTimer || _qualityHistoryRefreshRunning) return;
    _qualityHistoryRefreshTimer = setTimeout(async () => {
      _qualityHistoryRefreshTimer = null;
      await run();
    }, 5000);
  }

  const lossVLinesPlugin = {
    id: 'lossVLines',
    afterDatasetsDraw(chart) {
      try {
        const lossIdx    = (chart?.config?._lossIndexes) || [];
        const timeoutIdx = (chart?.config?._timeoutIndexes) || [];
        if (!lossIdx.length && !timeoutIdx.length) return;
        const ctx  = chart.ctx;
        const x    = chart.scales.x;
        const area = chart.chartArea;
        ctx.save();
        ctx.lineWidth = 1.5;

        ctx.strokeStyle = 'rgba(255,60,60,0.9)';
        for (const i of timeoutIdx) {
          const xp = x.getPixelForValue(i);
          if (!isFinite(xp)) continue;
          ctx.beginPath();
          ctx.moveTo(xp, area.top);
          ctx.lineTo(xp, area.bottom);
          ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(255,193,7,0.75)';
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
      } catch (_) {}
    }
  };

  async function loadQualityInterfaces(selectValue) {
    const $sel    = $('#qualityInterface');
    const $status = $('#qualityIfaceStatus');
    try {
      const [netRes, settRes] = await Promise.all([
        fetch('/api/config/networks').then(r => r.json()),
        fetch('/api/settings').then(r => r.json()),
      ]);
      const nets           = (netRes.networks || []).filter(n => n.enabled);
      const s              = settRes.settings || {};
      const primaryLabel   = (s.primary_net_label || '').trim() || 'Red principal';
      const primaryIface   = (s.primary_net_interface || '').trim();
      const primaryCidrRaw = (s.scan_cidr || '').trim();

      $sel.html('<option value="">— automático (ruta por defecto) —</option>');

      if (primaryCidrRaw) {
        const cidrLabel = primaryCidrRaw.split(',')[0].trim();
        $sel.append(`<option value="${esc(primaryIface)}">${esc(primaryLabel)}  (${esc(cidrLabel)})</option>`);
        if (primaryIface) _ifaceToNetLabel[primaryIface] = primaryLabel;
      }

      for (const n of nets) {
        const label = n.label || n.cidr;
        const val   = n.interface || '';
        $sel.append(`<option value="${esc(val)}">${esc(label)}  (${esc(n.cidr)})</option>`);
      }

      if (selectValue) $sel.val(selectValue);

      const total = (primaryCidrRaw ? 1 : 0) + nets.length;
      $status.text(total ? `${total} red(es) disponible(s)` : 'No hay redes configuradas')
             .css('color', total ? 'var(--accent)' : 'rgba(255,255,255,0.4)');
    } catch(e) {
      $status.text('Error al cargar redes').css('color', '#ff6b6b');
    }
  }

  $('#qualityIfaceRefresh').on('click', async function() {
    const $icon = $(this).find('i');
    $icon.addClass('spin');
    $(this).prop('disabled', true);
    await loadQualityInterfaces($('#qualityInterface').val());
    $icon.removeClass('spin');
    $(this).prop('disabled', false);
  });

  let _ifaceToNetLabel = {};
  let _qualityTargetsById = {};
  let _qualityDiagLastReport = '';
  const qualityTargetModalEl = document.getElementById('qualityTargetModal');
  const qualityTargetModal = qualityTargetModalEl ? new bootstrap.Modal(qualityTargetModalEl) : null;

  function _resetQualityTargetModal() {
    $('#qualityTargetEditId').val('');
    $('#qualityTargetModalTitle').html('<i class="bi bi-plus-circle me-2"></i>Añadir destino');
    $('#qualityAddTarget').html('<i class="bi bi-check-lg me-1"></i>Guardar destino');
    $('#qualityNewName').val('');
    $('#qualityNewHost').val('');
    $('#qualityInterface').val('');
    $('#qualityIfaceStatus').text('');
  }

  async function _openQualityTargetModalForCreate() {
    _resetQualityTargetModal();
    await loadQualityInterfaces('');
  }

  async function _openQualityTargetModalForEdit(tid) {
    const t = _qualityTargetsById[String(tid)] || _qualityTargetsById[Number(tid)];
    if (!t) return;
    $('#qualityTargetEditId').val(t.id);
    $('#qualityTargetModalTitle').html('<i class="bi bi-pencil me-2"></i>Editar destino');
    $('#qualityAddTarget').html('<i class="bi bi-check-lg me-1"></i>Guardar cambios');
    $('#qualityNewName').val(t.name || '');
    $('#qualityNewHost').val(t.host || '');
    await loadQualityInterfaces((t.interface || '').trim());
    $('#qualityInterface').val((t.interface || '').trim());
    if (qualityTargetModal) qualityTargetModal.show();
  }


  async function _loadNetworkLabels() {
    try {
      const [netRes, settRes] = await Promise.all([
        fetch('/api/config/networks').then(r => r.json()),
        fetch('/api/settings').then(r => r.json()),
      ]);
      const map = {};
      for (const n of (netRes.networks || [])) {
        if (n.interface && n.label) map[n.interface] = n.label;
        if (n.interface && !n.label && n.cidr) map[n.interface] = n.cidr;
      }
      const settings = (settRes.settings || {});
      const primaryLabel = (settings.primary_net_label || '').trim() || 'Red principal';
      const primaryIface = (settings.primary_net_interface || '').trim();
      if (primaryIface) map[primaryIface] = primaryLabel;
      _ifaceToNetLabel = map;
    } catch(e) {}
  }

  function _qualityDiagSetStatus(msg, tone) {
    const $el = $('#qualityDiagStatus');
    $el.removeClass('text-danger text-success text-warning text-info');
    if (tone) $el.addClass(tone);
    $el.text(msg || '');
  }

  function _qualityDiagResetResult(keepStatus = false) {
    _qualityDiagLastReport = '';
    if (!keepStatus) _qualityDiagSetStatus('', '');
    $('#qualityDiagEmpty').show();
    $('#qualityDiagResultWrap').hide();
    $('#qualityDiagCopyReport').hide();
    $('#qualityDiagCopyPrompt').hide();
    $('#qualityDiagAnalyzeAi').hide();
    $('#qualityDiagAiWrap').hide();
    $('#qualityDiagAiMeta').text('');
    $('#qualityDiagAiBody').html('');
    $('#qualityDiagReportText').text('');
    $('#qualityDiagPingMeta').text('');
    $('#qualityDiagPingOutput').text('');
    $('#qualityDiagTraceMeta').text('');
    $('#qualityDiagTraceOutput').text('');
    $('#qualityDiagMtrMeta').text('');
    $('#qualityDiagMtrOutput').text('');
  }

  function _qualityDiagText(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload.trim();
    if (Array.isArray(payload)) {
      return payload
        .map(v => typeof v === 'string' ? v : JSON.stringify(v))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (typeof payload === 'object') {
      if (typeof payload.output === 'string' && payload.output.trim()) return payload.output.trim();
      if (Array.isArray(payload.lines) && payload.lines.length) return payload.lines.join('\n').trim();
      if (Array.isArray(payload.raw_lines) && payload.raw_lines.length) return payload.raw_lines.join('\n').trim();
      return JSON.stringify(payload, null, 2);
    }
    return String(payload).trim();
  }

  function _qualityDiagMeta(label, payload) {
    const parts = [];
    if (label) parts.push(label);
    const status = String(payload?.status || '').trim();
    if (status) parts.push(`estado: ${status}`);
    if (payload?.avg_ms != null) parts.push(`media: ${payload.avg_ms} ms`);
    if (payload?.latency_ms != null) parts.push(`latencia: ${payload.latency_ms} ms`);
    if (payload?.packet_loss != null) parts.push(`pérdida: ${payload.packet_loss}%`);
    if (payload?.hops != null) parts.push(`saltos: ${payload.hops}`);
    if (payload?.tool) parts.push(`tool: ${payload.tool}`);
    return parts.join(' · ');
  }

  async function loadQualityDiagnosticOptions(targets) {
    const targetList = Array.isArray(targets) ? targets : null;
    const prevTarget = ($('#qualityDiagTarget').val() || '').trim();
    const prevIface  = ($('#qualityDiagInterface').val() || '').trim();

    let targetData = { ok: true, targets: targetList || [] };
    if (!targetList) {
      try {
        targetData = await fetch('/api/quality/targets').then(r => r.json());
      } catch (_) {
        targetData = { ok: false, targets: [] };
      }
    }

    let ifaceData = { ok: true, interfaces: [] };
    try {
      ifaceData = await fetch('/api/quality/interfaces').then(r => r.json());
    } catch (_) {
      ifaceData = { ok: false, interfaces: [] };
    }

    const $target = $('#qualityDiagTarget');
    $target.html('<option value="">Selecciona un destino…</option>');
    for (const t of (targetData.targets || [])) {
      const extra = t.enabled ? '' : ' · pausado';
      $target.append(`<option value="${esc(String(t.id))}">${esc(`${t.name} (${t.host})${extra}`)}</option>`);
    }
    if (prevTarget && $target.find(`option[value="${prevTarget}"]`).length) {
      $target.val(prevTarget);
    }

    const $iface = $('#qualityDiagInterface');
    $iface.html('<option value="">— automático —</option>');
    for (const i of (ifaceData.interfaces || [])) {
      const name = String(i.name || '').trim();
      if (!name) continue;
      const addrs = Array.isArray(i.addrs) && i.addrs.length ? ` · ${i.addrs.join(', ')}` : '';
      $iface.append(`<option value="${esc(name)}">${esc(name + addrs)}</option>`);
    }
    if (prevIface && $iface.find(`option[value="${prevIface}"]`).length) {
      $iface.val(prevIface);
    }
  }

  function _qualityDiagBuildAiPrompt() {
    const host = ($('#qualityDiagHost').val() || '').trim() || 'sin destino';
    const requestedInterface = ($('#qualityDiagInterface').val() || '').trim() || 'auto';

    const report    = String(_qualityDiagLastReport || $('#qualityDiagReportText').text() || '').trim();
    const pingMeta  = ($('#qualityDiagPingMeta').text() || '').trim();
    const pingOut   = ($('#qualityDiagPingOutput').text() || '').trim();
    const traceMeta = ($('#qualityDiagTraceMeta').text() || '').trim();
    const traceOut  = ($('#qualityDiagTraceOutput').text() || '').trim();
    const mtrMeta   = ($('#qualityDiagMtrMeta').text() || '').trim();
    const mtrOut    = ($('#qualityDiagMtrOutput').text() || '').trim();

    return [
      'Actúa como analista senior de red LAN/WAN.',
      'Quiero una valoración técnica breve, clara y accionable.',
      'Devuélveme solo estas secciones:',
      '1. Resumen ejecutivo',
      '2. Severidad (baja/media/alta)',
      '3. Tramo sospechoso',
      '4. Evidencias clave',
      '5. Hipótesis más probables',
      '6. Siguientes comprobaciones recomendadas',
      '7. Acciones inmediatas sugeridas',
      '',
      'CONTEXTO',
      `- Destino: ${host}`,
      `- Interfaz solicitada: ${requestedInterface}`,
      '',
      'INFORME TÉCNICO RESUMIDO',
      report || '(sin informe resumido)',
      '',
      'PING META',
      pingMeta || '(sin metadatos)',
      'PING OUTPUT',
      pingOut || '(sin salida)',
      '',
      'TRACEROUTE / TRACEPATH META',
      traceMeta || '(sin metadatos)',
      'TRACEROUTE / TRACEPATH OUTPUT',
      traceOut || '(sin salida)',
      '',
      'MTR META',
      mtrMeta || '(sin metadatos)',
      'MTR OUTPUT',
      mtrOut || '(sin salida)',
    ].join('\n').trim();
  }

  function _qualityDiagCurrentPayload() {
    return {
      host: ($('#qualityDiagHost').val() || '').trim() || 'sin destino',
      interface: ($('#qualityDiagInterface').val() || '').trim() || 'auto',
      report_text: String(_qualityDiagLastReport || $('#qualityDiagReportText').text() || '').trim(),
      ping_meta: ($('#qualityDiagPingMeta').text() || '').trim(),
      ping_output: ($('#qualityDiagPingOutput').text() || '').trim(),
      trace_meta: ($('#qualityDiagTraceMeta').text() || '').trim(),
      trace_output: ($('#qualityDiagTraceOutput').text() || '').trim(),
      mtr_meta: ($('#qualityDiagMtrMeta').text() || '').trim(),
      mtr_output: ($('#qualityDiagMtrOutput').text() || '').trim(),
    };
  }

  function _qualityDiagRenderAiAnalysis(data) {
    const analysis = String(data?.analysis || '').trim();
    const provider = String(data?.provider || '').trim().toUpperCase();
    const model = String(data?.model || '').trim();
    $('#qualityDiagAiMeta').text([provider, model].filter(Boolean).join(' · '));
    $('#qualityDiagAiBody').html(
      `<pre class="cfg-help-code mb-0" style="white-space:pre-wrap;max-height:260px;overflow:auto">${esc(analysis || 'Sin análisis IA.')}</pre>`
    );
    $('#qualityDiagAiWrap').show();
  }

  function _qualityDiagRender(data, requestedHost, requestedInterface) {
    const ping  = data?.ping || {};
    const trace = data?.traceroute || data?.trace || {};
    const mtr   = data?.mtr || {};
    const report = String(data?.report_text || data?.report || data?.summary || '').trim();

    _qualityDiagLastReport = report;
    $('#qualityDiagEmpty').hide();
    $('#qualityDiagResultWrap').show();
    $('#qualityDiagCopyReport').toggle(!!report);
    $('#qualityDiagCopyPrompt').show();
    $('#qualityDiagAnalyzeAi').show();
    $('#qualityDiagAiWrap').hide();
    $('#qualityDiagAiMeta').text('');
    $('#qualityDiagAiBody').html('');

    $('#qualityDiagReportText').text(report || 'Sin informe resumido.');
    $('#qualityDiagPingMeta').text(_qualityDiagMeta(`destino: ${requestedHost} · interfaz: ${requestedInterface || 'auto'}`, ping));
    $('#qualityDiagPingOutput').text(_qualityDiagText(ping) || 'Sin salida de ping.');

    $('#qualityDiagTraceMeta').text(_qualityDiagMeta(`destino: ${requestedHost}`, trace));
    $('#qualityDiagTraceOutput').text(_qualityDiagText(trace) || 'Sin salida de traceroute/tracepath.');

    const mtrEnabled = data?.include_mtr === true || data?.requested_include_mtr === true || !!(mtr && Object.keys(mtr).length);
    $('#qualityDiagMtrMeta').text(mtrEnabled ? _qualityDiagMeta(`destino: ${requestedHost}`, mtr) : 'MTR no solicitado.');
    $('#qualityDiagMtrOutput').text(
      mtrEnabled
        ? (_qualityDiagText(mtr) || 'Sin salida de MTR.')
        : 'MTR no solicitado en esta ejecución.'
    );
  }

  async function loadQualitySettings() {
    const res  = await fetch('/api/quality/settings');
    const data = await res.json();
    if (!data.ok) return;
    const s = data.settings;
    $('#qualityEnabled').prop('checked', !!s.enabled);
    $('#qualityThreshold').val(s.alert_threshold_pct || 200);
    $('#qualityCooldown').val(s.alert_cooldown_minutes || 30);
    $('#qualityIncidentStreak').val(s.incident_streak_min || 3);
    _qualityIncidentStreakMin = Math.max(2, parseInt(s.incident_streak_min, 10) || 3);
    $('#qualityQuietStart').val(s.quiet_start || '');
    $('#qualityQuietEnd').val(s.quiet_end || '');
    await Promise.all([_loadNetworkLabels(), loadQualityInterfaces((s.quality_interface || '').trim())]);
    renderQualityTargets(data.targets);
    await loadQualityDiagnosticOptions();
    await loadQualityDiagnosticOptions(data.targets || []);
  }

  function renderQualityTargets(targets) {
    const c = $('#qualityTargetsList');
    c.empty();
    _qualityTargetsById = {};
    if (!targets.length) {
      c.append('<span class="small-muted" style="font-size:.8rem">No hay destinos configurados todavía. Usa “Añadir destino” para crear el primero.</span>');
      return;
    }
    for (const t of targets) {
      _qualityTargetsById[String(t.id)] = t;
      const netLabel = t.interface ? (_ifaceToNetLabel[t.interface] || null) : null;
      const ifaceText = netLabel || t.interface || 'auto';
      const pausedText = window.t?.('common.paused', 'pausado') || 'pausado';
      const activeText = window.t?.('status.active', 'activo') || 'activo';
      const ifaceTitle = window.t?.('quality.interface_title', 'Interfaz: {iface}', {
        iface: t.interface || (window.t?.('quality.auto_default_route', 'automática (ruta por defecto)') || 'automática (ruta por defecto)')
      }) || `Interfaz: ${t.interface || 'automática (ruta por defecto)'}`;
      const pausedHtml = t.enabled ? '' : `<span class="qt-state" title="${esc(window.t?.('quality.paused_target', 'Destino pausado') || 'Destino pausado')}">${esc(pausedText)}</span>`;
      const badgeTitle = `${t.name} · ${t.host} · ${ifaceText} · ${t.enabled ? activeText : pausedText}`;
      c.append(`
        <div class="quality-target-badge compact ${t.enabled?'':'disabled'}" title="${esc(badgeTitle)}">
          <span class="quality-dot ${t.enabled?'ok':'warn'}"></span>
          <span class="qt-name" title="${esc(t.name)}">${esc(t.name)}</span>
          <span class="qt-host" title="${esc(t.host)}">${esc(t.host)}</span>
          <span class="qt-iface" title="${esc(ifaceTitle)}">${esc(ifaceText)}</span>
          ${pausedHtml}
        </div>
      `);
    }
  }

  async function loadQualityHistory() {
    const loadToken = ++_qualityLoadToken;
    const rangeAtStart = _qualityRange;
    _ensureQualityMarkersToggle();

    const container = document.getElementById('qualityChartsContainer');
    if (!container) return;

    const isFirstLoad = Object.keys(_qualityCharts).length === 0;
    if (isFirstLoad) {
      container.innerHTML = '<div class="quality-skeleton">' +
        ['','',''].map(() => '<div class="quality-chart-card mb-3"><div class="skeleton-bar" style="height:150px;border-radius:8px;background:rgba(255,255,255,0.06);animation:skeleton-pulse 1.4s ease-in-out infinite"></div></div>').join('') +
        '</div>';
    }

    let data = _qualityCache[_qualityRange];
    if (!data) {
      data = await _fetchRange(_qualityRange);
    } else {
      _fetchRange(_qualityRange).catch(() => {});
    }

    if (loadToken !== _qualityLoadToken || rangeAtStart !== _qualityRange) return;
    if (!data?.ok) return;

    if (!data.targets.length || data.targets.every(t => !t.data.length)) {
      _setHtmlIfChanged(container, '<div class="small-muted text-center py-4">Sin datos todavía. Activa la monitorización y espera el primer ping.</div>');
      return;
    }

    const allTs = [...new Set(
      data.targets.flatMap(t => (t.data || []).map(d => d.checked_at)).filter(Boolean)
    )].sort();

    const globalLabels = allTs.map(ts => qualityFmtChartLabel(ts));

    const rangeInfoEl = document.getElementById('qualityRangeInfo');
    if (rangeInfoEl) {
      const totalPoints = data.targets.reduce((s, t) => s + t.data.length, 0);
      const rangeLabel = _qualityRange === 1 ? 'Hoy' : `Últimos ${_qualityRange} días`;
      const fromDate = allTs.length ? qualityFmtDate(allTs[0]) : '—';
      _setTextIfChanged(rangeInfoEl, `${rangeLabel} · desde ${fromDate} · ${totalPoints} registros`);
    }

    const dark      = !document.body.classList.contains('light-mode');
    const textColor = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    const gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    if (isFirstLoad) {
      container.innerHTML = '';

      const legend = document.createElement('div');
      legend.className = 'mb-3 d-flex flex-wrap gap-3 align-items-center';
      legend.style.cssText = 'font-size:.75rem;padding:5px 10px;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08)';
      legend.innerHTML =
        '<span style="font-weight:600;opacity:.6;margin-right:4px">Leyenda:</span>' +
        '<span style="display:flex;align-items:center;gap:4px">' +
          '<span style="display:inline-block;width:12px;height:3px;background:var(--accent);border-radius:2px"></span>' +
          'Latencia normal' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:4px">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:rgba(255,193,7,0.92)"></span>' +
          '<span style="display:inline-block;width:2px;height:14px;background:rgba(255,193,7,0.75);border-radius:1px"></span>' +
          'Incidencia en racha (timeout o pérdida)' +
        '</span>';
      container.appendChild(legend);

      const activeIface = ($('#qualityInterface').val() || '').trim();
      if (activeIface) {
        const banner = document.createElement('div');
        banner.className = 'mb-3';
        banner.innerHTML = `<span style="font-size:.78rem;background:rgba(77,255,181,0.1);border:1px solid rgba(77,255,181,0.3);border-radius:6px;padding:3px 10px;color:var(--accent)">
          <i class="bi bi-ethernet me-1"></i>Pings enviados por interfaz: <strong>${esc(activeIface)}</strong>
        </span>`;
        container.appendChild(banner);
      }
    }

    for (const t of data.targets) {
      if (!t.enabled && !t.data.length) continue;

      const rows = Array.isArray(t.data) ? t.data : [];
      const byTs = new Map(rows.map(d => [d.checked_at, d]));

      const lats      = rows.filter(d => d.latency_ms != null).map(d => d.latency_ms);
      const avgMs     = lats.length ? Math.round(lats.reduce((a,b)=>a+b,0)/lats.length) : null;
      const minMs     = lats.length ? Math.round(Math.min(...lats)) : null;
      const maxMs     = lats.length ? Math.round(Math.max(...lats)) : null;
      const downCount = rows.filter(d => d.status === 'down' || d.status === 'error').length;
      const upPct     = rows.length ? Math.round((rows.length - downCount) / rows.length * 100) : null;

      const showMarkers = !!_qualityShowMarkers;
      const localIncidentIndexes = showMarkers ? _qualityBuildIncidentIndexes(rows) : [];
      const incidentTsSet = new Set(
        localIncidentIndexes.map(i => rows[i]?.checked_at).filter(Boolean)
      );

      const latData = allTs.map(ts => {
        const d = byTs.get(ts);
        return d ? (d.latency_ms ?? null) : null;
      });

      const lossIndexes = [];
      const timeoutIndexes = [];
      if (showMarkers) {
        allTs.forEach((ts, i) => {
          if (incidentTsSet.has(ts)) lossIndexes.push(i);
        });
      }

      const pointBgFn = (ctx) => {
        const ts = allTs[ctx.dataIndex];
        const d = byTs.get(ts);
        if (!d) return 'transparent';
        if (showMarkers && incidentTsSet.has(ts)) return 'rgba(255,193,7,0.92)';
        if (avgMs && d.latency_ms != null && d.latency_ms > avgMs * 2) return 'rgba(255,193,7,0.8)';
        return accentColor(0.7);
      };

      const pointRadiusFn = (ctx) => {
        const ts = allTs[ctx.dataIndex];
        if (!byTs.has(ts)) return 0;
        if (showMarkers && incidentTsSet.has(ts)) return 5;
        return (allTs.length > 200) ? 0 : 3;
      };

      const cardNetLabel = t.interface ? (_ifaceToNetLabel[t.interface] || t.interface) : 'Automática';

      const cardHeaderHtml = `
          <div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
            <strong>${esc(t.name)}</strong>
            <span class="small-muted">${esc(t.host)}</span>
            <span style="font-size:.7rem;background:rgba(77,255,181,0.12);border:1px solid rgba(77,255,181,0.25);border-radius:4px;padding:1px 6px;color:var(--accent)" title="${esc(window.t?.('quality.network_interface', 'Red / interfaz') || 'Red / interfaz')}">${esc(cardNetLabel)}</span>
            <span class="quality-stats">${_buildStats(avgMs, minMs, maxMs, upPct)}</span>
            <div class="ms-auto d-flex align-items-center gap-1">
              <button class="btn btn-outline-secondary btn-sm py-0 px-2 btn-quality-edit" data-tid="${t.id}" title="${esc(window.t?.('quality.edit_target', 'Editar destino') || 'Editar destino')}">${esc(window.t?.('common.edit', 'Editar') || 'Editar')}</button>
              <button class="btn btn-outline-danger btn-sm py-0 px-2 btn-quality-del" data-tid="${t.id}" title="${esc(window.t?.('quality.delete_target', 'Eliminar destino') || 'Eliminar destino')}">${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}</button>
            </div>
          </div>
      `;

      if (_qualityCharts[t.id]) {
        const chart = _qualityCharts[t.id];
        chart.data.labels = globalLabels;
        chart.data.datasets[0].data = latData;
        chart.data.datasets[0].pointBackgroundColor = pointBgFn;
        chart.data.datasets[0].pointRadius = pointRadiusFn;
        chart.config._lossIndexes = lossIndexes;
        chart.config._timeoutIndexes = timeoutIndexes;
        chart.update('none');

        const card = document.getElementById(`qcard_${t.id}`);
        if (card) {
          const headerMarkup = cardHeaderHtml.trim();
          const headerEl = card.firstElementChild;
          if (!headerEl || !headerEl.classList.contains('d-flex')) {
            card.insertAdjacentHTML('afterbegin', headerMarkup);
          } else if (headerEl.outerHTML.trim() !== headerMarkup) {
            headerEl.outerHTML = headerMarkup;
          }
          const statEl = card.querySelector('.quality-stats');
          if (statEl) _setHtmlIfChanged(statEl, _buildStats(avgMs, minMs, maxMs, upPct));
        }
      } else {
        const cardId = `qcard_${t.id}`;
        let div = document.getElementById(cardId);
        if (!div) {
          div = document.createElement('div');
          div.id = cardId;
          div.className = 'quality-chart-card mb-3';
          container.appendChild(div);
        }

        div.innerHTML = `
          ${cardHeaderHtml}
          <canvas id="qchart_${t.id}" style="max-height:130px"></canvas>
        `;

        const ctx = document.getElementById(`qchart_${t.id}`).getContext('2d');
        const chart = new Chart(ctx, {
          plugins: [lossVLinesPlugin],
          type: 'line',
          data: {
            labels: globalLabels,
            datasets: [{
              label: 'Latencia (ms)',
              data: latData,
              borderColor: accentColor(0.8),
              backgroundColor: 'transparent',
              borderWidth: 1.8,
              pointBackgroundColor: pointBgFn,
              pointRadius: pointRadiusFn,
              tension: 0.22,
              spanGaps: true
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: (items) => globalLabels[items[0]?.dataIndex] || '',
                  label: (ctx) => {
                    const ts = allTs[ctx.dataIndex];
                    const d = byTs.get(ts);
                    if (!d) return 'Sin dato';
                    if (showMarkers && incidentTsSet.has(ts)) return 'Incidencia en racha';
                    if (d.latency_ms == null) return 'Timeout';
                    return `Latencia: ${d.latency_ms} ms`;
                  },
                  afterLabel: (ctx) => {
                    const ts = allTs[ctx.dataIndex];
                    const d = byTs.get(ts);
                    if (!d) return [];
                    const lines = [];
                    if (d.packet_loss != null && d.packet_loss > 0) lines.push(`Pérdida paquetes: ${d.packet_loss}%`);
                    if (d.status && d.status !== 'ok') lines.push(`Estado: ${d.status}`);
                    return lines;
                  }
                }
              }
            },
            scales: {
              x: {
                display: true,
                ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0 },
                grid: { display: false }
              },
              y: {
                display: true,
                title: { display: true, text: 'ms', color: textColor, font: { size: 9 } },
                ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 4 },
                grid: { color: gridColor }
              }
            }
          }
        });

        chart.config._lossIndexes = lossIndexes;
        chart.config._timeoutIndexes = timeoutIndexes;
        _qualityCharts[t.id] = chart;
      }
    }

    const seenCardIds = new Set(
      data.targets
        .filter(t => t.enabled || (t.data && t.data.length))
        .map(t => `qcard_${t.id}`)
    );

    Array.from(container.querySelectorAll('.quality-chart-card[id^="qcard_"]') || []).forEach((el) => {
      if (!seenCardIds.has(el.id)) el.remove();
    });

    const last = data.targets.flatMap(t => t.data).sort((a,b) => b.checked_at.localeCompare(a.checked_at))[0];
    if (last) _setTextIfChanged('qualityLastUpdate', 'Último check: ' + qualityFmtTime(last.checked_at));
  }

  function _buildStats(avgMs, minMs, maxMs, upPct) {
    let html = '';
    if (avgMs != null) html += `<span class="quality-stat">⚡ Media: <strong>${avgMs}ms</strong></span> `;
    if (minMs != null) html += `<span class="quality-stat">↓ Min: ${minMs}ms</span> `;
    if (maxMs != null) html += `<span class="quality-stat">↑ Max: ${maxMs}ms</span> `;
    if (upPct != null) html += `<span class="quality-stat ms-auto">Disponibilidad: <strong style="color:${upPct>=95?'var(--accent)':upPct>=80?'#ffc107':'#ff6b6b'}">${upPct}%</strong></span>`;
    return html;
  }

  // Quality tab events — precarga los 3 rangos en paralelo al activar el tab
  function _qualityViewIsActive() {
    const view = document.getElementById('qualityView');
    const tab = document.getElementById('quality-tab');
    return !!(
      view && (view.classList.contains('show') || view.classList.contains('active'))
    ) || !!(
      tab && tab.classList.contains('active')
    );
  }

  function _kickoffQualityTabLoad() {
    const now = Date.now();
    if (now - _qualityKickoffAt < 800) {
      return;
    }
    _qualityKickoffAt = now;
    loadQualitySettings();
    loadQualityHistory();
    _precacheAllRanges();
  }

  document.getElementById('quality-tab').addEventListener('shown.bs.tab', () => {
    _kickoffQualityTabLoad();
  });

  setTimeout(() => {
    if (_qualityViewIsActive()) {
      _kickoffQualityTabLoad();
    }
  }, 350);

  // Range selector — al cambiar rango, destruir charts existentes para forzar recreación
  // con los datos del nuevo periodo (los colores de fondo pueden cambiar)
  $(document).on('click', '.quality-range-btn', function() {
    $('.quality-range-btn').removeClass('active');
    $(this).addClass('active');
    const newRange = parseInt($(this).data('range'));
    if (newRange !== _qualityRange) {
      _qualityLoadToken += 1;  // invalida respuestas viejas en vuelo
      // Destruir charts para que loadQualityHistory los recree con nueva escala temporal
      for (const id in _qualityCharts) { try { _qualityCharts[id].destroy(); } catch(e){} }
      _qualityCharts = {};
      const container = document.getElementById('qualityChartsContainer');
      if (container) container.innerHTML = '';
    }
    _qualityRange = newRange;
    loadQualityHistory();
  });

  // Toggle monitoring
  $('#qualityEnabled').on('change', async function() {
    const enabled = this.checked;
    const threshold = parseFloat($('#qualityThreshold').val()) || 200;
    const cooldown = parseInt($('#qualityCooldown').val()) || 30;
    const streak = Math.max(2, parseInt($('#qualityIncidentStreak').val(), 10) || 3);
    _qualityIncidentStreakMin = streak;
    const qs = $('#qualityQuietStart').val();
    const qe = $('#qualityQuietEnd').val();
    await fetch('/api/quality/settings', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ enabled, alert_threshold_pct: threshold, alert_cooldown_minutes: cooldown, incident_streak_min: streak, quiet_start: qs, quiet_end: qe, quality_interface: ($('#qualityInterface').val() || '').trim() })
    });
  });

  $('#qualitySaveSettings').on('click', async function() {
    const payload = {
      enabled: $('#qualityEnabled').prop('checked'),
      alert_threshold_pct: parseFloat($('#qualityThreshold').val()) || 200,
      alert_cooldown_minutes: parseInt($('#qualityCooldown').val()) || 30,
      incident_streak_min: Math.max(2, parseInt($('#qualityIncidentStreak').val(), 10) || 3),
      quality_interface: ($('#qualityInterface').val() || '').trim(),
      quiet_start: $('#qualityQuietStart').val(),
      quiet_end: $('#qualityQuietEnd').val(),
    };
    const res = await fetch('/api/quality/settings', {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      const $btn = $(this);
      $btn.html('<i class="bi bi-check-lg"></i> Guardado').addClass('btn-success');
      setTimeout(() => $btn.html('<i class="bi bi-floppy-fill"></i> Guardar configuración'), 3000);
    }
  });

  $(document).on('click', '#qualityOpenCreateModal', function() {
    _openQualityTargetModalForCreate().catch(() => {});
  });

  qualityTargetModalEl?.addEventListener('hidden.bs.modal', () => {
    _resetQualityTargetModal();
  });

  // Add / edit target — usa el mismo modal para alta y edición
  $('#qualityAddTarget').on('click', async function() {
    const tid       = ($('#qualityTargetEditId').val() || '').trim();
    const name      = $('#qualityNewName').val().trim();
    const host      = $('#qualityNewHost').val().trim();
    const iface     = ($('#qualityInterface').val() || '').trim();
    if (!name || !host) {
      showToast(window.t?.('quality.target_required', 'Nombre y Host son obligatorios') || 'Nombre y Host son obligatorios', 'warning');
      return;
    }

    const isEdit = !!tid;
    const res = await fetch(isEdit ? `/api/quality/targets/${tid}` : '/api/quality/targets', {
      method: isEdit ? 'PUT' : 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, host, interface: iface })
    });
    const data = await res.json();

    if (data.ok) {
      if (qualityTargetModal) qualityTargetModal.hide();
      _resetQualityTargetModal();
      showToast(window.t?.('quality.target_saved', 'Destino "{name}" ({host}) {action}{iface}', { name, host, action: isEdit ? (window.t?.('quality.action_updated', 'actualizado') || 'actualizado') : (window.t?.('quality.action_added', 'añadido') || 'añadido'), iface: iface ? ' · vía ' + iface : '' }) || `Destino "${name}" (${host}) ${isEdit ? 'actualizado' : 'añadido'}${iface ? ' · vía ' + iface : ''}`, 'success');
      await loadQualitySettings();
      await loadQualityHistory();
    }
  });

  $(document).on('click', '.btn-quality-edit', async function(e) {
    e.stopPropagation();
    const tid = $(this).data('tid');
    await _openQualityTargetModalForEdit(tid);
  });

  $(document).on('click', '.btn-quality-del', async function(e) {
    e.stopPropagation();
    const tid = $(this).data('tid');
    if (!(await window.appConfirm('¿Eliminar este destino y su historial?', {
      title: 'Eliminar destino de calidad',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    await fetch(`/api/quality/targets/${tid}`, {method:'DELETE'});
    await loadQualitySettings();
    await loadQualityHistory();
  });

  // ── Ping bajo demanda — columnas por destino, 1 ping/seg ──────────────
  let _pingAborted  = false;
  let _pingRunning  = false;
  let _pingLogLines = [];          // para descarga
  let _pingColData  = {};          // { targetName: [{ts, lat, loss, status}] }
  const _PING_ROWS  = 6;           // filas visibles por columna

  function _pingSetRunning(running) {
    _pingRunning = running;
    if (running) {
      $('#qualityCheckNow').prop('disabled', true).html('<i class="bi bi-arrow-repeat spin-icon"></i> Pingando…');
      $('#qualityPingStop').show();
      $('#qualityPingDownload').hide();
      $('#qualityPingCycle').show();
    } else {
      $('#qualityCheckNow').prop('disabled', false).html('<i class="bi bi-play-fill"></i> Iniciar pings');
      $('#qualityPingStop').hide();
      $('#qualityPingCycle').hide().text('');
      if (_pingLogLines.length) $('#qualityPingDownload').show();
    }
  }

  function _renderPingColumns() {
    const $wrap = $('#qualityPingColumns');
    const names = Object.keys(_pingColData);
    if (!names.length) return;

    // Actualizar cada columna
    names.forEach(name => {
      const colId = 'pingcol_' + name.replace(/[^a-z0-9]/gi,'_');
      let $col = $(`#${colId}`);

      if (!$col.length) {
        // Primera vez: crear la columna
        $col = $(`<div id="${colId}" style="flex:1 1 180px;min-width:160px;max-width:280px">
          <div style="font-size:.75rem;font-weight:600;color:var(--accent);margin-bottom:4px;padding:2px 6px;
                      background:rgba(77,255,181,0.08);border-radius:4px;white-space:nowrap;overflow:hidden;
                      text-overflow:ellipsis">${esc(name)}</div>
          <div class="pingcol-rows"
               style="font-family:monospace;font-size:.73rem;background:rgba(0,0,0,0.2);
                      border:1px solid rgba(255,255,255,0.07);border-radius:5px;
                      padding:5px 7px;height:calc(${_PING_ROWS} * 1.55em + 10px);
                      overflow-y:auto;line-height:1.55"></div>
        </div>`);
        $wrap.append($col);
      }

      const rows  = _pingColData[name];
      const $rows = $col.find('.pingcol-rows');
      $rows.empty();
      rows.forEach(r => {
        const ok    = r.status === 'ok';
        const color = ok ? '#4dffb5' : (r.loss > 0 && r.loss < 100 ? '#ffc107' : '#ff6b6b');
        const lat   = r.lat != null ? `${r.lat.toFixed(1)}ms` : '—';
        const loss  = r.loss > 0 ? `<span style="color:#ffc107"> ${r.loss}%↓</span>` : '';
        const icon  = ok ? '✓' : '✗';
        $rows[0].insertAdjacentHTML('beforeend',
          `<div><span style="opacity:.45">${r.ts}</span> <span style="color:${color}">${icon} ${lat}</span>${loss}</div>`
        );
      });
      // Auto-scroll al fondo
      $rows[0].scrollTop = $rows[0].scrollHeight;
    });
  }

  $('#qualityCheckNow').on('click', async function() {
    if (_pingRunning) return;
    _pingAborted  = false;
    _pingLogLines = [];
    _pingColData  = {};
    $('#qualityPingColumns').empty().css('display', 'flex');
    _pingSetRunning(true);

    // Leer targets una sola vez al inicio
    let targets = [];
    try {
      const tr = await fetch('/api/quality/targets');
      const td = await tr.json();
      targets = (td.targets || []).filter(t => t.enabled);
    } catch(e) {}

    if (!targets.length) {
      $('#qualityPingColumns').html('<span class="small-muted">No hay destinos activos configurados.</span>');
      _pingSetRunning(false);
      return;
    }

    // Inicializar columnas vacías
    targets.forEach(t => { _pingColData[t.name] = []; });
    _renderPingColumns();

    let ciclo = 0;

    while (!_pingAborted) {
      ciclo++;
      $('#qualityPingCycle').text(`Ciclo ${ciclo}`);

      try {
        const res  = await fetch('/api/quality/ping-now', { method: 'POST' });
        const data = await res.json();

        if (!data.ok) break;

        const ts = qualityFmtTime(new Date().toISOString());
        for (const r of data.results) {
          if (_pingAborted) break;
          const netName = r.interface && r.interface !== 'auto' ? (_ifaceToNetLabel[r.interface] || r.interface) : null;
          if (!_pingColData[r.name]) _pingColData[r.name] = [];
          _pingColData[r.name].push({
            ts, lat: r.latency_ms, loss: r.packet_loss || 0, status: r.status
          });
          // Mantener solo las últimas N filas
          if (_pingColData[r.name].length > 50) _pingColData[r.name].shift();
          // Log para descarga
          const icon = r.status === 'ok' ? '✓' : '✗';
          const via  = netName ? ` vía ${netName}` : '';
          _pingLogLines.push(`[${ts}] ${icon} ${r.name} (${r.host}) → ${r.latency_ms != null ? r.latency_ms.toFixed(1)+'ms' : '—'}${r.packet_loss > 0 ? ' pérd:'+r.packet_loss+'%' : ''}${via} [${r.status}]`);
        }
        _renderPingColumns();
        _scheduleQualityHistoryRefresh();

      } catch(e) {
        break;
      }

      // Pausa de 1 segundo entre ciclos chequeando abort
      await new Promise(r => setTimeout(r, 1000));
    }

    _pingSetRunning(false);
  });

  $('#qualityPingStop').on('click', function() {
    _pingAborted = true;
    // Add a visual stop marker in each column
    Object.keys(_pingColData).forEach(name => {
      _pingColData[name].push({ ts: '——', lat: null, loss: 0, status: 'stopped' });
    });
    _renderPingColumns();
    _pingSetRunning(false);
    _scheduleQualityHistoryRefresh(true);
  });

  $('#qualityPingDownload').on('click', function() {
    const blob = new Blob([_pingLogLines.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ping_log_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $(document).on('change', '#qualityDiagTarget', function() {
    const tid = ($(this).val() || '').trim();
    const t = _qualityTargetsById[String(tid)] || _qualityTargetsById[Number(tid)];
    if (!t) return;
    $('#qualityDiagHost').val((t.host || '').trim());
    $('#qualityDiagInterface').val((t.interface || '').trim());
    _qualityDiagSetStatus(
      t.interface
        ? `Destino cargado · interfaz preferida: ${t.interface}`
        : 'Destino cargado · interfaz automática',
      'text-info'
    );
  });

  $(document).on('click', '#qualityDiagRun', async function() {
    const tid = ($('#qualityDiagTarget').val() || '').trim();
    const t = _qualityTargetsById[String(tid)] || _qualityTargetsById[Number(tid)] || null;

    const host = ($('#qualityDiagHost').val() || '').trim() || (t?.host || '').trim();
    const interfaceName = ($('#qualityDiagInterface').val() || '').trim() || ((t?.interface || '').trim());
    const count = Math.max(1, Math.min(10, parseInt($('#qualityDiagCount').val() || '4', 10) || 4));
    const maxHops = Math.max(4, Math.min(30, parseInt($('#qualityDiagMaxHops').val() || '12', 10) || 12));
    const includeMtr = !!$('#qualityDiagIncludeMtr').prop('checked');

    if (!host) {
      _qualityDiagSetStatus('Indica un destino o selecciona uno configurado.', 'text-danger');
      return;
    }

    const $btn = $('#qualityDiagRun');
    const prevHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="bi bi-arrow-repeat spin-icon"></i> Ejecutando…');
    _qualityDiagResetResult(true);
    _qualityDiagSetStatus('Ejecutando ping, traceroute/tracepath y diagnóstico auxiliar…', 'text-info');

    try {
      const res = await fetch('/api/quality/diagnose-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          interface: interfaceName,
          count,
          max_hops: maxHops,
          include_mtr: includeMtr,
        }),
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'Error ejecutando diagnóstico');

      $('#qualityDiagHost').val(host);
      _qualityDiagRender(data, host, interfaceName);
      _qualityDiagSetStatus('Diagnóstico completado.', 'text-success');
    } catch (e) {
      _qualityDiagResetResult(true);
      _qualityDiagSetStatus(`Error: ${e.message}`, 'text-danger');
    } finally {
      $btn.prop('disabled', false).html(prevHtml);
    }
  });

  $(document).on('click', '#qualityDiagCopyReport', async function() {
    const text = String(_qualityDiagLastReport || $('#qualityDiagReportText').text() || '').trim();
    if (!text) {
      _qualityDiagSetStatus('No hay informe para copiar.', 'text-warning');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      _qualityDiagSetStatus('Informe copiado al portapapeles.', 'text-success');
    } catch (e) {
      _qualityDiagSetStatus(`No se pudo copiar el informe: ${e.message}`, 'text-danger');
    }
  });

  $(document).on('click', '#qualityDiagCopyPrompt', async function() {
    const text = _qualityDiagBuildAiPrompt();
    if (!text) {
      _qualityDiagSetStatus('No hay prompt IA para copiar.', 'text-warning');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      _qualityDiagSetStatus('Prompt IA copiado al portapapeles.', 'text-success');
    } catch (e) {
      _qualityDiagSetStatus(`No se pudo copiar el prompt IA: ${e.message}`, 'text-danger');
    }
  });

  $(document).on('click', '#qualityDiagAnalyzeAi', async function() {
    const payload = _qualityDiagCurrentPayload();
    if (!payload.host || (!payload.report_text && !payload.ping_output && !payload.trace_output && !payload.mtr_output)) {
      _qualityDiagSetStatus('No hay diagnóstico técnico suficiente para analizar con IA.', 'text-warning');
      return;
    }

    const $btn = $('#qualityDiagAnalyzeAi');
    const prevHtml = $btn.html();
    $btn.prop('disabled', true).html('<i class="bi bi-robot"></i> Analizando…');
    _qualityDiagSetStatus('Solicitando valoración IA…', 'text-info');
    $('#qualityDiagAiWrap').hide();
    $('#qualityDiagAiMeta').text('');
    $('#qualityDiagAiBody').html('');

    try {
      const res = await fetch('/api/quality/diagnose-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'Error');
      _qualityDiagRenderAiAnalysis(data);
      _qualityDiagSetStatus('Valoración IA completada.', 'text-success');
    } catch (e) {
      _qualityDiagSetStatus(`No se pudo obtener la valoración IA: ${e.message}`, 'text-danger');
    } finally {
      $btn.prop('disabled', false).html(prevHtml);
    }
  });

  // Auto-refresh calidad si pestaña activa — limpia caché del rango actual para obtener datos frescos
  let _qualityAutoRefreshTimer = null;
  function _qualityAutoRefreshMs() {
    return window.getFrontendRefreshMs('normal');
  }
  function _startQualityAutoRefreshTimer() {
    if (_qualityAutoRefreshTimer) clearInterval(_qualityAutoRefreshTimer);
    _qualityAutoRefreshTimer = setInterval(() => {
      if (document.getElementById('qualityView')?.classList.contains('active')) {
        _scheduleQualityHistoryRefresh(true);
      }
    }, _qualityAutoRefreshMs());
  }
  _startQualityAutoRefreshTimer();
  document.addEventListener('frontendrefreshsettingschange', _startQualityAutoRefreshTimer);

  // ══════════════════════════════════════════════════════════
  // QUALITY TABLE — load & export
  // ══════════════════════════════════════════════════════════
  function _ensureQualityExportDateDefaults() {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');
    const fromEl = document.getElementById('qualityExportFrom');
    const toEl = document.getElementById('qualityExportTo');
    if (fromEl && !fromEl.value) fromEl.value = today;
    if (toEl && !toEl.value) toEl.value = today;
    return {
      from: fromEl ? fromEl.value : '',
      to: toEl ? toEl.value : ''
    };
  }

  _ensureQualityExportDateDefaults();

  window.populateQualityExportTargets = async function populateQualityExportTargets() {
    _ensureQualityExportDateDefaults();
    const res = await fetch('/api/quality/targets');
    const data = await res.json();
    const sel = document.getElementById('qualityExportTarget');
    sel.innerHTML = '<option value="0">Todos</option>';
    for (const t of (data.targets || [])) {
      sel.innerHTML += `<option value="${t.id}">${esc(t.name)} (${esc(t.host)})</option>`;
    }
  }

  window.loadQualityTable = async function loadQualityTable() {
    const { from, to } = _ensureQualityExportDateDefaults();
    const tid       = document.getElementById('qualityExportTarget').value;
    const lossOnly  = document.getElementById('qualityLossOnly')?.checked;
    const lossMin   = Math.max(0, parseInt(document.getElementById('qualityLossMin')?.value || '1', 10) || 1);
    const params    = new URLSearchParams();
    if (from) params.set('date_from', from);
    if (to)   params.set('date_to', to);
    if (tid && tid !== '0') params.set('target_id', tid);
    // Load via the same CSV endpoint but parse JSON from history
    // Use history API with computed days
    let days = 30;
    if (from) {
      const diffMs = Date.now() - new Date(from).getTime();
      days = Math.max(1, Math.ceil(diffMs / 86400000) + 1);
    }
    const res  = await fetch(`/api/quality/history?days=${days}`);
    const data = await res.json();
    if (!data.ok) return;

    const fromDate = from ? new Date(from + 'T00:00:00') : null;
    const toDate   = to   ? new Date(to   + 'T23:59:59') : null;
    const targetId = tid && tid !== '0' ? parseInt(tid) : null;

    let rows = [];
    for (const t of data.targets) {
      if (targetId && t.id !== targetId) continue;
      for (const d of t.data) {
        const dt = new Date(d.checked_at);
        if (fromDate && dt < fromDate) continue;
        if (toDate   && dt > toDate)   continue;

        const packetLoss = Number(d.packet_loss || 0);
        const status = String(d.status || '').toLowerCase();
        const isHardError = ['error', 'down', 'timeout'].includes(status);
        const passesLossFilter = packetLoss >= lossMin;
        const isLossOrError = isHardError || passesLossFilter;

        if (lossOnly && !isLossOrError) continue;

        rows.push({ target: t.name, host: t.host, ...d });
      }
    }
    rows.sort((a,b) => b.checked_at.localeCompare(a.checked_at));

    const tbody = document.getElementById('qualityDataTbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center small-muted py-3">${esc(window.t?.('quality.no_range_data', 'Sin datos para el rango seleccionado') || 'Sin datos para el rango seleccionado')}</td></tr>`;
      document.getElementById('qualityTableStatus').textContent = window.t?.('quality.table_zero', '0 registros') || '0 registros';
      return;
    }
    const tableLimit = window.getFrontendLimit('table_rows');
    tbody.innerHTML = rows.slice(0, tableLimit).map(r => {
      const statusClass = r.status === 'ok' ? 'ok' : 'bad';
      const lat = r.latency_ms != null ? r.latency_ms.toFixed(1) + ' ms' : '—';
      const loss = r.packet_loss != null ? r.packet_loss + '%' : '—';
      return `<tr>
        <td>${esc(r.target)}</td>
        <td class="mono">${esc(r.host)}</td>
        <td class="mono">${qualityFmtDateTime(r.checked_at)}</td>
        <td class="${statusClass}">${lat}</td>
        <td>${loss}</td>
        <td><span class="${statusClass}">${esc(r.status)}</span></td>
      </tr>`;
    }).join('');
    document.getElementById('qualityTableStatus').textContent =
      window.t?.('quality.table_status', '{count} registros{suffix}', {
        count: rows.length,
        suffix: rows.length > tableLimit
          ? (window.t?.('quality.table_status_limited', ' (mostrando primeros {limit})', { limit: tableLimit }) || ` (mostrando primeros ${tableLimit})`)
          : ''
      }) || `${rows.length} registros${rows.length > tableLimit ? ` (mostrando primeros ${tableLimit})` : ''}`;
  }

  $('#qualityLoadTable').on('click', loadQualityTable);

  $('#qualityExportCsv').on('click', function() {
  const { from, to } = _ensureQualityExportDateDefaults();
  const tid  = parseInt($('#qualityExportTarget').val() || '0');
  const lossOnly = $('#qualityLossOnly').prop('checked') ? 1 : 0;
  const lossMin  = parseInt($('#qualityLossMin').val() || '1');

  const qs = new URLSearchParams();
  if (from) qs.set('date_from', from);
  if (to)   qs.set('date_to', to);
  if (tid)  qs.set('target_id', String(tid));
  if (lossOnly) {
    qs.set('loss_only', '1');
    qs.set('loss_min', String(lossMin));
  }
  // Abrir descarga
  window.open(`/api/quality/export.csv?${qs.toString()}`, '_blank');
});

  // (quality-tab listener merged into $(function block above)

  // ══════════════════════════════════════════════════════════
  // SCAN NOTES — inline editing in scans table
  // ══════════════════════════════════════════════════════════
  $(document).on('click', '.scan-note-btn', async function() {
    const scanId = $(this).data('id');
    const current = $(this).data('note') || '';
    const newNote = await window.appPrompt(`Nota para scan #${scanId}:`, current, {
      title: 'Nota de scan',
      confirmText: 'Guardar'
    });
    if (newNote === null) return;
    const res = await fetch(`/api/scans/${scanId}/notes`, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({notes: newNote})
    });
    if ((await res.json()).ok) {
      $(this).data('note', newNote).attr('title', newNote || 'Sin nota')
        .toggleClass('text-warning', !!newNote)
        .find('span').text(newNote ? '💬' : '📝');
      if (typeof window.loadScans === 'function') window.loadScans();
    }
  });


  document.getElementById('quality-tab')?.addEventListener('shown.bs.tab', () => {
    loadQualityDiagnosticOptions().catch(() => {});
  });

  setTimeout(() => {
    if (_qualityViewIsActive()) loadQualityDiagnosticOptions().catch(() => {});
  }, 0);



}); // end $(function) — quality.js
