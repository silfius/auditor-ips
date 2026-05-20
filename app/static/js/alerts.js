// ════════════════════════════════════════════════════════
//  alerts.js — Auditor IPs · Alertas programables
//  CRUD alertas, modal edición, toggle, test Discord
// ════════════════════════════════════════════════════════
$(function() {
  const TRIGGER_LABELS = {
    new_host: '🆕 Nuevo host', offline: '🔴 Offline', offline_for: '🔴⏱ Offline prolongado',
    online: '🟢 Online', status_change: '🔄 Cambio estado', ip_change: '🔀 Cambio IP'
  };

  function fmtAlertDateTime(value) {
    if (!value) return '<span class="small-muted">Nunca</span>';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted && formatted !== '—' ? esc(formatted) : '<span class="small-muted">Nunca</span>';
    }
    return '<span class="small-muted">Nunca</span>';
  }

  // Mostrar/ocultar campo de filtro valor
  $('#alFilterMode').on('change', function() {
    const mode = $(this).val();
    $('#alFilterValueWrap').toggle(mode !== 'all');
    $('#alFilterValueIp').toggle(mode === 'ip');
    $('#alFilterValueType').toggle(mode === 'type_id');
    $('#alFilterLabel').text(mode === 'ip' ? 'IP' : 'Tipo');
  });

  window.loadAlerts = async function loadAlerts() {
    const res  = await fetch('/api/alerts');
    const data = await res.json();
    if (!data.ok) return;

    const tbody = $('#alertsTbody');
    tbody.empty();

    if (data.alerts.length === 0) {
      tbody.append('<tr><td colspan="7" class="small-muted text-center">Sin alertas configuradas</td></tr>');
      return;
    }

    for (const a of data.alerts) {
      const filterDesc = a.filter_mode === 'all' ? 'Todos'
                       : a.filter_mode === 'ip'  ? `IP: <code>${esc(a.filter_value||'')}</code>`
                       : `Tipo: <span class="badge bg-secondary">${esc(a.type_name||a.filter_value||'')}</span>`;
      const stateBadge = a.enabled
        ? '<span class="badge badge-active">Activa</span>'
        : '<span class="badge badge-inactive">Pausada</span>';
      const lastFired = fmtAlertDateTime(a.last_fired);
      const cdText = a.cooldown_minutes > 0 ? `${a.cooldown_minutes}min` : 'Sin cooldown';

      tbody.append(`
        <tr class="${a.enabled ? '' : 'alert-row-disabled'}" data-alert-id="${a.id}">
          <td><strong>${esc(a.name)}</strong></td>
          <td><span class="badge badge-trigger bg-secondary">${esc(TRIGGER_LABELS[a.trigger_type]||a.trigger_type)}</span></td>
          <td>${filterDesc}</td>
          <td class="small-muted">${cdText}</td>
          <td class="small-muted">${lastFired}</td>
          <td>${stateBadge}</td>
          <td>
            <div class="d-flex gap-1">
              <button class="btn btn-outline-secondary btn-sm btn-ico btn-alert-edit" data-id="${a.id}" title="${esc(window.t?.('alerts.edit_title', 'Editar alerta') || 'Editar alerta')}">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-outline-warning btn-sm btn-ico btn-alert-toggle" data-id="${a.id}" title="${esc(a.enabled ? (window.t?.('common.pause', 'Pausar') || 'Pausar') : (window.t?.('common.activate', 'Activar') || 'Activar'))}">
                <i class="bi bi-${a.enabled?'pause':'play'}-fill"></i>
              </button>
              <button class="btn btn-outline-info btn-sm btn-ico btn-alert-test" data-id="${a.id}" title="${esc(window.t?.('alerts.test_title', 'Probar alerta (envía test a Discord)') || 'Probar alerta (envía test a Discord)')}">
                <i class="bi bi-send"></i>
              </button>
              <button class="btn btn-outline-danger btn-sm btn-ico btn-alert-del" data-id="${a.id}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}">
                <i class="bi bi-trash3"></i>
              </button>
            </div>
          </td>
        </tr>
      `);
    }
  }

  // Cargar alertas al entrar en la pestaña
  // alerts-tab: also see loadAlertsWithEdit listener below

  // Añadir alerta
  $('#alAdd').on('click', async function() {
    const name    = ($('#alName').val()||'').trim();
    const trigger = $('#alTrigger').val();
    const fmode   = $('#alFilterMode').val();
    const fvalue  = fmode === 'ip'      ? ($('#alFilterValueIp').val()||'').trim()
                  : fmode === 'type_id' ? $('#alFilterValueType').val()
                  : '';
    const cooldown = parseInt($('#alCooldown').val()||'0');
    if (!name) { $('#alMsg').text('⚠ Nombre vacío'); return; }

    $('#alMsg').text('Guardando…');
    const res = await fetch('/api/alerts', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, trigger_type: trigger, filter_mode: fmode, filter_value: fvalue, cooldown_minutes: cooldown, action: 'discord' })
    });
    const data = await res.json();
    if (!data.ok) { $('#alMsg').text('Error: '+(data.error||'?')); return; }
    $('#alMsg').text('✓ Añadida');
    $('#alName').val('');
    await loadAlerts();
    setTimeout(()=>$('#alMsg').text(''), 3000);
  });

  // Toggle / Test / Delete
  $(document).on('click', '.btn-alert-toggle', async function() {
    const id = $(this).data('id');
    await fetch(`/api/alerts/${id}/toggle`, {method:'POST'});
    await loadAlerts();
  });
  $(document).on('click', '.btn-alert-test', async function() {
    const id = $(this).data('id');
    const res  = await fetch(`/api/alerts/${id}/test`, {method:'POST'});
    const data = await res.json();
    $('#alMsg').text(data.ok ? '✓ Test enviado' : '✗ '+data.discord_error);
    setTimeout(()=>$('#alMsg').text(''), 4000);
  });
  $(document).on('click', '.btn-alert-del', async function() {
    const id = $(this).data('id');
    if (!(await window.appConfirm('¿Eliminar esta alerta?', {
      title: 'Eliminar alerta',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    await fetch(`/api/alerts/${id}`, {method:'DELETE'});
    await loadAlerts();
  });

  // ══════════════════════════════════════════════════
  // #25 HISTÓRICO DE UPTIME en modal — Sesión 7
  //   Gráfica de barras apiladas online/offline
  //   Selector de rango 7D/30D/90D
  //   Toggle chart/grid
  // ══════════════════════════════════════════════════
  const TRIGGER_LABELS_EXT = {
    'new_host': '🆕 Nuevo host', 'offline': '🔴 Offline',
    'offline_for': '🔴⏱ Offline prolongado',
    'online': '🟢 Online', 'status_change': '🔄 Cambio estado',
    'ip_change': '🔀 Cambio IP'
  };

  $('#alTrigger').on('change', function() {
    const show = this.value === 'offline_for';
    document.getElementById('alMinDownWrap').style.display = show ? '' : 'none';
  });

  // Override alAdd to include min_down_minutes
  $('#alAdd').off('click').on('click', async function() {
    const name    = ($('#alName').val()||'').trim();
    const trigger = $('#alTrigger').val();
    const fmode   = $('#alFilterMode').val();
    const fvalue  = fmode === 'ip'      ? ($('#alFilterValueIp').val()||'').trim()
                  : fmode === 'type_id' ? $('#alFilterValueType').val()
                  : '';
    const cooldown  = parseInt($('#alCooldown').val()||'0');
    const min_down  = parseInt($('#alMinDown').val()||'0');
    if (!name) { $('#alMsg').text('⚠ Nombre vacío'); return; }

    $('#alMsg').text('Guardando…');
    const res = await fetch('/api/alerts', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, trigger_type: trigger, filter_mode: fmode,
        filter_value: fvalue, cooldown_minutes: cooldown,
        min_down_minutes: min_down, action: 'discord' })
    });
    const data = await res.json();
    if (!data.ok) { $('#alMsg').text('Error: '+(data.error||'?')); return; }
    $('#alMsg').text('✓ Añadida');
    $('#alName').val('');
    await loadAlerts();
    setTimeout(()=>$('#alMsg').text(''), 3000);
  });


  // ══════════════════════════════════════════════════════════
  // DASHBOARD PERSONALIZABLE
  // ══════════════════════════════════════════════════════════
  const _alertEditModal = new bootstrap.Modal(document.getElementById('alertEditModal'));
  let _alertEditData = {};

  // Store all alert data in rows for editing
  let _allAlerts = [];

  // Override loadAlerts to save data
  const _origLoadAlerts = window.loadAlerts;
  window.loadAlertsWithEdit = async function loadAlertsWithEdit() {
    const res  = await fetch('/api/alerts');
    const data = await res.json();
    if (!data.ok) return;
    _allAlerts = data.alerts;

    const tbody = $('#alertsTbody');
    tbody.empty();
    if (!data.alerts.length) {
      tbody.append('<tr><td colspan="8" class="small-muted text-center">Sin alertas configuradas</td></tr>');
      return;
    }
    for (const a of data.alerts) {
      const filterDesc = a.filter_mode === 'all' ? 'Todos'
                       : a.filter_mode === 'ip'  ? `IP: <code>${esc(a.filter_value||'')}</code>`
                       : `Tipo: <span class="badge bg-secondary">${esc(a.type_name||a.filter_value||'')}</span>`;
      const stateBadge = a.enabled
        ? '<span class="badge badge-active">Activa</span>'
        : '<span class="badge badge-inactive">Pausada</span>';
      const lastFired = fmtAlertDateTime(a.last_fired);
      const cdText = a.cooldown_minutes > 0 ? `${a.cooldown_minutes}min` : 'Sin cooldown';
      tbody.append(`
        <tr class="${a.enabled ? '' : 'alert-row-disabled'}" data-alert-id="${a.id}">
          <td><strong>${esc(a.name)}</strong></td>
          <td><span class="badge badge-trigger bg-secondary">${esc(TRIGGER_LABELS[a.trigger_type]||a.trigger_type)}</span></td>
          <td>${filterDesc}</td>
          <td class="small-muted">${cdText}</td>
          <td class="small-muted">${lastFired}</td>
          <td>${stateBadge}</td>
          <td>
            <div class="d-flex gap-1">
              <button class="btn btn-outline-secondary btn-sm btn-ico btn-alert-edit" data-id="${a.id}" title="${esc(window.t?.('common.edit', 'Editar') || 'Editar')}"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-outline-warning btn-sm btn-ico btn-alert-toggle" data-id="${a.id}" title="${esc(a.enabled ? (window.t?.('common.pause', 'Pausar') || 'Pausar') : (window.t?.('common.activate', 'Activar') || 'Activar'))}"><i class="bi bi-${a.enabled?'pause':'play'}-fill"></i></button>
              <button class="btn btn-outline-info btn-sm btn-ico btn-alert-test" data-id="${a.id}" title="${esc(window.t?.('alerts.test_discord', 'Test Discord') || 'Test Discord')}"><i class="bi bi-send"></i></button>
              <button class="btn btn-outline-danger btn-sm btn-ico btn-alert-del" data-id="${a.id}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
            </div>
          </td>
        </tr>
      `);
    }
  }
  function _alertsPaneIsActive() {
    const tab = document.getElementById('alerts-tab');
    const pane = document.getElementById('alertsView');
    return !!(
      tab?.classList.contains('active') ||
      pane?.classList.contains('active') ||
      pane?.classList.contains('show')
    );
  }

  function _refreshAlertsIfVisible() {
    if (_alertsPaneIsActive()) {
      window.loadAlertsWithEdit?.();
    }
  }

  // Replace the global loadAlerts
  window.loadAlerts = loadAlertsWithEdit;
  const alertsTabEl = document.getElementById('alerts-tab');
  if (alertsTabEl) {
    alertsTabEl.addEventListener('shown.bs.tab', loadAlertsWithEdit);
  }
  document.addEventListener('shown.bs.tab', function(e) {
    if (e.target?.id === 'alerts-tab') loadAlertsWithEdit();
  });
  setTimeout(_refreshAlertsIfVisible, 80);

  // Edit button click → open modal with data
  $(document).on('click', '.btn-alert-edit', function() {
    const id = parseInt($(this).data('id'));
    const a = _allAlerts.find(x => x.id === id);
    if (!a) return;
    $('#alertEditId').val(a.id);
    $('#alertEditName').val(a.name);
    $('#alertEditTrigger').val(a.trigger_type);
    $('#alertEditFilterMode').val(a.filter_mode);
    $('#alertEditCooldown').val(a.cooldown_minutes);
    $('#alertEditMinDown').val(a.min_down_minutes || 5);
    $('#alertEditEnabled').prop('checked', !!a.enabled);
    // Filter value
    const fm = a.filter_mode;
    $('#alertEditFilterValueWrap').toggle(fm !== 'all');
    $('#alertEditFilterValueIp').toggle(fm === 'ip').val(fm === 'ip' ? (a.filter_value||'') : '');
    $('#alertEditFilterValueType').toggle(fm === 'type_id');
    if (fm === 'type_id') $('#alertEditFilterValueType').val(a.filter_value||'');
    $('#alertEditMinDownWrap').toggle(a.trigger_type === 'offline_for');
    $('#alertEditMsg').text('');
    _alertEditModal.show();
  });

  // Edit modal filter mode change
  $('#alertEditFilterMode').on('change', function() {
    const v = $(this).val();
    $('#alertEditFilterValueWrap').toggle(v !== 'all');
    $('#alertEditFilterValueIp').toggle(v === 'ip');
    $('#alertEditFilterValueType').toggle(v === 'type_id');
  });
  $('#alertEditTrigger').on('change', function() {
    $('#alertEditMinDownWrap').toggle($(this).val() === 'offline_for');
  });

  // Save edit
  $('#alertEditSave').on('click', async function() {
    const id = $('#alertEditId').val();
    const fm = $('#alertEditFilterMode').val();
    const fv = fm === 'ip' ? $('#alertEditFilterValueIp').val() : fm === 'type_id' ? $('#alertEditFilterValueType').val() : '';
    const payload = {
      name: $('#alertEditName').val().trim(),
      trigger_type: $('#alertEditTrigger').val(),
      filter_mode: fm,
      filter_value: fv,
      cooldown_minutes: parseInt($('#alertEditCooldown').val()||'0'),
      min_down_minutes: parseInt($('#alertEditMinDown').val()||'0'),
      enabled: $('#alertEditEnabled').prop('checked') ? 1 : 0,
      action: 'discord'
    };
    $('#alertEditMsg').text('Guardando…');
    const res = await fetch(`/api/alerts/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) { $('#alertEditMsg').text('Error: '+(data.error||'?')); return; }
    _alertEditModal.hide();
    await loadAlertsWithEdit();
  });

  // ══════════════════════════════════════════════════════════
  // CALIDAD DE CONEXIÓN
  // ══════════════════════════════════════════════════════════

}); // end $(function) — alerts.js
