// ════════════════════════════════════════════════════════
//  auth.js — Auditor IPs · Auth + Audit log
//  Sidebar nav, login modal, fetch interceptor,
//  usuarios, sesiones, cambio contraseña, audit log
// ════════════════════════════════════════════════════════

// ── Sidebar / Navigation ──────────────────────────────────
(function() {
  // ── Sidebar navigation — event delegation (S16: funciona con offcanvas) ──
  const SAVE_PANELS = new Set(['scanner','notifications','appearance','router','backup']);

  document.addEventListener('click', function(e) {
    const btn = e.target.closest('.cfg-nav-btn');
    if (!btn) return;
    const section = btn.dataset.section;
    // Toggle active
    document.querySelectorAll('.cfg-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Show/hide panels
    document.querySelectorAll('.cfg-panel').forEach(p => {
      p.style.display = p.dataset.panel === section ? 'block' : 'none';
    });
    // Save bar
    const saveBar = document.getElementById('cfgSaveBar');
    if (saveBar) saveBar.classList.toggle('hidden', !SAVE_PANELS.has(section));
    // Lazy load
    if (section === 'auth')  loadAuthPanel();
    if (section === 'audit') { _auditOffset=0; loadAudit(); }
    if (section === 'backup') { if (typeof loadBackupList === 'function') loadBackupList(); }
    if (section === 'system_health') { if (typeof window.loadConfigSystemHealth === 'function') window.loadConfigSystemHealth(); }
  });

  // ── Logout ──────────────────────────────────────────────
  window.doLogout = async function() {
    await fetch('/api/auth/logout', {method:'POST'});
    window.location.reload();  // stay on page, just drop session
  };

  // ── Show login modal (called by topbar button or on 401) ──
  window.showLoginModal = function(pendingCb) {
    const el = document.getElementById('loginModal');
    if (!el) return;   // auth disabled or already logged in
    window._loginPendingCb = pendingCb || null;
    document.getElementById('loginModalUser').value = '';
    document.getElementById('loginModalPass').value = '';
    document.getElementById('loginModalAlert').classList.add('d-none');
    bootstrap.Modal.getOrCreateInstance(el).show();
    setTimeout(() => document.getElementById('loginModalUser').focus(), 300);
  };

  window.doLoginModal = async function() {
    const user = document.getElementById('loginModalUser').value.trim();
    const pass = document.getElementById('loginModalPass').value;
    const alertEl = document.getElementById('loginModalAlert');
    const btn = document.getElementById('loginModalBtn');
    alertEl.classList.add('d-none');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Entrando…';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({username: user, password: pass})
      });
      const data = await r.json();
      if (data.ok) {
		  bootstrap.Modal.getOrCreateInstance(document.getElementById('loginModal')).hide();
		  try { sessionStorage.setItem('auditor-force-dashboard-once', '1'); } catch (_) {}
		  window.location.reload();  // reload to update Jinja2 is_logged_in context
	  } else {
        alertEl.textContent = data.error || 'Error de autenticación';
        alertEl.classList.remove('d-none');
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-box-arrow-in-right me-1"></i>Entrar';
      }
    } catch(e) {
      alertEl.textContent = window.t?.('auth.network_error', 'Error de red') || 'Error de red';
      alertEl.classList.remove('d-none');
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-box-arrow-in-right me-1"></i>Entrar';
    }
  };

  // Enter key in login modal
  document.getElementById('loginModal')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLoginModal();
  });

  // ── Intercept 401 → show login modal instead of redirecting ──
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const resp = await _origFetch(...args);
    if (resp.status === 401) {
      const clone = resp.clone();
      clone.json().then(data => {
        if (data && data.show_login) {
          showLoginModal();
        }
      }).catch(() => {});
    }
    return resp;
  };

  // ── PWA button in appearance ────────────────────────────
  document.getElementById('pwaOpenModal2')?.addEventListener('click', () => {
    const m = bootstrap.Modal.getOrCreateInstance(document.getElementById('pwaModal'));
    m.show();
  });

  function fmtAuthDate(value) {
    if (!value) return '—';
    if (typeof window.fmtDate === 'function') {
      const formatted = window.fmtDate(value);
      return formatted || '—';
    }
    return '—';
  }

  function fmtAuthDateTime(value) {
    if (!value) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(value);
      return formatted || '—';
    }
    return '—';
  }

  // ── Auth panel ───────────────────────────────────────────
  async function loadAuthPanel() {
    loadUsers();
    loadSessions();
  }

  async function loadUsers() {
    const tbody = document.getElementById('usersTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Cargando…</td></tr>';
    const r = await fetch('/api/auth/users');
    const data = await r.json();
    if (!data.ok) { tbody.innerHTML = '<tr><td colspan="4" class="text-danger text-center">' + (data.error||'Error') + '</td></tr>'; return; }
    if (!data.users.length) { tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Sin usuarios</td></tr>'; return; }
    const meUser = (window.APP_CONFIG && window.APP_CONFIG.current_user) || '';
    tbody.innerHTML = data.users.map(u => {
      const isMe = u.username === meUser;
      const lastLogin = fmtAuthDateTime(u.last_login);
      const created   = fmtAuthDate(u.created_at);
      return `<tr>
        <td><i class="bi bi-person-circle me-1 text-info"></i> <strong>${u.username}</strong> ${isMe ? '<span class="badge bg-success ms-1" style="font-size:.65rem">Tú</span>' : ''}</td>
        <td class="small text-muted">${created}</td>
        <td class="small text-muted">${lastLogin}</td>
        <td class="text-end">
          ${!isMe ? `<button class="btn btn-outline-danger btn-sm" onclick="deleteUser(${u.id},'${u.username}')"><i class="bi bi-trash3"></i></button>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  window.deleteUser = async function(id, name) {
    if (!(await window.appConfirm(`¿Eliminar usuario "${name}"? Se cerrarán todas sus sesiones.`, {
      title: 'Eliminar usuario',
      confirmText: 'Eliminar',
      danger: true
    }))) return;
    const r    = await fetch('/api/auth/users/' + id, {method:'DELETE'});
    const data = await r.json();
    if (data.ok) { showToast(window.t?.('auth.user_deleted', 'Usuario eliminado') || 'Usuario eliminado', 'success'); loadUsers(); }
    else showToast(data.error || 'Error', 'danger');
  };

  document.getElementById('btnCreateUser')?.addEventListener('click', async function() {
    const username = document.getElementById('newUserName').value.trim();
    const password = document.getElementById('newUserPw').value;
    const msgEl    = document.getElementById('createUserMsg');
    msgEl.textContent = '';
    const r    = await fetch('/api/auth/users', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username, password})});
    const data = await r.json();
    if (data.ok) {
      msgEl.className = 'small text-success';
      msgEl.textContent = window.t?.('auth.user_created', '✓ Usuario "{username}" creado', { username }) || `✓ Usuario "${username}" creado`;
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserPw').value = '';
      loadUsers();
    } else {
      msgEl.className = 'small text-danger';
      msgEl.textContent = data.error || 'Error';
    }
  });

  document.getElementById('btnChangePw')?.addEventListener('click', async function() {
    const cur  = document.getElementById('cpCurrentPw').value;
    const np   = document.getElementById('cpNewPw').value;
    const np2  = document.getElementById('cpNewPw2').value;
    const msg  = document.getElementById('cpMsg');
    msg.textContent = '';
    if (np !== np2) { msg.className='small text-danger'; msg.textContent=window.t?.('auth.password_mismatch', 'Las contraseñas no coinciden') || 'Las contraseñas no coinciden'; return; }
    const r    = await fetch('/api/auth/change-password', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({current_password:cur, new_password:np})});
    const data = await r.json();
    if (data.ok) {
      msg.className='small text-success'; msg.textContent=window.t?.('auth.password_changed', '✓ Contraseña cambiada correctamente') || '✓ Contraseña cambiada correctamente';
      document.getElementById('cpCurrentPw').value = '';
      document.getElementById('cpNewPw').value = '';
      document.getElementById('cpNewPw2').value = '';
    } else {
      msg.className='small text-danger'; msg.textContent=data.error||'Error';
    }
  });

  async function loadSessions() {
    const tbody = document.getElementById('sessionsTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Cargando…</td></tr>';
    try {
      const r = await fetch('/api/auth/sessions');
      const data = await r.json();
      if (!data.ok || !data.sessions.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin sesiones activas</td></tr>';
        return;
      }
      tbody.innerHTML = data.sessions.map(s => {
        const created = fmtAuthDateTime(s.created_at);
        const expires = fmtAuthDateTime(s.expires_at);
        const ua = (s.user_agent || '').substring(0,40);
        return `<tr>
          <td><strong>${s.username}</strong></td>
          <td><code class="small">${s.ip}</code></td>
          <td class="small text-muted">${created}</td>
          <td class="small text-muted">${expires}</td>
          <td><button class="btn btn-outline-danger btn-sm" onclick="killSession('${s.token.substring(0,8)}')"><i class="bi bi-x-lg"></i></button></td>
        </tr>`;
      }).join('');
    } catch(e) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-danger">Error de red</td></tr>';
    }
  }

  window.killSession = async function(prefix) {
    if (!(await window.appConfirm('¿Cerrar esta sesión?', {
      title: 'Cerrar sesión',
      confirmText: 'Cerrar sesión',
      danger: true
    }))) return;
    const r = await fetch('/api/auth/sessions/' + prefix, {method:'DELETE'});
    const d = await r.json();
    if (d.ok) { showToast(window.t?.('auth.session_closed', 'Sesión cerrada') || 'Sesión cerrada', 'success'); loadSessions(); }
  };

  // ── Audit log ────────────────────────────────────────────
  let _auditOffset = 0;
  const _auditLimit = 50;
  let _auditTotal   = 0;
  let _auditIpFilter = '';

  async function loadAudit() {
    const tbody = document.getElementById('auditTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3"><i class="bi bi-hourglass-split"></i> Cargando…</td></tr>';
    try {
      const params = new URLSearchParams({limit: _auditLimit, offset: _auditOffset});
      if (_auditIpFilter) params.set('ip_filter', _auditIpFilter);
      params.set('_ts', String(Date.now()));
      const r    = await fetch('/api/auth/audit?' + params, { cache: 'no-store' });
      const data = await r.json();
      if (!data.ok) { tbody.innerHTML = '<tr><td colspan="5" class="text-danger text-center">' + (data.error||'Error') + '</td></tr>'; return; }
      _auditTotal = data.total;
      if (!data.entries.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin registros</td></tr>'; return; }
      tbody.innerHTML = data.entries.map(e => {
        const badge = e.authed
          ? `<span class="badge bg-success" style="font-size:.7rem">${e.username||'admin'}</span>`
          : `<span class="badge bg-secondary" style="font-size:.7rem">Anónimo</span>`;
        let detail = '';
        if (e.detail && typeof e.detail === 'object') {
          if (e.detail.summary) {
            detail = `<div class="text-muted small">${e.detail.summary}</div>`;
          } else if (e.detail.host) {
            detail = `<span class="text-muted small"> → ${e.detail.host}</span>`;
          }
        }
        const ipMeta = e.ip_origin
          ? `<div class="small" style="color:rgba(255,255,255,.72);line-height:1.15" title="${e.ip_origin}${e.ip_device_type ? ` · ${e.ip_device_type}` : ''}">${e.ip_origin}${e.ip_device_type ? ` · ${e.ip_device_type}` : ''}</div>`
          : '';
        return `<tr>
          <td class="small text-muted">${e.at}</td>
          <td><code class="small">${e.ip}</code>${ipMeta}</td>
          <td>${e.username ? `<code class="small">${e.username}</code>` : '—'}</td>
          <td>${e.action}${detail}</td>
          <td>${badge}</td>
        </tr>`;
      }).join('');
      // Stats
      const adminC = data.entries.filter(e=>e.authed).length;
      const anonC  = data.entries.filter(e=>!e.authed).length;
      const uips   = new Set(data.entries.map(e=>e.ip)).size;
      document.getElementById('auditStatTotal').textContent = _auditTotal;
      document.getElementById('auditStatAdmin').textContent = adminC;
      document.getElementById('auditStatAnon').textContent  = anonC;
      document.getElementById('auditStatIps').textContent   = uips;
      // Pagination
      const page  = Math.floor(_auditOffset / _auditLimit) + 1;
      const pages = Math.max(1, Math.ceil(_auditTotal / _auditLimit));
      document.getElementById('auditPageLabel').textContent = page + ' / ' + pages;
      document.getElementById('auditPrevBtn').disabled = _auditOffset === 0;
      document.getElementById('auditNextBtn').disabled = _auditOffset + _auditLimit >= _auditTotal;
      document.getElementById('auditFooter').textContent = _auditTotal + ' entradas totales';
    } catch(e) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-danger text-center">Error de red</td></tr>';
    }
  }

  let _auditTimer;

  document.addEventListener('click', async (ev) => {
    const refreshBtn = ev.target.closest('#auditRefreshBtn');
    if (refreshBtn) {
      _auditOffset = 0;
      loadAudit();
      return;
    }

    const prevBtn = ev.target.closest('#auditPrevBtn');
    if (prevBtn) {
      _auditOffset = Math.max(0, _auditOffset - _auditLimit);
      loadAudit();
      return;
    }

    const nextBtn = ev.target.closest('#auditNextBtn');
    if (nextBtn) {
      _auditOffset += _auditLimit;
      loadAudit();
      return;
    }

    const exportBtn = ev.target.closest('#auditExportBtn');
    if (exportBtn) {
      const exportLimit = window.getFrontendLimit('export_rows');
      const exportUrl =
        '/api/auth/audit?limit=' + encodeURIComponent(exportLimit) + '&offset=0'
        + (_auditIpFilter ? '&ip_filter=' + encodeURIComponent(_auditIpFilter) : '')
        + '&_ts=' + Date.now();
      const r = await fetch(exportUrl, { cache: 'no-store' });
      const data = await r.json();
      if (!data.ok) return;
      const rows = [['Fecha','IP','Usuario','Accion','Modo']].concat(
        data.entries.map(e => [e.at, e.ip, e.username || '', e.action, e.authed ? (e.username || 'admin') : 'Anónimo'])
      );
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
      a.download = 'audit_log_' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
    }
  });

  document.addEventListener('input', (ev) => {
    const ipFilter = ev.target.closest('#auditIpFilter');
    if (!ipFilter) return;
    clearTimeout(_auditTimer);
    _auditTimer = setTimeout(() => {
      _auditIpFilter = ipFilter.value.trim();
      _auditOffset = 0;
      loadAudit();
    }, 400);
  });

  // Al abrir el offcanvas: asegurar que el panel activo es visible
  document.getElementById('configOffcanvas')?.addEventListener('show.bs.offcanvas', function() {
    // Asegurar que hay siempre un panel activo visible
    const activeBtn = document.querySelector('.cfg-nav-btn.active');
    const activeSection = activeBtn?.dataset.section || 'scanner';
    document.querySelectorAll('.cfg-panel').forEach(p => {
      p.style.display = p.dataset.panel === activeSection ? 'block' : 'none';
    });
    const saveBar = document.getElementById('cfgSaveBar');
    const SAVE_PANELS = new Set(['scanner','notifications','appearance','router','backup']);
    if (saveBar) saveBar.classList.toggle('hidden', !SAVE_PANELS.has(activeSection));
    // Lazy loads
    if (activeSection === 'audit')  { _auditOffset=0; loadAudit(); }
    if (activeSection === 'auth')   loadAuthPanel();
    if (activeSection === 'backup') { if (typeof loadBackupList === 'function') loadBackupList(); }
    if (activeSection === 'system_health') { if (typeof window.loadConfigSystemHealth === 'function') window.loadConfigSystemHealth(); }
  });

  // ── cfgAuthSections save via cfgSave ─────────────────────
  // Patch: add auth_sections to existing cfgSave handler
  const _origCfgSave = window._cfgSavePayloadExtra || null;
  window._cfgAuthSectionsValue = function() {
    return (document.getElementById('cfgAuthSections')?.value || '').trim();
  };

})();

