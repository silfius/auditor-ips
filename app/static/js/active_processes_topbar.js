/*
 * active_processes_topbar.js — Auditor IPs
 * Topbar global de procesos activos: Automatizaciones + Syncthing.
 */
(function () {
  'use strict';

  const state = {
    items: [],
    index: 0,
    rotateTimer: null,
    refreshTimer: null,
    refreshMs: 20000,
    rotateMs: 4500,
  };

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function tr(key, fallback) {
    try {
      return window.t ? window.t(key, fallback) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function fmtBytes(bytes) {
    const n = Math.max(0, Number(bytes || 0));
    if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${Math.round(n)} B`;
  }

  function fmtRate(bytesPerSecond) {
    return `${fmtBytes(bytesPerSecond)}/s`;
  }

  function scriptLabel(s) {
    return String(s?.cfg_label || s?.label || s?.name || tr('topbar.process.script', 'Automatización'));
  }

  function scriptSub(s) {
    const pct = Number(s?.progress_pct ?? s?.progress?.pct ?? s?.progress?.percent);
    const step = String(s?.step_label || s?.step || s?.current_step || '').trim();
    if (Number.isFinite(pct) && pct >= 0) {
      return step ? `${Math.round(pct)}% · ${step}` : `${Math.round(pct)}%`;
    }
    if (step) return step;
    return tr('topbar.process.running', 'En ejecución');
  }

  function buildScriptItems(scripts) {
    return (scripts || [])
      .filter(s => ['running', 'started'].includes(String(s?.state || s?.status || '').toLowerCase()))
      .slice(0, 6)
      .map(s => ({
        kind: 'scripts',
        icon: 'bi-cpu',
        title: scriptLabel(s),
        sub: scriptSub(s),
        target: 'scripts',
      }));
  }

  function buildSyncthingItems(data) {
    const summary = data?.summary || {};
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const folders = Array.isArray(data?.folders) ? data.folders : [];

    const items = [];

    const transferringNodes = nodes
      .filter(n => !!n?.isTransferring)
      .sort((a, b) => Number(b.totalBytesPerSecond || 0) - Number(a.totalBytesPerSecond || 0));

    if (transferringNodes.length) {
      const top = transferringNodes[0];
      const rate = Number(summary.rxBytesPerSecond || 0) + Number(summary.txBytesPerSecond || 0);
      items.push({
        kind: 'syncthing',
        icon: 'bi-arrow-left-right',
        title: transferringNodes.length === 1
          ? `Syncthing · ${top.name || top.node_name || 'Nodo'}`
          : `Syncthing · ${transferringNodes.length} nodos transfiriendo`,
        sub: `${tr('topbar.process.transfer', 'Transferencia activa')} · ${fmtRate(rate || top.totalBytesPerSecond || 0)}`,
        target: 'syncthing',
      });
    }

    const syncingFolders = folders.filter(f => String(f?.status || '').toLowerCase() === 'syncing');
    const nodesSyncing = Number(summary.nodes_syncing || 0);
    const needBytes = Number(summary.needBytes || 0);

    if (nodesSyncing > 0 || syncingFolders.length > 0 || needBytes > 0) {
      items.push({
        kind: 'syncthing',
        icon: 'bi-arrow-repeat',
        title: `Syncthing · ${nodesSyncing || syncingFolders.length} sincronizando`,
        sub: `${syncingFolders.length} carpetas · pendiente ${fmtBytes(needBytes)}`,
        target: 'syncthing',
      });
    }

    return items.slice(0, 4);
  }

  async function fetchJson(url) {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function openTarget(target) {
    try {
      const infraTab = document.getElementById('infra-tab');
      infraTab?.click();

      setTimeout(() => {
        if (target === 'scripts') {
          document.getElementById('infra-scripts-tab')?.click();
          return;
        }
        if (target === 'syncthing') {
          document.getElementById('infra-syncthing-tab')?.click();
        }
      }, 80);
    } catch (e) {
      console.warn('[active processes topbar open]', e.message);
    }
  }

  function renderCurrent() {
    const root = document.getElementById('activeProcessesTopbar');
    const title = document.getElementById('activeProcessesTitle');
    const sub = document.getElementById('activeProcessesSub');
    const count = document.getElementById('activeProcessesCount');
    const icon = root?.querySelector('.active-processes-icon i');

    if (!root || !title || !sub || !count) return;

    if (!state.items.length) {
      root.classList.remove('has-items');
      root.dataset.target = '';
      return;
    }

    if (state.index >= state.items.length) state.index = 0;
    const item = state.items[state.index];

    root.classList.add('has-items');
    root.dataset.target = item.target || '';
    title.textContent = item.title || tr('topbar.process.active', 'Proceso activo');
    sub.textContent = item.sub || '';
    count.textContent = state.items.length === 1 ? '1' : `${state.index + 1}/${state.items.length}`;
    if (icon) icon.className = `bi ${item.icon || 'bi-activity'}`;
  }

  function restartRotation() {
    if (state.rotateTimer) clearInterval(state.rotateTimer);
    state.rotateTimer = null;

    if (state.items.length > 1) {
      state.rotateTimer = setInterval(() => {
        state.index = (state.index + 1) % state.items.length;
        renderCurrent();
      }, state.rotateMs);
    }
  }

  async function refresh() {
    const items = [];

    try {
      const scripts = await fetchJson('/api/scripts/status');
      items.push(...buildScriptItems(Array.isArray(scripts) ? scripts : (scripts.scripts || scripts.statuses || [])));
    } catch (e) {
      console.warn('[active processes topbar scripts]', e.message);
    }

    try {
      const st = await fetchJson('/api/syncthing/overview');
      items.push(...buildSyncthingItems(st));
    } catch (e) {
      console.warn('[active processes topbar syncthing]', e.message);
    }

    const signature = JSON.stringify(items.map(i => [i.kind, i.title, i.sub, i.target]));
    const previous = JSON.stringify(state.items.map(i => [i.kind, i.title, i.sub, i.target]));

    state.items = items;
    if (signature !== previous) {
      state.index = 0;
      restartRotation();
    }
    renderCurrent();
  }

  function bind() {
    const root = document.getElementById('activeProcessesTopbar');
    if (!root) return;

    root.addEventListener('click', () => {
      if (!state.items.length) return;
      const item = state.items[state.index] || {};
      openTarget(item.target);
    });

    root.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      if (!state.items.length) return;
      const item = state.items[state.index] || {};
      openTarget(item.target);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    refresh();
    state.refreshTimer = setInterval(refresh, state.refreshMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  });
})();
