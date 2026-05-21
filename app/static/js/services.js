// ════════════════════════════════════════════════════════
//  services.js — Auditor IPs · Servicios TCP/HTTP
//  Monitor servicios, cards, historial, gráficas, edición
// ════════════════════════════════════════════════════════
$(function() {
  const SVC_TYPE_ICONS = {
    generic:'🔌', http:'🌐', https:'🔒', immich:'📷',
    plex:'🎬', jellyfin:'🎵', qbittorrent:'⬇️', pihole:'🛡️', omnitools:'🛠️'
  };
  window.SVC_TYPE_ICONS = SVC_TYPE_ICONS;
  window.SVC_TYPE_ICONS = SVC_TYPE_ICONS;

  function svcFmtTime(value) {
    if (!value) return '—';
    if (typeof window.fmtTime === 'function') {
      const formatted = window.fmtTime(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function svcFmtDate(value) {
    if (!value) return '—';
    if (typeof window.fmtDate === 'function') {
      const formatted = window.fmtDate(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function svcFmtDateTime(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function svcFmtChartLabel(value, range) {
    if (range === 'day') return svcFmtTime(value);
    if (range === 'week') return svcFmtDateTime(value);
    return svcFmtDate(value);
  }

  function svcFmtNumber(value) {
    if (typeof window.fmtNumber === 'function') {
      const formatted = window.fmtNumber(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function svcExpectedScheduleState(svc) {
    return svc?.expected_schedule_state || {
      enabled: !!svc?.expected_schedule_enabled,
      in_expected_window: true,
      label: '',
      detail: '',
      state: 'not_configured'
    };
  }

  function svcExpectedScheduleBadge(svc) {
    const state = svcExpectedScheduleState(svc);
    if (!state.enabled) return '';

    const st = String(svc?.last_status || '').toLowerCase();
    const breach = state.in_expected_window && st && st !== 'up';
    const cls = !state.in_expected_window
      ? 'bg-secondary'
      : breach
        ? 'bg-danger'
        : 'bg-success';
    const label = breach ? 'Incumplimiento horario' : (state.label || 'Horario esperado');
    const detail = state.detail ? ` · ${esc(state.detail)}` : '';

    return `<span class="badge ${cls}" title="${esc(label + (state.detail ? ' · ' + state.detail : ''))}">
      <i class="bi bi-calendar-check me-1"></i>${esc(label)}${detail}
    </span>`;
  }

  function svcExpectedScheduleDays(svc) {
    const raw = String(svc?.expected_schedule_days || '1,2,3,4,5,6,7');
    const selected = new Set(raw.split(',').map(x => x.trim()).filter(Boolean));
    return ['1','2','3','4','5','6','7'].map(value => ({
      value,
      label: ['L','M','X','J','V','S','D'][Number(value) - 1],
      checked: selected.has(value),
    }));
  }

  function renderSvcExpectedScheduleEditor(svc) {
    const enabled = !!svc?.expected_schedule_enabled;
    const start = esc(svc?.expected_schedule_start || '');
    const end = esc(svc?.expected_schedule_end || '');
    const dayChecks = svcExpectedScheduleDays(svc).map(day => `
      <label class="form-check form-check-inline mb-0 small-muted" style="font-size:.76rem">
        <input class="form-check-input ef-expected-day" type="checkbox" value="${day.value}" ${day.checked ? 'checked' : ''}>
        ${day.label}
      </label>
    `).join('');

    return `
      <div class="col-12">
        <div class="p-2 rounded" style="border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03)">
          <label class="form-check form-switch d-flex align-items-center gap-2 mb-2">
            <input class="form-check-input ef-expected-enabled" type="checkbox" ${enabled ? 'checked' : ''}>
            <span class="small-muted" style="font-size:.78rem">Horario esperado de funcionamiento</span>
          </label>
          <div class="row g-2 align-items-end">
            <div class="col-12 col-md-5">
              <div class="small-muted mb-1" style="font-size:.72rem">Días activos</div>
              <div>${dayChecks}</div>
            </div>
            <div class="col-6 col-md-3">
              <label class="small-muted" style="font-size:.72rem">Inicio</label>
              <input type="time" class="form-control form-control-sm ef-expected-start" value="${start}">
            </div>
            <div class="col-6 col-md-3">
              <label class="small-muted" style="font-size:.72rem">Fin</label>
              <input type="time" class="form-control form-control-sm ef-expected-end" value="${end}">
            </div>
            <div class="col-12">
              <div class="small-muted" style="font-size:.72rem">
                Fuera de esta franja se siguen guardando checks, pero no se envían alertas de caída/timeout.
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function svcExpectedSchedulePayload(form) {
    const days = form.find('.ef-expected-day:checked').map(function(){ return this.value; }).get();
    return {
      expected_schedule_enabled: form.find('.ef-expected-enabled').is(':checked'),
      expected_schedule_days: days.length ? days.join(',') : '1,2,3,4,5,6,7',
      expected_schedule_start: form.find('.ef-expected-start').val() || '',
      expected_schedule_end: form.find('.ef-expected-end').val() || '',
    };
  }


  function renderSvcInfo(infoJson) {
    if (!infoJson) return '';
    let info = {};
    try { info = JSON.parse(infoJson); } catch(e) { return ''; }
    const badges = [];
    if (info.version)      badges.push(`<span class="svc-info-badge">v${esc(info.version)}</span>`);
    if (info.server_name)  badges.push(`<span class="svc-info-badge">${esc(info.server_name)}</span>`);
    if (info.status)       badges.push(`<span class="svc-info-badge">Estado: ${esc(info.status)}</span>`);
    if (info.photos != null)    badges.push(`<span class="svc-info-badge">📷 ${esc(svcFmtNumber(info.photos))}</span>`);
    if (info.videos != null)    badges.push(`<span class="svc-info-badge">🎬 ${esc(svcFmtNumber(info.videos))}</span>`);
    if (info.usage_gb != null)  badges.push(`<span class="svc-info-badge">💾 ${info.usage_gb} GB</span>`);
    if (info.dl_kbs != null)    badges.push(`<span class="svc-info-badge">⬇ ${info.dl_kbs} KB/s</span>`);
    if (info.up_kbs != null)    badges.push(`<span class="svc-info-badge">⬆ ${info.up_kbs} KB/s</span>`);
    if (info.blocked_today != null) badges.push(`<span class="svc-info-badge">🛡 ${esc(svcFmtNumber(info.blocked_today))} bloqueadas</span>`);
    if (info.block_pct != null) badges.push(`<span class="svc-info-badge">${info.block_pct}% block</span>`);
    if (info.queries_today != null) badges.push(`<span class="svc-info-badge">${esc(svcFmtNumber(info.queries_today))} queries</span>`);
    return badges.length ? `<div class="d-flex flex-wrap gap-1 mt-1">${badges.join('')}</div>` : '';
  }

  function renderSvcCard(svc) {
    const rawStatusClass = svc.last_status === 'up' ? 'up' : svc.last_status === 'down' ? 'down' : 'unknown';
    const scheduleState = svcExpectedScheduleState(svc);
    const statusClass = scheduleState.enabled && !scheduleState.in_expected_window ? 'unknown' : rawStatusClass;
    const scheduleBadge = svcExpectedScheduleBadge(svc);
    const latText     = svc.last_latency != null ? `${svc.last_latency}ms` : '—';
    const icon        = SVC_TYPE_ICONS[svc.service_type] || '🔌';
    const checkedAt   = svcFmtTime(svc.last_checked);
    const infoHtml    = renderSvcInfo(svc.last_info);
    const errHtml     = (svc.last_status !== 'up' && svc.last_error)
      ? `<div style="font-size:.72rem;color:#ff8080;margin-top:4px">${esc(svc.last_error.slice(0,80))}</div>` : '';
    // URL de acceso: usa access_url si existe, o construye desde host:port
    const accessUrl   = svc.access_url || `http://${svc.host}:${svc.port}`;
    const SVC_TYPE_DEFAULTS = { immich:2283, plex:32400, jellyfin:8096, qbittorrent:8080, pihole:80 };
    const defaultPorts = Object.values(SVC_TYPE_DEFAULTS);
    const hasCustomAccess = !!svc.access_url;

    return `
      <div class="col-12 col-md-6 col-lg-4" data-svc-id="${svc.id}">
        <div class="svc-card svc-${statusClass}" data-svc-id="${svc.id}" data-svc='${JSON.stringify(svc).replace(/'/g,"&#39;")}'>
          <div class="svc-card-head d-flex justify-content-between align-items-start gap-2">
            <div class="d-flex gap-2 align-items-center" style="overflow:hidden">
              <div class="svc-status-dot ${statusClass}" style="flex-shrink:0"></div>
              <div style="overflow:hidden">
                <a href="${esc(accessUrl)}" target="_blank" rel="noopener"
                   class="svc-title text-decoration-none d-flex align-items-center gap-1"
                   title="${esc(window.t?.('services.open_external', 'Abrir {url} en nueva pestaña', { url: accessUrl }) || ('Abrir ' + accessUrl + ' en nueva pestaña'))}" style="color:inherit">
                  ${icon} ${esc(svc.name)}
                  <i class="bi bi-box-arrow-up-right" style="font-size:.65rem;opacity:.5"></i>
                </a>
                <div class="svc-host">${esc(svc.host)}:${svc.port}${hasCustomAccess ? ' <span style="opacity:.5;font-size:.7rem">→ acceso: '+esc(svc.access_url)+'</span>' : ''}</div>
              </div>
            </div>
            <div class="d-flex gap-1 flex-shrink-0">
              <button class="btn btn-outline-secondary btn-sm btn-ico btn-svc-edit" data-id="${svc.id}" title="${esc(window.t?.('common.edit', 'Editar') || 'Editar')}">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-outline-primary btn-sm btn-ico btn-svc-history" data-id="${svc.id}" title="${esc(window.t?.('common.history', 'Historial') || 'Historial')}">
                <i class="bi bi-graph-up"></i>
              </button>
              <button class="btn btn-outline-info btn-sm btn-ico btn-svc-check" data-id="${svc.id}" title="${esc(window.t?.('common.check_now', 'Check ahora') || 'Check ahora')}">
                <i class="bi bi-arrow-repeat"></i>
              </button>
              <button class="btn btn-outline-${svc.enabled ? 'warning' : 'success'} btn-sm btn-ico btn-svc-toggle" data-id="${svc.id}">
                <i class="bi bi-${svc.enabled ? 'pause' : 'play'}-fill"></i>
              </button>
              <button class="btn btn-outline-danger btn-sm btn-ico btn-svc-del" data-id="${svc.id}">
                <i class="bi bi-trash3"></i>
              </button>
            </div>
          </div>
          <div class="svc-card-status-row d-flex gap-3 mt-2 align-items-center flex-wrap">
            <span class="badge ${svc.last_status === 'up' ? 'bg-success' : svc.last_status === 'down' ? 'bg-danger' : 'bg-secondary'}">
              ${(svc.last_status || 'Sin datos').toUpperCase()}
            </span>
            <span class="svc-latency">${latText}</span>
            ${scheduleBadge}
            <span class="svc-latency ms-auto">Último: ${checkedAt}</span>
          </div>
          <div class="svc-card-meta-extra">${infoHtml}${errHtml}</div>
          <div class="svc-chart-wrap" id="svcChartWrap_${svc.id}">
            <canvas id="svcChart_${svc.id}"></canvas>
          </div>
          <div class="svc-time-selector">
            <button class="svc-time-btn active" data-svc="${svc.id}" data-range="day">1D</button>
            <button class="svc-time-btn" data-svc="${svc.id}" data-range="week">7D</button>
            <button class="svc-time-btn" data-svc="${svc.id}" data-range="month">30D</button>
            <button class="svc-time-btn" data-svc="${svc.id}" data-range="quarter">90D</button>
          </div>

          <!-- Formulario edición inline (oculto por defecto) -->
          <div class="svc-edit-form" id="svcEdit_${svc.id}">
            <div class="row g-2">
              <div class="col-12 col-sm-6"><label class="small-muted" style="font-size:.72rem">Nombre</label>
                <input class="form-control form-control-sm ef-name" value="${esc(svc.name)}"></div>
              <div class="col-6 col-sm-3"><label class="small-muted" style="font-size:.72rem">Host</label>
                <input class="form-control form-control-sm ef-host" value="${esc(svc.host)}"></div>
              <div class="col-6 col-sm-3"><label class="small-muted" style="font-size:.72rem">Puerto</label>
                <input type="number" class="form-control form-control-sm ef-port" value="${svc.port}"></div>
              <div class="col-6 col-sm-4"><label class="small-muted" style="font-size:.72rem">Tipo</label>
                <select class="form-select form-select-sm ef-type">
                  ${['generic','http','https','immich','plex','jellyfin','qbittorrent','pihole','omnitools']
                    .map(t => `<option value="${t}" ${svc.service_type===t?'selected':''}>${t}</option>`).join('')}
                </select></div>
              <div class="col-6 col-sm-4"><label class="small-muted" style="font-size:.72rem">URL check</label>
                <input class="form-control form-control-sm ef-url" value="${esc(svc.service_url||'')}" placeholder="http://ip:port"></div>
              <div class="col-6 col-sm-4"><label class="small-muted" style="font-size:.72rem">URL acceso <span style="opacity:.5">(opcional)</span></label>
                <input class="form-control form-control-sm ef-access" value="${esc(svc.access_url||'')}" placeholder="https://mi.dominio.com"></div>
              <div class="col-6 col-sm-3"><label class="small-muted" style="font-size:.72rem">Intervalo (s)</label>
                <input type="number" class="form-control form-control-sm ef-interval" value="${svc.check_interval}" min="30"></div>
              ${renderSvcExpectedScheduleEditor(svc)}
              <div class="col-12 col-sm-9"><label class="small-muted" style="font-size:.72rem">Notas</label>
                <input class="form-control form-control-sm ef-notes" value="${esc(svc.notes||'')}"></div>
              <div class="col-12 d-flex gap-2 justify-content-end">
                <button class="btn btn-secondary btn-sm btn-svc-edit-cancel" data-id="${svc.id}">Cancelar</button>
                <button class="btn btn-success btn-sm btn-svc-save" data-id="${svc.id}">
                  <i class="bi bi-save2"></i> Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }


  function buildSvcCardNode(svc) {
    const tpl = document.createElement('template');
    tpl.innerHTML = renderSvcCard(svc).trim();
    return tpl.content.firstElementChild;
  }

  function updateSvcCardNode(node, svc) {
    const freshNode = buildSvcCardNode(svc);
    const currentCard = node?.querySelector('.svc-card');
    const nextCard = freshNode?.querySelector('.svc-card');
    if (!node || !currentCard || !nextCard) return;

    node.dataset.snapshot = svcSnapshot(svc);
    node.dataset.svcId = String(svc.id);

    currentCard.className = nextCard.className;
    currentCard.dataset.svcId = String(svc.id);
    currentCard.setAttribute('data-svc', nextCard.getAttribute('data-svc') || '');

    ['.svc-card-head', '.svc-card-status-row', '.svc-card-meta-extra', '.svc-time-selector'].forEach((sel) => {
      const cur = currentCard.querySelector(sel);
      const nxt = nextCard.querySelector(sel);
      if (cur && nxt) cur.innerHTML = nxt.innerHTML;
    });

    const editForm = currentCard.querySelector('.svc-edit-form');
    const nextEditForm = nextCard.querySelector('.svc-edit-form');
    if (editForm && nextEditForm && !editForm.classList.contains('open')) {
      editForm.innerHTML = nextEditForm.innerHTML;
    }
  }


  function svcSnapshot(svc) {
    return JSON.stringify([
      svc.id,
      svc.enabled,
      svc.name,
      svc.host,
      svc.port,
      svc.service_type,
      svc.service_url || '',
      svc.access_url || '',
      svc.check_interval,
      svc.notes || '',
      svc.last_status || '',
      svc.last_latency ?? null,
      svc.last_checked || '',
      svc.last_error || '',
      svc.last_info || '',
      svc.uptime_pct ?? null,
      svc.expected_schedule_enabled ?? null,
      svc.expected_schedule_days || '',
      svc.expected_schedule_start || '',
      svc.expected_schedule_end || '',
      svc.expected_schedule_state?.state || '',
    ]);
  }

  function servicesTableSnapshot(svcs) {
    return JSON.stringify((svcs || []).map(svc => ([
      svc.id,
      svc.last_status || '',
      svc.name,
      svc.host,
      svc.port,
      svc.service_type,
      svc.last_latency ?? null,
      svc.uptime_pct ?? null,
      svc.last_checked || '',
      svc.check_interval ?? null,
      svc.expected_schedule_enabled ?? null,
      svc.expected_schedule_days || '',
      svc.expected_schedule_start || '',
      svc.expected_schedule_end || '',
      svc.expected_schedule_state?.state || '',
    ])));
  }

  let _servicesTableSnap = '';
  let _servicesSummarySnap = '';
  let _servicesEmptyState = '';

  window.loadServices = async function loadServices() {
    try {
      const res  = await fetch('/api/services', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) return;

      const grid = document.getElementById('servicesGrid');
      if (!grid) return;

      const svcs = data.services || [];
      const upCount = svcs.filter(s => s.last_status === 'up').length;
      const dnCount = svcs.filter(s => s.last_status === 'down').length;
      const summaryHtml =
        `${svcs.length} servicios · <span style="color:var(--accent)">▲ ${upCount} arriba</span> · <span style="color:#ff6b6b">▼ ${dnCount} caídos</span>`;
      if (_servicesSummarySnap !== summaryHtml) {
        document.getElementById('svcSummary').innerHTML = summaryHtml;
        _servicesSummarySnap = summaryHtml;
      }

      if (svcs.length === 0) {
        const emptyHtml = '<div class="col-12 small-muted">Sin servicios configurados. Añade uno arriba.</div>';
        if (_servicesEmptyState !== emptyHtml || !grid.children.length) {
          grid.innerHTML = emptyHtml;
          _servicesEmptyState = emptyHtml;
        }
        renderServicesTable(svcs);
        return;
      }

      _servicesEmptyState = '';

      const existing = new Map(
        Array.from(grid.children)
          .filter((el) => el?.dataset?.svcId)
          .map((el) => [String(el.dataset.svcId || ''), el])
      );
      const seen = new Set();

      for (const svc of svcs) {
        const id = String(svc.id);
        const nextSnap = svcSnapshot(svc);
        const activeRange = svcChartRanges[id] || 'day';
        let node = existing.get(id);

        if (!node) {
          node = buildSvcCardNode(svc);
          node.dataset.snapshot = nextSnap;
        } else if (node.dataset.snapshot !== nextSnap) {
          if (!node.querySelector('.svc-edit-form.open')) {
            updateSvcCardNode(node, svc);
          }
        }

        node.querySelectorAll('.svc-time-btn').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.range === activeRange);
        });

        grid.appendChild(node);
        seen.add(id);
        loadSvcHistory(svc.id, activeRange);
      }

      existing.forEach((node, id) => {
        if (!seen.has(id)) node.remove();
      });

      renderServicesTable(svcs);
    } catch(e) {
      console.error('loadServices:', e);
    }
  }

  function renderServicesTable(svcs) {
    const tbody = document.getElementById('servicesTableBody');
    if (!tbody) return;
    const nextSnap = servicesTableSnapshot(svcs);
    if (_servicesTableSnap === nextSnap) return;
    _servicesTableSnap = nextSnap;
    tbody.innerHTML = svcs.map(svc => {
      const st = svc.last_status || '';
      const stBadge = st === 'up'
        ? '<span class="badge bg-success">UP</span>'
        : st === 'down'
          ? '<span class="badge bg-danger">DOWN</span>'
          : st === 'timeout'
            ? '<span class="badge bg-warning text-dark">TIMEOUT</span>'
            : '<span class="badge bg-secondary">—</span>';
      const icon = SVC_TYPE_ICONS[svc.service_type] || '🔌';
      const lat = svc.last_latency != null ? `${svc.last_latency}ms` : '—';
      const checkedAt = svcFmtTime(svc.last_checked);
      const scheduleInline = svcExpectedScheduleBadge(svc);
      const accessUrl = svc.access_url || `http://${svc.host}:${svc.port}`;
      // Uptime from recent checks if available
      const uptime = svc.uptime_pct != null ? `${svc.uptime_pct}%` : '—';
      return `<tr>
        <td>${stBadge}</td>
        <td>
          <a href="${esc(accessUrl)}" target="_blank" class="text-decoration-none" style="color:inherit">${icon} ${esc(svc.name)}</a>
          ${scheduleInline ? `<div class="mt-1">${scheduleInline}</div>` : ''}
        </td>
        <td class="mono small">${esc(svc.host)}:${svc.port}</td>
        <td><span class="badge bg-secondary">${esc(svc.service_type)}</span></td>
        <td class="mono">${lat}</td>
        <td>${uptime}</td>
        <td class="small">${checkedAt}</td>
        <td class="small">${svc.check_interval}s</td>
        <td>
          <button class="btn btn-outline-primary btn-sm btn-ico btn-svc-history" data-id="${svc.id}" title="${esc(window.t?.('common.history', 'Historial') || 'Historial')}"><i class="bi bi-graph-up"></i></button>
          <button class="btn btn-outline-info btn-sm btn-ico btn-svc-check" data-id="${svc.id}" title="${esc(window.t?.('common.check_now', 'Check ahora') || 'Check ahora')}"><i class="bi bi-arrow-repeat"></i></button>
          <button class="btn btn-outline-secondary btn-sm btn-ico btn-svc-edit" data-id="${svc.id}" title="${esc(window.t?.('common.edit', 'Editar') || 'Editar')}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-outline-danger btn-sm btn-ico btn-svc-del" data-id="${svc.id}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
        </td>
      </tr>`;
    }).join('');
  }

  // View toggle
  let _svcView = 'grid';
  $(document).on('click', '#svcViewGrid', function() {
    _svcView = 'grid';
    $('#svcViewGrid').addClass('active'); $('#svcViewTable').removeClass('active');
    $('#servicesGrid').show(); $('#servicesTableWrap').hide();
  });
  $(document).on('click', '#svcViewTable', function() {
    _svcView = 'table';
    $('#svcViewTable').addClass('active'); $('#svcViewGrid').removeClass('active');
    $('#servicesGrid').hide(); $('#servicesTableWrap').show();
  });


  // Store for svc charts
  const svcCharts = {};
  const svcChartRanges = {};

  async function loadSvcHistory(svcId, range) {
    range = range || 'day';
    svcChartRanges[String(svcId)] = range;

    // Configuración por rango: días a pedir, tamaño de bucket en minutos, nº max ticks eje X
    const cfgMap = {
      day:     { days: 1,  bucketMin: 15,   maxTicks: 6  },
      week:    { days: 7,  bucketMin: 120,  maxTicks: 7  },
      month:   { days: 30, bucketMin: 720,  maxTicks: 10 },
      quarter: { days: 90, bucketMin: 1440, maxTicks: 10 },
    };
    const cfg = cfgMap[range] || cfgMap.day;

    try {
      const res  = await fetch(`/api/services/${svcId}/history?days=${cfg.days}&limit=${window.getFrontendLimit('history')}`);
      const data = await res.json();
      const canvas = document.getElementById(`svcChart_${svcId}`);
      if (!canvas || !data.ok) return;

      const existingChart = svcCharts[svcId];
      if (existingChart && existingChart.canvas !== canvas) {
        existingChart.destroy();
        delete svcCharts[svcId];
      }

      // Los datos vienen DESC, los invertimos
      const hist = (data.history || []).slice().reverse();

      if (!hist.length) {
        if (svcCharts[svcId]) { svcCharts[svcId].destroy(); delete svcCharts[svcId]; }
        return;
      }

      // Construir buckets de tiempo
      const bucketMs  = cfg.bucketMin * 60 * 1000;
      const nowMs     = Date.now();
      const sinceMs   = nowMs - cfg.days * 86400000;

      // Redondear sinceMs al bucket más cercano
      const startMs   = Math.floor(sinceMs / bucketMs) * bucketMs;
      const numBuckets= Math.ceil((nowMs - startMs) / bucketMs);

      const buckets = [];
      for (let i = 0; i < numBuckets; i++) {
        buckets.push({ t: startMs + i * bucketMs, checks: [] });
      }

      for (const h of hist) {
        const ts = new Date(h.checked_at).getTime();
        const idx = Math.floor((ts - startMs) / bucketMs);
        if (idx >= 0 && idx < buckets.length) buckets[idx].checks.push(h);
      }

      // Para cada bucket: latencia promedio y estado dominante
      const labels = [], latencyData = [], statusColors = [], tooltipMeta = [];

      for (const b of buckets) {
        const fmt = svcFmtChartLabel(b.t, range);
        labels.push(fmt);

        if (!b.checks.length) {
          latencyData.push(null);
          statusColors.push('rgba(255,255,255,0.08)');
          tooltipMeta.push(null);
          continue;
        }

        const ups = b.checks.filter(c => c.status === 'up').length;
        const downs = b.checks.filter(c => c.status === 'down').length;
        const timeouts = b.checks.filter(c => c.status === 'timeout').length;
        const total = b.checks.length;
        const upPct = Math.round(ups / total * 100);

        const lats = b.checks.filter(c => c.latency_ms != null).map(c => c.latency_ms);
        const avgLat = lats.length ? Math.round(lats.reduce((a,b)=>a+b,0)/lats.length) : null;

        // Color basado en disponibilidad del bucket
        let col;
        if (upPct >= 80)      col = accentColor(0.5 + upPct/200);
        else if (upPct >= 40) col = 'rgba(255,193,7,0.8)';
        else                  col = 'rgba(255,107,107,0.8)';

        latencyData.push(avgLat || 1);
        statusColors.push(col);
        tooltipMeta.push({ ups, downs, timeouts, total, upPct, avgLat,
                           dateStr: svcFmtDateTime(b.t) });
      }

      const ctx = canvas.getContext('2d');

      // Uptime % per bucket for the availability line
      const uptimeData = tooltipMeta.map(m => m ? m.upPct : null);

      // If chart already exists, update data in-place (no destroy → no flicker).
      if (svcCharts[svcId]) {
        const chart = svcCharts[svcId];
        chart.data.labels                         = labels;
        chart.data.datasets[0].data               = latencyData;
        chart.data.datasets[0].backgroundColor    = statusColors;
        chart.data.datasets[1].data               = uptimeData;
        // Store updated tooltipMeta so tooltip callbacks still work
        chart._tooltipMeta = tooltipMeta;
        chart.update('none');
        return;
      }

      // Gradient fill for latency (first render only)
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.offsetHeight || 80);
      gradient.addColorStop(0, accentColor(0.4));
      gradient.addColorStop(1, accentColor(0.02));

      svcCharts[svcId] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              // Latency bars
              type: 'bar',
              label: 'Latencia (ms)',
              data: latencyData,
              backgroundColor: statusColors,
              borderRadius: 3,
              borderWidth: 0,
              barPercentage: 0.85,
              categoryPercentage: 1.0,
              minBarLength: 4,
              yAxisID: 'y',
            },
            {
              // Uptime % smooth line overlay
              type: 'line',
              label: 'Uptime %',
              data: uptimeData,
              borderColor: 'rgba(255,255,255,0.25)',
              backgroundColor: 'transparent',
              borderWidth: 1,
              pointRadius: 0,
              tension: 0.4,
              spanGaps: true,
              yAxisID: 'y2',
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(14,18,26,0.97)',
              titleColor: '#fff',
              bodyColor: 'rgba(255,255,255,0.75)',
              borderColor: 'rgba(255,255,255,0.12)',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              callbacks: {
                title: (ctx) => {
                  // Use _tooltipMeta attached to chart instance (survives in-place updates)
                  const chart  = svcCharts[svcId];
                  const meta   = chart?._tooltipMeta || tooltipMeta;
                  const m = meta[ctx[0].dataIndex];
                  return m ? m.dateStr : ctx[0].label;
                },
                label: (ctx) => {
                  if (ctx.datasetIndex !== 0) return null;
                  const chart  = svcCharts[svcId];
                  const meta   = chart?._tooltipMeta || tooltipMeta;
                  const m = meta[ctx.dataIndex];
                  if (!m) return 'Sin datos en este intervalo';
                  const statusIcon = m.upPct >= 80 ? '🟢' : m.upPct >= 40 ? '🟡' : '🔴';
                  const lines = [
                    `${statusIcon} Disponibilidad: ${m.upPct}%  (↑${m.ups} ↓${m.downs}${m.timeouts ? ' ⏱'+m.timeouts : ''})`,
                  ];
                  if (m.avgLat != null) lines.push(`⚡ Latencia: ${m.avgLat}ms`);
                  lines.push(`🔢 Checks: ${m.total}`);
                  return lines;
                }
              }
            }
          },
          scales: {
            x: {
              display: true,
              ticks: {
                color: 'rgba(255,255,255,0.3)',
                font: { size: 9 },
                maxTicksLimit: cfg.maxTicks,
                maxRotation: 0,
              },
              grid: { display: false }
            },
            y: {
              display: true,
              position: 'left',
              ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 }, maxTicksLimit: 3 },
              grid: { color: 'rgba(255,255,255,0.05)' }
            },
            y2: {
              display: false,
              position: 'right',
              suggestedMin: 0,
              suggestedMax: 100,
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
      // Attach tooltipMeta to chart instance for in-place update access
      svcCharts[svcId]._tooltipMeta = tooltipMeta;
    } catch(e) { console.error('loadSvcHistory:', e); }
  }

  // Time range selector for service charts
  $(document).on('click', '.svc-time-btn', function() {
    const svcId = $(this).data('svc');
    const range = $(this).data('range');
    $(`.svc-time-btn[data-svc="${svcId}"]`).removeClass('active');
    $(this).addClass('active');
    loadSvcHistory(svcId, range);
  });

  // Autorellenar URL al cambiar tipo
  $('#svcType').on('change', function() {
    const t = $(this).val();
    const host = $('#svcHost').val();
    const port = $('#svcPort').val();
    const defaults = {
      immich: 2283, plex: 32400, jellyfin: 8096,
      qbittorrent: 8080, pihole: 80, omnitools: 80, http: 80, https: 443, generic: 80
    };
    if (defaults[t] && !$('#svcPort').data('touched')) {
      $('#svcPort').val(defaults[t]);
    }
    const needsUrl = ['immich','plex','jellyfin','qbittorrent','pihole','omnitools','http','https'];
    $('#svcUrlWrap').toggle(needsUrl.includes(t));
  });
  $('#svcPort').on('change', function() { $(this).data('touched', true); });
  $('#svcType').trigger('change');

  // Añadir servicio
  $('#svcAdd').on('click', async function() {
    const name     = ($('#svcName').val()||'').trim();
    const host     = ($('#svcHost').val()||'').trim();
    const port     = parseInt($('#svcPort').val()||'80');
    const svcType  = $('#svcType').val();
    const svcUrl   = ($('#svcUrl').val()||'').trim();
    const interval = parseInt($('#svcInterval').val()||'60');
    const proto    = ['http','https'].includes(svcType) ? svcType : 'tcp';

    if (!name || !host) { $('#svcMsg').text('⚠ Nombre y host son obligatorios'); return; }
    $('#svcMsg').text('Añadiendo…');
    setBtnLoading(this, true);

    const res = await fetch('/api/services', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, host, port, protocol: proto, service_type: svcType,
                             service_url: svcUrl || null, check_interval: interval })
    });
    const data = await res.json();
    setBtnLoading(this, false);
    if (!data.ok) { $('#svcMsg').text('Error: '+(data.error||'?')); return; }
    $('#svcMsg').text('✓ Añadido. Check en curso…');
    $('#svcName').val(''); $('#svcHost').val(''); $('#svcUrl').val('');
    setTimeout(() => { loadServices(); $('#svcMsg').text(''); }, 2000);
  });

  // Check manual
  $(document).on('click', '.btn-svc-check', async function() {
    const id = $(this).data('id');
    setBtnLoading(this, true);
    await fetch(`/api/services/${id}/check`, {method:'POST'});
    setTimeout(async () => { await loadServices(); setBtnLoading(this, false); }, 1500);
  });

  // Toggle
  $(document).on('click', '.btn-svc-toggle', async function() {
    const id = $(this).data('id');
    await fetch(`/api/services/${id}/toggle`, {method:'POST'});
    await loadServices();
  });

  // Delete
  $(document).on('click', '.btn-svc-del', async function() {
    const id = $(this).data('id');
    if (!(await window.appConfirm('¿Eliminar este servicio y todo su historial?', {
      title: 'Eliminar servicio',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    await fetch(`/api/services/${id}`, {method:'DELETE'});
    await loadServices();
  });

  // Recargar manual + auto en tab
  $('#svcRefresh').on('click', loadServices);

  setTimeout(() => {
    if (document.getElementById('servicesGrid')) loadServices();
  }, 600);
  // Fire on both the legacy services-tab ID and the new infra-apps-tab
  document.getElementById('services-tab')?.addEventListener('shown.bs.tab', loadServices);
  document.getElementById('infra-apps-tab')?.addEventListener('shown.bs.tab', loadServices);
  document.getElementById('infra-tab')?.addEventListener('shown.bs.tab', function() {
    // Only load if Aplicaciones subtab is already active
    if (document.getElementById('infraApps')?.classList.contains('show')) loadServices();
  });
  // Auto-refresh servicios si la pestaña está activa
  let _servicesRefreshTimer = null;
  function _servicesRefreshMs() {
    return window.getFrontendRefreshMs('normal');
  }
  function _startServicesRefreshTimer() {
    if (_servicesRefreshTimer) clearInterval(_servicesRefreshTimer);
    _servicesRefreshTimer = setInterval(() => {
      // servicesView may be inside infraApps subtab; check either container
      const svEl = document.getElementById('servicesView') || document.getElementById('infraApps');
      if (svEl?.closest('.tab-pane.show, .tab-pane.active')) loadServices();
    }, _servicesRefreshMs());
  }
  _startServicesRefreshTimer();
  document.addEventListener('frontendrefreshsettingschange', _startServicesRefreshTimer);

  // ══════════════════════════════════════════════════
  // #27 LATENCIA en modal
  // ══════════════════════════════════════════════════
  window.loadLatency = async function loadLatency(ip) {
    try {
      const res  = await fetch(`/api/hosts/${encodeURIComponent(ip)}/latency?limit=50`);
      const data = await res.json();
      if (!data.ok) return;
      const ms = data.last_latency_ms;
      let txt = '—', cls = '';
      if (ms != null) {
        txt = ms < 10 ? `${ms}ms ⚡` : ms < 50 ? `${ms}ms` : `${ms}ms ⚠`;
        cls = ms < 10 ? 'latency-ok' : ms < 50 ? 'latency-warn' : 'latency-bad';
      }
      $('#mLatency').text(txt).attr('class', 'mono fw-bold ' + cls);
    } catch(e) {}
  }

  // Backup/restore handlers → see cfgRestoreFile / cfgResetDb handlers below



  // ══════════════════════════════════════════════════════════
  // DASHBOARD
  // ══════════════════════════════════════════════════════════
  $(document).on('click', '.btn-svc-edit', function() {
    const id = $(this).data('id');
    const form = $(`#svcEdit_${id}`);
    form.toggleClass('open');
    $(this).find('i').toggleClass('bi-pencil bi-pencil-fill');
  });

  $(document).on('click', '.btn-svc-edit-cancel', function() {
    const id = $(this).data('id');
    $(`#svcEdit_${id}`).removeClass('open');
    $(`[data-id="${id}"].btn-svc-edit i`).removeClass('bi-pencil-fill').addClass('bi-pencil');
  });

  $(document).on('click', '.btn-svc-save', async function() {
    const id   = $(this).data('id');
    const form = $(`#svcEdit_${id}`);
    const payload = {
      name:           form.find('.ef-name').val().trim(),
      host:           form.find('.ef-host').val().trim(),
      port:           parseInt(form.find('.ef-port').val()),
      service_type:   form.find('.ef-type').val(),
      service_url:    form.find('.ef-url').val().trim() || null,
      access_url:     form.find('.ef-access').val().trim() || null,
      check_interval: parseInt(form.find('.ef-interval').val()),
      notes:          form.find('.ef-notes').val().trim() || null,
      enabled:        true,
      protocol:       ['http','https'].includes(form.find('.ef-type').val()) ? form.find('.ef-type').val() : 'tcp',
    };
    Object.assign(payload, svcExpectedSchedulePayload(form));
    setBtnLoading(this, true);
    const res  = await fetch(`/api/services/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    setBtnLoading(this, false);
    if (!data.ok) { showToast((window.t?.('services.error_prefix', 'Error:') || 'Error:') + ' ' + (data.error||'?'), 'danger'); return; }
    $(`#svcEdit_${id}`).removeClass('open');
    $(`[data-id="${id}"].btn-svc-edit i`).removeClass('bi-pencil-fill').addClass('bi-pencil');
    await loadServices();
  });

  // Pasar access_url en svcAdd
  const _origSvcAdd = $('#svcAdd').off('click');
  $('#svcAdd').on('click', async function() {
    const name     = ($('#svcName').val()||'').trim();
    const host     = ($('#svcHost').val()||'').trim();
    const port     = parseInt($('#svcPort').val()||'80');
    const svcType  = $('#svcType').val();
    const svcUrl   = ($('#svcUrl').val()||'').trim();
    const accessUrl= ($('#svcAccessUrl').val()||'').trim();
    const interval = parseInt($('#svcInterval').val()||'60');
    const proto    = ['http','https'].includes(svcType) ? svcType : 'tcp';
    if (!name || !host) { $('#svcMsg').text('⚠ Nombre y host son obligatorios'); return; }
    $('#svcMsg').text('Añadiendo…');
    setBtnLoading(this, true);
    const res = await fetch('/api/services', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, host, port, protocol: proto, service_type: svcType,
                             service_url: svcUrl || null, access_url: accessUrl || null,
                             check_interval: interval })
    });
    const data = await res.json();
    setBtnLoading(this, false);
    if (!data.ok) { $('#svcMsg').text('Error: '+(data.error||'?')); return; }
    $('#svcMsg').text('✓ Añadido. Check en curso…');
    $('#svcName,#svcHost,#svcUrl,#svcAccessUrl').val('');
    setTimeout(() => { loadServices(); $('#svcMsg').text(''); }, 2000);
  });



  // ══════════════════════════════════════════════════════════
  // CONFIGURACIÓN
  // ══════════════════════════════════════════════════════════

}); // end $(function) — services.js

// ── File-scope globals (used by inline onclick handlers) ──
// Modal chart instance
let svcHistoryChartInst = null;
let svcHistoryCurrent = { id: null, name: null, host: null, port: null, access_url: null };
let svcHistoryLastData = []; // for CSV

function statusBadgeHtml(st) {
  const s = (st || '').toLowerCase();
  if (s === 'up') return '<span class="badge bg-success">UP</span>';
  if (s === 'down') return '<span class="badge bg-danger">DOWN</span>';
  if (s === 'timeout') return '<span class="badge bg-warning text-dark">TIMEOUT</span>';
  return '<span class="badge bg-secondary">—</span>';
}

function toCsv(rows) {
  const escCsv = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/\r?\n/g, ' ');
    return /[",;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['checked_at','status','latency_ms','error'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push([r.checked_at, r.status, r.latency_ms ?? '', r.error ?? ''].map(escCsv).join(';'));
  }
  return lines.join('\n');
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function openSvcHistoryModalFromCard(cardEl) {
  try {
    const svc = JSON.parse(cardEl.getAttribute('data-svc') || '{}');
    if (!svc.id) return;

    svcHistoryCurrent = { id: svc.id, name: svc.name, host: svc.host, port: svc.port, access_url: svc.access_url || null };

    const accessUrl = svc.access_url || `http://${svc.host}:${svc.port}`;
    document.getElementById('svcHistoryTitle').innerText = window.t?.('services.history_title', 'Historial · {name}', { name: svc.name }) || `Historial · ${svc.name}`;
    document.getElementById('svcHistorySubtitle').innerHTML =
      `<span class="mono">${svc.host}:${svc.port}</span> · <a href="${esc(accessUrl)}" target="_blank" rel="noopener">Abrir</a>`;

    document.getElementById('svcHistoryMeta').innerText = '';
    document.getElementById('svcHistoryTbody').innerHTML = '';
    document.getElementById('svcHistoryFoot').innerText = '';

    // reset range buttons
    document.querySelectorAll('.svc-hist-range').forEach(b => b.classList.remove('active'));
    document.querySelector('.svc-hist-range[data-range="day"]').classList.add('active');

    const modal = new bootstrap.Modal(document.getElementById('svcHistoryModal'));
    modal.show();

    await loadSvcHistoryDetailed(svc.id, 'day');
  } catch (e) {
    console.error('openSvcHistoryModalFromCard:', e);
  }
}

async function loadSvcHistoryDetailed(svcId, range) {
  const cfgMap = {
    day:     { days: 1,  bucketMin: 5,    maxTicks: 8  },
    week:    { days: 7,  bucketMin: 60,   maxTicks: 10 },
    month:   { days: 30, bucketMin: 240,  maxTicks: 12 },
    quarter: { days: 90, bucketMin: 1440, maxTicks: 12 },
  };
  const cfg = cfgMap[range] || cfgMap.day;

  try {
    const res = await fetch(`/api/services/${svcId}/history?days=${cfg.days}&limit=${window.getFrontendLimit('detail_history')}`);
    const data = await res.json();
    if (!data.ok) return;

    // API devuelve DESC
    const histDesc = (data.history || []);
    const histAsc  = histDesc.slice().reverse();
    svcHistoryLastData = histDesc.slice(0, window.getFrontendLimit('export_rows'));

    // Meta
    const total = histDesc.length;
    const up = histDesc.filter(h => h.status === 'up').length;
    const dn = histDesc.filter(h => h.status === 'down').length;
    const to = histDesc.filter(h => h.status === 'timeout').length;
    const upPct = total ? Math.round(up / total * 100) : 0;
    document.getElementById('svcHistoryMeta').innerText =
      window.t?.('services.history_meta', '{total} checks · {upPct}% up{timeout}', {
        total,
        upPct,
        timeout: to ? (window.t?.('services.history_timeout_suffix', ' · {count} timeout', { count: to }) || ` · ${to} timeout`) : ''
      }) || (`${total} checks · ${upPct}% up` + (to ? ` · ${to} timeout` : ''));

    // Tabla de detalle limitada por configuración frontend
    const tb = document.getElementById('svcHistoryTbody');
    tb.innerHTML = '';
    const take = Math.min(window.getFrontendLimit('table_rows'), histDesc.length);
    for (let i = 0; i < take; i++) {
      const h = histDesc[i];
      const dt = svcFmtDateTime(h.checked_at);
      const lat = (h.latency_ms != null) ? `${h.latency_ms} ms` : '—';
      const err = h.error ? esc(String(h.error)).slice(0, 140) : '';
      tb.insertAdjacentHTML('beforeend',
        `<tr>
           <td class="mono">${dt}</td>
           <td>${statusBadgeHtml(h.status)}</td>
           <td class="mono">${lat}</td>
           <td style="color:${h.status === 'up' ? 'rgba(255,255,255,0.45)' : '#ff9b9b'}">${err}</td>
         </tr>`
      );
    }
    document.getElementById('svcHistoryFoot').innerText =
      take
        ? (window.t?.('services.history_foot_shown', 'Mostrando {take} de {total} checks (orden: más reciente primero).', { take, total: histDesc.length }) || `Mostrando ${take} de ${histDesc.length} checks (orden: más reciente primero).`)
        : (window.t?.('services.history_foot_empty', 'Sin datos en este rango.') || 'Sin datos en este rango.');

    // Chart buckets (similar a mini, pero más grande)
    const bucketMs   = cfg.bucketMin * 60 * 1000;
    const nowMs      = Date.now();
    const sinceMs    = nowMs - cfg.days * 86400000;
    const startMs    = Math.floor(sinceMs / bucketMs) * bucketMs;
    const numBuckets = Math.ceil((nowMs - startMs) / bucketMs);

    const buckets = [];
    for (let i = 0; i < numBuckets; i++) buckets.push({ t: startMs + i * bucketMs, checks: [] });

    for (const h of histAsc) {
      const ts = new Date(h.checked_at).getTime();
      const idx = Math.floor((ts - startMs) / bucketMs);
      if (idx >= 0 && idx < buckets.length) buckets[idx].checks.push(h);
    }

    const labels = [], latencyData = [], statusColors = [], tooltipMeta = [];
    for (const b of buckets) {
      const fmt = svcFmtChartLabel(b.t, range);
      labels.push(fmt);

      if (!b.checks.length) {
        latencyData.push(null);
        statusColors.push('rgba(255,255,255,0.08)');
        tooltipMeta.push(null);
        continue;
      }

      const ups = b.checks.filter(c => c.status === 'up').length;
      const downs = b.checks.filter(c => c.status === 'down').length;
      const timeouts = b.checks.filter(c => c.status === 'timeout').length;
      const totalB = b.checks.length;
      const upPctB = Math.round(ups / totalB * 100);

      const lats = b.checks.filter(c => c.latency_ms != null).map(c => c.latency_ms);
      const avgLat = lats.length ? Math.round(lats.reduce((a,b)=>a+b,0)/lats.length) : null;

      let col;
      if (upPctB >= 80)      col = accentColor(0.5 + upPctB/200);
      else if (upPctB >= 40) col = 'rgba(255,193,7,0.85)';
      else                   col = 'rgba(255,107,107,0.85)';

      latencyData.push(avgLat || 1);
      statusColors.push(col);
      tooltipMeta.push({ ups, downs, timeouts, total: totalB, upPct: upPctB, avgLat,
                         dateStr: svcFmtDateTime(b.t) });
    }

    const canvas = document.getElementById('svcHistoryChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (svcHistoryChartInst) { svcHistoryChartInst.destroy(); svcHistoryChartInst = null; }

    svcHistoryChartInst = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{
        data: latencyData,
        backgroundColor: statusColors,
        borderRadius: 4,
          borderWidth: 0,
        barPercentage: 0.9,
        categoryPercentage: 1.0,
        minBarLength: 3,
      }]},
      options: {
        responsive: true,
          maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(20,24,30,0.95)',
            titleColor: '#fff',
            bodyColor: 'rgba(255,255,255,0.85)',
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 1,
            padding: 10,
            displayColors: false,
            callbacks: {
              title: (ctx) => {
                const m = tooltipMeta[ctx[0].dataIndex];
                return m ? m.dateStr : ctx[0].label;
              },
              label: (ctx) => {
                const m = tooltipMeta[ctx[0].dataIndex];
                if (!m) return 'Sin datos en este intervalo';
                const lines = [
                  `✅ Up: ${m.ups}  ❌ Down: ${m.downs}${m.timeouts ? '  ⏱ Timeout: '+m.timeouts : ''}`,
                  `📊 Disponibilidad: ${m.upPct}%`,
                ];
                if (m.avgLat != null) lines.push(`⚡ Latencia media: ${m.avgLat}ms`);
                lines.push(`🔢 Total checks: ${m.total}`);
                return lines;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 }, maxTicksLimit: cfg.maxTicks, maxRotation: 0 },
            grid: { display: false }
          },
          y: {
            ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 }, maxTicksLimit: 5 },
            grid: { color: 'rgba(255,255,255,0.08)' }
          }
        }
      }
    });

  } catch(e) {
    console.error('loadSvcHistoryDetailed:', e);
  }
}

// Abrir historial desde botón en tarjeta
$(document).on('click', '.btn-svc-history', function(e) {
  e.preventDefault();
  const card = this.closest('.svc-card');
  if (!card) return;
  openSvcHistoryModalFromCard(card);
});

// Cambiar rango en modal
$(document).on('click', '.svc-hist-range', function() {
  const range = this.getAttribute('data-range');
  document.querySelectorAll('.svc-hist-range').forEach(b => b.classList.remove('active'));
  this.classList.add('active');
  if (svcHistoryCurrent.id) loadSvcHistoryDetailed(svcHistoryCurrent.id, range);
});

// Export CSV
$(document).on('click', '#svcHistoryExportBtn', function() {
  if (!svcHistoryCurrent.id) return;
  const fname = `svc_${svcHistoryCurrent.id}_${(svcHistoryCurrent.name||'hist').replace(/\s+/g,'_')}.csv`;
  downloadText(fname, toCsv(svcHistoryLastData || []));
});



