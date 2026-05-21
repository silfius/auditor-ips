/*
 * syncthing_control.js — Auditor IPs
 * Fase 1: solo lectura sobre Syncthing + CRUD local de nodos.
 */
(function () {
  'use strict';

  const state = {
    loaded: false,
    busy: false,
    overview: { summary: {}, nodes: [], folders: [] },
    fileEvents: { items: [], summary: {}, filters: { nodes: [], folders: [], types: [] } },
    fileEventsQ: '',
    fileEventsHours: 168,
    fileEventsNodeId: '',
    fileEventsFolderId: '',
    fileEventsAction: '',
    fileEventsExpanded: false,
    fileEventsSort: { key: 'event_time', dir: 'desc' },
    transferFlowsExpanded: false,
    syncRefreshTimer: null,
    q: '',
    nodeFilter: 'all',
    folderFilter: 'all',
    nodeSort: { key: 'name', dir: 'asc' },
    folderSort: { key: 'node_name', dir: 'asc' },
    pendingDeleteId: null,
    charts: {
      folder: null,
      node: null,
      dashboard: null,
    },
    dashboardChartHours: 24,
    dashboardChartMode: 'rate',
    nodeChartMode: 'rate',
  };

  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return (s ?? '').toString()
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtBytes(value) {
    const n = Number(value || 0);
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

  function fmtRate(value) {
    return `${fmtBytes(value || 0)}/s`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(iso);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }


  function pctOf(value, max) {
    const v = Number(value || 0);
    const m = Number(max || 0);
    if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((v / m) * 100)));
  }

  function chartLabelTime(iso) {
    if (!iso) return '—';
    if (typeof window.fmtDateTime === 'function') {
      const formatted = window.fmtDateTime(iso);
      return formatted && formatted !== '—' ? formatted : '—';
    }
    return '—';
  }

  function destroyChart(name) {
    const chart = state.charts?.[name];
    if (chart) {
      try { chart.destroy(); } catch (_) {}
      state.charts[name] = null;
    }
  }

  function chartLineDataset(label, data) {
    return {
      label,
      data,
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
      fill: false,
    };
  }

  function renderLineChart(canvasId, chartName, labels, datasets, yTitle, valueFormatter) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    destroyChart(chartName);

    const fmtValue = typeof valueFormatter === 'function' ? valueFormatter : fmtBytes;

    state.charts[chartName] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom' },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${fmtValue(ctx.parsed.y || 0)}`,
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: {
            beginAtZero: true,
            title: { display: !!yTitle, text: yTitle || '' },
            ticks: { callback: value => fmtValue(value) },
          },
        },
      },
    });
  }

  function folderRangeButtons(activeHours) {
    const ranges = [
      [24, '24h'],
      [168, '7d'],
      [720, '30d'],
    ];
    return `
      <div class="btn-group btn-group-sm" role="group" id="st-folder-chart-ranges">
        ${ranges.map(([hours, label]) => `
          <button type="button" class="btn btn-outline-secondary ${Number(activeHours) === hours ? 'active' : ''}" data-hours="${hours}">
            ${label}
          </button>
        `).join('')}
      </div>
    `;
  }

  function nodeRangeButtons(activeHours) {
    const ranges = [
      [24, '24h'],
      [168, '7d'],
      [720, '30d'],
    ];
    return `
      <div class="btn-group btn-group-sm" role="group" id="st-node-chart-ranges">
        ${ranges.map(([hours, label]) => `
          <button type="button" class="btn btn-outline-secondary ${Number(activeHours) === hours ? 'active' : ''}" data-hours="${hours}">
            ${label}
          </button>
        `).join('')}
      </div>
    `;
  }

  function dashboardRangeButtons(activeHours) {
    const ranges = [
      [24, '24h'],
      [168, '7d'],
      [720, '30d'],
    ];
    return `
      <div class="btn-group btn-group-sm" role="group" id="st-dashboard-chart-ranges">
        ${ranges.map(([hours, label]) => `
          <button type="button" class="btn btn-outline-secondary ${Number(activeHours) === hours ? 'active' : ''}" data-hours="${hours}">
            ${label}
          </button>
        `).join('')}
      </div>
    `;
  }

  function chartModeButtons(scope, activeMode) {
    const modes = [
      ['rate', 'Velocidad'],
      ['bytes', 'Datos transferidos'],
    ];
    return `
      <div class="btn-group btn-group-sm" role="group" id="st-${scope}-chart-modes">
        ${modes.map(([mode, label]) => `
          <button type="button" class="btn btn-outline-secondary ${String(activeMode || 'rate') === mode ? 'active' : ''}" data-mode="${mode}">
            ${label}
          </button>
        `).join('')}
      </div>
    `;
  }

  function transferChartMeta(mode) {
    const isBytes = String(mode || 'rate') === 'bytes';
    return {
      mode: isBytes ? 'bytes' : 'rate',
      title: isBytes ? 'Datos transferidos entrada/salida' : 'Velocidad entrada/salida',
      yTitle: isBytes ? 'Bytes' : 'B/s',
      formatter: isBytes ? fmtBytes : fmtRate,
      rxKey: isBytes ? 'rx_delta_bytes' : 'rx_bps',
      txKey: isBytes ? 'tx_delta_bytes' : 'tx_bps',
    };
  }

  function transferNodeName(n) {
    return String(n?.name || n?.node_name || `Nodo ${n?.id || ''}` || 'Nodo');
  }

  function transferTotalRate(n) {
    return Math.max(0, Number(n.rxBytesPerSecond || 0)) + Math.max(0, Number(n.txBytesPerSecond || 0));
  }

  function transferNodePendingBytes(nodeId) {
    return (state.overview.folders || [])
      .filter(f => String(f.node_id) === String(nodeId))
      .reduce((acc, f) => acc + Math.max(0, Number(f.needBytes || 0)), 0);
  }

  function transferAuditorNodeByMyId(remoteDeviceId, localNodeId) {
    const rid = String(remoteDeviceId || '').trim();
    if (!rid) return null;
    return (state.overview.nodes || []).find(n =>
      String(n.myID || '').trim() === rid && String(n.id) !== String(localNodeId || '')
    ) || null;
  }

  function transferRemoteEndpoint(localNode, remote) {
    const matchedNode = transferAuditorNodeByMyId(remote?.remote_device_id, localNode?.id);
    if (matchedNode) {
      return {
        ...matchedNode,
        transferEndpointKind: 'auditor-node',
        transferEndpointSub: 'Nodo Auditor',
      };
    }

    const remoteName = String(remote?.remote_device_name || remote?.remote_device_id || 'Remoto').trim();
    return {
      id: `remote:${remote?.remote_device_id || remoteName}`,
      name: remoteName,
      transferEndpointKind: 'remote-device',
      transferEndpointSub: 'Remoto no monitorizado',
      remote_device_id: remote?.remote_device_id || '',
    };
  }

  function transferEndpointName(endpoint) {
    return String(endpoint?.name || endpoint?.node_name || endpoint?.remote_device_name || `Nodo ${endpoint?.id || ''}` || 'Nodo');
  }

  function transferEndpointSub(endpoint) {
    return String(endpoint?.transferEndpointSub || '');
  }

  function transferEndpointKey(endpoint) {
    if (endpoint?.transferEndpointKind === 'auditor-node' && endpoint?.id) {
      return `node:${endpoint.id}`;
    }
    if (endpoint?.remote_device_id) {
      return `remote:${endpoint.remote_device_id}`;
    }
    if (endpoint?.myID) {
      return `myid:${endpoint.myID}`;
    }
    return `name:${transferEndpointName(endpoint)}`;
  }

  function dedupeTransferPairsByRoute(pairs) {
    const byRoute = new Map();
    pairs.forEach(pair => {
      const key = `${transferEndpointKey(pair.origin)}=>${transferEndpointKey(pair.target)}`;
      const previous = byRoute.get(key);
      if (!previous || Number(pair.rate || 0) > Number(previous.rate || 0)) {
        byRoute.set(key, pair);
      }
    });
    return Array.from(byRoute.values());
  }

  function transferProgressMeta(pair) {
    if (pair.progress) return pair.progress;

    const transferred = Math.max(0, Math.min(
      Number(pair.origin?.txDeltaBytes || 0),
      Number(pair.target?.rxDeltaBytes || 0)
    ));
    const pendingTarget = transferNodePendingBytes(pair.target?.id);
    const pendingTotal = Math.max(0, Number(state.overview?.summary?.needBytes || 0));
    const total = pendingTarget > 0 ? pendingTarget : pendingTotal;
    const pct = total > 0 ? Math.max(1, Math.min(100, Math.round((transferred / total) * 100))) : 0;
    return { transferred, total, pct };
  }

  function buildRemoteTransferPairs(activeNodes) {
    const threshold = Math.max(1, Number(state.overview?.summary?.transferActiveThresholdBps || 1024));
    const pairs = [];

    activeNodes.forEach(localNode => {
      (localNode.remoteTransferDevices || []).forEach(remote => {
        if (!remote || !remote.isTransferring) return;

        const rx = Math.max(0, Number(remote.rxBytesPerSecond || 0));
        const tx = Math.max(0, Number(remote.txBytesPerSecond || 0));
        const remoteEndpoint = transferRemoteEndpoint(localNode, remote);
        const localEndpoint = {
          ...localNode,
          transferEndpointKind: 'auditor-node',
          transferEndpointSub: 'Nodo Auditor',
        };

        if (rx >= threshold) {
          const total = transferNodePendingBytes(localNode.id) || Math.max(0, Number(state.overview?.summary?.needBytes || 0));
          const transferred = Math.max(0, Number(remote.rxDeltaBytes || 0));
          pairs.push({
            origin: remoteEndpoint,
            target: localEndpoint,
            rate: rx,
            directionNote: remoteEndpoint.transferEndpointKind === 'auditor-node'
              ? 'Dirección medida por dispositivo remoto Syncthing monitorizado'
              : 'Dirección medida por dispositivo remoto Syncthing no monitorizado',
            detailNote: `Entrada local desde remoto: ${fmtRate(rx)}`,
            progress: {
              transferred,
              total,
              pct: total > 0 ? Math.max(1, Math.min(100, Math.round((transferred / total) * 100))) : 0,
            },
          });
        }

        if (tx >= threshold) {
          const transferred = Math.max(0, Number(remote.txDeltaBytes || 0));
          const total = Math.max(0, Number(state.overview?.summary?.needBytes || 0));
          pairs.push({
            origin: localEndpoint,
            target: remoteEndpoint,
            rate: tx,
            directionNote: remoteEndpoint.transferEndpointKind === 'auditor-node'
              ? 'Dirección medida por dispositivo remoto Syncthing monitorizado'
              : 'Dirección medida hacia remoto Syncthing no monitorizado',
            detailNote: `Salida local hacia remoto: ${fmtRate(tx)}`,
            progress: {
              transferred,
              total,
              pct: total > 0 ? Math.max(1, Math.min(100, Math.round((transferred / total) * 100))) : 0,
            },
          });
        }
      });
    });

    return dedupeTransferPairsByRoute(pairs)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
  }

  function buildMonitoredTransferPairs(activeNodes) {
    const threshold = Math.max(1, Number(state.overview?.summary?.transferActiveThresholdBps || 1024));
    const candidates = [];

    activeNodes.forEach(origin => {
      activeNodes.forEach(target => {
        if (String(origin.id) === String(target.id)) return;

        const originTx = Math.max(0, Number(origin.txBytesPerSecond || 0));
        const targetRx = Math.max(0, Number(target.rxBytesPerSecond || 0));
        const maxRate = Math.max(originTx, targetRx);
        const matchedRate = Math.min(originTx, targetRx);

        if (matchedRate < threshold || maxRate <= 0) return;

        const ratio = matchedRate / maxRate;
        if (ratio < 0.35) return;

        candidates.push({
          origin,
          target,
          rate: matchedRate,
          originTx,
          targetRx,
          ratio,
        });
      });
    });

    return candidates
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 6);
  }

  function renderTransferPairFlow(pair) {
    const originName = transferEndpointName(pair.origin);
    const targetName = transferEndpointName(pair.target);
    const originSub = transferEndpointSub(pair.origin);
    const targetSub = transferEndpointSub(pair.target);
    const rate = Number(pair.rate || 0);
    const progress = pair.progress || transferProgressMeta(pair);
    const pct = Math.max(0, Math.min(100, Number(progress.pct || 0)));
    const directionNote = pair.directionNote || 'Dirección estimada por movimiento real medido';
    const tone = pair.origin?.transferEndpointKind === 'auditor-node' && pair.target?.transferEndpointKind === 'auditor-node'
      ? 'is-monitored'
      : 'is-remote';

    return `
      <div class="st-transfer-flow-card st-transfer-flow-card-active st-transfer-flow-row ${tone}" style="--transfer-progress:${pct}%">
        <div class="st-transfer-route">
          <span class="st-transfer-node is-origin">${esc(originName)}${originSub ? `<small>${esc(originSub)}</small>` : ''}</span>
          <span class="st-transfer-arrow">→</span>
          <span class="st-transfer-node is-target">${esc(targetName)}${targetSub ? `<small>${esc(targetSub)}</small>` : ''}</span>
        </div>
        <div class="st-transfer-meter" title="${esc(directionNote)}">
          <span></span>
        </div>
        <div class="st-transfer-row-meta">
          <span class="badge text-bg-info">${esc(fmtRate(rate))}</span>
          <span class="small text-muted">${esc(fmtBytes(progress.transferred || 0))}${progress.total > 0 ? ` / ${esc(fmtBytes(progress.total))}` : ''}</span>
        </div>
      </div>`;
  }

  function renderTransferFlowNode(n) {
    const rx = Number(n.rxBytesPerSecond || 0);
    const tx = Number(n.txBytesPerSecond || 0);
    const total = rx + tx;
    const nodeName = transferNodeName(n);
    const max = Math.max(rx, tx, 1);
    const rxPct = Math.max(0, Math.min(100, Math.round((rx / max) * 100)));
    const txPct = Math.max(0, Math.min(100, Math.round((tx / max) * 100)));

    return `
      <div class="st-transfer-flow-card st-transfer-flow-row is-node" style="--transfer-progress:${Math.max(rxPct, txPct)}%">
        <div class="st-transfer-route">
          <span class="st-transfer-node is-origin">${esc(window.t?.('st.remote_nodes', 'Remotos') || 'Remotos')}</span>
          <span class="st-transfer-arrow">↔</span>
          <span class="st-transfer-node is-target">${esc(nodeName)}</span>
        </div>
        <div class="st-transfer-meter" title="${esc(window.t?.('st.transfer_unknown_remote', 'Movimiento real medido sin remoto exacto identificado') || 'Movimiento real medido sin remoto exacto identificado')}">
          <span></span>
        </div>
        <div class="st-transfer-row-meta">
          <span class="badge text-bg-info">${esc(fmtRate(total))}</span>
          <span class="small text-muted">↓ ${esc(fmtRate(rx))} · ↑ ${esc(fmtRate(tx))}</span>
        </div>
      </div>`;
  }

  function renderTransferFlows() {
    const slot = document.getElementById('st-transfer-flow-list');
    const badge = document.getElementById('st-transfer-flow-count');
    const title = document.getElementById('st-transfer-flow-title');
    const subtitle = document.getElementById('st-transfer-flow-subtitle');
    const card = document.getElementById('st-transfer-compact-card');
    const caret = document.getElementById('st-transfer-flow-caret');
    const summaryMeter = document.getElementById('st-transfer-summary-meter');
    if (!slot) return;

    const active = (state.overview.nodes || [])
      .filter(n => !!n.isTransferring)
      .sort((a, b) => transferTotalRate(b) - transferTotalRate(a));

    const monitoredPairs = buildMonitoredTransferPairs(active);
    const remotePairs = buildRemoteTransferPairs(active);
    const pairs = dedupeTransferPairsByRoute([...monitoredPairs, ...remotePairs]);

    const flowCount = pairs.length || active.length;
    const totalRate = pairs.length
      ? pairs.reduce((acc, p) => acc + Number(p.rate || 0), 0)
      : active.reduce((acc, n) => acc + transferTotalRate(n), 0);

    if (!flowCount) {
      const syncing = Number(state.overview?.summary?.nodes_syncing || 0);
      if (syncing > 0) {
        if (badge) {
          badge.textContent = window.t?.('st.syncing_count', '{count} sincronizando', { count: syncing }) || `${syncing} sincronizando`;
          badge.className = 'dash-pill warn';
        }
        if (title) title.textContent = window.t?.('st.sync_in_progress', 'Sincronización en curso · {count} nodo{s}', { count: syncing, s: syncing === 1 ? '' : 's' }) || `Sincronización en curso · ${syncing} nodo${syncing === 1 ? '' : 's'}`;
        if (subtitle) subtitle.textContent = window.t?.('st.waiting_second_sample', 'Esperando segunda muestra para calcular transferencia real') || 'Esperando segunda muestra para calcular transferencia real';
        if (card) card.classList.add('is-active', 'is-pending-sample');
        if (summaryMeter) {
          summaryMeter.classList.remove('d-none');
          summaryMeter.classList.add('is-pending');
          summaryMeter.style.setProperty('--transfer-progress', '18%');
          summaryMeter.setAttribute('title', window.t?.('st.sync_detected_waiting', 'Sincronización detectada; esperando segunda muestra para calcular progreso real') || 'Sincronización detectada; esperando segunda muestra para calcular progreso real');
        }
        if (caret) caret.textContent = state.transferFlowsExpanded ? '▲' : '▼';
        slot.classList.toggle('d-none', !state.transferFlowsExpanded);
        if (state.transferFlowsExpanded) {
          const syncingNodes = (state.overview.nodes || [])
            .filter(n => String(n.status || '') === 'syncing' || Number(n.needBytes || 0) > 0 || Number(n.needFiles || 0) > 0);
          slot.innerHTML = syncingNodes.length
            ? syncingNodes.map(n => `
              <div class="st-transfer-flow-card st-transfer-flow-row is-node" style="--transfer-progress:18%">
                <div class="st-transfer-route">
                  <span class="st-transfer-node">${esc(n.name || (window.t?.('st.node', 'Nodo') || 'Nodo'))}<small>${esc(window.t?.('dash.syncthing.syncing', 'sincronizando') || 'sincronizando')}</small></span>
                  <span class="st-transfer-arrow">→</span>
                  <span class="st-transfer-node">${esc(window.t?.('st.calculating_transfer', 'calculando transferencia') || 'calculando transferencia')}<small>${esc(window.t?.('st.waiting_second_sample', 'esperando segunda muestra') || 'esperando segunda muestra')}</small></span>
                </div>
                <div class="st-transfer-meter" title="${esc(window.t?.('st.waiting_second_sample', 'Esperando segunda muestra para calcular transferencia real') || 'Esperando segunda muestra para calcular transferencia real')}"><span></span></div>
                <div class="st-transfer-row-meta">
                  <span class="badge text-bg-warning">${esc(window.t?.('st.pending', 'pendiente') || 'pendiente')}</span>
                  <span class="small text-muted">${esc(window.t?.('st.no_enough_delta', 'sin delta suficiente') || 'sin delta suficiente')}</span>
                </div>
              </div>
            `).join('')
            : `<div class="st-transfer-flow-empty"><i class="bi bi-hourglass-split me-2"></i>Esperando segunda muestra para calcular transferencia real.</div>`;
        } else {
          slot.innerHTML = '';
        }
        return;
      } else {
        if (badge) {
          badge.textContent = window.t?.('st.no_movement', 'sin movimiento') || 'sin movimiento';
          badge.className = 'dash-pill neutral';
        }
        if (title) title.textContent = window.t?.('st.no_transfer', 'Sin transferencia en curso') || 'Sin transferencia en curso';
        if (subtitle) subtitle.textContent = window.t?.('st.real_movement_measured', 'Movimiento real medido') || 'Movimiento real medido';
        if (card) card.classList.remove('is-active', 'is-pending-sample');
        if (summaryMeter) {
          summaryMeter.classList.add('d-none');
          summaryMeter.classList.remove('is-pending');
          summaryMeter.style.setProperty('--transfer-progress', '0%');
          summaryMeter.removeAttribute('title');
        }
        if (caret) caret.textContent = '▼';
      }
      slot.classList.add('d-none');
      slot.innerHTML = '';
      return;
    }

    if (badge) {
      badge.textContent = window.t?.('st.active_count', '{count} activo{s}', { count: flowCount, s: flowCount === 1 ? '' : 's' }) || `${flowCount} activo${flowCount === 1 ? '' : 's'}`;
      badge.className = 'dash-pill warn';
    }
    if (title) {
      title.textContent = window.t?.('st.transfer_in_progress', 'Transferencia en curso · {count} flujo{s} · {rate}', { count: flowCount, s: flowCount === 1 ? '' : 's', rate: fmtRate(totalRate) }) || `Transferencia en curso · ${flowCount} flujo${flowCount === 1 ? '' : 's'} · ${fmtRate(totalRate)}`;
    }
    if (subtitle) {
      subtitle.textContent = state.transferFlowsExpanded ? (window.t?.('st.transfers_expanded', 'Transferencias desplegadas · clic para contraer') || 'Transferencias desplegadas · clic para contraer') : (window.t?.('st.click_transfer_detail', 'Clic para ver detalle de transferencias') || 'Clic para ver detalle de transferencias');
    }
    if (card) {
      card.classList.add('is-active');
      card.classList.remove('is-pending-sample');
    }
    if (summaryMeter) {
      let transferredTotal = 0;
      let expectedTotal = 0;
      if (pairs.length) {
        pairs.forEach(pair => {
          const meta = transferProgressMeta(pair);
          transferredTotal += Number(meta.transferred || 0);
          expectedTotal += Number(meta.total || 0);
        });
      } else {
        transferredTotal = active.reduce((acc, n) => acc + Number(n.totalDeltaBytes || 0), 0);
        expectedTotal = Number(state.overview?.summary?.needBytes || 0);
      }
      const pct = expectedTotal > 0
        ? Math.max(3, Math.min(100, Math.round((transferredTotal / expectedTotal) * 100)))
        : Math.max(8, Math.min(100, Math.round(totalRate / 1024 / 1024 * 8)));
      summaryMeter.classList.remove('d-none', 'is-pending');
      summaryMeter.style.setProperty('--transfer-progress', `${pct}%`);
      summaryMeter.setAttribute(
        'title',
        expectedTotal > 0
          ? `Transferido aprox.: ${fmtBytes(transferredTotal)} / ${fmtBytes(expectedTotal)}`
          : `Actividad total: ${fmtRate(totalRate)}`
      );
    }
    if (caret) caret.textContent = state.transferFlowsExpanded ? '▲' : '▼';

    slot.classList.toggle('d-none', !state.transferFlowsExpanded);
    slot.innerHTML = pairs.length
      ? pairs.map(renderTransferPairFlow).join('')
      : active.map(renderTransferFlowNode).join('');
  }

  function statusMeta(status) {
    const st = String(status || 'unknown').toLowerCase();
    if (st === 'syncing') return { label: 'Sincronizando', cls: 'primary', icon: 'bi-arrow-repeat' };
    if (st === 'scanning') return { label: 'Escaneando', cls: 'info', icon: 'bi-search' };
    if (st === 'standby') return { label: 'Standby', cls: 'success', icon: 'bi-check-circle' };
    if (st === 'paused') return { label: 'Pausada', cls: 'secondary', icon: 'bi-pause-circle' };
    if (st === 'offline') return { label: 'Offline', cls: 'danger', icon: 'bi-wifi-off' };
    if (st === 'error') return { label: 'Error', cls: 'danger', icon: 'bi-exclamation-triangle' };
    return { label: st || '—', cls: 'secondary', icon: 'bi-question-circle' };
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function showError(msg) {
    setText('st-error-msg', msg || 'Error desconocido');
    document.getElementById('st-error-banner')?.classList.remove('d-none');
  }

  function clearError() {
    document.getElementById('st-error-banner')?.classList.add('d-none');
  }

  async function apiJson(url, opts) {
    const resp = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  function ensureShell() {
    const root = document.getElementById('st-root');
    if (!root || root.dataset.ready === '1') return;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="modal fade" id="stNodeFormModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <form id="st-node-form" class="modal-content">
            <div class="modal-header">
              <div>
                <h5 class="modal-title mb-1" id="st-node-form-title"><i class="bi bi-hdd-network me-2"></i>Añadir nodo Syncthing</h5>
                <div class="small text-muted">Las API keys se guardan en BD local y se muestran enmascaradas.</div>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <input type="hidden" id="st-node-id">
              <div class="row g-2 align-items-end">
                <div class="col-12 col-md-4">
                  <label class="form-label form-label-sm small-muted mb-1">Nombre</label>
                  <input id="st-node-name" class="form-control form-control-sm" placeholder="ServerLinuxSecundario" autocomplete="off">
                </div>
                <div class="col-12 col-md-8">
                  <label class="form-label form-label-sm small-muted mb-1">URL API</label>
                  <input id="st-node-api-url" class="form-control form-control-sm" placeholder="https://192.168.1.253:8384" autocomplete="off">
                </div>
                <div class="col-12 col-md-8">
                  <label class="form-label form-label-sm small-muted mb-1">URL GUI</label>
                  <input id="st-node-gui-url" class="form-control form-control-sm" placeholder="https://192.168.1.253:8384/#" autocomplete="off">
                </div>
                <div class="col-12 col-md-4">
                  <label class="form-label form-label-sm small-muted mb-1">API key</label>
                  <input id="st-node-api-key" type="password" class="form-control form-control-sm" placeholder="Nueva clave o vacío al editar" autocomplete="new-password">
                </div>
                <div class="col-6 col-md-3">
                  <label class="form-label form-label-sm small-muted mb-1">Timeout</label>
                  <input id="st-node-timeout" type="number" min="2" max="60" step="1" value="8" class="form-control form-control-sm">
                </div>
                <div class="col-6 col-md-3">
                  <label class="form-label form-label-sm small-muted mb-1">TLS</label>
                  <select id="st-node-verify-tls" class="form-select form-select-sm">
                    <option value="0">Sin verificar</option>
                    <option value="1">Verificar</option>
                  </select>
                </div>
                <div class="col-12 col-md-6">
                  <label class="form-label form-label-sm small-muted mb-1">Notas</label>
                  <input id="st-node-notes" class="form-control form-control-sm" placeholder="Uso interno, ubicación, rol del nodo…" autocomplete="off">
                </div>
              </div>
              <div class="small-muted mt-2" id="st-node-msg"></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-outline-secondary btn-sm" type="button" id="st-node-cancel">Cancelar</button>
              <button class="btn btn-success btn-sm" type="submit"><i class="bi bi-save"></i> Guardar nodo</button>
            </div>
          </form>
        </div>
      </div>

      <div class="cardish mb-3">
        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
          <div>
            <div class="small-muted"><i class="bi bi-graph-up-arrow"></i> Dashboard Syncthing</div>
            <div class="small-muted">Transferencia agregada de todos los servidores con histórico local limitado.</div>
          </div>
          <div class="d-flex gap-2 flex-wrap justify-content-end">
            <div id="st-dashboard-chart-mode-slot"></div>
            <div id="st-dashboard-chart-range-slot"></div>
          </div>
        </div>
        <div class="st-chart-wrap st-dashboard-chart-wrap mb-2">
          <canvas id="stDashboardTransferChart"></canvas>
        </div>
        <div class="d-flex gap-2 flex-wrap small-muted">
          <span>Muestras: <strong id="st-dashboard-chart-samples">—</strong></span>
          <span>Máx entrada: <strong id="st-dashboard-chart-max-rx">—</strong></span>
          <span>Máx salida: <strong id="st-dashboard-chart-max-tx">—</strong></span>
          <span>Máx total: <strong id="st-dashboard-chart-max-total">—</strong></span>
        </div>
      </div>

      <div class="cardish mb-3 st-transfer-compact-card" id="st-transfer-compact-card">
        <button class="st-transfer-summary-btn" id="st-transfer-flow-toggle" type="button">
          <span class="st-transfer-summary-icon"><i class="bi bi-arrow-left-right"></i></span>
          <span class="st-transfer-summary-main">
            <span id="st-transfer-flow-title">${esc(window.t?.('st.no_transfer', 'Sin transferencia en curso') || 'Sin transferencia en curso')}</span>
            <span class="small" id="st-transfer-flow-subtitle">${esc(window.t?.('st.real_movement_measured', 'Movimiento real medido') || 'Movimiento real medido')}</span>
          </span>
          <span class="st-transfer-summary-meter d-none" id="st-transfer-summary-meter" title="${esc(window.t?.('st.transfer_summary_title', 'Progreso/actividad total de transferencia') || 'Progreso/actividad total de transferencia')}">
            <span></span>
          </span>
          <span class="dash-pill neutral" id="st-transfer-flow-count">${esc(window.t?.('st.no_movement', 'sin movimiento') || 'sin movimiento')}</span>
          <span class="st-transfer-summary-caret" id="st-transfer-flow-caret">▼</span>
        </button>
        <div class="st-transfer-flow-list mt-2 d-none" id="st-transfer-flow-list"></div>
      </div>

      <div class="cardish mb-3">
        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
          <div>
            <div class="small-muted"><i class="bi bi-files"></i> Historial global de archivos</div>
            <div class="small-muted">Eventos observados por Syncthing Control. No se guarda la ruta completa; el nombre puede ocultarse por privacidad.</div>
          </div>
          <div class="d-flex gap-2 flex-wrap justify-content-end">
            <button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#st-file-events-filters" aria-expanded="false" aria-controls="st-file-events-filters">
              <i class="bi bi-funnel"></i> Filtros
            </button>
            <button class="btn btn-sm btn-outline-secondary" id="st-file-events-clear"><i class="bi bi-x-circle"></i> Limpiar</button>
            <button class="btn btn-sm btn-outline-info" id="st-file-events-refresh"><i class="bi bi-arrow-clockwise"></i> Actualizar</button>
          </div>
        </div>

        <div class="collapse" id="st-file-events-filters">
          <div class="row g-2 align-items-end mb-2">
          <div class="col-12 col-md-3">
            <label class="form-label form-label-sm small-muted mb-1">Buscar</label>
            <input id="st-file-events-q" class="form-control form-control-sm" placeholder="Nodo, carpeta, nombre o hash…" autocomplete="off">
          </div>
          <div class="col-6 col-md-2">
            <label class="form-label form-label-sm small-muted mb-1">Rango</label>
            <select id="st-file-events-hours" class="form-select form-select-sm">
              <option value="24">24 horas</option>
              <option value="168" selected>7 días</option>
              <option value="720">30 días</option>
              <option value="2160">90 días</option>
            </select>
          </div>
          <div class="col-6 col-md-2">
            <label class="form-label form-label-sm small-muted mb-1">Observado en</label>
            <select id="st-file-events-node" class="form-select form-select-sm">
              <option value="">Todos</option>
            </select>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label form-label-sm small-muted mb-1">Carpeta</label>
            <select id="st-file-events-folder" class="form-select form-select-sm">
              <option value="">Todas</option>
            </select>
          </div>
          <div class="col-6 col-md-2">
            <label class="form-label form-label-sm small-muted mb-1">Acción</label>
            <select id="st-file-events-action" class="form-select form-select-sm">
              <option value="">Todas</option>
            </select>
          </div>
          </div>
        </div>

        <div class="d-flex gap-2 flex-wrap small-muted mb-2 align-items-center">
          <span>Eventos: <strong id="st-file-events-count">—</strong></span>
          <span>Nombres visibles: <strong id="st-file-events-privacy">—</strong></span>
          <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" id="st-file-events-toggle">Ver todo</button>
          <span id="st-file-events-status"></span>
        </div>

        <div id="st-file-events-expanded-top" class="text-center mb-2 d-none"></div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0" id="st-file-events-table">
            <thead>
              <tr>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="event_time">Fecha <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="node_name">Observado en <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="origin">Origen probable <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="folder_label">Carpeta <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="item_name">Archivo <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="item_type">Tipo <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="action">Acción <span class="st-file-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-file-sort" data-sort-key="confirmation">Confirmación <span class="st-file-sort-icon"></span></button></th>
              </tr>
            </thead>
            <tbody id="st-file-events-body">
              <tr><td colspan="8" class="text-muted">Cargando historial…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
        <div class="btn-group btn-group-sm" role="group" id="st-node-filter">
          <button class="btn btn-outline-secondary active" data-filter="all">Todos</button>
          <button class="btn btn-outline-secondary" data-filter="syncing">Sincronizando</button>
          <button class="btn btn-outline-secondary" data-filter="transferring">Transfiriendo</button>
          <button class="btn btn-outline-secondary" data-filter="scanning">Escaneando</button>
          <button class="btn btn-outline-secondary" data-filter="standby">Standby</button>
          <button class="btn btn-outline-secondary" data-filter="error">Error</button>
          <button class="btn btn-outline-secondary" data-filter="offline">Offline</button>
        </div>
        <input id="st-search" class="form-control form-control-sm" style="max-width:260px" placeholder="Buscar nodo o carpeta…">
      </div>

      <div class="cardish mb-4">
        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
          <div>
            <div class="small-muted"><i class="bi bi-hdd-network"></i> Servidores Syncthing</div>
            <div class="small-muted">Tabla operativa diferenciada de carpetas.</div>
          </div>
          <button class="btn btn-sm btn-outline-info" id="st-toggle-node-form">
            <i class="bi bi-plus-circle"></i> Añadir nodo
          </button>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0" id="st-nodes-table">
            <thead>
              <tr>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="status">Estado <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="lastRelevantStateChangeAt" title="${esc(window.t?.('st.sort_state_change_title', 'Solo cambios entre Standby, Sincronizando, Error y Posible atasco') || 'Solo cambios entre Standby, Sincronizando, Error y Posible atasco')}">Último cambio <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="name">Servidor <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="version">Versión <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="connected_devices">Conectados <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="inBytesTotal">Entrada <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="outBytesTotal">Salida <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="nodes" data-sort-key="totalBytesPerSecond">Velocidad <span class="st-sort-icon"></span></button></th>
                <th>Seguridad</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="st-nodes-body"></tbody>
          </table>
        </div>
      </div>

      <div class="cardish">
        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
          <div class="small-muted"><i class="bi bi-folder2-open"></i> Carpetas</div>
          <div class="btn-group btn-group-sm" role="group" id="st-folder-filter">
            <button class="btn btn-outline-secondary active" data-filter="all">Todas</button>
            <button class="btn btn-outline-secondary" data-filter="syncing">Sincronizando</button>
            <button class="btn btn-outline-secondary" data-filter="scanning">Escaneando</button>
            <button class="btn btn-outline-secondary" data-filter="standby">Standby</button>
            <button class="btn btn-outline-secondary" data-filter="paused">Pausadas</button>
            <button class="btn btn-outline-secondary" data-filter="error">Error</button>
            <button class="btn btn-outline-secondary" data-filter="stalled">Posibles atascos</button>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle" id="st-folders-table">
            <thead>
              <tr>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="status">Estado <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="node_name">Nodo <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="label">Carpeta <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="type">Tipo <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="needBytes">Pendiente <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="globalBytes">Local / Global <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="stateChanged" title="${esc(window.t?.('st.sort_activity_title', 'Ordena solo por sincronizaciones reales o errores; los escaneos no cuentan como transacción') || 'Ordena solo por sincronizaciones reales o errores; los escaneos no cuentan como transacción')}">Última actividad relevante <span class="st-sort-icon"></span></button></th>
                <th><button type="button" class="btn btn-sm btn-link link-secondary p-0 text-decoration-none st-sort" data-sort-scope="folders" data-sort-key="syncing_minutes_observed">Observado <span class="st-sort-icon"></span></button></th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="st-folders-body"></tbody>
          </table>
        </div>
      </div>
    `;
  }

  function ensureHistoryModal() {
    if (document.getElementById('stHistoryModal')) return;

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="stHistoryModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <div>
                <h5 class="modal-title mb-1"><i class="bi bi-clock-history me-2"></i>Detalle de carpeta Syncthing</h5>
                <div class="small text-muted" id="st-history-subtitle">—</div>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="row g-2 mb-3">
                <div class="col-6 col-md-3"><div class="card border-0 shadow-sm text-center py-2"><div class="card-body p-2"><div class="fs-5 fw-bold" id="st-h-samples">—</div><div class="small text-muted">Muestras</div></div></div></div>
                <div class="col-6 col-md-3"><div class="card border-0 shadow-sm text-center py-2"><div class="card-body p-2"><div class="fs-5 fw-bold" id="st-h-status">—</div><div class="small text-muted">Último estado</div></div></div></div>
                <div class="col-6 col-md-3"><div class="card border-0 shadow-sm text-center py-2"><div class="card-body p-2"><div class="fs-5 fw-bold" id="st-h-need">—</div><div class="small text-muted">Pendiente actual</div></div></div></div>
                <div class="col-6 col-md-3"><div class="card border-0 shadow-sm text-center py-2"><div class="card-body p-2"><div class="fs-5 fw-bold" id="st-h-sync-min">—</div><div class="small text-muted">Observado sync</div></div></div></div>
              </div>

              <div class="alert alert-secondary small mb-3">
                Archivos pendientes obtenidos en lectura desde Syncthing. La evolución inferior es histórico local de Auditor IPs. No ejecuta acciones remotas.
              </div>

              <div id="st-history-body">
                <div class="text-muted">Selecciona una carpeta para ver su histórico.</div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Cerrar</button>
            </div>
          </div>
        </div>
      </div>
    `);
  }


  function needFilesHtml(currentNeed) {
    const need = currentNeed || {};
    if (need.error) {
      return `<div class="alert alert-warning mb-3">No se pudo leer /rest/db/need: ${esc(need.error)}</div>`;
    }

    const groups = [
      ['progress', 'En progreso'],
      ['queued', 'En cola'],
      ['rest', 'Pendientes'],
    ];

    const rows = [];
    groups.forEach(([key, label]) => {
      (need[key] || []).forEach(item => {
        rows.push({ group: label, item });
      });
    });

    if (!rows.length) {
      return '<div class="alert alert-secondary mb-3">Syncthing no informa archivos pendientes ahora mismo para esta carpeta.</div>';
    }

    return `
      <div class="mb-3">
        <div class="small-muted mb-2">
          <i class="bi bi-list-ul"></i>
          Archivos pendientes ahora:
          ${Number(need.counts?.total || 0)} ficheros · tamaño total ${esc(fmtBytes(need.bytes?.total || 0))}
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead>
              <tr>
                <th>Grupo</th>
                <th>Archivo</th>
                <th>Tamaño fichero</th>
                <th>Modificado</th>
                <th>Origen</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(({ group, item }) => `
                <tr>
                  <td><span class="badge text-bg-${group === 'En progreso' ? 'primary' : 'secondary'}">${esc(group)}</span></td>
                  <td><strong>${esc(item.name || '—')}</strong></td>
                  <td>${esc(fmtBytes(item.size || 0))}</td>
                  <td>${esc(fmtDateTime(item.modified))}</td>
                  <td>${esc(item.modifiedBy || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function historyRowsHtml(snapshots, maxNeedBytes) {
    if (!snapshots.length) {
      return '<tr><td colspan="7" class="text-muted">Sin snapshots locales para esta carpeta.</td></tr>';
    }

    return snapshots.slice().reverse().map(item => {
      const meta = statusMeta(item.status);
      const pct = pctOf(item.need_bytes, maxNeedBytes);
      return `
        <tr>
          <td>${esc(fmtDateTime(item.observed_at))}</td>
          <td><span class="badge text-bg-${meta.cls}"><i class="bi ${meta.icon} me-1"></i>${meta.label}</span></td>
          <td>${esc(item.state || '—')}</td>
          <td>
            <div class="d-flex align-items-center gap-2">
              <div class="progress flex-grow-1" style="height:8px;min-width:120px">
                <div class="progress-bar" role="progressbar" style="width:${pct}%"></div>
              </div>
              <span class="small">${esc(fmtBytes(item.need_bytes || 0))}</span>
            </div>
          </td>
          <td>${Number(item.need_files || 0)}</td>
          <td>${esc(fmtBytes(item.local_bytes || 0))}</td>
          <td>${esc(fmtBytes(item.global_bytes || 0))}</td>
        </tr>`;
    }).join('');
  }

  async function openFolderHistory(nodeId, folderId, hours) {
    ensureHistoryModal();

    const rangeHours = Number(hours || state.activeHistoryFolder?.hours || 24);
    const limit = rangeHours <= 24 ? 240 : 360;

    const folder = (state.overview.folders || []).find(f =>
      Number(f.node_id) === Number(nodeId) && String(f.id || '') === String(folderId || '')
    );

    state.activeHistoryFolder = { nodeId, folderId, hours: rangeHours };
    setText('st-history-subtitle', `${folder?.node_name || 'Nodo'} · ${folder?.label || folderId}`);
    setText('st-h-samples', '—');
    setText('st-h-status', '—');
    setText('st-h-need', '—');
    setText('st-h-sync-min', '—');

    const body = document.getElementById('st-history-body');
    if (body) {
      body.innerHTML = '<div class="text-center py-4"><div class="spinner-border" role="status"><span class="visually-hidden">Cargando…</span></div></div>';
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('stHistoryModal')).show();

    try {
      const data = await apiJson(`/api/syncthing/folders/${encodeURIComponent(nodeId)}/${encodeURIComponent(folderId)}/history?hours=${encodeURIComponent(rangeHours)}&limit=${encodeURIComponent(limit)}`);
      const s = data.summary || {};
      const snapshots = data.snapshots || [];
      const meta = statusMeta(s.latest_status);

      setText('st-h-samples', String(s.samples ?? 0));
      document.getElementById('st-h-status').innerHTML = `<span class="badge text-bg-${meta.cls}"><i class="bi ${meta.icon} me-1"></i>${esc(meta.label)}</span>`;
      setText('st-h-need', fmtBytes(s.latest_need_bytes || 0));
      setText('st-h-sync-min', s.syncing_minutes_observed ? `${s.syncing_minutes_observed} min` : '—');

      if (body) {
        body.innerHTML = `
          ${needFilesHtml(data.current_need || {})}
          <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
            <div class="small-muted"><i class="bi bi-activity"></i> Evolución local de la carpeta</div>
            <div class="d-flex gap-2 flex-wrap justify-content-end">
              <span class="badge text-bg-secondary align-self-center">Estado de carpeta</span>
              ${folderRangeButtons(rangeHours)}
            </div>
          </div>
          <div class="st-chart-wrap mb-3">
            <canvas id="stFolderHistoryChart"></canvas>
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0">
              <thead>
                <tr>
                  <th>Observado</th>
                  <th>Estado</th>
                  <th>State</th>
                  <th>Pendiente</th>
                  <th>Ficheros</th>
                  <th>Local</th>
                  <th>Global</th>
                </tr>
              </thead>
              <tbody>${historyRowsHtml(snapshots, s.max_need_bytes || 0)}</tbody>
            </table>
          </div>`;

        renderLineChart(
          'stFolderHistoryChart',
          'folder',
          snapshots.map(item => chartLabelTime(item.observed_at)),
          [
            chartLineDataset('Pendiente', snapshots.map(item => Number(item.need_bytes || 0))),
            chartLineDataset('Local', snapshots.map(item => Number(item.local_bytes || 0))),
            chartLineDataset('Global', snapshots.map(item => Number(item.global_bytes || 0))),
          ],
          'Bytes'
        );
      }
    } catch (e) {
      if (body) body.innerHTML = `<div class="alert alert-warning mb-0">${esc(e.message || String(e))}</div>`;
    }
  }

  function ensureNodeChartModal() {
    if (document.getElementById('stNodeChartModal')) return;

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="stNodeChartModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <div>
                <h5 class="modal-title mb-1"><i class="bi bi-graph-up-arrow me-2"></i>Transferencia del servidor Syncthing</h5>
                <div class="small text-muted" id="st-node-chart-subtitle">—</div>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                <div class="small-muted" id="st-node-chart-mode-title"><i class="bi bi-speedometer2"></i> Velocidad entrada/salida</div>
                <div class="d-flex gap-2 flex-wrap justify-content-end">
                  <div id="st-node-chart-mode-slot"></div>
                  <div id="st-node-chart-range-slot"></div>
                </div>
              </div>
              <div class="st-chart-wrap mb-3">
                <canvas id="stNodeTransferChart"></canvas>
              </div>
              <div class="row g-2">
                <div class="col-6 col-md-3"><div class="st-kpi-pill"><span class="st-kpi-value" id="st-node-chart-samples">—</span><span class="st-kpi-label">Muestras</span></div></div>
                <div class="col-6 col-md-3"><div class="st-kpi-pill"><span class="st-kpi-value" id="st-node-chart-max-rx">—</span><span class="st-kpi-label">Máx entrada</span></div></div>
                <div class="col-6 col-md-3"><div class="st-kpi-pill"><span class="st-kpi-value" id="st-node-chart-max-tx">—</span><span class="st-kpi-label">Máx salida</span></div></div>
                <div class="col-6 col-md-3"><div class="st-kpi-pill"><span class="st-kpi-value" id="st-node-chart-transferring">—</span><span class="st-kpi-label">Puntos</span></div></div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Cerrar</button>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  async function openNodeChart(nodeId, hours, mode) {
    ensureNodeChartModal();

    const rangeHours = Number(hours || state.activeNodeChart?.hours || 24);
    const chartMode = String(mode || state.activeNodeChart?.mode || state.nodeChartMode || 'rate');
    const chartMeta = transferChartMeta(chartMode);
    const node = activeNodeById(nodeId) || {};

    state.nodeChartMode = chartMeta.mode;
    state.activeNodeChart = { nodeId, hours: rangeHours, mode: chartMeta.mode };
    setText('st-node-chart-subtitle', node.name || `Nodo ${nodeId}`);
    const title = document.getElementById('st-node-chart-mode-title');
    if (title) title.innerHTML = `<i class="bi bi-speedometer2"></i> ${esc(chartMeta.title)}`;
    const modeSlot = document.getElementById('st-node-chart-mode-slot');
    if (modeSlot) modeSlot.innerHTML = chartModeButtons('node', chartMeta.mode);
    const slot = document.getElementById('st-node-chart-range-slot');
    if (slot) slot.innerHTML = nodeRangeButtons(rangeHours);
    setText('st-node-chart-samples', '—');
    setText('st-node-chart-max-rx', '—');
    setText('st-node-chart-max-tx', '—');
    setText('st-node-chart-transferring', '—');

    bootstrap.Modal.getOrCreateInstance(document.getElementById('stNodeChartModal')).show();

    try {
      const data = await apiJson(`/api/syncthing/transfer-chart?node_id=${encodeURIComponent(nodeId)}&hours=${encodeURIComponent(rangeHours)}`);
      const summary = data.summary || {};
      const points = data.points || [];

      const maxRx = Math.max(0, ...points.map(item => Number(item[chartMeta.rxKey] || 0)));
      const maxTx = Math.max(0, ...points.map(item => Number(item[chartMeta.txKey] || 0)));

      setText('st-node-chart-samples', String(summary.raw_samples ?? 0));
      setText('st-node-chart-max-rx', chartMeta.formatter(maxRx));
      setText('st-node-chart-max-tx', chartMeta.formatter(maxTx));
      setText('st-node-chart-transferring', String(summary.samples ?? points.length));

      renderLineChart(
        'stNodeTransferChart',
        'node',
        points.map(item => chartLabelTime(item.observed_at)),
        [
          chartLineDataset('Entrada', points.map(item => Number(item[chartMeta.rxKey] || 0))),
          chartLineDataset('Salida', points.map(item => Number(item[chartMeta.txKey] || 0))),
        ],
        chartMeta.yTitle,
        chartMeta.formatter
      );
    } catch (e) {
      const canvasWrap = document.getElementById('stNodeTransferChart')?.closest('.st-chart-wrap');
      if (canvasWrap) canvasWrap.innerHTML = `<div class="alert alert-warning mb-0">${esc(e.message || String(e))}</div>`;
    }
  }

  function ensureDeleteModal() {
    if (document.getElementById('stDeleteModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="stDeleteModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-trash text-danger me-2"></i>Eliminar nodo Syncthing</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="mb-1">Se eliminará la configuración local del nodo.</p>
              <p class="small-muted mb-0">No se ejecutará ninguna acción remota sobre Syncthing.</p>
              <div class="mt-3 fw-semibold" id="st-delete-name">—</div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-danger btn-sm" id="st-delete-confirm"><i class="bi bi-trash"></i> Eliminar</button>
            </div>
          </div>
        </div>
      </div>
    `);

    document.getElementById('st-delete-confirm')?.addEventListener('click', async () => {
      const id = state.pendingDeleteId;
      if (!id) return;
      try {
        await apiJson(`/api/syncthing/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        bootstrap.Modal.getOrCreateInstance(document.getElementById('stDeleteModal')).hide();

        state.overview.nodes = (state.overview.nodes || []).filter(n => String(n.id) !== String(id));
        state.overview.folders = (state.overview.folders || []).filter(f => String(f.node_id) !== String(id));
        state.pendingDeleteId = null;
        state.loaded = false;
        renderAll();

        await loadSyncthingControl(true);
      } catch (e) {
        showError(e.message || String(e));
      }
    });
  }

  function matchesQuery(item) {
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [
      item.name,
      item.node_name,
      item.label,
      item.id,
      item.path,
      item.api_base_url,
      item.gui_url,
    ].map(v => String(v || '').toLowerCase()).join(' ').includes(q);
  }

  function statusRank(status) {
    const st = String(status || '').toLowerCase();
    const ranks = {
      error: 10,
      offline: 20,
      syncing: 30,
      scanning: 40,
      paused: 50,
      standby: 60,
    };
    return ranks[st] ?? 99;
  }

  function defaultSortDir(key) {
    const desc = new Set([
      'connected_devices',
      'inBytesTotal',
      'outBytesTotal',
      'rxBytesPerSecond',
      'txBytesPerSecond',
      'totalBytesPerSecond',
      'lastRelevantStateChangeAt',
      'relevantStateChangedAt',
      'needBytes',
      'needFiles',
      'localBytes',
      'globalBytes',
      'stateChanged',
      'syncing_minutes_observed',
    ]);
    return desc.has(key) ? 'desc' : 'asc';
  }

  function folderRelevantActivityAt(item) {
    return String(item?.lastRelevantActivityAt || item?.last_relevant_activity_at || '').trim();
  }

  function isRelevantFolderActivity(item) {
    if (!item) return false;
    if (folderRelevantActivityAt(item)) return true;
    const st = String(item.status || '').toLowerCase();
    if (st === 'error') return true;
    if (st !== 'syncing') return false;
    return Number(item.needBytes || 0) > 0
      || Number(item.needFiles || 0) > 0
      || Number(item.syncing_minutes_observed || 0) > 0;
  }

  function sortValue(item, key) {
    if (!item) return '';
    if (key === 'status') return statusRank(item.status);
    if (key === 'totalBytesPerSecond') return Number(item.rxBytesPerSecond || 0) + Number(item.txBytesPerSecond || 0);
    if (key === 'lastRelevantStateChangeAt' || key === 'relevantStateChangedAt') {
      const raw = item.lastRelevantStateChangeAt || item.relevantStateChangedAt || '';
      const d = raw ? new Date(raw) : null;
      return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
    }
    if (key === 'label') return item.label || item.id || '';
    if (key === 'stateChanged') {
      const raw = ('node_id' in item)
        ? (folderRelevantActivityAt(item) || (isRelevantFolderActivity(item) ? item.stateChanged : ''))
        : item.stateChanged;
      const d = raw ? new Date(raw) : null;
      return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
    }
    const value = item[key];
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return '';
    return String(value).toLocaleLowerCase(navigator.language || 'es');
  }

  function sortItems(items, sort) {
    const key = sort?.key || 'name';
    const dir = sort?.dir === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);

      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }

      return String(av).localeCompare(String(bv), navigator.language || 'es', {
        numeric: true,
        sensitivity: 'base',
      }) * dir;
    });
  }

  function updateSort(scope, key) {
    const prop = scope === 'nodes' ? 'nodeSort' : 'folderSort';
    const current = state[prop] || {};
    state[prop] = {
      key,
      dir: current.key === key
        ? (current.dir === 'asc' ? 'desc' : 'asc')
        : defaultSortDir(key),
    };
  }

  function updateSortHeaders() {
    document.querySelectorAll('.st-sort[data-sort-scope][data-sort-key]').forEach(btn => {
      const scope = btn.dataset.sortScope;
      const key = btn.dataset.sortKey;
      const sort = scope === 'nodes' ? state.nodeSort : state.folderSort;
      const active = !!sort && sort.key === key;
      const icon = btn.querySelector('.st-sort-icon');

      btn.classList.toggle('fw-semibold', active);
      btn.setAttribute('aria-sort', active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

      if (icon) {
        icon.textContent = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
      }
    });
  }

  function renderKpis() {
    const s = state.overview.summary || {};
    setText('st-next-refresh-countdown', nextRefreshText());
    setText('st-kpi-nodes', String(s.nodes_total ?? 0));
    setText('st-kpi-online', String(s.nodes_online ?? 0));
    setText('st-kpi-syncing', String(s.nodes_syncing ?? 0));
    setText('st-kpi-transferring', String(s.nodes_transferring ?? 0));
    setText('st-kpi-transfer-rate', `${fmtRate(s.rxBytesPerSecond || 0)} ↓ · ${fmtRate(s.txBytesPerSecond || 0)} ↑`);
    setText('st-kpi-errors', String(s.nodes_error ?? 0));
    setText('st-kpi-folders', String(s.folders_total ?? 0));
    setText('st-kpi-need', fmtBytes(s.needBytes || 0));
    setText('st-kpi-stalled', String(s.folders_stalled_candidate ?? 0));
    setText('st-last-refresh', fmtDateTime(s.last_refresh));
  }

  function renderNodes() {
    const body = document.getElementById('st-nodes-body');
    if (!body) return;

    const nodes = sortItems((state.overview.nodes || [])
      .filter(n => {
        if (state.nodeFilter === 'all') return true;
        if (state.nodeFilter === 'transferring') return !!n.isTransferring;
        return String(n.status || '') === state.nodeFilter;
      })
      .filter(matchesQuery), state.nodeSort);

    if (!nodes.length) {
      body.innerHTML = '<tr><td colspan="10" class="text-muted">No hay nodos Syncthing para el filtro actual.</td></tr>';
      return;
    }

    body.innerHTML = nodes.map(n => {
      const meta = statusMeta(n.status);
      const gui = n.gui_url
        ? `<a class="btn btn-sm btn-outline-info" href="${esc(n.gui_url)}" target="_blank" rel="noopener" title="${esc(window.t?.('st.open_syncthing', 'Abrir Syncthing') || 'Abrir Syncthing')}"><i class="bi bi-box-arrow-up-right"></i></a>`
        : '';

      const transferBadge = n.isTransferring
        ? `<div class="small mt-1"><span class="badge text-bg-info"><i class="bi bi-activity me-1"></i>${esc(window.t?.('st.transferring', 'Transfiriendo') || 'Transfiriendo')}</span></div>`
        : '';
      const relevantState = n.relevantStateLabel || n.relevant_state_label || '—';
      const relevantChanged = n.lastRelevantStateChangeAt || n.relevantStateChangedAt || '';
      return `
        <tr>
          <td><span class="badge text-bg-${meta.cls}"><i class="bi ${meta.icon} me-1"></i>${meta.label}</span>${transferBadge}</td>
          <td>
            <div>${esc(fmtDateTime(relevantChanged))}</div>
            <div class="small text-muted">${esc(relevantState)}</div>
          </td>
          <td>
            <strong><i class="bi bi-hdd-network me-1"></i>${esc(n.name || (window.t?.('st.node', 'Nodo') || 'Nodo'))}</strong>
            <div class="small text-muted mono">${esc(n.api_base_url || '')}</div>
          </td>
          <td>${esc(n.version || '—')}</td>
          <td>${Number(n.connected_devices || 0)}</td>
          <td>${esc(fmtBytes(n.inBytesTotal || 0))}</td>
          <td>${esc(fmtBytes(n.outBytesTotal || 0))}</td>
          <td>
            <div class="small">↓ ${esc(fmtRate(n.rxBytesPerSecond || 0))}</div>
            <div class="small text-muted">↑ ${esc(fmtRate(n.txBytesPerSecond || 0))}</div>
          </td>
          <td>
            <div class="small">TLS: ${n.verify_tls ? 'verificado' : 'sin verificar'}</div>
            <div class="small text-muted">API key: ${esc(n.api_key_masked || '—')}</div>
          </td>
          <td>
            <div class="d-flex gap-1 flex-wrap">
              ${gui}
              <button class="btn btn-sm st-node-chart st-chart-action-btn" data-id="${Number(n.id)}" title="${esc(window.t?.('common.graph', 'Gráfica') || 'Gráfica')}"><i class="bi bi-graph-up"></i></button>
              <button class="btn btn-sm btn-outline-info st-node-events" data-id="${Number(n.id)}" title="${esc(window.t?.('common.file_events', 'Eventos de archivos') || 'Eventos de archivos')}"><i class="bi bi-files"></i></button>
              <button class="btn btn-sm btn-outline-secondary st-edit-node" data-id="${Number(n.id)}" title="${esc(window.t?.('common.edit', 'Editar') || 'Editar')}"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-danger st-delete-node" data-id="${Number(n.id)}" title="${esc(window.t?.('common.delete', 'Eliminar') || 'Eliminar')}"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  function renderFolders() {
    const body = document.getElementById('st-folders-body');
    if (!body) return;

    const folders = sortItems((state.overview.folders || [])
      .filter(f => state.folderFilter === 'all' || (state.folderFilter === 'stalled' ? !!f.stalled_candidate : String(f.status || '') === state.folderFilter))
      .filter(matchesQuery), state.folderSort);

    if (!folders.length) {
      body.innerHTML = '<tr><td colspan="9" class="text-muted">No hay carpetas para el filtro actual.</td></tr>';
      return;
    }

    body.innerHTML = folders.map(f => {
      const meta = statusMeta(f.status);
      const observedMinutes = Number(f.syncing_minutes_observed || 0);
      const relevantActivity = isRelevantFolderActivity(f);
      const relevantActivityAt = folderRelevantActivityAt(f) || (relevantActivity ? f.stateChanged : '');
      const observedText = f.status === 'syncing' && observedMinutes > 0
        ? `${observedMinutes} min`
        : '—';
      const relevantActivityText = relevantActivityAt ? fmtDateTime(relevantActivityAt) : '—';
      const stalledBadge = f.stalled_candidate
        ? `<div class="small mt-1"><span class="badge text-bg-warning"><i class="bi bi-hourglass-split me-1"></i>Posible atasco</span></div>`
        : '';
      return `
        <tr>
          <td><span class="badge text-bg-${meta.cls}"><i class="bi ${meta.icon} me-1"></i>${meta.label}</span>${stalledBadge}</td>
          <td>${esc(f.node_name || '—')}</td>
          <td><strong>${esc(f.label || f.id || '—')}</strong><div class="small text-muted mono">${esc(f.path || f.id || '')}</div></td>
          <td>${esc(f.type || '—')}</td>
          <td>${esc(fmtBytes(f.needBytes || 0))} · ${Number(f.needFiles || 0)} ficheros</td>
          <td>${esc(fmtBytes(f.localBytes || 0))} / ${esc(fmtBytes(f.globalBytes || 0))}</td>
          <td>${esc(relevantActivityText)}</td>
          <td>${esc(observedText)}</td>
          <td>
            <div class="d-flex gap-1 flex-wrap">
              <button class="btn btn-sm btn-outline-info st-folder-history" data-node-id="${Number(f.node_id)}" data-folder-id="${esc(f.id || '')}">
                <i class="bi bi-clock-history"></i> ${esc(window.t?.('st.detail', 'Detalle') || 'Detalle')}
              </button>
              <button class="btn btn-sm btn-outline-secondary st-folder-events" data-node-id="${Number(f.node_id)}" data-folder-id="${esc(f.id || '')}" title="${esc(window.t?.('common.file_events', 'Eventos de archivos') || 'Eventos de archivos')}">
                <i class="bi bi-files"></i> ${esc(window.t?.('st.events', 'Eventos') || 'Eventos')}
              </button>
            </div>
          </td>
        </tr>`;
    }).join('');
  }


  function eventFileLabel(ev) {
    const name = String(ev?.item_name || '').trim();
    if (name) return `<span>${esc(name)}</span>`;
    const hash = String(ev?.item_hash || '').trim();
    if (hash) return `<span class="text-muted">Nombre oculto</span><div class="small text-muted mono">${esc(hash.slice(0, 12))}…</div>`;
    return '<span class="text-muted">—</span>';
  }

  function renderFileEventFilters() {
    const data = state.fileEvents || {};
    const filters = data.filters || {};
    const nodeSel = document.getElementById('st-file-events-node');
    const folderSel = document.getElementById('st-file-events-folder');
    const actionSel = document.getElementById('st-file-events-action');

    const nodeEventTotals = new Map();
    (filters.nodes || []).forEach(n => {
      const key = String(n.node_id || '');
      if (key) nodeEventTotals.set(key, Number(n.total || 0));
    });

    const folderEventTotals = new Map();
    (filters.folders || []).forEach(f => {
      const key = String(f.folder_id || '');
      if (key) folderEventTotals.set(key, Number(f.total || 0));
    });

    if (nodeSel) {
      const current = String(state.fileEventsNodeId || '');
      const byId = new Map();

      (state.overview.nodes || []).forEach(n => {
        const value = String(n.id || '');
        if (!value) return;
        byId.set(value, {
          value,
          name: String(n.name || ('Nodo #' + value)),
          total: nodeEventTotals.get(value) || 0,
        });
      });

      (filters.nodes || []).forEach(n => {
        const value = String(n.node_id || '');
        if (!value || byId.has(value)) return;
        byId.set(value, {
          value,
          name: String(n.node_name || ('Nodo #' + value)),
          total: Number(n.total || 0),
        });
      });

      const nodes = [...byId.values()].sort((a, b) =>
        a.name.localeCompare(b.name, navigator.language || 'es', { numeric: true, sensitivity: 'base' })
      );

      nodeSel.innerHTML = '<option value="">Todos</option>' + nodes.map(n => {
        const suffix = n.total > 0 ? ` (${n.total})` : '';
        return `<option value="${esc(n.value)}"${n.value === current ? ' selected' : ''}>${esc(n.name + suffix)}</option>`;
      }).join('');
    }

    if (folderSel) {
      const current = String(state.fileEventsFolderId || '');
      const currentNode = String(state.fileEventsNodeId || '');
      const byId = new Map();

      (state.overview.folders || []).forEach(f => {
        const nodeId = String(f.node_id || '');
        if (currentNode && nodeId !== currentNode) return;

        const value = String(f.id || '');
        if (!value || byId.has(value)) return;

        const baseLabel = String(f.label || value);
        const nodeLabel = currentNode ? '' : ` · ${String(f.node_name || 'Nodo')}`;
        byId.set(value, {
          value,
          label: baseLabel + nodeLabel,
          total: folderEventTotals.get(value) || 0,
        });
      });

      (filters.folders || []).forEach(f => {
        const value = String(f.folder_id || '');
        if (!value || byId.has(value)) return;
        byId.set(value, {
          value,
          label: String(f.folder_label || value),
          total: Number(f.total || 0),
        });
      });

      const folders = [...byId.values()].sort((a, b) =>
        a.label.localeCompare(b.label, navigator.language || 'es', { numeric: true, sensitivity: 'base' })
      );

      folderSel.innerHTML = '<option value="">Todas</option>' + folders.map(f => {
        const suffix = f.total > 0 ? ` (${f.total})` : '';
        return `<option value="${esc(f.value)}"${f.value === current ? ' selected' : ''}>${esc(f.label + suffix)}</option>`;
      }).join('');
    }

    if (actionSel) {
      const current = String(state.fileEventsAction || '');
      const seen = new Set();
      const options = [];
      (filters.types || []).forEach(t => {
        const action = String(t.action || '').trim();
        if (!action || seen.has(action)) return;
        seen.add(action);
        options.push({ action, total: Number(t.total || 0) });
      });
      actionSel.innerHTML = '<option value="">Todas</option>' + options.map(item =>
        `<option value="${esc(item.action)}"${item.action === current ? ' selected' : ''}>${esc(item.action)} (${item.total})</option>`
      ).join('');
    }
  }

  function originProbableHtml(ev) {
    const nodeName = String(ev?.origin_node_name || '').trim();
    const deviceName = String(ev?.origin_device_name || '').trim();
    const deviceId = String(ev?.origin_device_id || '').trim();
    const source = String(ev?.origin_source || '').trim();

    const label = nodeName || deviceName || (deviceId ? `${deviceId}…` : '');
    if (!label) return '<span class="text-muted">—</span>';

    const sourceLabel = source === 'LocalChangeDetected'
      ? 'cambio local'
      : (source === 'RemoteChangeDetected' ? 'modifiedBy' : 'probable');

    return `
      <span>${esc(label)}</span>
      <div class="small text-muted">${esc(sourceLabel)}${deviceId ? ` · ${esc(deviceId)}` : ''}</div>
    `;
  }

  function fileEventSortValue(ev, key) {
    if (!ev) return '';
    if (key === 'event_time') {
      const raw = ev.event_time || ev.observed_at || '';
      const d = raw ? new Date(raw) : null;
      return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
    }
    if (key === 'origin') {
      return ev.origin_node_name || ev.origin_device_name || ev.origin_device_id || '';
    }
    if (key === 'item_name') {
      return ev.item_name || ev.item_hash || '';
    }
    const value = ev[key];
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value == null) return '';
    return String(value).toLocaleLowerCase(navigator.language || 'es');
  }

  function sortFileEvents(items) {
    const sort = state.fileEventsSort || { key: 'event_time', dir: 'desc' };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const av = fileEventSortValue(a, sort.key);
      const bv = fileEventSortValue(b, sort.key);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), navigator.language || 'es', {
        numeric: true,
        sensitivity: 'base',
      }) * dir;
    });
  }

  function updateFileSortHeaders() {
    document.querySelectorAll('.st-file-sort[data-sort-key]').forEach(btn => {
      const key = btn.dataset.sortKey;
      const active = state.fileEventsSort && state.fileEventsSort.key === key;
      const icon = btn.querySelector('.st-file-sort-icon');
      btn.classList.toggle('fw-semibold', active);
      btn.setAttribute('aria-sort', active ? (state.fileEventsSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      if (icon) icon.textContent = active ? (state.fileEventsSort.dir === 'asc' ? '▲' : '▼') : '↕';
    });
  }

  function renderFileEvents() {
    const body = document.getElementById('st-file-events-body');
    if (!body) return;

    const data = state.fileEvents || {};
    const allItems = sortFileEvents(data.items || []);
    const summary = data.summary || {};
    const items = state.fileEventsExpanded ? allItems : allItems.slice(0, 2);

    setText('st-file-events-count', String(summary.total_returned ?? allItems.length));
    setText('st-file-events-privacy', summary.store_file_names ? (window.t?.('st.privacy_visible_days', 'sí · {days} días', { days: summary.file_name_retention_days || 7 }) || `sí · ${summary.file_name_retention_days || 7} días`) : (window.t?.('st.privacy_hidden', 'ocultos') || 'ocultos'));
    const toggle = document.getElementById('st-file-events-toggle');
    if (toggle) {
      const hidden = Math.max(0, allItems.length - 2);
      toggle.style.display = (!state.fileEventsExpanded && allItems.length > 2) ? '' : 'none';
      toggle.textContent = window.t?.('st.view_all_more', 'Ver todo ({count} más)', { count: hidden }) || `Ver todo (${hidden} más)`;
    }
    renderFileEventFilters();
    updateFileSortHeaders();

    if (!allItems.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-muted">Sin eventos de archivo para los filtros actuales.</td></tr>';
      return;
    }

    body.innerHTML = items.map(ev => {
      const confirmation = String(ev.confirmation || 'observed');
      const confirmationLabel = confirmation === 'observed' ? 'Observado' : confirmation;
      const action = String(ev.action || '—');
      const hasError = String(ev.error || '').trim();
      return `
        <tr>
          <td>${esc(fmtDateTime(ev.event_time || ev.observed_at))}</td>
          <td>${esc(ev.node_name || '—')}</td>
          <td>${originProbableHtml(ev)}</td>
          <td><strong>${esc(ev.folder_label || ev.folder_id || '—')}</strong><div class="small text-muted mono">${esc(ev.folder_id || '')}</div></td>
          <td>${eventFileLabel(ev)}</td>
          <td>${esc(ev.item_type || ev.event_type || '—')}</td>
          <td>
            <span class="badge text-bg-${hasError ? 'danger' : 'secondary'}">${esc(action)}</span>
            ${hasError ? `<div class="small text-danger">${esc(ev.error)}</div>` : ''}
          </td>
          <td><span class="badge text-bg-info">${esc(confirmationLabel)}</span></td>
        </tr>`;
    }).join('');

    const topToggle = document.getElementById('st-file-events-expanded-top');
    if (topToggle) {
      topToggle.classList.toggle('d-none', !state.fileEventsExpanded || allItems.length <= 2);
      topToggle.innerHTML = state.fileEventsExpanded
        ? `<button type="button" class="btn btn-sm btn-outline-info st-file-events-expand-inline">
             <i class="bi bi-chevron-up me-1"></i> Contraer historial
           </button>`
        : '';
    }

    if (!state.fileEventsExpanded && allItems.length > 2) {
      const hidden = Math.max(0, allItems.length - 2);
      body.insertAdjacentHTML('beforeend', `
        <tr class="st-file-events-more-row">
          <td colspan="8" class="text-center">
            <button type="button" class="btn btn-sm btn-outline-info st-file-events-expand-inline">
              <i class="bi bi-chevron-down me-1"></i> Expandir historial · mostrar ${hidden} eventos más
            </button>
          </td>
        </tr>
      `);
    }
  }

  async function loadFileEvents() {
    if (!document.getElementById('st-file-events-body')) return;

    const params = new URLSearchParams();
    params.set('hours', String(state.fileEventsHours || 168));
    params.set('limit', '200');
    if (state.fileEventsQ) params.set('q', state.fileEventsQ);
    if (state.fileEventsNodeId) params.set('node_id', state.fileEventsNodeId);
    if (state.fileEventsFolderId) params.set('folder_id', state.fileEventsFolderId);
    if (state.fileEventsAction) params.set('action', state.fileEventsAction);

    setText('st-file-events-status', 'Cargando…');
    try {
      const data = await apiJson(`/api/syncthing/file-events?${params.toString()}`);
      state.fileEvents = data || { items: [], summary: {}, filters: {} };
      renderFileEvents();
      setText('st-file-events-status', '');
    } catch (e) {
      setText('st-file-events-status', `Error: ${e.message || e}`);
    }
  }

  function setFileEventContext(filters) {
    state.fileEventsNodeId = filters?.nodeId ? String(filters.nodeId) : '';
    state.fileEventsFolderId = filters?.folderId ? String(filters.folderId) : '';
    const qEl = document.getElementById('st-file-events-q');
    const nodeEl = document.getElementById('st-file-events-node');
    const folderEl = document.getElementById('st-file-events-folder');
    if (qEl) qEl.value = state.fileEventsQ || '';
    if (nodeEl) nodeEl.value = state.fileEventsNodeId;
    if (folderEl) folderEl.value = state.fileEventsFolderId;
    loadFileEvents();
    document.getElementById('st-file-events-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function nextRefreshText() {
    const summary = state.overview.summary || {};
    const lastRaw = summary.last_refresh || state.overview.cache_refreshed_at || '';
    const intervalSeconds = Number(summary.refresh_interval_seconds || 60);
    if (!lastRaw) return '—';
    const last = new Date(lastRaw);
    if (Number.isNaN(last.getTime())) return '—';
    const nextMs = last.getTime() + Math.max(15, intervalSeconds) * 1000;
    const remaining = Math.max(0, Math.ceil((nextMs - Date.now()) / 1000));
    if (remaining <= 0) return 'en curso';
    if (remaining >= 60) {
      const m = Math.floor(remaining / 60);
      const sec = remaining % 60;
      return `${m}m ${String(sec).padStart(2, '0')}s`;
    }
    return `${remaining}s`;
  }

  function startCountdownLoop() {
    if (state.countdownTimer) return;
    state.countdownTimer = window.setInterval(() => {
      if (!isSyncthingActive()) return;
      setText('st-next-refresh-countdown', nextRefreshText());
    }, 1000);
  }

  async function renderSyncthingDashboardChart(hours, mode) {
    const rangeHours = Number(hours || state.dashboardChartHours || 24);
    const chartMode = String(mode || state.dashboardChartMode || 'rate');
    const chartMeta = transferChartMeta(chartMode);
    state.dashboardChartHours = rangeHours;
    state.dashboardChartMode = chartMeta.mode;

    const modeSlot = document.getElementById('st-dashboard-chart-mode-slot');
    if (modeSlot) modeSlot.innerHTML = chartModeButtons('dashboard', chartMeta.mode);
    const slot = document.getElementById('st-dashboard-chart-range-slot');
    if (slot) slot.innerHTML = dashboardRangeButtons(rangeHours);

    setText('st-dashboard-chart-samples', '—');
    setText('st-dashboard-chart-max-rx', '—');
    setText('st-dashboard-chart-max-tx', '—');
    setText('st-dashboard-chart-max-total', '—');

    try {
      const data = await apiJson(`/api/syncthing/transfer-chart?node_id=0&hours=${encodeURIComponent(rangeHours)}`);
      const points = data.points || [];
      const summary = data.summary || {};
      const maxRxKey = chartMeta.mode === 'bytes' ? 'max_rx_delta_bytes' : 'max_rx_bps';
      const maxTxKey = chartMeta.mode === 'bytes' ? 'max_tx_delta_bytes' : 'max_tx_bps';
      const maxTotalKey = chartMeta.mode === 'bytes' ? 'max_total_delta_bytes' : 'max_total_bps';

      const maxRx = Number(summary[maxRxKey] ?? Math.max(0, ...points.map(p => Number(p[chartMeta.rxKey] || 0))));
      const maxTx = Number(summary[maxTxKey] ?? Math.max(0, ...points.map(p => Number(p[chartMeta.txKey] || 0))));
      const maxTotal = Number(summary[maxTotalKey] ?? Math.max(0, ...points.map(p => Number(p[chartMeta.rxKey] || 0) + Number(p[chartMeta.txKey] || 0))));
      const sampleCount = Number(summary.raw_samples ?? summary.samples ?? points.length);

      setText('st-dashboard-chart-samples', String(sampleCount));
      setText('st-dashboard-chart-max-rx', chartMeta.formatter(maxRx));
      setText('st-dashboard-chart-max-tx', chartMeta.formatter(maxTx));
      setText('st-dashboard-chart-max-total', chartMeta.formatter(maxTotal));

      renderLineChart(
        'stDashboardTransferChart',
        'dashboard',
        points.map(item => chartLabelTime(item.observed_at)),
        [
          chartLineDataset('Entrada', points.map(item => Number(item[chartMeta.rxKey] || 0))),
          chartLineDataset('Salida', points.map(item => Number(item[chartMeta.txKey] || 0))),
        ],
        chartMeta.yTitle,
        chartMeta.formatter
      );
    } catch (e) {
      const wrap = document.getElementById('stDashboardTransferChart')?.closest('.st-chart-wrap');
      if (wrap) wrap.innerHTML = `<div class="alert alert-warning mb-0">${esc(e.message || String(e))}</div>`;
    }
  }

  function renderAll() {
    ensureShell();
    renderKpis();
    renderTransferFlows();
    renderNodes();
    renderFolders();
    renderFileEvents();
    updateSortHeaders();
  }

  function scheduleSyncthingDeltaRefresh() {
    const summary = state.overview?.summary || {};
    const syncing = Number(summary.nodes_syncing || 0);
    const transferring = Number(summary.nodes_transferring || 0);

    if (!syncing || transferring || state.syncRefreshTimer) return;

    state.syncRefreshTimer = window.setTimeout(() => {
      state.syncRefreshTimer = null;
      if (!isSyncthingActive() || state.busy) return;
      state.loaded = false;
      loadSyncthingControl(true);
    }, 7000);
  }

  async function loadSyncthingControl(force) {
    if (!document.getElementById('syncthingView')) return;
    ensureShell();
    if (state.busy) return;
    if (state.loaded && !force) return;

    state.busy = true;
    clearError();
    try {
      const url = force ? '/api/syncthing/overview?refresh=1' : '/api/syncthing/overview';
      const data = await apiJson(url);
      state.overview = data || { summary: {}, nodes: [], folders: [] };
      state.loaded = true;

      await loadFileEvents();

      renderAll();
      renderSyncthingDashboardChart(state.dashboardChartHours, state.dashboardChartMode);
      scheduleSyncthingDeltaRefresh();

      if (data?.cache_status === 'stale_after_error' && data?.cache_error) {
        showError(`Mostrando caché Syncthing; último refresco falló: ${data.cache_error}`);
      }
    } catch (e) {
      showError(e.message || String(e));
    } finally {
      state.busy = false;
    }
  }

  function isSyncthingActive() {
    return !!(
      document.getElementById('infra-syncthing-tab')?.classList.contains('active')
      || document.getElementById('infraSyncthing')?.classList.contains('show')
    );
  }

  function stFrontendRefreshMs() {
    return window.getFrontendRefreshMs('normal');
  }

  function startSoftRefreshLoop() {
    if (state.softRefreshTimer) return;
    state.softRefreshTimer = window.setInterval(() => {
      if (!isSyncthingActive() || state.busy) return;
      state.loaded = false;
      loadSyncthingControl(false);
    }, stFrontendRefreshMs());
  }

  document.addEventListener('frontendrefreshsettingschange', () => {
    if (!state.softRefreshTimer) return;
    clearInterval(state.softRefreshTimer);
    state.softRefreshTimer = null;
    startSoftRefreshLoop();
  });

  function activeNodeById(id) {
    return (state.overview.nodes || []).find(n => Number(n.id) === Number(id));
  }

  function resetNodeForm() {
    const form = document.getElementById('st-node-form');
    if (!form) return;
    form.reset();
    setText('st-node-msg', '');
    setText('st-node-form-title', 'Añadir nodo Syncthing');
    const id = document.getElementById('st-node-id');
    if (id) id.value = '';
    const timeout = document.getElementById('st-node-timeout');
    if (timeout) timeout.value = '8';
    const tls = document.getElementById('st-node-verify-tls');
    if (tls) tls.value = '0';
  }

  function showForm(show) {
    const modalEl = document.getElementById('stNodeFormModal');
    if (!modalEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    if (show) {
      modal.show();
    } else {
      modal.hide();
      resetNodeForm();
    }
  }

  function fillForm(node) {
    showForm(true);
    setText('st-node-form-title', `Editar nodo Syncthing · ${node.name || 'Nodo'}`);
    document.getElementById('st-node-id').value = node.id || '';
    document.getElementById('st-node-name').value = node.name || '';
    document.getElementById('st-node-api-url').value = node.api_base_url || '';
    document.getElementById('st-node-gui-url').value = node.gui_url || '';
    document.getElementById('st-node-api-key').value = '';
    document.getElementById('st-node-timeout').value = node.timeout_s || 8;
    document.getElementById('st-node-verify-tls').value = node.verify_tls ? '1' : '0';
    document.getElementById('st-node-notes').value = node.notes || '';
    setText('st-node-msg', node.api_key_configured ? 'Clave actual preservada si dejas API key vacía.' : '');
  }

  function normalizeSyncthingUrlInput(value, required, label) {
    let raw = String(value || '').trim();
    if (!raw) {
      return required
        ? { ok: false, value: '', error: `${label} es obligatoria.` }
        : { ok: true, value: '', error: '' };
    }

    raw = raw
      .replace('https.//', 'https://')
      .replace('http.//', 'http://');

    if (raw.startsWith('https:/') && !raw.startsWith('https://')) raw = raw.replace('https:/', 'https://');
    if (raw.startsWith('http:/') && !raw.startsWith('http://')) raw = raw.replace('http:/', 'http://');

    if (!raw.includes('://')) raw = `https://${raw}`;

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return { ok: false, value: '', error: `${label} no es una URL válida.` };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, value: '', error: `${label} debe empezar por http:// o https://.` };
    }

    if (!parsed.hostname) {
      return { ok: false, value: '', error: `${label} no contiene host válido.` };
    }

    return { ok: true, value: raw.replace(/\/+$/, ''), error: '' };
  }

  function probeSaveMessage(probeData) {
    const result = probeData?.result || {};
    const node = result.node || {};
    if (probeData?.ok && result.ok && node.status !== 'offline') {
      return `✓ Nodo guardado y conexión verificada (${node.status || 'online'}).`;
    }
    const err = result.error || probeData?.error || 'no responde ahora mismo';
    return `⚠ Nodo guardado, pero no se pudo verificar conexión: ${err}`;
  }

  async function saveNode(evt) {
    evt.preventDefault();

    const id = document.getElementById('st-node-id')?.value || '';
    const isNewNode = !id;

    const apiUrlCheck = normalizeSyncthingUrlInput(document.getElementById('st-node-api-url')?.value || '', true, 'URL API');
    if (!apiUrlCheck.ok) {
      setText('st-node-msg', apiUrlCheck.error);
      return;
    }

    const guiUrlCheck = normalizeSyncthingUrlInput(document.getElementById('st-node-gui-url')?.value || '', false, 'URL GUI');
    if (!guiUrlCheck.ok) {
      setText('st-node-msg', guiUrlCheck.error);
      return;
    }

    const apiUrlInput = document.getElementById('st-node-api-url');
    const guiUrlInput = document.getElementById('st-node-gui-url');
    if (apiUrlInput) apiUrlInput.value = apiUrlCheck.value;
    if (guiUrlInput) guiUrlInput.value = guiUrlCheck.value;

    const payload = {
      name: document.getElementById('st-node-name')?.value || '',
      api_base_url: apiUrlCheck.value,
      gui_url: guiUrlCheck.value,
      api_key: document.getElementById('st-node-api-key')?.value || '',
      timeout_s: document.getElementById('st-node-timeout')?.value || '8',
      verify_tls: document.getElementById('st-node-verify-tls')?.value === '1',
      enabled: true,
      notes: document.getElementById('st-node-notes')?.value || '',
    };

    try {
      setText('st-node-msg', 'Guardando…');
      const saved = await apiJson(id ? `/api/syncthing/nodes/${encodeURIComponent(id)}` : '/api/syncthing/nodes', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let postSaveMsg = '✓ Nodo guardado.';
      if (isNewNode && saved?.id) {
        setText('st-node-msg', 'Nodo guardado. Verificando conexión…');
        try {
          const probeData = await apiJson(`/api/syncthing/nodes/${encodeURIComponent(saved.id)}/probe`, { method: 'POST' });
          postSaveMsg = probeSaveMessage(probeData);
        } catch (probeErr) {
          postSaveMsg = `⚠ Nodo guardado, pero no se pudo verificar conexión: ${probeErr.message || probeErr}`;
        }
      }

      showForm(false);
      state.loaded = false;
      await loadSyncthingControl(true);
      showError(postSaveMsg);
    } catch (e) {
      setText('st-node-msg', e.message || String(e));
    }
  }

  function askDeleteNode(id) {
    const node = activeNodeById(id);
    state.pendingDeleteId = id;
    ensureDeleteModal();
    setText('st-delete-name', node?.name || `Nodo #${id}`);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('stDeleteModal')).show();
  }

  function bindEvents() {
    document.getElementById('infra-syncthing-tab')?.addEventListener('shown.bs.tab', () => loadSyncthingControl(false));
    document.getElementById('infra-tab')?.addEventListener('shown.bs.tab', () => {
      if (document.getElementById('infraSyncthing')?.classList.contains('show')) loadSyncthingControl(false);
    });
    document.getElementById('st-btn-refresh')?.addEventListener('click', () => loadSyncthingControl(true));

    document.addEventListener('click', ev => {
      const btn = ev.target.closest('#st-folder-chart-ranges button[data-hours]');
      if (!btn) return;
      const active = state.activeHistoryFolder || {};
      if (!active.nodeId || !active.folderId) return;
      openFolderHistory(active.nodeId, active.folderId, Number(btn.dataset.hours || 24));
    });

    document.addEventListener('click', ev => {
      const btn = ev.target.closest('#st-node-chart-ranges button[data-hours]');
      if (!btn) return;
      const active = state.activeNodeChart || {};
      if (!active.nodeId) return;
      openNodeChart(active.nodeId, Number(btn.dataset.hours || 24), active.mode || state.nodeChartMode);
    });

    document.addEventListener('click', ev => {
      const btn = ev.target.closest('#st-node-chart-modes button[data-mode]');
      if (!btn) return;
      const active = state.activeNodeChart || {};
      if (!active.nodeId) return;
      openNodeChart(active.nodeId, active.hours || 24, btn.dataset.mode || 'rate');
    });

    document.addEventListener('click', ev => {
      const btn = ev.target.closest('#st-dashboard-chart-ranges button[data-hours]');
      if (!btn) return;
      renderSyncthingDashboardChart(Number(btn.dataset.hours || 24), state.dashboardChartMode);
    });

    document.addEventListener('click', ev => {
      const btn = ev.target.closest('#st-dashboard-chart-modes button[data-mode]');
      if (!btn) return;
      renderSyncthingDashboardChart(state.dashboardChartHours, btn.dataset.mode || 'rate');
    });

    document.addEventListener('click', function (ev) {
      const add = ev.target.closest('#st-toggle-node-form');
      if (add) {
        resetNodeForm();
        showForm(true);
        return;
      }

      const cancel = ev.target.closest('#st-node-cancel');
      if (cancel) {
        showForm(false);
        return;
      }

      const chart = ev.target.closest('.st-node-chart');
      if (chart) {
        openNodeChart(Number(chart.dataset.id), 24);
        return;
      }

      const nodeEvents = ev.target.closest('.st-node-events');
      if (nodeEvents) {
        setFileEventContext({ nodeId: nodeEvents.dataset.id });
        return;
      }

      const edit = ev.target.closest('.st-edit-node');
      if (edit) {
        const node = activeNodeById(edit.dataset.id);
        if (node) fillForm(node);
        return;
      }

      const del = ev.target.closest('.st-delete-node');
      if (del) {
        askDeleteNode(del.dataset.id);
        return;
      }

      const hist = ev.target.closest('.st-folder-history');
      if (hist) {
        openFolderHistory(hist.dataset.nodeId, hist.dataset.folderId);
        return;
      }

      const folderEvents = ev.target.closest('.st-folder-events');
      if (folderEvents) {
        setFileEventContext({ nodeId: folderEvents.dataset.nodeId, folderId: folderEvents.dataset.folderId });
        return;
      }

      const sortBtn = ev.target.closest('.st-sort[data-sort-scope][data-sort-key]');
      if (sortBtn) {
        const scope = sortBtn.dataset.sortScope;
        updateSort(scope, sortBtn.dataset.sortKey);
        if (scope === 'nodes') renderNodes();
        if (scope === 'folders') renderFolders();
        updateSortHeaders();
        return;
      }

      const nodeFilter = ev.target.closest('#st-node-filter button[data-filter]');
      if (nodeFilter) {
        document.querySelectorAll('#st-node-filter button').forEach(b => b.classList.remove('active'));
        nodeFilter.classList.add('active');
        state.nodeFilter = nodeFilter.dataset.filter || 'all';
        renderNodes();
        return;
      }

      const transferToggle = ev.target.closest('#st-transfer-flow-toggle');
      const transferCard = transferToggle ? null : ev.target.closest('#st-transfer-compact-card');
      if (transferToggle || (transferCard && !ev.target.closest('#st-transfer-flow-list'))) {
        ev.preventDefault();
        state.transferFlowsExpanded = !state.transferFlowsExpanded;
        renderTransferFlows();
        return;
      }

      const fileSort = ev.target.closest('.st-file-sort[data-sort-key]');
      if (fileSort) {
        const key = fileSort.dataset.sortKey;
        const current = state.fileEventsSort || { key: 'event_time', dir: 'desc' };
        state.fileEventsSort = {
          key,
          dir: current.key === key ? (current.dir === 'asc' ? 'desc' : 'asc') : (key === 'event_time' ? 'desc' : 'asc'),
        };
        renderFileEvents();
        return;
      }

      const fileToggle = ev.target.closest('#st-file-events-toggle, .st-file-events-expand-inline');
      if (fileToggle) {
        state.fileEventsExpanded = !state.fileEventsExpanded;
        renderFileEvents();
        return;
      }

      const fileTable = ev.target.closest('#st-file-events-table');
      if (fileTable && !ev.target.closest('button, a, select, input')) {
        const total = (state.fileEvents?.items || []).length;
        if (total > 2) {
          state.fileEventsExpanded = !state.fileEventsExpanded;
          renderFileEvents();
        }
        return;
      }

      const fileRefresh = ev.target.closest('#st-file-events-refresh');
      if (fileRefresh) {
        loadFileEvents();
        return;
      }

      const fileClear = ev.target.closest('#st-file-events-clear');
      if (fileClear) {
        state.fileEventsQ = '';
        state.fileEventsNodeId = '';
        state.fileEventsFolderId = '';
        state.fileEventsAction = '';
        state.fileEventsHours = 168;
        ['st-file-events-q', 'st-file-events-node', 'st-file-events-folder', 'st-file-events-action'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        const hours = document.getElementById('st-file-events-hours');
        if (hours) hours.value = '168';
        loadFileEvents();
        return;
      }

      const folderFilter = ev.target.closest('#st-folder-filter button[data-filter]');
      if (folderFilter) {
        document.querySelectorAll('#st-folder-filter button').forEach(b => b.classList.remove('active'));
        folderFilter.classList.add('active');
        state.folderFilter = folderFilter.dataset.filter || 'all';
        renderFolders();
      }
    });

    document.addEventListener('submit', function (ev) {
      if (ev.target && ev.target.id === 'st-node-form') saveNode(ev);
    });

    document.addEventListener('input', function (ev) {
      if (ev.target && ev.target.id === 'st-search') {
        state.q = ev.target.value || '';
        renderNodes();
        renderFolders();
      }

      if (ev.target && ev.target.id === 'st-file-events-q') {
        state.fileEventsQ = ev.target.value || '';
        window.clearTimeout(state.fileEventsSearchTimer);
        state.fileEventsSearchTimer = window.setTimeout(loadFileEvents, 250);
      }
    });

    document.addEventListener('change', function (ev) {
      if (!ev.target) return;

      if (ev.target.id === 'st-file-events-hours') {
        state.fileEventsHours = Number(ev.target.value || 168);
        loadFileEvents();
      }

      if (ev.target.id === 'st-file-events-node') {
        state.fileEventsNodeId = ev.target.value || '';
        loadFileEvents();
      }

      if (ev.target.id === 'st-file-events-folder') {
        state.fileEventsFolderId = ev.target.value || '';
        loadFileEvents();
      }

      if (ev.target.id === 'st-file-events-action') {
        state.fileEventsAction = ev.target.value || '';
        loadFileEvents();
      }
    });

    setTimeout(() => {
      if (isSyncthingActive()) loadSyncthingControl(false);
      startSoftRefreshLoop();
      startCountdownLoop();
    }, 0);
  }

  window.loadSyncthingControl = loadSyncthingControl;
  document.addEventListener('DOMContentLoaded', bindEvents);
})();
