/**
 * Signals Tab — Variant 3 (Hybrid: table + detail panel)
 * Fetches live signals + outcome stats
 */

const SIG_API = window.location.origin
const SIG_REFRESH_MS = 30_000

const sigState = {
  signals: [],
  selected: null,
  outcomes: [],
  typeFilter: '',
  dirFilter: '',
  search: '',
  refreshTimer: null,
  active: false,
}

const sigEl = (id) => document.getElementById(id)

// ---- Init / Stop ----
function initSignals() {
  if (sigState.active) { loadSignals(); return }
  sigState.active = true

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

    const [liveRes, summaryRes, outcomesRes] = await Promise.all([
      fetch(`${SIG_API}/api/signals/live?${params}`).then(r => r.json()),
      fetch(`${SIG_API}/api/signals/summary`).then(r => r.json()),
      fetch(`${SIG_API}/api/signals/outcomes`).then(r => r.json()),
    ])

    if (liveRes.success) sigState.signals = liveRes.data || []
    if (outcomesRes.success) sigState.outcomes = outcomesRes.stats || []
    if (summaryRes.success) renderSummary(summaryRes)
    renderSignals()
    renderOutcomeStats()
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

// ---- Outcome Stats ----
function renderOutcomeStats() {
  const container = sigEl('sigOutcomeStats')
  if (!container) return

  const stats = sigState.outcomes
  if (!stats || stats.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted); font-size:11px;">Outcome tracking: collecting data...</span>'
    return
  }

  container.innerHTML = stats.map(s => {
    const wr = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : '—'
    const wrColor = wr >= 55 ? '#22c55e' : wr >= 45 ? '#f59e0b' : '#ef4444'
    const avgPnl = s.avg_pnl != null ? (s.avg_pnl > 0 ? '+' : '') + s.avg_pnl.toFixed(2) + '%' : '—'
    const pnlColor = s.avg_pnl > 0 ? '#22c55e' : '#ef4444'
    const icon = { volume_spike: '📊', big_mover: '🚀', natr_spike: '⚡' }[s.type] || '•'

    return `<div class="sig-outcome-card">
      <div class="sig-outcome-type">${icon} ${formatTypeShort(s.type)}</div>
      <div class="sig-outcome-row">
        <span>WR</span><span style="color:${wrColor}; font-weight:600;">${wr}%</span>
      </div>
      <div class="sig-outcome-row">
        <span>Avg P&L</span><span style="color:${pnlColor}; font-weight:600;">${avgPnl}</span>
      </div>
      <div class="sig-outcome-row">
        <span>Signals</span><span>${s.total}</span>
      </div>
    </div>`
  }).join('')
}

// ---- Table ----
function renderSignals() {
  const tbody = sigEl('sigTbody')
  if (!tbody) return

  let list = [...sigState.signals]

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

  const metaItems = []
  if (meta.change !== undefined) metaItems.push({ key: 'Change 24h', val: `${meta.change > 0 ? '+' : ''}${Number(meta.change).toFixed(2)}%`, color: meta.change > 0 ? '#22c55e' : '#ef4444' })
  if (meta.volume !== undefined) metaItems.push({ key: 'Volume', val: fmtVol(meta.volume) })
  if (meta.volX !== undefined) metaItems.push({ key: 'Vol / Median', val: `${meta.volX}x` })
  if (meta.volDelta !== undefined && meta.volDelta > 0) metaItems.push({ key: 'Vol Δ', val: `+${meta.volDelta}%`, color: '#3b82f6' })
  if (meta.natr !== undefined) metaItems.push({ key: 'NATR', val: `${meta.natr}%` })
  if (meta.range !== undefined) metaItems.push({ key: 'Range', val: `${meta.range}%` })
  if (meta.high !== undefined) metaItems.push({ key: 'High', val: formatPrice(meta.high) })
  if (meta.low !== undefined) metaItems.push({ key: 'Low', val: formatPrice(meta.low) })
  if (meta.oiChangePct !== undefined) metaItems.push({ key: 'OI Change', val: `${meta.oiChangePct > 0 ? '+' : ''}${meta.oiChangePct}%`, color: meta.oiChangePct > 0 ? '#3b82f6' : '#ef4444' })
  if (meta.oiValue !== undefined) metaItems.push({ key: 'OI Value', val: fmtVol(meta.oiValue) })
  if (meta.buySellRatio !== undefined) metaItems.push({ key: 'Buy/Sell', val: `${meta.buySellRatio}x`, color: meta.buySellRatio > 1 ? '#22c55e' : '#ef4444' })
  if (meta.subType) metaItems.push({ key: 'Pattern', val: { oi_longs: 'Longs Accumulating', oi_shorts: 'Shorts Accumulating', oi_squeeze: 'Short Squeeze', oi_liquidation: 'Long Liquidation' }[meta.subType] || meta.subType })

  panel.innerHTML = `
    <div class="sig-detail-header">
      <span class="sig-type-badge ${s.type}" style="font-size:13px;">${formatType(s.type)}</span>
      <span class="sig-detail-symbol">${s.symbol.replace('USDT', '')}</span>
      <span class="sig-dir ${s.direction}" style="font-size:13px;">${s.direction}</span>
    </div>

    <div class="sig-detail-section">
      <div class="sig-detail-label">Price at Signal</div>
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
      <div class="sig-detail-label">Signal Time</div>
      <div class="sig-detail-value">${new Date(s.created_at).toLocaleString()}</div>
    </div>

    <button class="sig-detail-btn" onclick="openSignalChart('${s.symbol}')">Open Chart</button>
  `
}

// ---- Open Chart ----
function openSignalChart(symbol) {
  if (typeof openCoinModal === 'function') {
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
    setTimeout(() => openCoinModal(symbol), 200)
  }
}

// ---- Formatters ----
function formatType(type) {
  const map = {
    volume_spike: '📊 Vol Spike',
    big_mover: '🚀 Big Mover',
    natr_spike: '⚡ NATR Spike',
    oi_cvd: '🔮 OI+CVD',
  }
  return map[type] || type
}

function formatTypeShort(type) {
  const map = { volume_spike: 'Vol Spike', big_mover: 'Big Mover', natr_spike: 'NATR Spike', oi_cvd: 'OI+CVD' }
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
