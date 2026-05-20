
// ── Compat shim: algunas variantes de hosts.js siguen llamando a loadNetworksModern ──
if (typeof window.loadNetworksModern !== 'function') {
  window.loadNetworksModern = async function loadNetworksModern() {
    return [];
  };
}

// ════════════════════════════════════════════════════════
//  app.js — Auditor IPs · Bootstrap global  (Sesión 28)
//  ① Globals: esc, macValid, DataTable IP sort
//  ② $(function):
//     A. Helpers: safeId, cssVar, accentColor
//     B. Hosts DataTable + column visibility + density toggle
//     C. Filters: texto, tipo, estado, red, desconocidos
//     D. Scan button
//     E. Scans table + loadScans
//     F. Host actions: row click, modal save/delete, WoL, types
//     G. Auto-refresh / pollStatus
//     H. Nav: moveBubble + tab persistence + subtab routing
//     I. Prefetch orchestrator
//     J. Mobile view toggle
//     K. Quality config
// ════════════════════════════════════════════════════════

// ── Aplicar tema guardado antes del DOM (evita flash) ────────────────────────
(function () {
  const t     = localStorage.getItem('auditor-theme') || 'dark';
  const tName = localStorage.getItem('auditor-theme-name') || '';
  // Build CDN URL: use saved theme name if available, else map light/dark to defaults
  const defaultLight = 'darkly';  // fallback light theme
  const themeSlug    = tName || (t === 'light' ? 'flatly' : 'darkly');
  const themeUrl     = `https://cdn.jsdelivr.net/npm/bootswatch@5.3.3/dist/${themeSlug}/bootstrap.min.css`;

  if (t === 'light') {
    document.documentElement.style.visibility = 'hidden';
    document.addEventListener('DOMContentLoaded', function () {
      document.getElementById('themeCSS').href = themeUrl;
      document.body.classList.add('light-mode');
      const icon = document.getElementById('themeIcon');
      if (icon) icon.className = 'bi bi-moon-stars-fill';
      document.documentElement.style.visibility = '';
    });
  } else if (tName && tName !== 'darkly') {
    // Non-default dark theme — apply without hiding
    document.addEventListener('DOMContentLoaded', function () {
      const el = document.getElementById('themeCSS');
      if (el) el.href = themeUrl;
    });
  }
})();

// ── DataTable: sort por IP ────────────────────────────────────────────────────
jQuery.extend(jQuery.fn.dataTableExt.oSort, {
  'ip-pre':  a => { if (!a) return 0; const m = a.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); return m ? ((+m[1]<<24)+(+m[2]<<16)+(+m[3]<<8)+(+m[4])) : 0; },
  'ip-asc':  (a, b) => a - b,
  'ip-desc': (a, b) => b - a,
});

// ── Utilities globales ────────────────────────────────────────────────────────
function esc(s) {
  return (s ?? '').toString()
    .replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function macValid(mac) {
  if (!mac) return false;
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(String(mac).trim().toUpperCase().replaceAll('-',':'));
}

// ════════════════════════════════════════════════════════
$(function () {

  // ── A. Helpers ───────────────────────────────────────────────────────────────
  function safeId(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return 'g' + Math.abs(h).toString(36);
  }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function accentColor(alpha) {
    const hex = cssVar('--accent');
    if (!hex?.startsWith('#')) return `rgba(77,255,181,${alpha})`;
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return alpha >= 1 ? hex : `rgba(${r},${g},${b},${alpha})`;
  }
  function accent2Color(alpha) {
    const hex = cssVar('--accent2');
    if (!hex?.startsWith('#')) return `rgba(55,90,127,${alpha})`;
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return alpha >= 1 ? hex : `rgba(${r},${g},${b},${alpha})`;
  }

  const hostModal         = new bootstrap.Modal(document.getElementById('hostModal'));
  const confirmDeleteModal = new bootstrap.Modal(document.getElementById('confirmDeleteModal'));
  const hostHistoryModalEl = document.getElementById('hostHistoryModal');
  const hostHistoryModal = hostHistoryModalEl ? new bootstrap.Modal(hostHistoryModalEl) : null;
  const hostPingModalEl = document.getElementById('hostPingModal');
  const hostPingModal = hostPingModalEl ? new bootstrap.Modal(hostPingModalEl) : null;
  const hostFingerprintModalEl = document.getElementById('hostFingerprintModal');
  const hostFingerprintModal = hostFingerprintModalEl ? new bootstrap.Modal(hostFingerprintModalEl) : null;
  let _hostPingTimer = null;
  let _hostPingBusy = false;
  let _hostPingCurrentIp = null;
  let _hostPingTick = 0;
  let _hostFingerprintRunning = false;
  let _lastFingerprintResult = null; // último resultado de fingerprint para el botón Aplicar
  let _lastFingerprintPayload = null; // último payload completo para rerender tras aplicar
  window.currentIp        = null;
  let   currentIp         = null;
  window.pendingDeleteIp  = null;
  let _lastScanRefIso         = '';
  let _scanAgeTickTimer       = null;
  let _autoRefreshTimer       = null;
  let _autoRefreshBusy        = false;
  let _nextAutoRefreshAtMs    = 0;
  const AUTO_REFRESH_KEY      = 'auditor-hosts-auto-refresh';
  const AUTO_REFRESH_FALLBACK_MS = 30000;

  function _coerceFrontendRefreshSeconds(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  window.getFrontendRefreshMs = window.getFrontendRefreshMs || function(scope) {
    const cfg = window.APP_CONFIG || {};
    const isDashboard = String(scope || '') === 'dashboard';
    const key = isDashboard ? 'frontend_dashboard_refresh_interval_seconds' : 'frontend_refresh_interval_seconds';
    const fallback = isDashboard ? 60 : 30;
    const min = isDashboard ? 10 : 5;
    return _coerceFrontendRefreshSeconds(cfg[key], fallback, min, 3600) * 1000;
  };

  window.applyFrontendRefreshSettings = window.applyFrontendRefreshSettings || function(settings) {
    window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, settings || {});
    document.dispatchEvent(new CustomEvent('frontendrefreshsettingschange', { detail: window.APP_CONFIG }));
  };

  function _coerceFrontendLimit(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  window.getFrontendLimit = window.getFrontendLimit || function(scope) {
    const cfg = window.APP_CONFIG || {};
    const specs = {
      history: ['frontend_history_limit', 5000, 100, 50000],
      detail_history: ['frontend_detail_history_limit', 20000, 500, 100000],
      table_rows: ['frontend_table_rows_limit', 2000, 100, 20000],
      export_rows: ['frontend_export_rows_limit', 5000, 100, 50000],
    };
    const spec = specs[String(scope || '')] || specs.history;
    return _coerceFrontendLimit(cfg[spec[0]], spec[1], spec[2], spec[3]);
  };

  window.applyFrontendDataLimitSettings = window.applyFrontendDataLimitSettings || function(settings) {
    window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, settings || {});
    document.dispatchEvent(new CustomEvent('frontenddatalimitsettingschange', { detail: window.APP_CONFIG }));
  };

  function _coerceOperationalTimeoutSeconds(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  window.getOperationalTimeoutMs = window.getOperationalTimeoutMs || function(scope) {
    const cfg = window.APP_CONFIG || {};
    const specs = {
      service_check: ['service_check_timeout_seconds', 8, 1, 60],
      service_info: ['service_info_timeout_seconds', 6, 1, 60],
      script_ai_cloud: ['script_ai_cloud_timeout_seconds', 30, 5, 300],
      script_ai_local: ['script_ai_local_timeout_seconds', 180, 30, 900],
      script_ai_frontend: ['script_ai_frontend_timeout_seconds', 135, 30, 600],
      script_report: ['script_report_timeout_seconds', 120, 30, 600],
      wol_tracker: ['wol_tracker_timeout_seconds', 120, 10, 900],
    };
    const spec = specs[String(scope || '')] || specs.service_check;
    return _coerceOperationalTimeoutSeconds(cfg[spec[0]], spec[1], spec[2], spec[3]) * 1000;
  };

  window.applyOperationalTimeoutSettings = window.applyOperationalTimeoutSettings || function(settings) {
    window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, settings || {});
    document.dispatchEvent(new CustomEvent('operationaltimeoutsettingschange', { detail: window.APP_CONFIG }));
  };

  function _hostAutoRefreshIntervalMs() {
    if (typeof window.getFrontendRefreshMs === 'function') {
      return window.getFrontendRefreshMs('normal') || AUTO_REFRESH_FALLBACK_MS;
    }
    return AUTO_REFRESH_FALLBACK_MS;
  }

  const HOST_GROUP_BY_KEY = 'auditor-hosts-group-by';
  let   _hostGroupBy = localStorage.getItem(HOST_GROUP_BY_KEY) || '';
  const _collapsedHostGroups = new Set();
  let   _lastHostGroupKeys = [];


  // ── B. Hosts DataTable + column visibility + density ─────────────────────────

  // Columnas toggleables (índice en DataTable, clave localStorage, label, activa por defecto)
  const HOST_COLS = [
    { idx: 1,  key: 'c_estado',       label: 'Estado',         def: true  },
    { idx: 2,  key: 'c_ip',           label: 'IP',             def: true  },
    { idx: 3,  key: 'c_mac',          label: 'MAC',            def: true  },
    { idx: 4,  key: 'c_nombre',       label: 'Nombre',         def: true  },
    { idx: 9,  key: 'c_tipo',         label: 'Tipo',           def: true  },
    { idx: 8,  key: 'c_owner',        label: 'Responsable',    def: true  },
    { idx: 10, key: 'c_device_type',  label: 'Device Type',    def: true  },
    { idx: 11, key: 'c_conocido',     label: 'Conocido',       def: true  },
    { idx: 12, key: 'c_latencia',     label: 'Latencia',       def: true  },
    { idx: 13, key: 'c_visto',        label: 'Visto hace',     def: true  },
    { idx: 14, key: 'c_cambio',       label: 'Último cambio',  def: false },
  ];

  function _colVisible(col) {
    const stored = localStorage.getItem(col.key);
    return stored !== null ? stored === '1' : col.def;
  }

  // Construir columnDefs con visibilidad inicial guardada
  const initialColDefs = [
    { targets: 0,  orderable: false, searchable: false, width: '30px' },
    { targets: 2,  type: 'ip' },
    { targets: 5,  visible: false, searchable: true },   // Tipo_sort
    { targets: 6,  visible: false, searchable: true },   // ManualName
    { targets: 7,  visible: false, searchable: true },   // Tags
    { targets: 9,  orderData: [5] },
    { targets: 15, orderable: false, searchable: false, width: '128px', className: 'host-actions-col text-center' },
    { targets: 16, visible: false, searchable: false },  // GroupOwner
    { targets: 17, visible: false, searchable: false },  // GroupType
    { targets: 18, visible: false, searchable: false },  // GroupStatus
    { targets: 19, visible: false, searchable: false },  // GroupKnown
  ];
  HOST_COLS.forEach(col => {
    if (!_colVisible(col)) initialColDefs.push({ targets: col.idx, visible: false });
  });

  function _hostGroupText(value, fallback) {
    return String(value || '').replace(/\s+\(deshabilitado\)\s*$/, '').trim() || fallback;
  }

  function _hostRowGroupInfoFromData(rowData) {
    const group = String(_hostGroupBy || '');
    const data = Array.isArray(rowData) ? rowData : [];
    if (!group) return { key: 'none', title: '', label: '' };

    if (group === 'owner') {
      const label = _hostGroupText(data[16], 'Sin responsable');
      return { key: `owner:${_slugGroupValue(label)}`, title: 'Responsable', label };
    }

    if (group === 'type') {
      const label = _hostGroupText(data[17] || data[5], 'Sin tipo');
      return { key: `type:${_slugGroupValue(label)}`, title: 'Tipo', label };
    }

    if (group === 'status') {
      const label = _hostGroupText(data[18], 'Offline');
      return { key: `status:${_slugGroupValue(label)}`, title: 'Estado', label };
    }

    if (group === 'network') {
      const ip = String(data[2] || '').replace(/<[^>]+>/g, '').trim();
      const label = _hostNetworkLabel(ip);
      return { key: `network:${_slugGroupValue(label)}`, title: 'Red', label };
    }

    if (group === 'known') {
      const label = _hostGroupText(data[19], 'No conocidos');
      return { key: `known:${_slugGroupValue(label)}`, title: 'Conocido', label };
    }

    return { key: 'none', title: '', label: '' };
  }

  function _hostRowGroupPackedValue(rowData) {
    const info = _hostRowGroupInfoFromData(rowData);
    return `${info.title}\u001f${info.key}\u001f${info.label}`;
  }

  function _hostRowGroupInfoFromPacked(value) {
    const parts = String(value || '').split('\u001f');
    return {
      title: parts[0] || '',
      key: parts[1] || 'none',
      label: parts[2] || 'Sin grupo',
    };
  }

  function _hostStatusGroupLabelFromStatus(status) {
    const st = String(status || '').toLowerCase();
    if (st === 'online') return 'Online';
    if (st === 'online_silent') return 'Online silent';
    return 'Offline';
  }

  function _hostOwnerGroupLabel(host) {
    return _hostGroupText(host?.owner_name, 'Sin responsable');
  }

  function _hostTypeGroupLabel(host) {
    return _hostGroupText(host?.type_name, 'Sin tipo');
  }

  function _hostKnownGroupLabelFromHost(host) {
    return host?.known ? 'Conocidos' : 'No conocidos';
  }

  function _hostRowGroupStartRender(rows, packedValue) {
    const info = _hostRowGroupInfoFromPacked(packedValue);
    const collapsed = _collapsedHostGroups.has(info.key);
    let online = 0;
    let offline = 0;

    rows.nodes().each(function (row) {
      const status = _hostStatusGroup(row).key;
      if (status === 'online' || status === 'silent') online += 1;
      else offline += 1;
      $(row).toggle(!collapsed);
    });

    if (!_lastHostGroupKeys.includes(info.key)) _lastHostGroupKeys.push(info.key);

    const icon = collapsed ? '▸' : '▾';
    let colspan = 1;
    try { colspan = Math.max(1, hostsTable.columns(':visible').count()); } catch (_) {}
    return $(`
      <tr class="host-group-row dtrg-start" data-group-key="${esc(info.key)}">
        <td colspan="${colspan}">
          <span class="host-group-pill">
            <span class="host-group-chevron">${icon}</span>
            <span class="host-group-title">${esc(info.title)}</span>
            <span class="host-group-value">${esc(info.label)}</span>
          </span>
          <span class="host-group-meta">${rows.count()} host(s) · ${online} online · ${offline} offline</span>
        </td>
      </tr>
    `);
  }

  $('#hosts').css('width', '100%');

  const hostsTable = $.fn.DataTable.isDataTable('#hosts')
    ? $('#hosts').DataTable()
    : $('#hosts').DataTable({
        pageLength: 50,
        order:      [[1, 'desc'], [2, 'asc']],
        autoWidth:  false,
        deferRender: true,
        orderClasses: false,
        searchDelay: 120,
        scrollX:    true,
        scrollCollapse: false,
        columnDefs: initialColDefs,
        rowGroup: {
          enable: false,
          dataSrc: function (rowData) {
            return _hostRowGroupPackedValue(rowData);
          },
          startRender: _hostRowGroupStartRender,
        },
        drawCallback: function () {
          if (!_hostGroupBy) return;
          try { this.api().columns.adjust(); } catch (_) {}
        },
      });

  function _adjustHostsTableFluidLayout() {
    try {
      hostsTable.columns.adjust();
      if ($.fn.DataTable?.tables) {
        $.fn.DataTable.tables({ visible: true, api: true }).columns.adjust();
      }
    } catch (_) {}
  }

  let _hostsTableResizeTimer = null;
  $(window).off('resize.hostsTableFluid').on('resize.hostsTableFluid', function () {
    clearTimeout(_hostsTableResizeTimer);
    _hostsTableResizeTimer = setTimeout(_adjustHostsTableFluidLayout, 120);
  });

  $(document)
    .off('shown.bs.tab.hostsTableFluid', '#hosts-tabla-tab')
    .on('shown.bs.tab.hostsTableFluid', '#hosts-tabla-tab', function () {
      setTimeout(_adjustHostsTableFluidLayout, 80);
    });

  function _renderLastScanAge() {
    $('#lastScanAge').text(_fmtAgo(_lastScanRefIso));
  }

  function _fmtCountdown(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    const sec = Math.ceil(safeMs / 1000);
    if (sec <= 0) return 'ahora';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
    const hours = Math.floor(min / 60);
    const minRem = min % 60;
    return minRem ? `${hours}h ${minRem}m` : `${hours}h`;
  }

  function _fmtCadence(ms) {
    const safeMs = Math.max(1000, Number(ms) || 0);
    const sec = Math.round(safeMs / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min`;
    const hours = Math.floor(min / 60);
    const minRem = min % 60;
    return minRem ? `${hours}h ${minRem}m` : `${hours}h`;
  }

  function _renderScanInterval() {
    const el = document.getElementById('scanIntervalLabel');
    if (!el) return;
    el.textContent = _fmtCadence(_hostAutoRefreshIntervalMs());
  }

  function _setConnectionDotState(state) {
    const dot = document.getElementById('connectionDot');
    const wrap = document.getElementById('scanHealthWrap');
    if (!dot) return;
    const isOnline = state === 'online';
    dot.classList.remove('online', 'offline');
    dot.classList.add(isOnline ? 'online' : 'offline');
    const title = isOnline
      ? 'Indicador de conexión del panel. Verde: el panel está conectado con el backend y la actualización responde.'
      : 'Indicador de conexión del panel. Rojo: la última actualización del panel no recibió respuesta del backend.';
    dot.setAttribute('aria-label', isOnline ? 'Conexión del panel correcta' : 'Conexión del panel con error');
    dot.setAttribute('title', title);
    wrap?.setAttribute('title', title);
  }

  function _initTopbarTooltips() {
    ['scanHealthWrap', 'scanIntervalWidget', 'nextRefreshWidget'].forEach(id => {
      const el = document.getElementById(id);
      if (el) bootstrap.Tooltip.getOrCreateInstance(el);
    });
  }

  function _renderNextAutoRefresh() {
    const el = document.getElementById('nextRefreshEta');
    if (!el) return;
    if (!_isAutoRefreshEnabled()) {
      el.textContent = window.t?.('common.paused', 'pausado') || 'pausado';
      return;
    }
    if (!_nextAutoRefreshAtMs) {
      el.textContent = '—';
      return;
    }
    el.textContent = _fmtCountdown(_nextAutoRefreshAtMs - Date.now());
  }

  function _scheduleNextAutoRefreshCountdown(fromNowMs = _hostAutoRefreshIntervalMs()) {
    if (!_isAutoRefreshEnabled()) {
      _nextAutoRefreshAtMs = 0;
      _renderNextAutoRefresh();
      return;
    }
    _nextAutoRefreshAtMs = Date.now() + Math.max(1000, Number(fromNowMs) || _hostAutoRefreshIntervalMs());
    _renderNextAutoRefresh();
  }

  function _isHostsTableVisible() {
    return document.getElementById('hostsView')?.classList.contains('show')
      && document.getElementById('hostsTabla')?.classList.contains('show');
  }

  function _adjustHostsTableLayout(delay = 0) {
    window.setTimeout(() => {
      if (!_isHostsTableVisible()) return;
      try { hostsTable.columns.adjust(); } catch (_) {}
    }, delay);
  }

  let _hostsViewRefreshTimer = null;
  let _hostsViewRefreshBusy = false;

  function _queueHostsTableRefresh(delay = 120) {
    if (_hostsViewRefreshTimer) clearTimeout(_hostsViewRefreshTimer);
    _hostsViewRefreshTimer = window.setTimeout(async () => {
      _hostsViewRefreshTimer = null;
      if (!_isHostsTableVisible()) return;
      if (_hostsViewRefreshBusy) return;
      _hostsViewRefreshBusy = true;
      try {
        await refreshHostsTable({ keepPage: true, adjustLayout: true });
      } catch (_) {
        // noop: dejamos que el auto-refresh o la siguiente acción reintenten
      } finally {
        _hostsViewRefreshBusy = false;
      }
    }, delay);
  }

  function _isAutoRefreshEnabled() {
    const el = document.getElementById('autoRefreshToggle');
    return el ? !!el.checked : true;
  }

  function _syncHostRowNode(existingNode, host) {
    if (!existingNode) return;
    const $existing = $(existingNode);
    const wasChecked = !!$existing.find('.row-check').prop('checked');
    const wasSelected = $existing.hasClass('row-selected');
    const tempNode = $(_hostRowHtml(host))[0];
    if (!tempNode) return;

    existingNode.className = tempNode.className;
    existingNode.setAttribute('data-ip', tempNode.getAttribute('data-ip') || '');
    existingNode.setAttribute('data-mac', tempNode.getAttribute('data-mac') || '');
    existingNode.setAttribute('data-tags', tempNode.getAttribute('data-tags') || '');
    existingNode.setAttribute('data-owner-id', tempNode.getAttribute('data-owner-id') || '');
    existingNode.innerHTML = tempNode.innerHTML;

    if (wasSelected) $existing.addClass('row-selected');
    const $check = $existing.find('.row-check');
    if ($check.length) $check.prop('checked', wasChecked);
    _decorateHostRow(existingNode, host);
  }

  // ── Column visibility dropdown ──
  function _buildColPicker() {
    const wrap = document.getElementById('colPickerMenu');
    if (!wrap) return;
    wrap.innerHTML = '';
    HOST_COLS.forEach(col => {
      const visible = _colVisible(col);
      const item    = document.createElement('li');
      item.innerHTML = `<label class="dropdown-item d-flex align-items-center gap-2" style="cursor:pointer">
        <input type="checkbox" class="form-check-input mt-0" data-col-idx="${col.idx}" data-col-key="${col.key}" ${visible ? 'checked' : ''}>
        <span style="font-size:.83rem">${col.label}</span>
      </label>`;
      wrap.appendChild(item);
    });
  }
  _buildColPicker();

  $(document).on('change', '#colPickerMenu input[type=checkbox]', function () {
    const idx = parseInt($(this).data('col-idx'));
    const key = $(this).data('col-key');
    const show = $(this).is(':checked');

    try {
      hostsTable.column(idx).visible(show, false);
      localStorage.setItem(key, show ? '1' : '0');

      setTimeout(() => {
        try {
          hostsTable.columns.adjust().draw(false);
          if ($.fn.DataTable?.tables) {
            $.fn.DataTable.tables({ visible: true, api: true }).columns.adjust();
          }
        } catch (_) {}
      }, 0);
    } catch (_) {}
  });

  // ── Density toggle (densa / cómoda) ──
  const DENSITY_KEY = 'auditor-hosts-density';
  function _applyDensity(mode) {
    const $table = $('#hosts');
    const $btn   = $('#densityToggle');
    if (mode === 'comfortable') {
      $table.removeClass('table-sm');
      if ($btn.length) { $btn.html('<i class="bi bi-layout-three-columns"></i>'); $btn.attr('title','Vista densa'); }
    } else {
      $table.addClass('table-sm');
      if ($btn.length) { $btn.html('<i class="bi bi-layout-split"></i>'); $btn.attr('title','Vista cómoda'); }
    }
    _adjustHostsTableLayout(0);
  }
  _applyDensity(localStorage.getItem(DENSITY_KEY) || 'dense');

  $(document).on('click', '#densityToggle', function () {
    const cur  = localStorage.getItem(DENSITY_KEY) || 'dense';
    const next = cur === 'dense' ? 'comfortable' : 'dense';
    localStorage.setItem(DENSITY_KEY, next);
    _applyDensity(next);
  });


  // ── C. Filters ───────────────────────────────────────────────────────────────
  const textCols = [2, 3, 4, 6, 8]; // IP, MAC, Nombre, ManualName, Responsable

  window.statusFilter = '';
  window.showOnlyUnknown = false;
  let   statusFilter  = '';
  let  _networkFilter = '';
  function _ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o, 10), 0) >>> 0; }
  function _ipInCidr(ip, cidr) {
    try {
      const [net, bits] = cidr.split('/');
      const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xffffffff;
      return (_ipToInt(ip) & mask) === (_ipToInt(net) & mask);
    } catch { return false; }
  }

  function _isPendingKnownValidation(host) {
    const raw = String(host?.known ?? '').trim().toLowerCase();
    const isKnown = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'si' || raw === 'sí' || raw === 'on';
    return !isKnown;
  }

  $.fn.dataTable.ext.search.push(function (settings, data, dataIndex) {
    if (settings.nTable.id !== 'hosts') return true;
    const q    = ($('#hostFilter').val() || '').trim().toLowerCase();
    const type = ($('#typeFilter').val() || '').trim().toLowerCase();
    const owner = ($('#ownerFilter').val() || '').trim();

    if (statusFilter) {
      const rowNode = settings.aoData?.[dataIndex]?.nTr || null;
      let status = 'offline';
      if (rowNode?.classList?.contains('row-online') || rowNode?.classList?.contains('row-silent')) {
        status = 'online';
      } else if (rowNode?.classList?.contains('row-offline')) {
        status = 'offline';
      } else {
        const raw = (data[1] || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
        status = (raw.includes('online') || raw.includes('silent')) ? 'online' : 'offline';
      }
      if (status !== statusFilter) return false;
    }
    if (type) {
      if ((data[5] || '').trim().toLowerCase() !== type) return false;
    }
    if (owner) {
      const rowNode = settings.aoData?.[dataIndex]?.nTr || null;
      const rowOwner = String(rowNode?.getAttribute?.('data-owner-id') || '');
      if (owner === '__none__') {
        if (rowOwner) return false;
      } else if (rowOwner !== owner) {
        return false;
      }
    }
    if (_networkFilter) {
      const ip     = (data[2] || '').replace(/<[^>]+>/g, '').trim();
      const [, cidr] = _networkFilter.split(':');
      if (!_ipInCidr(ip, cidr)) return false;
    }
    if (window.showOnlyUnknown) {
      const rowNode = settings.aoData?.[dataIndex]?.nTr || null;
      const toggleBtn = rowNode?.querySelector?.('.btn-toggle-known');
      let isKnown = false;
      if (toggleBtn) {
        const rawKnown = String(toggleBtn.getAttribute('data-known') || '').trim().toLowerCase();
        isKnown = rawKnown === 'true' || rawKnown === '1' || rawKnown === 'yes' || rawKnown === 'y' || rawKnown === 'si' || rawKnown === 'sí' || rawKnown === 'on';
      } else {
        const rawKnownText = (data[11] || '').replace(/<[^>]+>/g, ' ').trim().toLowerCase();
        isKnown = rawKnownText.includes('sí') || rawKnownText.includes('si') || rawKnownText.includes('yes');
      }
      if (isKnown) return false;
    }
    if (q) return textCols.some(i => (data[i] || '').toLowerCase().includes(q));
    return true;
  });

  function _redraw() {
    hostsTable.draw();
    window._refreshSplitByNet?.();
    window._refreshHostsVisualViews?.();
  }

  function _slugGroupValue(value) {
    return String(value || 'none').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'none';
  }

  function _hostStatusGroup(node) {
    if (node?.classList?.contains('row-online')) return { key: 'online', label: 'Online' };
    if (node?.classList?.contains('row-silent')) return { key: 'silent', label: 'Online silent' };
    return { key: 'offline', label: 'Offline' };
  }

  function _hostKnownGroup(node) {
    const raw = String(node?.querySelector?.('.btn-toggle-known')?.getAttribute('data-known') || '').toLowerCase();
    const known = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'si' || raw === 'sí';
    return known ? { key: 'known', label: 'Conocidos' } : { key: 'unknown', label: 'No conocidos' };
  }

  function _hostNetworkLabel(ip) {
    let label = '';
    $('#networkFilter option').each(function () {
      const value = String(this.value || '');
      if (!value || !value.includes(':')) return;
      const cidr = value.split(':').slice(1).join(':');
      if (cidr && _ipInCidr(ip, cidr)) {
        label = String($(this).text() || '').trim();
        return false;
      }
    });
    if (label) return label;
    const parts = String(ip || '').split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return 'Sin red';
  }


  function _applyHostGrouping(value, draw = true) {
    _hostGroupBy = String(value || '');
    localStorage.setItem(HOST_GROUP_BY_KEY, _hostGroupBy);
    $('#hostGroupBy').val(_hostGroupBy);
    _collapsedHostGroups.clear();
    _lastHostGroupKeys = [];

    $('#hostGroupExpandAll, #hostGroupCollapseAll').toggle(!!_hostGroupBy);

    if (hostsTable.rowGroup) {
      hostsTable.rowGroup().enable(!!_hostGroupBy);
    }

    if (_hostGroupBy === 'owner') hostsTable.order([[16, 'asc'], [1, 'desc'], [2, 'asc']]);
    else if (_hostGroupBy === 'type') hostsTable.order([[17, 'asc'], [1, 'desc'], [2, 'asc']]);
    else if (_hostGroupBy === 'status') hostsTable.order([[18, 'asc'], [2, 'asc']]);
    else if (_hostGroupBy === 'network') hostsTable.order([[2, 'asc']]);
    else if (_hostGroupBy === 'known') hostsTable.order([[19, 'asc'], [1, 'desc'], [2, 'asc']]);
    else hostsTable.order([[1, 'desc'], [2, 'asc']]);

    if (draw) hostsTable.draw(false);
    else hostsTable.draw(false);
  }

  $(document).on('change', '#hostGroupBy', function () {
    _applyHostGrouping($(this).val() || '', true);
  });

  $(document).on('click', '.host-group-row', function () {
    const key = String($(this).data('group-key') || '');
    if (!key) return;
    if (_collapsedHostGroups.has(key)) _collapsedHostGroups.delete(key);
    else _collapsedHostGroups.add(key);
    hostsTable.draw(false);
  });

  $(document).on('click', '#hostGroupExpandAll', function () {
    _collapsedHostGroups.clear();
    hostsTable.draw(false);
  });

  $(document).on('click', '#hostGroupCollapseAll', function () {
    _lastHostGroupKeys.forEach(k => _collapsedHostGroups.add(k));
    hostsTable.draw(false);
  });

  hostsTable.on('preDraw', function () {
    _lastHostGroupKeys = [];
  });

  $('#hostGroupBy').val(_hostGroupBy);
  _applyHostGrouping(_hostGroupBy, false);

  $('#hostFilter').on('input', _redraw);
  $('#typeFilter').on('change', _redraw);
  $('#ownerFilter').on('change', _redraw);
  $(document).on('change', '#networkFilter', function () {
    _networkFilter = $(this).val() || '';
    $(this).toggleClass('border-info', !!_networkFilter);
    _redraw();
  });
  $('#onlineFilter').on('click', function () {
    statusFilter = statusFilter === 'online' ? '' : 'online';
    $(this).toggleClass('active-online', statusFilter === 'online');
    $('#offlineFilter').removeClass('active-offline');
    _redraw();
  });
  $('#offlineFilter').on('click', function () {
    statusFilter = statusFilter === 'offline' ? '' : 'offline';
    $(this).toggleClass('active-offline', statusFilter === 'offline');
    $('#onlineFilter').removeClass('active-online');
    _redraw();
  });
  $('#unknownFilter').on('click', function () {
    window.showOnlyUnknown = !window.showOnlyUnknown;
    $(this).toggleClass('active-filter', window.showOnlyUnknown);
    $(this).find('i')
      .toggleClass('bi-question-diamond-fill', window.showOnlyUnknown)
      .toggleClass('bi-question-diamond', !window.showOnlyUnknown);
    _redraw();
  });
  $('#clearFilter').on('click', function () {
    $('#hostFilter').val('');
    $('#typeFilter').val('');
    $('#ownerFilter').val('');
    $('#networkFilter').val('').removeClass('border-info');
    _networkFilter = statusFilter = '';
    $('#onlineFilter').removeClass('active-online');
    $('#offlineFilter').removeClass('active-offline');
    window.showOnlyUnknown = false;
    $('#unknownFilter').removeClass('active-filter')
      .find('i').removeClass('bi-question-diamond-fill').addClass('bi-question-diamond');
    _redraw();
  });

  $(document).on('change', '#autoRefreshToggle', function () {
    localStorage.setItem(AUTO_REFRESH_KEY, this.checked ? '1' : '0');
    if (this.checked) {
      _scheduleNextAutoRefreshCountdown();
    } else {
      _nextAutoRefreshAtMs = 0;
      _renderNextAutoRefresh();
    }
  });

  document.getElementById('tab-hosts')?.addEventListener('shown.bs.tab', () => {
    _adjustHostsTableLayout(80);
    _queueHostsTableRefresh(140);
  });
  document.getElementById('hosts-tabla-tab')?.addEventListener('shown.bs.tab', () => {
    _adjustHostsTableLayout(80);
    _queueHostsTableRefresh(80);
  });
  window.addEventListener('resize', () => _adjustHostsTableLayout(80));

  // Counters: initialized to '—' until pollStatus() returns real values from /api/status.
  // DO NOT read from empty tbody on page load (table rows are injected by JS, not SSR).
  $('#cntTotal, #cntOnline, #cntOffline, #cntUnknown').text('—');
  $('#cntOnlineBadge, #cntOfflineBadge').text('—');


  function _fmtAgo(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const diffMs = Date.now() - d.getTime();
      if (!Number.isFinite(diffMs) || diffMs < 0) return 'ahora';
      const sec = Math.floor(diffMs / 1000);
      if (sec < 10) return 'ahora';
      if (sec < 60) return `hace ${sec}s`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `hace ${min}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `hace ${hr}h`;
      const day = Math.floor(hr / 24);
      return `hace ${day}d`;
    } catch (_) {
      return '—';
    }
  }

  function _hostRowClass(host) {
    const st = String(host?.status || 'offline').toLowerCase();
    return st === 'online' ? 'row-online' : (st === 'online_silent' ? 'row-silent' : 'row-offline');
  }

  function _hostStatusBucketFromStatus(status) {
    const st = String(status || 'offline').toLowerCase();
    return (st === 'online' || st === 'online_silent') ? 'online' : 'offline';
  }

  function _hostStatusOrder(host) {
    const st = String(host?.status || 'offline').toLowerCase();
    if (st === 'online') return '3';
    if (st === 'online_silent') return '2';
    if (st === 'offline') return '1';
    return '0';
  }

  function _hostStatusHtml(host) {
    const st = String(host?.status || 'offline').toLowerCase();
    if (st === 'online') {
      return '<i class="bi bi-circle-fill text-success" style="font-size:.6rem"></i> online';
    }
    if (st === 'online_silent') {
      return `<i class="bi bi-eye-slash-fill text-warning" style="font-size:.6rem" title="${esc(window.t?.('host.status_silent_title', 'Solo visible por el router, no responde a ping') || 'Solo visible por el router, no responde a ping')}"></i> <span class="text-warning">silent</span>`;
    }
    return '<i class="bi bi-circle-fill text-danger" style="font-size:.6rem"></i> offline';
  }

  function _hostNameHtml(host) {
    const manualName = (host?.manual_name || '').trim();
    const fallback = (host?.nmap_hostname || host?.router_hostname || host?.dns_name || '').trim();
    const displayName = manualName || fallback || host?.ip || '';
    const subName = manualName && fallback ? fallback : '';
    const ipAssignment = (host?.ip_assignment || '').trim();
    return `
      <span class="host-name-editable" data-ip="${esc(host?.ip || '')}" data-manual="${esc(manualName)}" title="${esc(window.t?.('host.name_edit_title', 'Doble clic para editar nombre') || 'Doble clic para editar nombre')}">${esc(displayName)}</span>
      ${subName ? `<div class="sub-name">${esc(subName)}</div>` : ''}
      ${ipAssignment ? `<div class="sub-name"><i class="bi bi-router" title="${esc(window.t?.('host.router_ssh', 'Router SSH') || 'Router SSH')}"></i> <span class="text-info-emphasis" style="font-size:.72rem">${esc(ipAssignment.toUpperCase())}</span></div>` : ''}
    `;
  }

  function _hostTypeOptions(selectedTypeId) {
    const types = Array.isArray(window._latestHostTypes) && window._latestHostTypes.length
      ? window._latestHostTypes
      : Array.from(document.querySelectorAll('#mType option')).map(opt => ({
          id: opt.value,
          name: (opt.textContent || '').trim(),
          icon: ''
        }));
    return types.map(t => {
      const id = String(t?.id ?? '');
      const selected = id === String(selectedTypeId ?? '') ? ' selected' : '';
      const label = t?.icon ? `${esc(t.icon)} ${esc(t.name || '')}` : esc(t?.name || '');
      return `<option value="${esc(id)}"${selected}>${label}</option>`;
    }).join('');
  }

  function _hostOwnerOptions(selectedOwnerId) {
    const owners = Array.isArray(window._latestHostOwners) && window._latestHostOwners.length
      ? window._latestHostOwners
      : Array.from(document.querySelectorAll('#mOwner option')).filter(opt => opt.value !== '').map(opt => ({
          id: opt.value,
          name: (opt.textContent || '').replace(/\s+\(deshabilitado\)\s*$/, '').trim(),
          enabled: !/deshabilitado/.test(opt.textContent || ''),
          color: ''
        }));
    const selectedRaw = String(selectedOwnerId ?? '');
    return '<option value="">Sin responsable</option>' + owners.map(o => {
      const id = String(o?.id ?? '');
      const selected = id === selectedRaw ? ' selected' : '';
      const suffix = o?.enabled === false ? ' (deshabilitado)' : '';
      return `<option value="${esc(id)}"${selected}>${esc(o?.name || '')}${suffix}</option>`;
    }).join('');
  }

  function _hostOwnerHtml(host) {
    const name = String(host?.owner_name || '').trim();
    if (!name) return '<span class="small-muted">—</span>';
    const color = /^#[0-9a-fA-F]{6}$/.test(String(host?.owner_color || '')) ? host.owner_color : '#64748b';
    const suffix = host?.owner_enabled === false ? ' opacity-75' : '';
    return `<span class="badge${suffix}" style="background:${esc(color)};color:#fff">${esc(name)}</span>`;
  }

  function _hostOwnerSelectHtml(host) {
    return `<select class="form-select form-select-sm owner-select" data-ip="${esc(host?.ip || '')}" title="${esc(window.t?.('host.owner_assign', 'Asignar responsable') || 'Asignar responsable')}">${_hostOwnerOptions(host?.owner_id ?? '')}</select>`;
  }

  function _syncOwnerSelectors(owners) {
    const list = Array.isArray(owners) ? owners : [];
    window._latestHostOwners = list;

    const currentFilter = String($('#ownerFilter').val() || '');
    const filterHtml = ['<option value="">(Todos responsables)</option>', '<option value="__none__">Sin responsable</option>']
      .concat(list.map(o => `<option value="${esc(o.id)}">${esc(o.name || '')}${o.enabled === false ? ' (deshabilitado)' : ''}</option>`))
      .join('');
    $('#ownerFilter').html(filterHtml).val(currentFilter);

    const currentBulk = String($('#bulkOwnerSelect').val() || '');
    const bulkHtml = ['<option value="">Responsable…</option>', '<option value="__none__">Sin responsable</option>']
      .concat(list.map(o => `<option value="${esc(o.id)}">${esc(o.name || '')}${o.enabled === false ? ' (deshabilitado)' : ''}</option>`))
      .join('');
    $('#bulkOwnerSelect').html(bulkHtml).val(currentBulk);

    const currentModal = String($('#mOwner').val() || '');
    $('#mOwner').html(_hostOwnerOptions(currentModal)).val(currentModal);
  }

  function _ownerAdminRow(o) {
    const color = /^#[0-9a-fA-F]{6}$/.test(String(o?.color || '')) ? o.color : '#3b82f6';
    return `<tr data-owner-id="${esc(o?.id || '')}">
      <td><input class="form-control form-control-sm owner-name" value="${esc(o?.name || '')}"></td>
      <td><input type="color" class="form-control form-control-sm form-control-color owner-color" value="${esc(color)}"></td>
      <td class="text-center"><input type="checkbox" class="form-check-input owner-enabled" ${o?.enabled === false ? '' : 'checked'}></td>
      <td class="mono">${esc(o?.hosts_total ?? 0)}</td>
      <td class="mono text-success">${esc(o?.hosts_online ?? 0)}</td>
      <td class="mono text-danger">${esc(o?.hosts_offline ?? 0)}</td>
      <td><button class="btn btn-outline-info btn-sm save-owner"><i class="bi bi-save2"></i></button></td>
    </tr>`;
  }

  function _renderOwnerAdmin(owners) {
    const tbody = document.getElementById('hostOwnersTableBody');
    if (!tbody) return;
    tbody.innerHTML = (owners || []).map(_ownerAdminRow).join('');
  }

  async function loadHostOwners() {
    const data = await fetch('/api/host-owners', { cache: 'no-store' }).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || 'No se pudieron cargar responsables');
    _syncOwnerSelectors(data.owners || []);
    _renderOwnerAdmin(data.owners || []);
    return data.owners || [];
  }
  window.loadHostOwners = loadHostOwners;

  function _hostDeviceTypeHtml(host) {
    const dt = String(host?.device_type || 'unknown').trim() || 'unknown';
    return dt !== 'unknown' ? `<span class="badge badge-device-type">${esc(dt)}</span>` : '—';
  }

  function _hostKnownHtml(host) {
    const known = !!host?.known;
    return `
      ${known
        ? '<span class="badge badge-known"><i class="bi bi-check-circle-fill"></i> Sí</span>'
        : '<span class="badge badge-unknown"><i class="bi bi-question-circle"></i> No</span>'}
      <button class="btn btn-sm btn-known-toggle btn-outline-secondary ms-1 btn-toggle-known"
              data-ip="${esc(host?.ip || '')}" data-known="${known ? 'true' : 'false'}"
              title="${known ? 'Marcar como desconocido' : 'Marcar como conocido'}">
        ${known ? '✓→?' : '?→✓'}
      </button>
    `;
  }

  function _hostLatencyHtml(host) {
    const lat = host?.last_latency_ms;
    if (lat == null || lat === '') return '<span class="latency-none">—</span>';
    const n = Number(lat);
    const cls = n < 10 ? 'latency-ok' : (n < 50 ? 'latency-warn' : 'latency-bad');
    return `<span class="${cls}">${n.toFixed(1)}ms</span><span class="d-none">${n}</span>`;
  }

  function _hostActionsHtml(host) {
    const validMac = macValid(host?.mac || '');
    return `
      <div class="d-flex gap-2 actions-mobile">
        <button class="btn btn-outline-warning btn-sm btn-ico btn-wol"
                title="${esc(validMac ? (window.t?.('host.wol', 'Wake-on-LAN') || 'Wake-on-LAN') : (window.t?.('host.wol_mac_required', 'WOL requiere MAC válida') || 'WOL requiere MAC válida'))}"
                ${validMac ? '' : 'disabled'}>
          <i class="bi bi-lightning-charge"></i>
        </button>
        <button class="btn btn-outline-info btn-sm btn-ico btn-detail" title="${esc(window.t?.('host.details', 'Detalles') || 'Detalles')}">
          <i class="bi bi-info-circle"></i>
        </button>
        <button class="btn btn-outline-danger btn-sm btn-ico btn-delete" title="${esc(window.t?.('host.delete_rediscover', 'Eliminar (forzar nueva detección)') || 'Eliminar (forzar nueva detección)')}">
          <i class="bi bi-trash3"></i>
        </button>
      </div>
    `;
  }

  function _hostRowHtml(host) {
    const typeName = String(host?.type_name || '').trim();
    const lastChangeText = host?.last_change || '';
    const knownOrder = host?.known ? '1' : '0';
    const lastSeenOrder = esc(host?.last_seen_raw || host?.last_seen || '');
    const lastChangeOrder = esc(host?.last_change_raw || lastChangeText || '');
    const lat = host?.last_latency_ms;
    const latencyOrder = (lat == null || lat === '' || Number.isNaN(Number(lat))) ? '-1' : String(Number(lat));

    return `
      <tr class="host-row ${_hostRowClass(host)}" data-ip="${esc(host?.ip || '')}" data-mac="${esc(host?.mac || '')}" data-tags="${esc(host?.tags || '')}" data-owner-id="${esc(host?.owner_id || '')}">
        <td class="no-row-click" style="width:30px"><input type="checkbox" class="row-check" value="${esc(host?.ip || '')}"></td>
        <td data-label="Estado" data-order="${_hostStatusOrder(host)}">${_hostStatusHtml(host)}</td>
        <td data-label="IP" class="mono">${esc(host?.ip || '')}</td>
        <td data-label="MAC" class="mono">${esc(host?.mac || '')}</td>
        <td data-label="Nombre" class="host-name no-row-click">${_hostNameHtml(host)}</td>
        <td data-label="Tipo_sort" class="d-none type-sort">${esc(typeName)}</td>
        <td class="d-none manual-name-hidden">${esc(host?.manual_name || '')}</td>
        <td class="d-none tags-hidden">${esc(host?.tags || '')}</td>
        <td data-label="Responsable" class="no-row-click host-owner-cell" data-order="${esc(host?.owner_name || 'zzzz')}">${_hostOwnerSelectHtml(host)}</td>
        <td data-label="Tipo" class="no-row-click type-inline"><div class="d-flex align-items-center gap-2"><select class="form-select form-select-sm type-select" data-ip="${esc(host?.ip || '')}">${_hostTypeOptions(host?.type_id)}</select></div></td>
        <td data-label="Device Type" class="device-type-cell">${_hostDeviceTypeHtml(host)}</td>
        <td data-label="Conocido" data-order="${knownOrder}" class="no-row-click text-center">${_hostKnownHtml(host)}</td>
        <td data-label="Latencia" data-order="${latencyOrder}">${_hostLatencyHtml(host)}</td>
        <td data-label="Visto hace" data-order="${lastSeenOrder}" class="mono">${esc(host?.seen_ago || '')}</td>
        <td data-label="Último cambio" data-order="${lastChangeOrder}" class="mono">${esc(lastChangeText)}<span class="d-none">${lastChangeOrder}</span></td>
        <td data-label="Acciones" class="no-row-click">${_hostActionsHtml(host)}</td>
        <td class="d-none group-owner-hidden">${esc(_hostOwnerGroupLabel(host))}</td>
        <td class="d-none group-type-hidden">${esc(_hostTypeGroupLabel(host))}</td>
        <td class="d-none group-status-hidden">${esc(_hostStatusGroupLabelFromStatus(host?.status))}</td>
        <td class="d-none group-known-hidden">${esc(_hostKnownGroupLabelFromHost(host))}</td>
      </tr>
    `;
  }

  function _decorateHostRow(node, host) {
    if (!node) return;
    const $row = $(node);
    const status = String(host?.status || 'offline').toLowerCase();
    const statusCls = status === 'online' ? 'ok' : (status === 'online_silent' ? 'silent' : 'bad');

    $row.attr('data-ip', host?.ip || '');
    $row.attr('data-mac', host?.mac || '');
    $row.attr('data-tags', host?.tags || '');
    $row.attr('data-owner-id', host?.owner_id || '');
    $row.removeClass('host-row row-online row-offline row-silent').addClass(`host-row ${_hostRowClass(host)}`);

    const $cells = $row.children('td');
    $cells.eq(0).addClass('no-row-click').css('width', '30px');
    $cells.eq(1).attr('data-label', 'Estado').attr('data-order', _hostStatusOrder(host)).removeClass('ok bad silent').addClass(statusCls);
    $cells.eq(2).attr('data-label', 'IP').addClass('mono');
    $cells.eq(3).attr('data-label', 'MAC').addClass('mono');
    $cells.eq(4).attr('data-label', 'Nombre').addClass('host-name no-row-click');
    $cells.eq(5).attr('data-label', 'Tipo_sort').addClass('d-none type-sort');
    $cells.eq(6).addClass('d-none manual-name-hidden');
    $cells.eq(7).addClass('d-none tags-hidden');
    $cells.eq(8).attr('data-label', 'Responsable').addClass('no-row-click host-owner-cell');
    $cells.eq(9).attr('data-label', 'Tipo').addClass('no-row-click type-inline');
    $cells.eq(10).attr('data-label', 'Device Type').addClass('device-type-cell');
    $cells.eq(11).attr('data-label', 'Conocido').addClass('no-row-click text-center');
    $cells.eq(12).attr('data-label', 'Latencia');
    $cells.eq(13).attr('data-label', 'Visto hace').addClass('mono');
    $cells.eq(14).attr('data-label', 'Último cambio').addClass('mono');
    $cells.eq(15).attr('data-label', 'Acciones').addClass('no-row-click');
    $cells.eq(16).addClass('d-none group-owner-hidden').text(_hostOwnerGroupLabel(host));
    $cells.eq(17).addClass('d-none group-type-hidden').text(_hostTypeGroupLabel(host));
    $cells.eq(18).addClass('d-none group-status-hidden').text(_hostStatusGroupLabelFromStatus(host?.status));
    $cells.eq(19).addClass('d-none group-known-hidden').text(_hostKnownGroupLabelFromHost(host));
  }

  async function refreshHostsTable(options = {}) {
    const keepPage = options.keepPage !== false;
    const adjustLayout = options.adjustLayout !== false;
    const currentPage = keepPage ? hostsTable.page() : 0;
    const data = await fetch('/api/hosts', { cache: 'no-store' }).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || 'No se pudo actualizar la lista de hosts');

    const hosts = Array.isArray(data.hosts) ? data.hosts : [];
    window._hostsData = hosts;
    window._latestHostTypes = Array.isArray(data.types) ? data.types : (window._latestHostTypes || []);
    if (Array.isArray(data.owners)) {
      _syncOwnerSelectors(data.owners);
      _renderOwnerAdmin(data.owners);
    }
    if (window._prefetch) window._prefetch.hosts = data;

    const existingRows = new Map();
    hostsTable.rows().every(function () {
      const node = this.node();
      const ip = String($(node).attr('data-ip') || $(node).children('td').eq(2).text().trim() || '');
      if (ip) existingRows.set(ip, this);
    });

    const incomingIps = new Set();
    hosts.forEach(host => {
      const ip = String(host?.ip || '');
      if (!ip) return;
      incomingIps.add(ip);
      const rowApi = existingRows.get(ip);
      if (rowApi) {
        _syncHostRowNode(rowApi.node(), host);
        rowApi.invalidate('dom');
      } else {
        const node = $(_hostRowHtml(host))[0];
        hostsTable.row.add(node);
      }
    });

    existingRows.forEach((rowApi, ip) => {
      if (!incomingIps.has(ip)) rowApi.remove();
    });

    hostsTable.draw(false);

    if (keepPage) {
      const pageCount = hostsTable.page.info().pages || 1;
      if (currentPage >= pageCount) {
        hostsTable.page(Math.max(0, pageCount - 1)).draw('page');
      }
    }

    if (adjustLayout) _adjustHostsTableLayout(0);
    if (_hostGroupBy && hostsTable.rowGroup) {
      hostsTable.rowGroup().enable(true);
    }
    window._refreshSplitByNet?.();
    window._refreshHostsVisualViews?.();
    return data;
  }

  async function pollStatus() {
    try {
      const st = await fetch('/api/status', { cache: 'no-store' }).then(r => r.json());
      if (!st?.ok) throw new Error(st?.error || 'Status no disponible');

      $('#cntTotal').text(st.total ?? '—');
      $('#cntOnline').text(st.online ?? '—');
      $('#cntOffline').text(st.offline ?? '—');
      $('#cntUnknown').text(st.unknown_online ?? '—');
      $('#cntOnlineBadge').text(st.online ?? '—');
      $('#cntOfflineBadge').text(st.offline ?? '—');
      _lastScanRefIso = st.last_scan?.finished_at || st.last_scan?.started_at || '';
      _renderLastScanAge();

      _setConnectionDotState('online');
      if (window._prefetch) window._prefetch.dashboard = st;
      return st;
    } catch (e) {
      _setConnectionDotState('offline');
      return null;
    }
  }
  window.pollStatus = pollStatus;
  pollStatus().catch(() => {});

  async function _runAutoRefreshCycle() {
    if (_autoRefreshBusy) return;
    _autoRefreshBusy = true;
    try {
      await pollStatus();
      if (document.getElementById('dashboardView')?.classList.contains('show') && typeof window.loadDashboard === 'function') {
        await window.loadDashboard();
      }
      if (document.getElementById('hostsView')?.classList.contains('show')) {
        await refreshHostsTable({ keepPage: true, adjustLayout: _isHostsTableVisible() });
      }
      if (document.getElementById('hostsScans')?.classList.contains('show') && typeof window.loadScans === 'function') {
        await window.loadScans();
      }
    } finally {
      _autoRefreshBusy = false;
    }
  }

  function _startAutoRefreshTimers() {
    if (_scanAgeTickTimer) clearInterval(_scanAgeTickTimer);
    if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
    _scanAgeTickTimer = setInterval(() => {
      _renderLastScanAge();
      _renderNextAutoRefresh();
    }, 1000);
    _scheduleNextAutoRefreshCountdown();
    _autoRefreshTimer = setInterval(() => {
      if (!_isAutoRefreshEnabled()) {
        _nextAutoRefreshAtMs = 0;
        _renderNextAutoRefresh();
        return;
      }
      _scheduleNextAutoRefreshCountdown(_hostAutoRefreshIntervalMs());
      _runAutoRefreshCycle().catch(() => {});
    }, _hostAutoRefreshIntervalMs());
  }

  const autoRefreshEl = document.getElementById('autoRefreshToggle');
  if (autoRefreshEl) {
    const stored = localStorage.getItem(AUTO_REFRESH_KEY);
    if (stored !== null) autoRefreshEl.checked = stored === '1';
  }
  _renderScanInterval();
  _initTopbarTooltips();
  _setConnectionDotState('online');
  _startAutoRefreshTimers();
  _renderNextAutoRefresh();
  document.addEventListener('frontendrefreshsettingschange', () => {
    _renderScanInterval();
    _startAutoRefreshTimers();
    _renderNextAutoRefresh();
  });

  async function refreshActiveViews(options = {}) {
    const refreshHosts = options.refreshHosts !== false;
    const tasks = [window.pollStatus?.()];
    if (refreshHosts) tasks.push(refreshHostsTable({ keepPage: true }));
    if (options.refreshScans && document.getElementById('hostsScans')?.classList.contains('show') && typeof window.loadScans === 'function') {
      tasks.push(window.loadScans());
    }
    if (options.refreshDashboard && document.getElementById('dashboardView')?.classList.contains('show') && typeof window.loadDashboard === 'function') {
      tasks.push(window.loadDashboard());
    }
    if (options.reopenIp && document.getElementById('hostModal')?.classList.contains('show') && typeof window.openHost === 'function') {
      tasks.push(window.openHost(options.reopenIp));
    }
    await Promise.allSettled(tasks.filter(Boolean));
  }




  // ── C.1. Global search + quick navigation ───────────────────────────────────
  function _activateTab(tabId) {
    const tabEl = document.getElementById(tabId);
    if (!tabEl) return;
    try { bootstrap.Tab.getOrCreateInstance(tabEl).show(); } catch (_) {}
  }

  function _flashSearchTarget(el) {
    if (!el) return;
    el.classList.add('search-hit-flash');
    window.setTimeout(() => el.classList.remove('search-hit-flash'), 1800);
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
  }

  function _globalSearchText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function _globalSearchTitleFromNode(node, fallback) {
    if (!node) return fallback || 'Resultado';
    const preferred = node.querySelector?.('h1,h2,h3,h4,h5,h6,.svc-title,.dash-proc-row-name,.dash-proc-title,.fw-semibold,.fw-bold,strong');
    const preferredText = _globalSearchText(preferred?.textContent || '');
    if (preferredText) return preferredText;
    const text = _globalSearchText(node.textContent || '');
    if (!text) return fallback || 'Resultado';
    const parts = text.split('·').map(x => x.trim()).filter(Boolean);
    return parts[0] || text.slice(0, 80);
  }

  function _globalSearchArray(payload, preferredKeys = []) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of preferredKeys) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    for (const value of Object.values(payload)) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  function _globalSearchServiceTitle(item) {
    return (
      item?.name ||
      item?.title ||
      item?.service_name ||
      item?.service ||
      item?.app_name ||
      item?.application_name ||
      item?.label ||
      item?.host ||
      item?.ip ||
      item?.id ||
      'Aplicación'
    );
  }

  function _globalSearchServiceSubtitle(item) {
    return [
      item?.host,
      item?.ip,
      item?.url,
      item?.domain,
      item?.status,
      item?.type,
      item?.description,
    ]
      .filter(Boolean)
      .map(value => String(value).trim())
      .join(' · ');
  }

  function _collectStructuredSearchResults(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const results = [];
    const seen = new Set();

    const addItems = (items, kind, icon, mainTabId, subTabId, titleFn, subtitleFn) => {
      (Array.isArray(items) ? items : []).forEach(item => {
        const haystack = [
          item?.name, item?.title, item?.service_name, item?.service, item?.app_name, item?.application_name,
          item?.script_name, item?.label, item?.host, item?.ip, item?.url, item?.domain, item?.status,
          item?.type, item?.description, item?.notes, item?.target, item?.command, item?.cron, item?.message
        ]
          .filter(Boolean)
          .map(value => String(value).toLowerCase())
          .join(' · ');
        if (!haystack.includes(q)) return;

        const title = _globalSearchText(titleFn(item) || '');
        const subtitle = _globalSearchText(subtitleFn(item) || '');
        const dedupeKey = `${kind}|${title}|${subtitle}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        results.push({
          kind,
          icon,
          title: title || (kind === 'automation' ? 'Automatización' : 'Aplicación'),
          subtitle: subtitle || haystack.slice(0, 140),
          action() {
            _activateTab(mainTabId);
            if (subTabId) window.setTimeout(() => _activateTab(subTabId), 60);
          }
        });
      });
    };

    const serviceItems = _globalSearchArray(window._prefetch?.services, ['services', 'items', 'apps', 'applications']);
    const scriptItems = _globalSearchArray(window._prefetch?.scripts, ['scripts', 'items', 'automation', 'automations', 'rows']);

    addItems(
      serviceItems,
      'service',
      'bi-hdd-rack',
      'infra-tab',
      'infra-apps-tab',
      _globalSearchServiceTitle,
      _globalSearchServiceSubtitle
    );

    addItems(
      scriptItems,
      'automation',
      'bi-cpu',
      'infra-tab',
      'infra-auto-tab',
      item => item?.name || item?.title || item?.script_name || item?.label || item?.id || 'Automatización',
      item => [item?.status, item?.target, item?.cron, item?.message, item?.description].filter(Boolean).join(' · ')
    );

    return results;
  }

  function _collectDomSearchResults(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const results = [];
    const seen = new Set();

    const addNodeMatches = (selector, kind, icon, mainTabId, subTabId) => {
      document.querySelectorAll(selector).forEach(node => {
        const text = _globalSearchText(node.textContent || '');
        if (!text) return;
        const haystack = text.toLowerCase();
        if (!haystack.includes(q)) return;
        const dedupeKey = `${kind}|${text}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        results.push({
          kind,
          icon,
          title: _globalSearchTitleFromNode(node, kind === 'automation' ? 'Automatización' : 'Aplicación'),
          subtitle: text.slice(0, 140),
          action() {
            _activateTab(mainTabId);
            if (subTabId) {
              window.setTimeout(() => _activateTab(subTabId), 60);
              window.setTimeout(() => _flashSearchTarget(node), 180);
            } else {
              window.setTimeout(() => _flashSearchTarget(node), 120);
            }
          }
        });
      });
    };

    addNodeMatches('#servicesGrid .svc-card, #servicesTableBody tr', 'service', 'bi-hdd-rack', 'infra-tab', 'infra-apps-tab');
    addNodeMatches('#scriptsView #sp-cards .card, #scriptsView .dash-proc-card, #scriptsView .dash-proc-row, #scriptsView tbody tr', 'automation', 'bi-cpu', 'infra-tab', 'infra-auto-tab');

    return results;
  }

  async function _ensureGlobalSearchHosts() {
    if (Array.isArray(window._hostsData) && window._hostsData.length) return window._hostsData;
    try { await refreshHostsTable({ keepPage: true, adjustLayout: false }); } catch (_) {}
    return Array.isArray(window._hostsData) ? window._hostsData : [];
  }

  async function _ensureGlobalSearchData() {
    const pending = [];
    if (!_globalSearchArray(window._prefetch?.services, ['services', 'items', 'apps', 'applications']).length) {
      pending.push(
        fetch('/api/services', { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) window._prefetch.services = data; })
          .catch(() => {})
      );
    }
    if (!_globalSearchArray(window._prefetch?.scripts, ['scripts', 'items', 'automation', 'automations', 'rows']).length) {
      pending.push(
        fetch('/api/scripts/status', { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) window._prefetch.scripts = data; })
          .catch(() => {})
      );
    }
    if (!_globalSearchArray(window._prefetch?.docs, ['docs', 'items']).length) {
      pending.push(
        fetch('/api/docs', { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data) window._prefetch.docs = data; })
          .catch(() => {})
      );
    }
    if (pending.length) await Promise.allSettled(pending);
  }

  function _openDocumentationSearchResult(info) {
    const modalEl = document.getElementById('configModal');
    if (!modalEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
    window.setTimeout(() => {
      document.querySelector('.cfg-nav-btn[data-section="docs"]')?.click();
      if (info?.tabId) {
        window.setTimeout(() => document.getElementById(info.tabId)?.click(), 90);
      }
    }, 80);
  }

  function _collectDocumentationSearchResults(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];

    const docs = _globalSearchArray(window._prefetch?.docs, ['docs', 'items']);
    const available = new Set(
      docs.map(doc => String(doc?.name || '').trim().toLowerCase()).filter(Boolean)
    );
    available.add('redes');

    const meta = {
      readme: {
        title: 'README',
        subtitle: 'DOC_ONLINE/README.md',
        tabId: 'doc-readme-tab',
        keywords: ['documentacion', 'documentación', 'docs', 'manual', 'guia', 'guía', 'canónico', 'canonico']
      },
      roadmap: {
        title: 'Roadmap',
        subtitle: 'DOC_ONLINE/ROADMAP_Auditor_IPs.txt',
        tabId: 'doc-roadmap-tab',
        keywords: ['roadmap', 'ruta', 'plan', 'pendientes', 'bloques']
      },
      estado: {
        title: 'Estado actual',
        subtitle: 'DOC_ONLINE/ESTADO_ACTUAL_Auditor_IPs.txt',
        keywords: ['estado', 'continuidad', 'traspaso', 'handoff']
      },
      indice: {
        title: 'Índice técnico',
        subtitle: 'DOC_ONLINE/INDICE_Auditor_IPs.txt',
        keywords: ['indice', 'índice', 'ficheros', 'secciones']
      },
      prompt: {
        title: 'Prompt operativo',
        subtitle: 'DOC_ONLINE/PROMPT_Auditor_IPs.txt',
        keywords: ['prompt', 'ritual', 'inicio', 'reglas']
      },
      checklist: {
        title: 'Checklist de cierre',
        subtitle: 'DOC_ONLINE/CHECKLIST_CIERRE_BLOQUE.md',
        keywords: ['checklist', 'cierre', 'bloque', 'merge']
      },
      decisiones: {
        title: 'Decisiones y errores',
        subtitle: 'DOC_ONLINE/DECISIONES_Y_ERRORES.md',
        keywords: ['decisiones', 'errores', 'trampas', 'regresiones']
      },
      redes: {
        title: 'Config Red Secundaria',
        subtitle: 'Configuración → Documentación',
        tabId: 'doc-redes-tab',
        keywords: ['redes', 'red', 'secundaria', 'configuracion', 'configuración']
      }
    };

    return Array.from(available)
      .map(name => {
        const info = meta[name];
        if (!info) return null;
        const haystack = [
          name,
          info.title,
          info.subtitle,
          ...(info.keywords || [])
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return null;
        return {
          kind: 'doc',
          icon: 'bi-book',
          title: info.title,
          subtitle: info.subtitle,
          action() {
            _openDocumentationSearchResult(info);
          }
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  }

  function _globalSearchFindTextNode(containerSelector, tokens, options = {}) {
    const root = document.querySelector(containerSelector);
    if (!root) return null;

    const cleanTokens = (Array.isArray(tokens) ? tokens : [tokens])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(value => value.length >= 2);

    if (!cleanTokens.length) return null;

    const isVisible = el => {
      const rect = el.getBoundingClientRect?.();
      return !!rect && rect.width > 0 && rect.height > 0;
    };

    const candidates = Array.from(root.querySelectorAll(
      '[data-folder-id], [data-node-id], .st-folder-card, .st-node-card, .st-folder-row, .st-node-row, tbody tr, .list-group-item, .cardish, .card'
    )).filter(isVisible);

    const matches = candidates.filter(el => {
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text || text.length > 1800) return false;
      return cleanTokens.some(token => text.includes(token));
    });

    if (!matches.length) return null;

    const strong = matches.filter(el => el.matches(
      '[data-folder-id], [data-node-id], .st-folder-card, .st-node-card, .st-folder-row, .st-node-row, tbody tr, .list-group-item'
    ));
    const pool = strong.length ? strong : matches;

    return options.preferLast ? pool[pool.length - 1] : pool[0];
  }

  function _globalSearchFocusSyncthingResult(row) {
    const kind = String(row?.kind || row?.type || '').trim();
    const title = String(row?.title || row?.name || '').trim();
    const folderId = String(row?.folder_id || '').trim();
    const nodeName = String(row?.subtitle || '').split('·')[0]?.trim() || '';

    // Para carpetas, el texto visible localiza mejor que el ID técnico.
    const isFolder = kind === 'syncthing_folder' || !!folderId;
    const preferred = isFolder ? (title || folderId || nodeName) : (title || nodeName || folderId);

    const input = document.getElementById('st-search');
    if (input && preferred) {
      input.value = preferred;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const tokens = isFolder
      ? [title, folderId, nodeName].filter(Boolean)
      : [title, nodeName, folderId].filter(Boolean);

    const tryFocus = () => {
      const el = _globalSearchFindTextNode('#infraSyncthing', tokens, { preferLast: isFolder });
      if (el) _flashSearchTarget(el);
    };

    window.setTimeout(tryFocus, 250);
    window.setTimeout(tryFocus, 800);
    window.setTimeout(tryFocus, 1400);
    window.setTimeout(tryFocus, 2200);
  }

  function _globalSearchRunApiAction(rawAction, row) {
    const action = String(rawAction || '').trim();
    const [kind, ...rest] = action.split(':');
    const target = rest.join(':');

    const openInfra = (subTabId, loader, afterOpen) => {
      _activateTab('infra-tab');
      window.setTimeout(async () => {
        _activateTab(subTabId);
        if (loader && typeof window[loader] === 'function') {
          try { await window[loader](false); } catch (_) {}
        }
        if (typeof afterOpen === 'function') afterOpen();
      }, 80);
    };

    if (kind === 'openHost' && target) {
      _activateTab('tab-hosts');
      window.setTimeout(() => {
        _activateTab('hosts-tabla-tab');
        if (typeof window.openHost === 'function') window.openHost(target);
      }, 80);
      return;
    }

    if (kind === 'openTab') {
      if (target === 'infra-apps') return openInfra('infra-apps-tab', 'loadServices');
      if (target === 'infra-auto') return openInfra('infra-auto-tab', null);
      if (target === 'infra-syncthing') {
        return openInfra('infra-syncthing-tab', 'loadSyncthingControl', () => _globalSearchFocusSyncthingResult(row || {}));
      }
      if (target === 'quality') return _activateTab('quality-tab');
      if (target === 'hosts-scans') {
        _activateTab('tab-hosts');
        window.setTimeout(() => _activateTab('hosts-scans-tab'), 80);
        return;
      }
      _activateTab(target);
      return;
    }

    if (kind === 'openConfig') {
      const modalEl = document.getElementById('configModal');
      if (!modalEl || !window.bootstrap?.Modal) return;
      window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
      window.setTimeout(() => {
        document.querySelector(`.cfg-nav-btn[data-section="${target}"]`)?.click();
      }, 90);
    }
  }

  async function _collectApiSearchResults(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    try {
      const data = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=16`, { cache: 'no-store' }).then(r => r.json());
      const rows = Array.isArray(data?.results) ? data.results : [];
      return rows.map(row => ({
        kind: row.kind || row.type || 'api',
        icon: row.icon || 'bi-search',
        title: row.title || row.name || 'Resultado',
        subtitle: row.subtitle || '',
        status: row.status || '',
        action() {
          _globalSearchRunApiAction(row.action, row);
        }
      }));
    } catch (_) {
      return [];
    }
  }

  function _collectHostSearchResults(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const hosts = Array.isArray(window._hostsData) ? window._hostsData : [];
    return hosts
      .filter(host => {
        const haystack = [
          host?.ip, host?.mac, host?.manual_name, host?.nmap_hostname, host?.router_hostname,
          host?.dns_name, host?.vendor, host?.type_name, host?.device_type, host?.tags
        ]
          .filter(Boolean)
          .map(value => String(value).toLowerCase());
        return haystack.some(value => value.includes(q));
      })
      .slice(0, 8)
      .map(host => ({
        kind: 'host',
        icon: 'bi-pc-display',
        title: host?.manual_name || host?.nmap_hostname || host?.router_hostname || host?.dns_name || host?.ip || 'Host',
        subtitle: [host?.ip, host?.mac, host?.type_name, host?.device_type].filter(Boolean).join(' · '),
        action() {
          _activateTab('tab-hosts');
          window.setTimeout(() => {
            _activateTab('hosts-tabla-tab');
            if (host?.ip) openHost(host.ip);
          }, 80);
        }
      }));
  }

  function _renderGlobalSearchResults(results) {
    const drop = document.getElementById('globalSearchDrop');
    if (!drop) return;
    if (!Array.isArray(results) || !results.length) {
      drop.innerHTML = '<div class="gs-empty">Sin resultados</div>';
      drop.style.display = 'block';
      return;
    }
    const limited = results.slice(0, 12);
    drop.innerHTML = limited.map((item, idx) => `
      <button type="button" class="gs-item w-100 text-start border-0 bg-transparent"
              data-gs-idx="${idx}">
        <span class="gs-icon"><i class="bi ${esc(item.icon || 'bi-search')}"></i></span>
        <span class="flex-grow-1 text-truncate">
          <span class="gs-title d-block text-truncate">${esc(item.title || 'Resultado')}</span>
          <span class="gs-sub d-block text-truncate">${esc(item.subtitle || '')}</span>
        </span>
      </button>
    `).join('');
    drop.style.display = 'block';
    drop._results = limited;
  }

  function _hideGlobalSearchResults() {
    const drop = document.getElementById('globalSearchDrop');
    if (!drop) return;
    drop.style.display = 'none';
    drop.innerHTML = '';
    drop._results = [];
  }

  let _globalSearchTimer = null;
  $(document).on('input', '#globalSearchInput', function () {
    const query = $(this).val() || '';
    window.clearTimeout(_globalSearchTimer);
    _globalSearchTimer = window.setTimeout(async () => {
      const q = query.trim();
      if (q.length < 2) {
        _hideGlobalSearchResults();
        return;
      }
      await Promise.allSettled([
        _ensureGlobalSearchHosts(),
        _ensureGlobalSearchData(),
      ]);
      const apiResults = await _collectApiSearchResults(q);
      const results = [
        ...apiResults,
        ..._collectHostSearchResults(q),
        ..._collectStructuredSearchResults(q),
        ..._collectDocumentationSearchResults(q),
        ..._collectDomSearchResults(q),
      ];
      _renderGlobalSearchResults(results);
    }, 120);
  });

  $(document).on('keydown', '#globalSearchInput', function (evt) {
    if (evt.key === 'Escape') {
      _hideGlobalSearchResults();
      this.blur();
    }
  });

  $(document).on('click', '#globalSearchDrop .gs-item', function () {
    const drop = document.getElementById('globalSearchDrop');
    const results = Array.isArray(drop?._results) ? drop._results : [];
    const idx = parseInt(this.getAttribute('data-gs-idx') || '-1', 10);
    const item = idx >= 0 ? results[idx] : null;
    _hideGlobalSearchResults();
    if (item?.action) item.action();
  });

  $(document).on('click', function (evt) {
    if ($(evt.target).closest('#globalSearchWrap').length) return;
    _hideGlobalSearchResults();
  });

  // ── C.2. Known toggle from Hosts table ───────────────────────────────────────
  $(document).on('click', '.btn-toggle-known', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const ip = String($(this).data('ip') || '').trim();
    if (!ip) return;
    const rawKnown = String($(this).data('known') ?? '').trim().toLowerCase();
    const currentKnown = rawKnown === 'true' || rawKnown === '1' || rawKnown === 'yes' || rawKnown === 'y' || rawKnown === 'si' || rawKnown === 'sí' || rawKnown === 'on';
    const nextKnown = !currentKnown;
    setBtnLoading(this, true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/known`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ known: nextKnown }),
      }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      const reopenIp = (window.currentIp && window.currentIp === ip) ? ip : undefined;
      await refreshActiveViews({ refreshHosts: true, refreshDashboard: true, reopenIp });
      $('#scanStatus').text(`✓ Conocido actualizado para ${ip}`);
    } catch (err) {
      $('#scanStatus').text(`Error cambiando conocido: ${err.message}`);
    } finally {
      setBtnLoading(this, false);
    }
  });

  // ── D. Scan button ────────────────────────────────────────────────────────────
  $('#scanBtn').on('click', async () => {
    setBtnLoading('#scanBtn', true);
    setLoading(true, 'Escaneando red…');
    $('#scanStatus').text('');
    try {
      const res  = await fetch('/scan', { method: 'POST' });
      const data = await res.json();
      if (res.status === 409) {
        $('#scanStatus').text('⏳ Scan ya en curso, espera a que termine…');
        setBtnLoading('#scanBtn', false); setLoading(false); return;
      }
      if (!data.ok) throw new Error(data.error || 'Error');
      $('#scanStatus').text('⏳ Escaneando en background…');
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const st = await fetch('/api/status').then(r => r.json());
          const fin = st.last_scan?.finished_at;
          if (fin && (Date.now() - new Date(fin).getTime()) < 20000) {
            clearInterval(poll);
            $('#scanStatus').text(`✓ online=${st.online} · offline=${st.offline} · nuevos=${st.last_scan?.new_hosts ?? 0}`);
            await refreshActiveViews({ refreshHosts: true, refreshScans: true, refreshDashboard: true });
            setBtnLoading('#scanBtn', false);
            setLoading(false);
            return;
          }
        } catch (_) {}
        if (attempts >= 30) {
          clearInterval(poll);
          await refreshActiveViews({ refreshHosts: true, refreshScans: true, refreshDashboard: true });
          setBtnLoading('#scanBtn', false);
          setLoading(false);
          $('#scanStatus').text('✓ Scan finalizado. Vista actualizada.');
        }
      }, 3000);
    } catch (e) {
      setLoading(false); setBtnLoading('#scanBtn', false);
      $('#scanStatus').text('Error: ' + e.message);
    }
  });


  // ── E. Scans table + loadScans ───────────────────────────────────────────────
  const scansTable = $.fn.DataTable.isDataTable('#scans')
    ? $('#scans').DataTable()
    : $('#scans').DataTable({
        pageLength: 25,
        order: [[0, 'desc']],
        deferRender: true,
        columns: [null, null, null, null, null, null, null, null, null, null, { orderable: false }]
      });

  async function loadScans() {
    setLoading(true);
    $('#scanStatus').text('');
    try {
      const rows = await fetch('/api/scans').then(r => r.json());
      scansTable.clear();
      scansTable.rows.add((rows || []).map(r => [
        esc(r.id ?? ''), esc(r.started_at ?? ''), esc(r.finished_at ?? ''),
        esc(r.cidr ?? ''), esc(r.online_hosts ?? ''), esc(r.offline_hosts ?? ''),
        esc(r.new_hosts ?? ''), esc(r.events_sent ?? ''),
        r.discord_sent ? '✅' : '—', '—', '',
      ])).draw();
      setLoading(false);
      if (typeof buildChart === 'function') buildChart(rows || []);
    } catch (e) {
      setLoading(false);
      $('#scanStatus').text('Error cargando ejecuciones: ' + e.message);
    }
  }
  $('#refreshScans').on('click', loadScans);


  // ── F. Host actions ───────────────────────────────────────────────────────────

  // WoL
  let _wolTrackerTimer = null;
  let _wolTrackerDeadline = 0;
  let _wolTrackerState = null;

  function ensureWolTracker() {
    if (document.getElementById('wolTracker')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="wolTracker" style="display:none;position:fixed;right:16px;bottom:16px;z-index:2055;width:min(420px,calc(100vw - 24px));">
        <div class="cardish" style="background:linear-gradient(180deg, rgba(12,18,30,.96), rgba(9,14,24,.94));box-shadow:0 18px 44px rgba(0,0,0,.56);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)">
          <div class="d-flex align-items-center gap-2 p-2 border-bottom border-secondary-subtle">
            <div class="fw-semibold" id="wolTrackerTitle">${_appDialogEscape(window.t?.('wol.tracker_title', 'Seguimiento WoL') || 'Seguimiento WoL')}</div>
            <span class="badge bg-secondary ms-auto" id="wolTrackerBadge">${_appDialogEscape(window.t?.('wol.tracker_waiting', 'esperando') || 'esperando')}</span>
            <button type="button" class="btn btn-outline-secondary btn-sm py-0 px-2" id="wolTrackerMin" title="${_appDialogEscape(window.t?.('common.minimize', 'Minimizar') || 'Minimizar')}"><i class="bi bi-dash-lg"></i></button>
            <button type="button" class="btn btn-outline-secondary btn-sm py-0 px-2" id="wolTrackerClose" title="${_appDialogEscape(window.t?.('common.close', 'Cerrar') || 'Cerrar')}"><i class="bi bi-x-lg"></i></button>
          </div>
          <div id="wolTrackerBody" class="p-2">
            <div id="wolTrackerStatus" class="small-muted mb-2"></div>
            <div id="wolTrackerLines" style="max-height:220px;overflow:auto;font-family:monospace;font-size:.78rem"></div>
          </div>
        </div>
      </div>
    `);
    $(document).off('click', '#wolTrackerMin').on('click', '#wolTrackerMin', function () {
      const $body = $('#wolTrackerBody');
      const hidden = $body.is(':hidden');
      $body.toggle(!hidden);
      $(this).find('i').attr('class', hidden ? 'bi bi-dash-lg' : 'bi bi-arrows-angle-expand');
    });
    $(document).off('click', '#wolTrackerClose').on('click', '#wolTrackerClose', function () {
      if (_wolTrackerTimer) clearInterval(_wolTrackerTimer);
      _wolTrackerTimer = null;
      _wolTrackerState = null;
      $('#wolTracker').hide();
    });
  }

  function trackerLine(text, cls) {
    ensureWolTracker();
    const nowIso = new Date().toISOString();
    const ts = (typeof window.fmtTime === 'function') ? window.fmtTime(nowIso) : '—';
    const safe = esc(text);
    const klass = cls ? ` ${cls}` : '';
    $('#wolTrackerLines').prepend(`<div class="${klass}">[${ts}] ${safe}</div>`);
  }

  async function refreshHostAfterWol(ip) {
    try { await refreshActiveViews({ refreshHosts: true, refreshDashboard: true, reopenIp: ip }); } catch (_) {}
    const modalShown = document.getElementById('hostModal')?.classList.contains('show');
    if (modalShown && window.currentIp === ip && typeof window.openHost === 'function') {
      try { await window.openHost(ip); } catch (_) {}
      $('#mMsg').text('✓ Equipo online');
      return;
    }
    $('#scanStatus').text(`✓ ${ip} online`);
  }

  window.startWolTracker = function startWolTracker(ip, options = {}) {
    if (!ip) return;
    ensureWolTracker();
    if (_wolTrackerTimer) clearInterval(_wolTrackerTimer);
    _wolTrackerDeadline = Date.now() + (Number(options.timeoutMs) || window.getOperationalTimeoutMs('wol_tracker'));
    _wolTrackerState = {
      ip,
      isPublic: !!options.isPublic,
      onOnline: typeof options.onOnline === 'function' ? options.onOnline : null,
    };
    $('#wolTracker').show();
    $('#wolTrackerBody').show();
    $('#wolTrackerMin i').attr('class', 'bi bi-dash-lg');
    $('#wolTrackerTitle').text(`Seguimiento WoL · ${ip}`);
    $('#wolTrackerBadge').attr('class', 'badge bg-warning').text('arrancando');
    $('#wolTrackerStatus').text('Esperando respuesta ICMP y refresco de estado…');
    $('#wolTrackerLines').html('');
    trackerLine('WoL enviado. Empezando comprobaciones…');

    const tick = async () => {
      if (!_wolTrackerState || _wolTrackerState.ip !== ip) return;
      if (Date.now() > _wolTrackerDeadline) {
        if (_wolTrackerTimer) clearInterval(_wolTrackerTimer);
        _wolTrackerTimer = null;
        $('#wolTrackerBadge').attr('class', 'badge bg-danger').text('sin respuesta');
        $('#wolTrackerStatus').text('No ha respondido al ping dentro del tiempo de espera.');
        trackerLine('Sin respuesta todavía.', 'text-danger');
        return;
      }
      try {
        const endpoint = _wolTrackerState.isPublic
          ? `/api/public/wol/${encodeURIComponent(ip)}/status`
          : `/api/hosts/${encodeURIComponent(ip)}/wol/status`;
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.alive) {
          if (_wolTrackerTimer) clearInterval(_wolTrackerTimer);
          _wolTrackerTimer = null;
          $('#wolTrackerBadge').attr('class', 'badge bg-success').text('online');
          const latency = data.avg_ms != null ? ` · ${Math.round(data.avg_ms)}ms` : '';
          $('#wolTrackerStatus').text(`Equipo online${latency}`);
          trackerLine(`Host online${latency}. Estado actualizado.`, 'text-success');
          try { await (_wolTrackerState.onOnline?.(data) || refreshHostAfterWol(ip)); } catch (_) {}
          return;
        }
        const loss = data.loss_pct != null ? ` · pérdida ${data.loss_pct}%` : '';
        $('#wolTrackerBadge').attr('class', 'badge bg-warning').text('esperando');
        $('#wolTrackerStatus').text('Todavía no responde al ping…');
        trackerLine(`Sin respuesta${loss}`, 'text-warning');
      } catch (e) {
        $('#wolTrackerBadge').attr('class', 'badge bg-danger').text('error');
        $('#wolTrackerStatus').text(e.message || 'Error comprobando el estado');
        trackerLine(`Error comprobando estado: ${e.message || 'Error'}`, 'text-danger');
      }
    };

    setTimeout(tick, 2500);
    _wolTrackerTimer = setInterval(tick, 3000);
  };

  async function doWol(ip, msgSel, btn, options = {}) {
    if (btn) setBtnLoading(btn, true);
    setLoading(true);
    if (msgSel) $(msgSel).text('Enviando WOL…');
    $('#scanStatus').text(`⚡ Enviando WOL a ${ip}…`);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/wol`, { method: 'POST' }).then(r => r.json());
      setLoading(false);
      if (btn) setBtnLoading(btn, false);
      if (!data.ok) throw new Error(data.error || 'Error');
      const msg = `⚡ WOL OK · ${ip} · ${data.mac} → ${data.broadcast}:${data.port}`;
      $('#scanStatus').text(msg);
      if (msgSel) $(msgSel).text(msg);
      if (options.track !== false) {
        window.startWolTracker(ip, { isPublic: false, timeoutMs: options.timeoutMs });
      }
    } catch (e) {
      setLoading(false);
      if (btn) setBtnLoading(btn, false);
      const msg = `WOL ERROR · ${ip}: ${e.message}`;
      $('#scanStatus').text(msg);
      if (msgSel) $(msgSel).text(msg);
    }
  }

  $(document).on('click', '.btn-wol', function (e) {
    e.preventDefault(); e.stopPropagation();
    if ($(this).prop('disabled')) return;
    doWol($(this).closest('tr').data('ip'), null, this);
  });
  $(document).off('click', '#mWol').on('click', '#mWol', function () {
    const ip = window.currentIp || (($('#mIp').text() || '').trim());
    if (!ip || $(this).prop('disabled')) return;
    doWol(ip, '#mMsg', this);
  });

  // Row click → modal
  $(document).on('click', 'tr.host-row', function (e) {
    if ($(e.target).closest('.no-row-click, button, a, input, textarea, select').length) return;
    openHost($(this).data('ip'));
  });
  $(document).on('click', '.btn-detail', function (e) {
    e.preventDefault(); e.stopPropagation();
    openHost($(this).closest('tr').data('ip'));
  });

  // Save host modal
  $('#mSave').on('click', async function () {
    const ip = window.currentIp || (($('#mIp').text() || '').trim());
    if (!ip) return;
    setBtnLoading(this, true); setLoading(true); $('#mMsg').text('');
    try {
      const res  = await fetch(`/api/hosts/${encodeURIComponent(ip)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual_name: $('#mManual').val(), notes: $('#mNotes').val(), type_id: $('#mType').val(), owner_id: $('#mOwner').val() || null })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error');
      $('#mMsg').text('✓ Guardado');
      const newManual = ($('#mManual').val() || '').trim();
      const nmapHost  = ($('#mHost').text() || '').trim();
      const dnsName   = ($('#mDns').text()  || '').trim();
      const row       = $(`tr[data-ip="${CSS.escape(ip)}"]`);
      if (row.length) {
        const fallback     = nmapHost || dnsName;
        const displayName  = newManual || fallback || ip;
        row.find('td.host-name').html($('<span>').text(displayName).html() + (newManual && fallback ? `<div class="sub-name">${$('<span>').text(fallback).html()}</div>` : ''));
        row.find('td.manual-name-hidden').text(newManual);
        hostsTable.draw(false);
      }
      await refreshActiveViews({ refreshHosts: true, refreshDashboard: true, reopenIp: ip });
      setBtnLoading(this, false);
      setLoading(false);
    } catch (e) {
      setBtnLoading(this, false); setLoading(false);
      $('#mMsg').text('Error: ' + e.message);
    }
  });

  // Type inline
  // Save previous value on focus so we can revert if the API rejects the change (e.g. 401).
  $(document).on('focus mousedown', '.type-select', function () {
    $(this).data('prev-type-val', $(this).val());
  });
  $(document).on('change', '.type-select', async function (e) {
    e.preventDefault(); e.stopPropagation();
    const ip = $(this).data('ip'), type_id = $(this).val();
    const $sel = $(this);
    const prevVal = $sel.data('prev-type-val') || $sel.find('option:first').val();
    setLoading(true); $sel.prop('disabled', true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type_id })
      }).then(r => r.json());
      setLoading(false); $sel.prop('disabled', false);
      if (!data.ok) {
        // Revert the select to its previous value — avoids phantom UI change on auth error
        $sel.val(prevVal);
        throw new Error(data.error || 'Error');
      }
      $sel.data('prev-type-val', type_id);
      $sel.closest('tr').find('td.type-sort').text($sel.find('option:selected').text());
      hostsTable.draw(false);
    } catch (err) {
      setLoading(false); $sel.prop('disabled', false);
      // Ensure select is reverted on any error path
      if ($sel.val() !== prevVal) $sel.val(prevVal);
      $('#scanStatus').text('Error actualizando tipo: ' + err.message);
    }
  });

  // Delete
  function askDelete(ip) { window.pendingDeleteIp = ip; $('#dIp').text(ip); confirmDeleteModal.show(); }
  $(document).on('click', '.btn-delete', function (e) { e.preventDefault(); e.stopPropagation(); askDelete($(this).closest('tr').data('ip')); });
  $('#mDelete').on('click', function () {
    const ip = window.currentIp || (($('#mIp').text() || '').trim());
    if (ip) askDelete(ip);
  });
  $('#dConfirm').on('click', async function () {
    if (!window.pendingDeleteIp) return;
    setBtnLoading(this, true); setLoading(true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(window.pendingDeleteIp)}`, { method: 'DELETE' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      const removedIp = window.pendingDeleteIp;
      confirmDeleteModal.hide(); hostModal.hide();
      $('#scanStatus').text(`🗑 Eliminado ${removedIp}.`);
      await refreshActiveViews({ refreshHosts: true, refreshScans: false, refreshDashboard: true });
      window.pendingDeleteIp = null;
      setBtnLoading(this, false);
      setLoading(false);
    } catch (e) {
      setBtnLoading(this, false); setLoading(false);
      $('#scanStatus').text('Error eliminando: ' + e.message);
    }
  });

  // Types CRUD
  async function reloadTypes() {
    const data = await fetch('/api/types').then(r => r.json());
    if (!data.ok) return;
    const tbody = $('#typesTable tbody');
    tbody.empty();
    for (const t of data.types) {
      tbody.append(`<tr data-type-id="${t.id}">
        <td class="mono">${t.id}</td>
        <td><input class="form-control form-control-sm type-name" value="${esc(t.name)}"></td>
        <td><div class="emoji-picker-wrap">
          <button type="button" class="emoji-picker-btn type-icon-val" data-icon="${esc(t.icon||'')}">${t.icon||'❓'}</button>
          <input type="hidden" class="type-icon-hidden" value="${esc(t.icon||'')}">
          <div class="emoji-grid-popup"></div>
        </div></td>
        <td><div class="d-flex gap-2">
          <button class="btn btn-outline-info btn-sm save-type"><i class="bi bi-save2"></i></button>
          <button class="btn btn-outline-danger btn-sm del-type"><i class="bi bi-trash3"></i></button>
        </div></td>
      </tr>`);
    }
    // Rebuild selectors
    const typeFilter = $('#typeFilter'), curFilter = typeFilter.val();
    typeFilter.empty().append('<option value="">(Todos)</option>');
    for (const t of data.types) typeFilter.append(`<option value="${esc(t.name)}">${t.icon ? t.icon+' ' : ''}${esc(t.name)}</option>`);
    typeFilter.val(curFilter || '');

    $('.type-select').each(function () {
      const sel = $(this), cur = sel.val();
      sel.empty();
      for (const t of data.types) sel.append(`<option value="${t.id}" data-icon="${esc(t.icon||'')}">${t.icon ? t.icon+' ' : ''}${esc(t.name)}</option>`);
      sel.val(cur);
      sel.closest('tr').find('td.type-sort').text(sel.find('option:selected').text());
    });
    const mType = $('#mType'), curM = mType.val();
    mType.empty();
    for (const t of data.types) mType.append(`<option value="${t.id}">${t.icon ? t.icon+' ' : ''}${esc(t.name)}</option>`);
    mType.val(curM || '');
  }

  $('#addType').on('click', async function () {
    const name = ($('#newTypeName').val() || '').trim(), ico = ($('#newTypeIcon').val() || '').trim();
    if (!name) { $('#typesMsg').text('Nombre vacío'); return; }
    $('#typesMsg').text('Añadiendo…');
    const data = await fetch('/api/types', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, icon: ico }) }).then(r => r.json());
    if (!data.ok) { $('#typesMsg').text(data.error || 'Error'); return; }
    $('#newTypeName').val(''); $('#newTypeIcon').val(''); $('#typesMsg').text('OK');
    await reloadTypes();
  });
  $(document).on('click', '.save-type', async function () {
    const tr = $(this).closest('tr'), id = tr.data('type-id');
    const name = (tr.find('.type-name').val() || '').trim();
    const icon = (tr.find('.type-icon-hidden').val() || tr.find('.type-icon-val').data('icon') || '').trim();
    $('#typesMsg').text('Guardando…');
    const data = await fetch(`/api/types/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, icon }) }).then(r => r.json());
    if (!data.ok) { $('#typesMsg').text(data.error || 'Error'); return; }
    $('#typesMsg').text('OK');
    await reloadTypes(); hostsTable.draw(false);
  });
  $(document).on('click', '.del-type', async function () {
    const tr = $(this).closest('tr'), id = tr.data('type-id');
    const name = (tr.find('.type-name').val() || '').trim();
    if (!(await window.appConfirm(`¿Borrar el tipo "${name}"?\nLos hosts que lo usen pasarán a "Por defecto".`, {
      title: 'Borrar tipo de host',
      confirmText: 'Borrar',
      danger: true
    }))) return;
    $('#typesMsg').text('Borrando…');
    const data = await fetch(`/api/types/${id}`, { method:'DELETE' }).then(r => r.json());
    if (!data.ok) { $('#typesMsg').text(data.error || 'Error'); return; }
    $('#typesMsg').text('OK');
    await reloadTypes(); hostsTable.draw(false);
  });


  // ── Responsable inline y asignación masiva ───────────────────────────────────
  $(document).on('focus mousedown', '.owner-select', function () {
    $(this).data('prev-owner-val', $(this).val());
  });

  $(document).on('change', '.owner-select', async function (e) {
    e.preventDefault(); e.stopPropagation();
    const ip = $(this).data('ip');
    const ownerVal = $(this).val() || null;
    const $sel = $(this);
    const prevVal = $sel.data('prev-owner-val') || '';
    if (!ip) return;

    setLoading(true);
    $sel.prop('disabled', true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_id: ownerVal })
      }).then(r => r.json());

      if (!data.ok) {
        $sel.val(prevVal);
        throw new Error(data.error || 'Error');
      }

      $sel.data('prev-owner-val', ownerVal || '');
      await refreshHostsTable({ keepPage: true });
    } catch (err) {
      $sel.val(prevVal);
      $('#bulkMsg').text('✗ ' + err.message);
    } finally {
      setLoading(false);
      $sel.prop('disabled', false);
    }
  });

  function _selectedHostIps() {
    return $('.row-check:checked').map(function () {
      return String($(this).val() || '').trim();
    }).get().filter(Boolean);
  }

  async function _bulkUpdateSelectedHosts(payloadFactory, label) {
    const ips = _selectedHostIps();
    const $msg = $('#bulkMsg');
    if (!ips.length) {
      $msg.text('Selecciona al menos un host.');
      return;
    }

    setLoading(true, `${label}…`);
    $msg.text(`${label} (${ips.length})…`);

    let ok = 0;
    let failed = 0;
    for (const ip of ips) {
      try {
        const payload = payloadFactory(ip);
        const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json());
        if (data.ok) ok += 1;
        else failed += 1;
      } catch (_) {
        failed += 1;
      }
    }

    await refreshActiveViews({ refreshHosts: true, refreshDashboard: true });
    setLoading(false);
    $msg.text(failed ? `✓ ${ok} OK · ✗ ${failed} error(es)` : `✓ ${ok} host(s) actualizados`);
  }

  $(document).on('click', '#bulkApplyOwner', async function () {
    const val = String($('#bulkOwnerSelect').val() || '');
    if (!val) {
      $('#bulkMsg').text('Elige un responsable o “Sin responsable”.');
      return;
    }
    const ownerId = val === '__none__' ? null : val;
    $(this).prop('disabled', true);
    try {
      await _bulkUpdateSelectedHosts(() => ({ owner_id: ownerId }), 'Asignando responsable');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $(document).on('click', '#bulkApplyType', async function () {
    const typeId = String($('#bulkTypeSelect').val() || '');
    if (!typeId) {
      $('#bulkMsg').text('Elige un tipo.');
      return;
    }
    $(this).prop('disabled', true);
    try {
      await _bulkUpdateSelectedHosts(() => ({ type_id: typeId }), 'Asignando tipo');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // ── Responsables de hosts ─────────────────────────────────────────────────────
  $(document).on('click', '#addOwnerBtn', async function () {
    const name = ($('#newOwnerName').val() || '').trim();
    const color = ($('#newOwnerColor').val() || '').trim();
    const $msg = $('#ownersMsg');
    if (!name) { $msg.text('Nombre vacío'); return; }
    $(this).prop('disabled', true); $msg.text('Añadiendo…');
    try {
      const data = await fetch('/api/host-owners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, enabled: true })
      }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $('#newOwnerName').val('');
      $msg.text('✓ Añadido');
      await loadHostOwners();
      await refreshHostsTable({ keepPage: true });
    } catch (e) {
      $msg.text('✗ ' + e.message);
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $(document).on('click', '.save-owner', async function () {
    const tr = $(this).closest('tr');
    const id = tr.data('owner-id');
    const name = (tr.find('.owner-name').val() || '').trim();
    const color = (tr.find('.owner-color').val() || '').trim();
    const enabled = tr.find('.owner-enabled').is(':checked');
    const $msg = $('#ownersMsg');
    if (!id) return;
    if (!name) { $msg.text('Nombre vacío'); return; }
    $(this).prop('disabled', true); $msg.text('Guardando…');
    try {
      const data = await fetch(`/api/host-owners/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, enabled })
      }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $msg.text('✓ Guardado');
      await loadHostOwners();
      await refreshHostsTable({ keepPage: true });
    } catch (e) {
      $msg.text('✗ ' + e.message);
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // ── G. Loading helpers ────────────────────────────────────────────────────────
  function setLoading(active, msg) {
    const spinner    = document.getElementById('globalSpinner');
    const overlay    = document.getElementById('tableOverlay');
    const overlayMsg = document.getElementById('overlayMsg');
    if (active) {
      spinner.style.display = 'block';
      if (msg) { overlayMsg.textContent = msg; overlay.style.display = 'flex'; }
    } else {
      spinner.style.display = 'none';
      overlay.style.display = 'none';
    }
  }
  function setBtnLoading(btn, active) {
    const $b = $(btn);
    if (active) {
      if (!$b.data('orig-html')) $b.data('orig-html', $b.html());
      $b.addClass('btn-loading').html(`<span class="btn-label">${$b.data('orig-html')}</span>`);
    } else {
      $b.removeClass('btn-loading');
      if ($b.data('orig-html')) { $b.html($b.data('orig-html')); $b.removeData('orig-html'); }
    }
  }

  // Toast

  function _appDialogEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function _appDialogText(key, fallback) {
    try {
      if (typeof window.t !== 'function') return fallback;
      const value = window.t(key, fallback);
      if (!value || value === key) return fallback;
      return value;
    } catch (_) {
      return fallback;
    }
  }

  function _ensureAppDialogModal() {
    let modalEl = document.getElementById('appGenericDialogModal');
    if (modalEl) return modalEl;

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="appGenericDialogModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark text-light border-secondary">
            <div class="modal-header">
              <h5 class="modal-title" id="appGenericDialogTitle">${_appDialogEscape(_appDialogText('common.confirm_action', 'Confirmar acción'))}</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="${_appDialogEscape(_appDialogText('common.close', 'Cerrar'))}"></button>
            </div>
            <div class="modal-body">
              <div id="appGenericDialogMessage" class="small"></div>
              <textarea id="appGenericDialogInput" class="form-control mt-3 d-none" rows="4"></textarea>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-light" id="appGenericDialogCancel" data-bs-dismiss="modal">${_appDialogEscape(_appDialogText('common.cancel', 'Cancelar'))}</button>
              <button type="button" class="btn btn-primary" id="appGenericDialogOk">${_appDialogEscape(_appDialogText('common.accept', 'Aceptar'))}</button>
            </div>
          </div>
        </div>
      </div>
    `);
    return document.getElementById('appGenericDialogModal');
  }

  function _appDialog(options = {}) {
    return new Promise(resolve => {
      const modalEl = _ensureAppDialogModal();
      const titleEl = modalEl.querySelector('#appGenericDialogTitle');
      const msgEl = modalEl.querySelector('#appGenericDialogMessage');
      const inputEl = modalEl.querySelector('#appGenericDialogInput');
      const okBtn = modalEl.querySelector('#appGenericDialogOk');
      const cancelBtn = modalEl.querySelector('#appGenericDialogCancel');

      const withInput = !!options.withInput;
      titleEl.textContent = options.title || _appDialogText('common.confirm_action', 'Confirmar acción');
      msgEl.innerHTML = _appDialogEscape(options.message || '').replace(/\n/g, '<br>');
      cancelBtn.textContent = options.cancelText || _appDialogText('common.cancel', 'Cancelar');
      okBtn.textContent = options.confirmText || _appDialogText('common.accept', 'Aceptar');
      okBtn.className = `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`;

      inputEl.classList.toggle('d-none', !withInput);
      inputEl.value = withInput ? String(options.defaultValue ?? '') : '';

      const modal = window.bootstrap?.Modal
        ? window.bootstrap.Modal.getOrCreateInstance(modalEl)
        : null;

      let settled = false;
      const cleanup = () => {
        okBtn.removeEventListener('click', onOk);
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
      };
      const finish = value => {
        if (settled) return;
        settled = true;
        cleanup();
        if (modal) modal.hide();
        resolve(value);
      };
      const onOk = () => finish(withInput ? inputEl.value : true);
      const onHidden = () => finish(withInput ? null : false);

      okBtn.addEventListener('click', onOk);
      modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });

      if (modal) {
        modal.show();
        if (withInput) setTimeout(() => inputEl.focus(), 150);
      } else {
        cleanup();
        resolve(withInput ? null : false);
      }
    });
  }

  window.appConfirm = function appConfirm(message, options = {}) {
    return _appDialog(Object.assign({
      title: _appDialogText('common.confirm_action', 'Confirmar acción'),
      message,
      confirmText: _appDialogText('common.accept', 'Aceptar'),
      cancelText: _appDialogText('common.cancel', 'Cancelar')
    }, options || {}));
  };

  window.appPrompt = function appPrompt(message, defaultValue = '', options = {}) {
    return _appDialog(Object.assign({
      title: _appDialogText('common.enter_value', 'Introducir dato'),
      message,
      defaultValue,
      confirmText: _appDialogText('common.save', 'Guardar'),
      cancelText: _appDialogText('common.cancel', 'Cancelar'),
      withInput: true
    }, options || {}));
  };


  function showToast(msg, type) {
    const el = document.getElementById('toastBody'), toast = document.getElementById('notifToast');
    if (!el || !toast) return;
    el.textContent = msg;
    toast.className = toast.className.replace(/bg-\S+/, '');
    if (type === 'success') toast.classList.add('bg-success');
    else if (type === 'danger')  toast.classList.add('bg-danger');
    else if (type === 'warning') toast.classList.add('bg-warning');
    bootstrap.Toast.getOrCreateInstance(toast).show();
  }


  // ── H. Global exports ─────────────────────────────────────────────────────────
  Object.assign(window, {
    hostsTable, scansTable, hostModal, confirmDeleteModal,
    setLoading, setBtnLoading, showToast,
    accentColor, accent2Color, cssVar, safeId,
    esc, macValid, reloadTypes, askDelete, doWol, startWolTracker: window.startWolTracker,
    loadScans,
    openConfig: () => { const el = document.getElementById('configModal'); if (el) bootstrap.Modal.getOrCreateInstance(el).show(); },
  });


  function _cfgNavVisible(btn) {
    const item = btn?.closest('.nav-item');
    return !!(btn && item && item.style.display !== 'none');
  }

  function _cfgSetNavVisible(btn, show) {
    const item = btn?.closest('.nav-item');
    if (!item || !btn) return;
    item.style.display = show ? '' : 'none';
    btn.classList.toggle('d-none', !show);
    if (!show) btn.classList.remove('active');
  }

  function _cfgSetPaneVisible(pane, show) {
    const el = typeof pane === 'string' ? document.getElementById(pane) : pane;
    if (!el) return;
    el.style.display = show ? '' : 'none';
    if (!show) el.classList.remove('show', 'active');
  }

  function _cfgActivateVisibleTab(btn) {
    if (!btn || !_cfgNavVisible(btn)) return false;
    try {
      bootstrap.Tab.getOrCreateInstance(btn).show();
      return true;
    } catch (_) {
      return false;
    }
  }

  function _cfgFirstVisible(buttons) {
    return (buttons || []).find(btn => _cfgNavVisible(btn)) || null;
  }


  try {
    if (localStorage.getItem('auditor-last-subtab-tab-hosts') === 'hosts-grupos-tab') {
      localStorage.setItem('auditor-last-subtab-tab-hosts', 'hosts-tabla-tab');
    }
    if (localStorage.getItem('auditor-last-subtab-hosts-tab') === 'hosts-grupos-tab') {
      localStorage.setItem('auditor-last-subtab-hosts-tab', 'hosts-tabla-tab');
    }
  } catch (_) {}


  const OPTIONAL_MODULE_DEFAULTS = {
    services: true,
    automation: true,
    agents: true,
    syncthing: true,
    quality: true,
    notifications: true,
    ai: true,
    exports: true,
  };

  function _parseEnabledModules(raw) {
    const values = Object.assign({}, OPTIONAL_MODULE_DEFAULTS);

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      Object.keys(raw).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(values, key)) values[key] = !!raw[key];
      });
      return values;
    }

    const txt = String(raw || '').trim();
    if (!txt) return values;

    try {
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(key => {
          if (Object.prototype.hasOwnProperty.call(values, key)) values[key] = !!parsed[key];
        });
        return values;
      }
      if (Array.isArray(parsed)) {
        const enabled = new Set(parsed.map(x => String(x || '').trim()).filter(Boolean));
        Object.keys(values).forEach(key => { values[key] = enabled.has(key); });
        return values;
      }
    } catch (_) {}

    if (txt.includes(',')) {
      const enabled = new Set(txt.split(',').map(x => x.trim()).filter(Boolean));
      Object.keys(values).forEach(key => { values[key] = enabled.has(key); });
    }

    return values;
  }

  window.getEnabledModules = function() {
    return _parseEnabledModules(window.APP_CONFIG?.enabled_modules || {});
  };

  window.moduleEnabled = function(moduleId, fallback = true) {
    const modules = window.getEnabledModules();
    return Object.prototype.hasOwnProperty.call(modules, moduleId) ? !!modules[moduleId] : !!fallback;
  };

  window.applyModuleGating = function(enabledModules) {
    const modules = _parseEnabledModules(enabledModules);
    window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, { enabled_modules: modules });

    document.dispatchEvent(new CustomEvent('modulegatingchange', { detail: modules }));

    return modules;
  };


  window.applyHiddenTabs = function(hiddenTabs) {
    const hidden = new Set(
      (Array.isArray(hiddenTabs) ? hiddenTabs : String(hiddenTabs || '').split(','))
        .map(v => String(v || '').trim())
        .filter(Boolean)
    );

    const dashboardBtn  = document.getElementById('dashboard-tab');
    const hostsBtn      = document.getElementById('tab-hosts');
    const infraBtn      = document.getElementById('infra-tab');
    const qualityBtn    = document.getElementById('quality-tab');
    const alertsBtn     = document.getElementById('alerts-tab');

    const hostsTableBtn = document.getElementById('hosts-tabla-tab');
    const hostsMapBtn   = document.getElementById('hosts-mapa-tab');
    const hostsScansBtn = document.getElementById('hosts-scans-tab');

    const infraAppsBtn  = document.getElementById('infra-apps-tab');
    const infraAutoBtn  = document.getElementById('infra-auto-tab');
    const infraSyncBtn  = document.getElementById('infra-syncthing-tab');

    const modules = window.getEnabledModules ? window.getEnabledModules() : {};
    const moduleOn = (key) => !Object.prototype.hasOwnProperty.call(modules, key) || !!modules[key];

    const showQuality   = moduleOn('quality') && !hidden.has('quality');
    const showAlerts    = moduleOn('notifications') && !hidden.has('alerts');
    const showHostsMap  = !hidden.has('map');
    const showInfraApps = moduleOn('services') && !hidden.has('services');
    const showInfraAuto = moduleOn('automation') && !hidden.has('scripts');
    const showInfraSync = moduleOn('syncthing') && !hidden.has('syncthing');
    const showInfra     = showInfraApps || showInfraAuto || showInfraSync;

    _cfgSetNavVisible(qualityBtn, showQuality);
    _cfgSetPaneVisible('qualityView', showQuality);

    _cfgSetNavVisible(alertsBtn, showAlerts);
    _cfgSetPaneVisible('alertsView', showAlerts);

    _cfgSetNavVisible(hostsMapBtn, showHostsMap);
    _cfgSetPaneVisible('hostsMapa', showHostsMap);

    _cfgSetNavVisible(infraAppsBtn, showInfraApps);
    _cfgSetPaneVisible('infraApps', showInfraApps);

    _cfgSetNavVisible(infraAutoBtn, showInfraAuto);
    _cfgSetPaneVisible('infraAuto', showInfraAuto);

    _cfgSetNavVisible(infraSyncBtn, showInfraSync);
    _cfgSetPaneVisible('infraSyncthing', showInfraSync);

    _cfgSetNavVisible(infraBtn, showInfra);
    _cfgSetPaneVisible('infraView', showInfra);

    const activeTop = document.querySelector('#viewTabs .nav-link.active');
    if (activeTop && !_cfgNavVisible(activeTop)) {
      _cfgActivateVisibleTab(_cfgFirstVisible([dashboardBtn, hostsBtn, infraBtn, qualityBtn]));
    }

    const activeHostsSub = document.querySelector('#hostsSubTabs .nav-link.active');
    if (activeHostsSub && !_cfgNavVisible(activeHostsSub)) {
      _cfgActivateVisibleTab(_cfgFirstVisible([hostsTableBtn, hostsMapBtn, hostsScansBtn, alertsBtn]));
    }

    const activeInfraSub = document.querySelector('#infraSubTabs .nav-link.active');
    if (activeInfraSub && !_cfgNavVisible(activeInfraSub)) {
      const fallbackInfra = _cfgFirstVisible([infraAppsBtn, infraAutoBtn, infraSyncBtn]);
      if (fallbackInfra) {
        _cfgActivateVisibleTab(fallbackInfra);
      } else if (document.getElementById('infraView')?.classList.contains('active')) {
        _cfgActivateVisibleTab(_cfgFirstVisible([dashboardBtn, hostsBtn, qualityBtn]));
      }
    }

    try { window.moveBubble?.(document.querySelector('#viewTabs .nav-link.active')); } catch (_) {}
  };

  window._applyHiddenTabsFromServer = async function() {
    try {
      const data = await fetch('/api/settings', { cache: 'no-store' }).then(r => r.json());
      const settings = data.settings || {};
      window.applyModuleGating?.(settings.enabled_modules || {});
      const hidden = (settings.hidden_tabs || '')
        .split(',')
        .map(v => String(v || '').trim())
        .filter(Boolean);
      window.applyHiddenTabs?.(hidden);
    } catch (_) {}
  };

  setTimeout(() => { window._applyHiddenTabsFromServer?.(); }, 0);

  // ── I. Nav: moveBubble + tab persistence + subtab routing ────────────────────
  function moveBubble(tabEl) {
    const ul = document.getElementById('viewTabs');
    if (!ul || !tabEl) return;
    const ulRect  = ul.getBoundingClientRect();
    const tabRect = tabEl.getBoundingClientRect();
    const scroll  = ul.scrollLeft || 0;
    let bubble = ul.querySelector('.nav-bubble');
    if (!bubble) {
      bubble = document.createElement('span');
      bubble.className = 'nav-bubble';
      bubble.style.cssText = 'position:absolute;top:4px;height:calc(100% - 8px);border-radius:10px;z-index:0;pointer-events:none;transition:left .32s cubic-bezier(.34,1.56,.64,1),width .32s cubic-bezier(.34,1.56,.64,1),background .3s ease,box-shadow .3s ease';
      ul.insertBefore(bubble, ul.firstChild);
    }
    const accent    = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4dffb5';
    const accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '77,255,181';
    bubble.style.left      = (tabRect.left - ulRect.left + scroll) + 'px';
    bubble.style.width     = tabRect.width + 'px';
    bubble.style.background = accent;
    bubble.style.boxShadow  = `0 0 16px rgba(${accentRgb},.45),0 2px 8px rgba(0,0,0,.3)`;
  }
  window.moveBubble = moveBubble;

  setTimeout(() => { const a = document.querySelector('#viewTabs .nav-link.active'); if (a) moveBubble(a); }, 80);
  document.getElementById('viewTabs')?.addEventListener('click', e => {
    const tab = e.target.closest('.nav-link');
    if (tab) setTimeout(() => moveBubble(tab), 10);
  });

  function _setMainViewsRestoreMask(active) {
    try {
      document.documentElement.classList.toggle('auditor-restore-pending', !!active);
    } catch (_) {}
    ['dashboardView', 'hostsView', 'qualityView', 'infraView', 'alertsView'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (active) {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
      } else {
        el.style.visibility = '';
        el.style.pointerEvents = '';
      }
    });
  }

  function _releaseMainViewsRestoreMask() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        _setMainViewsRestoreMask(false);
      });
    });
  }

  document.addEventListener('shown.bs.tab', e => {
    if (e.target.matches('#viewTabs .nav-link')) {
      moveBubble(e.target);
      const id = e.target.id;
      if (id) localStorage.setItem('auditor-last-tab', id);

      // When infra-tab becomes active, activate its default subtab (Aplicaciones)
      // so services.js loads without needing a manual click
      if (id === 'infra-tab') {
        const savedInfraSub = localStorage.getItem('auditor-last-subtab-infra-tab');
        const targetSubId   = savedInfraSub || 'infra-apps-tab';
        const targetSub     = document.getElementById(targetSubId) || document.getElementById('infra-apps-tab');

        if (targetSub) {
          try { bootstrap.Tab.getOrCreateInstance(targetSub).show(); } catch (_) {}
          targetSub.dispatchEvent(new Event('shown.bs.tab', { bubbles: true }));
          $(targetSub).trigger('shown.bs.tab');
        }
      }

      // Restore saved subtab for Hosts when the main Hosts tab becomes active
      if (id === 'tab-hosts') {
        const savedHostsSub =
          localStorage.getItem('auditor-last-subtab-tab-hosts') ||
          localStorage.getItem('auditor-last-subtab-hosts-tab') ||
          'hosts-tabla-tab';
        const subEl = document.getElementById(savedHostsSub) || document.getElementById('hosts-tabla-tab');
        if (subEl && !subEl.classList.contains('active')) {
          try { bootstrap.Tab.getOrCreateInstance(subEl).show(); } catch (_) {}
        }
      }
    }

    // ── Subtab persistence: save which subtab is active per parent tab ──
    const SUBTAB_PARENT = {
      'hosts-tabla-tab':  'tab-hosts',
      'hosts-mapa-tab':   'tab-hosts',
      'hosts-scans-tab':  'tab-hosts',
      'alerts-tab':       'tab-hosts',
      'infra-apps-tab':   'infra-tab',
      'infra-auto-tab':   'infra-tab',
      'infra-syncthing-tab': 'infra-tab',
    };
    const parentId = SUBTAB_PARENT[e.target.id];
    if (parentId) {
      localStorage.setItem(`auditor-last-subtab-${parentId}`, e.target.id);
      if (parentId === 'tab-hosts') localStorage.setItem('auditor-last-subtab-hosts-tab', e.target.id);
    }

    // ── Subtab routing: fire events on legacy IDs so older modules load ──
    // jQuery .on('shown.bs.tab') needs $.trigger, plain dispatchEvent doesn't work with jQuery
    const SUBTAB_FORWARD = {
      'hosts-mapa-tab':   'map-tab',
      'hosts-scans-tab':  'scans-tab',
      'infra-apps-tab':   'services-tab',
      'infra-auto-tab':   'scripts-tab',
    };
    const fwd = SUBTAB_FORWARD[e.target.id];
    if (fwd) {
      const legacy = document.getElementById(fwd);
      if (legacy) {
        // Fire both DOM event and jQuery event for maximum compatibility
        legacy.dispatchEvent(new Event('shown.bs.tab', { bubbles: true }));
        $(legacy).trigger('shown.bs.tab');
      }
    }
  });

  // Tab persistence
  (function restoreLastTab() {
    try {
      if (localStorage.getItem('auditor-last-tab') === 'alerts-tab') {
        localStorage.setItem('auditor-last-tab', 'tab-hosts');
        localStorage.setItem('auditor-last-subtab-tab-hosts', 'alerts-tab');
        localStorage.setItem('auditor-last-subtab-hosts-tab', 'alerts-tab');
      }
    } catch (_) {}
    const dashTab = document.getElementById('dashboard-tab');
    const forceDashboardOnce = (() => {
	  try {
		return sessionStorage.getItem('auditor-force-dashboard-once') === '1';
	  } catch (_) {
		return false;
	  }
	})();
	const navEntry = performance.getEntriesByType?.('navigation')?.[0];
	const isReload = navEntry
	  ? navEntry.type === 'reload'
	  : (performance.navigation && performance.navigation.type === 1);

    if (isReload) {
      _setMainViewsRestoreMask(true);
      window.setTimeout(() => _setMainViewsRestoreMask(false), 700);
    }

	if (forceDashboardOnce) {
	  try { sessionStorage.removeItem('auditor-force-dashboard-once'); } catch (_) {}
	  if (dashTab && !dashTab.classList.contains('active')) {
		try { bootstrap.Tab.getOrCreateInstance(dashTab).show(); } catch (_) {}
	  }
	  window.syncFiltersBar?.();
      _releaseMainViewsRestoreMask();
	  return;
	}

	if (!isReload) {
	  if (dashTab && !dashTab.classList.contains('active')) {
		try { bootstrap.Tab.getOrCreateInstance(dashTab).show(); } catch (_) {}
	  }
	  window.syncFiltersBar?.();
      _releaseMainViewsRestoreMask();
	  return;
	}

    const legacyMap = {
        'hosts-tab': 'tab-hosts',
        'map-tab': 'tab-hosts',
        'scans-tab': 'tab-hosts',
        'services-tab': 'infra-tab',
        'scripts-tab': 'infra-tab',
        'infra-syncthing-tab': 'infra-tab',
      };
    const savedRaw = localStorage.getItem('auditor-last-tab') || 'dashboard-tab';
    const savedId = legacyMap[savedRaw] || savedRaw;
      if (savedId !== savedRaw) {
        try { localStorage.setItem('auditor-last-tab', savedId); } catch (_) {}
      }
    const tabEl = document.getElementById(savedId);

    if (tabEl && !tabEl.classList.contains('active')) {
      try { bootstrap.Tab.getOrCreateInstance(tabEl).show(); } catch (_) {}
    } else if (!tabEl && dashTab && !dashTab.classList.contains('active')) {
      try { bootstrap.Tab.getOrCreateInstance(dashTab).show(); } catch (_) {}
    }

    window.syncFiltersBar?.();
    _releaseMainViewsRestoreMask();
  })();

  window.addEventListener('resize', () => {
    const a = document.querySelector('#viewTabs .nav-link.active');
    if (a) moveBubble(a);
  });


  // ── J. Prefetch orchestrator ──────────────────────────────────────────────────
  window._prefetch = {};
  (function prefetchAll() {
    [
      { key: 'scripts',   url: '/api/scripts/status'    },
      { key: 'hosts',     url: '/api/hosts'             },
      { key: 'scans',     url: '/api/scans'             },
      { key: 'services',  url: '/api/services'          },
      { key: 'quality',   url: '/api/quality/targets'   },
      { key: 'alerts',    url: '/api/alerts'            },
      { key: 'dashboard', url: '/api/status'            },
    ].forEach(({ key, url }) => {
      fetch(url).then(r => r.ok ? r.json() : null).then(d => { if (d) window._prefetch[key] = d; }).catch(() => {});
    });
  })();


  // ── K. Mobile view toggle ─────────────────────────────────────────────────────
  (function initMobileViewToggle() {
    const btn   = document.getElementById('mobileViewToggle');
    const icon  = document.getElementById('mobileViewIcon');
    const label = document.getElementById('mobileViewLabel');
    const proxyBtn = document.getElementById('mobileViewToggleProxy');
    const proxyIcon = document.getElementById('mobileViewIconProxy');
    const proxyLabel = document.getElementById('mobileViewLabelProxy');
    if (!btn) return;
    const STORAGE_KEY = 'auditor-mobile-view';

    function isHostsTableActive() {
      const hostsMainActive = document.getElementById('hostsView')?.classList.contains('active')
        || document.getElementById('tab-hosts')?.classList.contains('active');
      const hostsTableActive = document.getElementById('hostsTabla')?.classList.contains('active')
        || document.getElementById('hosts-tabla-tab')?.classList.contains('active');
      return !!(hostsMainActive && hostsTableActive);
    }

    function setElementVisible(el, visible) {
      if (!el) return;
      el.hidden = !visible;
      if (visible) el.style.removeProperty('display');
      else el.style.setProperty('display', 'none', 'important');
    }

    function updateToggleVisibility() {
      const visible = isHostsTableActive();
      setElementVisible(btn, visible);
      setElementVisible(proxyBtn, visible);
    }

    function syncProxy() {
      if (!proxyBtn || !proxyIcon || !proxyLabel || !icon || !label) {
        updateToggleVisibility();
        return;
      }
      proxyIcon.className = icon.className || 'bi bi-table';
      proxyLabel.textContent = label.textContent || 'Tabla';
      proxyBtn.classList.toggle('btn-info', btn.classList.contains('btn-info'));
      updateToggleVisibility();
    }

    function applyMobileView(mode, animate) {
      if (mode === 'table') {
        document.body.classList.add('mobile-table-view');
        icon.className = 'bi bi-grid-3x3-gap';
        label.textContent = window.t?.('common.cards', 'Fichas') || 'Fichas';
        if (animate) btn.classList.add('btn-info'); else btn.classList.remove('btn-info');
      } else {
        document.body.classList.remove('mobile-table-view');
        icon.className = 'bi bi-table';
        label.textContent = window.t?.('common.table', 'Tabla') || 'Tabla';
        btn.classList.remove('btn-info');
      }
      syncProxy();
      setTimeout(() => {
        try { hostsTable?.columns.adjust(); } catch (_) {}
      }, 50);
    }

    applyMobileView(localStorage.getItem(STORAGE_KEY) || 'card', false);
    btn.addEventListener('click', function () {
      const cur  = document.body.classList.contains('mobile-table-view') ? 'table' : 'card';
      const next = cur === 'card' ? 'table' : 'card';
      applyMobileView(next, true);
      localStorage.setItem(STORAGE_KEY, next);
    });

    proxyBtn?.addEventListener('click', function () {
      btn.click();
    });

    document.addEventListener('shown.bs.tab', function () {
      updateToggleVisibility();
    });

    window.addEventListener('resize', updateToggleVisibility);
    updateToggleVisibility();
  })();






  (function initMobileHeaderStack() {
    const bannerWrap = document.querySelector('.site-banner-wrap');
    const toolbar = document.querySelector('.site-banner-toolbar');
    const mobileNav = document.getElementById('mobilePrimaryNavCard');
    if (!bannerWrap || !toolbar || !mobileNav) return;

    let stack = document.getElementById('mobileHeaderStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'mobileHeaderStack';
      bannerWrap.insertAdjacentElement('afterend', stack);
    }

    if (!toolbar.__homeMarker) {
      const marker = document.createComment('site-banner-toolbar-home');
      toolbar.parentNode.insertBefore(marker, toolbar);
      toolbar.__homeMarker = marker;
    }

    if (!mobileNav.__homeMarker) {
      const marker = document.createComment('mobile-primary-nav-home');
      mobileNav.parentNode.insertBefore(marker, mobileNav);
      mobileNav.__homeMarker = marker;
    }

    function applyMobileHeaderStack() {
      const isMobile = window.matchMedia('(max-width: 768px)').matches;

      if (isMobile) {
        if (toolbar.parentNode !== stack) stack.appendChild(toolbar);
        if (mobileNav.parentNode !== stack) stack.appendChild(mobileNav);
        toolbar.classList.add('mobile-toolbar-detached');
      } else {
        const toolbarHome = toolbar.__homeMarker;
        const navHome = mobileNav.__homeMarker;

        if (toolbarHome?.parentNode && toolbar.parentNode !== toolbarHome.parentNode) {
          toolbarHome.parentNode.insertBefore(toolbar, toolbarHome.nextSibling);
        }
        if (navHome?.parentNode && mobileNav.parentNode !== navHome.parentNode) {
          navHome.parentNode.insertBefore(mobileNav, navHome.nextSibling);
        }
        toolbar.classList.remove('mobile-toolbar-detached');
      }
    }

    applyMobileHeaderStack();
    window.addEventListener('resize', applyMobileHeaderStack);
    window.addEventListener('orientationchange', applyMobileHeaderStack);
  })();

  (function initMobilePrimaryNav() {
    const menuBtn = document.getElementById('mobileSectionMenuBtn');
    const menuIcon = document.getElementById('mobileSectionMenuIcon');
    const menuLabel = document.getElementById('mobileSectionMenuLabel');
    const dailyProxy = document.getElementById('mobileDailyReportProxy');
    const dailyReal = document.getElementById('sp-btn-daily-report');
    if (!menuBtn || !menuIcon || !menuLabel) return;

    const mobileTabs = {
      'dashboard-tab': { icon: 'bi-speedometer2', labelKey: 'tab.dashboard', fallback: 'Dashboard' },
      'tab-hosts':     { icon: 'bi-hdd-network',  labelKey: 'tab.hosts', fallback: 'Hosts' },
      'infra-tab':     { icon: 'bi-server',       labelKey: 'tab.infrastructure', fallback: 'Infraestructura' },
      'quality-tab':   { icon: 'bi-wifi',         labelKey: 'tab.quality', fallback: 'Calidad' },
    };

    function syncMobilePrimaryNav() {
      const active = document.querySelector('#viewTabs .nav-link.active');
      const cfg = mobileTabs[active?.id] || mobileTabs['dashboard-tab'];
      menuIcon.className = `bi ${cfg.icon}`;
      menuLabel.textContent = window.t ? window.t(cfg.labelKey) : cfg.fallback;
      document.querySelectorAll('.mobile-section-item').forEach(item => {
        item.classList.toggle('active', item.dataset.mobileTabTarget === active?.id);
      });
    }

    document.querySelectorAll('.mobile-section-item').forEach(item => {
      item.addEventListener('click', function () {
        const targetId = this.dataset.mobileTabTarget;
        const realTab = targetId ? document.getElementById(targetId) : null;
        if (realTab) {
          try { bootstrap.Tab.getOrCreateInstance(realTab).show(); } catch (_) {}
        }
        try { bootstrap.Dropdown.getOrCreateInstance(menuBtn).hide(); } catch (_) {}
      });
    });

    dailyProxy?.addEventListener('click', function () {
      dailyReal?.click();
    });

    document.addEventListener('shown.bs.tab', function (e) {
      if (e.target?.matches?.('#viewTabs .nav-link')) {
        window.setTimeout(syncMobilePrimaryNav, 10);
      }
    });

    document.addEventListener('langchange', function () {
      window.setTimeout(syncMobilePrimaryNav, 10);
    });

    window.setTimeout(syncMobilePrimaryNav, 0);
  })();

  // ── L. Hosts visual views: mapa / grupos / por red ───────────────────────────
  function _hostStatusBucket(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'online' || st === 'online_silent') return 'online';
    if (st === 'offline') return 'offline';
    return 'unknown';
  }

  function _hostNodeColor(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'online') return cssVar('--accent') || '#4dffb5';
    if (st === 'online_silent') return '#ffc107';
    if (st === 'offline') return '#ff6b6b';
    return '#888';
  }

  function _hostStatusLabelShort(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'online') return 'Online';
    if (st === 'online_silent') return 'Silent';
    if (st === 'offline') return 'Offline';
    return 'Desconocido';
  }

  async function _ensureHostsDataset() {
    if (Array.isArray(window._hostsData)) return window._hostsData;
    try {
      const data = await fetch('/api/hosts', { cache: 'no-store' }).then(r => r.json());
      if (data?.ok && Array.isArray(data.hosts)) {
        window._hostsData = data.hosts;
        return window._hostsData;
      }
    } catch (_) {}
    return [];
  }

  let _mapNodes = [];
  let _mapGroups = [];
  let _mapDragging = null;
  let _mapOffset = { x: 0, y: 0 };
  let _mapScale = 1;
  let _mapPan = { x: 0, y: 0 };
  let _mapPanning = false;
  let _mapPanStart = { x: 0, y: 0 };
  let _mapPanOrigin = { x: 0, y: 0 };
  let _mapFilter = 'all';
  let _mapGroupBy = 'flat';

  function _mapVisibleNodes() {
    return _mapNodes.filter(node => {
      if (_mapFilter === 'all') return true;
      if (_mapFilter === 'online') return _hostStatusBucket(node.status) === 'online';
      if (_mapFilter === 'offline') return _hostStatusBucket(node.status) === 'offline';
      return String(node.status || '').toLowerCase() === _mapFilter;
    });
  }

  function renderMap() {
    const canvas = document.getElementById('networkCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = Math.max(canvas.offsetWidth || 0, 320);
    const height = Math.max(520, Math.round(width * 0.55));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const dark = !document.body.classList.contains('light-mode');
    const bgColor = dark ? '#1a1f26' : '#f5f5f5';
    const lineColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = dark ? 'rgba(255,255,255,0.85)' : '#333';
    const subColor = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    const groupColor = dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(_mapPan.x, _mapPan.y);
    ctx.scale(_mapScale, _mapScale);

    const visibleNodes = _mapVisibleNodes();

    if (_mapGroups.length) {
      _mapGroups.forEach(group => {
        const nodes = visibleNodes.filter(node => group.members.includes(node.ip));
        if (!nodes.length) return;
        const xs = nodes.map(node => node.x);
        const ys = nodes.map(node => node.y);
        const pad = 40;
        const gx = Math.min(...xs) - pad;
        const gy = Math.min(...ys) - pad;
        const gw = Math.max(...xs) - Math.min(...xs) + pad * 2;
        const gh = Math.max(...ys) - Math.min(...ys) + pad * 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(gx, gy, gw, gh, 14);
        else ctx.rect(gx, gy, gw, gh);
        ctx.fillStyle = groupColor;
        ctx.fill();
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = subColor;
        ctx.fillText(group.label, gx + 8, gy + 14);
      });
    }

    const cx = (width / 2) / _mapScale;
    const cy = (height / 2) / _mapScale;

    visibleNodes.forEach(node => {
      const bucket = _hostStatusBucket(node.status);
      const nodeColor = _hostNodeColor(node.status);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(node.x, node.y);
      ctx.strokeStyle = bucket === 'online' ? accentColor(0.16) : lineColor;
      ctx.lineWidth = bucket === 'online' ? 1.5 : 1;
      ctx.setLineDash(bucket === 'offline' ? [4, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.fillStyle = dark ? '#2a3040' : '#ddd';
    ctx.fill();
    ctx.strokeStyle = cssVar('--accent') || '#4dffb5';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🌐', cx, cy + 6);
    ctx.font = '9px sans-serif';
    ctx.fillStyle = subColor;
    ctx.fillText('Gateway', cx, cy + 36);

    visibleNodes.forEach(node => {
      const radius = 20;
      const nodeColor = _hostNodeColor(node.status);
      const bucket = _hostStatusBucket(node.status);

      if (String(node.status || '').toLowerCase() === 'online') {
        ctx.shadowColor = nodeColor;
        ctx.shadowBlur = 8;
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `${nodeColor}22`;
      ctx.fill();
      ctx.strokeStyle = nodeColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (bucket === 'online' && node.latency != null) {
        const latencyText = `${Math.round(Number(node.latency))}ms`;
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = nodeColor;
        ctx.fillText(latencyText, node.x, node.y - radius - 4);
      }

      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = textColor;
      ctx.fillText(node.icon || '💻', node.x, node.y + 5);

      const label = node.name || node.ip;
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = textColor;
      ctx.fillText(label.length > 14 ? `${label.slice(0, 13)}…` : label, node.x, node.y + radius + 14);

      const sub = node.vendor || node.ip;
      if (sub && sub !== label) {
        ctx.font = '8px sans-serif';
        ctx.fillStyle = subColor;
        const shortSub = sub.length > 14 ? `${sub.slice(0, 13)}…` : sub;
        ctx.fillText(shortSub, node.x, node.y + radius + 24);
      }
    });

    ctx.restore();

    const onlineCount = visibleNodes.filter(node => _hostStatusBucket(node.status) === 'online').length;
    const offlineCount = visibleNodes.filter(node => _hostStatusBucket(node.status) === 'offline').length;
    const statsEl = document.getElementById('mapStats');
    if (statsEl) statsEl.textContent = window.t?.('host.table_stats', '{online} online · {offline} offline · Total: {total}', { online: onlineCount, offline: offlineCount, total: visibleNodes.length }) || `${onlineCount} online · ${offlineCount} offline · Total: ${visibleNodes.length}`;
  }

  function layoutMapNodes(hosts = []) {
    const canvas = document.getElementById('networkCanvas');
    if (!canvas) return;
    const width = canvas.offsetWidth || 800;
    const height = Math.max(520, Math.round(width * 0.55));
    const cx = width / 2;
    const cy = height / 2;
    const makeNode = host => ({
      ip: host.ip,
      status: host.status,
      mac: host.mac,
      vendor: host.vendor || '',
      latency: host.last_latency_ms,
      name: host.manual_name || host.nmap_hostname || host.router_hostname || host.dns_name || host.ip,
      icon: host.type_icon || '💻',
      x: cx,
      y: cy,
    });

    _mapGroups = [];

    if (_mapGroupBy === 'subnet') {
      const buckets = {};
      hosts.forEach(host => {
        const parts = String(host.ip || '').split('.');
        const key = parts.length >= 3 ? `${parts.slice(0, 3).join('.')}.0/24` : (host.ip || 'sin-subred');
        (buckets[key] ||= []).push(host);
      });

      const keys = Object.keys(buckets);
      const groupCount = Math.max(1, keys.length);
      const nodes = [];
      keys.forEach((key, groupIndex) => {
        const groupHosts = buckets[key];
        const angle = (groupIndex / groupCount) * Math.PI * 2 - Math.PI / 2;
        const groupRadius = Math.min(width, height) * 0.3;
        const groupCx = cx + Math.cos(angle) * groupRadius;
        const groupCy = cy + Math.sin(angle) * groupRadius;
        const members = [];
        groupHosts.forEach((host, idx) => {
          const nodeAngle = (idx / Math.max(1, groupHosts.length)) * Math.PI * 2;
          const radius = groupHosts.length === 1 ? 0 : Math.max(40, groupHosts.length * 12);
          const node = makeNode(host);
          node.x = groupCx + Math.cos(nodeAngle) * radius;
          node.y = groupCy + Math.sin(nodeAngle) * radius;
          nodes.push(node);
          members.push(host.ip);
        });
        _mapGroups.push({ label: key, members });
      });
      _mapNodes = nodes;
      return;
    }

    if (_mapGroupBy === 'type') {
      const buckets = {};
      hosts.forEach(host => {
        const key = host.type_name || 'Sin tipo';
        (buckets[key] ||= []).push(host);
      });

      const keys = Object.keys(buckets);
      const groupCount = Math.max(1, keys.length);
      const nodes = [];
      keys.forEach((key, groupIndex) => {
        const groupHosts = buckets[key];
        const angle = (groupIndex / groupCount) * Math.PI * 2 - Math.PI / 2;
        const groupRadius = Math.min(width, height) * 0.3;
        const groupCx = cx + Math.cos(angle) * groupRadius;
        const groupCy = cy + Math.sin(angle) * groupRadius;
        const members = [];
        groupHosts.forEach((host, idx) => {
          const nodeAngle = (idx / Math.max(1, groupHosts.length)) * Math.PI * 2;
          const radius = groupHosts.length === 1 ? 0 : Math.max(40, groupHosts.length * 12);
          const node = makeNode(host);
          node.x = groupCx + Math.cos(nodeAngle) * radius;
          node.y = groupCy + Math.sin(nodeAngle) * radius;
          nodes.push(node);
          members.push(host.ip);
        });
        _mapGroups.push({ label: key, members });
      });
      _mapNodes = nodes;
      return;
    }

    const total = Math.max(1, hosts.length);
    const radius = Math.min(width, height) * 0.35;
    _mapNodes = hosts.map((host, idx) => {
      const node = makeNode(host);
      const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;
      node.x = cx + Math.cos(angle) * radius;
      node.y = cy + Math.sin(angle) * radius;
      return node;
    });
  }

  window.loadMap = async function loadMap() {
    const hostsData = await _ensureHostsDataset();
    layoutMapNodes(Array.isArray(hostsData) ? hostsData : []);
    renderMap();
  };

  function _mapCanvasEl() {
    return document.getElementById('networkCanvas');
  }

  function _getMapCoords(evt) {
    const canvas = _mapCanvasEl();
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left - _mapPan.x) / _mapScale,
      y: (evt.clientY - rect.top - _mapPan.y) / _mapScale,
    };
  }

  $(document).on('mousedown', '#networkCanvas', function (evt) {
    const pos = _getMapCoords(evt);
    const hit = _mapNodes.find(node => {
      const dx = node.x - pos.x;
      const dy = node.y - pos.y;
      return Math.sqrt((dx * dx) + (dy * dy)) < 22;
    });
    if (hit) {
      _mapDragging = hit;
      _mapOffset = { x: pos.x - hit.x, y: pos.y - hit.y };
      return;
    }
    _mapPanning = true;
    _mapPanStart = { x: evt.clientX, y: evt.clientY };
    _mapPanOrigin = { ..._mapPan };
  });

  $(document).on('mousemove', function (evt) {
    if (_mapDragging) {
      const pos = _getMapCoords(evt);
      _mapDragging.x = pos.x - _mapOffset.x;
      _mapDragging.y = pos.y - _mapOffset.y;
      renderMap();
    } else if (_mapPanning) {
      _mapPan.x = _mapPanOrigin.x + (evt.clientX - _mapPanStart.x);
      _mapPan.y = _mapPanOrigin.y + (evt.clientY - _mapPanStart.y);
      renderMap();
    }
  });

  $(document).on('mouseup', function () {
    _mapDragging = null;
    _mapPanning = false;
  });

  $(document).on('wheel', '#networkCanvas', function (evt) {
    evt.preventDefault();
    const delta = evt.originalEvent.deltaY > 0 ? 0.9 : 1.1;
    _mapScale = Math.min(4, Math.max(0.3, _mapScale * delta));
    renderMap();
  });

  $(document).on('click', '#networkCanvas', function (evt) {
    if (_mapDragging) return;
    const pos = _getMapCoords(evt);
    const hit = _mapNodes.find(node => {
      const dx = node.x - pos.x;
      const dy = node.y - pos.y;
      return Math.sqrt((dx * dx) + (dy * dy)) < 22;
    });
    if (hit?.ip) openHost(hit.ip);
  });

  $(document).on('change', '#mapFilter', function () {
    _mapFilter = $(this).val() || 'all';
    renderMap();
  });

  $(document).on('change', '#mapGroupBy', function () {
    _mapGroupBy = $(this).val() || 'flat';
    window.loadMap?.();
  });

  $(document).on('click', '#mapReset', function () {
    _mapScale = 1;
    _mapPan = { x: 0, y: 0 };
    window.loadMap?.();
  });

  document.getElementById('map-tab')?.addEventListener('shown.bs.tab', () => {
    window.loadMap?.();
  });

  if (document.getElementById('hosts-mapa-tab')?.classList.contains('active')) {
    window.loadMap?.();
  }

  let _splitByNet = false;

  function _applyFiltersToHosts(hostsData) {
    const text = ($('#hostFilter').val() || '').trim().toLowerCase();
    const type = ($('#typeFilter').val() || '').trim().toLowerCase();
    const showOnlyUnknown = !!window.showOnlyUnknown;

    return (Array.isArray(hostsData) ? hostsData : []).filter(host => {
      if (statusFilter) {
        const bucket = _hostStatusBucket(host.status);
        if (bucket !== statusFilter) return false;
      }
      if (_networkFilter) {
        const [, cidr] = String(_networkFilter || '').split(':');
        if (cidr && !_ipInCidr(host.ip, cidr)) return false;
      }
      if (type && String(host.type_name || '').trim().toLowerCase() !== type) return false;
      if (showOnlyUnknown && !_isPendingKnownValidation(host)) return false;
      if (text) {
        const haystack = [host.ip, host.mac, host.manual_name, host.nmap_hostname, host.router_hostname, host.dns_name, host.vendor, host.type_name]
          .filter(Boolean)
          .map(value => String(value).toLowerCase());
        if (!haystack.some(value => value.includes(text))) return false;
      }
      return true;
    });
  }

  function _buildNetSections(hostsData) {
    const allNets = [
      ...((window._primaryNetworks || []).map(net => ({ ...net, _type: 'primary' }))),
      ...((window._secondaryNetworks || []).map(net => ({ ...net, _type: 'secondary' }))),
    ];

    if (!allNets.length) {
      return '<div class="small-muted p-3">No hay redes configuradas. Añádelas en Config → Redes.</div>';
    }

    const buckets = {};
    const unassigned = [];
    allNets.forEach(net => { buckets[net.cidr] = { net, hosts: [] }; });

    hostsData.forEach(host => {
      let assigned = false;
      allNets.forEach(net => {
        if (!assigned && net.cidr && _ipInCidr(host.ip, net.cidr)) {
          buckets[net.cidr].hosts.push(host);
          assigned = true;
        }
      });
      if (!assigned) unassigned.push(host);
    });

    let html = '';
    allNets.forEach(net => {
      const bucket = buckets[net.cidr];
      const hosts = bucket.hosts;
      const online = hosts.filter(host => _hostStatusBucket(host.status) === 'online').length;
      const accent = net._type === 'primary' ? 'var(--accent)' : '#74b9ff';
      const icon = net._type === 'primary'
        ? '<i class="bi bi-house-fill me-2" style="font-size:.85rem"></i>'
        : '<i class="bi bi-diagram-3-fill me-2" style="font-size:.85rem"></i>';

      html += `<div class="mb-4">
        <div class="d-flex align-items-center gap-2 mb-2 px-1" style="border-left:3px solid ${accent};padding-left:8px!important">
          <span style="color:${accent};font-weight:600;font-size:.9rem">${icon}${esc(net.label || net.cidr)}</span>
          <code style="font-size:.72rem;opacity:.55">${esc(net.cidr)}</code>
          <span class="badge ms-1" style="background:${accent}22;color:${accent};font-size:.7rem">${online} online / ${hosts.length} total</span>
          <div class="ms-auto" style="width:80px;height:5px;background:rgba(255,255,255,0.08);border-radius:3px">
            <div style="width:${hosts.length ? Math.round((online / hosts.length) * 100) : 0}%;height:100%;background:${accent};border-radius:3px;transition:width .3s"></div>
          </div>
        </div>`;

      if (!hosts.length) {
        html += `<div class="small-muted px-3 py-2" style="font-size:.78rem;opacity:.5"><i class="bi bi-inbox me-1"></i>Sin hosts detectados en esta red</div>`;
      } else {
        const sorted = [...hosts].sort((a, b) => {
          const sa = _hostStatusBucket(a.status) === 'online' ? 0 : 1;
          const sb = _hostStatusBucket(b.status) === 'online' ? 0 : 1;
          if (sa !== sb) return sa - sb;
          return String(a.ip || '').localeCompare(String(b.ip || ''), undefined, { numeric: true });
        });
        html += `<div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0" style="font-size:.78rem">
            <thead style="opacity:.6">
              <tr>
                <th style="width:16px"></th>
                <th>IP</th>
                <th>Nombre</th>
                <th>MAC</th>
                <th>Fabricante</th>
                <th>Estado</th>
                <th>Visto</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(host => {
                const status = String(host.status || 'unknown').toLowerCase();
                const online = _hostStatusBucket(status) === 'online';
                const silent = status === 'online_silent';
                const dot = online
                  ? `<span style="color:${silent ? '#ffc107' : '#4dffb5'};font-size:.9rem">●</span>`
                  : (status === 'offline'
                      ? '<span style="color:#ff6b6b;font-size:.9rem">●</span>'
                      : '<span style="color:#888;font-size:.9rem">●</span>');
                const badge = online
                  ? `<span class="badge" style="background:rgba(77,255,181,0.15);color:${silent ? '#ffc107' : '#4dffb5'};font-size:.68rem">${silent ? 'silent' : 'online'}</span>`
                  : (status === 'offline'
                      ? '<span class="badge bg-secondary" style="font-size:.68rem">offline</span>'
                      : '<span class="badge bg-dark" style="font-size:.68rem">desconocido</span>');
                return `<tr class="net-host-row" data-ip="${esc(host.ip)}" style="cursor:pointer">
                  <td>${dot}</td>
                  <td class="mono" style="font-size:.75rem">${esc(host.ip)}</td>
                  <td>${esc(host.manual_name || host.nmap_hostname || host.router_hostname || host.dns_name || '—')}</td>
                  <td class="mono" style="font-size:.7rem;opacity:.7">${esc(host.mac || '—')}</td>
                  <td style="opacity:.6">${esc(host.vendor || '—')}</td>
                  <td>${badge}</td>
                  <td style="opacity:.55;font-size:.72rem">${esc(host.seen_ago || '—')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
      }
      html += '</div>';
    });

    if (unassigned.length) {
      html += `<div class="mb-4">
        <div class="d-flex align-items-center gap-2 mb-2 px-1" style="border-left:3px solid rgba(255,255,255,0.2);padding-left:8px!important">
          <span style="color:rgba(255,255,255,0.45);font-weight:600;font-size:.9rem"><i class="bi bi-question-circle me-2"></i>Sin red asignada</span>
          <span class="badge ms-1" style="background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-size:.7rem">${unassigned.length} hosts</span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0" style="font-size:.78rem">
            <tbody>
              ${unassigned.map(host => {
                const online = _hostStatusBucket(host.status) === 'online';
                const dot = online ? '<span style="color:#4dffb5">●</span>' : '<span style="color:#ff6b6b">●</span>';
                return `<tr class="net-host-row" data-ip="${esc(host.ip)}" style="cursor:pointer">
                  <td>${dot}</td>
                  <td class="mono" style="font-size:.75rem">${esc(host.ip)}</td>
                  <td>${esc(host.manual_name || host.nmap_hostname || host.router_hostname || host.dns_name || '—')}</td>
                  <td class="mono" style="font-size:.7rem;opacity:.7">${esc(host.mac || '—')}</td>
                  <td style="opacity:.6">${esc(host.vendor || '—')}</td>
                  <td></td>
                  <td style="opacity:.55;font-size:.72rem">${esc(host.seen_ago || '—')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }

    return html;
  }

  function _applySplitByNet() {
    const container = $('#hostsByNetContainer');
    const tableWrap = $('#hostsTableWrap');
    const btn = $('#splitByNetBtn');

    if (!container.length || !tableWrap.length || !btn.length) return;

    const allNets = [...(window._primaryNetworks || []), ...(window._secondaryNetworks || [])];
    if (_splitByNet && allNets.length > 0) {
      const hostsData = _applyFiltersToHosts(window._hostsData || []);
      container.html(_buildNetSections(hostsData)).show();
      tableWrap.hide();
      btn.addClass('active btn-info').removeClass('btn-outline-secondary');
    } else {
      container.hide().html('');
      tableWrap.show();
      btn.removeClass('active btn-info').addClass('btn-outline-secondary');
    }
  }

  function _initSplitByNetBtn() {
    const allNets = [...(window._primaryNetworks || []), ...(window._secondaryNetworks || [])];
    if (allNets.length > 1) $('#splitByNetBtn').show();
  }

  _initSplitByNetBtn();

  $(document).on('click', '#splitByNetBtn', function () {
    _splitByNet = !_splitByNet;
    _applySplitByNet();
    localStorage.setItem('auditor-split-by-net', _splitByNet ? '1' : '0');
  });

  if (localStorage.getItem('auditor-split-by-net') === '1') {
    _splitByNet = true;
    setTimeout(_applySplitByNet, 300);
  }

  $(document).on('click', '.net-host-row', function () {
    const ip = $(this).data('ip');
    if (ip) openHost(ip);
  });

  window._refreshSplitByNet = function () {
    if (_splitByNet) _applySplitByNet();
  };

  window._refreshHostsVisualViews = function () {
    if (document.getElementById('hostsMapa')?.classList.contains('show')) window.loadMap?.();
  };

  window.addEventListener('resize', () => {
    if (document.getElementById('hostsMapa')?.classList.contains('show')) renderMap();
  });


  // ── L. Host detail modal (host-detail-history-ux) ─────────────────────────────
  let _hostUptimeDays = 7;
  let _hostUptimeView = 'table';
  let _hostStateChanges = [];
  let _hostTimelineRange = 'day';
  let _hostShowAllIntervals = false;
  let _hostUptimeChart = null;
  let _hostTimelineChart = null;
  let _hostLatencyChart = null;

  function _hostLocale() {
    try {
      if (typeof window.getLocale === 'function') return window.getLocale();
      return document.documentElement?.getAttribute('lang') || navigator.language || undefined;
    } catch (_) {
      return undefined;
    }
  }

  function _hostTimeZone() {
    try {
      if (typeof window.getTimeZone === 'function') return window.getTimeZone();
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch (_) {
      return undefined;
    }
  }

  function _hostFmtIntl(value, options = {}, dateOnly = false) {
    if (value == null || value === '') return '—';
    try {
      const raw = String(value).trim();
      const num = typeof value === 'number' ? value : Number(raw);
      const parsed = Number.isFinite(num) && raw !== ''
        ? new Date(num)
        : (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(raw)
            ? new Date(`${raw}T12:00:00Z`)
            : new Date(raw));
      if (Number.isNaN(parsed.getTime())) return raw || '—';
      return new Intl.DateTimeFormat(_hostLocale(), Object.assign({
        timeZone: _hostTimeZone(),
      }, options || {})).format(parsed);
    } catch (_) {
      return value || '—';
    }
  }

  function _hostFmtDateTime(iso) {
    return _hostFmtIntl(iso, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function _hostFmtTime(iso) {
    return _hostFmtIntl(iso, {
      hour: '2-digit', minute: '2-digit'
    });
  }

  function _hostFmtDateShort(iso) {
    return _hostFmtIntl(iso, {
      day: '2-digit', month: '2-digit'
    }, true);
  }

  function _hostFmtDateLabel(iso) {
    return _hostFmtIntl(iso, {
      year: 'numeric', month: '2-digit', day: '2-digit'
    }, true);
  }

  function _hostFmtDateTimeCompact(iso) {
    return _hostFmtIntl(iso, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function _hostT(key, fallback = '') {
    try {
      if (typeof window.t === 'function') {
        const val = window.t(key);
        if (val && val !== key) return val;
      }
    } catch (_) {}
    return fallback || key;
  }

  function _hostBoolLabel(value) {
    return value ? _hostT('common.yes', 'Yes') : _hostT('common.no', 'No');
  }

  function _timelineStepMs(range, date = '') {
    if (date || range === 'day') return 60 * 60 * 1000;
    if (range === 'week') return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
  }

  function _timelineStepLabel(range, date = '') {
    if (date || range === 'day') return '1h';
    if (range === 'week') return '6h';
    return '1 día';
  }

  function _timelineRangeContext(range, date, firstIso, lastIso) {
    if (date) return `${_hostT('host.timeline_day_prefix', 'Day')} ${_hostFmtDateLabel(date)}`;
    if (!firstIso || !lastIso) {
      return range === 'week'
        ? _hostT('host.last_7d', 'Last 7 days')
        : (range === 'month' ? _hostT('host.last_30d', 'Last 30 days') : _hostT('host.last_24h', 'Last 24h'));
    }
    if (range === 'day') return `${_hostT('host.last_24h', 'Last 24h')} · ${_hostFmtDateLabel(firstIso)}`;
    if (range === 'week') return `${_hostFmtDateShort(firstIso)} → ${_hostFmtDateShort(lastIso)}`;
    return `${_hostFmtDateShort(firstIso)} → ${_hostFmtDateShort(lastIso)}`;
  }

  function _timelineAxisLabel(iso, range, includeDate = false) {
    if (!iso) return '—';
    if (includeDate || range !== 'day') return _hostFmtDateTimeCompact(iso);
    return _hostFmtTime(iso);
  }

  function _timelineStatusLabel(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'online') return _hostT('status.online', 'Online');
    if (st === 'online_silent') return _hostT('host.status_silent', 'Silent');
    if (st === 'offline') return _hostT('status.offline', 'Offline');
    return _hostT('status.unknown', 'Unknown');
  }

  function _renderTimelineAxis(segments, range, date = '') {
    const axisEl = document.getElementById('mTimelineAxis');
    if (!axisEl) return;
    if (!Array.isArray(segments) || !segments.length) {
      axisEl.innerHTML = '';
      return;
    }
    const stepMs = _timelineStepMs(range, date);
    const firstMs = new Date(segments[0]?.time || '').getTime();
    const lastStartMs = new Date(segments[segments.length - 1]?.time || '').getTime();
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastStartMs)) {
      axisEl.innerHTML = '';
      return;
    }
    const lastEndMs = lastStartMs + stepMs;
    const midMs = firstMs + Math.max(stepMs, Math.round((lastEndMs - firstMs) / 2));
    const context = _timelineRangeContext(range, date, firstMs, lastEndMs - 60000);
    const startLabel = _timelineAxisLabel(firstMs, range, !!date);
    const midLabel = _timelineAxisLabel(midMs, range, range !== 'day' || !!date);
    const endLabel = _timelineAxisLabel(lastEndMs - 60000, range, range !== 'day' || !!date);
    axisEl.innerHTML = `
      <div class="host-timeline-axis-start">
        <strong>${esc(startLabel)}</strong>
        <span>${esc(_hostT('host.timeline_start', 'start'))}</span>
      </div>
      <div class="host-timeline-axis-mid">
        <strong>${esc(midLabel)}</strong>
        <span>${esc(context)}</span>
      </div>
      <div class="host-timeline-axis-end">
        <strong>${esc(endLabel)}</strong>
        <span>${esc(_hostT('host.timeline_end', 'end'))}</span>
      </div>
    `;
  }

  function _hideTimelineTooltip() {
    const tooltip = document.getElementById('mTimelineTooltip');
    if (!tooltip) return;
    tooltip.classList.remove('is-visible');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  function _showTimelineTooltip(target, evt) {
    const tooltip = document.getElementById('mTimelineTooltip');
    const wrap = target?.closest('.host-timeline-wrap');
    const tip = target?.dataset?.tip || '';
    if (!tooltip || !wrap || !tip) return;
    tooltip.innerHTML = tip;
    tooltip.classList.add('is-visible');
    tooltip.setAttribute('aria-hidden', 'false');
    _moveTimelineTooltip(target, evt);
  }

  function _moveTimelineTooltip(target, evt) {
    const tooltip = document.getElementById('mTimelineTooltip');
    const wrap = target?.closest('.host-timeline-wrap');
    if (!tooltip || !wrap || !tooltip.classList.contains('is-visible')) return;
    const wrapRect = wrap.getBoundingClientRect();
    const segRect = target.getBoundingClientRect();
    const preferredX = evt?.clientX
      ? evt.clientX - wrapRect.left
      : (segRect.left - wrapRect.left + (segRect.width / 2));
    const tooltipWidth = tooltip.offsetWidth || 180;
    const minX = tooltipWidth / 2 + 8;
    const maxX = Math.max(minX, wrapRect.width - tooltipWidth / 2 - 8);
    const x = Math.min(maxX, Math.max(minX, preferredX));
    const y = Math.max(8, segRect.top - wrapRect.top - 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function _hostFmtDurationMs(startIso, endIso) {
    if (!startIso) return '—';
    try {
      const start = new Date(startIso).getTime();
      const end = endIso ? new Date(endIso).getTime() : Date.now();
      const diffMs = Math.max(0, end - start);
      const totalMin = Math.round(diffMs / 60000);
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      if (days) return `${days}d ${hours}h`;
      if (hours) return `${hours}h ${mins}m`;
      return `${mins}m`;
    } catch (_) {
      return '—';
    }
  }

  function _hostFmtSeenAgo(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '—';
    if (raw === '0s' || raw === '0m') return _hostT('host.relative_just_now', 'just now');

    const m = raw.match(/^(\d+)([smhd])$/);
    if (!m) return value || '—';

    const n = m[1];
    const unit = m[2];
    const key = unit === 's'
      ? 'host.relative_seconds_ago'
      : (unit === 'm'
          ? 'host.relative_minutes_ago'
          : (unit === 'h' ? 'host.relative_hours_ago' : 'host.relative_days_ago'));

    return _hostT(key, '{n} ago').replace('{n}', n);
  }

  function _hostStatusTone(status) {
    const st = String(status || 'offline').toLowerCase();
    if (st === 'online') return { badge: 'bg-success', text: _hostT('status.online', 'Online') };
    if (st === 'online_silent') return { badge: 'bg-warning text-dark', text: _hostT('host.status_silent', 'Silent') };
    return { badge: 'bg-secondary', text: _hostT('status.offline', 'Offline') };
  }

  function _normalizeAvailStatus(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'online' || st === 'online_silent') return 'online';
    if (st === 'offline') return 'offline';
    return 'unknown';
  }

  function _deviceConfidencePct(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1.5 ? Math.max(0, Math.min(100, n)) : Math.max(0, Math.min(100, n * 100));
  }

  function _deviceEvidenceItems(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.map(item => {
      if (item && typeof item === 'object') {
        const label = item.label || item.title || item.kind || item.type || item.source || '';
        const value = item.value || item.detail || item.text || item.reason || item.summary || '';
        const score = _deviceConfidencePct(item.score ?? item.confidence ?? item.weight);
        const parts = [label, value].filter(Boolean);
        const txt = parts.join(': ');
        return score != null ? `${txt || _hostT('host.signal', 'Signal')} · ${Math.round(score)}%` : (txt || JSON.stringify(item));
      }
      return String(item || '').trim();
    }).filter(Boolean).slice(0, 6);
  }

  function _hostEventTypeLabel(eventType, newValue) {
    const et = String(eventType || '').toLowerCase();
    const nv = String(newValue || '');
    if (et === 'new') return _hostT('host.new', 'New');
    if (et === 'new_silent') return _hostT('host.status_silent', 'Silent');
    if (et === 'status') return nv ? `${_hostT('host.state_label', 'State')}: ${nv}` : _hostT('host.state_label', 'State');
    if (et === 'mac') return 'MAC';
    if (et === 'ip_change') return _hostT('host.ip_change', 'IP change');
    if (et === 'ip_change_arrived') return _hostT('host.new_ip', 'New IP');
    if (et === 'delete') return _hostT('host.deleted', 'Deleted');
    return (et || 'event').replaceAll('_', ' ');
  }

  function _hostEventSummary(ev) {
    if (ev?.summary) return ev.summary;
    const et = String(ev?.event_type || '').toLowerCase();
    const oldVal = String(ev?.old_value || '');
    const newVal = String(ev?.new_value || '');
    if (et === 'new') return _hostT('host.detected_first_time', 'Detected for the first time');
    if (et === 'new_silent') return _hostT('host.detected_router_only', 'Detected only by router');
    if (et === 'status') return `${_hostT('host.state_label', 'State')} → ${newVal || '—'}`;
    if (et === 'mac') return `MAC: ${oldVal || '—'} → ${newVal || '—'}`;
    if (et === 'ip_change') return `IP: ${oldVal || '—'} → ${newVal || '—'}`;
    if (et === 'ip_change_arrived') return `${_hostT('host.new_ip', 'New IP')}: ${newVal || '—'}`;
    if (et === 'delete') return _hostT('host.deleted', 'Host deleted');
    return newVal || oldVal || _hostT('host.change_recorded', 'Recorded change');
  }

  function _renderHostModalTags(tags) {
    const wrap = document.getElementById('mTagWrap');
    const input = document.getElementById('mTagInput');
    if (!wrap || !input) return;
    wrap.querySelectorAll('.tag-badge').forEach(el => el.remove());
    (Array.isArray(tags) ? tags : []).forEach(tag => {
      const badge = document.createElement('span');
      badge.className = 'tag-badge';
      badge.innerHTML = `${esc(tag)} <span class="tag-remove" data-tag="${esc(tag)}">×</span>`;
      wrap.insertBefore(badge, input);
    });
  }

  function _toggleHostUptimeView(view) {
    _hostUptimeView = view === 'table' ? 'table' : 'chart';
    $('#mUptimeChartView').toggle(_hostUptimeView === 'chart');
    $('#mUptimeGridView').toggle(_hostUptimeView === 'table');
    $('.uptime-view-btn').removeClass('active');
    $(`.uptime-view-btn[data-view="${_hostUptimeView}"]`).addClass('active');
  }

  function _renderHostClassification(detail) {
    const host = detail?.host || {};
    const type = String(host.device_type || 'unknown').trim() || 'unknown';
    const knownType = type && type !== 'unknown';
    const pct = _deviceConfidencePct(host.device_confidence);
    const source = String(host.device_source || '').trim();
    const updated = host.device_updated_at_local ? ` · ${host.device_updated_at_local}` : '';
    const evidenceItems = _deviceEvidenceItems(host.device_evidence);

    $('#mDeviceTypeBadge, #mClassTypeBadge')
      .text(knownType ? type : _hostT('host.unclassified', 'Unclassified'))
      .toggleClass('opacity-75', !knownType);
    $('#mDeviceConfidence, #mClassConfidence').text(
      pct != null ? `${_hostT('host.confidence', 'Confidence')} ${Math.round(pct)}%` : ''
    );
    $('#mDeviceSource, #mClassSource').text(
      source
        ? `${_hostT('host.source', 'Source')}: ${source}${updated}`
        : (updated ? `${_hostT('host.updated', 'Updated')}: ${updated.replace(/^ · /, '')}` : '')
    );
    $('#mClassMeta').text(
      knownType
        ? _hostT('host.active_classification', 'Active classification on host record')
        : _hostT('host.no_confirmed_classification', 'No confirmed automatic classification')
    );
    $('#mClassEvidence').html(evidenceItems.length
      ? evidenceItems.map(line => `<li><div class="ip-dot"></div><div>${esc(line)}</div></li>`).join('')
      : `<li><div class="ip-dot old"></div><div class="small-muted">${esc(_hostT('host.no_saved_evidence', 'No detailed evidence stored for this host.'))}</div></li>`
    );
  }

  function _renderHostLastChange(host) {
    const intervalWhen = host?.current_interval_started_at_local || '';
    if (intervalWhen) {
      const tone = _hostStatusTone(host?.status);
      $('#mLastChangeText').text(`${_hostT('host.state_label', 'State')} → ${tone.text}`);
      $('#mLastChange').text(intervalWhen || '—');
      return;
    }

    const text = host?.last_relevant_change_text || _hostT('host.no_recent_relevant_changes', 'No recent relevant changes');
    const when = host?.last_relevant_change_at_local || host?.last_change_local || '—';
    $('#mLastChangeText').text(text);
    $('#mLastChange').text(when || '—');
  }

  function _renderHostIpHistory(detail) {
    const $card = $('#mIpHistoryCard');
    const $list = $('#mIpTimeline');
    if (!$card.length || !$list.length) return;

    const events = Array.isArray(detail?.events_all)
      ? detail.events_all
      : (Array.isArray(detail?.events) ? detail.events : []);

    const ipEvents = events.filter(ev => {
      const et = String(ev?.event_type || '').toLowerCase();
      return et === 'ip_change' || et === 'ip_change_arrived';
    });

    if (!ipEvents.length) {
      $list.html('');
      $card.hide();
      return;
    }

    $list.html(ipEvents.slice(0, 12).map(ev => {
      const label = _hostEventTypeLabel(ev?.event_type, ev?.new_value);
      const summary = _hostEventSummary(ev);
      const when = ev?.at_local || _hostFmtDateTime(ev?.at);
      return `<li>
        <div class="ip-dot"></div>
        <div class="d-flex flex-column gap-1">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="badge bg-secondary-subtle text-light border border-secondary-subtle">${esc(label)}</span>
            <span class="mono small-muted">${esc(when || '—')}</span>
          </div>
          <div>${esc(summary)}</div>
        </div>
      </li>`;
    }).join(''));

    $card.show();
  }

  function _renderHostSummary(detail) {
    const host = detail?.host || {};
    const tone = _hostStatusTone(host.status);
    window.currentIp = currentIp = host.ip || null;

    $('#mIp').text(host.ip || '—');
    $('#mMac').text(host.mac || '—');
    $('#mVendor').text(host.vendor || '—');
    $('#mHost').text(host.manual_name || host.nmap_hostname || host.router_hostname || '—');
    $('#mDns').text(host.dns_name || '—');
    $('#mStatus').attr('class', `badge ${tone.badge}`).text(tone.text);
    const knownFlag = host.known === true || host.known === 1 || host.known === '1' || host.known === 'true';
    $('#mKnownBadge').attr('class', `badge ms-1 ${knownFlag ? 'badge-known' : 'badge-unknown'}`).text(_hostBoolLabel(knownFlag));
    $('#mToggleKnown').data('known', knownFlag).text(_hostKnownToggleLabel(knownFlag));
    $('#mFirst').text(host.first_seen_local || '—');
    $('#mLast').text(host.last_seen_local || '—');
    $('#mSeenAgo').text(_hostFmtSeenAgo(host.seen_ago));
    $('#mLatency').text(host.last_latency_ms != null ? `${Number(host.last_latency_ms).toFixed(1)}ms` : '—');
    const statusSince = host.current_interval_started_at || host.last_change_raw || host.last_relevant_change_at;
    $('#mStatusDuration').text(`${tone.text} · ${_hostFmtDurationMs(statusSince, '')}`);
    _renderHostLastChange(host);
    _renderHostClassification(detail);
    _renderHostIpHistory(detail);

    $('#mType').val(host.type_id ?? '');
    $('#mOwner').html(_hostOwnerOptions(host.owner_id ?? '')).val(host.owner_id ?? '');
    $('#mManual').val(host.manual_name || '');
    $('#mNotes').val(host.notes || '');
    window._currentTags = String(host.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    _renderHostModalTags(window._currentTags);

    const hasRouterInfo = !!(host.router_hostname || host.ip_assignment || host.dhcp_lease_expires);
    $('#mRouterInfo').toggle(hasRouterInfo);
    $('#mRouterHostname').text(host.router_hostname || '—');
    $('#mIpAssignment').text(host.ip_assignment || '—');
    $('#mLeaseExpires').text(host.dhcp_lease_expires || '—');

    $('#mMsg').text('');
  }

  function _renderUptimeChart(data) {
    const canvas = document.getElementById('mUptimeChart');
    if (!canvas) return;
    const rows = Array.isArray(data?.daily) ? data.daily : [];
    const labels = rows.map(r => _hostFmtDateShort(r.date));
    const online = rows.map(r => Number(r.online_h || 0));
    const offline = rows.map(r => Number(r.offline_h || 0));
    const rawMax = Math.max(1, ...online, ...offline);
    const yMax = Math.max(1, Math.ceil(rawMax * 1.25));

    if (_hostUptimeChart) {
      try { _hostUptimeChart.destroy(); } catch (_) {}
      _hostUptimeChart = null;
    }
    _hostUptimeChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: `${_hostT('status.online', 'Online')} (h)`, data: online, backgroundColor: accentColor(0.78), borderColor: accentColor(1), borderWidth: 1, borderRadius: 4 },
          { label: `${_hostT('status.offline', 'Offline')} (h)`, data: offline, backgroundColor: 'rgba(255,107,107,0.5)', borderColor: 'rgba(255,107,107,0.9)', borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: true, labels: { boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } } },
        scales: {
          y: { min: 0, max: yMax, ticks: { callback: v => `${v}h`, maxTicksLimit: 5 }, grid: { color: 'rgba(255,255,255,0.08)' } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function _renderUptimeGrid(data) {
    const rows = Array.isArray(data?.daily) ? data.daily : [];
    const tableRows = [...rows].reverse();
    $('#mUptimeDays').html(tableRows.length
      ? `<div class="table-responsive"><table class="table table-sm align-middle mb-0 uptime-table"><thead><tr><th>${esc(_hostT('host.uptime_day', 'Day'))}</th><th class="text-end">${esc(_hostT('status.online', 'Online'))}</th><th class="text-end">${esc(_hostT('status.offline', 'Offline'))}</th><th class="text-end">${esc(_hostT('host.uptime_observed', 'Observed uptime'))}</th></tr></thead><tbody>${tableRows.map(r => `
          <tr>
            <td class="mono">${esc(r.date || '—')}</td>
            <td class="text-end mono">${esc(Number(r.online_h || 0).toFixed(1))}h</td>
            <td class="text-end mono">${esc(Number(r.offline_h || 0).toFixed(1))}h</td>
            <td class="text-end mono">${r.pct == null ? '—' : esc(Number(r.pct).toFixed(1) + '%')}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="small-muted">${esc(_hostT('host.uptime_no_data', 'No uptime data for this range'))}</div>`
    );
  }

  async function _loadHostUptime(ip, days = _hostUptimeDays) {
    _hostUptimeDays = days;
    $('.uptime-range-btn').removeClass('active');
    $(`.uptime-range-btn[data-days="${days}"]`).addClass('active');

    const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/uptime?days=${days}`, { cache: 'no-store' }).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || _hostT('host.load_uptime_failed', 'Could not load uptime'));

    const onlineH = Number(data.total_online_h || 0);
    const offlineH = Number(data.total_offline_h || 0);
    const totalH = onlineH + offlineH;
    const onlinePct = totalH > 0 ? Math.max(0, Math.min(100, (onlineH * 100) / totalH)) : 0;
    const offlinePct = totalH > 0 ? Math.max(0, Math.min(100, (offlineH * 100) / totalH)) : 0;

    $('#mUptimePct').text(data.uptime_pct != null ? `${data.uptime_pct}%` : '—');
    $('#mUptimeBarOnline').css('width', `${onlinePct}%`);
    $('#mUptimeBarOffline').css('width', `${offlinePct}%`);
    $('#mUptimeOnlineH').text(data.total_online_h != null ? Number(data.total_online_h).toFixed(1) : '—');
    $('#mUptimeOfflineH').text(data.total_offline_h != null ? Number(data.total_offline_h).toFixed(1) : '—');
    $('#mUptimeRangeLabel').text(
      days === 1
        ? _hostT('host.range_last_24h', 'last 24h')
        : (days === 7 ? _hostT('host.range_last_7d', 'last 7 days') : _hostT('host.range_last_30d', 'last 30 days'))
    );
    $('#mUptimeExplain').text(days === 1
      ? _hostT('host.uptime_explain_24h', '24h uses observed time between scans from the current model; it is not a full 24h window nor a fine-grained timeline.')
      : _hostT('host.uptime_explain_multi', 'Each row or bar summarizes observed online/offline hours between scans; the percentage is observed uptime over the accumulated time for that day.'));

    _renderUptimeChart(data);
    _renderUptimeGrid(data);
    _toggleHostUptimeView(_hostUptimeView);
    return data;
  }

  function _buildIntervalsFromSegments(segments = []) {
    if (!Array.isArray(segments) || !segments.length) return [];
    const intervals = [];
    let current = { status: segments[0].status || 'unknown', start: segments[0].time, end: null };
    for (let i = 1; i < segments.length; i += 1) {
      const seg = segments[i];
      if ((seg.status || 'unknown') !== current.status) {
        current.end = seg.time;
        intervals.push(current);
        current = { status: seg.status || 'unknown', start: seg.time, end: null };
      }
    }
    intervals.push(current);
    return intervals.reverse();
  }

  function _normalizeScanHistoryItem(item) {
    if (!item || typeof item !== 'object') return null;
    const rawStatus = String(
      item.status
      ?? item.state
      ?? item.new_status
      ?? item.new_value
      ?? item.value
      ?? item.kind
      ?? ''
    ).trim();
    const start = String(
      item.start
      ?? item.start_at
      ?? item.started_at
      ?? item.from
      ?? item.at
      ?? item.timestamp
      ?? item.ts
      ?? ''
    ).trim();
    const end = String(
      item.end
      ?? item.end_at
      ?? item.ended_at
      ?? item.finished_at
      ?? item.to
      ?? item.until
      ?? ''
    ).trim();
    if (!start) return null;
    return {
      status: rawStatus || 'unknown',
      start,
      end: end || null,
      oldStatus: String(item.old_status ?? item.old_value ?? '').trim(),
      source: String(item.source ?? item.origin ?? '').trim(),
    };
  }

  function _extractScanHistoryIntervals(payload) {
    const base = Array.isArray(payload) ? payload : (payload?.data || payload || {});
    const rows = Array.isArray(base)
      ? base
      : (Array.isArray(base?.history)
          ? base.history
          : (Array.isArray(base?.intervals)
              ? base.intervals
              : (Array.isArray(base?.items)
                  ? base.items
                  : (Array.isArray(base?.changes)
                      ? base.changes
                      : (Array.isArray(base?.rows) ? base.rows : [])))));

    return rows
      .map(_normalizeScanHistoryItem)
      .filter(Boolean)
      .sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime());
  }


  function _timelineBucket(status) {
    const raw = String(status || 'unknown').trim().toLowerCase();
    if (raw === 'online_silent' || raw === 'silent') return 'online_silent';
    if (raw === 'online') return 'online';
    if (raw === 'offline') return 'offline';
    return 'unknown';
  }

  function _normalizeTimelineSegments(segments) {
    return (Array.isArray(segments) ? segments : [])
      .map(seg => {
        const time = String(seg?.time ?? seg?.at ?? seg?.start ?? '').trim();
        const ms = new Date(time).getTime();
        if (!time || !Number.isFinite(ms)) return null;
        const status = String(seg?.status ?? seg?.state ?? '').trim() || 'unknown';
        return {
          ...seg,
          time,
          status,
          _ms: ms,
          _bucket: _timelineBucket(status),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a._ms - b._ms);
  }

  function _mergeStateIntervals(intervals) {
    const rows = (Array.isArray(intervals) ? intervals : [])
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const start = String(item.start ?? item.at ?? item.time ?? '').trim();
        if (!start) return null;
        const startMs = new Date(start).getTime();
        if (!Number.isFinite(startMs)) return null;
        const end = String(item.end ?? item.to ?? '').trim();
        const endMs = end ? new Date(end).getTime() : NaN;
        const status = String(item.status ?? item.state ?? item.new_status ?? item.new_value ?? '').trim() || 'unknown';
        return {
          status,
          start,
          end: end || null,
          oldStatus: String(item.oldStatus ?? item.old_status ?? item.old_value ?? '').trim(),
          source: String(item.source ?? '').trim(),
          _startMs: startMs,
          _endMs: Number.isFinite(endMs) ? endMs : null,
          _bucket: _timelineBucket(status),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a._startMs - b._startMs);

    const merged = [];
    const MERGE_GAP_MS = 90 * 1000;

    rows.forEach(row => {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push({ ...row });
        return;
      }

      const lastEndMs = last._endMs ?? last._startMs;
      const rowStartMs = row._startMs;
      const canMerge =
        last._bucket === row._bucket &&
        rowStartMs <= (lastEndMs + MERGE_GAP_MS);

      if (canMerge) {
        if (row._endMs == null || last._endMs == null) {
          last.end = row.end || last.end || null;
          last._endMs = row._endMs ?? last._endMs;
        } else if (row._endMs >= last._endMs) {
          last.end = row.end;
          last._endMs = row._endMs;
        }
        if (!last.source && row.source) last.source = row.source;
        if (!last.oldStatus && row.oldStatus) last.oldStatus = row.oldStatus;
        return;
      }

      merged.push({ ...row });
    });

    return merged
      .sort((a, b) => b._startMs - a._startMs)
      .map(({ _startMs, _endMs, _bucket, ...rest }) => rest);
  }


  function _hasMeaningfulStateIntervals(intervals) {
    const rows = Array.isArray(intervals) ? intervals : [];
    if (!rows.length) return false;
    const buckets = rows
      .map(item => _timelineBucket(item?.status))
      .filter(bucket => bucket !== 'unknown');
    const uniqueBuckets = new Set(buckets);
    if (rows.length >= 2 && uniqueBuckets.size >= 2) return true;
    if (rows.length >= 3) return true;
    return false;
  }

  function _intervalTone(status) {
    const raw = String(status || 'unknown').toLowerCase();
    const norm = _normalizeAvailStatus(raw);
    return {
      norm,
      rowClass: raw === 'online_silent' ? 'silent' : (norm === 'online' ? 'online' : 'offline'),
      badgeClass: raw === 'online_silent'
        ? 'bg-warning text-dark'
        : (norm === 'online' ? 'bg-success' : (norm === 'offline' ? 'bg-secondary' : 'bg-dark')),
      label: _timelineStatusLabel(raw || norm),
    };
  }

  function _buildStateChangesFromEvents(detail) {
    const all = Array.isArray(detail?.events_all) ? detail.events_all : [];
    const transitions = [];
    let lastNewStatus = null;

    all
      .slice()
      .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
      .forEach(ev => {
        if (String(ev?.event_type || '').toLowerCase() !== 'status') return;
        const oldNorm = _normalizeAvailStatus(ev.old_value);
        const newNorm = _normalizeAvailStatus(ev.new_value);
        if (!['online', 'offline'].includes(oldNorm) || !['online', 'offline'].includes(newNorm)) return;
        if (oldNorm === newNorm) return;
        if (lastNewStatus === newNorm) return;
        transitions.push({ status: newNorm, start: ev.at, end: null, oldStatus: oldNorm });
        lastNewStatus = newNorm;
      });

    for (let i = 0; i < transitions.length; i += 1) {
      transitions[i].end = i === 0 ? null : transitions[i - 1].start;
    }
    return transitions;
  }

  function _renderIntervals(intervals) {
    _hostStateChanges = Array.isArray(intervals) ? intervals : [];
    const rows = _hostStateChanges.slice(0, 6);
    $('#btnScanHistory').prop('disabled', _hostStateChanges.length === 0);
    $('#mScanHistory').html(rows.length
      ? rows.map(item => {
          const tone = _intervalTone(item.status);
          return `<div class="interval-row ${tone.rowClass}">
            <span class="badge ${tone.badgeClass}">${esc(tone.label)}</span>
            <span class="mono">${esc(_hostFmtDateTime(item.start))}</span>
            <span class="small-muted">→</span>
            <span class="mono">${esc(item.end ? _hostFmtDateTime(item.end) : _hostT('host.now', 'now'))}</span>
            <span class="small-muted ms-auto">${esc(_hostFmtDurationMs(item.start, item.end))}</span>
          </div>`;
        }).join('')
      : `<div class="small-muted">${esc(_hostT('host.no_recent_state_changes', 'No recent state changes'))}</div>`
    );
  }

  function _renderAllIntervalsModal() {
    $('#mScanHistoryAll').html(_hostStateChanges.length
      ? _hostStateChanges.map(item => {
          const tone = _intervalTone(item.status);
          return `<div class="interval-row ${tone.rowClass} mb-2">
            <span class="badge ${tone.badgeClass}">${esc(tone.label)}</span>
            <span class="mono">${esc(_hostFmtDateTime(item.start))}</span>
            <span class="small-muted">→</span>
            <span class="mono">${esc(item.end ? _hostFmtDateTime(item.end) : _hostT('host.now', 'now'))}</span>
            <span class="small-muted ms-auto">${esc(_hostFmtDurationMs(item.start, item.end))}</span>
          </div>`;
        }).join('')
      : `<div class="small-muted">${esc(_hostT('host.no_recent_state_changes', 'No recent state changes'))}</div>`
    );
  }

  function _buildPreciseTimelineIntervals(intervals, windowStart, windowEnd) {
    const startMs = new Date(windowStart || '').getTime();
    const endMs = new Date(windowEnd || '').getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

    const rows = (Array.isArray(intervals) ? intervals : [])
      .map(item => {
        const start = String(item?.start || '').trim();
        const end = String(item?.end || '').trim();
        const startVal = new Date(start).getTime();
        const endVal = new Date(end).getTime();
        if (!start || !end || !Number.isFinite(startVal) || !Number.isFinite(endVal) || endVal <= startVal) return null;
        return {
          status: String(item?.status || 'unknown').trim().toLowerCase() || 'unknown',
          startMs: startVal,
          endMs: endVal,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.startMs - b.startMs);

    const result = [];
    let cursorMs = startMs;

    rows.forEach(row => {
      const segStart = Math.max(startMs, row.startMs);
      const segEnd = Math.min(endMs, row.endMs);
      if (segEnd <= segStart) return;

      if (segStart > cursorMs) {
        result.push({
          bucket: 'unknown',
          rawStatus: 'unknown',
          startIso: new Date(cursorMs).toISOString(),
          endIso: new Date(segStart).toISOString(),
          durationMs: segStart - cursorMs,
        });
      }

      result.push({
        bucket: _timelineBucket(row.status),
        rawStatus: row.status,
        startIso: new Date(segStart).toISOString(),
        endIso: new Date(segEnd).toISOString(),
        durationMs: segEnd - segStart,
      });

      cursorMs = Math.max(cursorMs, segEnd);
    });

    if (cursorMs < endMs) {
      result.push({
        bucket: 'unknown',
        rawStatus: 'unknown',
        startIso: new Date(cursorMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        durationMs: endMs - cursorMs,
      });
    }

    return result.filter(run => Number.isFinite(run.durationMs) && run.durationMs > 0);
  }

  function _renderPreciseTimelineStrip(intervals, range, date, stats, windowStart, windowEnd) {
    const $strip = $('#mTimelineStrip');
    const startMs = new Date(windowStart || '').getTime();
    const endMs = new Date(windowEnd || '').getTime();
    if (!$strip.length || !intervals.length || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;

    const totalMs = endMs - startMs;
    const colors = bucket => (
      bucket === 'online_silent'
        ? 'linear-gradient(135deg, rgba(255,193,7,0.90), rgba(255,193,7,0.70))'
        : (bucket === 'online'
            ? 'linear-gradient(135deg, rgba(77,255,181,0.90), rgba(77,255,181,0.66))'
            : (bucket === 'offline'
                ? 'linear-gradient(135deg, rgba(255,107,107,0.88), rgba(255,107,107,0.68))'
                : 'linear-gradient(135deg, rgba(148,163,184,0.72), rgba(148,163,184,0.48))'))
    );
    const textColor = bucket => (
      bucket === 'offline' ? '#2c0c0c' : (bucket === 'online_silent' ? '#342300' : (bucket === 'online' ? '#062317' : '#18212d'))
    );

    const runHtml = intervals.map((run, idx) => {
      const widthPct = Math.max(0.35, (run.durationMs / totalMs) * 100);
      const tipTitle = _timelineStatusLabel(run.rawStatus || run.bucket);
      const tipRange = `${_hostFmtDateTime(run.startIso)} → ${_hostFmtDateTime(run.endIso)}`;
      const tipMeta = _hostFmtDurationMs(run.startIso, run.endIso);
      const tipHtml = `<strong>${esc(tipTitle)}</strong><div>${esc(tipRange)}</div><div class="timeline-tooltip-sub">${esc(tipMeta)}</div>`;
      const leftRadius = idx === 0 ? '16px' : '0';
      const rightRadius = idx === intervals.length - 1 ? '16px' : '0';
      const labelMain = _timelineStatusLabel(run.rawStatus || run.bucket).toUpperCase();
      const labelSub = _hostFmtDurationMs(run.startIso, run.endIso);
      const showLabel = widthPct >= 14 || run.durationMs >= (90 * 60 * 1000);

      return `<span class="host-timeline-seg" title="${esc(`${tipRange} · ${tipTitle}`)}" data-tip="${esc(tipHtml)}"
        style="position:relative;flex:0 0 ${widthPct}%;width:${widthPct}%;min-width:${Math.max(8, Math.min(52, widthPct * 3.4))}px;height:64px;background:${colors(run.bucket)};border-radius:${leftRadius} ${rightRadius} ${rightRadius} ${leftRadius};box-shadow:inset 0 1px 0 rgba(255,255,255,0.12), inset -1px 0 0 rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:center;overflow:hidden;color:${textColor(run.bucket)};">
          ${showLabel ? `<span style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 8px;max-width:100%;line-height:1.1;text-align:center">
            <strong style="font-size:.68rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(labelMain)}</strong>
            <span style="font-size:.64rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(labelSub)}</span>
          </span>` : ''}
        </span>`;
    }).join('');

    const tickEntries = [0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
      const ms = startMs + Math.round(totalMs * ratio);
      return {
        left: ratio * 100,
        main: _hostFmtTime(new Date(ms).toISOString()),
        sub: idx === 0 ? _hostT('host.timeline_start', 'start') : (idx === 4 ? _hostT('host.timeline_end', 'end') : ''),
      };
    });

    const tickHtml = `<div style="position:relative;height:20px;margin-top:8px">${tickEntries.map(tick => `
      <span style="position:absolute;left:${tick.left}%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1px;font-size:.63rem;line-height:1.1;color:rgba(255,255,255,0.62);white-space:nowrap">
        <strong style="font-size:.68rem;color:rgba(255,255,255,0.82);font-weight:600">${esc(tick.main)}</strong>
        ${tick.sub ? `<span>${esc(tick.sub)}</span>` : ''}
      </span>`).join('')}</div>`;

    const chips = (intervals.length > 6)
      ? [...intervals.slice(0, 2), { collapsed: true, extra: intervals.length - 4 }, ...intervals.slice(-2)]
      : intervals;

    const chipHtml = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${chips.map(run => {
      if (run.collapsed) {
        return `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:.7rem;color:rgba(255,255,255,0.78)"><span style="width:8px;height:8px;border-radius:50%;background:rgba(148,163,184,0.88)"></span><strong>+${run.extra}</strong> tramos</span>`;
      }
      const dot = run.bucket === 'online_silent'
        ? 'rgba(255,193,7,0.95)'
        : (run.bucket === 'online' ? 'rgba(77,255,181,0.95)' : (run.bucket === 'offline' ? 'rgba(255,107,107,0.95)' : 'rgba(148,163,184,0.88)'));
      return `<span style="display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:.7rem;color:rgba(255,255,255,0.84)">
        <span style="width:8px;height:8px;border-radius:50%;background:${dot}"></span>
        <span><strong style="color:rgba(255,255,255,0.92)">${esc(_timelineStatusLabel(run.rawStatus || run.bucket))}</strong> · ${esc(_hostFmtTime(run.startIso))} → ${esc(_hostFmtTime(run.endIso))} · ${esc(_hostFmtDurationMs(run.startIso, run.endIso))}</span>
      </span>`;
    }).join('')}</div>`;

    const shellHtml = `<div style="position:relative;min-height:64px;padding:12px;border-radius:16px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));overflow:hidden">
      <div style="position:relative;display:flex;align-items:stretch;height:64px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,0.035)">${runHtml}</div>
      ${tickHtml}
      ${chipHtml}
    </div>`;

    $strip.html(shellHtml);
    $strip.attr('style', 'position:relative;overflow:visible');

    const midMs = startMs + Math.round(totalMs / 2);
    const context = _timelineRangeContext(range, date, windowStart, new Date(endMs - 60000).toISOString());
    $('#mTimelineAxis').html(`
      <div class="host-timeline-axis-start">
        <strong>${esc(_timelineAxisLabel(startMs, range, !!date))}</strong>
        <span>${esc(_hostT('host.timeline_start', 'start'))}</span>
      </div>
      <div class="host-timeline-axis-mid">
        <strong>${esc(_timelineAxisLabel(midMs, range, range !== 'day' || !!date))}</strong>
        <span>${esc(context)}</span>
      </div>
      <div class="host-timeline-axis-end">
        <strong>${esc(_timelineAxisLabel(endMs - 60000, range, range !== 'day' || !!date))}</strong>
        <span>${esc(_hostT('host.timeline_end', 'end'))}</span>
      </div>
    `);

    $('#mTimelineStats').text(
      `${context} · ${_hostT('status.online', 'Online')}: ${stats?.online ?? 0} · ${_hostT('status.offline', 'Offline')}: ${stats?.offline ?? 0} · ${_hostT('status.unknown', 'Unknown')}: ${stats?.unknown ?? 0}`
    );

    return true;
  }

  function _renderTimelineStrip(segments, range, date, stats, preciseIntervals = [], windowStart = '', windowEnd = '') {
    const stepLabel = _timelineStepLabel(range, date);
    const ordered = _normalizeTimelineSegments(segments);
    _hideTimelineTooltip();
    const $strip = $('#mTimelineStrip');

    const preciseRows = (range === 'day' || date)
      ? _buildPreciseTimelineIntervals(preciseIntervals, windowStart, windowEnd)
      : [];

    if (preciseRows.length && _renderPreciseTimelineStrip(preciseRows, range, date, stats, windowStart, windowEnd)) {
      return;
    }

    if (!ordered.length) {
      $strip.html(`<div class="small-muted">${esc(_hostT('host.loading_availability_empty', 'No availability data'))}</div>`);
      $strip.attr('style', 'display:flex;align-items:center;justify-content:center;min-height:86px;padding:12px;border-radius:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);');
      $('#mTimelineAxis').html('');
      $('#mTimelineStats').text(`${_hostT('host.timeline_block_label', 'Each block')} = ${stepLabel} · ${_hostT('host.timeline_no_recent_data', 'No recent data')}`);
      return;
    }

    const stepMs = _timelineStepMs(range, date);
    const runs = [];
    ordered.forEach((seg, idx) => {
      const bucket = _timelineBucket(seg.status);
      if (!runs.length || runs[runs.length - 1].bucket !== bucket) {
        runs.push({
          bucket,
          rawStatus: String(seg.status || bucket),
          startIso: seg.time,
          endIso: seg.time,
          steps: 1,
          startIndex: idx,
          endIndex: idx,
        });
      } else {
        const run = runs[runs.length - 1];
        run.endIso = seg.time;
        run.endIndex = idx;
        run.steps += 1;
      }
    });

    const totalSteps = Math.max(1, ordered.length);
    const gridLines = Array.from({ length: totalSteps + 1 }, (_, idx) => {
      const left = (idx / totalSteps) * 100;
      const strong = idx === 0 || idx === totalSteps || (totalSteps > 6 && idx === Math.round(totalSteps / 2));
      return `<span style="position:absolute;top:0;bottom:0;left:${left}%;width:${strong ? 2 : 1}px;background:${strong ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)'};transform:translateX(-50%);pointer-events:none"></span>`;
    }).join('');

    const runHtml = runs.map((run, idx) => {
      const startMs = new Date(run.startIso || '').getTime();
      const lastMs = new Date(run.endIso || '').getTime();
      const endMs = Number.isFinite(lastMs) ? (lastMs + stepMs) : NaN;
      const endIso = Number.isFinite(endMs) ? new Date(endMs).toISOString() : '';
      const tipTitle = _timelineStatusLabel(run.rawStatus || run.bucket);
      const tipRange = `${_hostFmtDateTime(run.startIso)} → ${_hostFmtDateTime(endIso || run.endIso || run.startIso)}`;
      const tipMeta = `${_hostFmtDurationMs(run.startIso, endIso || null)} · ${run.steps} bloque(s)`;
      const tipHtml = `<strong>${esc(tipTitle)}</strong><div>${esc(tipRange)}</div><div class="timeline-tooltip-sub">${esc(tipMeta)}</div>`;
      const widthPct = (run.steps / totalSteps) * 100;
      const baseColor = run.bucket === 'online_silent'
        ? 'linear-gradient(135deg, rgba(255,193,7,0.90), rgba(255,193,7,0.70))'
        : (run.bucket === 'online'
            ? 'linear-gradient(135deg, rgba(77,255,181,0.90), rgba(77,255,181,0.66))'
            : (run.bucket === 'offline'
                ? 'linear-gradient(135deg, rgba(255,107,107,0.88), rgba(255,107,107,0.68))'
                : 'linear-gradient(135deg, rgba(148,163,184,0.72), rgba(148,163,184,0.48))'));
      const leftRadius = idx === 0 ? '16px' : '0';
      const rightRadius = idx === runs.length - 1 ? '16px' : '0';
      const labelMain = _timelineStatusLabel(run.rawStatus || run.bucket).toUpperCase();
      const labelSub = range === 'day' || date
        ? _hostFmtDurationMs(run.startIso, endIso || null)
        : `${_hostFmtDateShort(run.startIso)} → ${_hostFmtDateShort(endIso || run.endIso)}`;
      const showLabel = widthPct >= 16 || run.steps >= 4;
      return `<span class="host-timeline-seg" title="${esc(`${tipRange} · ${tipTitle}`)}" data-tip="${esc(tipHtml)}"
        style="position:relative;flex:0 0 ${widthPct}%;width:${widthPct}%;min-width:${Math.max(16, Math.min(54, run.steps * 6))}px;height:64px;background:${baseColor};border-radius:${leftRadius} ${rightRadius} ${rightRadius} ${leftRadius};box-shadow:inset 0 1px 0 rgba(255,255,255,0.12), inset -1px 0 0 rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:center;overflow:hidden;color:${run.bucket === 'offline' ? '#2c0c0c' : (run.bucket === 'online_silent' ? '#342300' : '#062317')};">
          ${showLabel ? `<span style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 8px;max-width:100%;line-height:1.1;text-align:center">
            <strong style="font-size:.68rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(labelMain)}</strong>
            <span style="font-size:.64rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(labelSub)}</span>
          </span>` : ''}
        </span>`;
    }).join('');

    const tickEntries = (() => {
      const firstMs = ordered[0]._ms;
      const lastStartMs = ordered[ordered.length - 1]._ms;
      const lastEndMs = lastStartMs + stepMs;
      const totalMs = Math.max(stepMs, lastEndMs - firstMs);
      const makeTick = (ms, main, sub = '') => ({
        left: Math.max(0, Math.min(100, ((ms - firstMs) / totalMs) * 100)),
        main,
        sub,
      });

      if (date || range === 'day') {
        return [0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
          const ms = firstMs + Math.round(totalMs * ratio);
          return makeTick(ms, _hostFmtTime(new Date(ms).toISOString()), idx === 0 ? 'inicio' : (idx === 4 ? 'fin' : ''));
        });
      }
      if (range === 'week') {
        return Array.from({ length: 8 }, (_, idx) => {
          const ms = firstMs + idx * 24 * 60 * 60 * 1000;
          const d = new Date(ms);
          return makeTick(
            ms,
            _hostFmtDateShort(d.toISOString()),
            (typeof window.fmtDate === 'function' ? window.fmtDate(d.toISOString()) : _hostFmtDateShort(d.toISOString()))
          );
        });
      }
      return Array.from({ length: 5 }, (_, idx) => {
        const ratio = idx / 4;
        const ms = firstMs + Math.round(totalMs * ratio);
        return makeTick(ms, _hostFmtDateShort(new Date(ms).toISOString()), idx === 0 ? 'inicio' : (idx === 4 ? 'fin' : ''));
      });
    })();

    const tickHtml = `<div style="position:relative;height:${range === 'day' || date ? 20 : 24}px;margin-top:8px">${tickEntries.map(tick => `
      <span style="position:absolute;left:${tick.left}%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:1px;font-size:.63rem;line-height:1.1;color:rgba(255,255,255,0.62);white-space:nowrap">
        <strong style="font-size:.68rem;color:rgba(255,255,255,0.82);font-weight:600">${esc(tick.main)}</strong>
        ${tick.sub ? `<span>${esc(tick.sub)}</span>` : ''}
      </span>`).join('')}</div>`;

    const chips = (runs.length > 6)
      ? [...runs.slice(0, 2), { collapsed: true, extra: runs.length - 4 }, ...runs.slice(-2)]
      : runs;
    const chipHtml = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${chips.map(run => {
      if (run.collapsed) {
        return `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:.7rem;color:rgba(255,255,255,0.78)"><span style="width:8px;height:8px;border-radius:50%;background:rgba(148,163,184,0.88)"></span><strong>+${run.extra}</strong> tramos</span>`;
      }
      const startMs = new Date(run.startIso || '').getTime();
      const endMs = new Date(run.endIso || '').getTime() + stepMs;
      const endIso = Number.isFinite(endMs) ? new Date(endMs).toISOString() : run.endIso;
      const dot = run.bucket === 'online_silent'
        ? 'rgba(255,193,7,0.95)'
        : (run.bucket === 'online' ? 'rgba(77,255,181,0.95)' : (run.bucket === 'offline' ? 'rgba(255,107,107,0.95)' : 'rgba(148,163,184,0.88)'));
      const rangeText = range === 'day' || date
        ? `${_hostFmtTime(run.startIso)} → ${_hostFmtTime(endIso)}`
        : `${_hostFmtDateShort(run.startIso)} → ${_hostFmtDateShort(endIso)}`;
      return `<span style="display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.05);font-size:.7rem;color:rgba(255,255,255,0.84)">
        <span style="width:8px;height:8px;border-radius:50%;background:${dot}"></span>
        <span><strong style="color:rgba(255,255,255,0.92)">${esc(_timelineStatusLabel(run.rawStatus || run.bucket))}</strong> · ${esc(rangeText)} · ${esc(_hostFmtDurationMs(run.startIso, endIso || null))}</span>
      </span>`;
    }).join('')}</div>`;

    const shellHtml = `<div style="position:relative;min-height:64px;padding:12px;border-radius:16px;border:1px solid rgba(255,255,255,0.08);background:linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));overflow:hidden">
      <div style="position:absolute;inset:12px 12px auto 12px;height:64px;pointer-events:none">${gridLines}</div>
      <div style="position:relative;display:flex;align-items:stretch;height:64px;border-radius:16px;overflow:hidden;background:rgba(255,255,255,0.035)">${runHtml}</div>
      ${tickHtml}
      ${chipHtml}
    </div>`;

    $strip.html(shellHtml);
    $strip.attr('style', 'position:relative;overflow:visible');

    _renderTimelineAxis(ordered, range, date);
    const firstIso = ordered[0]?.time || '';
    const lastIso = ordered[ordered.length - 1]?.time || '';
    const context = _timelineRangeContext(range, date, firstIso, Number.isFinite(new Date(lastIso).getTime()) ? (new Date(new Date(lastIso).getTime() + stepMs - 60000).toISOString()) : '');
    $('#mTimelineStats').text(
      `${context} · ${_hostT('host.timeline_block_label', 'Each block')} = ${stepLabel} · ${_hostT('status.online', 'Online')}: ${stats?.online ?? 0} · ${_hostT('status.offline', 'Offline')}: ${stats?.offline ?? 0} · ${_hostT('status.unknown', 'Unknown')}: ${stats?.unknown ?? 0}`
    );
  }

  async function _loadHostTimeline(ip, range = _hostTimelineRange, date = '') {
    _hostTimelineRange = date ? 'date' : range;
    $('#tlBtnDay, #tlBtnWeek, #tlBtnMonth').removeClass('active');
    if (!date) {
      const btnId = range === 'week' ? '#tlBtnWeek' : (range === 'month' ? '#tlBtnMonth' : '#tlBtnDay');
      $(btnId).addClass('active');
    }

    const url = new URL(`/api/hosts/${encodeURIComponent(ip)}/timeline`, window.location.origin);
    if (date) {
      url.searchParams.set('date', date);
      url.searchParams.set('range', 'day');
    } else {
      url.searchParams.set('range', range);
    }
    const data = await fetch(url.toString(), { cache: 'no-store' }).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || _hostT('host.load_timeline_failed', 'Could not load timeline'));

    const segments = Array.isArray(data.segments) ? data.segments : [];
    _renderTimelineStrip(
      segments,
      range,
      date,
      data.stats || {},
      Array.isArray(data.intervals) ? data.intervals : [],
      data.window_start || '',
      data.window_end || ''
    );
    return data;
  }

  async function _loadHostScanHistory(ip, detail, timelineData) {
    let persistedIntervals = [];
    try {
      const payload = await fetch(`/api/hosts/${encodeURIComponent(ip)}/scan-history`, { cache: 'no-store' }).then(r => r.json());
      if (payload?.ok === false) throw new Error(payload?.error || _hostT('host.load_history_failed', 'Could not load history'));
      persistedIntervals = _mergeStateIntervals(
        _extractScanHistoryIntervals(payload)
          .slice()
          .sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime())
      );
      if (persistedIntervals.length) {
        _renderIntervals(persistedIntervals);
        return persistedIntervals;
      }
    } catch (_) {
      persistedIntervals = [];
    }

    const legacyIntervals = _mergeStateIntervals(_buildStateChangesFromEvents(detail));
    if (_hasMeaningfulStateIntervals(legacyIntervals)) {
      _renderIntervals(legacyIntervals);
      return legacyIntervals;
    }

    const fallbackStepMs = _timelineStepMs(
      _hostTimelineRange === 'date' ? 'day' : _hostTimelineRange,
      _hostTimelineRange === 'date' ? ($('#mHostDatePicker').val() || '') : ''
    );
    const timelineIntervals = _mergeStateIntervals(
      _buildIntervalsFromSegments(Array.isArray(timelineData?.segments) ? timelineData.segments : [], fallbackStepMs)
    );
    if (_hasMeaningfulStateIntervals(timelineIntervals)) {
      _renderIntervals(timelineIntervals);
      return timelineIntervals;
    }

    const fallback = persistedIntervals.length
      ? persistedIntervals
      : (legacyIntervals.length ? legacyIntervals : timelineIntervals);
    _renderIntervals(fallback);
    return fallback;
  }

  async function _loadHostLatency(ip) {
    const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/latency?hours=24&limit=200`, { cache: 'no-store' }).then(r => r.json());
    if (!data?.ok) throw new Error(data?.error || _hostT('host.load_latency_failed', 'Could not load latency'));
    const hist = Array.isArray(data.history) ? data.history : [];
    const labels = hist.map(r => _hostFmtTime(r.scanned_at));
    const values = hist.map(r => r.latency_ms == null ? null : Number(r.latency_ms));

    if (_hostLatencyChart) {
      try { _hostLatencyChart.destroy(); } catch (_) {}
      _hostLatencyChart = null;
    }
    const canvas = document.getElementById('mLatencyChart');
    if (canvas) {
      _hostLatencyChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: values,
            borderColor: accent2Color(1),
            backgroundColor: accent2Color(0.12),
            fill: true,
            tension: 0.22,
            pointRadius: values.length > 24 ? 0 : 1.8,
            spanGaps: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { ticks: { callback: v => `${v}ms`, maxTicksLimit: 4 }, grid: { color: 'rgba(255,255,255,0.08)' } },
            x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 8 } },
          },
        },
      });
    }

    const valid = values.filter(v => v != null && Number.isFinite(v));
    const avg = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length) : null;
    $('#mLatencyStats').text(avg != null
      ? `Últimas 24h · ${valid.length} muestras · media ${avg.toFixed(1)}ms · actual ${data.last_latency_ms != null ? `${Number(data.last_latency_ms).toFixed(1)}ms` : '—'}`
      : 'Sin histórico de latencia en las últimas 24h');
    return data;
  }

  async function _loadHostDetailBundle(ip) {
    const detail = await fetch(`/api/hosts/${encodeURIComponent(ip)}/detail`, { cache: 'no-store' }).then(r => r.json());
    if (!detail?.ok) throw new Error(detail?.error || _hostT('host.load_detail_failed', 'Could not load host detail'));
    _renderHostSummary(detail);
    $('#mScanHistory').html(`<div class="small-muted">${esc(_hostT('host.loading_state_changes', 'Loading state changes…'))}</div>`);
    const timelineData = await _loadHostTimeline(
      ip,
      _hostTimelineRange === 'date' ? 'day' : _hostTimelineRange,
      _hostTimelineRange === 'date' ? ($('#mHostDatePicker').val() || '') : ''
    );
    await Promise.allSettled([
      _loadHostScanHistory(ip, detail, timelineData),
      _loadHostUptime(ip, _hostUptimeDays),
      _loadHostLatency(ip),
    ]);
    return detail;
  }


  function _hostActiveLabel() {
    return ($('#mManual').val() || '').trim()
      || ($('#mHost').text() || '').trim()
      || ($('#mDns').text() || '').trim()
      || window.currentIp
      || '';
  }

  function _hostToolTimestamp() {
    const nowIso = new Date().toISOString();
    return (typeof window.fmtTime === 'function') ? window.fmtTime(nowIso) : '—';
  }

  function _hostToolEscapeLines(lines) {
    return (Array.isArray(lines) ? lines : []).map(line => `<div class="ping-result-line">${esc(line)}</div>`).join('');
  }

  const HOST_PING_INTERVAL_MS = 4000;

  function _hostPingLineList(data) {
    if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
    if (Array.isArray(data?.output_lines) && data.output_lines.length) return data.output_lines;
    if (typeof data?.output === 'string' && data.output.trim()) {
      return data.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    return [];
  }

  function _hostKnownToggleLabel(isKnown) {
    return isKnown
      ? _hostT('host.mark_unknown', 'Mark as unknown')
      : _hostT('host.mark_known', 'Mark as known');
  }

  function _setHostPingButtons(running) {
    $('#hostPingStart').prop('disabled', !!running);
    $('#hostPingStop').prop('disabled', !running);
    $('#hostPingStateBadge').attr('class', `badge ${running ? 'bg-info' : 'bg-secondary'}`).text(
      running ? _hostT('host.ping_running', 'running') : _hostT('host.ping_stopped', 'stopped')
    );
  }

  // Añade una línea compacta al log de ping (sin timestamp propio, sin bloque)
  function _appendHostPingLine(tick, alive, avgMs, lossPct, statusNote, errorMsg) {
    const log = document.getElementById('hostPingLog');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `ping-log-line ${alive ? 'ping-alive' : (errorMsg ? 'ping-dead' : 'ping-dead')}`;
    const num = `<span class="ping-log-num">${tick}</span>`;
    if (errorMsg) {
      line.innerHTML = `${num}<span class="ping-log-body">error · ${esc(errorMsg)}</span>`;
    } else {
      const parts = [alive ? 'respuesta recibida' : 'sin respuesta'];
      if (avgMs != null) parts.push(`${Number(avgMs).toFixed(1)}ms`);
      if (lossPct != null) parts.push(`pérdida ${lossPct}%`);
      if (statusNote) parts.push(statusNote);
      line.innerHTML = `${num}<span class="ping-log-body">${parts.join(' · ')}</span>`;
    }
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // Actualiza el panel de salida técnica del último intento (se sobreescribe, no se acumula)
  function _updateHostPingRawOutput(lines) {
    const el = document.getElementById('hostPingRawOutput');
    if (!el) return;
    if (!lines || !lines.length) {
      el.innerHTML = '<span class="small-muted">Sin salida técnica.</span>';
      return;
    }
    el.textContent = lines.join('\n');
  }

  function _clearHostPingLog() {
    $('#hostPingLog').empty();
    _updateHostPingRawOutput([]);
    $('#hostPingSummary').text(_hostT('host.ping_prompt_start', 'Press start to begin continuous ping.'));
    $('#hostPingMeta').text(`1 paquete cada ~${Math.round(HOST_PING_INTERVAL_MS / 1000)}s`);
  }

  function _stopHostPingLoop(updateUi = true) {
    if (_hostPingTimer) clearInterval(_hostPingTimer);
    _hostPingTimer = null;
    _hostPingBusy = false;
    if (updateUi) _setHostPingButtons(false);
  }

  async function _refreshHostAfterActiveTool(ip) {
    try { await _loadHostDetailBundle(ip); } catch (_) {}
    try { await refreshHostsTable({ keepPage: true }); } catch (_) {}
    try { if (typeof window.loadDashboard === 'function') await window.loadDashboard(); } catch (_) {}
  }

  async function _runHostPingOnce(ip) {
    if (!ip || _hostPingBusy) return;
    _hostPingBusy = true;
    _hostPingTick += 1;
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/ping`, { method: 'POST' }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      const alive = !!data.alive;
      const lines = _hostPingLineList(data);
      const backendStatus = _normalizeAvailStatus(data?.host_status || '');
      const currentStatus = _normalizeAvailStatus($('#mStatus').text() || '');
      const statusNote = backendStatus || '';
      _appendHostPingLine(_hostPingTick, alive, data.avg_ms, data.loss_pct, statusNote, null);
      _updateHostPingRawOutput(lines);
      $('#hostPingSummary').text(alive
        ? 'Flujo continuo activo. El último intento ha respondido.'
        : 'Flujo continuo activo. El último intento no ha respondido.');
      $('#hostPingMeta').text(`Intentos: ${_hostPingTick} · 1 paquete cada ~${Math.round(HOST_PING_INTERVAL_MS / 1000)}s`);
      if (alive && backendStatus && backendStatus !== currentStatus) {
        await _refreshHostAfterActiveTool(ip);
      }
    } catch (e) {
      _appendHostPingLine(_hostPingTick, false, null, null, '', e.message || 'Error');
      $('#hostPingSummary').text(`Error comprobando conectividad: ${e.message || 'Error'}`);
      $('#hostPingMeta').text(`Intentos: ${_hostPingTick} · 1 paquete cada ~${Math.round(HOST_PING_INTERVAL_MS / 1000)}s`);
    } finally {
      _hostPingBusy = false;
    }
  }

  function _startHostPingLoop(ip) {
    _hostPingCurrentIp = ip;
    _hostPingTick = 0;
    _clearHostPingLog();
    _setHostPingButtons(true);
    $('#hostPingMeta').text(`1 paquete cada ~${Math.round(HOST_PING_INTERVAL_MS / 1000)}s`);
    _runHostPingOnce(ip);
    _hostPingTimer = setInterval(() => _runHostPingOnce(ip), HOST_PING_INTERVAL_MS);
  }

  function _normalizeDeviceTypeForCompare(value) {
    const raw = String(value || '').trim().toLowerCase();
    const localizedUnclassified = String(_hostT('host.unclassified', 'Unclassified') || '').trim().toLowerCase();
    if (!raw || raw === 'unknown' || raw === 'unclassified' || raw === 'sin clasificar' || (localizedUnclassified && raw === localizedUnclassified)) {
      return 'unknown';
    }
    return raw;
  }

  function _readPersistedClassificationFromHost() {
    const unclassified = _hostT('host.unclassified', 'Unclassified');
    const type = ($('#mClassTypeBadge').text() || $('#mDeviceTypeBadge').text() || unclassified).trim() || unclassified;
    const confidence = ($('#mClassConfidence').text() || $('#mDeviceConfidence').text() || '').trim();
    const source = ($('#mClassSource').text() || $('#mDeviceSource').text() || '').trim();
    const evidence = $('#mClassEvidence li').map(function(){ return $(this).text().trim(); }).get().filter(Boolean);
    return { type, confidence, source, evidence };
  }

  function _renderFingerprintPersistedPanel() {
    const info = _readPersistedClassificationFromHost();
    $('#hostFpPersisted').html(`
      <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
        <span class="badge badge-device-type ${info.type === _hostT('host.unclassified', 'Unclassified') ? 'opacity-75' : ''}">${esc(info.type)}</span>
        ${info.confidence ? `<span class="small-muted">${esc(info.confidence)}</span>` : ''}
      </div>
      ${info.source ? `<div class="small-muted mb-2">${esc(info.source)}</div>` : '<div class="small-muted mb-2">Sin fuente adicional guardada.</div>'}
      ${info.evidence.length ? `<ul class="ip-timeline mt-2">${info.evidence.map(item => `<li><div class="ip-dot"></div><div>${esc(item)}</div></li>`).join('')}</ul>` : `<div class="small-muted">${esc(_hostT('host.no_saved_evidence', 'No detailed evidence stored for this host.'))}</div>`}
    `);
  }

  function _clearFingerprintModal() {
    _lastFingerprintResult = null;
    _lastFingerprintPayload = null;
    $('#hostFpQuickResult').html('<div class="small-muted">Aún no se ha ejecutado una identificación en esta ventana.</div>');
    $('#hostFpOutput').html('<div class="small-muted">Sin salida todavía.</div>');
  }

  function _renderFingerprintQuickResult(data) {
    const summary = data?.summary || {};
    const classification = data?.classification || {};
    const persisted = _readPersistedClassificationFromHost();
    // quickType: preferir classification.device_type (calculado por classify_host_device)
    // sobre summary.device_type (línea literal nmap), que suele estar vacía en PCs.
    const quickType = String(
      classification.device_type && classification.device_type !== 'unknown'
        ? classification.device_type
        : (summary.device_type || classification.device_type || data?.device_type || '')
    ).trim() || _hostT('host.unclassified', 'Unclassified');

    _lastFingerprintPayload = data;

    const serviceInfo = (() => {
      if (String(summary.service_info || '').trim()) return String(summary.service_info).trim();
      if (Array.isArray(data?.port_clues) && data.port_clues.length) return data.port_clues.join(', ');
      if (Array.isArray(data?.services) && data.services.length) return data.services.join(', ');
      if (data?.services && typeof data.services === 'object') {
        return Object.entries(data.services)
          .map(([port, service]) => `${port}: ${service}`)
          .filter(Boolean)
          .join(', ');
      }
      return '';
    })();
    const ports = (() => {
      if (Array.isArray(summary.ports) && summary.ports.length) return summary.ports;
      if (Array.isArray(data?.open_ports) && data.open_ports.length) {
        return data.open_ports.map(port => {
          const svc = data?.services && typeof data.services === 'object'
            ? (data.services[port] || data.services[String(port)] || '')
            : '';
          return svc ? `${port}/tcp ${svc}` : `${port}/tcp`;
        });
      }
      return [];
    })();
    const outputLines = Array.isArray(data?.output_lines) && data.output_lines.length
      ? data.output_lines
      : (Array.isArray(data?.raw_lines) && data.raw_lines.length
          ? data.raw_lines
          : (typeof data?.output === 'string' && data.output.trim()
              ? data.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
              : []));
    const details = [
      ['Running', summary.running || data?.os_guess],
      ['OS details', summary.os_details],
      ['Service info', serviceInfo],
      ['Network distance', summary.network_distance],
      ['Fabricante MAC', summary.mac_vendor || data?.vendor],
    ].filter(([, value]) => String(value || '').trim());

    const persistenceNote = `<div class="alert alert-secondary py-2 px-3 mt-3 mb-0" style="font-size:.82rem">${esc(_hostT('host.fingerprint_persistence_note', 'Fingerprint point-in-time result. This run does not change the persisted host classification by itself.'))}</div>`;

    // Botón "Aplicar clasificación": solo si quickType es válido Y difiere del persistido
    const quickTypeCompare = _normalizeDeviceTypeForCompare(quickType);
    const persistedTypeCompare = _normalizeDeviceTypeForCompare(persisted.type);
    const showApply = quickTypeCompare !== 'unknown' && quickTypeCompare !== persistedTypeCompare;

    _lastFingerprintResult = showApply
      ? {
          device_type: quickType !== _hostT('host.unclassified', 'Unclassified') ? quickType : (classification.device_type || 'unknown'),
          device_confidence: classification.device_confidence ?? 0.0,
          device_source: 'fingerprint_manual',
          device_evidence: classification.device_evidence || [],
        }
      : null;

    const applyBtn = showApply
      ? `<div class="mt-3"><button id="hostFpApply" class="btn btn-sm btn-warning" data-quick-type="${esc(quickType)}">Aplicar clasificación: <strong>${esc(quickType)}</strong></button></div>`
      : '';

    const diffNote = showApply
      ? `<div class="alert alert-warning py-2 px-3 mt-3 mb-0" style="font-size:.82rem">El resultado puntual sugiere <strong>${esc(quickType)}</strong>, pero la clasificación persistida actual sigue siendo <strong>${esc(persisted.type)}</strong>.</div>`
      : '';

    $('#hostFpQuickResult').html(`
      <div class="d-flex align-items-center gap-2 flex-wrap mb-2">
        <span class="badge badge-device-type ${quickType === _hostT('host.unclassified', 'Unclassified') ? 'opacity-75' : ''}">${esc(quickType)}</span>
        <span class="small-muted">Return code: ${esc(String(data?.returncode ?? (data?.ok ? 0 : '—')))}</span>
      </div>
      ${details.length ? `<div class="row g-2">${details.map(([label, value]) => `<div class="col-md-6"><div class="small-muted">${esc(label)}</div><div>${esc(String(value))}</div></div>`).join('')}</div>` : '<div class="small-muted">Sin detalles destacados en este intento.</div>'}
      ${ports.length ? `<div class="mt-3"><div class="small-muted mb-1">Puertos detectados</div><div class="mono small">${ports.map(esc).join('<br>')}</div></div>` : '<div class="small-muted mt-3">Sin puertos destacados en el escaneo rápido.</div>'}
      ${persistenceNote}
      ${diffNote}
      ${applyBtn}
    `);
    $('#hostFpOutput').html(outputLines.length
      ? `<details open><summary class="small-muted">Mostrar / ocultar salida completa</summary><pre class="cfg-help-code mt-2" style="white-space:pre-wrap">${esc(outputLines.join('\n'))}</pre></details>`
      : '<div class="small-muted">nmap no devolvió salida útil.</div>'
    );
  }

  window.openHost = async function openHost(ip) {
    if (!ip) return;
    window.currentIp = currentIp = ip;
    _hostShowAllIntervals = false;
    hostModal.show();
    $('#mIp').text(ip);
    $('#mStatus').attr('class', 'badge bg-secondary').text(_hostT('host.loading', 'Loading…'));
    $('#mLastChangeText').text(_hostT('host.loading', 'Loading…'));
    $('#mLastChange').text('—');
    $('#mClassMeta').text(_hostT('host.loading', 'Loading…'));
    $('#mClassTypeBadge').text(_hostT('host.loading', 'Loading…'));
    $('#mClassConfidence').text('');
    $('#mClassSource').text('');
    $('#mClassEvidence').html(`<li><div class="ip-dot old"></div><div class="small-muted">${esc(_hostT('host.loading_classification', 'Loading classification…'))}</div></li>`);
    $('#mScanHistory').html(`<div class="small-muted">${esc(_hostT('host.loading_state_changes', 'Loading state changes…'))}</div>`);
    $('#mTimelineStrip').html(`<div class="small-muted">${esc(_hostT('host.loading_availability', 'Loading availability…'))}</div>`);
    $('#mTimelineAxis').html('');
    _hideTimelineTooltip();
    _stopHostPingLoop();
    hostPingModal?.hide();
    hostFingerprintModal?.hide();
    _clearFingerprintModal();
    try {
      await _loadHostDetailBundle(ip);
    } catch (e) {
      $('#mMsg').text(`${_hostT('host.error_detail', 'Error loading detail')}: ${e.message}`);
      throw e;
    }
  };

  $(document).on('click', '.uptime-range-btn', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    const days = parseInt($(this).data('days') || '7', 10) || 7;
    try { await _loadHostUptime(ip, days); } catch (e) { $('#mMsg').text(`${_hostT('host.error_uptime', 'Uptime error')}: ${e.message}`); }
  });

  $(document).on('click', '.uptime-view-btn', function () {
    _toggleHostUptimeView($(this).data('view') || 'chart');
  });

  let _hostLocaleRefreshInFlight = false;

  async function _refreshOpenHostModalForLocale() {
    const modalShown = document.getElementById('hostModal')?.classList.contains('show');
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!modalShown || !ip || _hostLocaleRefreshInFlight) return;
    _hostLocaleRefreshInFlight = true;
    try {
      await _loadHostDetailBundle(ip);
    } catch (e) {
      $('#mMsg').text(`${_hostT('host.error_detail', 'Error loading detail')}: ${e.message}`);
    } finally {
      _hostLocaleRefreshInFlight = false;
    }
  }

  document.addEventListener('langchange', () => { _refreshOpenHostModalForLocale(); });
  document.addEventListener('timezonechange', () => { _refreshOpenHostModalForLocale(); });

  $(document).on('click', '#tlBtnDay, #tlBtnWeek, #tlBtnMonth', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    const range = this.id === 'tlBtnWeek' ? 'week' : (this.id === 'tlBtnMonth' ? 'month' : 'day');
    try { await _loadHostTimeline(ip, range, ''); } catch (e) { $('#mMsg').text(`${_hostT('host.error_timeline', 'Timeline error')}: ${e.message}`); }
  });

  $(document).on('click', '#tlBtnDateGo', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    const date = ($('#mHostDatePicker').val() || '').trim();
    if (!ip || !date) return;
    try { await _loadHostTimeline(ip, 'day', date); } catch (e) { $('#mMsg').text(`${_hostT('host.error_timeline', 'Timeline error')}: ${e.message}`); }
  });

  $(document).on('mouseenter', '#mTimelineStrip .host-timeline-seg', function (e) {
    _showTimelineTooltip(this, e);
  });

  $(document).on('mousemove', '#mTimelineStrip .host-timeline-seg', function (e) {
    _moveTimelineTooltip(this, e);
  });

  $(document).on('mouseleave', '#mTimelineStrip .host-timeline-seg', function () {
    _hideTimelineTooltip();
  });

  $('#hostModal').on('hidden.bs.modal', function () {
    _hideTimelineTooltip();
  });

  $(document).on('click', '#btnScanHistory', function () {
    _renderAllIntervalsModal();
    hostHistoryModal?.show();
  });

  $(document).on('click', '#mToggleKnown', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    const rawKnown = String($(this).data('known') ?? '').trim().toLowerCase();
    const currentKnown = rawKnown === 'true' || rawKnown === '1' || rawKnown === 'yes' || rawKnown === 'y' || rawKnown === 'si' || rawKnown === 'sí' || rawKnown === 'on';
    const nextKnown = !currentKnown;
    setBtnLoading(this, true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/known`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ known: nextKnown }),
      }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      const resolvedKnown = data?.known === true || data?.known === 1 || data?.known === '1' || data?.known === 'true';
      const newLabel = _hostKnownToggleLabel(resolvedKnown);
      // Actualizar orig-html ANTES del finally para que setBtnLoading(false) restaure el label correcto
      $(this).data('orig-html', newLabel).data('known', resolvedKnown);
      $('#mKnownBadge').attr('class', `badge ms-1 ${resolvedKnown ? 'badge-known' : 'badge-unknown'}`).text(_hostBoolLabel(resolvedKnown));
      $('#mMsg').text(`✓ ${_hostT('host.known', 'Known')}: ${_hostBoolLabel(resolvedKnown)}`);
      await refreshActiveViews({ refreshHosts: true, refreshDashboard: true });
    } catch (e) {
      $('#mMsg').text(`${_hostT('host.error_known', 'Error changing known flag')}: ${e.message}`);
    } finally {
      setBtnLoading(this, false);
    }
  });

  $(document).on('click', '#mPing', function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    $('#hostPingTitleIp').text(ip);
    $('#hostPingTitleName').text(_hostActiveLabel() || ip);
    hostPingModal?.show();
    _startHostPingLoop(ip);
  });

  $(document).on('click', '#hostPingStart', function () {
    const ip = _hostPingCurrentIp || window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    $('#hostPingTitleIp').text(ip);
    $('#hostPingTitleName').text(_hostActiveLabel() || ip);
    _startHostPingLoop(ip);
  });

  $(document).on('click', '#hostPingStop', function () {
    _stopHostPingLoop();
    $('#hostPingSummary').text(_hostT('host.ping_stopped_msg', 'Continuous ping stopped.'));
  });

  $(document).on('click', '#hostPingClear', function () {
    _clearHostPingLog();
  });

  hostPingModalEl?.addEventListener('hidden.bs.modal', () => {
    _stopHostPingLoop();
  });

  $(document).on('click', '#mFingerprint', function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    $('#hostFpTitleIp').text(ip);
    $('#hostFpTitleName').text(_hostActiveLabel() || ip);
    _renderFingerprintPersistedPanel();
    _clearFingerprintModal();
    $('#hostFpRun').data('ip', ip);
    hostFingerprintModal?.show();
  });

  $(document).on('click', '#hostFpClear', function () {
    _clearFingerprintModal();
    _renderFingerprintPersistedPanel();
  });

  $(document).on('click', '#hostFpRun', async function () {
    const ip = $(this).data('ip') || window.currentIp || $('#mIp').text().trim();
    if (!ip || _hostFingerprintRunning) return;
    _hostFingerprintRunning = true;
    setBtnLoading(this, true);
    $('#hostFpQuickResult').html('<div class="small-muted">Ejecutando identificación…</div>');
    $('#hostFpOutput').html('<div class="small-muted">Esperando salida de nmap…</div>');
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/fingerprint`, { method: 'POST' }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      await _refreshHostAfterActiveTool(ip);
      _renderFingerprintPersistedPanel();
      _renderFingerprintQuickResult(data);
      const quickType = String(data?.summary?.device_type || data?.classification?.device_type || data?.device_type || '').trim();
      $('#mMsg').text(quickType ? `✓ Identificación puntual ejecutada · ${quickType}` : '✓ Identificación puntual ejecutada');
    } catch (e) {
      $('#hostFpQuickResult').html(`<div class="alert alert-danger py-2 px-3 mb-0">${esc(e.message || 'Error')}</div>`);
      $('#hostFpOutput').html('<div class="small-muted">Sin salida por error.</div>');
      $('#mMsg').text(`${_hostT('host.error_identifying', 'Error identifying')}: ${e.message}`);
    } finally {
      _hostFingerprintRunning = false;
      setBtnLoading(this, false);
    }
  });

  hostFingerprintModalEl?.addEventListener('hidden.bs.modal', () => {
    _hostFingerprintRunning = false;
    _lastFingerprintResult = null;
  });

  $(document).on('click', '#hostFpApply', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip || !_lastFingerprintResult) return;
    setBtnLoading(this, true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/apply-classification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_lastFingerprintResult),
      }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      // Refrescar el bundle del host para que el panel persistido muestre el nuevo valor
      await _refreshHostAfterActiveTool(ip);
      _renderFingerprintPersistedPanel();
      if (_lastFingerprintPayload) {
        _renderFingerprintQuickResult(_lastFingerprintPayload);
      }
      $('#mMsg').text(`✓ Clasificación aplicada: ${esc(data.device_type || _lastFingerprintResult?.device_type || 'unknown')}`);
    } catch (e) {
      $('#mMsg').text(`${_hostT('host.error_apply_classification', 'Error applying classification')}: ${e.message}`);
    } finally {
      setBtnLoading(this, false);
    }
  });

$(document).on('click', '#mClearMac', async function () {
    const ip = window.currentIp || $('#mIp').text().trim();
    if (!ip) return;
    setBtnLoading(this, true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/clear-mac`, { method: 'POST' }).then(r => r.json());
      if (!data?.ok) throw new Error(data?.error || 'Error');
      await refreshActiveViews({ refreshHosts: true, refreshDashboard: true, reopenIp: ip });
      $('#mMsg').text('✓ MAC limpiada');
    } catch (e) {
      $('#mMsg').text(`${_hostT('host.error_clear_mac', 'Error clearing MAC')}: ${e.message}`);
    } finally {
      setBtnLoading(this, false);
    }
  });

  // ── L. Quality config ─────────────────────────────────────────────────────────
  (function initQualityConfig() {
    const ifaceSel  = document.getElementById('qualityInterface');
    const detectBtn = document.getElementById('qualityDetectInterfaces');
    const saveBtn   = document.getElementById('qualitySaveSettings');
    if (!ifaceSel || !saveBtn) return;

    async function loadInterfaces(selected = '') {
      try {
        const data  = await fetch('/api/quality/interfaces').then(r => r.json());
        const items = data.interfaces || [];
        ifaceSel.innerHTML = '<option value="">— automática —</option>' + items.map(i => {
          const addrs = i.addrs?.length ? ` (${i.addrs.join(', ')})` : '';
          return `<option value="${i.name}"${selected === i.name ? ' selected' : ''}>${i.name}${addrs}</option>`;
        }).join('');
        if (selected && !items.find(i => i.name === selected))
          ifaceSel.insertAdjacentHTML('beforeend', `<option value="${selected}" selected>${selected}</option>`);
      } catch (e) { console.error('quality loadInterfaces:', e); }
    }

    async function loadSettings() {
      try {
        const s = (await fetch('/api/quality/settings').then(r => r.json())).settings || {};
        const get = id => document.getElementById(id);
        get('qualityEnabled')?.setAttribute  ('checked', !!Number(s.enabled ?? 0));
        if (get('qualityEnabled'))    get('qualityEnabled').checked    = !!Number(s.enabled ?? 0);
        if (get('qualityThreshold'))  get('qualityThreshold').value    = s.alert_threshold_pct ?? 200;
        if (get('qualityCooldown'))   get('qualityCooldown').value     = s.alert_cooldown_minutes ?? 30;
        if (get('qualityQuietStart')) get('qualityQuietStart').value   = s.quiet_start || '';
        if (get('qualityQuietEnd'))   get('qualityQuietEnd').value     = s.quiet_end || '';
        await loadInterfaces(s.quality_interface || '');
      } catch (e) { console.error('quality loadSettings:', e); }
    }

    detectBtn?.addEventListener('click', async function () {
      this.querySelector('i')?.classList.add('spin');
      await loadInterfaces(ifaceSel.value || '');
      this.querySelector('i')?.classList.remove('spin');
    });

    saveBtn.addEventListener('click', async function () {
      const oldHtml = this.innerHTML;
      this.disabled = true;
      this.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Guardando';
      try {
        await fetch('/api/quality/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled:                document.getElementById('qualityEnabled')?.checked ? 1 : 0,
            alert_threshold_pct:    Number(document.getElementById('qualityThreshold')?.value || 200),
            alert_cooldown_minutes: Number(document.getElementById('qualityCooldown')?.value || 30),
            quiet_start:            document.getElementById('qualityQuietStart')?.value || '',
            quiet_end:              document.getElementById('qualityQuietEnd')?.value || '',
            quality_interface:      ifaceSel.value || '',
          })
        });
      } catch (e) { console.error('quality save:', e); }
      finally { this.disabled = false; this.innerHTML = oldHtml; }
    });

    loadSettings();
  })();

});
