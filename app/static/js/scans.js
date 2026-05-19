// ════════════════════════════════════════════════════════
//  scans.js — Auditor IPs · Ejecuciones (Scans)
//  Tabla scans, diff visual, notas inline, scan manual
// ════════════════════════════════════════════════════════
$(function() {
  // ══════════════════════════════════════════════════════════
  // SCAN DIFF — enriquecer tabla de scans con diff visual
  // ══════════════════════════════════════════════════════════
  const _origLoadScans = loadScans;
  let _scanRangeDays = 7;

  function _parseScanDate(row) {
    const raw = row?.started_at || row?.finished_at || '';
    const d = raw ? new Date(raw) : null;
    return d && !isNaN(d.getTime()) ? d : null;
  }

  function _filterScansByRange(rows) {
    const days = parseInt(_scanRangeDays || 7, 10);
    if (days >= 30) return rows;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return rows.filter(r => { const d = _parseScanDate(r); return !d || d.getTime() >= cutoff; });
  }

  let _activityChart = null;

  function _chartBucketMs() {
    const days = parseInt(_scanRangeDays || 7, 10);
    if (days <= 1) return 10 * 60 * 1000;      // 10 min
    if (days <= 7) return 60 * 60 * 1000;      // 1 h
    return 6 * 60 * 60 * 1000;                 // 6 h
  }

  function _aggregateChartRows(rows) {
    const bucketMs = _chartBucketMs();
    const buckets = new Map();

    for (const r of (Array.isArray(rows) ? rows : [])) {
      const raw = r?.finished_at || r?.started_at || '';
      const ts = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;

      const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      const key = String(bucketTs);
      const item = buckets.get(key) || {
        ts: bucketTs,
        onlineSum: 0,
        offlineSum: 0,
        count: 0,
      };

      item.onlineSum += Number(r.online_hosts || 0);
      item.offlineSum += Number(r.offline_hosts || 0);
      item.count += 1;
      buckets.set(key, item);
    }

    return Array.from(buckets.values())
      .sort((a, b) => a.ts - b.ts)
      .map(item => ({
        ts: item.ts,
        online_avg: Number((item.onlineSum / Math.max(1, item.count)).toFixed(1)),
        offline_avg: Number((item.offlineSum / Math.max(1, item.count)).toFixed(1)),
        sample_count: item.count,
      }));
  }

  function _formatChartLabel(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';

    if (_scanRangeDays <= 1 && typeof window.fmtTime === 'function') {
      return window.fmtTime(ts);
    }
    if (_scanRangeDays <= 7 && typeof window.fmtDateTime === 'function') {
      return window.fmtDateTime(ts);
    }
    if (typeof window.fmtDate === 'function') {
      return window.fmtDate(ts);
    }
    return '';
  }

  function buildChart(points, meta = {}) {
    const canvas = document.getElementById('activityChart');
    const subtitle = document.getElementById('chartSubtitle');
    if (!canvas || typeof Chart === 'undefined') return;

    const safePoints = Array.isArray(points) ? points : [];
    const labels = [];
    const onlineValues = [];
    const offlineValues = [];

    for (const p of safePoints) {
      const raw = p?.bucket_start || '';
      const ts = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;

      labels.push(_formatChartLabel(ts));
      onlineValues.push(Number(p.online_avg || 0));
      offlineValues.push(Number(p.offline_avg || 0));
    }

    if (_activityChart) {
      try { _activityChart.destroy(); } catch (_) {}
      _activityChart = null;
    }

    _activityChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Online',
            data: onlineValues,
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 2
          },
          {
            label: 'Offline',
            data: offlineValues,
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}`
            }
          }
        },
        scales: {
          x: {
            ticks: {
              autoSkip: true,
              maxTicksLimit: (_scanRangeDays <= 1 ? 8 : (_scanRangeDays <= 7 ? 10 : 12)),
              maxRotation: 0,
              minRotation: 0
            }
          },
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0
            }
          }
        }
      }
    });

    if (subtitle) {
      subtitle.textContent = safePoints.length
        ? `${safePoints.length} puntos medios · ${meta.totalScans ?? '—'} ejecuciones`
        : 'Sin datos';
    }

    window._activityChart = _activityChart;
  }

  function _ensureScanRangeControls() {
    if (document.getElementById('scanRangeControls')) return;
    const wrap = document.createElement('div');
    wrap.id = 'scanRangeControls';
    wrap.className = 'btn-group btn-group-sm ms-auto';
    wrap.innerHTML = `
      <button class="btn btn-outline-secondary active" data-range="1">1 día</button>
      <button class="btn btn-outline-secondary" data-range="7">7 días</button>
      <button class="btn btn-outline-secondary" data-range="30">1 mes</button>`;
    const target = document.querySelector('#hostsScans .d-flex.flex-wrap.gap-2.mb-2');
    if (target) target.appendChild(wrap);
    $(document).on('click', '#scanRangeControls [data-range]', async function () {
      _scanRangeDays = parseInt(this.dataset.range || '7', 10);
      $('#scanRangeControls .btn').removeClass('active');
      $(this).addClass('active');
      await window.loadScansWithDiff();
    });
    $('#scanRangeControls [data-range="7"]').addClass('active');
    $('#scanRangeControls [data-range="1"]').removeClass('active');
  }
  window.loadScansWithDiff = async function loadScansWithDiff() {
    const trace = `scans-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const perfStart = performance.now();
    setLoading(true);
    $('#scanStatus').text('');
    _ensureScanRangeControls();
    try {
      const [rawRows, chartPayload] = await Promise.all([
        fetch(`/api/scans?days=${encodeURIComponent(_scanRangeDays)}&trace=${encodeURIComponent(trace)}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/scans/chart?days=${encodeURIComponent(_scanRangeDays)}&trace=${encodeURIComponent(trace)}`, { cache: 'no-store' })
          .then(r => r.json())
          .catch(() => ({ ok: false, points: [], total_scans: 0 }))
      ]);

      const rows = Array.isArray(rawRows) ? rawRows : [];
      const tableLimit = _scanRangeDays <= 1 ? 120 : (_scanRangeDays <= 7 ? 300 : 700);
      const rowsForTable = rows.slice(0, tableLimit);
      const tbody = [];
      for (const r of rowsForTable) {
        const appeared = (r.appeared || []).map(h => `<span class="diff-badge new">+${esc(h.name||h.ip)}</span>`).join(' ');
        const disappeared = (r.disappeared || []).map(h => `<span class="diff-badge gone">-${esc(h.name||h.ip)}</span>`).join(' ');
        const diffCell = [appeared, disappeared].filter(Boolean).join(' ');
        const hasChange = !!diffCell || Number(r.new_hosts || 0) > 0 || Number(r.events_sent || 0) > 0;
        const hasNote = r.notes && r.notes.trim();
        if (!hasChange && !hasNote) continue;
        const noteBtn = `<button class="btn btn-sm scan-note-btn ${hasNote ? 'text-warning' : 'text-muted'}" data-id="${r.id}" data-note="${esc(r.notes||'')}" title="${esc(r.notes||'Sin nota — click para añadir')}"><span>${hasNote ? '💬' : '📝'}</span></button>`;
        tbody.push([
          esc(r.id ?? ''),
          esc(r.started_at ?? ''),
          esc(r.finished_at ?? ''),
          esc(r.cidr ?? ''),
          esc(r.online_hosts ?? ''),
          esc(r.offline_hosts ?? ''),
          esc(r.new_hosts ?? ''),
          esc(r.events_sent ?? ''),
          (r.discord_sent ? '✅' : '—'),
          diffCell || '—',
          noteBtn,
        ]);
      }
      const tTable0 = performance.now();
      scansTable.clear();
      scansTable.rows.add(tbody).draw();
      const tTable1 = performance.now();

      if (typeof buildChart === 'function') {
        buildChart(chartPayload?.points || [], { totalScans: chartPayload?.total_scans ?? rows.length });
      }
      const tChart1 = performance.now();

      setLoading(false);
      $('#scanStatus').text(
        rows.length > rowsForTable.length
          ? `Mostrando últimas ${rowsForTable.length} de ${rows.length} ejecuciones en la tabla.`
          : ''
      );

      const tracePayload = {
        trace,
        days: _scanRangeDays,
        total_ms: Math.round((tChart1 - perfStart) * 10) / 10,
        table_ms: Math.round((tTable1 - tTable0) * 10) / 10,
        chart_ms: Math.round((tChart1 - tTable1) * 10) / 10,
        rows: rows.length,
        points: Array.isArray(chartPayload?.points) ? chartPayload.points.length : 0
      };

      try {
        fetch('/api/scans/ui-trace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tracePayload)
        }).catch(() => {});
      } catch (_) {}

      try {
        console.log('[trace][scans][ui]', tracePayload);
      } catch (_) {}
    } catch (e) {
      setLoading(false);
      $('#scanStatus').text('Error cargando ejecuciones: ' + e.message);
    }
  }
  // Override global loadScans
  window.loadScans = loadScansWithDiff;
  document.getElementById('scans-tab').removeEventListener('shown.bs.tab', _origLoadScans);

  async function _loadScansActiveView() {
    await loadScansWithDiff();
    setTimeout(() => { if (window._activityChart) window._activityChart.resize(); }, 100);
  }

  document.getElementById('scans-tab').addEventListener('shown.bs.tab', _loadScansActiveView);

  if (document.getElementById('hosts-scans-tab')?.classList.contains('active')) {
    _loadScansActiveView();
  }

  $('#refreshScans').off('click').on('click', loadScansWithDiff);

  // ══════════════════════════════════════════════════════════
  // TEMA DE COLOR (accent swatches)
  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════
  // INLINE HOST NAME EDITING — double-click on name cell
  // ══════════════════════════════════════════════════════════
  $(document).on('dblclick', '.host-name-editable', function(e) {
    e.stopPropagation();
    const $el  = $(this);
    const ip   = $el.data('ip');
    if ($el.hasClass('editing')) return;
    // Usar data-manual como fuente de verdad (puede ser '' si no tiene nombre manual)
    const currentManual = $el.data('manual') !== undefined ? String($el.data('manual')) : '';
    $el.addClass('editing').attr('contenteditable', 'true')
       .attr('placeholder', 'Escribir nombre…').text(currentManual).focus();
    const range = document.createRange();
    range.selectNodeContents(this);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    async function saveInline() {
      const newName = $el.text().trim();
      $el.removeClass('editing').removeAttr('contenteditable').removeAttr('placeholder');
      if (newName === currentManual) {
        if (!currentManual) {
          const fallback = $el.closest('tr').find('.sub-name').text() || ip;
          $el.text(fallback);
        }
        return;
      }
      try {
        const det = await (await fetch(`/api/hosts/${encodeURIComponent(ip)}/detail`)).json();
        if (!det.ok) { showToast(window.t?.('scans.host_data_error', 'Error al obtener datos del host') || 'Error al obtener datos del host', 'danger'); return; }
        const h = det.host;
        const res = await fetch(`/api/hosts/${encodeURIComponent(ip)}`, {
          method: 'PUT',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ manual_name: newName, type_id: h.type_id || null, notes: h.notes || '' })
        });
        if ((await res.json()).ok) {
          const fallback = h.nmap_hostname || h.dns_name || '';
          const displayName = newName || fallback || ip;
          $el.data('manual', newName).text(displayName);
          const $td = $el.closest('td');
          $td.find('.sub-name').remove();
          if (newName && fallback) $td.append(`<div class="sub-name">${$('<span>').text(fallback).html()}</div>`);
          $el.closest('tr').find('td.manual-name-hidden').text(newName);
          if (hostsTable) hostsTable.draw(false);
          showToast(window.t?.('scans.name_updated', '✏️ Nombre actualizado: {name}', { name: newName || (window.t?.('scans.name_cleared', '(borrado)') || '(borrado)') }) || `✏️ Nombre actualizado: ${newName || '(borrado)'}`, 'success');
        } else {
          $el.text(currentManual || h.nmap_hostname || h.dns_name || ip);
        }
      } catch(err) {
        $el.text(currentManual);
        showToast(window.t?.('scans.name_save_error', 'Error al guardar nombre') || 'Error al guardar nombre', 'danger');
      }
    }

    $el.on('blur.inline', function() {
      $el.off('blur.inline keydown.inline');
      saveInline();
    }).on('keydown.inline', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); this.blur(); }
      if (ev.key === 'Escape') {
        $el.off('blur.inline keydown.inline').removeClass('editing').removeAttr('contenteditable').removeAttr('placeholder');
        $el.text(currentManual || $el.closest('tr').find('td.manual-name-hidden').text() || ip);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // IP RANGE SEARCH
  // ══════════════════════════════════════════════════════════

}); // end $(function) — scans.js
