/**
 * Signals Tab — Variant 3 (Hybrid: table + detail panel)
 * Fetches live signals from /api/signals/live, renders table + detail
 */

const SIG_API = window.location.origin
const SIG_REFRESH_MS = 30_000 // auto-refresh every 30s

const sigState = {
  signals: [],
  selected: null,
  typeFilter: '',
  dirFilter: '',
  search: '',
  refreshTimer: null,
  active: false,
}

// ---- DOM helpers ----
const sigEl = (id) => document.getElementById(id)

// ---- Init (called from densities.js tab switch) ----
function initSignals() {
  if (sigState.active) { loadSignals(); return }
  sigState.active = true

  // Bind filters
  const typeF = sigEl('sigTypeFilter')
  const dirF = sigEl('sigDirFilter')
  const searchF = sigEl('sigSearch')

  if (typeF) typeF.onchange = () => { sigState.typeFilter = typeF.value; loadSignals() }
  if (dirF) dirF.onchange = () => { sigState.dirFilter = dirF.value; loadSignals() }
  if (searchF) searchF.oninput = () => { sigState.search = searchF.value; renderSignals() }

  loadSignals()
  sigState.refreshTimer = setInterval(loadSignals, SIG_REFRESH_MS)
}

function stopSignals() {
  sigState.active = false
  if (sigState.refreshTimer) {
    clearInterval(sigState.refreshTimer)
    sigState.refreshTimer = null
  }
}

// ---- Fetch ----
async function loadSignals() {
  try {
    const params = new URLSearchParams({ limit: '100' })
    if (sigState.typeFilter) params.set('type', sigState.typeFilter)
    if (sigState.dirFilter) params.set('direction', sigState.dirFilter)

    const [liveRes, summaryRes] = await Promise.all([
      fetch(`${SIG_API}/api/signals/live?${params}`).then(r => r.json()),
      fetch(`${SIG_API}/api/signals/summary`).then(r => r.json()),
    ])

    if (liveRes.success) sigState.signals = liveRes.data || []
    if (summaryRes.success) renderSummary(summaryRes)
    renderSignals()
  } catch (err) {
    console.error('[Signals] Load error:', err)
  }
}

// ---- Summary bar ----
function renderSummary(data) {
  const el = sigEl('sigSummary')
  if (!el) return

  const types = data.types || []
  const byType = data.by_type || {}

  el.innerHTML = types.map(t => {
    const count = byType[t.id] || 0
    return `<span class="sig-summary-item">
      <span class="sig-summary-dot" style="background:${t.color}"></span>
      ${t.icon} <span class="sig-summary-count">${count}</span>
    </span>`
  }).join('') + `<span class="sig-summary-item" style="margin-left:8px;">Total: <span class="sig-summary-count">${data.last_1h || 0}</span>/1h</span>`
}

// ---- Table ----
function renderSignals() {
  const tbody = sigEl('sigTbody')
  if (!tbody) return

  let list = [...sigState.signals]

  // Client-side search filter
  if (sigState.search) {
    const q = sigState.search.toUpperCase()
    list = list.filter(s => s.symbol.includes(q))
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-muted);">No signals yet — scanner runs every 60s</td></tr>`
    return
  }

  tbody.innerHTML = list.map(s => {
    const isActive = sigState.selected?.id === s.id ? ' sig-active' : ''
    const confColor = s.confidence >= 80 ? '#22c55e' : s.confidence >= 60 ? '#f59e0b' : '#ef4444'
    const typeLabel = formatType(s.type)

    return `<tr class="${isActive}" data-sig-id="${s.id}" onclick="selectSignal('${s.id}')">
      <td class="sig-time">${formatTime(s.created_at)}</td>
      <td><span class="sig-type-badge ${s.type}">${typeLabel}</span></td>
      <td class="sig-symbol">${s.symbol.replace('USDT', '')}</td>
      <td><span class="sig-dir ${s.direction}">${s.direction === 'LONG' ? '▲ L' : '▼ S'}</span></td>
      <td style="font-variant-numeric:tabular-nums;">${formatPrice(s.price)}</td>
      <td>
        <span class="sig-conf-text" style="color:${confColor}">${s.confidence}%</span>
        <span class="sig-conf-bar" style="width:${s.confidence * 0.5}px; background:${confColor};"></span>
      </td>
      <td class="sig-desc-col" style="color:var(--text-muted); font-size:11px;">${s.description || ''}</td>
    </tr>`
  }).join('')
}

// ---- Detail Panel ----
function selectSignal(id) {
  const s = sigState.signals.find(x => x.id === id)
  if (!s) return
  sigState.selected = s

  // Highlight row
  const tbody = sigEl('sigTbody')
  if (tbody) {
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('sig-active'))
    const row = tbody.querySelector(`tr[data-sig-id="${id}"]`)
    if (row) row.classList.add('sig-active')
  }

  const panel = sigEl('sigDetail')
  if (!panel) return

  const meta = s.metadata || {}
  const confColor = s.confidence >= 80 ? '#22c55e' : s.confidence >= 60 ? '#f59e0b' : '#ef4444'

  // Build metadata grid items
  const metaItems = []
  if (meta.change !== undefined) metaItems.push({ key: 'Change 24h', val: `${meta.change > 0 ? '+' : ''}${Number(meta.change).toFixed(2)}%`, color: meta.change > 0 ? '#22c55e' : '#ef4444' })
  if (meta.volume !== undefined) metaItems.push({ key: 'Volume', val: fmtVol(meta.volume) })
  if (meta.volX !== undefined) metaItems.push({ key: 'Vol / Median', val: `${meta.volX}x` })
  if (meta.natr !== undefined) metaItems.push({ key: 'NATR', val: `${meta.natr}%` })
  if (meta.high !== undefined) metaItems.push({ key: 'High', val: formatPrice(meta.high) })
  if (meta.low !== undefined) metaItems.push({ key: 'Low', val: formatPrice(meta.low) })
  if (meta.wallPrice !== undefined) metaItems.push({ key: 'Wall Price', val: formatPrice(meta.wallPrice) })
  if (meta.notional !== undefined) metaItems.push({ key: 'Wall Size', val: `$${fmtVol(meta.notional)}` })
  if (meta.side !== undefined) metaItems.push({ key: 'Side', val: meta.side })
  if (meta.distPct !== undefined) metaItems.push({ key: 'Distance', val: `${meta.distPct}%` })

  panel.innerHTML = `
    <div class="sig-detail-header">
      <span class="sig-type-badge ${s.type}" style="font-size:13px;">${formatType(s.type)}</span>
      <span class="sig-detail-symbol">${s.symbol.replace('USDT', '')}</span>
      <span class="sig-dir ${s.direction}" style="font-size:13px;">${s.direction}</span>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Price</div>
      <div class="sig-detail-price">${formatPrice(s.price)} USDT</div>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Confidence</div>
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="flex:1; height:6px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;">
          <div style="width:${s.confidence}%; height:100%; background:${confColor}; border-radius:3px;"></div>
        </div>
        <span style="font-size:14px; font-weight:600; color:${confColor}">${s.confidence}%</span>
      </div>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Description</div>
      <div class="sig-detail-value">${s.description || '—'}</div>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Details</div>
      <div class="sig-detail-meta">
        ${metaItems.map(m => `
          <div class="sig-detail-meta-item">
            <div class="sig-detail-meta-key">${m.key}</div>
            <div class="sig-detail-meta-val" ${m.color ? `style="color:${m.color}"` : ''}>${m.val}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Time</div>
      <div class="sig-detail-value">${new Date(s.created_at).toLocaleString()}</div>
    </div>

    <button class="sig-detail-btn" onclick="openSignalChart('${s.symbol}')">Open Chart</button>
  `
}

// ---- Open Chart (reuse mini-charts modal) ----
function openSignalChart(symbol) {
  if (typeof openCoinModal === 'function') {
    // Switch to mini-charts tab and open modal
    const tabs = document.querySelectorAll('.tab')
    tabs.forEach(t => t.classList.remove('active'))
    const mcTab = document.querySelector('.tab[data-tab="mini-charts"]')
    if (mcTab) {
      mcTab.classList.add('active')
      document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none')
      const mcContent = document.getElementById('tab-mini-charts')
      if (mcContent) mcContent.style.display = 'block'
      if (typeof initMiniCharts === 'function') initMiniCharts()
    }
    // Small delay to ensure mini-charts is initialized
    setTimeout(() => openCoinModal(symbol), 200)
  }
}

// ---- Formatters ----
function formatType(type) {
  const map = {
    volume_spike: '📊 Vol Spike',
    big_mover: '🚀 Big Mover',
    natr_spike: '⚡ NATR Spike',
    density_break: '🧱 Density',
  }
  return map[type] || type
}

function formatTime(iso) {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatPrice(p) {
  if (!p || p === 0) return '—'
  if (p >= 1000) return p.toFixed(1)
  if (p >= 100) return p.toFixed(2)
  if (p >= 1) return p.toFixed(3)
  if (p >= 0.01) return p.toFixed(4)
  if (p >= 0.001) return p.toFixed(5)
  return p.toFixed(6)
}

function fmtVol(v) {
  if (!v) return '—'
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K'
  return '$' + v.toFixed(0)
}
