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
  minRatio: 3,  // user-configurable: show volume spikes >= Nx
  refreshTimer: null,
  active: false,
  seenIds: new Set(), // track notified signal IDs
  firstLoad: true,    // skip notifications on first load
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

  // Load signal settings from settings panel (unified)
  if (typeof settingsPanel !== 'undefined') {
    sigState.minRatio = settingsPanel.get('signalMinRatio') || 3
    settingsPanel.onChange((key, val) => {
      if (key === 'signalMinRatio') {
        sigState.minRatio = val
        renderSignals()
      } else if (key === 'signalMinConfidence') {
        renderSignals()
      } else if (key === 'signalWatchlistOnly' || key === '__watchlist') {
        renderSignals()
      }
    })
  } else {
    const saved = localStorage.getItem('sig_settings')
    if (saved) { try { const s = JSON.parse(saved); if (s.minRatio) sigState.minRatio = s.minRatio } catch {} }
  }

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
    const params = new URLSearchParams({ limit: '500', hours: '24' })
    if (sigState.typeFilter) params.set('type', sigState.typeFilter)
    if (sigState.dirFilter) params.set('direction', sigState.dirFilter)

    const [liveRes, summaryRes, outcomesRes] = await Promise.all([
      fetch(`${SIG_API}/api/signals/live?${params}`).then(r => r.json()),
      fetch(`${SIG_API}/api/signals/summary`).then(r => r.json()),
      fetch(`${SIG_API}/api/signals/outcomes`).then(r => r.json()),
    ])

    if (liveRes.success) {
      const newSignals = liveRes.data || []
      notifyNewSignals(newSignals)
      sigState.signals = newSignals
    }
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
    const icon = { volume_spike: '📊', oi_cvd: '🔮' }[s.type] || '•'

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

  // Filter volume spikes by min ratio
  if (sigState.minRatio > 0) {
    list = list.filter(s => {
      if (s.type !== 'volume_spike') return true
      const ratio = s.metadata?.ratio || 0
      return ratio >= sigState.minRatio
    })
  }

  // Filter by min confidence
  const minConf = typeof settingsPanel !== 'undefined' ? (settingsPanel.get('signalMinConfidence') || 50) : 50
  if (minConf > 30) {
    list = list.filter(s => (s.confidence || 0) >= minConf)
  }

  // Filter by watchlist if enabled
  if (typeof settingsPanel !== 'undefined' && settingsPanel.get('signalWatchlistOnly')) {
    list = list.filter(s => settingsPanel.wlHas(s.symbol))
  }

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
        <span class="sig-conf-text" style="color:${confColor}">${Math.round(s.confidence)}%</span>
        <span class="sig-conf-bar" style="width:${Math.round(s.confidence) * 0.5}px; background:${confColor};"></span>
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

  // Mobile: show detail as overlay
  if (window.innerWidth <= 900) {
    panel.classList.add('mobile-open')
  }

  const meta = s.metadata || {}
  const confColor = s.confidence >= 80 ? '#22c55e' : s.confidence >= 60 ? '#f59e0b' : '#ef4444'

  const metaItems = []
  // Volume spike metadata
  if (meta.ratio !== undefined) metaItems.push({ key: 'Volume Ratio', val: `${meta.ratio}x avg`, color: meta.ratio >= 5 ? '#22c55e' : '#3b82f6' })
  if (meta.currentVol !== undefined) metaItems.push({ key: 'Current Vol (5m)', val: fmtVol(meta.currentVol) })
  if (meta.avgVol !== undefined) metaItems.push({ key: 'Avg Vol (SMA20)', val: fmtVol(meta.avgVol) })
  if (meta.candleChange !== undefined) metaItems.push({ key: 'Candle Chg', val: `${meta.candleChange > 0 ? '+' : ''}${meta.candleChange}%`, color: meta.candleChange > 0 ? '#22c55e' : '#ef4444' })
  if (meta.change24h !== undefined) metaItems.push({ key: 'Change 24h', val: `${meta.change24h > 0 ? '+' : ''}${Number(meta.change24h).toFixed(2)}%`, color: meta.change24h > 0 ? '#22c55e' : '#ef4444' })
  if (meta.oiChangePct !== undefined) metaItems.push({ key: 'OI Change', val: `${meta.oiChangePct > 0 ? '+' : ''}${meta.oiChangePct}%`, color: meta.oiChangePct > 0 ? '#3b82f6' : '#ef4444' })
  if (meta.oiValue !== undefined) metaItems.push({ key: 'OI Value', val: fmtVol(meta.oiValue) })
  if (meta.buySellRatio !== undefined) metaItems.push({ key: 'Buy/Sell', val: `${meta.buySellRatio}x`, color: meta.buySellRatio > 1 ? '#22c55e' : '#ef4444' })
  if (meta.subType) metaItems.push({ key: 'Pattern', val: { oi_longs: 'Longs Accumulating', oi_shorts: 'Shorts Accumulating', oi_squeeze: 'Short Squeeze', oi_liquidation: 'Long Liquidation' }[meta.subType] || meta.subType })

  // Market context metadata (new enriched fields)
  if (meta.volume24h !== undefined) metaItems.push({ key: 'Volume 24h', val: '$' + fmtVol(meta.volume24h) })
  if (meta.natr !== undefined && meta.natr !== null) metaItems.push({ key: 'NATR', val: `${meta.natr}%`, color: meta.natr >= 2 ? '#f59e0b' : meta.natr >= 1 ? '#22c55e' : '#94a3b8' })
  if (meta.trades24h !== undefined && meta.trades24h > 0) metaItems.push({ key: 'Trades 24h', val: meta.trades24h >= 1e6 ? (meta.trades24h / 1e6).toFixed(1) + 'M' : meta.trades24h >= 1e3 ? (meta.trades24h / 1e3).toFixed(0) + 'K' : meta.trades24h.toString() })
  if (meta.fundingRate !== undefined && meta.fundingRate !== null) metaItems.push({ key: 'Funding', val: `${meta.fundingRate > 0 ? '+' : ''}${meta.fundingRate}%`, color: meta.fundingRate > 0.01 ? '#22c55e' : meta.fundingRate < -0.01 ? '#ef4444' : '#94a3b8' })
  if (meta.pricePosition !== undefined) metaItems.push({ key: '24h Range', val: `${meta.pricePosition}%`, color: meta.pricePosition >= 80 ? '#22c55e' : meta.pricePosition <= 20 ? '#ef4444' : '#94a3b8' })
  if (meta.marketRank !== undefined) metaItems.push({ key: 'Vol Rank', val: `#${meta.marketRank}` })

  panel.innerHTML = `
    <button class="sig-detail-back" onclick="document.getElementById('sigDetail').classList.remove('mobile-open')">← Back</button>
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
          <div style="width:${Math.round(s.confidence)}%; height:100%; background:${confColor}; border-radius:3px;"></div>
        </div>
        <span style="font-size:14px; font-weight:600; color:${confColor}">${Math.round(s.confidence)}%</span>
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
      <div class="sig-detail-value">${new Date(ensureUTC(s.created_at)).toLocaleString()}</div>
    </div>

    <button class="sig-detail-btn" onclick="openSignalChart('${s.symbol}')">Open Chart</button>
  `
}

// ---- Open Chart (modal overlay, stays on Signals tab) ----
// Store pending signal marker for modal chart
window._pendingSignalMarker = null

function openSignalChart(symbol) {
  if (typeof openCoinModal !== 'function') return

  // Find signal data for marker
  const sig = sigState.selected
  if (sig && sig.symbol === symbol) {
    window._pendingSignalMarker = {
      time: Math.floor(new Date(ensureUTC(sig.created_at)).getTime() / 1000),
      price: sig.price,
      direction: sig.direction,
      type: sig.type,
      description: sig.description,
    }
  }
  openCoinModal(symbol)
}

// ---- Formatters ----
function formatType(type) {
  const map = {
    volume_spike: '📊 Vol Spike',
    oi_cvd: '🔮 OI+CVD',
  }
  return map[type] || type
}

function formatTypeShort(type) {
  const map = { volume_spike: 'Vol Spike', oi_cvd: 'OI+CVD' }
  return map[type] || type
}

function ensureUTC(iso) {
  if (!iso) return iso
  // DB stores "2026-04-18 07:20:00" (UTC, no T, no Z) — normalize to ISO
  let s = iso.includes('T') ? iso : iso.replace(' ', 'T')
  if (!s.endsWith('Z') && !s.includes('+')) s += 'Z'
  return s
}

function formatTime(iso) {
  const d = new Date(ensureUTC(iso))
  const now = new Date()
  const diffMs = now - d
  if (diffMs < 0) return 'just now'
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 60_000)}m ago`
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

// ---- Browser Notifications for new signals ----
function notifyNewSignals(newList) {
  const sp = typeof settingsPanel !== 'undefined' ? settingsPanel : null
  const enabled = sp ? sp.get('signalNotifications') : false
  if (!enabled) return

  // On first load, just mark all as seen (no spam)
  if (sigState.firstLoad) {
    sigState.firstLoad = false
    newList.forEach(s => sigState.seenIds.add(s.id))
    return
  }

  // Find signals we haven't seen yet
  const fresh = newList.filter(s => !sigState.seenIds.has(s.id))
  if (fresh.length === 0) return

  // Mark as seen
  fresh.forEach(s => sigState.seenIds.add(s.id))

  // Cap seenIds to last 1000
  if (sigState.seenIds.size > 1000) {
    const arr = [...sigState.seenIds]
    sigState.seenIds = new Set(arr.slice(-500))
  }

  // Apply same filters as renderSignals
  const minConf = sp ? (sp.get('signalMinConfidence') || 50) : 50
  const minRatio = sigState.minRatio || 3
  const wlOnly = sp ? sp.get('signalWatchlistOnly') : false

  const filtered = fresh.filter(s => {
    if (s.type === 'volume_spike' && (s.metadata?.ratio || 0) < minRatio) return false
    if (minConf > 30 && (s.confidence || 0) < minConf) return false
    if (wlOnly && sp && !sp.wlHas(s.symbol)) return false
    return true
  })

  if (filtered.length === 0) return

  // Request permission if needed
  if (Notification.permission === 'default') {
    Notification.requestPermission()
    return
  }
  if (Notification.permission !== 'granted') return

  // Send notification for each new signal (max 3 to avoid spam)
  filtered.slice(0, 3).forEach(s => {
    const ticker = s.symbol.replace('USDT', '')
    const icon = s.type === 'volume_spike' ? '📊' : '🔮'
    const dir = s.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'
    const title = `${icon} ${ticker} ${dir}`
    const body = `${formatType(s.type)} • Conf ${Math.round(s.confidence)}%\n${s.description || ''}`

    try {
      // Use SW registration for persistent notifications (works when tab in background)
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, {
            body,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: `signal-${s.id}`,
            data: { symbol: s.symbol, signalId: s.id },
            vibrate: [200, 100, 200],
            requireInteraction: false,
            silent: !sp?.get('signalSound'),
          })
        })
      } else {
        // Fallback: basic Notification API
        new Notification(title, {
          body,
          tag: `signal-${s.id}`,
          data: { symbol: s.symbol },
        })
      }
    } catch (e) {
      console.error('[Signals] Notification error:', e)
    }
  })

  // Play sound if enabled
  if (sp?.get('signalSound') && filtered.length > 0) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.frequency.value = 880
      gain.gain.value = 0.15
      osc.start()
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3)
      osc.stop(ac.currentTime + 0.3)
    } catch (e) {}
  }
}

// ---- Listen for SW messages (notification click → open modal) ----
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'OPEN_SIGNAL' && e.data.symbol) {
      if (typeof openCoinModal === 'function') {
        openCoinModal(e.data.symbol)
      }
    }
  })
}

// ---- Check URL param on load (from notification click when app was closed) ----
(function checkSignalParam() {
  const params = new URLSearchParams(window.location.search)
  const sym = params.get('signal')
  if (sym) {
    // Clean URL
    window.history.replaceState({}, '', '/')
    // Wait for app to init, then open modal
    const tryOpen = () => {
      if (typeof openCoinModal === 'function' && typeof mc !== 'undefined' && mc.allPairs.length > 0) {
        openCoinModal(sym)
      } else {
        setTimeout(tryOpen, 500)
      }
    }
    setTimeout(tryOpen, 1000)
  }
})()
