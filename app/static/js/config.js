// ════════════════════════════════════════════════════════
//  config.js — Auditor IPs · Configuración  (Sesión 28)
//  Secciones:
//  ① Multi-CIDR chips
//  ② Config form load/save
//  ③ Router SSH
//  ④ WoL público
//  ⑤ Idioma
//  ⑥ Apariencia (temas, acento, animaciones)
//  ⑦ SMTP email
//  ⑧ Pestañas ocultables
//  ⑨ Tipos (en config)
//  ⑩ Push notifications + VAPID
//  ⑪ Backup / base de datos
//  ⑫ Búsqueda global
//  ⑬ Tags del host modal
//  ⑭ Exportación periódica
//  ⑮ Scripts monitorizados
//  ⑯ IA settings
//  ⑰ Redes (Networks)
//  ⑱ Discrepancias
//  ⑲ Motor de detección
//  ⑳ Config modal: listener único de apertura
//  ㉑ Alertas por script
//  ㉒ Historial informes IA de red
//  ㉓ Exportación histórica
// ════════════════════════════════════════════════════════
$(function () {

  // ══════════════════════════════════════════════════════════
  // ① MULTI-CIDR CHIPS
  // ══════════════════════════════════════════════════════════

  let _cidrList = [];

  function _isValidCidr(v) { return /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v.trim()); }

  function _renderCidrChips(list) {
    _cidrList = list.filter(Boolean);
    const wrap = document.getElementById('cidrChipsList');
    if (!wrap) return;
    wrap.innerHTML = '';
    _cidrList.forEach((cidr, i) => {
      const chip = document.createElement('span');
      chip.className = 'cidr-chip ' + (_isValidCidr(cidr) ? 'valid' : 'invalid');
      chip.innerHTML = `${cidr} <span class="remove-chip" data-i="${i}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}">×</span>`;
      wrap.appendChild(chip);
    });
  }

  function _getCidrValue() { return _cidrList.join(','); }

  function _addCidrChip(val) {
    val.split(',').map(x => x.trim()).filter(Boolean).forEach(p => {
      if (!_cidrList.includes(p)) _cidrList.push(p);
    });
    _renderCidrChips(_cidrList);
    const msg = document.getElementById('cidrValidationMsg');
    if (msg) {
      const invalid = _cidrList.filter(c => !_isValidCidr(c));
      msg.textContent = invalid.length ? `⚠️ CIDR inválido: ${invalid.join(', ')}` : '';
      msg.style.color = invalid.length ? '#ff7878' : '#4dffb5';
    }
  }

  $(document).on('keydown', '#cidrNewInput', function (e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = $(this).val().trim().replace(/,$/, '');
      if (val) { _addCidrChip(val); $(this).val(''); }
    } else if (e.key === 'Backspace' && !$(this).val() && _cidrList.length) {
      _cidrList.pop(); _renderCidrChips(_cidrList);
    }
  });
  $(document).on('paste', '#cidrNewInput', function () {
    setTimeout(() => {
      const val = $(this).val().trim();
      if (val) { _addCidrChip(val); $(this).val(''); }
    }, 10);
  });
  $(document).on('click', '.remove-chip', function (e) {
    e.stopPropagation();
    _cidrList.splice(parseInt($(this).data('i')), 1);
    _renderCidrChips(_cidrList);
  });

  // Topbar ranges display
  let _topbarRangesRefreshSeq = 0;
  let _topbarRangesRefreshTimer = null;

  function _renderTopbarRanges(primary = [], secondary = []) {
    const el = document.getElementById('topbarCidrPill');
    if (!el) return;
    const seen = new Set();
    const items = [...primary, ...secondary]
      .map(v => typeof v === 'string'
        ? { kind: 'primary', label: '', cidr: v }
        : {
            kind: String(v?.kind || 'primary').trim().toLowerCase() === 'secondary' ? 'secondary' : 'primary',
            label: String(v?.label || '').trim(),
            cidr: String(v?.cidr || '').trim(),
          })
      .filter(v => v.cidr)
      .filter(v => {
        const key = `${v.kind}||${v.label}||${v.cidr}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (!items.length) {
      el.innerHTML = '';
      return;
    }

    el.innerHTML = items.map(v => {
      const icon = v.kind === 'secondary'
        ? '<i class="bi bi-diagram-3 topbar-range-icon secondary"></i>'
        : '<i class="bi bi-broadcast topbar-range-icon"></i>';
      return `<div class="topbar-range-row">${icon}` +
        `<span class="topbar-range-label">${esc(v.label || '')}</span>` +
        `<span class="mono topbar-range-cidr">${esc(v.cidr)}</span></div>`;
    }).join('');
  }

  function _normalizeTopbarRangesPayload(settings = {}, networks = []) {
    const primaryLabel = String(settings.primary_net_label || '').trim();
    const secondary = (Array.isArray(networks) ? networks : [])
      .map(n => ({
        kind: 'secondary',
        label: String(n?.label || '').trim(),
        cidr: String(n?.cidr || '').trim(),
      }))
      .filter(n => n.cidr);

    const secondaryCidrs = new Set(secondary.map(n => n.cidr));
    const rawPrimaryCidrs = String(settings.scan_cidr || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

    const primary = rawPrimaryCidrs
      .filter(cidr => !secondaryCidrs.has(cidr))
      .map(cidr => ({ kind: 'primary', label: primaryLabel, cidr }));

    if (!primary.length && rawPrimaryCidrs[0] && !secondaryCidrs.has(rawPrimaryCidrs[0])) {
      primary.push({ kind: 'primary', label: primaryLabel, cidr: rawPrimaryCidrs[0] });
    }

    return { primary, secondary };
  }

  async function _refreshTopbarRangesFromState() {
    const seq = ++_topbarRangesRefreshSeq;
    try {
      const [sRes, nRes] = await Promise.all([
        fetch('/api/settings').then(r => r.json()).catch(() => ({ settings: {} })),
        fetch('/api/config/networks').then(r => r.json()).catch(() => ({ networks: [] })),
      ]);
      if (seq !== _topbarRangesRefreshSeq) return;
      const settings = sRes.settings || {};
      const networks = nRes.networks || settings.secondary_networks || [];
      const { primary, secondary } = _normalizeTopbarRangesPayload(settings, networks);
      _renderTopbarRanges(primary, secondary);
      _renderTopbarNetworkScanInterval(settings);
    } catch (_) {}
  }

  function _queueTopbarRangesRefresh(delay = 0) {
    clearTimeout(_topbarRangesRefreshTimer);
    _topbarRangesRefreshTimer = setTimeout(() => { _refreshTopbarRangesFromState(); }, delay);
  }

  function _humanizeSecs(s) {
    s = parseInt(s) || 0;
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }


  let _networkScanIntervalSecs = null;
  let _networkNextScanAtMs = null;
  let _networkNextScanTimer = null;

  function _humanizeRemainingSecs(s) {
    s = Math.max(0, parseInt(s, 10) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function _renderTopbarNextNetworkScan() {
    const el = document.getElementById('networkNextScanLabel');
    if (!el) return;
    if (!Number.isFinite(_networkNextScanAtMs) || !Number.isFinite(_networkScanIntervalSecs) || _networkScanIntervalSecs <= 0) {
      el.textContent = '—';
      return;
    }
    const remaining = Math.max(0, Math.ceil((_networkNextScanAtMs - Date.now()) / 1000));
    el.textContent = _humanizeRemainingSecs(remaining);
  }

  function _startTopbarNextScanTimer() {
    if (_networkNextScanTimer) clearInterval(_networkNextScanTimer);
    _networkNextScanTimer = setInterval(() => {
      if (!Number.isFinite(_networkNextScanAtMs)) return;
      if (Date.now() >= _networkNextScanAtMs && Number.isFinite(_networkScanIntervalSecs) && _networkScanIntervalSecs > 0) {
        _networkNextScanAtMs += (_networkScanIntervalSecs * 1000);
      }
      _renderTopbarNextNetworkScan();
    }, 1000);
  }

  function _extractLatestScanStartedAt(data) {
    const rows = Array.isArray(data)
      ? data
      : (Array.isArray(data?.scans) ? data.scans : (Array.isArray(data?.items) ? data.items : []));
    if (!rows.length) return null;
    const row = rows[0] || {};
    return row.started_at || row.start || row.start_time || row.created_at || null;
  }

  async function _refreshTopbarNextNetworkScan(settings = null) {
    const intervalSecs = parseInt(settings?.scan_interval ?? _networkScanIntervalSecs, 10);
    _networkScanIntervalSecs = Number.isFinite(intervalSecs) && intervalSecs > 0 ? intervalSecs : null;
    if (!_networkScanIntervalSecs) {
      _networkNextScanAtMs = null;
      _renderTopbarNextNetworkScan();
      return;
    }
    try {
      const res = await fetch('/api/scans', { cache: 'no-store' });
      const data = await res.json();
      const startedAt = _extractLatestScanStartedAt(data);
      if (!startedAt) {
        _networkNextScanAtMs = null;
        _renderTopbarNextNetworkScan();
        return;
      }
      const lastStartMs = Date.parse(startedAt);
      if (!Number.isFinite(lastStartMs)) {
        _networkNextScanAtMs = null;
        _renderTopbarNextNetworkScan();
        return;
      }
      const intervalMs = _networkScanIntervalSecs * 1000;
      const now = Date.now();
      let nextAt = lastStartMs + intervalMs;
      if (nextAt <= now) {
        const steps = Math.floor((now - lastStartMs) / intervalMs) + 1;
        nextAt = lastStartMs + (steps * intervalMs);
      }
      _networkNextScanAtMs = nextAt;
      _renderTopbarNextNetworkScan();
      _startTopbarNextScanTimer();
    } catch (_) {
      _networkNextScanAtMs = null;
      _renderTopbarNextNetworkScan();
    }
  }

  function _renderTopbarNetworkScanInterval(settings = {}) {
    const el = document.getElementById('networkScanIntervalLabel');
    if (!el) return;
    const secs = parseInt(settings?.scan_interval, 10);
    _networkScanIntervalSecs = Number.isFinite(secs) && secs > 0 ? secs : null;
    el.textContent = _networkScanIntervalSecs ? _humanizeSecs(_networkScanIntervalSecs) : '—';
    _refreshTopbarNextNetworkScan(settings);
  }


  // ══════════════════════════════════════════════════════════
  // ② CONFIG FORM LOAD / SAVE
  // ══════════════════════════════════════════════════════════

  let _cfgData = {};

  function populateCfgForm(s) {
    _cfgData = s;
    // Scan settings — la BD usa scan_cidr (no scan_range)
    const $cidr = $('#cidrInput'); if ($cidr.length) { $cidr.val(s.scan_cidr || ''); _renderCidrChips((s.scan_cidr||'').split(',').map(x=>x.trim()).filter(Boolean)); }
    const $int  = $('#intervalInput'); if ($int.length) $int.val(s.scan_interval || 900);
    const $iSel = $('#intervalSelect');
    if ($iSel.length) {
      const v = String(s.scan_interval || 900);
      const known = ['300','600','900','1800','3600','7200','86400'];
      if (!known.includes(v)) $iSel.append(`<option value="${v}">${_humanizeSecs(parseInt(v))} (personalizado)</option>`);
      $iSel.val(v);
    }
    const $boot = $('#bootScan'); if ($boot.length) $boot.prop('checked', !!s.scan_on_boot);

    // Notifications
    ['discord_webhook','telegram_token','telegram_chat_id'].forEach(k => {
      const $el = $(`#cfg_${k}`); if ($el.length) $el.val(s[k] || '');
    });
    // SMTP — la BD usa smtp_pass (no smtp_password)
    ['smtp_host','smtp_port','smtp_user','smtp_from','smtp_to'].forEach(k => {
      const $el = $(`#cfg_${k}`); if ($el.length) $el.val(s[k] || '');
    });
    const $smtpPass = $('#cfg_smtp_password'); if ($smtpPass.length) $smtpPass.val(s.smtp_pass || '');
    const $smtpEnabled = $('#cfg_smtp_enabled'); if ($smtpEnabled.length) $smtpEnabled.prop('checked', s.smtp_enabled === '1' || s.smtp_enabled === 1);
    const $tls = $('#cfg_smtp_tls'); if ($tls.length) $tls.val(s.smtp_tls || 'starttls');

    // BEGIN SMTP modern compatibility load
    // La UI actual usa IDs camelCase. Esta compatibilidad evita que rutas legacy
    // de carga de Configuración dejen los campos SMTP/notificaciones sin poblar.
    if ($('#cfgSmtpEnabled').length) $('#cfgSmtpEnabled').prop('checked', s.smtp_enabled === '1' || s.smtp_enabled === 1 || s.smtp_enabled === true);
    if ($('#cfgSmtpHost').length) $('#cfgSmtpHost').val(s.smtp_host || '');
    if ($('#cfgSmtpPort').length) $('#cfgSmtpPort').val(s.smtp_port || 587);
    if ($('#cfgSmtpTls').length) $('#cfgSmtpTls').val(s.smtp_tls || 'starttls');
    if ($('#cfgSmtpUser').length) $('#cfgSmtpUser').val(s.smtp_user || '');
    if ($('#cfgSmtpTo').length) $('#cfgSmtpTo').val(s.smtp_to || '');
    if ($('#cfgSmtpFrom').length) $('#cfgSmtpFrom').val(s.smtp_from || '');
    // END SMTP modern compatibility load

    // Alerts — la BD usa notify_new (no notify_new_host)
    const $na = $('#cfg_notify_new');     if ($na.length) $na.prop('checked', s.notify_new === '1' || !!s.notify_new);
    const $no = $('#cfg_notify_offline'); if ($no.length) $no.prop('checked', s.notify_offline === '1' || !!s.notify_offline);
    const $ev = $('#cfg_event_types');    if ($ev.length) {
      const types = (s.alert_event_types || '').split(',').map(x => x.trim()).filter(Boolean);
      $ev.find('input[type=checkbox]').each(function () {
        $(this).prop('checked', types.includes($(this).val()) || !types.length);
      });
    }

    // Auth
    const $authEnabled = $('#cfgAuthEnabled'); if ($authEnabled.length) $authEnabled.prop('checked', !!s.auth_enabled);

    // Topbar: reflejar también el intervalo real del scan.
    _renderTopbarNetworkScanInterval(s || {});

    // Language
    if (s.ui_lang) _updateLangBtns(s.ui_lang);
  }

  // Save settings
  $(document).on('click', '#cfgSave', async function () {
    const $btn = $(this); $btn.prop('disabled', true);
    const $status = $('#cfgSaveStatus');
    $status.css('display', 'inline-flex');
    $status.removeClass('ok err').text('Guardando…').addClass('ok');

    const interval = (typeof window._cfgReadScanInterval === 'function')
      ? window._cfgReadScanInterval()
      : (parseInt($('#cfgInterval').val() || $('#intervalSelect').val() || $('#intervalInput').val() || 900, 10) || 900);
    const cidrVal  = (typeof window._cfgReadPrimaryCidr === 'function')
      ? window._cfgReadPrimaryCidr()
      : (_getCidrValue() || ($('#cidrInput').val() || '').trim());

    // BEGIN cfgSave modern id helpers
    // cfgSave es una ruta legacy todavía viva. Debe leer primero los IDs actuales
    // para no guardar valores vacíos sobre SMTP/notificaciones.
    const _cfgSaveVal = (...ids) => {
      for (const id of ids) {
        const $el = $('#' + id);
        if ($el.length) return $el.val() || '';
      }
      return '';
    };
    const _cfgSaveChecked = (...ids) => {
      for (const id of ids) {
        const $el = $('#' + id);
        if ($el.length) return $el.is(':checked');
      }
      return false;
    };
    // END cfgSave modern id helpers

    const payload = {
      scan_cidr:          cidrVal,        // BD usa scan_cidr (no scan_range)
      scan_interval:      interval,
      scan_on_boot:       $('#bootScan').is(':checked') ? 1 : 0,
      discord_webhook_info: _cfgSaveVal('cfgDiscordInfo'),
      discord_webhook_alerts: _cfgSaveVal('cfgDiscordAlerts'),
      discord_info_fallback_to_alerts: _cfgSaveChecked('cfgDiscordInfoFallback') ? 1 : 0,
      telegram_token:     _cfgSaveVal('cfg_telegram_token'),
      telegram_chat_id:   _cfgSaveVal('cfg_telegram_chat_id'),
      notify_new:         _cfgSaveChecked('cfgNotifyNew', 'cfg_notify_new') ? 1 : 0,
      notify_online:      _cfgSaveChecked('cfgNotifyOnline') ? 1 : 0,
      notify_offline:     _cfgSaveChecked('cfgNotifyOffline', 'cfg_notify_offline') ? 1 : 0,
      notify_mac_change:  _cfgSaveChecked('cfgNotifyMac') ? 1 : 0,
      notify_service_down:_cfgSaveChecked('cfgNotifySvcDown') ? 1 : 0,
      notify_syncthing_stalled: _cfgSaveChecked('cfgNotifySyncthingStalled') ? 1 : 0,
      notify_quality_degraded: _cfgSaveChecked('cfgNotifyQualityDegraded') ? 1 : 0,
      notify_script_alerts: _cfgSaveChecked('cfgNotifyScriptAlerts') ? 1 : 0,
      notify_email:       _cfgSaveChecked('cfgNotifyEmail') ? 1 : 0,
      email_new:          _cfgSaveChecked('cfgEmailNew') ? 1 : 0,
      email_online:       _cfgSaveChecked('cfgEmailOnline') ? 1 : 0,
      email_offline:      _cfgSaveChecked('cfgEmailOffline') ? 1 : 0,
      email_mac_change:   _cfgSaveChecked('cfgEmailMac') ? 1 : 0,
      email_service_down: _cfgSaveChecked('cfgEmailSvcDown') ? 1 : 0,
      email_syncthing_stalled: _cfgSaveChecked('cfgEmailSyncthingStalled') ? 1 : 0,
      email_quality_degraded: _cfgSaveChecked('cfgEmailQualityDegraded') ? 1 : 0,
      email_script_alerts: _cfgSaveChecked('cfgEmailScriptAlerts') ? 1 : 0,
      automation_watchdog_enabled: _cfgSaveChecked('cfgAutomationWatchdogEnabled') ? 1 : 0,
      automation_watchdog_enforce_state: _cfgSaveChecked('cfgAutomationWatchdogEnforceState') ? 1 : 0,
      automation_watchdog_missed_grace_minutes: parseInt(_cfgSaveVal('cfgAutomationWatchdogMissedGrace') || 30, 10),
      automation_watchdog_stalled_minutes: parseInt(_cfgSaveVal('cfgAutomationWatchdogStalledMinutes') || 60, 10),
      smtp_enabled:       _cfgSaveChecked('cfgSmtpEnabled', 'cfg_smtp_enabled') ? '1' : '0',
      smtp_host:          _cfgSaveVal('cfgSmtpHost', 'cfg_smtp_host'),
      smtp_port:          parseInt(_cfgSaveVal('cfgSmtpPort', 'cfg_smtp_port') || 587, 10),
      smtp_user:          _cfgSaveVal('cfgSmtpUser', 'cfg_smtp_user'),
      smtp_pass:          _cfgSaveVal('cfgSmtpPass', 'cfg_smtp_password'),
      smtp_tls:           _cfgSaveVal('cfgSmtpTls', 'cfg_smtp_tls') || 'starttls',
      smtp_from:          _cfgSaveVal('cfgSmtpFrom', 'cfg_smtp_from'),
      smtp_to:            _cfgSaveVal('cfgSmtpTo', 'cfg_smtp_to'),
      auth_enabled:       $('#cfgAuthEnabled').is(':checked') ? 1 : 0,
    };

    // Event types
    const checkedTypes = [];
    $('#cfg_event_types input[type=checkbox]:checked').each(function () { checkedTypes.push($(this).val()); });
    payload.alert_event_types = checkedTypes.join(',');

    try {
      const res  = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error guardando');
      $status.removeClass('err').addClass('ok').text('✓ Guardado');
      _renderTopbarNetworkScanInterval(data.settings || payload || {});
      _queueTopbarRangesRefresh(50);
      setTimeout(() => $status.css('display','none'), 3000);
    } catch (e) {
      $status.removeClass('ok').addClass('err').text('✗ ' + e.message);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).on('click', '#cfgDiscard', function () {
    if (_cfgData && Object.keys(_cfgData).length) {
      populateCfgForm(_cfgData);
      if (typeof cfgPopulateModern === 'function') cfgPopulateModern(_cfgData);
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
    }
    $('#cfgSaveStatus').css('display', 'none');
  });

  // Interval select ↔ input sync
  $(document).on('change', '#intervalSelect', function () { $('#intervalInput').val($(this).val()); });
  $(document).on('input',  '#intervalInput',  function () {
    const v = $(this).val();
    if ($('#intervalSelect option[value="' + v + '"]').length) $('#intervalSelect').val(v);
    else $('#intervalSelect').val('');
  });


  // ══════════════════════════════════════════════════════════
  // ③ ROUTER SSH
  // ══════════════════════════════════════════════════════════

  $(document).on('click', '#cfgRouterTest', async function () {
    const $btn = $(this), $msg = $('#cfgRouterTestMsg');
    $btn.prop('disabled', true);
    $msg.text('Probando conexión…').removeClass('text-success text-danger');
    try {
      const res  = await fetch('/api/router/test', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        $msg.addClass('text-success').text(`✓ Conectado · ${data.hostname || ''} · ${data.hosts_found || 0} hosts · ${data.leases_found || 0} leases`);
      } else {
        $msg.addClass('text-danger').text('✗ ' + (data.error || 'Error desconocido'));
      }
    } catch (e) { $msg.addClass('text-danger').text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgRouterSave', async function () {
    const $btn = $(this), $msg = $('#cfgRouterMsg');
    $btn.prop('disabled', true); $msg.text('Guardando…');
    const payload = {
      router_enabled:         $('#cfgRouterEnabled').is(':checked') ? '1' : '0',
      router_ssh_host:        $('#cfgRouterHost').val() || '',
      router_ssh_port:        parseInt($('#cfgRouterPort').val() || 22),
      router_ssh_user:        $('#cfgRouterUser').val() || '',
      router_ssh_key:         $('#cfgRouterKey').val()  || '',   // BD usa router_ssh_key
    };
    try {
      const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
      $msg.text(data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'));
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgRouterScanNow', async function () {
    const $btn = $(this), $msg = $('#cfgRouterScanMsg');
    $btn.prop('disabled', true); $msg.text('Escaneando…');
    try {
      const data = await fetch('/api/router/scan', { method: 'POST' }).then(r => r.json());
      $msg.text(data.ok ? `✓ ${data.hosts_found || 0} hosts` : '✗ ' + (data.error || 'Error'));
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgRouterResetFingerprint', async function () {
    if (!(await window.appConfirm(window.t?.('cfg.router.reset_fingerprint_confirm', '¿Resetear el fingerprint SSH? Se pedirá confirmación en la próxima conexión.') || '¿Resetear el fingerprint SSH? Se pedirá confirmación en la próxima conexión.', {
      title: window.t?.('cfg.router.reset_fingerprint_title', 'Resetear fingerprint SSH') || 'Resetear fingerprint SSH',
      confirmText: window.t?.('cfg.router.reset_fingerprint_action', 'Resetear') || 'Resetear',
      danger: true
    }))) return;
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch('/api/router/test/reset-known-hosts', { method: 'POST' }).then(r => r.json());
      window.showToast?.(data.ok ? (window.t?.('cfg.router.fingerprint_reset', '✓ Fingerprint reseteado') || '✓ Fingerprint reseteado') : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'), data.ok ? 'success' : 'danger');
    } catch (e) { window.showToast?.('✗ ' + e.message, 'danger'); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ④ WoL PÚBLICO
  // ══════════════════════════════════════════════════════════

  let _cfgWolPublicItems = [];
  let _cfgWolPublicLoaded = false;
  let _cfgWolPublicLoading = false;
  let _cfgWolPublicSavedState = null;
  let _cfgWolPublicSavedSignature = '';

  function _cfgWolToggleEl() {
    return document.getElementById('cfgWolPublic') || document.getElementById('cfgWolPublicEnabled');
  }

  function _cfgWolPublicExactUrl() {
    try {
      return new URL('/wol', window.location.origin).toString();
    } catch (_) {
      return '/wol';
    }
  }

  function _cfgWolSearchText(item) {
    return [
      item.display_name,
      item.public_label,
      item.manual_name,
      item.router_hostname,
      item.nmap_hostname,
      item.hostname,
      item.dns_name,
      item.ip,
      item.mac,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function _renderWolStatusBadge(status, wolReady) {
    const st = String(status || 'offline').toLowerCase();
    const cls = st === 'online' ? 'bg-success' : (st === 'offline' ? 'bg-secondary' : 'bg-warning text-dark');
    const txt = st === 'online' ? 'online' : (st === 'offline' ? 'offline' : esc(st));
    const wol = wolReady
      ? '<span class="badge bg-info-subtle text-info-emphasis">lista</span>'
      : '<span class="badge bg-danger-subtle text-danger-emphasis">sin MAC</span>';
    return {
      status: `<span class="badge ${cls}">${txt}</span>`,
      wol,
    };
  }

  function _wolSelectedItems() {
    return _cfgWolPublicItems
      .filter(h => !!h.public_enabled)
      .sort((a, b) => {
        const ao = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 0;
        const bo = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0;
        if (ao !== bo) return ao - bo;
        return String(a.display_name || a.ip || '').localeCompare(String(b.display_name || b.ip || ''), 'es', { sensitivity: 'base' });
      });
  }

  function _cfgWolPublicNormalizeHosts(items) {
    return (Array.isArray(items) ? items : [])
      .filter(h => !!h.public_enabled && h.ip)
      .map((h, idx) => ({
        ip: String(h.ip || '').trim(),
        public_enabled: true,
        public_label: String(h.public_label || '').trim(),
        sort_order: parseInt(h.sort_order || (idx + 1), 10) || (idx + 1),
      }))
      .sort((a, b) => {
        const ao = parseInt(a.sort_order || 0, 10) || 0;
        const bo = parseInt(b.sort_order || 0, 10) || 0;
        if (ao !== bo) return ao - bo;
        return String(a.ip || '').localeCompare(String(b.ip || ''), 'es', { sensitivity: 'base' });
      });
  }

  function _cfgWolPublicCurrentState() {
    return {
      wol_public: _cfgWolToggleEl()?.checked ? 1 : 0,
      hosts: _cfgWolPublicNormalizeHosts(_cfgWolPublicItems),
    };
  }

  function _cfgWolPublicSignature(state) {
    return JSON.stringify({
      wol_public: state?.wol_public ? 1 : 0,
      hosts: Array.isArray(state?.hosts) ? state.hosts.map(h => ({
        ip: String(h.ip || '').trim(),
        public_label: String(h.public_label || '').trim(),
        sort_order: parseInt(h.sort_order || 0, 10) || 0,
      })) : [],
    });
  }

  function _cfgWolPublicHasPendingChanges() {
    return _cfgWolPublicSignature(_cfgWolPublicCurrentState()) !== (_cfgWolPublicSavedSignature || '');
  }

  function _cfgWolPublicResetFeedback() {
    $('#cfgWolPublicMsg').css('display', 'none').removeClass('ok err').text('');
  }

  function _cfgWolPublicSetFeedback(text, kind = 'ok') {
    const $msg = $('#cfgWolPublicMsg');
    if (!$msg.length) return;
    $msg.css('display', 'inline-flex').removeClass('ok err');
    if (kind === 'ok' || kind === 'err') $msg.addClass(kind);
    $msg.text(text || '');
  }

  function _cfgWolPublicStateSummary(state, kind = 'published') {
    const enabled = !!(state && state.wol_public);
    const count = Array.isArray(state?.hosts) ? state.hosts.length : 0;
    const countTxt = `${count} ${count === 1 ? 'equipo' : 'equipos'}`;
    if (kind === 'draft') {
      if (!enabled) {
        return count
          ? `Borrador actual: desactivado · ${countTxt} preparados, pero no se publicarán hasta activar y guardar.`
          : 'Borrador actual: desactivado y sin equipos seleccionados.';
      }
      return count
        ? `Borrador actual: activo · ${countTxt} seleccionados para publicar al guardar.`
        : 'Borrador actual: activo, pero sin equipos seleccionados todavía.';
    }
    if (!enabled) return 'Publicado ahora mismo: desactivado · la URL pública no está expuesta.';
    return count
      ? `Publicado ahora mismo: activo · ${countTxt} visibles en la página pública.`
      : 'Publicado ahora mismo: activo, pero sin equipos visibles en la página pública.';
  }

  function _cfgWolPublicRememberSavedState() {
    const state = _cfgWolPublicCurrentState();
    _cfgWolPublicSavedState = {
      wol_public: state.wol_public ? 1 : 0,
      hosts: _cfgWolPublicNormalizeHosts(_cfgWolPublicItems),
    };
    _cfgWolPublicSavedSignature = _cfgWolPublicSignature(_cfgWolPublicSavedState);
    _syncWolPublicUi();
  }

  function _syncWolPublicUi() {
    const currentState = _cfgWolPublicCurrentState();
    const savedState = _cfgWolPublicSavedState || { wol_public: 0, hosts: [] };
    const hasPending = _cfgWolPublicHasPendingChanges();
    const exactUrl = _cfgWolPublicExactUrl();

    const $box = $('#cfgWolPublicStateBox');
    const $badge = $('#cfgWolPublicPendingBadge');
    const $hint = $('#cfgWolPublicDraftHint');
    const $published = $('#cfgWolPublicPublishedState');
    const $draft = $('#cfgWolPublicDraftState');
    const $url = $('#cfgWolPublicExactUrl');
    const $save = $('#cfgWolPublicSave');
    const $open = $('#cfgWolPublicOpen');

    if ($url.length) {
      $url.attr('href', exactUrl).text(exactUrl);
    }

    if ($box.length) {
      $box.removeClass('alert-secondary alert-warning');
      $box.addClass(hasPending ? 'alert-warning' : 'alert-secondary');
    }

    if ($badge.length) {
      $badge.removeClass('text-bg-secondary text-bg-warning text-bg-success');
      if (hasPending) {
        $badge.addClass('text-bg-warning').text('Cambios sin guardar');
      } else if (savedState.wol_public) {
        $badge.addClass('text-bg-success').text('Publicado y sincronizado');
      } else {
        $badge.addClass('text-bg-secondary').text('Sin cambios pendientes');
      }
    }

    if ($hint.length) {
      $hint.text(
        hasPending
          ? 'Añadir, editar, quitar y activar/desactivar solo prepara un borrador local. Nada se publica hasta pulsar Guardar.'
          : 'Añadir, editar, quitar y activar/desactivar seguirá preparando cambios locales. Solo se publican al pulsar Guardar.'
      );
    }

    if ($published.length) $published.text(_cfgWolPublicStateSummary(savedState, 'published'));
    if ($draft.length) {
      $draft.text(
        hasPending
          ? _cfgWolPublicStateSummary(currentState, 'draft')
          : 'Borrador actual: coincide exactamente con el estado publicado.'
      );
    }

    if ($save.length) {
      $save.prop('disabled', !hasPending || _cfgWolPublicLoading);
    }

    if ($open.length) {
      const canOpenPublished = !hasPending && !!savedState.wol_public;
      $open.attr('href', exactUrl);
      $open.attr('aria-disabled', canOpenPublished ? 'false' : 'true');
      $open.attr('tabindex', canOpenPublished ? '0' : '-1');
      $open.toggleClass('disabled', !canOpenPublished);
      $open.toggleClass('btn-outline-secondary', !canOpenPublished);
      $open.toggleClass('btn-outline-info', canOpenPublished);
      $open.html(`<i class="bi bi-box-arrow-up-right me-1"></i>${hasPending ? 'Abrir página pública guardada' : 'Abrir página pública'}`);
      if (hasPending) {
        $open.attr('title', 'Hay cambios sin guardar. Guarda antes de abrir la versión pública actualizada.');
      } else if (!savedState.wol_public) {
        $open.attr('title', 'WoL público está desactivado en el estado guardado.');
      } else {
        $open.attr('title', `Abrir ${exactUrl}`);
      }
    }
  }

  function _renderWolCandidates() {
    const $select = $('#cfgWolPublicCandidates');
    if (!$select.length) return;
    const query = ($('#cfgWolPublicSearch').val() || '').trim().toLowerCase();
    const selectedIps = new Set(_wolSelectedItems().map(h => h.ip));
    const candidates = _cfgWolPublicItems.filter(h => {
      if (!h || !h.ip || selectedIps.has(h.ip)) return false;
      if (!h.wol_ready) return false;
      if (!query) return true;
      return _cfgWolSearchText(h).includes(query);
    }).sort((a, b) => String(a.display_name || a.ip || '').localeCompare(String(b.display_name || b.ip || ''), 'es', { sensitivity: 'base' }));

    if (!candidates.length) {
      $select.html('<option value="">Sin resultados</option>');
      $('#cfgWolPublicAdd').prop('disabled', true);
      return;
    }

    $select.html(candidates.map(h => {
      const label = `${h.display_name || h.ip} · ${h.ip}`;
      return `<option value="${esc(h.ip)}">${esc(label)}</option>`;
    }).join(''));
    const firstValue = $select.find('option:first').val() || '';
    $select.val(firstValue);
    $('#cfgWolPublicAdd').prop('disabled', !firstValue);
  }

  function _renderWolSelected() {
    const $body = $('#cfgWolPublicSelectedBody');
    if (!$body.length) return;
    const items = _wolSelectedItems();
    if (!items.length) {
      $body.html('<tr><td colspan="6" class="text-center text-muted">Todavía no hay equipos añadidos</td></tr>');
      return;
    }
    $body.html(items.map((h, idx) => {
      const badges = _renderWolStatusBadge(h.status, !!h.wol_ready);
      const display = esc(h.display_name || h.ip || '');
      const publicLabel = esc(h.public_label || '');
      const sortOrder = Number.isFinite(Number(h.sort_order)) ? Number(h.sort_order) : (idx + 1);
      return `<tr data-ip="${esc(h.ip)}">
        <td><input type="text" class="form-control form-control-sm cfg-wol-public-label" value="${publicLabel}" placeholder="Nombre visible"></td>
        <td>
          <div class="fw-semibold">${display}</div>
          <div class="small text-muted mono">${esc(h.ip || '')}</div>
        </td>
        <td>${badges.status}</td>
        <td>${badges.wol}</td>
        <td><input type="number" class="form-control form-control-sm cfg-wol-public-order" value="${sortOrder}" min="0" step="1"></td>
        <td class="text-end">
          <button type="button" class="btn btn-outline-danger btn-sm cfg-wol-public-remove"><i class="bi bi-x-lg"></i></button>
        </td>
      </tr>`;
    }).join(''));
  }

  async function loadWolPublicHosts(force = false) {
    const $body = $('#cfgWolPublicSelectedBody');
    if (!$body.length) return;
    if (_cfgWolPublicLoading) return;
    if (_cfgWolPublicLoaded && !force) return;
    _cfgWolPublicLoading = true;
    _syncWolPublicUi();
    $body.html('<tr><td colspan="6" class="text-center text-muted">Cargando equipos…</td></tr>');
    try {
      const data = await fetch('/api/config/wol-public/hosts', { cache: 'no-store' }).then(async r => {
        const payload = await r.json();
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
        return payload;
      });
      _cfgWolPublicItems = Array.isArray(data.items) ? data.items : [];
      _cfgWolPublicLoaded = true;
      _renderWolCandidates();
      _renderWolSelected();
      _cfgWolPublicRememberSavedState();
    } catch (e) {
      _cfgWolPublicItems = [];
      _cfgWolPublicLoaded = false;
      _renderWolCandidates();
      $body.html(`<tr><td colspan="6" class="text-center text-danger">Error cargando equipos: ${esc(e.message || 'Error')}</td></tr>`);
      _syncWolPublicUi();
    } finally {
      _cfgWolPublicLoading = false;
      _syncWolPublicUi();
    }
  }

  $(document).on('input', '#cfgWolPublicSearch', _renderWolCandidates);
  $(document).on('focus', '#cfgWolPublicSearch', function () {
    loadWolPublicHosts(false).catch(e => console.warn('[cfg] loadWolPublicHosts(focus):', e.message));
  });
  $(document).on('change', '#cfgWolPublicCandidates', function () {
    $('#cfgWolPublicAdd').prop('disabled', !($(this).val() || ''));
  });
  $(document).on('change', '#cfgWolPublic', function () {
    _cfgWolPublicResetFeedback();
    _syncWolPublicUi();
  });

  $(document).on('click', '#cfgWolPublicAdd', function () {
    const ip = ($('#cfgWolPublicCandidates').val() || '').trim();
    if (!ip) return;
    const item = _cfgWolPublicItems.find(h => h.ip === ip);
    if (!item || !item.wol_ready) return;
    item.public_enabled = true;
    if (!item.public_label) item.public_label = item.display_name || item.ip || '';
    if (!(Number(item.sort_order) > 0)) item.sort_order = _wolSelectedItems().length;
    _renderWolCandidates();
    _renderWolSelected();
    _cfgWolPublicResetFeedback();
    _syncWolPublicUi();
  });

  $(document).on('click', '.cfg-wol-public-remove', function () {
    const ip = $(this).closest('tr').data('ip');
    const item = _cfgWolPublicItems.find(h => h.ip === ip);
    if (!item) return;
    item.public_enabled = false;
    _renderWolCandidates();
    _renderWolSelected();
    _cfgWolPublicResetFeedback();
    _syncWolPublicUi();
  });

  $(document).on('input change', '.cfg-wol-public-label, .cfg-wol-public-order', function () {
    const $tr = $(this).closest('tr');
    const ip = $tr.data('ip');
    const item = _cfgWolPublicItems.find(h => h.ip === ip);
    if (!item) return;
    item.public_label = ($tr.find('.cfg-wol-public-label').val() || '').trim();
    item.sort_order = parseInt($tr.find('.cfg-wol-public-order').val() || '0', 10) || 0;
    _cfgWolPublicResetFeedback();
    _syncWolPublicUi();
  });

  $(document).on('click', '#cfgWolPublicSave', async function () {
    const $btn = $(this);
    const hosts = _cfgWolPublicNormalizeHosts(_cfgWolPublicItems);
    $btn.prop('disabled', true);
    _cfgWolPublicSetFeedback('Guardando…', 'ok');
    try {
      const data = await fetch('/api/config/wol-public', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wol_public: _cfgWolToggleEl()?.checked ? 1 : 0,
          hosts,
        }),
      }).then(async r => {
        const payload = await r.json();
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
        return payload;
      });
      let msg = '✓ Guardado';
      if (Array.isArray(data.skipped) && data.skipped.length) {
        msg += ` · omitidos sin MAC: ${data.skipped.join(', ')}`;
      }
      _cfgWolPublicSetFeedback(msg, 'ok');
      await loadWolPublicHosts(true);
    } catch (e) {
      _cfgWolPublicSetFeedback('✗ ' + (e.message || 'Error'), 'err');
      _syncWolPublicUi();
    } finally {
      _syncWolPublicUi();
    }
  });

  $(document).on('click', '#cfgWolPublicOpen', function (e) {
    const savedState = _cfgWolPublicSavedState || { wol_public: 0, hosts: [] };
    if (_cfgWolPublicHasPendingChanges()) {
      e.preventDefault();
      _cfgWolPublicSetFeedback('⚠️ Hay cambios sin guardar. La página pública no reflejará el borrador hasta pulsar Guardar.', 'err');
      return;
    }
    if (!savedState.wol_public) {
      e.preventDefault();
      _cfgWolPublicSetFeedback('⚠️ WoL público está desactivado en el estado guardado. Actívalo y pulsa Guardar.', 'err');
    }
  });


  // ══════════════════════════════════════════════════════════
  // ⑤ IDIOMA
  // ══════════════════════════════════════════════════════════

  function _updateLangBtns(lang) {
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });
  }

  $(document).on('click', '.lang-btn', async function () {
    const lang = $(this).data('lang');
    if (!lang) return;
    const langSelect = document.getElementById('cfgLangSelect');
    if (langSelect) langSelect.value = lang;
    _updateLangBtns(lang);
    try {
      if (typeof window.setLang === 'function') {
        await window.setLang(lang);
      } else {
        localStorage.setItem('auditor_lang', lang);
        await _cfgSave({ ui_lang: lang });
      }
    } catch (_) {}
  });

  // Init lang buttons when appearance section opens
  $(document).on('click', '.cfg-nav-btn[data-section="appearance"]', function () {
    try {
      const langSelect = document.getElementById('cfgLangSelect');
      const lang = ((langSelect && langSelect.value) || localStorage.getItem('auditor_lang') || document.documentElement.lang || 'es');
      _updateLangBtns(lang);
    } catch (_) {}
    cfgLoadModernSettings();
  });


  // ══════════════════════════════════════════════════════════
  // ⑥ APARIENCIA — TEMAS, ACENTO, ANIMACIONES
  // ══════════════════════════════════════════════════════════

  function applyAccent(color, color2) {
    document.documentElement.style.setProperty('--accent', color);
    const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
    if (color2) {
      document.documentElement.style.setProperty('--accent2', color2);
      const r2 = parseInt(color2.slice(1,3),16), g2 = parseInt(color2.slice(3,5),16), b2 = parseInt(color2.slice(5,7),16);
      document.documentElement.style.setProperty('--accent2-rgb', `${r2},${g2},${b2}`);
    }
    localStorage.setItem('auditor-accent', color);
    if (color2) localStorage.setItem('auditor-accent2', color2);
    const bubble = document.querySelector('#viewTabs .nav-bubble');
    if (bubble) bubble.style.background = color;
    window.moveBubble?.(document.querySelector('#viewTabs .nav-link.active'));
  }

  function loadAccent() {
    const saved  = localStorage.getItem('auditor-accent');
    const saved2 = localStorage.getItem('auditor-accent2');
    if (saved)  applyAccent(saved, saved2 || undefined);
  }
  loadAccent();

  $(document).on('click', '.accent-swatch', function () {
    const color  = $(this).data('color')  || $(this).css('background-color');
    const color2 = $(this).data('color2') || '';
    $('.accent-swatch').removeClass('active');
    $(this).addClass('active');
    applyAccent(color, color2 || undefined);
  });

  // Custom accent color picker
  $(document).on('input', '#cfgAccentCustom', function () {
    applyAccent($(this).val());
    $('.accent-swatch').removeClass('active');
  });

  // Animations
  $(document).on('click', '.anim-btn', function () {
    const anim = $(this).data('anim');
    $('.anim-btn').removeClass('active');
    $(this).addClass('active');
    document.body.dataset.animation = anim;
    localStorage.setItem('auditor-animation', anim);
    fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ui_animation: anim }) }).catch(() => {});
  });
  (function () {
    const saved = localStorage.getItem('auditor-animation');
    if (saved) { document.body.dataset.animation = saved; $(`.anim-btn[data-anim="${saved}"]`).addClass('active'); }
  })();

  // Theme cards — save preference then reload so Bootstrap CSS is applied cleanly.
  // Swapping the CSS link mid-session causes layout breakage in the config modal
  // because Bootstrap overrides CSS variables and component styles in-place.
  $(document).on('click', '.theme-card', async function () {
    const theme   = $(this).data('theme');
    const isLight = ['flatly','lux','minty','journal'].includes(theme);
    localStorage.setItem('auditor-theme', isLight ? 'light' : 'dark');
    localStorage.setItem('auditor-theme-name', theme);
    // Persist to DB so other sessions/devices also pick it up
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui_theme: theme })
    }).catch(() => {});
    // Reload to apply theme cleanly — avoids CSS mid-session corruption
    window.location.reload();
  });


  // ══════════════════════════════════════════════════════════
  // ⑦ SMTP EMAIL
  // ══════════════════════════════════════════════════════════

  $(document).on('click', '#cfgSmtpPasswordToggle', function () {
    const $inp = $('#cfg_smtp_password');
    const show = $inp.attr('type') === 'password';
    $inp.attr('type', show ? 'text' : 'password');
    $(this).find('i').toggleClass('bi-eye', !show).toggleClass('bi-eye-slash', show);
  });

  $(document).on('click', '#cfgSmtpTest', async function () {
    const $btn = $(this), $msg = $('#cfgSmtpTestMsg');
    $btn.prop('disabled', true); $msg.text('Enviando email de prueba…').removeClass('text-success text-danger');
    try {
      const payload = {
        smtp_host: $('#cfg_smtp_host').val(), smtp_port: parseInt($('#cfg_smtp_port').val() || 587),
        smtp_user: $('#cfg_smtp_user').val(), smtp_password: $('#cfg_smtp_password').val(),
        smtp_tls:  $('#cfg_smtp_tls').val(),  smtp_from: $('#cfg_smtp_from').val(), smtp_to: $('#cfg_smtp_to').val(),
      };
      const data = await fetch('/api/settings/test-smtp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
      $msg.addClass(data.ok ? 'text-success' : 'text-danger').text(data.ok ? '✓ Email enviado' : '✗ ' + (data.error || 'Error'));
    } catch (e) { $msg.addClass('text-danger').text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ⑧ PESTAÑAS OCULTABLES
  // ══════════════════════════════════════════════════════════

  async function loadHiddenTabs() {
    try {
      const data = await fetch('/api/settings').then(r => r.json());
      const s    = data.settings || {};
      const hidden = (s.hidden_tabs || '').split(',').map(x => x.trim()).filter(Boolean);
      document.querySelectorAll('.cfg-tab-toggle').forEach(el => {
        el.checked = !hidden.includes(el.dataset.tab);
      });
    } catch (_) {}
  }

  $(document).on('click', '#cfgTabTogglesSave', async function () {
    const $btn = $(this), $msg = $('#cfgTabTogglesMsg');
    $btn.prop('disabled', true); $msg.text('Guardando…');
    const hidden = [];
    document.querySelectorAll('.cfg-tab-toggle:not(:checked)').forEach(el => { hidden.push(el.dataset.tab); });
    try {
      const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hidden_tabs: hidden.join(',') }) }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $msg.text('✓ Guardado');
      window.applyHiddenTabs?.(hidden);
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ⑨ TIPOS EN CONFIGURACIÓN
  // ══════════════════════════════════════════════════════════

  async function cfgLoadTypes() {
    const data = await fetch('/api/types').then(r => r.json());
    if (!data.ok) return;
    const tbody = $('#cfgTypesTable tbody');
    tbody.empty();
    for (const t of data.types) {
      tbody.append(`<tr data-type-id="${t.id}">
        <td class="mono">${t.id}</td>
        <td><input class="form-control form-control-sm cfg-type-name" value="${esc(t.name)}"></td>
        <td><div class="emoji-picker-wrap">
          <button type="button" class="emoji-picker-btn type-icon-val" data-icon="${esc(t.icon||'')}">${t.icon||'❓'}</button>
          <input type="hidden" class="type-icon-hidden" value="${esc(t.icon||'')}">
          <div class="emoji-grid-popup"></div>
        </div></td>
        <td><div class="d-flex gap-2">
          <button class="btn btn-outline-info btn-sm cfg-save-type"><i class="bi bi-save2"></i></button>
          <button class="btn btn-outline-danger btn-sm cfg-del-type"><i class="bi bi-trash3"></i></button>
        </div></td>
      </tr>`);
    }
  }

  $(document).on('click', '.cfg-save-type', async function () {
    const tr   = $(this).closest('tr'), id = tr.data('type-id');
    const name = (tr.find('.cfg-type-name').val() || '').trim();
    const icon = (tr.find('.type-icon-hidden').val() || tr.find('.type-icon-val').data('icon') || '').trim();
    $('#typesMsg').text('Guardando…');
    const data = await fetch(`/api/types/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, icon }) }).then(r => r.json());
    $('#typesMsg').text(data.ok ? '✓ OK' : '✗ ' + (data.error || 'Error'));
    if (data.ok) { await cfgLoadTypes(); window.reloadTypes?.(); window.hostsTable?.draw(false); }
  });

  $(document).on('click', '.cfg-del-type', async function () {
    const tr   = $(this).closest('tr'), id = tr.data('type-id');
    const name = (tr.find('.cfg-type-name').val() || '').trim();
    if (!(await window.appConfirm(`¿Borrar el tipo "${name}"?`, {
      title: 'Borrar tipo',
      confirmText: 'Borrar',
      danger: true
    }))) return;
    const data = await fetch(`/api/types/${id}`, { method:'DELETE' }).then(r => r.json());
    $('#typesMsg').text(data.ok ? '✓ Borrado' : '✗ ' + (data.error || 'Error'));
    if (data.ok) { await cfgLoadTypes(); window.reloadTypes?.(); window.hostsTable?.draw(false); }
  });

  $('#cfgNewTypeIconBtn').on('click', function (e) {
    e.stopPropagation();
    const popup = $(this).closest('.emoji-picker-wrap').find('.emoji-grid-popup');
    popup.toggleClass('open');
  });

  $(document).on('click', function (e) {
    if (!$(e.target).closest('.emoji-picker-wrap').length) $('.emoji-grid-popup').removeClass('open');
  });

  // Add type
  $(document).on('click', '#cfgAddTypeBtn', async function () {
    const name = ($('#cfgNewTypeName').val() || '').trim();
    const icon = ($('#cfgNewTypeIcon').val() || '').trim();
    if (!name) { $('#cfgTypesMsg').text('Nombre vacío'); return; }
    const data = await fetch('/api/types', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, icon }) }).then(r => r.json());
    $('#cfgTypesMsg').text(data.ok ? '✓ Añadido' : '✗ ' + (data.error || 'Error'));
    if (data.ok) { $('#cfgNewTypeName').val(''); $('#cfgNewTypeIcon').val(''); await cfgLoadTypes(); window.reloadTypes?.(); }
  });

  // Emoji picker (config)
  $(document).on('click', '.type-icon-val', function (e) {
    e.stopPropagation();
    const wrap = $(this).closest('.emoji-picker-wrap');
    $('.emoji-grid-popup').not(wrap.find('.emoji-grid-popup')).removeClass('open');
    wrap.find('.emoji-grid-popup').toggleClass('open');
    if (wrap.find('.emoji-grid-popup').hasClass('open') && !wrap.find('.emoji-grid-popup').children().length) {
      _renderEmojiPicker(wrap);
    }
  });


  // ══════════════════════════════════════════════════════════
  // ⑩ PUSH NOTIFICATIONS + VAPID
  // ══════════════════════════════════════════════════════════

  let _pushSub = null;

  async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      document.getElementById('pushSection')?.remove(); return;
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      _pushSub  = await reg.pushManager.getSubscription();
      updatePushUI();
    } catch (_) {}
  }

  function updatePushUI() {
    const $legacyBtn = $('#pushSubscribeBtn');
    const $enableBtn = $('#btnPushEnable');
    const $disableBtn = $('#btnPushDisable');
    const $status = $('#pushStatus');

    if (_pushSub) {
      if ($legacyBtn.length) {
        $legacyBtn.text('Desactivar notificaciones push').removeClass('btn-outline-success').addClass('btn-outline-danger');
      }
      if ($enableBtn.length) $enableBtn.hide();
      if ($disableBtn.length) $disableBtn.show();
      $status.text('Push activo').addClass('text-success').removeClass('text-muted');
    } else {
      if ($legacyBtn.length) {
        $legacyBtn.text('Activar notificaciones push').removeClass('btn-outline-danger').addClass('btn-outline-success');
      }
      if ($enableBtn.length) $enableBtn.show();
      if ($disableBtn.length) $disableBtn.hide();
      $status.text('Push inactivo').removeClass('text-success').addClass('text-muted');
    }
  }

  $(document).on('click', '#pushSubscribeBtn, #btnPushEnable, #btnPushDisable', async function () {
    const $btn = $(this); $btn.prop('disabled', true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (_pushSub) {
        await _pushSub.unsubscribe();
        await fetch('/api/push/unsubscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ endpoint: _pushSub.endpoint }) });
        _pushSub = null;
      } else {
        const keyData = await fetch('/api/push/vapid-key').then(r => r.json());
        const vapidPublicKey = String(keyData.public_key || keyData.key || '').trim();
        if (!vapidPublicKey) throw new Error('Falta la clave pública VAPID');
        const base64 = vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const raw = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
        _pushSub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
        await fetch('/api/push/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(_pushSub) });
      }
      updatePushUI();
    } catch (e) { window.showToast?.(window.t?.('cfg.push.error', 'Error push: {error}', { error: e.message }) || ('Error push: ' + e.message), 'danger'); }
    finally {
      $('#pushSubscribeBtn, #btnPushEnable, #btnPushDisable').prop('disabled', false);
    }
  });

  $(document).on('click', '#pushTestBtn', async function () {
    const $msg = $('#pushTestMsg');
    $msg.text('Enviando…');
    try {
      const data = await fetch('/api/push/test', { method:'POST' }).then(r => r.json());
      $msg.text(data.ok ? '✓ Test enviado' : '✗ ' + (data.error || 'Error'));
    } catch (e) { $msg.text('✗ ' + e.message); }
  });

  // VAPID
  async function ensureVapidKeys() {
    try {
      const res  = await fetch('/api/push/vapid-key');
      if (!res.ok) return; // endpoint not available
      const data = await res.json();
      const vapidPublicKey = String(data.public_key || data.key || '').trim();
      if (vapidPublicKey) {
        const el = document.getElementById('cfgVapidKey');
        if (el) el.value = vapidPublicKey;
      }
    } catch (_) {}
  }


  // ══════════════════════════════════════════════════════════
  // ⑪ BACKUP / BASE DE DATOS
  // ══════════════════════════════════════════════════════════

  async function loadBackups() {
    const $tbody = $('#backupTbody');
    if (!$tbody.length) return;
    try {
      const data = await fetch('/api/backup/list').then(r => r.json());
      if (!data.ok) {
        $tbody.html(`<tr><td colspan="4" class="text-danger small text-center">${esc(data.error || 'Error cargando backups')}</td></tr>`);
        return;
      }
      if (!data.backups?.length) {
        $tbody.html(`<tr><td colspan="4" class="small-muted text-center">${esc(window.t?.('cfg.backup.no_backups', 'Sin backups') || 'Sin backups')}</td></tr>`);
        return;
      }
      $tbody.html(data.backups.map(b => `
        <tr class="backup-row">
          <td class="mono small">${esc(b.filename || '')}</td>
          <td>${esc(b.created || '')}</td>
          <td>${esc(dbFmtBytes(b.size_bytes || ((b.size_kb || 0) * 1024)))}</td>
          <td class="text-end">
            <div class="d-inline-flex gap-1">
              <a href="/api/backup/download/${encodeURIComponent(b.filename || '')}" class="btn btn-outline-secondary btn-sm py-0 px-2" title="${esc(window.t?.('common.download', 'Descargar') || 'Descargar')}"><i class="bi bi-download"></i></a>
              <button class="btn btn-outline-danger btn-sm py-0 px-2 btn-backup-del" data-name="${esc(b.filename || '')}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
            </div>
          </td>
        </tr>
      `).join(''));
    } catch (_) {
      $tbody.html(`<tr><td colspan="4" class="text-danger small text-center">${esc(window.t?.('cfg.backup.load_error', 'Error cargando backups') || 'Error cargando backups')}</td></tr>`);
    }
  }

  window.loadBackupList = loadBackups;

  function dbFmtInt(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function dbFmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function dbStorageCard(title, value, note) {
    return `
      <div class="col-12 col-md-3">
        <div class="p-2 rounded border border-secondary-subtle bg-dark bg-opacity-25 h-100">
          <div class="small-muted" style="font-size:.72rem">${esc(title)}</div>
          <div class="fw-semibold">${esc(value)}</div>
          ${note ? `<div class="small-muted" style="font-size:.7rem">${esc(note)}</div>` : ''}
        </div>
      </div>`;
  }

  async function loadDbStorageSummary() {
    const cards = document.getElementById('dbStorageCards');
    const tbody = document.getElementById('dbTableStatsTbody');
    const note = document.getElementById('dbTableStatsNote');
    if (!cards && !tbody) return;

    if (cards) cards.innerHTML = '<div class="col-12 small-muted">Cargando métricas…</div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="small-muted text-center">Cargando…</td></tr>';

    try {
      const data = await fetch('/api/db/storage-summary?_=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error cargando métricas');

      const files = data.files || {};
      const disk = data.disk || {};
      const sqlite = data.sqlite || {};

      if (cards) {
        cards.innerHTML = [
          dbStorageCard('BD SQLite', dbFmtBytes(files.db_bytes), data.db_path || ''),
          dbStorageCard('WAL / SHM', dbFmtBytes((files.wal_bytes || 0) + (files.shm_bytes || 0)), 'archivos auxiliares SQLite'),
          dbStorageCard('Backups', dbFmtBytes(files.backups_bytes), `${files.backup_count || 0} copias`),
          dbStorageCard('Libre en /data', dbFmtBytes(disk.free_bytes), `usado ${dbFmtBytes(disk.used_bytes)} de ${dbFmtBytes(disk.total_bytes)}`),
        ].join('') + `
          <div class="col-12">
            <div class="small-muted" style="font-size:.72rem">
              Espacio reutilizable interno SQLite estimado: ${esc(dbFmtBytes(sqlite.freelist_bytes || 0))}.
              La compactación física requiere VACUUM y se añadirá como acción separada.
            </div>
          </div>`;
      }

      if (tbody) {
        const allRows = Array.isArray(data.table_rows) ? data.table_rows : [];
        const rows = allRows.slice(0, 20);
        if (note) {
          note.textContent = `Mostrando las 20 tablas con más filas de ${dbFmtInt(allRows.length)}. Solo lectura. La limpieza de históricos se añadirá como acción separada con cálculo previo y backup automático.`;
        }
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="small-muted text-center">Sin tablas</td></tr>';
        } else {
          tbody.innerHTML = rows.map(r => `
            <tr>
              <td class="mono small">${esc(r.table || '')}</td>
              <td>${r.category === 'history' ? '<span class="badge text-bg-warning">histórico</span>' : '<span class="badge text-bg-secondary">base</span>'}</td>
              <td class="text-end">${dbFmtInt(r.rows || 0)}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      if (cards) cards.innerHTML = `<div class="col-12 text-danger small">Error cargando métricas: ${esc(e.message || 'Error')}</div>`;
      if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-danger small text-center">Error cargando métricas</td></tr>';
    }
  }

  window.loadDbStorageSummary = loadDbStorageSummary;



  function cfgHealthMeta(rawStatus) {
    const st = String(rawStatus || 'unknown').toLowerCase();
    const map = {
      ok:       { cls: 'text-bg-success', label: 'OK', icon: 'bi-check2-circle' },
      warning:  { cls: 'text-bg-warning', label: 'Aviso', icon: 'bi-exclamation-triangle' },
      error:    { cls: 'text-bg-danger',  label: 'Error', icon: 'bi-x-circle' },
      unknown:  { cls: 'text-bg-secondary', label: 'Desconocido', icon: 'bi-question-circle' },
      disabled: { cls: 'text-bg-secondary', label: 'Desactivado', icon: 'bi-dash-circle' },
    };
    return map[st] || map.unknown;
  }

  function cfgHealthBadge(status) {
    const meta = cfgHealthMeta(status);
    return `<span class="badge ${meta.cls}" style="font-size:.75rem"><i class="bi ${meta.icon} me-1"></i>${esc(meta.label)}</span>`;
  }

  function cfgHealthCard(title, status, value, note, icon) {
    return `
      <div class="col-12 col-md-6">
        <div class="p-3 rounded border border-secondary-subtle bg-dark bg-opacity-25 h-100">
          <div class="d-flex align-items-start justify-content-between gap-2 mb-2">
            <div class="fw-semibold"><i class="bi ${icon || 'bi-info-circle'} me-1"></i>${esc(title)}</div>
            ${cfgHealthBadge(status)}
          </div>
          <div class="fs-5 fw-bold">${esc(value || '—')}</div>
          ${note ? `<div class="small-muted mt-1" style="font-size:.74rem">${esc(note)}</div>` : ''}
        </div>
      </div>`;
  }

  function cfgHealthFmtDateTime(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function cfgHealthFmtDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function cfgHealthFmtOptionalDuration(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return '—';
    return cfgHealthFmtDuration(seconds);
  }

  async function loadConfigSystemHealth() {
    const badge = document.getElementById('cfgSystemHealthBadge');
    const meta = document.getElementById('cfgSystemHealthMeta');
    const summary = document.getElementById('cfgSystemHealthSummary');
    const cards = document.getElementById('cfgSystemHealthCards');
    const btn = document.getElementById('cfgSystemHealthRefresh');

    if (!summary && !cards) return;

    if (summary) summary.innerHTML = '<div class="col-12 small-muted">Cargando salud del sistema…</div>';
    if (cards) cards.innerHTML = '';
    if (meta) meta.textContent = 'Consultando /api/system/health…';
    btn?.classList.add('disabled');

    try {
      const data = await fetch('/api/system/health?_=' + Date.now(), { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });

      const app = data.app || {};
      const database = data.database || {};
      const storage = data.storage || {};
      const backups = data.backups || {};
      const scheduler = data.scheduler || {};
      const scans = data.scans || {};
      const quality = data.quality || {};
      const services = data.services || {};
      const automations = data.automations || {};
      const agents = data.agents || {};
      const syncthing = data.syncthing || {};
      const ai = data.ai || {};
      const notifications = data.notifications || {};
      const scanJob = scheduler.scan_job || {};
      const latestScan = scans.latest || {};
      const autoCounts = automations.status_counts || {};
      const autoIssues = Number(autoCounts.error || 0) + Number(autoCounts.missed || 0) + Number(autoCounts.stalled || 0);
      const overall = data.overall || (data.ok ? 'ok' : 'error');

      if (badge) badge.innerHTML = cfgHealthBadge(overall);
      if (meta) {
        meta.textContent = `Generado: ${cfgHealthFmtDateTime(data.generated_at)} · Arranque: ${cfgHealthFmtDateTime(app.started_at)} · PID ${app.pid || '—'}`;
      }

      if (summary) {
        summary.innerHTML = [
          cfgHealthCard('Estado global', overall, cfgHealthMeta(overall).label, 'Resumen derivado de todos los subsistemas locales disponibles.', 'bi-heart-pulse'),
          cfgHealthCard('Aplicación', app.name ? 'ok' : 'unknown', cfgHealthFmtDuration(app.uptime_seconds), `Python ${app.python || '—'} · ${app.name || 'Auditor IPs'}`, 'bi-cpu'),
          cfgHealthCard('Base de datos', database.status || 'unknown', dbFmtBytes(database.size_bytes), `WAL ${dbFmtBytes(database.wal_bytes)} · SHM ${dbFmtBytes(database.shm_bytes)} · latencia ${database.latency_ms ?? '—'} ms`, 'bi-database-check'),
          cfgHealthCard('Almacenamiento /data', storage.status || 'unknown', `${storage.used_pct ?? '—'}% usado`, `${dbFmtBytes(storage.free_bytes)} libres de ${dbFmtBytes(storage.total_bytes)} · aviso ${storage.warning_pct ?? '—'}% · error ${storage.error_pct ?? '—'}%`, 'bi-device-hdd'),
          cfgHealthCard('Scheduler', scheduler.status || 'unknown', `${scheduler.state || '—'} · ${dbFmtInt(scheduler.job_count || 0)} jobs`, scanJob.next_run_time ? `scan_job próxima: ${cfgHealthFmtDateTime(scanJob.next_run_time)}` : 'scan_job no registrado.', 'bi-clock-history'),
          cfgHealthCard('Scans', scans.status || 'unknown', `${dbFmtInt(scans.scans_today || 0)} hoy`, latestScan.id ? `Último #${latestScan.id} hace ${cfgHealthFmtDuration(latestScan.age_seconds)} · duración ${cfgHealthFmtDuration(latestScan.duration_seconds)} · ${latestScan.online_hosts ?? '—'} online / ${latestScan.offline_hosts ?? '—'} offline` : 'No hay scans registrados.', 'bi-radar'),
          cfgHealthCard('Calidad', quality.status || 'unknown', `${dbFmtInt(quality.targets_active || 0)} destinos activos`, `${dbFmtInt(quality.checks_24h || 0)} checks 24h · ${dbFmtInt(quality.errors_24h || 0)} avisos 24h · ${quality.latest?.target_name || quality.latest?.host || 'sin último check'}`, 'bi-activity'),
          cfgHealthCard('Servicios', services.status || 'unknown', `${dbFmtInt(services.services_enabled || 0)} activos`, `${dbFmtInt(services.checks_24h || 0)} checks 24h · ${dbFmtInt(services.errors_24h || 0)} avisos 24h · ${services.latest?.name || services.latest?.host || 'sin último check'}`, 'bi-hdd-network'),
          cfgHealthCard('Automatizaciones', automations.status || 'unknown', `${dbFmtInt(automations.scripts_active || 0)} scripts activos`, `${dbFmtInt(automations.status_files || 0)} estados · OK ${dbFmtInt(autoCounts.ok || 0)} · running ${dbFmtInt(autoCounts.running || 0)} · incidencias ${dbFmtInt(autoIssues)}`, 'bi-terminal'),
          cfgHealthCard('Agentes API', agents.status || 'unknown', `${dbFmtInt(agents.agents_enabled || 0)} habilitados`, `${dbFmtInt(agents.agents_stale || 0)} sin señal · ${dbFmtInt(agents.auth_failed_24h || 0)} fallos auth 24h · último hace ${cfgHealthFmtOptionalDuration(agents.latest_seen_age_seconds)}`, 'bi-shield-check'),
          cfgHealthCard('Syncthing Control', syncthing.status || 'unknown', `${dbFmtInt(syncthing.nodes_enabled || 0)} nodos activos`, `Caché hace ${cfgHealthFmtOptionalDuration(syncthing.cache_age_seconds)} · ${dbFmtInt(syncthing.folder_errors_24h || 0)} errores 24h · ${dbFmtInt(syncthing.stalled_alerts || 0)} atascos`, 'bi-arrow-left-right'),
          cfgHealthCard('IA', ai.status || 'unknown', ai.configured ? (ai.provider || 'Configurada') : 'Desactivada', `${dbFmtInt(ai.scan_reports || 0)} informes scan · ${dbFmtInt(ai.daily_reports || 0)} informes diarios · último hace ${cfgHealthFmtOptionalDuration(ai.latest_age_seconds)}`, 'bi-stars'),
          cfgHealthCard('Notificaciones', notifications.status || 'unknown', notifications.discord_configured ? 'Discord configurado' : 'Discord no configurado', `${dbFmtInt(notifications.alerts_enabled || 0)} alertas · ${dbFmtInt(notifications.script_rules_enabled || 0)} reglas script · error Discord reciente: ${notifications.latest_scan_discord_error ? 'sí' : 'no'}`, 'bi-bell'),
        ].join('');
      }

      if (cards) {
        const latestBackup = backups.latest || {};
        const sqlite = database.sqlite || {};
        cards.innerHTML = [
          cfgHealthCard('Backups', backups.status || 'unknown', `${dbFmtInt(backups.count || 0)} copia${Number(backups.count || 0) === 1 ? '' : 's'}`, latestBackup.filename ? `${latestBackup.filename} · ${cfgHealthFmtDateTime(latestBackup.mtime)} · ${dbFmtBytes(latestBackup.size_bytes)}` : 'No se detecta backup disponible.', 'bi-archive'),
          cfgHealthCard('SQLite interno', database.status || 'unknown', `${dbFmtInt(sqlite.page_count || 0)} páginas`, `Page size ${dbFmtBytes(sqlite.page_size || 0)} · freelist ${dbFmtBytes(sqlite.freelist_bytes || 0)}`, 'bi-diagram-3'),
          cfgHealthCard('Rutas locales', storage.status || 'unknown', storage.path || '/data', `BD: ${database.path || '—'} · backups: ${backups.path || '—'}`, 'bi-folder2-open'),
          cfgHealthCard('Healthcheck instalador', data.ok ? 'ok' : 'error', '/api/system/healthz', 'Smoke público mínimo para Docker/instalador. Esta vista usa el endpoint protegido completo.', 'bi-box-seam'),
        ].join('');
      }
    } catch (e) {
      if (badge) badge.innerHTML = cfgHealthBadge('error');
      if (meta) meta.textContent = 'Error cargando salud del sistema: ' + (e.message || 'Error');
      if (summary) summary.innerHTML = `<div class="col-12 text-danger small">No se pudo cargar /api/system/health: ${esc(e.message || 'Error')}</div>`;
      if (cards) cards.innerHTML = '';
      console.warn('[Config system health]', e.message);
    } finally {
      btn?.classList.remove('disabled');
    }
  }

  window.loadConfigSystemHealth = loadConfigSystemHealth;

  $(document).on('click', '#cfgSystemHealthRefresh', loadConfigSystemHealth);
  $(document).on('click', '#cfgSystemHealthOpenBackup', function () {
    $('.cfg-nav-btn[data-section="backup"]').trigger('click');
  });


  async function loadDbCleanupEstimate() {
    const days = parseInt(document.getElementById('dbCleanupEstimateDays')?.value || '60', 10) || 60;
    const summary = document.getElementById('dbCleanupEstimateSummary');
    const tbody = document.getElementById('dbCleanupEstimateTbody');

    if (summary) summary.textContent = 'Calculando estimación…';
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="small-muted text-center">Calculando…</td></tr>';

    try {
      const data = await fetch('/api/db/cleanup-estimate?days=' + encodeURIComponent(days) + '&_=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error calculando limpieza');

      _lastDbCleanupEstimate = data;
      if (summary) {
        summary.textContent = `Conservando ${dbFmtInt(data.days)} días: se eliminarían ${dbFmtInt(data.total_rows_delete)} filas históricas y quedarían ${dbFmtInt(data.total_rows_after)}. El tamaño físico de la BD no bajará hasta compactar/VACUUM.`;
      }

      const rows = Array.isArray(data.tables) ? data.tables.filter(r => Number(r.rows_delete || 0) > 0).slice(0, 30) : [];
      if (tbody) {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="small-muted text-center">No hay filas antiguas para ese plazo</td></tr>';
        } else {
          tbody.innerHTML = rows.map(r => `
            <tr>
              <td class="mono small">${esc(r.table || '')}</td>
              <td>${esc(r.date_column || '')}</td>
              <td class="text-end text-warning">${dbFmtInt(r.rows_delete || 0)}</td>
              <td class="text-end">${dbFmtInt(r.rows_after || 0)}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      if (summary) summary.textContent = 'Error calculando limpieza: ' + (e.message || 'Error');
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-danger small text-center">Error calculando limpieza</td></tr>';
    }
  }


  let _lastDbCleanupEstimate = null;

  window.loadDbCleanupEstimate = loadDbCleanupEstimate;

  $(document).off('click.cfgDbCleanupEstimate', '#btnDbCleanupEstimate').on('click.cfgDbCleanupEstimate', '#btnDbCleanupEstimate', function () {
    loadDbCleanupEstimate();
  });


  $(document).off('click.cfgDbVacuum', '#btnDbVacuum').on('click.cfgDbVacuum', '#btnDbVacuum', async function () {
    const btn = this;
    const msg = document.getElementById('dbVacuumMsg');

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Compactando…';
    if (msg) msg.textContent = 'Creando backup previo y compactando BD…';

    try {
      const data = await fetch('/api/db/vacuum', { method: 'POST' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error compactando BD');

      if (msg) {
        msg.textContent = `Compactación completada. Antes: ${dbFmtBytes(data.before_bytes || 0)} · Después: ${dbFmtBytes(data.after_bytes || 0)} · Liberado: ${dbFmtBytes(data.freed_bytes || 0)}. Backup previo: ${data.backup?.filename || 'creado'}.`;
      }

      await loadBackups();
      await loadDbStorageSummary();
    } catch (e) {
      if (msg) msg.textContent = 'Error compactando BD: ' + (e.message || 'Error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });

  $(document).off('click.cfgDbCleanupRunOpen', '#btnDbCleanupRunOpen').on('click.cfgDbCleanupRunOpen', '#btnDbCleanupRunOpen', async function () {
    if (!_lastDbCleanupEstimate) {
      await loadDbCleanupEstimate();
    }

    const days = parseInt(document.getElementById('dbCleanupEstimateDays')?.value || '60', 10) || 60;
    const estimate = _lastDbCleanupEstimate || {};
    const summary = document.getElementById('dbCleanupConfirmSummary');
    if (summary) {
      summary.textContent = `Conservar últimos ${dbFmtInt(days)} días. Según la última estimación se eliminarían ${dbFmtInt(estimate.total_rows_delete || 0)} filas históricas.`;
    }

    const modalEl = document.getElementById('dbCleanupConfirmModal');
    if (modalEl && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  });

  $(document).off('click.cfgDbCleanupRunConfirm', '#btnDbCleanupRunConfirm').on('click.cfgDbCleanupRunConfirm', '#btnDbCleanupRunConfirm', async function () {
    const btn = this;
    const days = parseInt(document.getElementById('dbCleanupEstimateDays')?.value || '60', 10) || 60;
    const summary = document.getElementById('dbCleanupEstimateSummary');

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Limpiando…';

    try {
      const data = await fetch('/api/db/cleanup-run', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ days })
      }).then(r => r.json());

      if (!data.ok) throw new Error(data.error || 'Error ejecutando limpieza');

      const modalEl = document.getElementById('dbCleanupConfirmModal');
      if (modalEl && window.bootstrap) {
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }

      if (summary) {
        summary.textContent = `Limpieza aplicada: ${dbFmtInt(data.total_rows_deleted || 0)} filas eliminadas. Backup previo: ${data.backup?.filename || 'creado'}.`;
      }

      _lastDbCleanupEstimate = null;
      await loadBackups();
      await loadDbStorageSummary();
      await loadDbCleanupEstimate();
    } catch (e) {
      if (summary) summary.textContent = 'Error ejecutando limpieza: ' + (e.message || 'Error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });

  let _lastDbRetentionEstimate = null;

  function dbRetentionSelectedModules() {
    return Array.from(document.querySelectorAll('.db-retention-module-check:checked'))
      .map(el => el.dataset.module || '')
      .filter(Boolean);
  }

  function dbRetentionModuleDaysFromCards() {
    const out = {};
    document.querySelectorAll('.db-retention-module-days').forEach(el => {
      const id = el.dataset.module || '';
      if (!id) return;
      const days = parseInt(el.value || '60', 10) || 60;
      out[id] = Math.max(1, Math.min(3650, days));
    });
    return out;
  }

  function dbRetentionModuleCard(module) {
    const id = String(module.id || '');
    const canDelete = Number(module.rows_delete_supported || 0) > 0;
    const disabled = canDelete ? '' : 'disabled';
    const title = esc(module.label || id || 'Módulo');
    const desc = esc(module.description || '');
    const days = Number(module.days || module.default_days || 60);
    return `
      <div class="col-12 col-lg-6">
        <div class="d-block p-2 rounded border border-secondary-subtle bg-dark bg-opacity-25 h-100">
          <div class="d-flex align-items-start gap-2">
            <input class="form-check-input mt-1 db-retention-module-check" type="checkbox" data-module="${esc(id)}" ${disabled}>
            <div class="flex-grow-1">
              <div class="d-flex justify-content-between gap-2 align-items-start flex-wrap">
                <div>
                  <div class="fw-semibold">${title}</div>
                  <div class="small-muted" style="font-size:.72rem">${desc}</div>
                </div>
                <label class="small-muted d-flex align-items-center gap-1" style="font-size:.72rem">
                  Días
                  <input class="form-control form-control-sm db-retention-module-days" type="number" min="1" max="3650" value="${days}" data-module="${esc(id)}" style="width:86px">
                </label>
              </div>
              <div class="small mt-1">
                <span class="badge text-bg-secondary">Filas ${dbFmtInt(module.rows_total || 0)}</span>
                <span class="badge text-bg-warning">Borraría ${dbFmtInt(module.rows_delete || 0)}</span>
                <span class="badge ${canDelete ? 'text-bg-danger' : 'text-bg-secondary'}">Soportadas ${dbFmtInt(module.rows_delete_supported || 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  async function loadDbRetentionEstimate() {
    const summary = document.getElementById('dbRetentionEstimateSummary');
    const tbody = document.getElementById('dbRetentionEstimateTbody');
    const modulesEl = document.getElementById('dbRetentionModules');

    if (summary) summary.textContent = 'Calculando retención por módulo…';
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="small-muted text-center">Calculando…</td></tr>';
    if (modulesEl) modulesEl.innerHTML = '';

    try {
      const data = await fetch('/api/db/retention-estimate?_=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error calculando retención');

      _lastDbRetentionEstimate = data;

      if (summary) {
        summary.textContent = `Política por módulo: se eliminarían ${dbFmtInt(data.total_rows_delete_supported || 0)} filas históricas soportadas según los días configurados en cada tarjeta.`;
      }

      const modules = Array.isArray(data.modules) ? data.modules : [];
      if (modulesEl) {
        modulesEl.innerHTML = modules.map(dbRetentionModuleCard).join('') || '<div class="col-12 small-muted">Sin módulos disponibles.</div>';
      }

      if (tbody) {
        if (!modules.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="small-muted text-center">Sin módulos</td></tr>';
        } else {
          tbody.innerHTML = modules.map(m => `
            <tr>
              <td>
                <div class="fw-semibold">${esc(m.label || m.id || '')}</div>
                <div class="small-muted" style="font-size:.7rem">${esc(m.id || '')}</div>
              </td>
              <td class="text-end">${dbFmtInt(m.days || m.default_days || 60)}</td>
              <td class="text-end">${dbFmtInt(m.rows_total || 0)}</td>
              <td class="text-end text-warning">${dbFmtInt(m.rows_delete || 0)}</td>
              <td class="text-end text-danger">${dbFmtInt(m.rows_delete_supported || 0)}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      _lastDbRetentionEstimate = null;
      if (summary) summary.textContent = 'Error calculando retención: ' + (e.message || 'Error');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-danger small text-center">Error calculando retención</td></tr>';
      if (modulesEl) modulesEl.innerHTML = '';
    }
  }

  window.loadDbRetentionEstimate = loadDbRetentionEstimate;

  $(document).off('click.cfgDbRetentionEstimate', '#btnDbRetentionEstimate').on('click.cfgDbRetentionEstimate', '#btnDbRetentionEstimate', function () {
    loadDbRetentionEstimate();
  });

  $(document).off('click.cfgDbRetentionPolicySave', '#btnDbRetentionPolicySave').on('click.cfgDbRetentionPolicySave', '#btnDbRetentionPolicySave', async function () {
    const btn = this;
    const summary = document.getElementById('dbRetentionEstimateSummary');
    const module_days = dbRetentionModuleDaysFromCards();

    if (!Object.keys(module_days).length) {
      await loadDbRetentionEstimate();
      return;
    }

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Guardando…';

    try {
      const data = await fetch('/api/db/retention-policy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ module_days })
      }).then(r => r.json());

      if (!data.ok) throw new Error(data.error || 'Error guardando política');

      if (summary) summary.textContent = 'Política de retención guardada. Recalculando estimación…';
      await loadDbRetentionEstimate();
    } catch (e) {
      if (summary) summary.textContent = 'Error guardando política: ' + (e.message || 'Error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });


  $(document).off('click.cfgDbRetentionRunOpen', '#btnDbRetentionRunOpen').on('click.cfgDbRetentionRunOpen', '#btnDbRetentionRunOpen', async function () {
    if (!_lastDbRetentionEstimate) {
      await loadDbRetentionEstimate();
    }

    const selected = dbRetentionSelectedModules();
    const summary = document.getElementById('dbRetentionConfirmSummary');

    if (!selected.length) {
      const mainSummary = document.getElementById('dbRetentionEstimateSummary');
      const msg = 'Selecciona al menos un módulo con filas antiguas soportadas antes de ejecutar la limpieza.';
      if (summary) summary.textContent = msg;
      if (mainSummary) mainSummary.textContent = msg;
      return;
    }

    const modules = (_lastDbRetentionEstimate?.modules || []).filter(m => selected.includes(String(m.id || '')));
    const rows = modules.reduce((acc, m) => acc + Number(m.rows_delete_supported || 0), 0);
    const detail = modules.map(m => `${m.label || m.id}: ${dbFmtInt(m.days || m.default_days || 60)} días`).join(' · ');

    if (summary) {
      summary.textContent = `Módulos seleccionados: ${selected.join(', ')}. ${detail}. Se eliminarían ${dbFmtInt(rows)} filas históricas soportadas.`;
    }

    const modalEl = document.getElementById('dbRetentionConfirmModal');
    if (modalEl && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  });

  $(document).off('click.cfgDbRetentionRunConfirm', '#btnDbRetentionRunConfirm').on('click.cfgDbRetentionRunConfirm', '#btnDbRetentionRunConfirm', async function () {
    const btn = this;
    const selected = dbRetentionSelectedModules();
    const module_days = dbRetentionModuleDaysFromCards();
    const summary = document.getElementById('dbRetentionEstimateSummary');

    if (!selected.length) {
      if (summary) summary.textContent = 'Selecciona al menos un módulo antes de ejecutar retención.';
      return;
    }

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Limpiando…';

    try {
      const data = await fetch('/api/db/retention-run', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ module_days, modules: selected })
      }).then(r => r.json());

      if (!data.ok) throw new Error(data.error || 'Error ejecutando retención');

      const modalEl = document.getElementById('dbRetentionConfirmModal');
      if (modalEl && window.bootstrap) {
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }

      if (summary) {
        summary.textContent = `Retención aplicada: ${dbFmtInt(data.total_rows_deleted || 0)} filas eliminadas. Backup previo: ${data.backup?.filename || 'creado'}.`;
      }

      _lastDbRetentionEstimate = null;
      await loadBackups();
      await loadDbStorageSummary();
      await loadDbRetentionEstimate();
    } catch (e) {
      if (summary) summary.textContent = 'Error ejecutando retención: ' + (e.message || 'Error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });


  let _lastHostsInactiveCleanupEstimate = null;

  function hostsInactiveCleanupDays() {
    const raw = parseInt(document.getElementById('hostsInactiveCleanupDays')?.value || '90', 10) || 90;
    return Math.max(1, Math.min(3650, raw));
  }

  function hostsInactiveCleanupIncludeKnown() {
    return !!document.getElementById('hostsInactiveCleanupIncludeKnown')?.checked;
  }

  function hostsInactiveCleanupName(host) {
    return host.manual_name || host.nmap_hostname || host.dns_name || host.mac || '—';
  }

  async function loadHostsInactiveCleanupEstimate() {
    const days = hostsInactiveCleanupDays();
    const includeKnown = hostsInactiveCleanupIncludeKnown();
    const summary = document.getElementById('hostsInactiveCleanupSummary');
    const tbody = document.getElementById('hostsInactiveCleanupTbody');

    if (summary) summary.textContent = 'Calculando hosts inactivos…';
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="small-muted text-center">Calculando…</td></tr>';

    try {
      const url = `/api/hosts/inactive-cleanup-estimate?days=${encodeURIComponent(days)}&include_known=${includeKnown ? '1' : '0'}&_=${Date.now()}`;
      const data = await fetch(url, { cache: 'no-store' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error calculando hosts inactivos');

      _lastHostsInactiveCleanupEstimate = data;

      const count = Number(data.hosts_count || 0);
      const related = Number(data.related_rows_delete || 0);
      const knownMsg = data.include_known ? 'Incluye hosts conocidos.' : 'Solo hosts no conocidos.';
      if (summary) {
        summary.textContent = `Sin verse en ${dbFmtInt(data.days || days)} días: se borrarían ${dbFmtInt(count)} hosts y ${dbFmtInt(related)} filas auxiliares. ${knownMsg} Nunca incluye hosts online.`;
      }

      const rows = Array.isArray(data.sample_hosts) ? data.sample_hosts : [];
      if (tbody) {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="small-muted text-center">No hay hosts candidatos con ese criterio</td></tr>';
        } else {
          tbody.innerHTML = rows.map(h => `
            <tr>
              <td class="mono">${esc(h.ip || '')}</td>
              <td>${esc(hostsInactiveCleanupName(h))}</td>
              <td><span class="badge text-bg-secondary">${esc(h.status || '—')}</span></td>
              <td>${Number(h.known || 0) ? '<span class="badge text-bg-info">Sí</span>' : '<span class="badge text-bg-secondary">No</span>'}</td>
              <td class="mono">${esc(h.last_seen || '—')}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      _lastHostsInactiveCleanupEstimate = null;
      if (summary) summary.textContent = 'Error calculando hosts inactivos: ' + (e.message || 'Error');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-danger small text-center">Error calculando hosts inactivos</td></tr>';
    }
  }

  window.loadHostsInactiveCleanupEstimate = loadHostsInactiveCleanupEstimate;

  $(document).off('click.hostsInactiveCleanupEstimate', '#btnHostsInactiveCleanupEstimate').on('click.hostsInactiveCleanupEstimate', '#btnHostsInactiveCleanupEstimate', function () {
    loadHostsInactiveCleanupEstimate();
  });

  $(document).off('change.hostsInactiveCleanupInputs', '#hostsInactiveCleanupDays, #hostsInactiveCleanupIncludeKnown').on('change.hostsInactiveCleanupInputs', '#hostsInactiveCleanupDays, #hostsInactiveCleanupIncludeKnown', function () {
    _lastHostsInactiveCleanupEstimate = null;
    const summary = document.getElementById('hostsInactiveCleanupSummary');
    const tbody = document.getElementById('hostsInactiveCleanupTbody');
    if (summary) summary.textContent = 'Criterio cambiado. Recalcula antes de ejecutar.';
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="small-muted text-center">Sin cálculo actualizado</td></tr>';
  });

  $(document).off('click.hostsInactiveCleanupRunOpen', '#btnHostsInactiveCleanupRunOpen').on('click.hostsInactiveCleanupRunOpen', '#btnHostsInactiveCleanupRunOpen', async function () {
    if (!_lastHostsInactiveCleanupEstimate) {
      await loadHostsInactiveCleanupEstimate();
    }

    const estimate = _lastHostsInactiveCleanupEstimate || {};
    const count = Number(estimate.hosts_count || 0);
    const related = Number(estimate.related_rows_delete || 0);
    const mainSummary = document.getElementById('hostsInactiveCleanupSummary');
    const summary = document.getElementById('hostsInactiveCleanupConfirmSummary');

    if (!count) {
      const msg = 'No hay hosts candidatos con el criterio actual.';
      if (mainSummary) mainSummary.textContent = msg;
      if (summary) summary.textContent = msg;
      return;
    }

    const knownMsg = estimate.include_known ? 'Incluye hosts conocidos.' : 'Solo hosts no conocidos.';
    if (summary) {
      summary.textContent = `Se eliminarán ${dbFmtInt(count)} hosts inactivos sin verse en ${dbFmtInt(estimate.days || hostsInactiveCleanupDays())} días y ${dbFmtInt(related)} filas auxiliares. ${knownMsg}`;
    }

    const modalEl = document.getElementById('hostsInactiveCleanupConfirmModal');
    if (modalEl && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  });

  $(document).off('click.hostsInactiveCleanupRunConfirm', '#btnHostsInactiveCleanupRunConfirm').on('click.hostsInactiveCleanupRunConfirm', '#btnHostsInactiveCleanupRunConfirm', async function (ev) {
    ev.preventDefault();
    const btn = this;
    const days = hostsInactiveCleanupDays();
    const include_known = hostsInactiveCleanupIncludeKnown();
    const summary = document.getElementById('hostsInactiveCleanupSummary');

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Limpiando…';

    try {
      const data = await fetch('/api/hosts/inactive-cleanup-run', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ days, include_known })
      }).then(r => r.json());

      if (!data.ok) throw new Error(data.error || 'Error limpiando hosts inactivos');

      const modalEl = document.getElementById('hostsInactiveCleanupConfirmModal');
      if (modalEl && window.bootstrap) {
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }

      if (summary) {
        summary.textContent = `Limpieza aplicada: ${dbFmtInt(data.hosts_deleted || 0)} hosts y ${dbFmtInt(data.related_rows_deleted || 0)} filas auxiliares eliminadas. Backup previo: ${data.backup?.filename || 'creado'}.`;
      }

      _lastHostsInactiveCleanupEstimate = null;
      await loadBackups();
      await loadDbStorageSummary();
      await loadHostsInactiveCleanupEstimate();

      try {
        if (typeof window.loadHosts === 'function') await window.loadHosts();
        else if (typeof window.reloadHosts === 'function') await window.reloadHosts();
      } catch (_) {}
    } catch (e) {
      if (summary) summary.textContent = 'Error limpiando hosts inactivos: ' + (e.message || 'Error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });


  function preloadBackupDbPanel() {
    window.setTimeout(function () {
      try { bindBackupNowButton(); } catch (_) {}
      try { loadBackups(); } catch (_) {}
      try { loadDbStorageSummary(); } catch (_) {}
      try { loadDbRetentionEstimate(); } catch (_) {}
    }, 120);
  }

  const cfgModalForDbPreload = document.getElementById('configModal');
  if (cfgModalForDbPreload && cfgModalForDbPreload.dataset.dbPreloadBound !== '1') {
    cfgModalForDbPreload.dataset.dbPreloadBound = '1';
    cfgModalForDbPreload.addEventListener('shown.bs.modal', preloadBackupDbPanel);
  }

  $(document).off('click.cfgDbStorageRefresh', '#btnDbStorageRefresh').on('click.cfgDbStorageRefresh', '#btnDbStorageRefresh', function () {
    loadDbStorageSummary();
  });


  async function pruneBackupsNow(btnEl) {
    const $btn = $(btnEl || '#btnBackupPrune');
    const $msg = $('#cfgBackupMsg');
    if (!$btn.length) return;

    $btn.prop('disabled', true);
    $msg.text('Limpiando backups antiguos…');

    try {
      const keep = parseInt(document.getElementById('cfgBackupKeep')?.value || '7', 10) || 7;
      const data = await fetch('/api/backup/prune', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ backup_keep: keep })
      }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $msg.text(`✓ Eliminados ${data.removed_count || 0} backups · liberado ${dbFmtBytes(data.freed_bytes || 0)}`);
      await loadBackups();
      await loadDbStorageSummary();
    } catch (e) {
      $msg.text('✗ ' + (e.message || 'Error'));
    } finally {
      $btn.prop('disabled', false);
    }
  }

  async function runBackupNow(btnEl) {
    const $btn = $(btnEl || '#btnBackupNow');
    const $msg = $('#cfgBackupMsg');
    if (!$btn.length) return;

    $btn.prop('disabled', true);
    $msg.text('Creando backup…');

    try {
      const data = await fetch('/api/backup/run', { method: 'POST' }).then(r => r.json());
      $msg.text(data.ok ? '✓ ' + (data.file || 'Creado') : '✗ ' + (data.error || 'Error'));
      if (data.ok) await loadBackups();
    } catch (e) {
      $msg.text('✗ ' + e.message);
    } finally {
      $btn.prop('disabled', false);
    }
  }

  function bindBackupNowButton() {
    const btn = document.getElementById('btnBackupNow');
    if (btn && btn.dataset.backupNowBound !== '1') {
      btn.dataset.backupNowBound = '1';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        runBackupNow(btn);
      });
    }

    const pruneBtn = document.getElementById('btnBackupPrune');
    if (pruneBtn && pruneBtn.dataset.backupPruneBound !== '1') {
      pruneBtn.dataset.backupPruneBound = '1';
      pruneBtn.addEventListener('click', function (e) {
        e.preventDefault();
        pruneBackupsNow(pruneBtn);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindBackupNowButton, { once: true });
  } else {
    bindBackupNowButton();
  }

  let _backupDeletePendingName = '';

  $(document).off('click.cfgBackupDeleteOpen', '.btn-backup-del').on('click.cfgBackupDeleteOpen', '.btn-backup-del', function () {
    const name = String($(this).data('name') || '');
    _backupDeletePendingName = name;

    const summary = document.getElementById('backupDeleteConfirmSummary');
    if (summary) {
      summary.textContent = name ? `Backup seleccionado: ${name}` : 'No se ha podido identificar el backup seleccionado.';
    }

    const modalEl = document.getElementById('backupDeleteConfirmModal');
    if (modalEl && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  });

  $(document).off('click.cfgBackupDeleteConfirm', '#btnBackupDeleteConfirm').on('click.cfgBackupDeleteConfirm', '#btnBackupDeleteConfirm', async function () {
    const btn = this;
    const name = _backupDeletePendingName;
    const msg = document.getElementById('cfgBackupMsg');

    if (!name) {
      if (msg) msg.textContent = 'No se ha podido identificar el backup a eliminar.';
      return;
    }

    btn.disabled = true;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Eliminando…';

    try {
      const data = await fetch(`/api/backup/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error eliminando backup');

      const modalEl = document.getElementById('backupDeleteConfirmModal');
      if (modalEl && window.bootstrap) {
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }

      _backupDeletePendingName = '';
      if (msg) msg.textContent = `✓ Backup eliminado: ${name}`;
      await loadBackups();
      await loadDbStorageSummary();
    } catch (e) {
      if (msg) msg.textContent = '✗ ' + (e.message || 'Error eliminando backup');
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  });


  // ══════════════════════════════════════════════════════════
  // ⑫ BÚSQUEDA GLOBAL
  // ══════════════════════════════════════════════════════════

  const _gsDrop = document.getElementById('globalSearchDrop');
  let   _gsTimer = null;

  function gsClose() { if (_gsDrop) _gsDrop.style.display = 'none'; }
  function gsOpen()  { if (_gsDrop) _gsDrop.style.display = 'block'; }

  $(document).on('input', '#globalSearch', function () {
    clearTimeout(_gsTimer);
    const q = $(this).val().trim();
    if (!q) { gsClose(); return; }
    _gsTimer = setTimeout(async () => {
      try {
        const data = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`).then(r => r.json());
        if (!data.results?.length) { _gsDrop.innerHTML = '<div class="gs-empty">Sin resultados</div>'; gsOpen(); return; }
        _gsDrop.innerHTML = data.results.map(r => {
          const statusDot = r.type === 'host'
            ? `<div class="gs-status-dot ${r.status === 'online' ? 'online' : 'offline'}"></div>` : '';
          const sub  = r.type === 'host' ? esc(r.ip || '') : r.type === 'service' ? `${esc(r.host||'')}:${r.port||''}` : '';
          return `<div class="gs-item" data-type="${r.type}" data-id="${esc(r.id||r.ip||'')}" data-ip="${esc(r.ip||'')}">
            <div class="gs-icon">${r.icon || (r.type==='host'?'🖥️':r.type==='service'?'🔌':'📌')}</div>
            ${statusDot}
            <div><div class="gs-title">${esc(r.name||r.ip||r.id)}</div><div class="gs-sub">${sub}</div></div>
          </div>`;
        }).join('');
        gsOpen();
      } catch (_) {}
    }, 250);
  });

  $(document).on('click', '.gs-item', function () {
    const type = $(this).data('type'), ip = $(this).data('ip');
    gsClose(); $('#globalSearch').val('');
    if (type === 'host' && ip && typeof window.openHost === 'function') window.openHost(ip);
  });
  $(document).on('keydown', '#globalSearch', function (e) { if (e.key === 'Escape') gsClose(); });
  $(document).on('click', e => { if (!$(e.target).closest('#globalSearchWrap').length) gsClose(); });


  // ══════════════════════════════════════════════════════════
  // ⑬ TAGS DEL HOST MODAL
  // ══════════════════════════════════════════════════════════

  function _renderModalTags(tags) {
    const wrap = document.getElementById('mTagWrap');
    if (!wrap) return;
    wrap.querySelectorAll('.tag-badge').forEach(el => el.remove());
    const input = document.getElementById('mTagInput');
    tags.forEach(tag => {
      const badge = document.createElement('span');
      badge.className = 'tag-badge';
      badge.innerHTML = `${esc(tag)} <span class="tag-remove" data-tag="${esc(tag)}">×</span>`;
      wrap.insertBefore(badge, input);
    });
  }

  $(document).on('keydown', '#mTagInput', function (e) {
    if ((e.key === 'Enter' || e.key === ',') && $(this).val().trim()) {
      e.preventDefault();
      const tag = $(this).val().trim().replace(/,+$/, '');
      if (tag && !window._currentTags.includes(tag)) {
        window._currentTags.push(tag);
        _renderModalTags(window._currentTags);
      }
      $(this).val('');
    }
  });
  $(document).on('blur', '#mTagInput', function () {
    const tag = $(this).val().trim();
    if (tag && !window._currentTags.includes(tag)) {
      window._currentTags.push(tag); _renderModalTags(window._currentTags);
    }
    $(this).val('');
  });
  $(document).on('click', '.tag-remove', function () {
    const tag = $(this).data('tag');
    window._currentTags = window._currentTags.filter(t => t !== tag);
    _renderModalTags(window._currentTags);
  });
  $(document).on('click', '#mTagWrap', function (e) {
    if (e.target === this || e.target.id === 'mTagInput') document.getElementById('mTagInput')?.focus();
  });

  $(document).on('click', '#mTagSave', async function () {
    const ip = window._currentTagIp;
    if (!ip) return;
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch(`/api/hosts/${encodeURIComponent(ip)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: window._currentTags })
      }).then(r => r.json());
      if (data.ok) {
        $('#mTagMsg').text('✓ Guardado');
        const $tr = $(`tr[data-ip="${CSS.escape(ip)}"]`);
        $tr.data('tags', window._currentTags.join(','));
        $tr.find('td.tags-hidden').text(window._currentTags.join(','));
        setTimeout(() => $('#mTagMsg').text(''), 2000);
      } else {
        $('#mTagMsg').text('✗ ' + (data.error || 'Error'));
      }
    } catch (e) { $('#mTagMsg').text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ⑭ EXPORTACIÓN PERIÓDICA (XLSX)
  // ══════════════════════════════════════════════════════════

  function _updateExportStatus(data) {
    const $s = $('#exportStatus');
    if (!$s.length) return;
    if (!data.enabled) {
      $s.html('<span class="text-muted small">Desactivada</span>');
      return;
    }
    let html = '<span class="text-success small"><i class="bi bi-check-circle me-1"></i>Activa</span>';
    if (data.last_run) {
      const lastRun = String(data.last_run).replace('T', ' ').slice(0, 16);
      html += ` &nbsp;·&nbsp; <span class="text-muted small">Última: ${esc(lastRun)}</span>`;
    }
    if (data.last_file) {
      html += ` &nbsp;·&nbsp; <span class="text-muted small"><i class="bi bi-file-earmark-excel me-1"></i>${esc(data.last_file)}</span>`;
    }
    $s.html(html);
  }

  function _toggleExportFields(enabled) {
    const $fields = $('#exportFieldsWrap');
    if (!$fields.length) return;
    enabled ? $fields.show() : $fields.hide();
  }

  function _updateExportDayUI(freq, day) {
    const $dayWrap  = $('#exportDayWrap');
    const $wdayWrap = $('#exportWeekdayWrap');
    if (!$dayWrap.length || !$wdayWrap.length) return;

    if (freq === 'weekly') {
      $dayWrap.hide();
      $wdayWrap.show();
      $('#exportWeekday').val(day);
    } else if (freq === 'monthly') {
      $wdayWrap.hide();
      $dayWrap.show();
      $('#exportMonthDay').val(day || 1);
    } else {
      $dayWrap.hide();
      $wdayWrap.hide();
    }
  }

  function loadExportConfig() {
    return fetch('/api/export/xlsx/config')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(data => {
        $('#exportEnabled').prop('checked', !!data.enabled);
        $('#exportPath').val(data.path || '/data/exports');
        $('#exportFrequency').val(data.frequency || 'weekly');
        $('#exportHour').val(data.hour !== undefined ? data.hour : 6);

        const day = data.day !== undefined ? data.day : 0;
        _updateExportDayUI(data.frequency || 'weekly', day);
        $('#exportWeekday').val(day);
        $('#exportMonthDay').val(day || 1);

        _updateExportStatus(data);
        _toggleExportFields(!!data.enabled);
      })
      .catch(() => {
        $('#exportStatus').html('<span class="text-danger small">Error cargando configuración</span>');
      });
  }

  $(document).on('change', '#exportEnabled', function () {
    _toggleExportFields($(this).prop('checked'));
  });

  $(document).on('change', '#exportFrequency', function () {
    const day = parseInt($('#exportWeekday').val() || $('#exportMonthDay').val() || 0, 10);
    _updateExportDayUI($(this).val(), day);
  });

  $(document).on('click', '#exportSaveBtn', async function () {
    const $btn = $(this);
    const payload = {
      enabled: $('#exportEnabled').prop('checked'),
      path: ($('#exportPath').val() || '').trim(),
      frequency: $('#exportFrequency').val(),
      day: $('#exportFrequency').val() === 'weekly'
        ? parseInt($('#exportWeekday').val() || 0, 10)
        : $('#exportFrequency').val() === 'monthly'
          ? parseInt($('#exportMonthDay').val() || 1, 10)
          : 0,
      hour: parseInt($('#exportHour').val() || 6, 10),
    };

    if (!payload.path) {
      $('#exportStatus').html('<span class="text-warning small">Indica una ruta de destino</span>');
      return;
    }

    $btn.prop('disabled', true);
    $('#exportStatus').html('<span class="text-muted small">Guardando…</span>');
    try {
      const data = await fetch('/api/export/xlsx/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());

      if (data.ok) {
        $('#exportStatus').html('<span class="text-success small">Configuración guardada</span>');
        await loadExportConfig();
      } else {
        $('#exportStatus').html(`<span class="text-danger small">${esc(data.error || 'Error guardando')}</span>`);
      }
    } catch (e) {
      $('#exportStatus').html(`<span class="text-danger small">${esc(e.message || 'Error guardando')}</span>`);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).on('click', '#exportNowBtn', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    $('#exportStatus').html('<span class="text-muted small">Exportando…</span>');
    try {
      const data = await fetch('/api/export/xlsx/now', { method: 'POST' }).then(r => r.json());
      if (data.ok) {
        $('#exportStatus').html(`<span class="text-success small">Exportado: ${esc(data.file || '')}</span>`);
        await loadExportConfig();
      } else {
        $('#exportStatus').html(`<span class="text-danger small">${esc(data.error || 'Error en exportación')}</span>`);
      }
    } catch (e) {
      $('#exportStatus').html(`<span class="text-danger small">${esc(e.message || 'Error en exportación')}</span>`);
    } finally {
      $btn.prop('disabled', false);
    }
  });


  // ══════════════════════════════════════════════════════════
  // ⑮ SCRIPTS MONITORIZADOS (Config → Automatizaciones)
  // ══════════════════════════════════════════════════════════

  async function loadMonitoredScripts() {
    try {
      const [cfgData, statusData] = await Promise.all([
        fetch('/api/config/scripts').then(r => r.ok ? r.json() : { scripts: [] }).catch(() => ({ scripts: [] })),
        fetch('/api/scripts/status').then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const scripts   = cfgData.scripts || [];
      const statusMap = {};
      (Array.isArray(statusData) ? statusData : []).forEach(s => { statusMap[s.name] = s; });
      const $count = $('#cfgScriptCount'); if ($count.length) $count.text(scripts.length);

      const $tbody = $('#cfgScriptTbody');
      if (!$tbody.length) return;
      if (!scripts.length) {
        // Mostrar mensaje con botón para importar automáticamente desde scripts_status/
        $tbody.html(`<tr><td colspan="10" class="text-center text-muted py-3">
          <i class="bi bi-info-circle me-1"></i>Sin scripts configurados.
          <button class="btn btn-outline-info btn-sm ms-2 py-0 px-2" id="cfgScriptImportNowBtn">
            <i class="bi bi-download me-1"></i>${esc(window.t?.('cfg.scripts.import_all_status', 'Importar todos los .status.json') || 'Importar todos los .status.json')}
          </button>
        </td></tr>`);
        return;
      }
      // El backend devuelve {id, script_name, label, ...}
      $tbody.html(scripts.map((s, idx) => {
        const st = statusMap[s.script_name] || {};
        const stateBadge = st.state === 'ok' ? '<span class="badge bg-success">OK</span>'
          : st.state === 'error' ? '<span class="badge bg-danger">Error</span>'
          : st.state ? `<span class="badge bg-secondary">${esc(st.state)}</span>` : '—';
        return `<tr data-script="${esc(s.script_name)}" data-script-id="${s.id}">
          <td>${idx + 1}</td>
          <td class="mono" style="font-size:.8rem">${esc(s.script_name)}</td>
          <td><input class="form-control form-control-sm cfg-script-host" value="${esc(s.host_name||'Local')}" placeholder="Local"></td>
          <td><input class="form-control form-control-sm cfg-script-label" value="${esc(s.label||'')}" placeholder="${esc(s.script_name)}"></td>
          <td><input class="form-control form-control-sm cfg-script-desc" value="${esc(s.description||'')}"></td>
          <td><input class="form-control form-control-sm cfg-script-cron mono" value="${esc(s.cron_expr||'')}" placeholder="${esc(window.t?.('cfg.scripts.cron_placeholder', 'sin cron') || 'sin cron')}" title="${esc(window.t?.('cfg.scripts.cron_title', 'Cron informativo para calcular próxima ejecución; Auditor IPs no modifica ni lee el crontab real') || 'Cron informativo para calcular próxima ejecución; Auditor IPs no modifica ni lee el crontab real')}"></td>
          <td><input class="form-control form-control-sm cfg-script-cron-source" value="${esc(s.cron_source||'')}" placeholder="${esc(window.t?.('cfg.scripts.cron_source_placeholder', 'Ej: ServerLinuxAuxiliar / root crontab') || 'Ej: ServerLinuxAuxiliar / root crontab')}"></td>
          <td><input type="color" class="form-control form-control-sm form-control-color cfg-script-color" value="${esc(s.color||'#4dffb5')}" style="width:44px;padding:2px"></td>
          <td><input type="checkbox" class="form-check-input cfg-script-active" ${s.active ? 'checked' : ''}></td>
          <td><div class="d-flex gap-1">
            ${stateBadge}
            <button class="btn btn-outline-success btn-sm py-0 px-1 cfg-script-save" title="${esc(window.t?.('common.save', 'Guardar') || 'Guardar')}"><i class="bi bi-save2"></i></button>
            <button class="btn btn-outline-danger btn-sm py-0 px-1 cfg-script-del" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
          </div></td>
        </tr>`;
      }).join(''));

      $tbody.find('.cfg-script-cron').each(function () { cfgValidateTableCronInput(this); });

      // Pending scripts (not yet configured)
      _loadPendingScripts(scripts.map(s => s.script_name));
    } catch (e) { console.error('loadMonitoredScripts:', e); }
  }

  async function _loadPendingScripts(configured) {
    try {
      const data = await fetch('/api/scripts/status').then(r => r.json()).catch(() => []);
      const all  = Array.isArray(data) ? data : [];
      const pending = all.filter(s => !configured.includes(s.name));
      const $sec  = $('#cfgScriptPendingSection'), $list = $('#cfgScriptPendingList'), $cnt = $('#cfgScriptPendingCount');
      if (!$sec.length) return;
      if (!pending.length) { $sec.hide(); return; }
      $sec.show();
      if ($cnt.length) $cnt.text(pending.length);
      $list.html(pending.map(s =>
        `<button class="btn btn-outline-secondary btn-sm cfg-script-pick" data-name="${esc(s.name)}">${esc(s.name)}</button>`
      ).join(''));
    } catch (_) {}
  }

  $(document).on('click', '.cfg-script-pick', function () {
    const name = $(this).data('name');
    $('#cfgScriptName').val(name);
    $('#cfgScriptLabel').val(name);
  });

  $(document).on('input change', '#cfgScriptCron', cfgValidateMainCron);
  $(document).on('input change', '.cfg-script-cron', function () { cfgValidateTableCronInput(this); });


  // ─────────────────────────────────────────────────
  // Asistente guiado de alta de script
  // ─────────────────────────────────────────────────
  let cfgScriptWizardStatus = [];
  let cfgScriptWizardConfigured = [];

  function cfgScriptWizardLabelFromName(name) {
    return String(name || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function cfgScriptWizardHost(s) {
    return String(s?.host_name || s?.cfg_host_name || 'Local').trim() || 'Local';
  }

  function cfgCronParseField(field, min, max) {
    const raw = String(field || '').trim();
    if (!raw) return { ok: false, error: 'campo vacío' };
    if (raw === '*') {
      return { ok: true, any: true, values: new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i)) };
    }

    const values = new Set();
    const parts = raw.split(',');
    for (const partRaw of parts) {
      const part = String(partRaw || '').trim();
      if (!part) return { ok: false, error: `lista inválida en "${raw}"` };

      const stepPieces = part.split('/');
      if (stepPieces.length > 2) return { ok: false, error: `paso inválido en "${part}"` };

      const base = stepPieces[0];
      const step = stepPieces.length === 2 ? Number(stepPieces[1]) : 1;
      if (!Number.isInteger(step) || step <= 0) return { ok: false, error: `paso inválido en "${part}"` };

      let start;
      let end;

      if (base === '*') {
        start = min;
        end = max;
      } else if (/^\d+$/.test(base)) {
        start = end = Number(base);
      } else {
        const m = base.match(/^(\d+)-(\d+)$/);
        if (!m) return { ok: false, error: `valor inválido "${part}"` };
        start = Number(m[1]);
        end = Number(m[2]);
      }

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        return { ok: false, error: `rango fuera de límite "${part}"` };
      }

      for (let v = start; v <= end; v += step) values.add(v);
    }

    return { ok: true, any: raw === '*', values };
  }

  function cfgCronParse(expr) {
    const cron = String(expr || '').trim();
    if (!cron) {
      return { ok: true, empty: true, message: 'Sin cron: no se calculará próxima ejecución ni watchdog missed.' };
    }

    const parts = cron.split(/\s+/);
    if (parts.length !== 5) {
      return { ok: false, message: 'Cron inválido: usa 5 campos: min hora día mes semana.' };
    }

    const specs = [
      ['minuto', 0, 59],
      ['hora', 0, 23],
      ['día del mes', 1, 31],
      ['mes', 1, 12],
      ['día semana', 0, 7],
    ];

    const parsed = [];
    for (let i = 0; i < specs.length; i++) {
      const [label, min, max] = specs[i];
      const r = cfgCronParseField(parts[i], min, max);
      if (!r.ok) return { ok: false, message: `Cron inválido en ${label}: ${r.error}.` };
      parsed.push(r);
    }

    return { ok: true, empty: false, parts, parsed };
  }

  function cfgCronMatchesDate(date, parsed) {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dom = date.getDate();
    const month = date.getMonth() + 1;
    const dow = date.getDay();

    const [m, h, d, mo, w] = parsed;

    const minuteMatch = m.values.has(minute);
    const hourMatch = h.values.has(hour);
    const monthMatch = mo.values.has(month);
    const domMatch = d.any ? true : d.values.has(dom);
    const dowMatch = w.any ? true : (w.values.has(dow) || (dow === 0 && w.values.has(7)));
    const dayMatch = (!d.any && !w.any) ? (domMatch || dowMatch) : (domMatch && dowMatch);

    return minuteMatch && hourMatch && monthMatch && dayMatch;
  }

  function cfgCronNextRun(expr) {
    const parsed = cfgCronParse(expr);
    if (!parsed.ok || parsed.empty) return { ...parsed, next: null };

    const now = new Date();
    const candidate = new Date(now.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    const maxMinutes = 366 * 24 * 60;
    for (let i = 0; i < maxMinutes; i++) {
      if (cfgCronMatchesDate(candidate, parsed.parsed)) {
        return { ...parsed, next: new Date(candidate.getTime()) };
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    return { ok: false, message: 'Cron válido, pero no se encontró próxima ejecución en 366 días.' };
  }

  function cfgCronFormatDate(date) {
    if (!date) return '';
    try {
      return new Intl.DateTimeFormat(navigator.language || 'es-ES', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
  }

  function cfgApplyCronValidation(inputEl, feedbackEl) {
    if (!inputEl) return { ok: true, empty: true };
    const result = cfgCronNextRun(inputEl.value || '');

    inputEl.classList.remove('is-valid', 'is-invalid');
    if (feedbackEl) feedbackEl.classList.remove('text-success', 'text-warning', 'text-danger', 'text-muted');

    if (result.empty) {
      if (feedbackEl) {
        feedbackEl.classList.add('text-muted');
        feedbackEl.textContent = 'Formato: min hora día mes semana. Sin cron no habrá próxima ejecución ni missed por watchdog.';
      }
      inputEl.title = 'Cron opcional. Formato: min hora día mes semana.';
      return result;
    }

    if (!result.ok) {
      inputEl.classList.add('is-invalid');
      inputEl.title = result.message || 'Cron inválido';
      if (feedbackEl) {
        feedbackEl.classList.add('text-danger');
        feedbackEl.textContent = result.message || 'Cron inválido.';
      }
      return result;
    }

    inputEl.classList.add('is-valid');
    const msg = `Cron válido. Próxima ejecución aprox.: ${cfgCronFormatDate(result.next)}.`;
    inputEl.title = msg;
    if (feedbackEl) {
      feedbackEl.classList.add('text-success');
      feedbackEl.textContent = msg;
    }
    return result;
  }

  function cfgValidateMainCron() {
    return cfgApplyCronValidation(
      document.getElementById('cfgScriptCron'),
      document.getElementById('cfgScriptCronFeedback')
    );
  }

  function cfgValidateWizardCron() {
    return cfgApplyCronValidation(
      document.getElementById('cfgScriptWizardCron'),
      document.getElementById('cfgScriptWizardCronFeedback')
    );
  }

  function cfgValidateTableCronInput(inputEl) {
    return cfgApplyCronValidation(inputEl, null);
  }

  function cfgScriptWizardRefreshSummary() {
    const name = ($('#cfgScriptWizardName').val() || '').trim();
    const host = ($('#cfgScriptWizardHost').val() || 'Local').trim();
    const label = ($('#cfgScriptWizardLabel').val() || name).trim();
    const cron = ($('#cfgScriptWizardCron').val() || '').trim();
    const source = ($('#cfgScriptWizardCronSource').val() || '').trim();
    const active = $('#cfgScriptWizardActive').is(':checked');
    const createAlert = $('#cfgScriptWizardCreateAlert').is(':checked');
    const alertMissed = $('#cfgScriptWizardAlertMissed').is(':checked');
    const alertHours = parseFloat($('#cfgScriptWizardAlertHours').val() || 25);
    const alertError = $('#cfgScriptWizardAlertError').is(':checked');
    const alertRunningLong = $('#cfgScriptWizardAlertRunningLong').is(':checked');
    const alertRunningHours = parseFloat($('#cfgScriptWizardAlertRunningHours').val() || 6);
    const alertCooldown = parseInt($('#cfgScriptWizardAlertCooldown').val() || 60, 10);

    const cronCheck = cfgCronNextRun(cron);
    const configured = cfgScriptWizardConfigured.includes(name);
    const warnings = [];
    if (!name) warnings.push('Falta el nombre técnico.');
    if (!cron) warnings.push('Sin cron: no se calculará próxima ejecución ni watchdog missed.');
    else if (!cronCheck.ok) warnings.push(cronCheck.message || 'Cron inválido.');
    if (configured) warnings.push('Ya existe una configuración con ese nombre.');

    cfgValidateWizardCron();

    $('#cfgScriptWizardSummary').html(`
      <div><strong>${esc(label || 'Sin etiqueta')}</strong> <code>${esc(name || '—')}</code></div>
      <div class="text-muted">Host: <strong>${esc(host)}</strong> · Estado: ${active ? 'activo' : 'inactivo'}</div>
      <div class="text-muted">Cron: <code>${esc(cron || 'sin cron')}</code>${source ? ` · ${esc(source)}` : ''}${cronCheck.ok && cronCheck.next ? ` · próxima aprox.: ${esc(cfgCronFormatDate(cronCheck.next))}` : ''}</div>
      <div class="text-muted">Alerta: ${createAlert ? `sin ejecutar ${esc(alertHours)}h=${alertMissed ? 'sí' : 'no'} · error=${alertError ? 'sí' : 'no'} · ejecución larga ${esc(alertRunningHours)}h=${alertRunningLong ? 'sí' : 'no'} · cooldown ${esc(alertCooldown)}min` : 'no crear regla inicial'}</div>
      ${warnings.length ? `<div class="text-warning mt-1"><i class="bi bi-exclamation-triangle me-1"></i>${esc(warnings.join(' '))}</div>` : '<div class="text-success mt-1"><i class="bi bi-check2-circle me-1"></i>Listo para crear.</div>'}
    `);
  }

  function cfgScriptWizardFillFromStatus(indexValue) {
    if (indexValue === '' || indexValue === null || indexValue === undefined) {
      cfgScriptWizardRefreshSummary();
      return;
    }

    const idx = Number(indexValue);
    const s = Number.isInteger(idx) ? cfgScriptWizardStatus[idx] : null;
    if (!s) {
      cfgScriptWizardRefreshSummary();
      return;
    }

    const scriptName = String(s.name || '').trim();

    $('#cfgScriptWizardName').val(scriptName);
    $('#cfgScriptWizardHost').val(cfgScriptWizardHost(s));
    $('#cfgScriptWizardLabel').val(s?.cfg_label || cfgScriptWizardLabelFromName(scriptName));
    $('#cfgScriptWizardDesc').val(s?.description || '');
    $('#cfgScriptWizardCron').val(s?.cron_expr || s?.cfg_cron_expr || '');
    $('#cfgScriptWizardCronSource').val(s?.cron_source || s?.cfg_cron_source || '');
    $('#cfgScriptWizardColor').val(s?.cfg_color || '#4dffb5');
    $('#cfgScriptWizardActive').prop('checked', true);
    cfgScriptWizardRefreshSummary();
  }

  async function cfgScriptWizardLoad() {
    $('#cfgScriptWizardMsg').removeClass('text-danger text-success').addClass('text-muted').text('Cargando scripts detectados…');

    const [cfgData, statusData] = await Promise.all([
      fetch('/api/config/scripts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { scripts: [] }).catch(() => ({ scripts: [] })),
      fetch('/api/scripts/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    cfgScriptWizardConfigured = (cfgData.scripts || []).map(s => String(s.script_name || ''));
    cfgScriptWizardStatus = (Array.isArray(statusData) ? statusData : [])
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), navigator.language || 'es', { numeric: true, sensitivity: 'base' }));

    const $sel = $('#cfgScriptWizardSource');
    const opts = ['<option value="">Manual / escribir nuevo nombre</option>'];
    cfgScriptWizardStatus.forEach((s, idx) => {
      const name = String(s.name || '');
      const configured = cfgScriptWizardConfigured.includes(name);
      const host = cfgScriptWizardHost(s);
      opts.push(`<option value="${idx}">${esc(name)} · ${esc(host)}${configured ? ' · ya configurado' : ''}</option>`);
    });
    $sel.html(opts.join(''));

    $('#cfgScriptWizardMsg').removeClass('text-danger').addClass('text-muted').text('Selecciona un script detectado o completa los datos manualmente.');
    cfgScriptWizardRefreshSummary();
  }

  $(document).on('click', '#cfgScriptWizardBtn', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    $('#cfgScriptWizardMsg').removeClass('text-danger text-success').addClass('text-muted').text('');
    $('#cfgScriptWizardSource').val('');
    $('#cfgScriptWizardName').val($('#cfgScriptName').val() || '');
    $('#cfgScriptWizardHost').val($('#cfgScriptHost').val() || 'Local');
    $('#cfgScriptWizardLabel').val($('#cfgScriptLabel').val() || '');
    $('#cfgScriptWizardDesc').val($('#cfgScriptDesc').val() || '');
    $('#cfgScriptWizardCron').val($('#cfgScriptCron').val() || '');
    $('#cfgScriptWizardCronSource').val($('#cfgScriptCronSource').val() || '');
    $('#cfgScriptWizardColor').val($('#cfgScriptColor').val() || '#4dffb5');
    $('#cfgScriptWizardActive').prop('checked', true);
    cfgScriptWizardRefreshSummary();

    const modalEl = document.getElementById('cfgScriptWizardModal');
    if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();

    try { await cfgScriptWizardLoad(); }
    catch (e) { $('#cfgScriptWizardMsg').removeClass('text-muted').addClass('text-danger').text('Error cargando datos: ' + (e.message || e)); }
  });

  $(document).on('change', '#cfgScriptWizardSource', function (e) {
    e.preventDefault();
    e.stopPropagation();
    cfgScriptWizardFillFromStatus(this.value);
  });

  $(document).on('input change', '#cfgScriptWizardName,#cfgScriptWizardHost,#cfgScriptWizardLabel,#cfgScriptWizardDesc,#cfgScriptWizardCron,#cfgScriptWizardCronSource,#cfgScriptWizardColor,#cfgScriptWizardActive,#cfgScriptWizardCreateAlert,#cfgScriptWizardAlertMissed,#cfgScriptWizardAlertHours,#cfgScriptWizardAlertError,#cfgScriptWizardAlertRunningLong,#cfgScriptWizardAlertRunningHours,#cfgScriptWizardAlertCooldown', cfgScriptWizardRefreshSummary);

  $(document).on('click', '#cfgScriptWizardFillBtn', function (e) {
    e.preventDefault();
    e.stopPropagation();
    $('#cfgScriptName').val(($('#cfgScriptWizardName').val() || '').trim());
    $('#cfgScriptHost').val(($('#cfgScriptWizardHost').val() || 'Local').trim());
    $('#cfgScriptLabel').val(($('#cfgScriptWizardLabel').val() || '').trim());
    $('#cfgScriptDesc').val(($('#cfgScriptWizardDesc').val() || '').trim());
    $('#cfgScriptCron').val(($('#cfgScriptWizardCron').val() || '').trim());
    $('#cfgScriptCronSource').val(($('#cfgScriptWizardCronSource').val() || '').trim());
    $('#cfgScriptColor').val($('#cfgScriptWizardColor').val() || '#4dffb5');
    $('#cfgScriptAddMsg').text('Datos pasados desde el asistente. Revisa y pulsa Añadir.');
    const modalEl = document.getElementById('cfgScriptWizardModal');
    if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
  });


  async function cfgScriptWizardSaveAlertRule(scriptName, hostName) {
    const payload = {
      host_name: hostName || 'Local',
      alert_missed: $('#cfgScriptWizardAlertMissed').is(':checked'),
      max_hours: parseFloat($('#cfgScriptWizardAlertHours').val() || 25),
      alert_error: $('#cfgScriptWizardAlertError').is(':checked'),
      alert_running_long: $('#cfgScriptWizardAlertRunningLong').is(':checked'),
      max_running_hours: parseFloat($('#cfgScriptWizardAlertRunningHours').val() || 6),
      cooldown_min: parseInt($('#cfgScriptWizardAlertCooldown').val() || 60, 10),
    };

    const res = await fetch(`/api/scripts/alert-rules/${encodeURIComponent(scriptName)}?host=${encodeURIComponent(hostName || 'Local')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.detail || `HTTP ${res.status}`);
    }
    return data;
  }

  $(document).on('click', '#cfgScriptWizardCreateBtn', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const name = ($('#cfgScriptWizardName').val() || '').trim();
    const cronCheck = cfgValidateWizardCron();
    if (!cronCheck.ok) {
      $('#cfgScriptWizardMsg').removeClass('text-muted text-success').addClass('text-danger').text('✗ ' + (cronCheck.message || 'Cron inválido'));
      return;
    }
    if (!name) {
      $('#cfgScriptWizardMsg').removeClass('text-muted text-success').addClass('text-danger').text('Falta el nombre técnico.');
      return;
    }

    const payload = {
      script_name: name,
      host_name: ($('#cfgScriptWizardHost').val() || 'Local').trim(),
      label: ($('#cfgScriptWizardLabel').val() || name).trim(),
      description: ($('#cfgScriptWizardDesc').val() || '').trim(),
      color: $('#cfgScriptWizardColor').val() || '#4dffb5',
      active: $('#cfgScriptWizardActive').is(':checked'),
      cron_expr: ($('#cfgScriptWizardCron').val() || '').trim(),
      cron_source: ($('#cfgScriptWizardCronSource').val() || '').trim(),
      host_source: 'config_ui',
    };

    const $btn = $('#cfgScriptWizardCreateBtn');
    $btn.prop('disabled', true);
    $('#cfgScriptWizardMsg').removeClass('text-danger text-success').addClass('text-muted').text('Creando configuración…');

    try {
      const data = await fetch('/api/config/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json());

      if (!data.ok) throw new Error(data.error || 'No se pudo crear la configuración.');

      let alertMsg = '';
      if ($('#cfgScriptWizardCreateAlert').is(':checked')) {
        await cfgScriptWizardSaveAlertRule(payload.script_name, payload.host_name);
        alertMsg = ' Regla de alerta creada.';
      }

      $('#cfgScriptWizardMsg').removeClass('text-muted text-danger').addClass('text-success').text('✓ Configuración creada.' + alertMsg);
      window.showToast?.('✓ Configuración de script creada' + alertMsg, 'success');
      await loadMonitoredScripts();
      try { await loadScriptAlertRules(); } catch (_) {}

      setTimeout(() => {
        const modalEl = document.getElementById('cfgScriptWizardModal');
        if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
      }, 500);
    } catch (e) {
      $('#cfgScriptWizardMsg').removeClass('text-muted text-success').addClass('text-danger').text('✗ ' + (e.message || e));
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).on('click', '#cfgScriptAddBtn', async function () {
    const name  = ($('#cfgScriptName').val()  || '').trim();
    const label = ($('#cfgScriptLabel').val() || '').trim();
    const desc  = ($('#cfgScriptDesc').val()  || '').trim();
    const color = ($('#cfgScriptColor').val() || '#4dffb5');
    const cronExpr = ($('#cfgScriptCron').val() || '').trim();
    const cronSource = ($('#cfgScriptCronSource').val() || '').trim();
    const hostName = ($('#cfgScriptHost').val() || 'Local').trim();
    const cronCheck = cfgValidateMainCron();
    if (!cronCheck.ok) { $('#cfgScriptAddMsg').text('✗ ' + (cronCheck.message || 'Cron inválido')); return; }
    if (!name) { $('#cfgScriptAddMsg').text(window.t?.('cfg.scripts.name_required', 'Nombre requerido') || 'Nombre requerido'); return; }
    $('#cfgScriptAddMsg').text(window.t?.('cfg.scripts.adding', 'Añadiendo…') || 'Añadiendo…');
    try {
      const data = await fetch('/api/config/scripts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ script_name: name, label, description: desc, color, active: true, cron_expr: cronExpr, cron_source: cronSource, host_name: hostName, host_source: 'config_ui' }) }).then(r => r.json());
      $('#cfgScriptAddMsg').text(data.ok ? (window.t?.('cfg.scripts.added', '✓ Añadido') || '✓ Añadido') : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'));
      if (data.ok) { $('#cfgScriptName,#cfgScriptHost,#cfgScriptLabel,#cfgScriptDesc,#cfgScriptCron,#cfgScriptCronSource').val(''); $('#cfgScriptHost').val('Local'); await loadMonitoredScripts(); }
    } catch (e) { $('#cfgScriptAddMsg').text('✗ ' + e.message); }
  });

  // Botón "Importar todos" que aparece cuando la lista está vacía
  $(document).on('click', '#cfgScriptImportNowBtn', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true).html(`<span class="spinner-border spinner-border-sm me-1"></span>${esc(window.t?.('cfg.scripts.importing', 'Importando…') || 'Importando…')}`);
    try {
      const data = await fetch('/api/config/scripts/import-all', { method: 'POST' }).then(r => r.json());
      window.showToast?.(
        data.ok ? (window.t?.('cfg.scripts.import_result', '✓ {added} scripts importados ({skipped} ya existían)', { added: data.added, skipped: data.skipped }) || `✓ ${data.added} scripts importados (${data.skipped} ya existían)`) : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'),
        data.ok ? 'success' : 'danger'
      );
      if (data.ok) await loadMonitoredScripts();
    } catch (e) {
      window.showToast?.('✗ ' + e.message, 'danger');
    } finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgScriptImportAllBtn', async function () {
    // Versión alternativa: importar uno a uno desde la lista de pendientes
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch('/api/config/scripts/import-all', { method: 'POST' }).then(r => r.json());
      window.showToast?.(
        data.ok ? (window.t?.('cfg.scripts.import_result_short', '✓ {added} añadidos, {skipped} ya existían', { added: data.added, skipped: data.skipped }) || `✓ ${data.added} añadidos, ${data.skipped} ya existían`) : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'),
        data.ok ? 'success' : 'danger'
      );
      if (data.ok) await loadMonitoredScripts();
    } catch (e) { window.showToast?.('✗ ' + e.message, 'danger'); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '.cfg-script-save', async function () {
    const tr = $(this).closest('tr');
    // Usar el id numérico del backend (data-script-id), no el nombre
    const id = tr.data('script-id');
    if (!id) { window.showToast?.(window.t?.('cfg.scripts.id_missing', 'ID de script no encontrado') || 'ID de script no encontrado', 'danger'); return; }
    const cronInput = tr.find('.cfg-script-cron').get(0);
    const cronCheck = cfgValidateTableCronInput(cronInput);
    if (!cronCheck.ok) {
      window.showToast?.('✗ ' + (cronCheck.message || 'Cron inválido'), 'danger');
      return;
    }

    const payload = {
      label:       tr.find('.cfg-script-label').val(),
      description: tr.find('.cfg-script-desc').val(),
      color:       tr.find('.cfg-script-color').val(),
      active:      tr.find('.cfg-script-active').is(':checked') ? 1 : 0,
      cron_expr:   (tr.find('.cfg-script-cron').val() || '').trim(),
      cron_source: (tr.find('.cfg-script-cron-source').val() || '').trim(),
      host_name:   (tr.find('.cfg-script-host').val() || 'Local').trim(),
      host_source: 'config_ui',
    };
    const data = await fetch(`/api/config/scripts/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
    window.showToast?.(data.ok ? (window.t?.('cfg.scripts.updated', '✓ Script actualizado') || '✓ Script actualizado') : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'), data.ok ? 'success' : 'danger');
    if (data.ok) await loadMonitoredScripts();
  });

  $(document).on('click', '.cfg-script-del', async function () {
    const tr   = $(this).closest('tr');
    const id   = tr.data('script-id');
    const name = tr.data('script');
    if (!(await window.appConfirm(`¿Eliminar la configuración de "${name}"?`, {
      title: 'Eliminar configuración de script',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    const data = await fetch(`/api/config/scripts/${id}`, { method: 'DELETE' }).then(r => r.json());
    window.showToast?.(data.ok ? (window.t?.('cfg.scripts.deleted', '✓ Eliminado') || '✓ Eliminado') : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'), data.ok ? 'success' : 'danger');
    if (data.ok) await loadMonitoredScripts();
  });



  // ══════════════════════════════════════════════════════════
  // ⑮.b AGENTES API REMOTOS (Config → Procesos)
  // ══════════════════════════════════════════════════════════

  function _cfgAgentStatusBadge(agent) {
    const enabled = Number(agent.enabled || 0) === 1;
    const revoked = !!String(agent.revoked_at || '').trim();
    if (revoked) return '<span class="badge bg-danger">Revocado</span>';
    if (!enabled) return '<span class="badge bg-secondary">Deshabilitado</span>';
    return '<span class="badge bg-success">Activo</span>';
  }

  function _cfgAgentFormatDate(v) {
    const raw = String(v || '').trim();
    if (!raw) return '—';

    if (typeof window.fmtDateTime === 'function') {
      try {
        const formatted = window.fmtDateTime(raw);
        if (formatted && formatted !== 'Invalid Date') return formatted;
      } catch (_) {}
    }

    return raw;
  }

  function _cfgAgentShowMsg(msg, ok) {
    const $msg = $('#cfgAgentMsg');
    if (!$msg.length) return;
    $msg
      .removeClass('text-success text-danger text-warning text-muted')
      .addClass(ok ? 'text-success' : 'text-danger')
      .text(msg || '');
  }

  function _cfgAgentShowToken(token) {
    const wrap = document.getElementById('cfgAgentCreatedTokenWrap');
    const inp = document.getElementById('cfgAgentCreatedToken');
    if (!wrap || !inp) return;
    inp.value = token || '';
    wrap.classList.toggle('d-none', !token);
    if (token) {
      try { inp.focus(); inp.select(); } catch (_) {}
    }
  }

  async function loadAutomationAgents() {
    const $tbody = $('#cfgAgentTbody');
    if (!$tbody.length) return;

    $tbody.html('<tr><td colspan="7" class="text-center text-muted py-3">Cargando agentes…</td></tr>');

    try {
      const res = await fetch('/api/scripts/automation-agents', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

      const agents = Array.isArray(data.agents) ? data.agents : [];
      $('#cfgAgentCount').text(agents.length);

      if (!agents.length) {
        $tbody.html('<tr><td colspan="7" class="text-center text-muted py-3">No hay agentes API configurados.</td></tr>');
        return;
      }

      $tbody.html(agents.map(a => {
        const host = String(a.host_name || '');
        const enabled = Number(a.enabled || 0) === 1;
        const notes = String(a.notes || '');
        const prefix = String(a.token_prefix || '');
        const lastSeen = _cfgAgentFormatDate(a.last_seen_at);
        const lastScript = String(a.last_status_script || '') || '—';

        return `<tr data-agent-host="${esc(host)}">
          <td>
            <div class="fw-semibold">${esc(host)}</div>
            <div class="small text-muted">API host</div>
          </td>
          <td>${_cfgAgentStatusBadge(a)}</td>
          <td><code>${esc(prefix || '—')}</code></td>
          <td class="small">${esc(lastSeen)}</td>
          <td class="small"><code>${esc(lastScript)}</code></td>
          <td style="min-width:210px">
            <input class="form-control form-control-sm cfg-agent-notes" value="${esc(notes)}" placeholder="${esc(window.t?.('cfg.agent.notes_placeholder', 'Notas') || 'Notas')}">
          </td>
          <td class="text-end">
            <div class="d-inline-flex gap-1 flex-wrap justify-content-end">
              <button class="btn btn-outline-success btn-sm py-0 px-2 cfg-agent-save" title="${esc(window.t?.('cfg.agent.save_title', 'Guardar notas/estado') || 'Guardar notas/estado')}">
                <i class="bi bi-save2"></i>
              </button>
              <button class="btn ${enabled ? 'btn-outline-secondary' : 'btn-outline-success'} btn-sm py-0 px-2 cfg-agent-toggle"
                      data-enabled="${enabled ? '1' : '0'}"
                      title="${esc(enabled ? (window.t?.('cfg.agent.disable', 'Deshabilitar') || 'Deshabilitar') : (window.t?.('cfg.agent.enable', 'Habilitar') || 'Habilitar'))}">
                <i class="bi ${enabled ? 'bi-pause-fill' : 'bi-play-fill'}"></i>
              </button>
              <button class="btn btn-outline-warning btn-sm py-0 px-2 cfg-agent-rotate" title="${esc(window.t?.('cfg.agent.rotate', 'Rotar token') || 'Rotar token')}">
                <i class="bi bi-arrow-repeat"></i>
              </button>
              <button class="btn btn-outline-danger btn-sm py-0 px-2 cfg-agent-revoke" title="${esc(window.t?.('cfg.agent.revoke', 'Revocar') || 'Revocar')}">
                <i class="bi bi-slash-circle"></i>
              </button>
            </div>
          </td>
        </tr>`;
      }).join(''));
    } catch (e) {
      $tbody.html(`<tr><td colspan="7" class="text-danger text-center py-3">${esc(window.t?.('cfg.agent.load_error', 'Error cargando agentes: {error}', { error: e.message || e }) || ('Error cargando agentes: ' + (e.message || e)))}</td></tr>`);
    }
  }

  async function loadAutomationAgentEvents() {
    const $tbody = $('#cfgAgentEventsBody');
    if (!$tbody.length) return;

    $tbody.html(`<tr><td colspan="6" class="text-center text-muted py-3">${esc(window.t?.('cfg.agent.loading_events', 'Cargando eventos…') || 'Cargando eventos…')}</td></tr>`);

    try {
      const res = await fetch('/api/scripts/automation-agents/events?limit=50', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

      const events = Array.isArray(data.events) ? data.events : [];
      if (!events.length) {
        $tbody.html(`<tr><td colspan="6" class="text-center text-muted py-3">${esc(window.t?.('cfg.agent.no_events', 'No hay eventos relevantes registrados. Las recepciones OK repetitivas se ocultan.') || 'No hay eventos relevantes registrados. Las recepciones OK repetitivas se ocultan.')}</td></tr>`);
        return;
      }

      $tbody.html(events.map(ev => {
        const ok = Number(ev.ok || 0) === 1;
        const detail = String(ev.detail || '');
        return `<tr>
          <td class="small text-nowrap">${esc(_cfgAgentFormatDate(ev.at))}</td>
          <td class="small"><code>${esc(ev.host_name || '—')}</code></td>
          <td class="small">${esc(ev.ip || '—')}</td>
          <td><span class="badge bg-secondary">${esc(ev.action || '—')}</span></td>
          <td>${ok ? '<span class="badge bg-success">OK</span>' : '<span class="badge bg-danger">Error</span>'}</td>
          <td class="small" style="max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(detail)}">${esc(detail || '—')}</td>
        </tr>`;
      }).join(''));
    } catch (e) {
      $tbody.html(`<tr><td colspan="6" class="text-danger text-center py-3">${esc(window.t?.('cfg.agent.events_error', 'Error cargando eventos: {error}', { error: e.message || e }) || ('Error cargando eventos: ' + (e.message || e)))}</td></tr>`);
    }
  }

  $(document).on('click', '#cfgAgentRefresh', function () {
    loadAutomationAgents();
  });

  $(document).on('click', '#cfgAgentEventsRefresh', function () {
    loadAutomationAgentEvents();
  });

  $(document).on('click', '#cfgAgentCopyToken', async function () {
    const token = $('#cfgAgentCreatedToken').val() || '';
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      window.showToast?.(window.t?.('cfg.agent.token_copied', 'Token copiado') || 'Token copiado', 'success');
    } catch (_) {
      $('#cfgAgentCreatedToken')[0]?.select();
      window.showToast?.(window.t?.('cfg.agent.token_copy_manual', 'Copia manualmente el token seleccionado') || 'Copia manualmente el token seleccionado', 'warning');
    }
  });

  $(document).on('click', '#cfgAgentAddBtn', async function () {
    const host = ($('#cfgAgentHost').val() || '').trim();
    const notes = ($('#cfgAgentNotes').val() || '').trim();
    const enabled = $('#cfgAgentEnabled').is(':checked') ? 1 : 0;

    if (!host) {
      _cfgAgentShowMsg(window.t?.('cfg.agent.host_required', 'Host requerido') || 'Host requerido', false);
      return;
    }

    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgAgentShowMsg(window.t?.('cfg.agent.creating', 'Creando agente…') || 'Creando agente…', true);
    _cfgAgentShowToken('');

    try {
      const res = await fetch('/api/scripts/automation-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host_name: host, notes, enabled })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

      _cfgAgentShowMsg(window.t?.('cfg.agent.created', '✓ Agente creado. Copia el token antes de cerrar.') || '✓ Agente creado. Copia el token antes de cerrar.', true);
      _cfgAgentShowToken(data.token || '');
      $('#cfgAgentHost,#cfgAgentNotes').val('');
      $('#cfgAgentEnabled').prop('checked', true);

      await loadAutomationAgents();
      await loadAutomationAgentEvents();
    } catch (e) {
      _cfgAgentShowMsg('✗ ' + (e.message || e), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).on('click', '.cfg-agent-save', async function () {
    const $tr = $(this).closest('tr');
    const host = String($tr.data('agent-host') || '');
    const notes = ($tr.find('.cfg-agent-notes').val() || '').trim();

    try {
      const res = await fetch(`/api/scripts/automation-agents/${encodeURIComponent(host)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok !== false;
      window.showToast?.(ok ? (window.t?.('cfg.agent.saved', '✓ Agente guardado') || '✓ Agente guardado') : '✗ ' + (data.detail || data.error || window.t?.('status.error', 'Error') || 'Error'), ok ? 'success' : 'danger');
      if (ok) await loadAutomationAgents();
    } catch (e) {
      window.showToast?.('✗ ' + (e.message || e), 'danger');
    }
  });

  $(document).on('click', '.cfg-agent-toggle', async function () {
    const $tr = $(this).closest('tr');
    const host = String($tr.data('agent-host') || '');
    const currentlyEnabled = String($(this).data('enabled') || '0') === '1';
    const newEnabled = currentlyEnabled ? 0 : 1;
    const notes = ($tr.find('.cfg-agent-notes').val() || '').trim();

    try {
      const res = await fetch(`/api/scripts/automation-agents/${encodeURIComponent(host)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, enabled: newEnabled })
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok !== false;
      window.showToast?.(ok ? (newEnabled ? (window.t?.('cfg.agent.enabled', '✓ Agente habilitado') || '✓ Agente habilitado') : (window.t?.('cfg.agent.disabled', '✓ Agente deshabilitado') || '✓ Agente deshabilitado')) : '✗ ' + (data.detail || data.error || window.t?.('status.error', 'Error') || 'Error'), ok ? 'success' : 'danger');
      if (ok) {
        await loadAutomationAgents();
        await loadAutomationAgentEvents();
      }
    } catch (e) {
      window.showToast?.('✗ ' + (e.message || e), 'danger');
    }
  });

  $(document).on('click', '.cfg-agent-rotate', async function () {
    const $btn = $(this);
    const $tr = $btn.closest('tr');
    const host = String($tr.data('agent-host') || '');

    if (String($btn.data('armed') || '0') !== '1') {
      $btn.data('armed', '1').removeClass('btn-outline-warning').addClass('btn-warning');
      window.showToast?.(window.t?.('cfg.agent.rotate_confirm', 'Pulsa rotar otra vez para confirmar') || 'Pulsa rotar otra vez para confirmar', 'warning');
      setTimeout(() => {
        $btn.data('armed', '0').removeClass('btn-warning').addClass('btn-outline-warning');
      }, 2500);
      return;
    }

    try {
      const res = await fetch(`/api/scripts/automation-agents/${encodeURIComponent(host)}/rotate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `HTTP ${res.status}`);

      _cfgAgentShowMsg(window.t?.('cfg.agent.rotated', '✓ Token rotado para {host}. Copia el nuevo token.', { host }) || `✓ Token rotado para ${host}. Copia el nuevo token.`, true);
      _cfgAgentShowToken(data.token || '');
      await loadAutomationAgents();
      await loadAutomationAgentEvents();
    } catch (e) {
      window.showToast?.('✗ ' + (e.message || e), 'danger');
    } finally {
      $btn.data('armed', '0').removeClass('btn-warning').addClass('btn-outline-warning');
    }
  });

  $(document).on('click', '.cfg-agent-revoke', async function () {
    const $btn = $(this);
    const $tr = $btn.closest('tr');
    const host = String($tr.data('agent-host') || '');

    if (String($btn.data('armed') || '0') !== '1') {
      $btn.data('armed', '1').removeClass('btn-outline-danger').addClass('btn-danger');
      window.showToast?.(window.t?.('cfg.agent.revoke_confirm', 'Pulsa revocar otra vez para confirmar') || 'Pulsa revocar otra vez para confirmar', 'warning');
      setTimeout(() => {
        $btn.data('armed', '0').removeClass('btn-danger').addClass('btn-outline-danger');
      }, 2500);
      return;
    }

    try {
      const res = await fetch(`/api/scripts/automation-agents/${encodeURIComponent(host)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok !== false;
      window.showToast?.(ok ? (window.t?.('cfg.agent.revoked', '✓ Agente revocado') || '✓ Agente revocado') : '✗ ' + (data.detail || data.error || window.t?.('status.error', 'Error') || 'Error'), ok ? 'success' : 'danger');
      if (ok) {
        await loadAutomationAgents();
        await loadAutomationAgentEvents();
      }
    } catch (e) {
      window.showToast?.('✗ ' + (e.message || e), 'danger');
    } finally {
      $btn.data('armed', '0').removeClass('btn-danger').addClass('btn-outline-danger');
    }
  });


  // ══════════════════════════════════════════════════════════
  // ⑯ IA SETTINGS
  // ══════════════════════════════════════════════════════════

  function _toggleAiFields(provider) {
    $('#cfgAiGeminiSection').toggle(provider === 'gemini');
    $('#cfgAiMistralSection').toggle(provider === 'mistral');
    $('#cfgAiOllamaSection').toggle(provider === 'ollama');
  }

  $(document).on('change', '#cfgAiProvider', function () { _toggleAiFields($(this).val()); });
  $(document).on('click', '#cfgAiKeyToggle', function () {
    const $inp = $('#cfgAiGeminiKey');
    $inp.attr('type', $inp.attr('type') === 'password' ? 'text' : 'password');
  });
  $(document).on('click', '#cfgAiMistralKeyToggle', function () {
    const $inp = $('#cfgAiMistralKey');
    $inp.attr('type', $inp.attr('type') === 'password' ? 'text' : 'password');
  });

  $(document).on('click', '#cfgAiSave', async function () {
    const $btn = $(this), $msg = $('#cfgAiMsg');
    $btn.prop('disabled', true); $msg.text('Guardando…');
    const provider = $('#cfgAiProvider').val() || 'gemini';
    const payload = {
      ai_provider:      provider,
      ai_gemini_key:    $('#cfgAiGeminiKey').val()  || '',
      ai_gemini_model:  $('#cfgAiGeminiModel').val()|| 'gemini-2.0-flash',
      ai_mistral_key:   $('#cfgAiMistralKey').val() || '',
      ai_mistral_model: $('#cfgAiMistralModel').val()|| 'mistral-small-latest',
      ai_ollama_url:    $('#cfgAiOllamaUrl').val()  || 'http://localhost:11434',
      ai_ollama_model:  $('#cfgAiOllamaModel').val()|| 'gemma2:2b',
    };
    try {
      const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
      $msg.text(data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'));
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgAiTest', async function () {
    const $btn = $(this), $msg = $('#cfgAiTestMsg');
    $btn.prop('disabled', true); $msg.text('Probando IA…').removeClass('text-success text-danger');
    try {
      const data = await fetch('/api/scripts/ollama/status').then(r => r.json());
      if (data.available) {
        $msg.addClass('text-success').text(`✓ ${data.provider || 'IA'} · ${data.model} · listo`);
      } else {
        $msg.addClass('text-danger').text('✗ No disponible: ' + (data.error || ''));
      }
    } catch (e) { $msg.addClass('text-danger').text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ⑰ REDES (NETWORKS)
  // ══════════════════════════════════════════════════════════

  let _netAutosaveTimer = null;
  let _availableIfaces  = [];

  async function loadNetworks() {
    try {
      const [cfgData, ifaceData] = await Promise.all([
        fetch('/api/settings').then(r => r.json()),
        fetch('/api/quality/interfaces').then(r => r.json()).catch(() => ({ interfaces: [] })),
      ]);
      _availableIfaces = (ifaceData.interfaces || []).map(i => i.name);
      const s = cfgData.settings || {};

      // Primary CIDR — BD usa scan_cidr (no scan_range)
      const primary = (s.scan_cidr || '').split(',').map(x => x.trim()).filter(Boolean);
      _renderCidrChips(primary);

      // Primary interface — BD usa primary_net_interface
      _loadPrimaryIfaceSelector(s.primary_net_interface || '');

      // Secondary networks table
      const nets = s.secondary_networks || [];
      _renderNetTable(nets);

      // Scan interval
      const $iSel = $('#intervalSelect'); if ($iSel.length) {
        const v = String(s.scan_interval || 900);
        if (!$iSel.find(`option[value="${v}"]`).length)
          $iSel.append(`<option value="${v}">${_humanizeSecs(parseInt(v))} (personalizado)</option>`);
        $iSel.val(v);
        $('#intervalInput').val(v);
      }

    } catch (e) { console.error('loadNetworks:', e); }
  }

  function _renderIfaceOptions(selected = '') {
    return '<option value="">— automática —</option>' +
      _availableIfaces.map(n => `<option value="${esc(n)}"${selected===n?' selected':''}>${esc(n)}</option>`).join('');
  }

  function _refreshIfaceSelectors() {
    $('.net-iface-sel').each(function () {
      const cur = $(this).val();
      $(this).html(_renderIfaceOptions(cur));
    });
    const $pri = $('#cfgPrimaryIface');
    if ($pri.length) { const cur = $pri.val(); $pri.html(_renderIfaceOptions(cur)); }
  }

  async function _detectHostInterfaces() {
    try {
      const data = await fetch('/api/quality/interfaces').then(r => r.json());
      _availableIfaces = (data.interfaces || []).map(i => i.name);
      _refreshIfaceSelectors();
    } catch (e) { console.error('_detectHostInterfaces:', e); }
  }

  function _renderNetTable(nets) {
    const $tbody = $('#cfgNetTbody');
    if (!$tbody.length) return;
    $tbody.empty();
    nets.forEach(n => {
      $tbody.append(_netRow(n));
    });
  }

  function _netRow(n) {
    return `<tr data-net-id="${n.id || ''}">
      <td><input class="form-control form-control-sm net-label-inp" value="${esc(n.label||'')}"></td>
      <td><input class="form-control form-control-sm mono net-cidr-inp" value="${esc(n.cidr||'')}" placeholder="192.168.2.0/24"></td>
      <td>
        <div class="d-flex align-items-center gap-1">
          <select class="form-select form-select-sm net-iface-sel" style="max-width:140px">${_renderIfaceOptions(n.iface||'')}</select>
          <button class="btn btn-outline-secondary btn-sm py-0 px-1 cfgNetIfaceToggle" title="${esc(window.t?.('common.detect_interfaces', 'Detectar interfaces') || 'Detectar interfaces')}"><i class="bi bi-arrow-repeat"></i></button>
        </div>
      </td>
      <td class="text-center"><input type="checkbox" class="form-check-input net-enabled-chk" ${n.enabled!==false?'checked':''}></td>
      <td><div class="d-flex gap-1">
        <button class="btn btn-outline-success btn-sm py-0 px-1 net-save-btn" title="${esc(window.t?.('common.save', 'Guardar') || 'Guardar')}"><i class="bi bi-save2"></i></button>
        <button class="btn btn-outline-danger btn-sm py-0 px-1 net-del-btn" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
      </div></td>
    </tr>`;
  }

  async function _loadPrimaryIfaceSelector(selected) {
    const $sel = $('#cfgPrimaryIface');
    if (!$sel.length) return;
    if (!_availableIfaces.length) await _detectHostInterfaces();
    $sel.html(_renderIfaceOptions(selected));
  }

  $(document).on('click', '#cfgNetAdd', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch('/api/config/networks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ label:'', cidr:'', interface:'', enabled: true }) }).then(r => r.json());
      if (data.ok) { await loadNetworks(); } else { window.showToast?.(window.t?.('cfg.network.add_error', 'Error añadiendo red: {error}', { error: data.error || '' }) || ('Error añadiendo red: ' + (data.error||'')), 'danger'); }
    } catch (e) { window.showToast?.('Error: ' + e.message, 'danger'); }
    finally { $btn.prop('disabled', false); }
  });

  async function _saveNetworkRow($tr, $btn) {
    if ($btn) $btn.prop('disabled', true);
    const id    = $tr.data('net-id') || $tr.data('id');
    const label = ($tr.find('.net-label-inp').val() || '').trim();
    const cidr  = ($tr.find('.net-cidr-inp').val() || '').trim();
    const iface = (($tr.find('.net-iface-sel').val() ?? $tr.find('.net-iface-inp').val()) || '').trim();
    const enabled = $tr.find('.net-enabled-chk').is(':checked') || $tr.find('.net-enabled-inp').is(':checked');
    if (!cidr) {
      if ($btn) $btn.prop('disabled', false);
      return;
    }
    try {
      const url  = id ? `/api/config/networks/${id}` : '/api/config/networks';
      const meth = id ? 'PUT' : 'POST';
      const data = await fetch(url, { method: meth, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ label, cidr, interface: iface, enabled }) }).then(r => r.json());
      if (data.ok) {
        _queueTopbarRangesRefresh(50);
        await loadNetworks();
      } else {
        window.showToast?.(window.t?.('cfg.network.save_error', 'Error guardando red: {error}', { error: data.error || '' }) || ('Error guardando red: ' + (data.error || '')), 'danger');
      }
    } catch (e) { window.showToast?.('Error: ' + e.message, 'danger'); }
    finally { if ($btn) $btn.prop('disabled', false); }
  }

  function _queueNetworkAutosave($tr) {
    clearTimeout(_netAutosaveTimer);
    _netAutosaveTimer = setTimeout(() => _saveNetworkRow($tr), 1500);
  }

  $(document).on('click', '.cfgNetIfaceToggle', async function () {
    const $i = $(this).find('i'); $i.addClass('spin');
    await _detectHostInterfaces(); $i.removeClass('spin');
  });
  $(document).on('input change', '.net-label-inp, .net-cidr-inp, .net-iface-sel, .net-iface-inp, .net-enabled-chk, .net-enabled-inp', function () {
    _queueNetworkAutosave($(this).closest('tr'));
  });
  $(document).on('blur', '.net-label-inp, .net-cidr-inp', function () {
    clearTimeout(_netAutosaveTimer); _saveNetworkRow($(this).closest('tr'));
  });
  $(document).on('click', '.net-save-btn', function () {
    _saveNetworkRow($(this).closest('tr'), $(this));
  });
  $(document).on('click', '.net-del-btn', async function () {
    const $tr = $(this).closest('tr'), id = $tr.data('net-id');
    if (!id) { $tr.remove(); return; }
    if (!(await window.appConfirm('¿Eliminar esta red?', {
      title: 'Eliminar red',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    await fetch(`/api/config/networks/${id}`, { method: 'DELETE' });
    await loadNetworks();
  });

  $(document).on('click', '#cfgPrimaryIfaceRefresh', async function () {
    const $i = $(this).find('i'); $i.addClass('spin');
    await _detectHostInterfaces(); $i.removeClass('spin');
  });

  $(document).on('click', '#cfgPrimaryNetSave', async function () {
    const $btn = $(this), $msg = $('#cfgPrimaryNetMsg');
    $btn.prop('disabled', true); $msg.text('Guardando…');
    const cidrVal   = _getCidrValue() || ($('#cidrInput').val() || '').trim();
    const ifaceVal  = $('#cfgPrimaryIface').val() || '';
    const interval  = parseInt($('#intervalSelect').val() || $('#intervalInput').val() || 900);
    const scanBoot  = $('#bootScan').is(':checked') ? 1 : 0;
    try {
      const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scan_cidr: cidrVal, primary_net_interface: ifaceVal, scan_interval: interval, scan_on_boot: scanBoot }) }).then(r => r.json());
      $msg.text(data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'));
      if (data.ok) _queueTopbarRangesRefresh(50);
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });

  $(document).on('click', '#cfgNetIfaceToggle', async function () {
    const $i = $(this).find('i'); $i.addClass('spin');
    await _detectHostInterfaces(); $i.removeClass('spin');
  });

  $(document).on('input', '#cfgPrimaryIface', function () {
    _queueTopbarRangesRefresh(100);
  });


  // ══════════════════════════════════════════════════════════
  // ⑱ DISCREPANCIAS
  // ══════════════════════════════════════════════════════════

  async function loadDiscrepancies() {
    const $wrap = $('#discrepancyWrap');
    if (!$wrap.length) return;
    $wrap.html('<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-info"></div></div>');
    try {
      const data  = await fetch('/api/scan/discrepancies').then(r => r.json());
      const rows  = data.discrepancies || [];
      const badge = document.getElementById('discBadge');
      const pending = rows.filter(r => !r.accepted);
      if (badge) badge.textContent = pending.length || '';

      if (!rows.length) { $wrap.html(`<div class="small-muted py-2">${esc(window.t?.('cfg.discrepancies.none', 'Sin discrepancias registradas.') || 'Sin discrepancias registradas.')}</div>`); return; }

      $wrap.html(`<div class="table-responsive"><table class="table table-sm table-hover align-middle">
        <thead><tr><th>IP</th><th>MAC</th><th>Primera vez</th><th>Última vez</th><th>Estado</th><th>Acciones</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td class="mono">${esc(r.ip)}</td>
          <td class="mono" style="font-size:.78rem">${esc(r.mac||'—')}</td>
          <td class="mono" style="font-size:.78rem">${esc(r.first_seen||'—')}</td>
          <td class="mono" style="font-size:.78rem">${esc(r.last_seen||'—')}</td>
          <td>${r.accepted ? `<span class="badge bg-success">${esc(window.t?.('cfg.discrepancies.accepted', 'Aceptada') || 'Aceptada')}</span>` : `<span class="badge bg-warning text-dark">${esc(window.t?.('cfg.discrepancies.pending', 'Pendiente') || 'Pendiente')}</span>`}</td>
          <td><div class="d-flex gap-1">
            ${!r.accepted ? `<button class="btn btn-outline-success btn-sm py-0 px-2 disc-accept" data-id="${r.id}" title="Aceptar"><i class="bi bi-check-lg"></i></button>` : ''}
            <button class="btn btn-outline-danger btn-sm py-0 px-2 disc-delete" data-id="${r.id}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
          </div></td>
        </tr>`).join('')}</tbody>
      </table></div>`);
    } catch (e) { $wrap.html(`<div class="text-danger small">Error: ${esc(e.message)}</div>`); }
  }

  $(document).on('click', '.cfg-nav-btn[data-section="scanner"]', function () {
    loadDiscrepancies();
    loadDetectionMotor();
    loadAiReports();
  });
  $(document).on('click', '#discRefreshBtn', () => loadDiscrepancies());
  $(document).on('click', '#discNmapNowBtn', async function () {
    const $btn = $(this), $msg = $('#discNmapMsg');
    $btn.prop('disabled', true); $msg.text('Lanzando scan nmap…');
    try {
      const data = await fetch('/api/scan/nmap-now', { method: 'POST' }).then(r => r.json());
      $msg.text(data.ok ? '✓ Scan completado' : '✗ ' + (data.error || 'Error'));
      if (data.ok) await loadDiscrepancies();
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });
  $(document).on('click', '#discAcceptAllBtn', async function () {
    await fetch('/api/scan/discrepancies/accept-all', { method: 'POST' });
    await loadDiscrepancies();
  });
  $(document).on('click', '.disc-accept', async function () {
    const id = $(this).data('id');
    await fetch(`/api/scan/discrepancies/${id}/accept`, { method: 'POST' });
    await loadDiscrepancies();
  });
  $(document).on('click', '.disc-delete', async function () {
    const id = $(this).data('id');
    if (!(await window.appConfirm('¿Eliminar esta discrepancia?', {
      title: 'Eliminar discrepancia',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    await fetch(`/api/scan/discrepancies/${id}`, { method: 'DELETE' });
    await loadDiscrepancies();
  });


  // ══════════════════════════════════════════════════════════
  // ⑲ MOTOR DE DETECCIÓN
  // ══════════════════════════════════════════════════════════

  async function loadDetectionMotor() {
    const $sec = $('#cfgDetectionSection');
    if (!$sec.length) return;
    try {
      const data = await fetch('/api/scan/detection-config').then(r => r.json());
      const s    = data.config || {};
      const get  = id => document.getElementById(id);
      if (get('cfgPrimarySource'))    get('cfgPrimarySource').value   = s.primary_source    || 'nmap';
      if (get('cfgSecondarySource'))  get('cfgSecondarySource').value = s.secondary_source  || 'nmap';
      if (get('cfgSecondaryEnabled')) get('cfgSecondaryEnabled').checked = !!s.secondary_enabled;
      if (get('cfgSecondaryInterval')) get('cfgSecondaryInterval').value = s.secondary_interval || 7200;
      if (get('cfgAiPostScan'))       get('cfgAiPostScan').checked    = !!s.ai_post_scan;
      _updateSecondaryVisibility(s.secondary_source || 'nmap');
    } catch (_) {}
  }

  function _updateSecondaryVisibility(val) {
    const $row = $('#cfgSecondaryIntervalRow');
    if ($row.length) $row.toggle(val !== 'disabled');
  }

  $(document).on('change', '#cfgSecondarySource', function () { _updateSecondaryVisibility($(this).val()); });

  $(document).on('click', '#cfgDetectionSave', async function () {
    const $btn = $(this), $msg = $('#cfgDetectionMsg');
    $btn.prop('disabled', true); $msg.text('Guardando…');
    const payload = {
      primary_source:       document.getElementById('cfgPrimarySource')?.value    || 'nmap',
      secondary_source:     document.getElementById('cfgSecondarySource')?.value  || 'nmap',
      secondary_enabled:    document.getElementById('cfgSecondaryEnabled')?.checked ? 1 : 0,
      secondary_interval:   parseInt(document.getElementById('cfgSecondaryInterval')?.value || 7200),
      ai_post_scan:         document.getElementById('cfgAiPostScan')?.checked ? 1 : 0,
    };
    try {
      const data = await fetch('/api/scan/detection-config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
      $msg.text(data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'));
      if (data.ok) { await fetch('/api/scan/reconfigure-jobs', { method: 'POST' }).catch(() => {}); }
    } catch (e) { $msg.text('✗ ' + e.message); }
    finally { $btn.prop('disabled', false); }
  });


  // ══════════════════════════════════════════════════════════
  // ⑳ CONFIG MODAL — LISTENER ÚNICO DE APERTURA
  // Carga todos los datos al abrir el modal por primera vez
  // ══════════════════════════════════════════════════════════

  let _cfgLoaded = false;

  document.getElementById('configModal')?.addEventListener('show.bs.modal', async function () {
    if (_cfgLoaded) return;
    _cfgLoaded = true;
    try {
      const data = await fetch('/api/settings').then(r => r.json());
      const s    = data.settings || {};
      populateCfgForm(s);
      try {
        if (typeof window.cfgPopulateModern === 'function') await window.cfgPopulateModern(s);
      } catch (e) { console.warn('[cfg] cfgPopulateModern(show):', e?.message || e); }

      // Router SSH fields
      const get = id => document.getElementById(id);
      if (get('cfgRouterHost'))       get('cfgRouterHost').value        = s.router_ssh_host || '';
      if (get('cfgRouterPort'))       get('cfgRouterPort').value        = s.router_ssh_port || 22;
      if (get('cfgRouterUser'))       get('cfgRouterUser').value        = s.router_ssh_user || '';
      if (get('cfgRouterKey'))        get('cfgRouterKey').value         = s.router_ssh_key  || '';  // BD: router_ssh_key
      if (get('cfgRouterEnabled'))    get('cfgRouterEnabled').checked   = s.router_enabled === '1' || s.router_enabled === 1;
      const wolToggle = _cfgWolToggleEl();
      if (wolToggle) wolToggle.checked = !!s.wol_public;
      if (get('cfgAuthEnabled'))      get('cfgAuthEnabled').checked     = !!s.auth_enabled;

      // IA
      if (get('cfgAiProvider'))   { get('cfgAiProvider').value  = s.ai_provider  || 'gemini'; _toggleAiFields(s.ai_provider || 'gemini'); }
      if (get('cfgAiGeminiKey'))   get('cfgAiGeminiKey').value  = s.ai_gemini_key   || '';
      if (get('cfgAiMistralKey'))  get('cfgAiMistralKey').value = s.ai_mistral_key  || '';
      if (get('cfgAiOllamaUrl'))   get('cfgAiOllamaUrl').value  = s.ai_ollama_url   || 'http://localhost:11434';
      try { _cfgApplyAiSecretHints(s); } catch (_) {}

      // Load sub-sections in parallel — each wrapped so one 404 doesn't block others
      await Promise.allSettled([
        loadNetworks().catch(e => console.warn('[cfg] loadNetworks:', e.message)),
        loadMonitoredScripts().catch(e => console.warn('[cfg] loadMonitoredScripts:', e.message)),
        loadScriptAlertRules().catch(e => console.warn('[cfg] loadScriptAlertRules:', e.message)),
        loadExportConfig().catch(e => console.warn('[cfg] loadExportConfig:', e.message)),
        cfgLoadTypes().catch(e => console.warn('[cfg] cfgLoadTypes:', e.message)),
        ensureVapidKeys().catch(e => console.warn('[cfg] ensureVapidKeys:', e.message)),
        initPush().catch(e => console.warn('[cfg] initPush:', e.message)),
        loadHiddenTabs().catch(e => console.warn('[cfg] loadHiddenTabs:', e.message)),
        loadWolPublicHosts().catch(e => console.warn('[cfg] loadWolPublicHosts:', e.message)),
        (window.loadDiscoveryScannersPreview ? window.loadDiscoveryScannersPreview() : Promise.resolve()).catch(e => console.warn('[cfg] loadDiscoveryScannersPreview:', e.message)),
        (window.loadRouterProfilesPreview ? window.loadRouterProfilesPreview() : Promise.resolve()).catch(e => console.warn('[cfg] loadRouterProfilesPreview:', e.message)),
      ]);
    } catch (e) {
      console.error('Config modal init:', e);
      _cfgLoaded = false; // allow retry on next open
    }
  });

  // Reset on close so next open re-fetches fresh data if needed
  document.getElementById('configModal')?.addEventListener('hidden.bs.modal', function () {
    _cfgLoaded = false;
    _docsLoaded = false;  // permitir recarga de docs si el contenido cambió
    _cfgWolPublicLoaded = false;
    _cfgWolPublicLoading = false;
    _cfgWolPublicItems = [];
    _cfgWolPublicSavedState = null;
    _cfgWolPublicSavedSignature = '';
    _cfgWolPublicResetFeedback();
  });

  // Sidebar navigation — usa [data-panel] en lugar de #cfg-{section} que no existe
  $(document).on('click', '.cfg-nav-btn', function () {
    const section = $(this).data('section');
    $('.cfg-nav-btn').removeClass('active');
    $(this).addClass('active');
    $('.cfg-panel').hide();
    $(`[data-panel="${section}"]`).show();
    if (section === 'networks')  { loadNetworks(); }
    if (section === 'backup')    { bindBackupNowButton(); loadBackups(); loadDbStorageSummary(); loadDbRetentionEstimate(); loadHostsInactiveCleanupEstimate(); }
    if (section === 'system_health') { loadConfigSystemHealth(); }
    if (section === 'scripts')   { loadMonitoredScripts(); loadScriptAlertRules(); loadAutomationAgents(); loadAutomationAgentEvents(); }
    if (section === 'exports')   { loadExportConfig(); }
    if (section === 'auth')      { loadWolPublicHosts(false).catch(e => console.warn('[cfg] loadWolPublicHosts(auth):', e.message)); }
    if (section === 'docs')      { loadDocsPanel(); }
  });


  // ══════════════════════════════════════════════════════════
  // ㉑ ALERTAS POR SCRIPT
  // ══════════════════════════════════════════════════════════

  async function loadScriptAlertRules() {
    const $wrap = $('#cfgScriptAlertsList');
    if (!$wrap.length) return;

    const t = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);
    $wrap.html(`<div class="text-muted small">${esc(t('status.loading', 'Loading…'))}</div>`);

    try {
      const [rulesData, statusData] = await Promise.all([
        fetch('/api/scripts/alert-rules').then(r => r.json()),
        fetch('/api/scripts/status').then(r => r.json()).catch(() => []),
      ]);

      const rules = rulesData.rules || [];
      const scripts = Array.isArray(statusData) ? statusData : [];

      const scriptHost = s => String(s.host_name || s.cfg_host_name || 'Local');
      const scriptKey = s => String(s.instance_key || `${scriptHost(s)}::${s.name || ''}`);

      const scriptMap = {};
      scripts.forEach(s => { scriptMap[scriptKey(s)] = s; });

      const scriptOptions = scripts.map(s => {
        const host = scriptHost(s);
        const name = String(s.name || '');
        const label = s.cfg_label || name;
        return `<option value="${esc(scriptKey(s))}" data-host="${esc(host)}" data-script="${esc(name)}">${esc(host)} / ${esc(label)}</option>`;
      }).join('');

      const rows = rules.map(r => {
        const host = String(r.host_name || 'Local');
        const name = String(r.script_name || '');
        const key = String(r.instance_key || `${host}::${name}`);
        const s = scriptMap[key] || {};
        const label = esc(s.cfg_label || name);
        const scriptName = esc(name);
        const hostLabel = esc(host);

        const missedChecked = r.alert_missed !== 0 && r.alert_missed !== false;
        const errorChecked = r.alert_error !== 0 && r.alert_error !== false;
        const runningLongChecked = r.alert_running_long === 1 || r.alert_running_long === true;

        return `<tr data-script="${scriptName}" data-host="${hostLabel}" data-key="${esc(key)}">
          <td style="min-width:230px">
            <div class="fw-semibold">${label}</div>
            <div class="small text-muted mono">${scriptName}</div>
          </td>
          <td class="small" style="min-width:100px">${hostLabel}</td>
          <td>
            <div class="d-flex flex-wrap gap-2 align-items-center">
              <label class="d-inline-flex align-items-center gap-1 small mb-0">
                <input type="checkbox" class="form-check-input mt-0 cfg-sal-missed" ${missedChecked ? 'checked' : ''}>
                <span>Sin ejecutar</span>
              </label>
              <div class="input-group input-group-sm" style="width:120px">
                <input type="number" class="form-control form-control-sm cfg-sal-hours" value="${r.max_hours ?? 25}" min="1">
                <span class="input-group-text">h</span>
              </div>

              <label class="d-inline-flex align-items-center gap-1 small mb-0 ms-2">
                <input type="checkbox" class="form-check-input mt-0 cfg-sal-error" ${errorChecked ? 'checked' : ''}>
                <span>Error</span>
              </label>

              <label class="d-inline-flex align-items-center gap-1 small mb-0 ms-2">
                <input type="checkbox" class="form-check-input mt-0 cfg-sal-running-long" ${runningLongChecked ? 'checked' : ''}>
                <span>Ejec. larga</span>
              </label>
              <div class="input-group input-group-sm" style="width:120px">
                <input type="number" class="form-control form-control-sm cfg-sal-running-hours" value="${r.max_running_hours ?? 6}" min="0.1" step="0.1">
                <span class="input-group-text">h</span>
              </div>
            </div>
          </td>
          <td style="width:150px">
            <div class="input-group input-group-sm">
              <input type="number" class="form-control form-control-sm cfg-sal-cooldown" value="${r.cooldown_min ?? 60}" min="1">
              <span class="input-group-text">min</span>
            </div>
          </td>
          <td class="text-nowrap" style="width:90px">
            <button class="btn btn-outline-success btn-sm py-0 px-2 cfg-script-alert-save"
                    title="${esc(t('cfg.scripts.alerts.save_rule', 'Guardar cambios'))}"
                    aria-label="${esc(t('cfg.scripts.alerts.save_rule', 'Guardar cambios'))}">
              <i class="bi bi-save2"></i>
            </button>
            <button class="btn btn-outline-danger btn-sm py-0 px-2 cfg-script-alert-del"
                    title="${esc(t('cfg.scripts.alerts.delete_rule', 'Eliminar regla'))}"
                    aria-label="${esc(t('cfg.scripts.alerts.delete_rule', 'Eliminar regla'))}">
              <i class="bi bi-trash3"></i>
            </button>
          </td>
        </tr>`;
      }).join('');

      $wrap.html(`
        <div class="d-flex justify-content-between align-items-center gap-2 flex-wrap mb-2">
          <div class="small text-muted">
            Crea reglas explícitas por <strong>Host + Script</strong>. Las filas inferiores son reglas ya guardadas.
          </div>
          <button type="button" class="btn btn-outline-info btn-sm" id="cfgScriptAlertAddToggle" ${scripts.length ? '' : 'disabled'}>
            <i class="bi bi-plus-lg me-1"></i>Añadir regla
          </button>
        </div>

        <div class="cfg-section mb-3 d-none" id="cfgScriptAlertAddBox">
          <div class="row g-2 align-items-end">
            <div class="col-12 col-xl-4">
              <label class="form-label small-muted mb-1">Host / Script</label>
              <select class="form-select form-select-sm" id="cfgScriptAlertNewScript">
                ${scriptOptions || '<option value="">No hay scripts disponibles</option>'}
              </select>
            </div>

            <div class="col-12 col-md-6 col-xl-2">
              <div class="border rounded-2 p-2 h-100">
                <label class="d-flex align-items-center gap-2 small mb-2">
                  <input type="checkbox" class="form-check-input mt-0" id="cfgScriptAlertNewMissed" checked>
                  <span>Sin ejecutar</span>
                </label>
                <div class="input-group input-group-sm">
                  <input type="number" class="form-control form-control-sm" id="cfgScriptAlertNewHours" value="25" min="1">
                  <span class="input-group-text">h máx</span>
                </div>
              </div>
            </div>

            <div class="col-12 col-md-6 col-xl-2">
              <div class="border rounded-2 p-2 h-100">
                <label class="d-flex align-items-center gap-2 small mb-2">
                  <input type="checkbox" class="form-check-input mt-0" id="cfgScriptAlertNewRunningLong">
                  <span>Ejecución larga</span>
                </label>
                <div class="input-group input-group-sm">
                  <input type="number" class="form-control form-control-sm" id="cfgScriptAlertNewRunHours" value="6" min="0.1" step="0.1">
                  <span class="input-group-text">h máx</span>
                </div>
              </div>
            </div>

            <div class="col-6 col-md-3 col-xl-1">
              <label class="form-label small-muted mb-1">Error</label>
              <div class="form-check">
                <input type="checkbox" class="form-check-input" id="cfgScriptAlertNewError" checked>
              </div>
            </div>

            <div class="col-6 col-md-4 col-xl-1">
              <label class="form-label small-muted mb-1">Cooldown</label>
              <input type="number" class="form-control form-control-sm" id="cfgScriptAlertNewCooldown" value="60" min="1">
            </div>

            <div class="col-12 col-md-5 col-xl-2">
              <button type="button" class="btn btn-success btn-sm w-100" id="cfgScriptAlertAddBtn">
                <i class="bi bi-plus-lg me-1"></i>Crear regla
              </button>
            </div>
          </div>
        </div>

        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead>
              <tr>
                <th>${esc(t('cfg.scripts.table.script', 'Script'))}</th>
                <th>Host</th>
                <th>Condiciones</th>
                <th>Cooldown</th>
                <th>${esc(t('cfg.scripts.table.actions', 'Actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="5" class="text-muted py-3">No hay reglas guardadas todavía. Usa <strong>Añadir regla</strong> para crear la primera.</td></tr>`}
            </tbody>
          </table>
        </div>
      `);
    } catch (e) {
      $wrap.html(`<div class="text-danger small">${esc(t('status.error', 'Error'))}: ${esc(e.message || 'Unknown error')}</div>`);
    }
  }

  $(document).on('click', '#cfgScriptAlertAddToggle', function () {
    $('#cfgScriptAlertAddBox').toggleClass('d-none');
  });

  $(document).on('click', '#cfgScriptAlertAddBtn', async function () {
    const $opt = $('#cfgScriptAlertNewScript option:selected');
    const name = $opt.data('script');
    const host = $opt.data('host') || 'Local';
    const t = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);

    if (!name) {
      window.showToast?.('Selecciona un script', 'warning');
      return;
    }

    const payload = {
      host_name: host,
      alert_missed: $('#cfgScriptAlertNewMissed').is(':checked'),
      max_hours: parseFloat($('#cfgScriptAlertNewHours').val() || 25),
      alert_error: $('#cfgScriptAlertNewError').is(':checked'),
      alert_running_long: $('#cfgScriptAlertNewRunningLong').is(':checked'),
      max_running_hours: parseFloat($('#cfgScriptAlertNewRunHours').val() || 6),
      cooldown_min: parseInt($('#cfgScriptAlertNewCooldown').val() || 60),
    };

    const res = await fetch(`/api/scripts/alert-rules/${encodeURIComponent(name)}?host=${encodeURIComponent(host)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;

    window.showToast?.(
      ok ? `${t('cfg.scripts.alerts.saved', '✓ Regla creada para')} ${host} / ${name}` : '✗ ' + (data.error || t('status.error', 'Error')),
      ok ? 'success' : 'danger'
    );

    if (ok) await loadScriptAlertRules();
  });

  $(document).on('click', '.cfg-script-alert-save', async function () {
    const $row = $(this).closest('[data-script]');
    const name = $row.data('script');
    const host = $row.data('host') || 'Local';
    const t = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);
    const payload = {
      alert_missed: $row.find('.cfg-sal-missed').is(':checked'),
      max_hours: parseFloat($row.find('.cfg-sal-hours').val() || 25),
      alert_error: $row.find('.cfg-sal-error').is(':checked'),
      alert_running_long: $row.find('.cfg-sal-running-long').is(':checked'),
      max_running_hours: parseFloat($row.find('.cfg-sal-running-hours').val() || 6),
      cooldown_min: parseInt($row.find('.cfg-sal-cooldown').val() || 60),
      host_name: host,
    };

    const res = await fetch(`/api/scripts/alert-rules/${encodeURIComponent(name)}?host=${encodeURIComponent(host)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;

    window.showToast?.(
      ok ? `${t('cfg.scripts.alerts.saved', '✓ Regla actualizada para')} ${host} / ${name}` : '✗ ' + (data.error || t('status.error', 'Error')),
      ok ? 'success' : 'danger'
    );

    if (ok) await loadScriptAlertRules();
  });

  $(document).on('click', '.cfg-script-alert-del', async function () {
    const $btn = $(this);
    const $row = $btn.closest('[data-script]');
    const name = $row.data('script');
    const host = $row.data('host') || 'Local';
    const t = (key, fallback) => (window.t ? window.t(key, fallback) : fallback);

    if (String($btn.data('armed') || '0') !== '1') {
      $btn.data('armed', '1');
      $btn.removeClass('btn-outline-danger').addClass('btn-danger');
      $btn.attr('title', t('cfg.scripts.alerts.confirm_delete', 'Click again to delete'));
      $btn.attr('aria-label', t('cfg.scripts.alerts.confirm_delete', 'Click again to delete'));

      const oldTimer = $btn.data('armTimer');
      if (oldTimer) clearTimeout(oldTimer);

      const timer = setTimeout(() => {
        $btn.data('armed', '0');
        $btn.removeClass('btn-danger').addClass('btn-outline-danger');
        $btn.attr('title', t('cfg.scripts.alerts.delete_rule', 'Delete rule'));
        $btn.attr('aria-label', t('cfg.scripts.alerts.delete_rule', 'Delete rule'));
      }, 2500);

      $btn.data('armTimer', timer);
      window.showToast?.(t('cfg.scripts.alerts.arm_delete', 'Click delete again to confirm'), 'warning');
      return;
    }

    const oldTimer = $btn.data('armTimer');
    if (oldTimer) clearTimeout(oldTimer);

    const res = await fetch(`/api/scripts/alert-rules/${encodeURIComponent(name)}?host=${encodeURIComponent(host)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;

    window.showToast?.(
      ok ? `${t('cfg.scripts.alerts.deleted', '✓ Rule deleted for')} ${host} / ${name}` : '✗ ' + (data.error || t('status.error', 'Error')),
      ok ? 'success' : 'danger'
    );

    if (ok) await loadScriptAlertRules();
  });

  // ══════════════════════════════════════════════════════════
  // ㉒ HISTORIAL INFORMES IA DE RED
  // ══════════════════════════════════════════════════════════

  async function loadAiReports() {
    if (typeof loadAiReportsModern === 'function') {
      return loadAiReportsModern();
    }
  }

  $(document).on('click', '#aiReportsRefreshBtn', () => loadAiReports());

  $(document).on('click', '.ai-report-open, .ai-report-row', async function (e) {
    if ($(e.target).closest('button').length && !$(e.target).closest('.ai-report-open').length) return;

    const id = $(this).data('id') || $(this).closest('[data-id]').data('id');
    const modalEl = document.getElementById('aiReportDetailModal');
    const bodyEl = document.getElementById('aiReportDetailBody');
    const metaEl = document.getElementById('aiReportDetailMeta');
    const configModalEl = document.getElementById('configModal');
    if (!id || !modalEl || !bodyEl) return;

    const detailModal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const configWasOpen = !!(configModalEl && configModalEl.classList.contains('show'));
    const configModal = configModalEl ? bootstrap.Modal.getOrCreateInstance(configModalEl) : null;

    if (configWasOpen && configModalEl && !modalEl.dataset.restoreConfigBound) {
      modalEl.dataset.restoreConfigBound = '1';
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (modalEl.dataset.restoreConfigOnClose === '1' && configModal) {
          modalEl.dataset.restoreConfigOnClose = '0';
          configModal.show();
        }
      });
    }

    if (metaEl) metaEl.textContent = '';
    bodyEl.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-info" role="status"></div></div>';

    if (configWasOpen && configModal) {
      modalEl.dataset.restoreConfigOnClose = '1';
      configModalEl.addEventListener('hidden.bs.modal', function onHidden() {
        configModalEl.removeEventListener('hidden.bs.modal', onHidden);
        detailModal.show();
      });
      configModal.hide();
    } else {
      detailModal.show();
    }

    try {
      const res = await fetch(`/api/scan/ai-reports/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const report = data.report || {};
      const generatedAt = String(report.generated_at || '').replace('T', ' ').slice(0, 16);
      const provider = String(report.source || '—').trim();
      const discrepancies = report.discrepancy_count ?? '—';

      if (metaEl) {
        metaEl.textContent = [generatedAt, `Proveedor: ${provider}`, `Discrepancias: ${discrepancies}`]
          .filter(Boolean)
          .join(' · ');
      }

      const raw = String(report.report_text || '(Sin informe)')
        .replace(/^```(?:markdown)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      let html = '';
      if (window.marked && typeof window.marked.parse === 'function') {
        html = window.marked.parse(raw);
      } else {
        html = raw
          .replace(/^## (.+)$/gm, '<h6 class="fw-bold mt-3">$1</h6>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
      }

      bodyEl.innerHTML = `<div class="small lh-lg">${html}</div>`;
    } catch (e) {
      bodyEl.innerHTML = `<div class="text-danger">Error: ${esc(e.message || 'Error cargando informe')}</div>`;
    }
  });


  // ══════════════════════════════════════════════════════════
  // ㉓ EXPORTACIÓN HISTÓRICA (xlsx por rango de fechas)
  // ══════════════════════════════════════════════════════════

  $(document).on('click', '.cfg-nav-btn[data-section="exports"]', function () {
    loadExportConfig();
  });

  $(document).on('click', '#histExportBtn', async function () {
    const from = document.getElementById('histExportFrom')?.value;
    const to   = document.getElementById('histExportTo')?.value;
    const $btn = $(this);
    const $msg = $('#histExportMsg');

    if (!from || !to) {
      $msg.removeClass('text-success text-danger').addClass('text-warning').text('Selecciona rango de fechas');
      return;
    }

    const url = `/api/export/history?date_from=${from}&date_to=${to}`;

    $btn.prop('disabled', true);
    $msg.removeClass('text-success text-danger text-warning').addClass('text-muted').text('Generando Excel…');

    try {
      const r = await fetch(url);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(txt || `HTTP ${r.status}`);
      }

      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/i);
      const filename = (m && m[1]) ? m[1] : `auditoria_${from}_${to}.xlsx`;

      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);

      $msg.removeClass('text-muted text-danger text-warning').addClass('text-success').text(`Descarga iniciada: ${filename}`);
    } catch (e) {
      $msg.removeClass('text-muted text-success text-warning').addClass('text-danger').text(`Error: ${e.message || 'No se pudo descargar el Excel'}`);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  // ── Emoji picker global helper ──────────────────────────────────────────────
  function _renderEmojiPicker(wrap) {
    // Minimal emoji set for type icons
    const EMOJIS = ['🖥️','💻','📱','🖨️','🔌','📡','🛜','📶','🌐','🔒','🛡️','🔑','⚙️','🔧','🔨',
                    '📷','🎬','🎵','⬇️','🖱️','⌨️','🖲️','💾','💿','📀','📼','📺','📻','☎️','🖥',
                    '🏠','🏢','🌩️','☁️','🔋','💡','🔭','🧭','🗺️','📍','🏷️','🚀','⭐','❓','🤖'];
    const popup = wrap.find('.emoji-grid-popup');
    popup.html('<div class="emoji-grid">' +
      EMOJIS.map(e => `<button type="button" class="emoji-pick" data-emoji="${e}">${e}</button>`).join('') +
      '<button type="button" class="emoji-pick emoji-clear" data-emoji="">✕ quitar</button>' +
      '</div>');
    popup.on('click', '.emoji-pick', function (e) {
      e.stopPropagation();
      const val = $(this).data('emoji');
      wrap.find('.type-icon-val').html(val || '❓').data('icon', val);
      wrap.find('.type-icon-hidden').val(val);
      popup.removeClass('open');
    });
  }

  $(document).on('click', function (e) {
    if (!$(e.target).closest('.emoji-picker-wrap').length) $('.emoji-grid-popup').removeClass('open');
  });


  // ══════════════════════════════════════════════════════════
  // ㉔ DOCUMENTACIÓN — README, Roadmap, Config Redes
  // ══════════════════════════════════════════════════════════

  const _docsCache = {};     // { readme: '...', roadmap: '...', redes: '...' }
  let   _docsLoaded = false;

  async function loadDocsPanel() {
    if (_docsLoaded) return;
    _docsLoaded = true;
    // Cargar README inmediatamente (primer tab activo)
    await _loadDocTab('readme', '#doc-readme-body');
    // Los demás se cargan al hacer click en su tab (lazy)
    $('#doc-roadmap-tab').one('shown.bs.tab', () => _loadDocTab('roadmap', '#doc-roadmap-body'));
    $('#doc-redes-tab').one('shown.bs.tab',   () => _loadDocTab('redes',   '#doc-redes-body'));
  }

  async function _loadDocTab(name, targetSelector) {
    const $el = $(targetSelector);
    if (!$el.length) return;

    // 'redes' no tiene fichero .md — lo clonamos directamente del panel Redes en el DOM
    if (name === 'redes') {
      const $source = $('[data-panel="networks"] .cfg-section').last();
      if ($source.length) {
        $el.html('<div class="small">' + $source.html() + '</div>');
      } else {
        $el.html('<div class="text-muted small">Navega a Config → Redes para ver esta guía.</div>');
      }
      return;
    }

    if (_docsCache[name]) { _renderDoc($el, _docsCache[name]); return; }
    $el.html('<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-info"></div></div>');
    try {
      const data = await fetch(`/api/docs/${name}`).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'No encontrado');
      _docsCache[name] = data.content;
      _renderDoc($el, data.content);
    } catch (e) {
      $el.html(`<div class="alert alert-warning small">
        No se pudo cargar el documento <strong>${esc(name)}</strong>.<br>
        <span class="text-muted">${esc(e.message)}</span><br><br>
        Asegúrate de que los documentos canónicos están en <code>DOC_ONLINE/</code>
        en la raíz del proyecto, por ejemplo <code>README.md</code> y <code>ROADMAP_Auditor_IPs.txt</code>.
      </div>`);
    }
  }

  function _renderDoc($el, markdown) {
    // Renderizado Markdown mínimo — encabezados, negrita, código, tablas, listas
    let html = markdown
      // Escapar HTML básico primero
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Headings
      .replace(/^#{4}\s+(.+)$/gm, '<h6 class="mt-3 mb-1 fw-semibold" style="font-size:.87rem">$1</h6>')
      .replace(/^#{3}\s+(.+)$/gm, '<h5 class="mt-3 mb-1" style="font-size:.93rem">$1</h5>')
      .replace(/^#{2}\s+(.+)$/gm, '<h4 class="mt-4 mb-2" style="font-size:1rem;color:var(--accent)">$1</h4>')
      .replace(/^#{1}\s+(.+)$/gm, '<h3 class="mt-4 mb-2" style="font-size:1.1rem;color:var(--accent)">$1</h3>')
      // Horizontal rule
      .replace(/^-{3,}$/gm, '<hr style="border-color:rgba(255,255,255,.12)">')
      // Bold + italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`\n]+)`/g, '<code style="font-size:.8rem;background:rgba(77,255,181,.1);padding:1px 4px;border-radius:3px">$1</code>')
      // Code blocks
      .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre style="background:rgba(0,0,0,.3);border-radius:6px;padding:10px;font-size:.78rem;overflow-x:auto;white-space:pre"><code>$1</code></pre>')
      // Unordered list items
      .replace(/^[\*\-]\s+(.+)$/gm, '<li style="margin:.2rem 0">$1</li>')
      .replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="padding-left:1.4rem;margin:.4rem 0">$&</ul>')
      // Ordered list items
      .replace(/^\d+\.\s+(.+)$/gm, '<li style="margin:.2rem 0">$1</li>')
      // Tables — minimal rendering
      .replace(/^\|(.+)\|$/gm, (line) => {
        const cells = line.split('|').filter((_,i,a) => i > 0 && i < a.length-1);
        return '<tr>' + cells.map(c => `<td style="padding:3px 8px;border:1px solid rgba(255,255,255,.1)">${c.trim()}</td>`).join('') + '</tr>';
      })
      .replace(/(<tr>.*<\/tr>\n?)+/g, m => `<table class="table table-sm" style="font-size:.8rem;margin:.5rem 0">${m}</table>`)
      // Paragraphs — wrap orphan lines
      .replace(/^([^<\n].+)$/gm, '<p class="mb-1" style="font-size:.84rem">$1</p>');

    $el.html(`<div style="line-height:1.75">${html}</div>`);
  }

  // Reset docs on modal close — ya manejado en el listener principal (hidden.bs.modal arriba)



// Compatibilidad HTML actual — wiring mínimo sin refactor
(function () {
  function _cfgGet(id) { return document.getElementById(id); }
  function _cfgBool(v) { return v === true || v === 1 || v === '1'; }
  function _cfgStatus(id, msg, ok) {
    const el = _cfgGet(id); if (!el) return;
    el.style.display = 'inline-flex';
    el.textContent = msg;
    el.classList.remove('ok','err');
    el.classList.add(ok ? 'ok' : 'err');
  }

  function _cfgSetSelectValue(id, value) {
    const el = _cfgGet(id);
    if (!el) return;
    const v = String(value ?? '');
    if (!Array.from(el.options).some(opt => opt.value === v)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      el.appendChild(opt);
    }
    el.value = v;
  }

  function _cfgSyncPrimaryCidr(cidr) {
    const value = String(cidr || '').trim();
    if (_cfgGet('cfgCidr')) _cfgGet('cfgCidr').value = value;
    if (_cfgGet('cidrInput')) _cfgGet('cidrInput').value = value;
    if (typeof _renderCidrChips === 'function') {
      _renderCidrChips(value.split(',').map(x => x.trim()).filter(Boolean));
    }
  }

  function _cfgReadPrimaryCidr() {
    const modern = (_cfgGet('cfgCidr')?.value || '').trim();
    const chips = (typeof _getCidrValue === 'function' ? (_getCidrValue() || '').trim() : '');
    const legacy = (_cfgGet('cidrInput')?.value || '').trim();
    return modern || chips || legacy;
  }

  function _cfgSyncScanInterval(raw) {
    const value = parseInt(raw || 900, 10) || 900;
    if (_cfgGet('cfgInterval')) _cfgGet('cfgInterval').value = value;
    if (_cfgGet('cfgIntervalHuman')) _cfgGet('cfgIntervalHuman').textContent = _humanizeSecs(value);
    if (_cfgGet('intervalInput')) _cfgGet('intervalInput').value = value;
    _cfgSetSelectValue('intervalSelect', value);
  }

  function _cfgReadScanInterval() {
    return parseInt(
      _cfgGet('cfgInterval')?.value ||
      _cfgGet('intervalSelect')?.value ||
      _cfgGet('intervalInput')?.value ||
      900,
      10
    ) || 900;
  }

  function _cfgSyncScanOnBoot(v) {
    if (_cfgGet('bootScan')) _cfgGet('bootScan').checked = _cfgBool(v);
  }

  function _cfgSyncPrimaryIface(v) {
    const value = String(v || '');
    if (_cfgGet('cfgPrimaryNetIface')) _cfgGet('cfgPrimaryNetIface').value = value;
    if (_cfgGet('cfgPrimaryIface')) _cfgGet('cfgPrimaryIface').value = value;
  }

  function _cfgReadPrimaryIface() {
    return (_cfgGet('cfgPrimaryNetIface')?.value || _cfgGet('cfgPrimaryIface')?.value || '').trim();
  }

  window._cfgReadPrimaryCidr = _cfgReadPrimaryCidr;
  window._cfgReadScanInterval = _cfgReadScanInterval;
  window._cfgReadPrimaryIface = _cfgReadPrimaryIface;

  $(document).off('input.cfgIntervalSync change.cfgIntervalSync', '#cfgInterval').on('input.cfgIntervalSync change.cfgIntervalSync', '#cfgInterval', function () {
    const value = parseInt(this.value || 900, 10) || 900;
    if (_cfgGet('cfgIntervalHuman')) _cfgGet('cfgIntervalHuman').textContent = _humanizeSecs(value);
    if (_cfgGet('intervalInput')) _cfgGet('intervalInput').value = value;
    _cfgSetSelectValue('intervalSelect', value);
  });


  const CFG_MODULE_DEFAULTS = {
    services: true,
    automation: true,
    agents: true,
    syncthing: true,
    quality: true,
    notifications: true,
    ai: true,
    exports: true,
  };

  function _cfgParseEnabledModules(raw) {
    const values = Object.assign({}, CFG_MODULE_DEFAULTS);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      Object.keys(raw).forEach(k => {
        if (Object.prototype.hasOwnProperty.call(values, k)) values[k] = !!raw[k];
      });
      return values;
    }

    const txt = String(raw || '').trim();
    if (!txt) return values;

    try {
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(k => {
          if (Object.prototype.hasOwnProperty.call(values, k)) values[k] = !!parsed[k];
        });
        return values;
      }
      if (Array.isArray(parsed)) {
        const enabled = new Set(parsed.map(x => String(x || '').trim()).filter(Boolean));
        Object.keys(values).forEach(k => { values[k] = enabled.has(k); });
        return values;
      }
    } catch (_) {}

    return values;
  }

  function _cfgReadEnabledModulesFromUi() {
    const values = Object.assign({}, CFG_MODULE_DEFAULTS);
    document.querySelectorAll('.cfg-module-toggle[data-module]').forEach(el => {
      const key = String(el.dataset.module || '').trim();
      if (key) values[key] = !!el.checked;
    });
    return values;
  }

  function _cfgApplyModuleTogglesToUi(modules = {}) {
    document.querySelectorAll('.cfg-module-toggle[data-module]').forEach(el => {
      const key = String(el.dataset.module || '').trim();
      if (!key) return;
      el.checked = Object.prototype.hasOwnProperty.call(modules, key) ? !!modules[key] : true;
    });
    _cfgSyncLinkedTabsFromModules(modules);
  }

  function _cfgSyncLinkedTabsFromModules(modules = _cfgReadEnabledModulesFromUi()) {
    document.querySelectorAll('.cfg-module-toggle[data-linked-tab]').forEach(el => {
      const tab = String(el.dataset.linkedTab || '').trim();
      const mod = String(el.dataset.module || '').trim();
      const tabEl = tab ? document.querySelector(`.cfg-tab-toggle[data-tab="${tab}"]`) : null;
      if (!tabEl || !mod) return;
      const enabled = Object.prototype.hasOwnProperty.call(modules, mod) ? !!modules[mod] : true;
      tabEl.disabled = !enabled;
      tabEl.closest('label')?.classList.toggle('opacity-50', !enabled);
      if (!enabled) tabEl.checked = false;
    });
    if (typeof _cfgInterfaceSyncAllGroupStates === 'function') _cfgInterfaceSyncAllGroupStates();
  }


  function _cfgToggleAiFields(provider) {
    const gemini = _cfgGet('cfgAiGeminiFields');
    const mistral = _cfgGet('cfgAiMistralFields');
    if (gemini) gemini.style.display = provider === 'gemini' ? '' : 'none';
    if (mistral) mistral.style.display = provider === 'mistral' ? '' : 'none';
  }

  function _cfgRefreshSecretFieldState(inputId, providerLabel) {
    const el = _cfgGet(inputId);
    if (!el) return;
    if (!el.dataset.defaultPlaceholder) {
      el.dataset.defaultPlaceholder = el.getAttribute('placeholder') || '';
    }
    const configured = el.dataset.storedConfigured === '1';
    const hasTypedValue = !!String(el.value || '').trim();
    const showStoredHint = configured && !hasTypedValue;

    el.placeholder = showStoredHint ? '•••••••• guardada' : (el.dataset.defaultPlaceholder || '');
    el.title = showStoredHint ? `API key de ${providerLabel} guardada. Déjala vacía para conservarla.` : '';
    el.classList.toggle('border-success-subtle', showStoredHint);
    el.classList.toggle('bg-success-subtle', showStoredHint);
  }

  function _cfgApplyAiSecretHints(s = {}) {
    const gemini = _cfgGet('cfgAiGeminiKey');
    const mistral = _cfgGet('cfgAiMistralKey');
    if (gemini) {
      gemini.dataset.storedConfigured = _cfgBool(s.ai_gemini_key_configured) ? '1' : '0';
      _cfgRefreshSecretFieldState('cfgAiGeminiKey', 'Gemini');
    }
    if (mistral) {
      mistral.dataset.storedConfigured = _cfgBool(s.ai_mistral_key_configured) ? '1' : '0';
      _cfgRefreshSecretFieldState('cfgAiMistralKey', 'Mistral');
    }
  }

  function _cfgClampFrontendRefreshSeconds(value, fallback, min) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(3600, safe));
  }

  function _cfgRenderFrontendRefreshHuman() {
    const normal = _cfgClampFrontendRefreshSeconds(_cfgGet('cfgFrontendRefreshSeconds')?.value, 30, 5);
    const dash = _cfgClampFrontendRefreshSeconds(_cfgGet('cfgFrontendDashboardRefreshSeconds')?.value, 60, 10);
    if (_cfgGet('cfgFrontendRefreshHuman')) _cfgGet('cfgFrontendRefreshHuman').textContent = _humanizeSecs(normal);
    if (_cfgGet('cfgFrontendDashboardRefreshHuman')) _cfgGet('cfgFrontendDashboardRefreshHuman').textContent = _humanizeSecs(dash);
  }

  function _cfgPopulateFrontendRefreshSettings(s = {}) {
    const normal = _cfgClampFrontendRefreshSeconds(s.frontend_refresh_interval_seconds ?? 30, 30, 5);
    const dash = _cfgClampFrontendRefreshSeconds(s.frontend_dashboard_refresh_interval_seconds ?? 60, 60, 10);
    if (_cfgGet('cfgFrontendRefreshSeconds')) _cfgGet('cfgFrontendRefreshSeconds').value = normal;
    if (_cfgGet('cfgFrontendDashboardRefreshSeconds')) _cfgGet('cfgFrontendDashboardRefreshSeconds').value = dash;
    _cfgRenderFrontendRefreshHuman();
  }

  function _cfgApplyFrontendRefreshRuntime(settings = {}) {
    if (typeof window.applyFrontendRefreshSettings === 'function') {
      window.applyFrontendRefreshSettings({
        frontend_refresh_interval_seconds: settings.frontend_refresh_interval_seconds ?? _cfgGet('cfgFrontendRefreshSeconds')?.value ?? 30,
        frontend_dashboard_refresh_interval_seconds: settings.frontend_dashboard_refresh_interval_seconds ?? _cfgGet('cfgFrontendDashboardRefreshSeconds')?.value ?? 60
      });
    }
  }

  function _cfgClampFrontendLimit(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  function _cfgRenderFrontendLimitsHuman() {
    const defs = [
      ['cfgFrontendHistoryLimit', 'cfgFrontendHistoryLimitHuman', 5000, 100, 50000],
      ['cfgFrontendDetailHistoryLimit', 'cfgFrontendDetailHistoryLimitHuman', 20000, 500, 100000],
      ['cfgFrontendTableRowsLimit', 'cfgFrontendTableRowsLimitHuman', 2000, 100, 20000],
      ['cfgFrontendExportRowsLimit', 'cfgFrontendExportRowsLimitHuman', 5000, 100, 50000],
    ];
    defs.forEach(([inputId, humanId, fallback, min, max]) => {
      const value = _cfgClampFrontendLimit(_cfgGet(inputId)?.value, fallback, min, max);
      const formatted = (typeof window.fmtNumber === 'function') ? window.fmtNumber(value) : String(value);
      if (_cfgGet(humanId)) _cfgGet(humanId).textContent = `${formatted} registros`;
    });
  }

  function _cfgPopulateFrontendDataLimitSettings(s = {}) {
    const history = _cfgClampFrontendLimit(s.frontend_history_limit ?? 5000, 5000, 100, 50000);
    const detail = _cfgClampFrontendLimit(s.frontend_detail_history_limit ?? 20000, 20000, 500, 100000);
    const table = _cfgClampFrontendLimit(s.frontend_table_rows_limit ?? 2000, 2000, 100, 20000);
    const exportRows = _cfgClampFrontendLimit(s.frontend_export_rows_limit ?? 5000, 5000, 100, 50000);
    if (_cfgGet('cfgFrontendHistoryLimit')) _cfgGet('cfgFrontendHistoryLimit').value = history;
    if (_cfgGet('cfgFrontendDetailHistoryLimit')) _cfgGet('cfgFrontendDetailHistoryLimit').value = detail;
    if (_cfgGet('cfgFrontendTableRowsLimit')) _cfgGet('cfgFrontendTableRowsLimit').value = table;
    if (_cfgGet('cfgFrontendExportRowsLimit')) _cfgGet('cfgFrontendExportRowsLimit').value = exportRows;
    _cfgRenderFrontendLimitsHuman();
  }

  function _cfgApplyFrontendDataLimitRuntime(settings = {}) {
    if (typeof window.applyFrontendDataLimitSettings === 'function') {
      window.applyFrontendDataLimitSettings({
        frontend_history_limit: settings.frontend_history_limit ?? _cfgGet('cfgFrontendHistoryLimit')?.value ?? 5000,
        frontend_detail_history_limit: settings.frontend_detail_history_limit ?? _cfgGet('cfgFrontendDetailHistoryLimit')?.value ?? 20000,
        frontend_table_rows_limit: settings.frontend_table_rows_limit ?? _cfgGet('cfgFrontendTableRowsLimit')?.value ?? 2000,
        frontend_export_rows_limit: settings.frontend_export_rows_limit ?? _cfgGet('cfgFrontendExportRowsLimit')?.value ?? 5000
      });
    }
  }

  function _cfgClampOperationalTimeout(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, safe));
  }

  function _cfgRenderOperationalTimeoutsHuman() {
    const defs = [
      ['cfgServiceCheckTimeoutSeconds', 'cfgServiceCheckTimeoutHuman', 8, 1, 60],
      ['cfgServiceInfoTimeoutSeconds', 'cfgServiceInfoTimeoutHuman', 6, 1, 60],
      ['cfgScriptAiCloudTimeoutSeconds', 'cfgScriptAiCloudTimeoutHuman', 30, 5, 300],
      ['cfgScriptAiLocalTimeoutSeconds', 'cfgScriptAiLocalTimeoutHuman', 180, 30, 900],
      ['cfgScriptAiFrontendTimeoutSeconds', 'cfgScriptAiFrontendTimeoutHuman', 135, 30, 600],
      ['cfgScriptReportTimeoutSeconds', 'cfgScriptReportTimeoutHuman', 120, 30, 600],
      ['cfgWolTrackerTimeoutSeconds', 'cfgWolTrackerTimeoutHuman', 120, 10, 900],
    ];
    defs.forEach(([inputId, humanId, fallback, min, max]) => {
      const value = _cfgClampOperationalTimeout(_cfgGet(inputId)?.value, fallback, min, max);
      if (_cfgGet(humanId)) _cfgGet(humanId).textContent = _humanizeSecs(value);
    });
  }

  function _cfgPopulateOperationalTimeoutSettings(s = {}) {
    const defs = [
      ['cfgServiceCheckTimeoutSeconds', 'service_check_timeout_seconds', 8, 1, 60],
      ['cfgServiceInfoTimeoutSeconds', 'service_info_timeout_seconds', 6, 1, 60],
      ['cfgScriptAiCloudTimeoutSeconds', 'script_ai_cloud_timeout_seconds', 30, 5, 300],
      ['cfgScriptAiLocalTimeoutSeconds', 'script_ai_local_timeout_seconds', 180, 30, 900],
      ['cfgScriptAiFrontendTimeoutSeconds', 'script_ai_frontend_timeout_seconds', 135, 30, 600],
      ['cfgScriptReportTimeoutSeconds', 'script_report_timeout_seconds', 120, 30, 600],
      ['cfgWolTrackerTimeoutSeconds', 'wol_tracker_timeout_seconds', 120, 10, 900],
    ];
    defs.forEach(([inputId, key, fallback, min, max]) => {
      const value = _cfgClampOperationalTimeout(s[key] ?? fallback, fallback, min, max);
      if (_cfgGet(inputId)) _cfgGet(inputId).value = value;
    });
    _cfgRenderOperationalTimeoutsHuman();
  }

  function _cfgApplyOperationalTimeoutRuntime(settings = {}) {
    if (typeof window.applyOperationalTimeoutSettings === 'function') {
      window.applyOperationalTimeoutSettings({
        service_check_timeout_seconds: settings.service_check_timeout_seconds ?? _cfgGet('cfgServiceCheckTimeoutSeconds')?.value ?? 8,
        service_info_timeout_seconds: settings.service_info_timeout_seconds ?? _cfgGet('cfgServiceInfoTimeoutSeconds')?.value ?? 6,
        script_ai_cloud_timeout_seconds: settings.script_ai_cloud_timeout_seconds ?? _cfgGet('cfgScriptAiCloudTimeoutSeconds')?.value ?? 30,
        script_ai_local_timeout_seconds: settings.script_ai_local_timeout_seconds ?? _cfgGet('cfgScriptAiLocalTimeoutSeconds')?.value ?? 180,
        script_ai_frontend_timeout_seconds: settings.script_ai_frontend_timeout_seconds ?? _cfgGet('cfgScriptAiFrontendTimeoutSeconds')?.value ?? 135,
        script_report_timeout_seconds: settings.script_report_timeout_seconds ?? _cfgGet('cfgScriptReportTimeoutSeconds')?.value ?? 120,
        wol_tracker_timeout_seconds: settings.wol_tracker_timeout_seconds ?? _cfgGet('cfgWolTrackerTimeoutSeconds')?.value ?? 120
      });
    }
  }

  async function cfgPopulateModern(s) {
    _cfgSyncPrimaryCidr(s.scan_cidr || '');
    _cfgSyncScanInterval(s.scan_interval || 900);
    _cfgSyncScanOnBoot(s.scan_on_boot);
    _cfgPopulateFrontendRefreshSettings(s);
    _cfgApplyFrontendRefreshRuntime(s);
    _cfgPopulateFrontendDataLimitSettings(s);
    _cfgApplyFrontendDataLimitRuntime(s);
    _cfgPopulateOperationalTimeoutSettings(s);
    _cfgApplyOperationalTimeoutRuntime(s);
    const enabledModules = _cfgParseEnabledModules(s.enabled_modules);
    _cfgApplyModuleTogglesToUi(enabledModules);
    if (typeof window.applyModuleGating === 'function') window.applyModuleGating(enabledModules);
    if (_cfgGet('cfgDns')) _cfgGet('cfgDns').value = s.dns_server || '';
    if (_cfgGet('cfgRetention')) _cfgGet('cfgRetention').value = s.retention_days || 14;
    if (_cfgGet('cfgWolPort')) _cfgGet('cfgWolPort').value = s.wol_port || 9;
    if (_cfgGet('cfgWolBroadcast')) _cfgGet('cfgWolBroadcast').value = s.wol_broadcast || '';
    if (_cfgGet('scanPrimaryRouter')) _cfgGet('scanPrimaryRouter').checked = (s.scan_primary_source || 'router') !== 'nmap';
    if (_cfgGet('scanPrimaryNmap')) _cfgGet('scanPrimaryNmap').checked = (s.scan_primary_source || 'router') === 'nmap';
    if (_cfgGet('cfgSecondarySource')) _cfgGet('cfgSecondarySource').value = s.scan_secondary_source || 'none';
    if (_cfgGet('cfgSecondaryInterval')) _cfgGet('cfgSecondaryInterval').value = s.scan_secondary_interval_hours || s.scan_secondary_interval || '2';
    if (_cfgGet('cfgSecondaryAiEnabled')) _cfgGet('cfgSecondaryAiEnabled').checked = _cfgBool(s.scan_secondary_ai_enabled || s.ai_post_scan);
    if (_cfgGet('cfgSecondaryIntervalWrap')) _cfgGet('cfgSecondaryIntervalWrap').style.display = (_cfgGet('cfgSecondarySource')?.value || 'none') === 'none' ? 'none' : '';

    if (_cfgGet('cfgSyncthingRefreshSeconds')) _cfgGet('cfgSyncthingRefreshSeconds').value = s.syncthing_refresh_interval_seconds || 60;
    if (_cfgGet('cfgSyncthingSnapshotDays')) _cfgGet('cfgSyncthingSnapshotDays').value = s.syncthing_snapshot_retention_days || 14;
    if (_cfgGet('cfgSyncthingStalledMinutes')) _cfgGet('cfgSyncthingStalledMinutes').value = s.syncthing_stalled_threshold_minutes || 60;
    if (_cfgGet('cfgSyncthingStalledAlertCooldown')) _cfgGet('cfgSyncthingStalledAlertCooldown').value = s.syncthing_stalled_alert_cooldown_minutes || 120;
    if (_cfgGet('cfgSyncthingAlertPersistenceMinutes')) _cfgGet('cfgSyncthingAlertPersistenceMinutes').value = s.syncthing_alert_persistence_minutes ?? 20;
    if (_cfgGet('cfgSyncthingTransferThresholdBps')) _cfgGet('cfgSyncthingTransferThresholdBps').value = s.syncthing_transfer_active_threshold_bps || 1024;
    if (_cfgGet('cfgSyncthingTransferMinDeltaBytes')) _cfgGet('cfgSyncthingTransferMinDeltaBytes').value = s.syncthing_transfer_active_min_delta_bytes || 1048576;
    if (_cfgGet('cfgSyncthingStoreFileNames')) _cfgGet('cfgSyncthingStoreFileNames').checked = _cfgBool(s.syncthing_store_file_names);
    if (_cfgGet('cfgSyncthingFileEventDays')) _cfgGet('cfgSyncthingFileEventDays').value = s.syncthing_file_event_retention_days || 5;
    if (_cfgGet('cfgSyncthingFileNameDays')) _cfgGet('cfgSyncthingFileNameDays').value = s.syncthing_file_name_retention_days || 7;
    function _cfgLoadSecretInput(id, configured, configuredText, emptyText, titleText) {
      const el = _cfgGet(id);
      if (!el) return;
      el.value = '';
      el.placeholder = configured ? configuredText : emptyText;
      el.title = configured ? titleText : '';
    }

    const discordInfoConfigured = _cfgBool(s.discord_webhook_info_configured);
    const discordAlertsConfigured = _cfgBool(s.discord_webhook_alerts_configured);
    const discordLegacyConfigured = _cfgBool(s.discord_webhook_configured);

    _cfgLoadSecretInput(
      'cfgDiscordInfo',
      discordInfoConfigured,
      'Webhook informativo guardado (oculto). Escribe uno nuevo solo si quieres reemplazarlo.',
      'https://discord.com/api/webhooks/...',
      'Ya hay un webhook informativo guardado. El valor real se oculta por seguridad.'
    );

    _cfgLoadSecretInput(
      'cfgDiscordAlerts',
      discordAlertsConfigured || discordLegacyConfigured,
      discordAlertsConfigured
        ? 'Webhook de alertas guardado (oculto). Escribe uno nuevo solo si quieres reemplazarlo.'
        : 'Webhook legacy guardado: se usará para alertas. Escribe uno nuevo si quieres separarlo.',
      'https://discord.com/api/webhooks/...',
      discordAlertsConfigured
        ? 'Ya hay un webhook de alertas guardado. El valor real se oculta por seguridad.'
        : (discordLegacyConfigured ? 'Existe un webhook legacy que se conserva como fallback de alertas.' : '')
    );

    if (_cfgGet('cfgDiscordInfoFallback')) {
      _cfgGet('cfgDiscordInfoFallback').checked = _cfgBool(s.discord_info_fallback_to_alerts);
    }

    const notifyMap = {
      cfgNotifyNew:'notify_new',
      cfgNotifyOnline:'notify_online',
      cfgNotifyOffline:'notify_offline',
      cfgNotifyMac:'notify_mac_change',
      cfgNotifySvcDown:'notify_service_down',
      cfgNotifySyncthingStalled:'notify_syncthing_stalled',
      cfgNotifyQualityDegraded:'notify_quality_degraded',
      cfgNotifyScriptAlerts:'notify_script_alerts',
      cfgNotifyEmail:'notify_email',
      cfgEmailNew:'email_new',
      cfgEmailOnline:'email_online',
      cfgEmailOffline:'email_offline',
      cfgEmailMac:'email_mac_change',
      cfgEmailSvcDown:'email_service_down',
      cfgEmailSyncthingStalled:'email_syncthing_stalled',
      cfgEmailQualityDegraded:'email_quality_degraded',
      cfgEmailScriptAlerts:'email_script_alerts'
    };
    Object.entries(notifyMap).forEach(([id, key]) => { const el = _cfgGet(id); if (el) el.checked = _cfgBool(s[key]); });

    if (_cfgGet('cfgAutomationWatchdogEnabled')) {
      _cfgGet('cfgAutomationWatchdogEnabled').checked = _cfgBool(s.automation_watchdog_enabled);
    }
    if (_cfgGet('cfgAutomationWatchdogEnforceState')) {
      _cfgGet('cfgAutomationWatchdogEnforceState').checked = _cfgBool(s.automation_watchdog_enforce_state);
    }
    if (_cfgGet('cfgAutomationWatchdogMissedGrace')) {
      _cfgGet('cfgAutomationWatchdogMissedGrace').value = s.automation_watchdog_missed_grace_minutes || 30;
    }
    if (_cfgGet('cfgAutomationWatchdogStalledMinutes')) {
      _cfgGet('cfgAutomationWatchdogStalledMinutes').value = s.automation_watchdog_stalled_minutes || 60;
    }

    if (_cfgGet('cfgSmtpEnabled')) _cfgGet('cfgSmtpEnabled').checked = _cfgBool(s.smtp_enabled);
    if (_cfgGet('cfgSmtpHost')) _cfgGet('cfgSmtpHost').value = s.smtp_host || '';
    if (_cfgGet('cfgSmtpPort')) _cfgGet('cfgSmtpPort').value = s.smtp_port || 587;
    if (_cfgGet('cfgSmtpTls')) _cfgGet('cfgSmtpTls').value = s.smtp_tls || 'starttls';
    if (_cfgGet('cfgSmtpUser')) _cfgGet('cfgSmtpUser').value = s.smtp_user || '';

    const _cfgSmtpPassEl = _cfgGet('cfgSmtpPass');
    if (_cfgSmtpPassEl) {
      const smtpPassConfigured = _cfgBool(s.smtp_pass_configured);
      _cfgSmtpPassEl.value = '';
      _cfgSmtpPassEl.placeholder = smtpPassConfigured
        ? 'Contraseña guardada (oculta). Escribe una nueva solo si quieres reemplazarla.'
        : 'contraseña o app password';
      _cfgSmtpPassEl.title = smtpPassConfigured
        ? 'Ya hay una contraseña SMTP guardada. El valor real se oculta por seguridad.'
        : '';
    }

    if (_cfgGet('cfgSmtpFrom')) _cfgGet('cfgSmtpFrom').value = s.smtp_from || '';
    if (_cfgGet('cfgSmtpTo')) _cfgGet('cfgSmtpTo').value = s.smtp_to || '';
    if (_cfgGet('cfgRouterHost')) _cfgGet('cfgRouterHost').value = s.router_ssh_host || '';
    if (_cfgGet('cfgRouterPort')) _cfgGet('cfgRouterPort').value = s.router_ssh_port || 22;
    if (_cfgGet('cfgRouterUser')) _cfgGet('cfgRouterUser').value = s.router_ssh_user || '';
    if (_cfgGet('cfgRouterKey')) _cfgGet('cfgRouterKey').value = s.router_ssh_key || '';
    if (_cfgGet('cfgRouterEnabled')) _cfgGet('cfgRouterEnabled').checked = _cfgBool(s.router_enabled);
    if (_cfgGet('cfgAiProvider')) _cfgGet('cfgAiProvider').value = s.ai_provider || 'gemini';
    if (_cfgGet('cfgAiGeminiKey')) _cfgGet('cfgAiGeminiKey').value = s.ai_gemini_key || '';
    if (_cfgGet('cfgAiGeminiModel')) _cfgGet('cfgAiGeminiModel').value = s.ai_gemini_model || 'gemini-2.0-flash';
    if (_cfgGet('cfgAiMistralKey')) _cfgGet('cfgAiMistralKey').value = s.ai_mistral_key || '';
    if (_cfgGet('cfgAiMistralModel')) _cfgGet('cfgAiMistralModel').value = s.ai_mistral_model || 'mistral-small-latest';
    if (_cfgGet('cfgAiOllamaUrl')) _cfgGet('cfgAiOllamaUrl').value = s.ai_ollama_url || 'http://localhost:11434';
    if (_cfgGet('cfgAiOllamaModel')) _cfgGet('cfgAiOllamaModel').value = s.ai_ollama_model || 'gemma2:2b';
    _cfgToggleAiFields(_cfgGet('cfgAiProvider')?.value || 'gemini');
    _cfgApplyAiSecretHints(s);
    if (_cfgGet('cfgPrimaryNetLabel')) _cfgGet('cfgPrimaryNetLabel').value = s.primary_net_label || '';
    _cfgSyncPrimaryIface(s.primary_net_interface || '');

    if (_cfgGet('cfgTitle')) _cfgGet('cfgTitle').value = s.page_title || 'Auditor IPs';
    if (_cfgGet('cfgTz')) _cfgGet('cfgTz').value = s.app_tz || _cfgDefaultTimeZone();
    if (_cfgGet('cfgLangSelect')) _cfgGet('cfgLangSelect').value = s.ui_lang || 'es';
    _updateLangBtns(s.ui_lang || localStorage.getItem('auditor_lang') || document.documentElement.lang || 'es');
    if (typeof window._i18nApplyFromSettings === 'function') {
      window._i18nApplyFromSettings(s.ui_lang || 'es');
    }
    if (typeof window.setTimeZone === 'function') {
      window.setTimeZone(s.app_tz || _cfgDefaultTimeZone());
    }

    if (s.page_title) {
      document.title = s.page_title;
      const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (appleTitle) appleTitle.setAttribute('content', s.page_title);
    }

    if (s.theme && !localStorage.getItem('ai_theme_id')) localStorage.setItem('ai_theme_id', s.theme);
  }

  function _cfgDefaultTimeZone() {
    try {
      if (typeof window.getDefaultTimeZone === 'function') return window.getDefaultTimeZone();
      if (typeof window.getTimeZone === 'function') return window.getTimeZone();
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_) {
      return 'UTC';
    }
  }

  async function cfgLoadModernSettings() {
    try {
      const data = await fetch('/api/settings').then(r => r.json());
      if (!data.ok) return;
      if (typeof window.cfgPopulateModern === 'function') {
        await window.cfgPopulateModern(data.settings || {});
      }
      if (typeof window._syncTopbarNetworkScanVisibility === 'function') {
        window._syncTopbarNetworkScanVisibility();
      }
    } catch (e) { console.warn('[cfg] modern settings load', e); }
  }

  window.cfgPopulateModern = cfgPopulateModern;
  window.cfgLoadModernSettings = cfgLoadModernSettings;

  $(document).off('input.cfgFrontendRefresh change.cfgFrontendRefresh', '#cfgFrontendRefreshSeconds, #cfgFrontendDashboardRefreshSeconds')
    .on('input.cfgFrontendRefresh change.cfgFrontendRefresh', '#cfgFrontendRefreshSeconds, #cfgFrontendDashboardRefreshSeconds', _cfgRenderFrontendRefreshHuman);

  $(document).off('click.cfgFrontendRefreshSave', '#cfgFrontendRefreshSave').on('click.cfgFrontendRefreshSave', '#cfgFrontendRefreshSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgFrontendRefreshMsg', 'Guardando…', true);

    const payload = {
      frontend_refresh_interval_seconds: _cfgClampFrontendRefreshSeconds(_cfgGet('cfgFrontendRefreshSeconds')?.value, 30, 5),
      frontend_dashboard_refresh_interval_seconds: _cfgClampFrontendRefreshSeconds(_cfgGet('cfgFrontendDashboardRefreshSeconds')?.value, 60, 10)
    };

    try {
      const data = await _cfgSave(payload);
      if (!data.ok) throw new Error(data.error || 'Error');
      _cfgApplyFrontendRefreshRuntime(data.settings || payload);
      _cfgPopulateFrontendRefreshSettings(data.settings || payload);
      _cfgStatus('cfgFrontendRefreshMsg', '✓ Guardado', true);
    } catch (e) {
      _cfgStatus('cfgFrontendRefreshMsg', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('input.cfgFrontendLimits change.cfgFrontendLimits', '#cfgFrontendHistoryLimit, #cfgFrontendDetailHistoryLimit, #cfgFrontendTableRowsLimit, #cfgFrontendExportRowsLimit')
    .on('input.cfgFrontendLimits change.cfgFrontendLimits', '#cfgFrontendHistoryLimit, #cfgFrontendDetailHistoryLimit, #cfgFrontendTableRowsLimit, #cfgFrontendExportRowsLimit', _cfgRenderFrontendLimitsHuman);

  $(document).off('click.cfgFrontendLimitsSave', '#cfgFrontendLimitsSave').on('click.cfgFrontendLimitsSave', '#cfgFrontendLimitsSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgFrontendLimitsMsg', 'Guardando…', true);

    const payload = {
      frontend_history_limit: _cfgClampFrontendLimit(_cfgGet('cfgFrontendHistoryLimit')?.value, 5000, 100, 50000),
      frontend_detail_history_limit: _cfgClampFrontendLimit(_cfgGet('cfgFrontendDetailHistoryLimit')?.value, 20000, 500, 100000),
      frontend_table_rows_limit: _cfgClampFrontendLimit(_cfgGet('cfgFrontendTableRowsLimit')?.value, 2000, 100, 20000),
      frontend_export_rows_limit: _cfgClampFrontendLimit(_cfgGet('cfgFrontendExportRowsLimit')?.value, 5000, 100, 50000)
    };

    try {
      const data = await _cfgSave(payload);
      if (!data.ok) throw new Error(data.error || 'Error');
      _cfgApplyFrontendDataLimitRuntime(data.settings || payload);
      _cfgPopulateFrontendDataLimitSettings(data.settings || payload);
      _cfgStatus('cfgFrontendLimitsMsg', '✓ Guardado', true);
    } catch (e) {
      _cfgStatus('cfgFrontendLimitsMsg', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('input.cfgOperationalTimeouts change.cfgOperationalTimeouts', '#cfgServiceCheckTimeoutSeconds, #cfgServiceInfoTimeoutSeconds, #cfgScriptAiCloudTimeoutSeconds, #cfgScriptAiLocalTimeoutSeconds, #cfgScriptAiFrontendTimeoutSeconds, #cfgScriptReportTimeoutSeconds, #cfgWolTrackerTimeoutSeconds')
    .on('input.cfgOperationalTimeouts change.cfgOperationalTimeouts', '#cfgServiceCheckTimeoutSeconds, #cfgServiceInfoTimeoutSeconds, #cfgScriptAiCloudTimeoutSeconds, #cfgScriptAiLocalTimeoutSeconds, #cfgScriptAiFrontendTimeoutSeconds, #cfgScriptReportTimeoutSeconds, #cfgWolTrackerTimeoutSeconds', _cfgRenderOperationalTimeoutsHuman);

  $(document).off('click.cfgOperationalTimeoutsSave', '#cfgOperationalTimeoutsSave').on('click.cfgOperationalTimeoutsSave', '#cfgOperationalTimeoutsSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgOperationalTimeoutsMsg', 'Guardando…', true);

    const payload = {
      service_check_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgServiceCheckTimeoutSeconds')?.value, 8, 1, 60),
      service_info_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgServiceInfoTimeoutSeconds')?.value, 6, 1, 60),
      script_ai_cloud_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgScriptAiCloudTimeoutSeconds')?.value, 30, 5, 300),
      script_ai_local_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgScriptAiLocalTimeoutSeconds')?.value, 180, 30, 900),
      script_ai_frontend_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgScriptAiFrontendTimeoutSeconds')?.value, 135, 30, 600),
      script_report_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgScriptReportTimeoutSeconds')?.value, 120, 30, 600),
      wol_tracker_timeout_seconds: _cfgClampOperationalTimeout(_cfgGet('cfgWolTrackerTimeoutSeconds')?.value, 120, 10, 900)
    };

    try {
      const data = await _cfgSave(payload);
      if (!data.ok) throw new Error(data.error || 'Error');
      _cfgApplyOperationalTimeoutRuntime(data.settings || payload);
      _cfgPopulateOperationalTimeoutSettings(data.settings || payload);
      _cfgStatus('cfgOperationalTimeoutsMsg', '✓ Guardado', true);
    } catch (e) {
      _cfgStatus('cfgOperationalTimeoutsMsg', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('change.cfgAiModern', '#cfgAiProvider').on('change.cfgAiModern', '#cfgAiProvider', function () {
    _cfgToggleAiFields(this.value || 'gemini');
  });

  $(document).off('input.cfgAiSecretFields', '#cfgAiGeminiKey, #cfgAiMistralKey').on('input.cfgAiSecretFields', '#cfgAiGeminiKey, #cfgAiMistralKey', function () {
    _cfgRefreshSecretFieldState(this.id, this.id === 'cfgAiGeminiKey' ? 'Gemini' : 'Mistral');
  });

  $(document).off('click', '.theme-card');

  $(document).off('click', '#cfgDetectionSave').on('click', '#cfgDetectionSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgDetectionMsg', 'Guardando…', true);

    const payload = {
      scan_cidr: (_cfgGet('cfgCidr')?.value || '').trim(),
      scan_interval: parseInt(_cfgGet('cfgInterval')?.value || 900, 10),
      dns_server: _cfgGet('cfgDns')?.value || '', retention_days: parseInt(_cfgGet('cfgRetention')?.value || 14, 10),
      wol_port: parseInt(_cfgGet('cfgWolPort')?.value || 9, 10), wol_broadcast: _cfgGet('cfgWolBroadcast')?.value || '',
      scan_primary_source: _cfgGet('scanPrimaryNmap')?.checked ? 'nmap' : 'router',
      scan_secondary_source: _cfgGet('cfgSecondarySource')?.value || 'none',
      scan_secondary_interval_hours: _cfgGet('cfgSecondaryInterval')?.value || '2',
      scan_secondary_ai_enabled: _cfgGet('cfgSecondaryAiEnabled')?.checked ? 1 : 0,
    };

    try {
      const res = await fetch('/api/settings', {
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error');
      _renderTopbarNetworkScanInterval(data.settings || payload || {});
      _cfgStatus('cfgDetectionMsg', '✓ Guardado', true);
    } catch (e) {
      _cfgStatus('cfgDetectionMsg', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click.cfgSyncthingSave', '#cfgSyncthingSave').on('click.cfgSyncthingSave', '#cfgSyncthingSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgSyncthingMsg', 'Guardando…', true);

    const payload = {
      syncthing_refresh_interval_seconds: parseInt(_cfgGet('cfgSyncthingRefreshSeconds')?.value || 60, 10) || 60,
      syncthing_snapshot_retention_days: parseInt(_cfgGet('cfgSyncthingSnapshotDays')?.value || 14, 10) || 14,
      syncthing_stalled_threshold_minutes: parseInt(_cfgGet('cfgSyncthingStalledMinutes')?.value || 60, 10) || 60,
      syncthing_stalled_alert_cooldown_minutes: parseInt(_cfgGet('cfgSyncthingStalledAlertCooldown')?.value || 120, 10) || 120,
      syncthing_transfer_active_threshold_bps: parseInt(_cfgGet('cfgSyncthingTransferThresholdBps')?.value || 1024, 10) || 1024,
      syncthing_transfer_active_min_delta_bytes: parseInt(_cfgGet('cfgSyncthingTransferMinDeltaBytes')?.value || 1048576, 10) || 1048576,
      syncthing_store_file_names: _cfgGet('cfgSyncthingStoreFileNames')?.checked ? 1 : 0,
      syncthing_file_event_retention_days: parseInt(_cfgGet('cfgSyncthingFileEventDays')?.value || 5, 10) || 5,
      syncthing_file_name_retention_days: parseInt(_cfgGet('cfgSyncthingFileNameDays')?.value || 7, 10) || 7,
    };

    try {
      const data = await _cfgSave(payload);
      _cfgStatus('cfgSyncthingMsg', data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'), !!data.ok);
    } catch (e) {
      _cfgStatus('cfgSyncthingMsg', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('change', '#cfgSecondarySource').on('change', '#cfgSecondarySource', function () {
    const wrap = _cfgGet('cfgSecondaryIntervalWrap');
    if (wrap) wrap.style.display = (this.value || 'none') === 'none' ? 'none' : '';
  });

  $(document).off('click', '#discNmapNowBtn').on('click', '#discNmapNowBtn', async function () {
    const $btn = $(this); $btn.prop('disabled', true);
    $('#discTableWrap').html('<div class="small-muted">Lanzando scan nmap…</div>');
    try {
      const data = await fetch('/api/scan/discrepancies/nmap-now', { method:'POST' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      window.showToast?.('✓ Scan nmap lanzado', 'success');
      if (typeof loadDiscrepancies === 'function') setTimeout(loadDiscrepancies, 1200);
    } catch (e) {
      $('#discTableWrap').html(`<div class="text-danger small">${esc(e.message)}</div>`);
    } finally { $btn.prop('disabled', false); }
  });

  function _renderScannerSecondaryNetworks(networks = []) {
    const $row  = $('#scannerSecNetsRow');
    const $list = $('#scannerSecNetsList');
    if (!$row.length || !$list.length) return;

    const enabled = (Array.isArray(networks) ? networks : [])
      .map(n => ({
        label: String(n?.label || '').trim(),
        cidr: String(n?.cidr || '').trim(),
        interface: String(n?.interface || '').trim(),
        enabled: Number(n?.enabled ?? 1),
        kind: String(n?.kind || 'secondary').trim(),
      }))
      .filter(n => n.cidr && n.enabled && n.kind !== 'primary');

    if (!enabled.length) {
      $list.empty();
      $row.hide();
      return;
    }

    $list.html(enabled.map(n => {
      const title = [n.label || 'Red secundaria', n.cidr, n.interface ? `· ${n.interface}` : '']
        .filter(Boolean)
        .join(' ');
      const text = [n.label || '', n.cidr].filter(Boolean).join(' · ');
      const meta = n.interface ? `<span class="small-muted ms-1">${esc(n.interface)}</span>` : '';
      return `<span class="badge rounded-pill text-bg-dark border border-secondary-subtle px-3 py-2" title="${esc(title)}">` +
        `<i class="bi bi-diagram-3 me-1" style="color:var(--accent)"></i>` +
        `<span class="mono">${esc(text)}</span>${meta}</span>`;
    }).join(''));
    $row.show();
  }

  async function loadNetworksModern() {
    const $tbody = $('#cfgNetTbody');
    if (!$tbody.length) return;
    try {
      const [sRes, nRes, iRes] = await Promise.all([
        fetch('/api/settings').then(r => r.json()),
        fetch('/api/config/networks').then(r => r.json()),
        fetch('/api/config/network/interfaces').then(r => r.json()),
      ]);
      const s = sRes.settings || {};
      const discoveryNetworks = Array.isArray(s.discovery_networks) ? s.discovery_networks : [];
      const secondaryFallback = Array.isArray(s.secondary_networks) ? s.secondary_networks : [];
      const networks = (Array.isArray(nRes.networks) && nRes.networks.length)
        ? nRes.networks
        : (discoveryNetworks.filter(n => String(n?.kind || '') !== 'primary').length
            ? discoveryNetworks.filter(n => String(n?.kind || '') !== 'primary')
            : secondaryFallback);
      const ifaces = iRes.interfaces || [];
      const opts = ifaces.map(i => {
        const label = `${i.name}${(i.addrs || []).length ? ' · ' + i.addrs.join(', ') : ''}`;
        return `<option value="${esc(i.name)}">${esc(label)}</option>`;
      }).join('');

      _cfgSyncPrimaryCidr(s.scan_cidr || '');
      _cfgSyncScanInterval(s.scan_interval || 900);
      _cfgSyncScanOnBoot(s.scan_on_boot);

      $('#cfgPrimaryNetIface, #cfgPrimaryIface').empty().append(`<option value="">${esc(window.t?.('cfg.network.automatic', 'Automático') || 'Automático')}</option>`).append(opts);
      _cfgSyncPrimaryIface(s.primary_net_interface || '');

      $('#cfgNetIface').empty().append(`<option value="">${esc(window.t?.('cfg.network.automatic', 'Automático') || 'Automático')}</option>`).append(opts);
      $('#cfgPrimaryNetLabel').val(s.primary_net_label || '');
      $tbody.html(networks.map(n => `<tr data-id="${n.id}"><td><input class="form-control form-control-sm net-label-inp" value="${esc(n.label || '')}"></td><td><input class="form-control form-control-sm net-cidr-inp" value="${esc(n.cidr || '')}"></td><td><select class="form-select form-select-sm net-iface-inp"><option value="">Automático</option>${opts}</select></td><td class="text-center"><input type="checkbox" class="form-check-input net-enabled-inp" ${n.enabled ? 'checked' : ''}></td><td class="text-end"><div class="btn-group btn-group-sm"><button class="btn btn-outline-success cfg-net-save"><i class="bi bi-save2"></i></button><button class="btn btn-outline-danger cfg-net-del"><i class="bi bi-trash3"></i></button></div></td></tr>`).join('') || (`<tr><td colspan="5" class="small-muted">${esc(window.t?.('cfg.network.no_secondary', 'Sin redes secundarias') || 'Sin redes secundarias')}</td></tr>`));
      networks.forEach(n => $tbody.find(`tr[data-id="${n.id}"] .net-iface-inp`).val(n.interface || ''));
      _renderScannerSecondaryNetworks(discoveryNetworks.length ? discoveryNetworks : networks);
      $('#networksHelpCard, #networksHelp, #cfgNetworksHelp').hide();
    } catch (e) {
      _renderScannerSecondaryNetworks([]);
      $tbody.html(`<tr><td colspan="5" class="text-danger small">${esc(e.message)}</td></tr>`);
    }
  }
  window.loadNetworks = loadNetworksModern;
  try { loadNetworks = loadNetworksModern; } catch (_) {}
  $(document).off('click', '#cfgPrimaryIfaceRefresh').on('click', '#cfgPrimaryIfaceRefresh', loadNetworksModern);
  $(document).off('click', '#cfgPrimaryNetSave').on('click', '#cfgPrimaryNetSave', async function () {
    const payload = {
      scan_cidr: _cfgReadPrimaryCidr(),
      scan_interval: _cfgReadScanInterval(),
      scan_on_boot: _cfgGet('bootScan')?.checked ? 1 : 0,
      primary_net_label: $('#cfgPrimaryNetLabel').val() || '',
      primary_net_interface: _cfgReadPrimaryIface(),
    };
    const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
    _cfgStatus('cfgPrimaryNetMsg', data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'), !!data.ok);
    if (data.ok) {
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
      await cfgLoadModernSettings();
      await loadNetworksModern();
    }
  });
  $(document).off('click', '#cfgNetAdd').on('click', '#cfgNetAdd', async function () {
    const payload = { label: ($('#cfgNetLabel').val() || '').trim(), cidr: ($('#cfgNetCidr').val() || '').trim(), interface: ($('#cfgNetIfaceManual').is(':visible') ? $('#cfgNetIfaceManual').val() : $('#cfgNetIface').val()) || '', enabled: 1 };
    const data = await fetch('/api/config/networks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
    if (data.ok) {
      $('#cfgNetLabel, #cfgNetCidr, #cfgNetIfaceManual').val('');
      $('#cfgNetIface').val('');
      await loadNetworksModern();
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
    } else window.showToast?.('✗ ' + (data.error || 'Error'), 'danger');
  });
  $(document).off('click', '.cfg-net-save').on('click', '.cfg-net-save', async function () {
    const $tr = $(this).closest('tr');
    const id = $tr.data('id');
    const payload = { label: $tr.find('.net-label-inp').val() || '', cidr: $tr.find('.net-cidr-inp').val() || '', interface: $tr.find('.net-iface-inp').val() || '', enabled: $tr.find('.net-enabled-inp').is(':checked') ? 1 : 0 };
    const data = await fetch(`/api/config/networks/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
    window.showToast?.(data.ok ? (window.t?.('cfg.network.saved', '✓ Red guardada') || '✓ Red guardada') : '✗ ' + (data.error || window.t?.('status.error', 'Error') || 'Error'), data.ok ? 'success' : 'danger');
    if (data.ok) {
      await loadNetworksModern();
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
    }
  });
  $(document).off('click', '.cfg-net-del').on('click', '.cfg-net-del', async function () {
    const id = $(this).closest('tr').data('id');
    await fetch(`/api/config/networks/${id}`, { method:'DELETE' });
    await loadNetworksModern();
    if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
  });
  $(document).off('click', '#cfgNetDetectBtn').on('click', '#cfgNetDetectBtn', async function () {
    const cidr = ($('#cfgNetCidr').val() || '').trim();
    const data = await fetch('/api/config/network/interfaces').then(r => r.json());
    const ifaces = data.interfaces || [];
    let picked = '';
    if (cidr) {
      const base = cidr.split('/')[0].split('.').slice(0,3).join('.');
      picked = (ifaces.find(i => (i.addrs || []).some(a => a.startsWith(base + '.'))) || {}).name || '';
    }
    if (!picked && ifaces[0]) picked = ifaces[0].name;
    $('#cfgNetIface').val(picked);
    if (picked) window.showToast?.(window.t?.('cfg.network.detected_iface', 'Interfaz detectada: {iface}', { iface: picked }) || `Interfaz detectada: ${picked}`, 'success');
  });

  function _toggleDiscordSecretInput(inputId, button) {
    const el = _cfgGet(inputId);
    if (!el) return;
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $(button).find('i').toggleClass('bi-eye', !show).toggleClass('bi-eye-slash', show);
  }

  async function _testDiscordChannel(channel, resultId) {
    const saved = await _saveNotificationsAndSmtp();
    if (!saved.ok) {
      _cfgStatus(resultId, '✗ ' + (saved.error || 'Error guardando Discord'), false);
      return;
    }
    const t = await fetch('/api/settings/test-discord', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ channel })
    }).then(r => r.json());
    _cfgStatus(resultId, t.ok ? '✓ Enviado' : '✗ ' + (t.error || 'Error'), !!t.ok);
  }

  $(document).off('click', '#cfgDiscordInfoTest').on('click', '#cfgDiscordInfoTest', async function () {
    await _testDiscordChannel('info', 'cfgDiscordInfoTestResult');
  });
  $(document).off('click', '#cfgDiscordAlertsTest').on('click', '#cfgDiscordAlertsTest', async function () {
    await _testDiscordChannel('alerts', 'cfgDiscordAlertsTestResult');
  });
  $(document).off('click', '#cfgDiscordInfoToggle').on('click', '#cfgDiscordInfoToggle', function () {
    _toggleDiscordSecretInput('cfgDiscordInfo', this);
  });
  $(document).off('click', '#cfgDiscordAlertsToggle').on('click', '#cfgDiscordAlertsToggle', function () {
    _toggleDiscordSecretInput('cfgDiscordAlerts', this);
  });

  async function loadAiReportsModern() {
    const $wrap = $('#aiReportsListWrap');
    if (!$wrap.length) return;
    $wrap.html('<div class="text-muted small">Cargando…</div>');
    try {
      const data = await fetch('/api/scan/ai-reports?limit=20').then(r => r.json());
      const reports = Array.isArray(data.reports) ? data.reports : [];
      if (!reports.length) {
        $wrap.html('<div class="small-muted">Sin informes generados.</div>');
        return;
      }
      $wrap.html(`<div class="table-responsive"><table class="table table-sm table-hover align-middle"><thead><tr><th>Fecha</th><th>Discrepancias</th><th>Proveedor</th><th></th></tr></thead><tbody>${reports.map(r => `<tr class="ai-report-row" data-id="${r.id}"><td class="mono">${esc(String(r.generated_at || '').replace('T',' ').slice(0,16) || '—')}</td><td>${r.discrepancy_count ?? '—'}</td><td>${esc(r.source || '—')}</td><td><button class="btn btn-outline-info btn-sm py-0 px-2 ai-report-open" data-id="${r.id}"><i class="bi bi-eye"></i></button></td></tr>`).join('')}</tbody></table></div>`);
    } catch (e) {
      $wrap.html(`<div class="text-danger small">${esc(e.message || 'Error cargando informes')}</div>`);
    }
  }
  window.loadAiReports = loadAiReportsModern;
  try { loadAiReports = loadAiReportsModern; } catch (_) {}
  $(document).off('click', '#aiReportsRefreshBtn').on('click', '#aiReportsRefreshBtn', loadAiReportsModern);

  async function _cfgSave(payload) {
    return fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).then(r => r.json());
  }

  async function _saveNotificationsAndSmtp() {
    const payload = {
      discord_webhook_info: $('#cfgDiscordInfo').val() || '',
      discord_webhook_alerts: $('#cfgDiscordAlerts').val() || '',
      discord_info_fallback_to_alerts: $('#cfgDiscordInfoFallback').is(':checked') ? 1 : 0,
      notify_new: $('#cfgNotifyNew').is(':checked') ? 1 : 0,
      notify_online: $('#cfgNotifyOnline').is(':checked') ? 1 : 0,
      notify_offline: $('#cfgNotifyOffline').is(':checked') ? 1 : 0,
      notify_mac_change: $('#cfgNotifyMac').is(':checked') ? 1 : 0,
      notify_service_down: $('#cfgNotifySvcDown').is(':checked') ? 1 : 0,
      notify_syncthing_stalled: $('#cfgNotifySyncthingStalled').is(':checked') ? 1 : 0,
      notify_quality_degraded: $('#cfgNotifyQualityDegraded').is(':checked') ? 1 : 0,
      notify_script_alerts: $('#cfgNotifyScriptAlerts').is(':checked') ? 1 : 0,
      notify_email: $('#cfgNotifyEmail').is(':checked') ? 1 : 0,
      email_new: $('#cfgEmailNew').is(':checked') ? 1 : 0,
      email_online: $('#cfgEmailOnline').is(':checked') ? 1 : 0,
      email_offline: $('#cfgEmailOffline').is(':checked') ? 1 : 0,
      email_mac_change: $('#cfgEmailMac').is(':checked') ? 1 : 0,
      email_service_down: $('#cfgEmailSvcDown').is(':checked') ? 1 : 0,
      email_syncthing_stalled: $('#cfgEmailSyncthingStalled').is(':checked') ? 1 : 0,
      email_quality_degraded: $('#cfgEmailQualityDegraded').is(':checked') ? 1 : 0,
      email_script_alerts: $('#cfgEmailScriptAlerts').is(':checked') ? 1 : 0,
      automation_watchdog_enabled: $('#cfgAutomationWatchdogEnabled').is(':checked') ? 1 : 0,
      automation_watchdog_enforce_state: $('#cfgAutomationWatchdogEnforceState').is(':checked') ? 1 : 0,
      automation_watchdog_missed_grace_minutes: parseInt($('#cfgAutomationWatchdogMissedGrace').val() || 30, 10),
      automation_watchdog_stalled_minutes: parseInt($('#cfgAutomationWatchdogStalledMinutes').val() || 60, 10),
      push_online: $('#cfgPushOnline').is(':checked') ? 1 : 0,
      push_offline: $('#cfgPushOffline').is(':checked') ? 1 : 0,
      push_mac_change: $('#cfgPushMac').is(':checked') ? 1 : 0,
      push_service_down: $('#cfgPushSvcDown').is(':checked') ? 1 : 0,
      smtp_enabled: $('#cfgSmtpEnabled').is(':checked') ? 1 : 0,
      smtp_host: $('#cfgSmtpHost').val() || '',
      smtp_port: parseInt($('#cfgSmtpPort').val() || 587, 10),
      smtp_tls: $('#cfgSmtpTls').val() || 'starttls',
      smtp_user: $('#cfgSmtpUser').val() || '',
      smtp_pass: $('#cfgSmtpPass').val() || '',
      smtp_to: $('#cfgSmtpTo').val() || '',
      smtp_from: $('#cfgSmtpFrom').val() || '',
    };
    return _cfgSave(payload);
  }

  async function _saveRouterSettings() {
    const data = await _cfgSave({
      router_enabled: $('#cfgRouterEnabled').is(':checked') ? 1 : 0,
      router_ssh_host: $('#cfgRouterHost').val() || '',
      router_ssh_port: parseInt($('#cfgRouterPort').val() || 22, 10),
      router_ssh_user: $('#cfgRouterUser').val() || '',
      router_ssh_key: $('#cfgRouterKey').val() || '',
    });
    loadRouterProfilesPreview().catch(() => {});
    return data;
  }

  async function _saveAiSettings() {
    const provider = $('#cfgAiProvider').val() || 'gemini';
    return _cfgSave({
      ai_provider: provider,
      ai_gemini_key: $('#cfgAiGeminiKey').val() || '',
      ai_gemini_model: $('#cfgAiGeminiModel').val() || 'gemini-2.0-flash',
      ai_mistral_key: $('#cfgAiMistralKey').val() || '',
      ai_mistral_model: $('#cfgAiMistralModel').val() || 'mistral-small-latest',
      ai_ollama_url: $('#cfgAiOllamaUrl').val() || 'http://localhost:11434',
      ai_ollama_model: $('#cfgAiOllamaModel').val() || 'gemma2:2b',
    });
  }

  function _discFmtDate(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted && formatted !== '—' ? esc(formatted) : '—';
    }
    return esc(String(value).replace('T', ' ').slice(0, 16));
  }

  function _discPriorityMeta(row) {
    const pending = !row.accepted;
    const hasKnownContext = !!(row.manual_name || row.router_hostname || row.nmap_hostname || row.vendor);
    const timesSeen = Number(row.times_seen || 0);

    if (!pending) return { label: 'Aceptada', cls: 'bg-success' };
    if (!hasKnownContext && timesSeen >= 3) return { label: 'Alta', cls: 'bg-danger' };
    if (!hasKnownContext || timesSeen >= 2) return { label: 'Media', cls: 'bg-warning text-dark' };
    return { label: 'Baja', cls: 'bg-info text-dark' };
  }

  function _discContextHtml(row) {
    const parts = [];
    if (row.manual_name) parts.push(`Manual: ${esc(row.manual_name)}`);
    if (row.router_hostname) parts.push(`Router: ${esc(row.router_hostname)}`);
    if (row.nmap_hostname) parts.push(`nmap: ${esc(row.nmap_hostname)}`);
    if (row.vendor) parts.push(`Vendor: ${esc(row.vendor)}`);

    if (!parts.length) {
      return '<div class="small-muted" style="font-size:.74rem">Sin pistas de host conocido en BD.</div>';
    }
    return `<div class="small-muted" style="font-size:.74rem;line-height:1.35">${parts.join(' · ')}</div>`;
  }

  async function loadDiscrepanciesModern() {
    const $wrap = $('#discTableWrap');
    if (!$wrap.length) return;
    $wrap.html('<div class="small-muted" style="font-size:.8rem">Cargando…</div>');
    try {
      const data = await fetch('/api/scan/discrepancies').then(r => r.json());
      const rows = data.discrepancies || [];
      const pending = rows.filter(r => !r.accepted);
      const high = pending.filter(r => _discPriorityMeta(r).label === 'Alta').length;
      const medium = pending.filter(r => _discPriorityMeta(r).label === 'Media').length;

      $('#discBadge').text(pending.length || '').toggle(!!pending.length);
      $('#discAcceptAllBtn').toggle(pending.length > 1);

      if (!rows.length) {
        $wrap.html('<div class="small-muted" style="font-size:.8rem">Sin discrepancias registradas.</div>');
        return;
      }

      const summaryHtml = `
        <div class="d-flex flex-wrap gap-2 mb-2">
          <span class="badge bg-secondary">Total: ${rows.length}</span>
          <span class="badge bg-warning text-dark">Pendientes: ${pending.length}</span>
          <span class="badge bg-danger">Alta: ${high}</span>
          <span class="badge bg-warning text-dark">Media: ${medium}</span>
        </div>
      `;

      $wrap.html(
        summaryHtml +
        `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>IP / MAC</th>
              <th>Contexto conocido</th>
              <th>Última detección</th>
              <th>Veces</th>
              <th>Prioridad</th>
              <th>Estado</th>
              <th class="text-end">Acciones</th>
            </tr>
          </thead>
          <tbody>${
            rows.map(r => {
              const prio = _discPriorityMeta(r);
              const acceptedBadge = r.accepted
                ? `<span class="badge bg-success">${esc(window.t?.('cfg.discrepancies.accepted', 'Aceptada') || 'Aceptada')}</span>`
                : `<span class="badge bg-warning text-dark">${esc(window.t?.('cfg.discrepancies.pending', 'Pendiente') || 'Pendiente')}</span>`;

              return `<tr style="${r.accepted ? 'opacity:.72;' : ''}">
                <td>
                  <div class="mono">${esc(r.ip || '—')}</div>
                  <div class="mono small-muted" style="font-size:.72rem">${esc(r.mac || '—')}</div>
                </td>
                <td>${_discContextHtml(r)}</td>
                <td>
                  <div class="mono" style="font-size:.75rem">${_discFmtDate(r.last_seen)}</div>
                  <div class="small-muted" style="font-size:.7rem">Primera: ${_discFmtDate(r.first_seen)}</div>
                </td>
                <td>${r.times_seen ?? '—'}</td>
                <td><span class="badge ${prio.cls}">${prio.label}</span></td>
                <td>${acceptedBadge}</td>
                <td class="text-end">
                  <div class="btn-group btn-group-sm">
                    ${!r.accepted ? `<button class="btn btn-outline-success disc-accept" data-id="${r.id}" title="Aceptar"><i class="bi bi-check-lg"></i></button>` : ''}
                    <button class="btn btn-outline-danger disc-delete" data-id="${r.id}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash3"></i></button>
                  </div>
                </td>
              </tr>`;
            }).join('')
          }</tbody>
        </table></div>`
      );
    } catch (e) {
      $wrap.html(`<div class="text-danger small">${esc(e.message)}</div>`);
    }
  }
  window.loadDiscrepancies = loadDiscrepanciesModern;
  try { loadDiscrepancies = loadDiscrepanciesModern; } catch (_) {}


  $(document).off('click', '.cfg-nav-btn[data-section="scanner"]').on('click', '.cfg-nav-btn[data-section="scanner"]', function () {
    cfgLoadModernSettings();
    loadDiscrepanciesModern();
    loadAiReportsModern();
    loadDiscoveryScannersPreview();
  });

  $(document).off('click', '.cfg-nav-btn[data-section="notifications"]').on('click', '.cfg-nav-btn[data-section="notifications"]', function () {
    cfgLoadModernSettings();
  });

  $(document).off('click', '.cfg-nav-btn[data-section="router"]').on('click', '.cfg-nav-btn[data-section="router"]', function () {
    loadRouterProfilesPreview();
  });

  $(document).off('click', '#discNmapNowBtn').on('click', '#discNmapNowBtn', async function () {
    const $btn = $(this);
    const $wrap = $('#discTableWrap');
    $btn.prop('disabled', true);
    $wrap.html('<div class="small-muted" style="font-size:.8rem">Lanzando scan nmap…</div>');
    try {
      const data = await fetch('/api/scan/nmap-now', { method:'POST' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $wrap.html(`<div class="small text-success">✓ Scan nmap completado · ${data.hosts_found ?? '—'} hosts</div>`);
      await loadDiscrepanciesModern();
    } catch (e) {
      $wrap.html(`<div class="text-danger small">${esc(e.message)}</div>`);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#discAiNowBtn').on('click', '#discAiNowBtn', async function () {
    const $btn = $(this);
    const $msg = $('#discAiMsg');
    $btn.prop('disabled', true);
    $msg.removeClass('text-success text-danger').text('Lanzando análisis IA…');
    try {
      const data = await fetch('/api/scan/ai-analyze-now', { method:'POST' }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');
      $msg.addClass('text-success').text('✓ Análisis IA lanzado. El informe debería aparecer en unos segundos.');
      window.setTimeout(() => {
        loadAiReportsModern();
        loadDiscrepanciesModern();
      }, 4000);
    } catch (e) {
      $msg.addClass('text-danger').text('✗ ' + e.message);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#cfgSmtpPassToggle').on('click', '#cfgSmtpPassToggle', function () {
    const $inp = $('#cfgSmtpPass');
    const show = $inp.attr('type') === 'password';
    $inp.attr('type', show ? 'text' : 'password');
    $(this).find('i').toggleClass('bi-eye', !show).toggleClass('bi-eye-slash', show);
  });

  $(document).off('click', '#cfgSmtpTest').on('click', '#cfgSmtpTest', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgSmtpTestResult', 'Enviando test…', true);
    try {
      const saved = await _saveNotificationsAndSmtp();
      if (!saved.ok) throw new Error(saved.error || 'No se pudo guardar SMTP');
      const data = await fetch('/api/settings/test-smtp', { method:'POST' }).then(r => r.json());
      _cfgStatus('cfgSmtpTestResult', data.ok ? '✓ Email enviado' : '✗ ' + (data.error || 'Error'), !!data.ok);
    } catch (e) {
      _cfgStatus('cfgSmtpTestResult', '✗ ' + e.message, false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#cfgRouterTest').on('click', '#cfgRouterTest', async function () {
    const $btn = $(this);
    const $detail = $('#cfgRouterTestDetail');
    const $table = $('#cfgRouterTestTable');
    $btn.prop('disabled', true);
    _cfgStatus('cfgRouterTestResult', 'Probando conexión…', true);
    $detail.hide();
    try {
      const saved = await _saveRouterSettings();
      if (!saved.ok) throw new Error(saved.error || 'No se pudo guardar Router SSH');
      const data = await fetch('/api/router/test', { method:'POST' }).then(r => r.json());
      _cfgStatus('cfgRouterTestResult', data.ok ? '✓ Conexión correcta' : '✗ ' + (data.error || 'Error'), !!data.ok);
      const diags = (data.diagnostics || []).map(x => `<div class="mono" style="font-size:.75rem">${esc(x)}</div>`).join('');
      const hosts = (data.hosts || []).slice(0, 25).map(h => `<tr><td class="mono">${esc(h.ip || '—')}</td><td class="mono">${esc(h.mac || '—')}</td><td>${esc(h.hostname || h.name || '—')}</td></tr>`).join('');
      $table.html(`${diags}${hosts ? `<div class="table-responsive mt-2"><table class="table table-sm table-dark table-striped mb-0"><thead><tr><th>IP</th><th>MAC</th><th>Hostname</th></tr></thead><tbody>${hosts}</tbody></table></div>` : ''}`);
      $detail.show();
    } catch (e) {
      _cfgStatus('cfgRouterTestResult', '✗ ' + e.message, false);
      $table.html(`<div class="text-danger small">${esc(e.message)}</div>`);
      $detail.show();
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#cfgRouterScanNow').on('click', '#cfgRouterScanNow', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgRouterTestResult', 'Lanzando scan…', true);
    try {
      const saved = await _saveRouterSettings();
      if (!saved.ok) throw new Error(saved.error || 'No se pudo guardar Router SSH');
      const data = await fetch('/api/router/scan', { method:'POST' }).then(r => r.json());
      _cfgStatus('cfgRouterTestResult', data.ok ? `✓ ${data.hosts_found || 0} hosts · ${data.silent_new || 0} nuevos` : '✗ ' + (data.error || 'Error'), !!data.ok);
    } catch (e) {
      _cfgStatus('cfgRouterTestResult', '✗ ' + e.message, false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#cfgAiSave').on('click', '#cfgAiSave', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgAiTestResult', 'Guardando…', true);
    try {
      const data = await _saveAiSettings();
      if (data.ok) await cfgLoadModernSettings();
      _cfgStatus('cfgAiTestResult', data.ok ? '✓ Guardado' : '✗ ' + (data.error || 'Error'), !!data.ok);
    } catch (e) {
      _cfgStatus('cfgAiTestResult', '✗ ' + e.message, false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '#cfgAiTest').on('click', '#cfgAiTest', async function () {
    const $btn = $(this);
    $btn.prop('disabled', true);
    _cfgStatus('cfgAiTestResult', 'Probando IA…', true);
    try {
      const saved = await _saveAiSettings();
      if (!saved.ok) throw new Error(saved.error || 'No se pudo guardar IA');
      const data = await fetch('/api/ai/test').then(r => r.json());
      _cfgStatus('cfgAiTestResult', data.ok ? `✓ ${data.provider || 'IA'} · ${data.model || data.detail || 'OK'}` : '✗ ' + (data.error || 'Error'), !!data.ok);
    } catch (e) {
      _cfgStatus('cfgAiTestResult', '✗ ' + e.message, false);
    } finally {
      $btn.prop('disabled', false);
    }
  });

  let _cfgPersistTimer = null;
  function _scheduleCfgPersist(kind) {
    clearTimeout(_cfgPersistTimer);
    _cfgPersistTimer = setTimeout(async () => {
      try {
        if (kind === 'notify') await _saveNotificationsAndSmtp();
        if (kind === 'router') await _saveRouterSettings();
      } catch (_) {}
    }, 350);
  }
  $(document).off('change.cfgAuto blur.cfgAuto');
  $(document).on('change.cfgAuto', '#cfgDiscordInfo, #cfgDiscordAlerts, #cfgDiscordInfoFallback, #cfgNotifyNew, #cfgNotifyOnline, #cfgNotifyOffline, #cfgNotifyMac, #cfgNotifySvcDown, #cfgNotifySyncthingStalled, #cfgNotifyQualityDegraded, #cfgNotifyScriptAlerts, #cfgNotifyEmail, #cfgEmailNew, #cfgEmailOnline, #cfgEmailOffline, #cfgEmailMac, #cfgEmailSvcDown, #cfgEmailSyncthingStalled, #cfgEmailQualityDegraded, #cfgEmailScriptAlerts, #cfgSmtpEnabled, #cfgSmtpTls, #cfgSmtpHost, #cfgSmtpPort, #cfgSmtpUser, #cfgSmtpPass, #cfgSmtpFrom, #cfgSmtpTo', function(){ _scheduleCfgPersist('notify'); });
  $(document).on('blur.cfgAuto', '#cfgDiscordInfo, #cfgDiscordAlerts, #cfgSmtpHost, #cfgSmtpPort, #cfgSmtpUser, #cfgSmtpPass, #cfgSmtpTo, #cfgSmtpFrom', function(){ _scheduleCfgPersist('notify'); });
  $(document).on('change.cfgAuto', '#cfgRouterEnabled', function(){ _scheduleCfgPersist('router'); });
  $(document).on('blur.cfgAuto', '#cfgRouterHost, #cfgRouterPort, #cfgRouterUser, #cfgRouterKey', function(){ _scheduleCfgPersist('router'); });

  async function _persistThemeToServer() {
    try {
      localStorage.removeItem('auditor-theme');
      localStorage.removeItem('auditor-theme-name');
      await _cfgSave({
        theme: localStorage.getItem('ai_theme_id') || 'default',
        ui_theme: localStorage.getItem('ai_theme_id') || 'default',
        accent_color: localStorage.getItem('ai_c1') || $('#cfgAccentCustom').val() || '#4dffb5',
        accent_color2: localStorage.getItem('ai_c2') || $('#cfgAccentCustom2').val() || '#375a7f',
      });
    } catch (_) {}
  }
  $(document).off('blur.cfgAppearance', '#cfgTitle').on('blur.cfgAppearance', '#cfgTitle', async function () {
    const title = ($(this).val() || '').trim() || 'Auditor IPs';
    try {
      await _cfgSave({ page_title: title });
      document.title = title;
      const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (appleTitle) appleTitle.setAttribute('content', title);
    } catch (_) {}
  });

  $(document).off('change.cfgAppearance', '#cfgTz').on('change.cfgAppearance', '#cfgTz', async function () {
    const tz = ($(this).val() || _cfgDefaultTimeZone()).trim();
    try {
      await _cfgSave({ app_tz: tz });
      if (typeof window.setTimeZone === 'function') {
        window.setTimeZone(tz);
      } else {
        localStorage.setItem('auditor_app_tz', tz);
      }
    } catch (_) {}
  });

  $(document).off('click.cfgThemePersist', '.theme-card').on('click.cfgThemePersist', '.theme-card', function () {
    setTimeout(_persistThemeToServer, 0);
  });
  $(document).off('input.cfgThemePersist', '#cfgAccentCustom, #cfgAccentCustom2').on('input.cfgThemePersist', '#cfgAccentCustom, #cfgAccentCustom2', function () {
    clearTimeout(_cfgPersistTimer);
    _cfgPersistTimer = setTimeout(_persistThemeToServer, 250);
  });

  function _cfgInterfaceSyncGroupState(group) {
    const parent = document.querySelector(`.cfg-tab-group-toggle[data-group="${group}"]`);
    const children = Array.from(document.querySelectorAll(`.cfg-tab-toggle[data-group-child="${group}"]`));
    if (!parent || !children.length) return;
    const checked = children.filter(el => el.checked).length;
    parent.checked = checked === children.length;
    parent.indeterminate = checked > 0 && checked < children.length;
  }

  function _cfgInterfaceSyncAllGroupStates() {
    document.querySelectorAll('.cfg-tab-group-toggle[data-group]').forEach(el => {
      _cfgInterfaceSyncGroupState(el.dataset.group);
    });
  }

  $(document)
    .off('change.cfgInterfaceGroup', '.cfg-tab-group-toggle[data-group]')
    .on('change.cfgInterfaceGroup', '.cfg-tab-group-toggle[data-group]', function () {
      const group = this.dataset.group;
      const checked = !!this.checked;
      document.querySelectorAll(`.cfg-tab-toggle[data-group-child="${group}"]`).forEach(el => {
        el.checked = checked;
      });
      _cfgInterfaceSyncGroupState(group);
    });

  $(document)
    .off('change.cfgInterfaceChild', '.cfg-tab-toggle[data-group-child]')
    .on('change.cfgInterfaceChild', '.cfg-tab-toggle[data-group-child]', function () {
      _cfgInterfaceSyncGroupState(this.dataset.groupChild);
    });

  const _origLoadHiddenTabs = typeof loadHiddenTabs === 'function' ? loadHiddenTabs : null;
  loadHiddenTabs = async function () {
    if (_origLoadHiddenTabs) await _origLoadHiddenTabs();
    const data = await fetch('/api/settings').then(r => r.json());
    const settings = data.settings || {};
    const modules = _cfgParseEnabledModules(settings.enabled_modules);
    _cfgApplyModuleTogglesToUi(modules);
    if (typeof window.applyModuleGating === 'function') window.applyModuleGating(modules);
    const hidden = (settings.hidden_tabs || '').split(',').map(x => x.trim()).filter(Boolean);
    document.querySelectorAll('.cfg-tab-toggle').forEach(el => { el.checked = !hidden.includes(el.dataset.tab); });
    _cfgSyncLinkedTabsFromModules(modules);
    _cfgInterfaceSyncAllGroupStates();
    window.applyHiddenTabs?.(hidden);
  };
  $(document).off('click', '#cfgTabTogglesSave').on('click', '#cfgTabTogglesSave', async function () {
    const hidden = [];
    document.querySelectorAll('.cfg-tab-toggle:not(:checked)').forEach(el => hidden.push(el.dataset.tab));
    const modules = _cfgReadEnabledModulesFromUi();
    const data = await fetch('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hidden_tabs: hidden.join(','), enabled_modules: modules }) }).then(r => r.json());
    _cfgStatus('cfgTabTogglesStatus', data.ok ? '✓ Aplicado' : '✗ ' + (data.error || 'Error'), !!data.ok);
    if (data.ok) {
      const savedModules = _cfgParseEnabledModules((data.settings || {}).enabled_modules || modules);
      _cfgApplyModuleTogglesToUi(savedModules);
      if (typeof window.applyModuleGating === 'function') window.applyModuleGating(savedModules);
      _cfgInterfaceSyncAllGroupStates();
      window.applyHiddenTabs?.(hidden);
    }
  });

  $(document).off('change.cfgModuleToggle', '.cfg-module-toggle[data-module]').on('change.cfgModuleToggle', '.cfg-module-toggle[data-module]', function () {
    const modules = _cfgReadEnabledModulesFromUi();
    _cfgSyncLinkedTabsFromModules(modules);
  });

  $(document).off('click.cfgModuleTogglesSave', '#cfgModuleTogglesSave').on('click.cfgModuleTogglesSave', '#cfgModuleTogglesSave', async function () {
    const $btn = $(this);
    const modules = _cfgReadEnabledModulesFromUi();
    $btn.prop('disabled', true);
    _cfgStatus('cfgModuleTogglesStatus', 'Guardando…', true);
    try {
      const data = await fetch('/api/settings', {
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ enabled_modules: modules })
      }).then(r => r.json());
      if (!data.ok) throw new Error(data.error || 'Error');

      const savedModules = _cfgParseEnabledModules((data.settings || {}).enabled_modules || modules);
      _cfgApplyModuleTogglesToUi(savedModules);
      if (typeof window.applyModuleGating === 'function') window.applyModuleGating(savedModules);

      const hidden = ((data.settings || {}).hidden_tabs || '').split(',').map(x => x.trim()).filter(Boolean);
      window.applyHiddenTabs?.(hidden);

      _cfgStatus('cfgModuleTogglesStatus', '✓ Módulos guardados', true);
    } catch (e) {
      _cfgStatus('cfgModuleTogglesStatus', '✗ ' + (e.message || 'Error'), false);
    } finally {
      $btn.prop('disabled', false);
    }
  });



  // ══════════════════════════════════════════════════════════
  // ㉔ DISCOVERY / ROUTER PROFILES — EDITOR SOBRE SCHEMA
  // ══════════════════════════════════════════════════════════

  let _discoveryRouterProfiles = [];
  let _discoveryIfaces = [];

  async function _loadDiscoveryEditorDependencies(force = false) {
    try {
      if (force || !_discoveryIfaces.length) {
        const ifaceData = await fetch('/api/config/network/interfaces', { cache:'no-store' }).then(r => r.json()).catch(() => ({ interfaces: [] }));
        _discoveryIfaces = Array.isArray(ifaceData.interfaces) ? ifaceData.interfaces : [];
      }
    } catch (_) {}
    try {
      if (force || !_discoveryRouterProfiles.length) {
        const rpData = await fetch('/api/router/profiles', { cache:'no-store' }).then(r => r.json()).catch(() => ({ profiles: [] }));
        _discoveryRouterProfiles = Array.isArray(rpData.profiles) ? rpData.profiles : [];
      }
    } catch (_) {}
  }

  function _renderDiscoveryIfaceOptions(selected = '') {
    const sel = String(selected || '').trim();
    const opts = ['<option value="">Automático</option>'].concat(
      (_discoveryIfaces || []).map(i => {
        const name = String(i?.name || '').trim();
        const addrs = Array.isArray(i?.addrs) ? i.addrs.filter(Boolean) : [];
        const label = addrs.length ? `${name} · ${addrs.join(', ')}` : name;
        return `<option value="${esc(name)}"${name === sel ? ' selected' : ''}>${esc(label || name)}</option>`;
      })
    );
    return `<select class="form-select form-select-sm discoverysc-interface">${opts.join('')}</select>`;
  }

  function _serializeDiscoveryNetworksEditor(nets) {
    const rows = Array.isArray(nets) ? nets : [];
    return rows.map(n => {
      const cidr = String(n?.cidr || '').trim();
      const label = String(n?.label || '').trim();
      if (!cidr) return '';
      return label ? `${cidr} | ${label}` : cidr;
    }).filter(Boolean).join('\n');
  }

  function _parseDiscoveryNetworksEditor(raw) {
    const items = [];
    String(raw || '')
      .replace(/\r/g, '')
      .split(/\n+/)
      .forEach(line => {
        String(line || '').split(',').forEach(part => {
          const piece = String(part || '').trim();
          if (!piece) return;
          const bits = piece.split('|');
          const cidr = String(bits[0] || '').trim();
          const label = String(bits.slice(1).join('|') || '').trim();
          if (!cidr) return;
          items.push({ cidr, label, enabled: 1, sort_order: items.length });
        });
      });
    return items;
  }

  function _renderDiscoveryScannerNetworksList(nets) {
    const rows = Array.isArray(nets) ? nets : [];
    if (!rows.length) return '<span class="text-muted">—</span>';
    return rows.map(n => {
      const cidr = esc(String(n?.cidr || '').trim());
      const label = esc(String(n?.label || '').trim());
      return `<div class="d-flex flex-column" style="line-height:1.15">
        <span class="mono" style="font-size:.78rem">${cidr || '—'}</span>
        ${label ? `<span class="small text-muted" style="font-size:.69rem">${label}</span>` : ''}
      </div>`;
    }).join('<div class="my-1"></div>');
  }

  function _renderDiscoveryRouterOptions(selectedId, method) {
    const selected = String(selectedId ?? '').trim();
    const usesRouter = ['router', 'router+nmap'].includes(String(method || 'nmap').trim().toLowerCase());
    const profiles = (_discoveryRouterProfiles || []).filter(p => Number(p?.enabled ?? 1) === 1 || String(p?.id || '') === selected);
    const options = ['<option value="">— sin router —</option>']
      .concat(profiles.map(p => `<option value="${esc(String(p.id))}"${String(p.id) === selected ? ' selected' : ''}>${esc(String(p.name || p.host || ('Perfil #' + p.id)))}</option>`));
    return `<select class="form-select form-select-sm discoverysc-router" ${usesRouter ? '' : 'disabled'}>${options.join('')}</select>`;
  }

  function _discoveryScannerRow(sc = {}) {
    const id = sc?.id ?? '';
    const method = String(sc?.method || 'nmap');
    const enabled = !!Number(sc?.enabled ?? 1);
    const state = enabled
      ? '<span class="badge bg-success-subtle text-success-emphasis">activo</span>'
      : '<span class="badge bg-secondary-subtle text-secondary-emphasis">inactivo</span>';
    return `<tr data-discovery-scanner-id="${esc(String(id))}">
      <td><input class="form-control form-control-sm discoverysc-name" value="${esc(String(sc?.name || ''))}" placeholder="${esc(window.t?.('cfg.discovery.scanner_name_placeholder', 'Nombre del escáner') || 'Nombre del escáner')}"></td>
      <td>${_renderDiscoveryIfaceOptions(sc?.interface || '')}</td>
      <td>
        <select class="form-select form-select-sm discoverysc-method" style="min-width:140px">
          <option value="router"${method === 'router' ? ' selected' : ''}>router</option>
          <option value="nmap"${method === 'nmap' ? ' selected' : ''}>nmap</option>
          <option value="router+nmap"${method === 'router+nmap' ? ' selected' : ''}>router+nmap</option>
        </select>
      </td>
      <td>${_renderDiscoveryRouterOptions(sc?.router_profile_id, method)}</td>
      <td>
        <textarea class="form-control form-control-sm mono discoverysc-networks" rows="3" placeholder="192.168.1.0/24 | Principal&#10;192.168.18.0/24 | Red Tecnocolor">${esc(_serializeDiscoveryNetworksEditor(sc?.networks || []))}</textarea>
        <div class="small text-muted mt-1" style="font-size:.68rem">Una red por línea · <span class="mono">CIDR | etiqueta</span></div>
      </td>
      <td>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${state}
          <div class="form-check form-switch m-0">
            <input class="form-check-input discoverysc-enabled" type="checkbox" ${enabled ? 'checked' : ''} title="${esc(window.t?.('common.enabled_disabled', 'Activo/inactivo') || 'Activo/inactivo')}">
          </div>
        </div>
      </td>
      <td class="text-end">
        <div class="d-flex justify-content-end gap-1 flex-wrap">
          <button type="button" class="btn btn-outline-success btn-sm py-0 px-2 discoverysc-save" title="${esc(window.t?.('cfg.discovery.save_scanner', 'Guardar escáner') || 'Guardar escáner')}">
            <i class="bi bi-save2"></i>
          </button>
          <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2 discoverysc-delete" title="${esc(window.t?.('cfg.discovery.delete_scanner', 'Eliminar escáner') || 'Eliminar escáner')}">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }

  async function loadDiscoveryScannersPreview() {
    const $body = $('#cfgDiscoveryScannersPreviewBody');
    const $badge = $('#cfgDiscoverySourceBadge');
    const $msg = $('#cfgDiscoveryScannersMsg');
    if (!$body.length) return;
    $body.html('<tr><td colspan="7" class="text-center text-muted py-3">Cargando…</td></tr>');
    try {
      await _loadDiscoveryEditorDependencies(false);
      const data = await fetch('/api/discovery/scanners', { cache:'no-store' }).then(async r => {
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
        return j;
      });
      const source = String(data.source || 'legacy');
      const scanners = Array.isArray(data.scanners) ? data.scanners : [];
      _discoveryRouterProfiles = Array.isArray(data.router_profiles) ? data.router_profiles : _discoveryRouterProfiles;
      $badge.text(source === 'schema' ? 'schema' : (source || 'legacy'))
        .removeClass('bg-secondary bg-success bg-warning text-dark bg-danger')
        .addClass(source === 'schema' ? 'bg-success' : 'bg-secondary');
      if ($msg.length) {
        $msg.text(source === 'schema'
          ? 'Editor activo sobre el schema canónico. Los cambios guardados ya afectan al modelo nuevo.'
          : 'La fuente efectiva no está en schema; usa este editor con precaución.').removeClass('text-danger').addClass(source === 'schema' ? 'text-info' : 'text-warning');
      }
      if (!scanners.length) {
        $body.html('<tr><td colspan="7" class="text-center text-muted py-3">Sin escáneres disponibles</td></tr>');
        return;
      }
      $body.html(scanners.map(sc => _discoveryScannerRow(sc)).join(''));
    } catch (e) {
      $body.html(`<tr><td colspan="7" class="text-center text-danger py-3">${esc(e.message || 'Error cargando escáneres')}</td></tr>`);
      $badge.text('error').removeClass('bg-secondary bg-success bg-warning text-dark').addClass('bg-danger');
      if ($msg.length) $msg.text(e.message || 'Error cargando escáneres').removeClass('text-info text-muted').addClass('text-danger');
    }
  }

  $(document).off('click', '#cfgDiscoveryScannerAdd').on('click', '#cfgDiscoveryScannerAdd', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    await _loadDiscoveryEditorDependencies(true);
    const $body = $('#cfgDiscoveryScannersPreviewBody');
    if (!$body.length) return;
    if ($body.find('tr[data-discovery-scanner-id=""]').length) return;
    $body.prepend(_discoveryScannerRow({ id: '', enabled: 1, method: 'nmap', networks: [] }));
  });

  $(document).off('change', '.discoverysc-method').on('change', '.discoverysc-method', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    await _loadDiscoveryEditorDependencies(false);
    const $tr = $(this).closest('tr');
    const method = $(this).val() || 'nmap';
    const current = $tr.find('.discoverysc-router').val() || '';
    $tr.find('td').eq(3).html(_renderDiscoveryRouterOptions(current, method));
  });

  async function _saveDiscoveryScannerRow($tr, $btn = null) {
    if (!$tr?.length) return;
    if ($btn) $btn.prop('disabled', true);
    const id = String($tr.data('discovery-scanner-id') ?? '').trim();
    const method = ($tr.find('.discoverysc-method').val() || 'nmap').trim();
    const payload = {
      name: ($tr.find('.discoverysc-name').val() || '').trim(),
      interface: ($tr.find('.discoverysc-interface').val() || '').trim(),
      method,
      router_profile_id: ['router', 'router+nmap'].includes(method) ? (($tr.find('.discoverysc-router').val() || '').trim() || null) : null,
      enabled: $tr.find('.discoverysc-enabled').is(':checked') ? 1 : 0,
      networks: _parseDiscoveryNetworksEditor($tr.find('.discoverysc-networks').val() || ''),
    };
    try {
      const url = id ? `/api/discovery/scanners/${id}` : '/api/discovery/scanners';
      const methodHttp = id ? 'PUT' : 'POST';
      const data = await fetch(url, {
        method: methodHttp,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async r => {
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
        return j;
      });
      $('#cfgDiscoveryScannersMsg').text(id ? '✓ Escáner actualizado' : '✓ Escáner creado').removeClass('text-danger text-muted text-warning').addClass('text-success');
      await loadDiscoveryScannersPreview();
      if (typeof cfgLoadModernSettings === 'function') await cfgLoadModernSettings();
      if (typeof loadNetworksModern === 'function') await loadNetworksModern();
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
      return data;
    } catch (e) {
      $('#cfgDiscoveryScannersMsg').text('✗ ' + (e.message || 'Error guardando escáner')).removeClass('text-success text-muted text-warning').addClass('text-danger');
      throw e;
    } finally {
      if ($btn) $btn.prop('disabled', false);
    }
  }

  $(document).off('click', '.discoverysc-save').on('click', '.discoverysc-save', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    await _saveDiscoveryScannerRow($(this).closest('tr'), $(this)).catch(() => {});
  });

  $(document).off('click', '.discoverysc-delete').on('click', '.discoverysc-delete', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $tr = $(this).closest('tr');
    const id = String($tr.data('discovery-scanner-id') ?? '').trim();
    if (!id) { $tr.remove(); return; }
    if (!(await window.appConfirm('¿Eliminar este escáner de discovery?', {
      title: 'Eliminar escáner de discovery',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch(`/api/discovery/scanners/${id}`, { method: 'DELETE' }).then(async r => {
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
        return j;
      });
      $('#cfgDiscoveryScannersMsg').text('✓ Escáner eliminado').removeClass('text-danger text-muted text-warning').addClass('text-success');
      await loadDiscoveryScannersPreview();
      if (typeof cfgLoadModernSettings === 'function') await cfgLoadModernSettings();
      if (typeof loadNetworksModern === 'function') await loadNetworksModern();
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
      return data;
    } catch (e) {
      $('#cfgDiscoveryScannersMsg').text('✗ ' + (e.message || 'Error eliminando escáner')).removeClass('text-success text-muted text-warning').addClass('text-danger');
    } finally {
      $btn.prop('disabled', false);
    }
  });

  function _routerProfileRow(p = {}) {
    const id = p?.id ?? '';
    const enabled = !!Number(p?.enabled ?? 1);
    const activeLegacy = !!p?.active_legacy;
    const state = enabled
      ? '<span class="badge bg-success-subtle text-success-emphasis">activo</span>'
      : '<span class="badge bg-secondary-subtle text-secondary-emphasis">inactivo</span>';
    const active = activeLegacy
      ? '<span class="badge bg-info-subtle text-info-emphasis ms-1">en uso</span>'
      : '';
    return `<tr data-router-profile-id="${esc(String(id))}">
      <td><input class="form-control form-control-sm routerprof-name" value="${esc(String(p?.name || ''))}" placeholder="${esc(window.t?.('cfg.router_profile.name_placeholder', 'Nombre del perfil') || 'Nombre del perfil')}"></td>
      <td><input class="form-control form-control-sm mono routerprof-host" value="${esc(String(p?.host || ''))}" placeholder="192.168.1.1"></td>
      <td><input class="form-control form-control-sm mono routerprof-port" type="number" min="1" max="65535" style="max-width:100px" value="${esc(String(p?.port || 22))}"></td>
      <td><input class="form-control form-control-sm routerprof-user" value="${esc(String(p?.user || ''))}" placeholder="${esc(window.t?.('cfg.router_profile.user_placeholder', 'usuario') || 'usuario')}"></td>
      <td><input class="form-control form-control-sm mono routerprof-key" value="${esc(String(p?.key_path || ''))}" placeholder="/app/router_key"></td>
      <td>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${state}${active}
          <div class="form-check form-switch m-0">
            <input class="form-check-input routerprof-enabled" type="checkbox" ${enabled ? 'checked' : ''} title="${esc(window.t?.('common.enabled_disabled', 'Activo/inactivo') || 'Activo/inactivo')}">
          </div>
        </div>
      </td>
      <td class="text-end">
        <div class="d-flex justify-content-end gap-1 flex-wrap">
          <button type="button" class="btn btn-outline-info btn-sm py-0 px-2 routerprof-activate" ${id ? '' : 'disabled'} title="${esc(window.t?.('cfg.router_profile.active_runtime', 'Dejar este perfil como runtime activo') || 'Dejar este perfil como runtime activo')}">
            <i class="bi bi-check2-circle"></i> Usar
          </button>
          <button type="button" class="btn btn-outline-primary btn-sm py-0 px-2 routerprof-test" ${id ? '' : 'disabled'} title="${esc(window.t?.('cfg.router_profile.test_title', 'Probar conexión con este perfil sin cambiar el runtime final') || 'Probar conexión con este perfil sin cambiar el runtime final')}">
            <i class="bi bi-plug"></i> Probar
          </button>
          <button type="button" class="btn btn-outline-success btn-sm py-0 px-2 routerprof-scan" ${id ? '' : 'disabled'} title="${esc(window.t?.('cfg.router_profile.scan_title', 'Lanzar scan con este perfil sin cambiar el runtime final') || 'Lanzar scan con este perfil sin cambiar el runtime final')}">
            <i class="bi bi-arrow-repeat"></i> Scan
          </button>
          <button type="button" class="btn btn-outline-success btn-sm py-0 px-2 routerprof-save" title="${esc(window.t?.('cfg.router_profile.save', 'Guardar perfil') || 'Guardar perfil')}">
            <i class="bi bi-save2"></i>
          </button>
          <button type="button" class="btn btn-outline-danger btn-sm py-0 px-2 routerprof-delete" title="${esc(window.t?.('cfg.router_profile.delete', 'Eliminar perfil') || 'Eliminar perfil')}">
            <i class="bi bi-trash3"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }

  function _renderRouterTestHostsTable(hosts) {
    const items = Array.isArray(hosts) ? hosts : [];
    if (!items.length) return '<div class="small-muted">Sin hosts detectados.</div>';
    return `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
      <thead><tr><th>IP</th><th>MAC</th><th>Nombre</th><th>Asignación</th></tr></thead>
      <tbody>${items.map(h => `<tr>
        <td class="mono">${esc(h.ip || '—')}</td>
        <td class="mono">${esc(h.mac || '—')}</td>
        <td>${esc(h.router_hostname || '')}</td>
        <td>${esc((h.ip_assignment || '').toUpperCase())}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  async function loadRouterProfilesPreview() {
    const $body = $('#cfgRouterProfilesPreviewBody');
    const $badge = $('#cfgRouterProfilesSourceBadge');
    const $msg = $('#cfgRouterProfilesMsg');
    if (!$body.length) return;
    $body.html('<tr><td colspan="7" class="text-center text-muted py-3">Cargando…</td></tr>');
    try {
      const data = await fetch('/api/router/profiles', { cache:'no-store' }).then(r => r.json());
      const profiles = Array.isArray(data.profiles) ? data.profiles : [];
      const source = String(data.source || 'none');
      $badge.text(source || 'none')
        .removeClass('bg-secondary bg-success bg-warning text-dark')
        .addClass(source === 'schema' ? 'bg-success' : (source === 'legacy' ? 'bg-warning text-dark' : 'bg-secondary'));
      const activeProfile = profiles.find(p => !!p.active_legacy) || null;
      const $summary = $('#cfgRouterRuntimeSummary');
      if ($summary.length) {
        $summary.text(activeProfile ? `Perfil activo para runtime: ${activeProfile.name}` : 'Sin perfil activo de runtime.').removeClass('text-muted').addClass('text-info');
      }
      if ($msg.length) {
        if (activeProfile) {
          $msg.text(`Perfil activo actual: ${activeProfile.name}`).removeClass('text-danger text-warning').addClass('text-info');
        } else {
          $msg.text('Ningún perfil coincide exactamente con la configuración legacy actual.').removeClass('text-danger text-warning').addClass('text-muted');
        }
      }
      if (!profiles.length) {
        $body.html('<tr><td colspan="7" class="text-center text-muted py-3">Sin perfiles de router</td></tr>');
        return;
      }
      $body.html(profiles.map(p => _routerProfileRow(p)).join(''));
    } catch (e) {
      $body.html(`<tr><td colspan="7" class="text-center text-danger py-3">${esc(e.message || 'Error cargando perfiles')}</td></tr>`);
      $badge.text('error').removeClass('bg-secondary bg-success bg-warning text-dark').addClass('bg-danger');
      if ($msg.length) $msg.text(e.message || 'Error cargando perfiles').removeClass('text-muted text-info').addClass('text-danger');
    }
  }

  $(document).off('click', '#cfgRouterProfileAdd').on('click', '#cfgRouterProfileAdd', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $body = $('#cfgRouterProfilesPreviewBody');
    if (!$body.length) return;
    if ($body.find('tr[data-router-profile-id=""]').length) return;
    $body.prepend(_routerProfileRow({ id: '', enabled: 1, port: 22 }));
  });

  async function _saveRouterProfileRow($tr, $btn = null) {
    if (!$tr?.length) return;
    if ($btn) $btn.prop('disabled', true);
    const id = String($tr.data('router-profile-id') ?? '').trim();
    const payload = {
      name: ($tr.find('.routerprof-name').val() || '').trim(),
      host: ($tr.find('.routerprof-host').val() || '').trim(),
      port: parseInt($tr.find('.routerprof-port').val() || 22, 10),
      user: ($tr.find('.routerprof-user').val() || '').trim(),
      key_path: ($tr.find('.routerprof-key').val() || '').trim(),
      enabled: $tr.find('.routerprof-enabled').is(':checked') ? 1 : 0,
    };
    try {
      const url = id ? `/api/router/profiles/${id}` : '/api/router/profiles';
      const method = id ? 'PUT' : 'POST';
      const data = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async r => {
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
        return j;
      });
      $('#cfgRouterProfilesMsg').text(id ? '✓ Perfil actualizado' : '✓ Perfil creado').removeClass('text-danger text-muted').addClass('text-success');
      await loadRouterProfilesPreview();
      await loadDiscoveryScannersPreview();
      return data;
    } catch (e) {
      $('#cfgRouterProfilesMsg').text('✗ ' + (e.message || 'Error guardando perfil')).removeClass('text-success text-muted').addClass('text-danger');
      throw e;
    } finally {
      if ($btn) $btn.prop('disabled', false);
    }
  }

  $(document).off('click', '.routerprof-save').on('click', '.routerprof-save', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    await _saveRouterProfileRow($(this).closest('tr'), $(this)).catch(() => {});
  });

  $(document).off('click', '.routerprof-delete').on('click', '.routerprof-delete', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $tr = $(this).closest('tr');
    const id = String($tr.data('router-profile-id') ?? '').trim();
    if (!id) { $tr.remove(); return; }
    if (!(await window.appConfirm('¿Eliminar este perfil de router?', {
      title: 'Eliminar perfil de router',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const data = await fetch(`/api/router/profiles/${id}`, { method: 'DELETE' }).then(async r => {
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
        return j;
      });
      $('#cfgRouterProfilesMsg').text('✓ Perfil eliminado').removeClass('text-danger text-muted').addClass('text-success');
      await loadRouterProfilesPreview();
      await loadDiscoveryScannersPreview();
      return data;
    } catch (e) {
      $('#cfgRouterProfilesMsg').text('✗ ' + (e.message || 'Error eliminando perfil')).removeClass('text-success text-muted').addClass('text-danger');
    } finally {
      $btn.prop('disabled', false);
    }
  });

    async function _routerProfilesState() {
    const data = await fetch('/api/router/profiles', { cache: 'no-store' }).then(async r => {
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
      return j;
    });
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    return {
      data,
      profiles,
      active: profiles.find(p => !!p.active_legacy) || null,
    };
  }

  async function _activateRouterProfile(profileId, { silent = false } = {}) {
    const data = await fetch(`/api/router/profiles/${profileId}/activate-legacy`, { method: 'POST' }).then(async r => {
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
      return j;
    });
    const c = data.legacy_config || {};
    $('#cfgRouterEnabled').prop('checked', true);
    $('#cfgRouterHost').val(c.host || '');
    $('#cfgRouterPort').val(c.port || 22);
    $('#cfgRouterUser').val(c.user || '');
    $('#cfgRouterKey').val(c.key_path || '');
    if (!silent) {
      $('#cfgRouterProfilesMsg').text('✓ Perfil aplicado al runtime').removeClass('text-danger text-muted text-warning').addClass('text-success');
    }
    await loadRouterProfilesPreview();
    await window.loadDiscoveryScannersPreview?.();
    return data;
  }

  async function _withTemporaryRouterProfile(profileId, runner) {
    const state = await _routerProfilesState();
    const prevId = state.active?.id ? String(state.active.id) : null;
    const targetId = String(profileId);
    let switched = false;
    try {
      if (prevId !== targetId) {
        await _activateRouterProfile(targetId, { silent: true });
        switched = true;
      }
      return await runner();
    } finally {
      if (switched && prevId) {
        try { await _activateRouterProfile(prevId, { silent: true }); } catch (_) {}
      }
    }
  }

$(document).off('click', '.routerprof-activate').on('click', '.routerprof-activate', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $tr = $(this).closest('tr');
    const id = String($tr.data('router-profile-id') ?? '').trim();
    if (!id) return;
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      await _activateRouterProfile(id, { silent: false });
      $('#cfgRouterTestDetail').hide();
    } catch (e) {
      $('#cfgRouterProfilesMsg').text('✗ ' + (e.message || 'Error activando perfil')).removeClass('text-success text-muted text-warning').addClass('text-danger');
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '.routerprof-test').on('click', '.routerprof-test', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $tr = $(this).closest('tr');
    const id = String($tr.data('router-profile-id') ?? '').trim();
    if (!id) return;
    const $btn = $(this);
    const $msg = $('#cfgRouterProfilesMsg');
    $btn.prop('disabled', true);
    $msg.text('Probando conexión con el perfil…').removeClass('text-success text-danger text-info text-muted').addClass('text-warning');
    try {
      const data = await _withTemporaryRouterProfile(id, async () => {
        return await fetch('/api/router/test', { method: 'POST' }).then(async r => {
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
          return j;
        });
      });
      $msg.text(`✓ Conectado · ${data.hosts_found || 0} hosts`).removeClass('text-warning text-danger text-info text-muted').addClass('text-success');
      $('#cfgRouterTestTable').html(_renderRouterTestHostsTable(data.hosts || []));
      $('#cfgRouterTestDetail').show();
      await loadRouterProfilesPreview();
    } catch (e) {
      $msg.text('✗ ' + (e.message || 'Error probando perfil')).removeClass('text-warning text-success text-info text-muted').addClass('text-danger');
      $('#cfgRouterTestDetail').hide();
    } finally {
      $btn.prop('disabled', false);
    }
  });

  $(document).off('click', '.routerprof-scan').on('click', '.routerprof-scan', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $tr = $(this).closest('tr');
    const id = String($tr.data('router-profile-id') ?? '').trim();
    if (!id) return;
    const $btn = $(this);
    const $msg = $('#cfgRouterProfilesMsg');
    $btn.prop('disabled', true);
    $msg.text('Lanzando scan con el perfil…').removeClass('text-success text-danger text-info text-muted').addClass('text-warning');
    try {
      const data = await _withTemporaryRouterProfile(id, async () => {
        return await fetch('/api/router/scan', { method: 'POST' }).then(async r => {
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error || 'Error');
          return j;
        });
      });
      $msg.text(`✓ Scan completado · ${data.hosts_found || 0} hosts`).removeClass('text-warning text-danger text-info text-muted').addClass('text-success');
      $('#cfgRouterTestDetail').hide();
      await loadRouterProfilesPreview();
      if (typeof _queueTopbarRangesRefresh === 'function') _queueTopbarRangesRefresh(50);
    } catch (e) {
      $msg.text('✗ ' + (e.message || 'Error lanzando scan')).removeClass('text-warning text-success text-info text-muted').addClass('text-danger');
    } finally {
      $btn.prop('disabled', false);
    }
  });

  window.loadDiscoveryScannersPreview = loadDiscoveryScannersPreview;
  window.loadRouterProfilesPreview = loadRouterProfilesPreview;

  document.getElementById('configModal')?.addEventListener('shown.bs.modal', function () {
    cfgLoadModernSettings();
    loadAiReportsModern();
    loadNetworksModern();
    window.loadDiscoveryScannersPreview?.();
    window.loadRouterProfilesPreview?.();
  });
})();

// === Schema UI cleanup (minimal and clean) ===
(function () {
  function _cfgSchemaUiSource() {
    return String($('#cfgDiscoverySourceBadge').text() || $('#cfgRouterProfilesSourceBadge').text() || '').trim().toLowerCase();
  }

  function _cfgClosestSection(id) {
    const el = document.getElementById(id);
    return el ? el.closest('.cfg-section') : null;
  }

  function _cfgToggleSection(id, show) {
    const sec = _cfgClosestSection(id);
    if (sec) sec.style.display = show ? '' : 'none';
  }

  function _cfgApplySchemaUiCleanup() {
    const isSchema = _cfgSchemaUiSource() === 'schema';

    const $scannerNav = $('.cfg-nav-btn[data-section="scanner"] span');
    const $routerNavBtn = $('.cfg-nav-btn[data-section="router"]');
    const $networksNavBtn = $('.cfg-nav-btn[data-section="networks"]');
    const $routerNavItem = $routerNavBtn.closest('.nav-item');
    const $networksNavItem = $networksNavBtn.closest('.nav-item');

    const $routerPanel = $('.cfg-panel[data-panel="router"], .cfg-panel-inline[data-panel="router"]');
    const $cfgPanels = $('#cfgPanels');
    const $mount = $('#cfgRouterInlineMount');
    const $networksPanel = $('.cfg-panel[data-panel="networks"]');

    if ($scannerNav.length) $scannerNav.text('Redes');
    if ($routerNavBtn.length) $routerNavBtn.find('span').text('Perfiles de router');
    $('#scanPrimaryRouterDisabled').html('<i class="bi bi-exclamation-triangle text-warning me-1"></i>Perfiles de router no configurados — solo disponible nmap. Configúralos en <strong>Perfiles de router</strong>.');
    $('#cfgSecondarySource option[value="router"]').text('Router complementario');

    if (isSchema) {
      $('#cfgLegacyRangesRow').hide();
      $('#cfgDetectionMotorSection').hide();
      $('#scannerSecNetsRow').hide();
      _cfgToggleSection('cfgPrimaryNetLabel', false);
      _cfgToggleSection('cfgNetLabel', false);
      _cfgToggleSection('cfgNetTbody', false);
      _cfgToggleSection('cfgNetHelpRoute', false);

      $networksNavItem.hide();
      $networksPanel.hide();
      $routerNavItem.hide();

      if ($mount.length && $routerPanel.length) {
        $mount.show();
        if ($routerPanel.hasClass('cfg-panel')) {
          $routerPanel.removeClass('cfg-panel').addClass('cfg-panel-inline');
        }
        $routerPanel.appendTo($mount).show();
      }
    } else {
      $('#cfgLegacyRangesRow').show();
      $('#cfgDetectionMotorSection').show();
      $('#scannerSecNetsRow').show();
      _cfgToggleSection('cfgPrimaryNetLabel', true);
      _cfgToggleSection('cfgNetLabel', true);
      _cfgToggleSection('cfgNetTbody', true);
      _cfgToggleSection('cfgNetHelpRoute', true);

      $networksNavItem.show();
      $networksPanel.show();
      $routerNavItem.show();

      if ($cfgPanels.length && $routerPanel.length && $routerPanel.parent().attr('id') === 'cfgRouterInlineMount') {
        $mount.hide();
        if ($routerPanel.hasClass('cfg-panel-inline')) {
          $routerPanel.removeClass('cfg-panel-inline').addClass('cfg-panel');
        }
        $routerPanel.appendTo($cfgPanels).hide();
      }
    }
  }

  function _cfgScheduleSchemaUiCleanup() {
    setTimeout(_cfgApplySchemaUiCleanup, 0);
    setTimeout(_cfgApplySchemaUiCleanup, 150);
    setTimeout(_cfgApplySchemaUiCleanup, 500);
  }

  const _origLoadDiscoveryScannersPreview = loadDiscoveryScannersPreview;
  loadDiscoveryScannersPreview = async function () {
    const out = await _origLoadDiscoveryScannersPreview.apply(this, arguments);
    _cfgScheduleSchemaUiCleanup();
    return out;
  };
  window.loadDiscoveryScannersPreview = loadDiscoveryScannersPreview;

  const _origLoadRouterProfilesPreview = loadRouterProfilesPreview;
  loadRouterProfilesPreview = async function () {
    const out = await _origLoadRouterProfilesPreview.apply(this, arguments);
    _cfgScheduleSchemaUiCleanup();
    return out;
  };
  window.loadRouterProfilesPreview = loadRouterProfilesPreview;

  const _origLoadNetworksModern = loadNetworksModern;
  loadNetworksModern = async function () {
    const out = await _origLoadNetworksModern.apply(this, arguments);
    _cfgScheduleSchemaUiCleanup();
    return out;
  };

  document.getElementById('configModal')?.addEventListener('shown.bs.modal', _cfgScheduleSchemaUiCleanup);
  $(document).on('click.cfgSchemaUiCleanupMinimal', '.cfg-nav-btn', _cfgScheduleSchemaUiCleanup);

  function _syncTopbarNetworkScanVisibility() {
    const wrap = document.getElementById('scanMetaWrap');
    if (!wrap) return;
    const hostsBtn = document.getElementById('tab-hosts');
    const hostsPane = document.getElementById('hostsView');
    const isHosts = !!((hostsBtn && hostsBtn.classList.contains('active')) || (hostsPane && hostsPane.classList.contains('show') && hostsPane.classList.contains('active')));
    wrap.style.display = isHosts ? '' : 'none';
  }
  window._syncTopbarNetworkScanVisibility = _syncTopbarNetworkScanVisibility;

  document.querySelectorAll('#viewTabs [data-bs-toggle="pill"]').forEach(btn => {
    btn.addEventListener('shown.bs.tab', () => { _syncTopbarNetworkScanVisibility(); _refreshTopbarNextNetworkScan(_cfgData || APP_CONFIG || {}); });
  });
  _refreshTopbarRangesFromState();
  _syncTopbarNetworkScanVisibility();
  _refreshTopbarNextNetworkScan(_cfgData || APP_CONFIG || {});

})();



});
