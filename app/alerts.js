/**
 * Alerts Tab — Full price alert management (CRUD + trigger history)
 * Backend: server/alerts.js (checker 5s), API routes in server/index.js
 * Requires authentication (authUI)
 */

const ALERT_REFRESH_MS = 15_000
const DIRECTION_LABELS = { crosses_above: 'Crosses Above', crosses_below: 'Crosses Below', crosses: 'Crosses' }
const DIRECTION_ICONS = { crosses_above: '📈', crosses_below: '📉', crosses: '↕️' }
const COOLDOWN_OPTIONS = [
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
  { value: 7200, label: '2h' },
]

const altState = {
  alerts: [],
  triggers: [],
  refreshTimer: null,
  active: false,
  editingId: null,
  coins: [],
  formOpen: false,
}

// --- Init / Destroy ---
function initAlerts() {
  altState.active = true
  const wrap = document.getElementById('altContent')
  if (!wrap) return

  if (!authUI.isLoggedIn()) {
    wrap.innerHTML = `<div class="alt-auth-msg">
      <div class="alt-auth-icon">🔔</div>
      <h3>Price Alerts</h3>
      <p>Login to create and manage price alerts with push notifications</p>
      <button class="alt-login-btn" onclick="authUI.openModal()">Login / Register</button>
    </div>`
    return
  }

  // Build skeleton if first time
  if (!document.getElementById('altAlertsList')) {
    wrap.innerHTML = buildAlertsSkeleton()
    setupAlertsListeners()
  }

  fetchAlerts()
  fetchTriggers()
  loadAlertCoins()

  clearInterval(altState.refreshTimer)
  altState.refreshTimer = setInterval(() => {
    if (altState.active) { fetchAlerts(); fetchTriggers() }
  }, ALERT_REFRESH_MS)
}

function stopAlerts() {
  altState.active = false
  clearInterval(altState.refreshTimer)
}

// --- Skeleton ---
function buildAlertsSkeleton() {
  return `
    <div class="alt-toolbar">
      <button class="alt-new-btn" id="altNewBtn">+ New Alert</button>
      <div class="alt-stats" id="altStats"></div>
    </div>
    <div class="alt-create-form" id="altCreateForm" style="display:none">
      <div class="alt-form-row">
        <div class="alt-field">
          <label>Symbol</label>
          <input type="text" id="altSymbol" list="altCoinList" placeholder="BTCUSDT" spellcheck="false" autocomplete="off" />
          <datalist id="altCoinList"></datalist>
        </div>
        <div class="alt-field">
          <label>Price</label>
          <input type="number" id="altPrice" placeholder="95000" step="any" min="0" />
        </div>
        <div class="alt-field">
          <label>Direction</label>
          <select id="altDirection">
            <option value="crosses_above">Crosses Above</option>
            <option value="crosses_below">Crosses Below</option>
            <option value="crosses">Crosses (any)</option>
          </select>
        </div>
        <div class="alt-field">
          <label>Cooldown</label>
          <select id="altCooldown">
            ${COOLDOWN_OPTIONS.map(o => `<option value="${o.value}"${o.value === 300 ? ' selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="alt-field alt-field-actions">
          <button class="alt-save-btn" id="altSaveBtn">Create</button>
          <button class="alt-cancel-btn" id="altCancelBtn">Cancel</button>
        </div>
      </div>
    </div>
    <div class="alt-layout">
      <div class="alt-list-wrap">
        <div class="alt-section-title">Active Alerts</div>
        <div id="altAlertsList" class="alt-alerts-list"></div>
      </div>
      <div class="alt-history-wrap">
        <div class="alt-section-title">Trigger History</div>
        <div id="altTriggersList" class="alt-triggers-list"></div>
      </div>
    </div>`
}

// --- Event Listeners ---
function setupAlertsListeners() {
  // New alert button
  document.getElementById('altNewBtn')?.addEventListener('click', () => toggleCreateForm(true))
  document.getElementById('altCancelBtn')?.addEventListener('click', () => toggleCreateForm(false))
  document.getElementById('altSaveBtn')?.addEventListener('click', saveAlert)

  // Enter key in form
  document.getElementById('altPrice')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveAlert() })
  document.getElementById('altSymbol')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('altPrice')?.focus() })
}

function toggleCreateForm(show, editAlert = null) {
  const form = document.getElementById('altCreateForm')
  const btn = document.getElementById('altNewBtn')
  if (!form) return

  altState.formOpen = show
  altState.editingId = editAlert?.id || null
  form.style.display = show ? 'block' : 'none'
  if (btn) btn.style.display = show ? 'none' : ''

  if (show) {
    const symInput = document.getElementById('altSymbol')
    const priceInput = document.getElementById('altPrice')
    const dirSelect = document.getElementById('altDirection')
    const cdSelect = document.getElementById('altCooldown')
    const saveBtn = document.getElementById('altSaveBtn')

    if (editAlert) {
      symInput.value = editAlert.symbol || ''
      symInput.disabled = true
      priceInput.value = editAlert.condition?.price || ''
      dirSelect.value = editAlert.condition?.direction || 'crosses_above'
      cdSelect.value = editAlert.cooldown_sec || 300
      saveBtn.textContent = 'Update'
    } else {
      symInput.value = ''
      symInput.disabled = false
      priceInput.value = ''
      dirSelect.value = 'crosses_above'
      cdSelect.value = '300'
      saveBtn.textContent = 'Create'
    }
    symInput.focus()
  }
}

// --- API calls ---
async function loadAlertCoins() {
  try {
    const res = await fetch('/api/tickers')
    const data = await res.json()
    if (Array.isArray(data)) {
      altState.coins = data.map(t => t.symbol).sort()
      const dl = document.getElementById('altCoinList')
      if (dl) dl.innerHTML = altState.coins.map(s => `<option value="${s}">`).join('')
    }
  } catch {}
}

async function fetchAlerts() {
  try {
    const res = await authUI.authFetch('/api/alerts')
    const data = await res.json()
    if (data.success) {
      altState.alerts = data.alerts || []
      renderAlertsList()
      updateStats()
    }
  } catch (e) { console.warn('[Alerts] fetch error:', e) }
}

async function fetchTriggers() {
  try {
    const res = await authUI.authFetch('/api/alerts/triggers?limit=100')
    const data = await res.json()
    if (data.success) {
      altState.triggers = data.triggers || []
      renderTriggerHistory()
    }
  } catch (e) { console.warn('[Alerts] triggers error:', e) }
}

async function saveAlert() {
  const symbol = document.getElementById('altSymbol')?.value?.trim().toUpperCase()
  const price = parseFloat(document.getElementById('altPrice')?.value)
  const direction = document.getElementById('altDirection')?.value
  const cooldown_sec = parseInt(document.getElementById('altCooldown')?.value)

  if (!symbol || !price || price <= 0) {
    shakeElement(document.getElementById(symbol ? 'altPrice' : 'altSymbol'))
    return
  }

  const condition = { price, direction }

  try {
    if (altState.editingId) {
      await authUI.authFetch(`/api/alerts/${altState.editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition, cooldown_sec })
      })
    } else {
      await authUI.authFetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'price', symbol, condition, cooldown_sec })
      })
    }
    toggleCreateForm(false)
    fetchAlerts()
  } catch (e) { console.error('[Alerts] save error:', e) }
}

async function toggleAlertEnabled(id, enabled) {
  try {
    await authUI.authFetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    })
    fetchAlerts()
  } catch (e) { console.error('[Alerts] toggle error:', e) }
}

async function deleteAlertById(id) {
  try {
    // Find alert info before deleting (need symbol for chart cleanup)
    const alert = altState.alerts.find(a => a.id === id)
    const sym = alert?.symbol

    await authUI.authFetch(`/api/alerts/${id}`, { method: 'DELETE' })

    // Sync priceAlertStore + remove line from chart
    if (typeof priceAlertStore !== 'undefined') {
      await priceAlertStore.remove(id)
      priceAlertStore.invalidateCache()
    }
    // Remove price line from currently open chart
    if (sym && typeof removeAlertLineFromChart === 'function') {
      const series = (typeof modal !== 'undefined' && modal.series) ? modal.series : null
      removeAlertLineFromChart(sym, id, series)
    }

    fetchAlerts()
  } catch (e) { console.error('[Alerts] delete error:', e) }
}

// --- Render ---
function updateStats() {
  const statsEl = document.getElementById('altStats')
  if (!statsEl) return
  const active = altState.alerts.filter(a => a.enabled).length
  const total = altState.alerts.length
  statsEl.innerHTML = `<span class="alt-stat">${active} active</span><span class="alt-stat-sep">/</span><span class="alt-stat">${total} total</span>`
}

function renderAlertsList() {
  const container = document.getElementById('altAlertsList')
  if (!container) return

  if (!altState.alerts.length) {
    container.innerHTML = `<div class="alt-empty">No alerts yet. Click <b>+ New Alert</b> to create one.</div>`
    return
  }

  container.innerHTML = altState.alerts.map(a => {
    const cond = a.condition || {}
    const dir = cond.direction || 'crosses'
    const price = cond.price || 0
    const icon = DIRECTION_ICONS[dir] || '🔔'
    const dirLabel = DIRECTION_LABELS[dir] || dir
    const cdLabel = COOLDOWN_OPTIONS.find(o => o.value === a.cooldown_sec)?.label || `${a.cooldown_sec}s`
    const sym = (a.symbol || '').replace('USDT', '')
    const fmtPrice = formatAlertPrice(price)
    const enabledClass = a.enabled ? 'alt-enabled' : 'alt-disabled'
    const triggerCount = altState.triggers.filter(t => t.alert_id === a.id).length

    return `<div class="alt-card ${enabledClass}" data-id="${a.id}">
      <div class="alt-card-main">
        <div class="alt-card-symbol">${escAttr(sym)}</div>
        <div class="alt-card-condition">
          <span class="alt-card-icon">${icon}</span>
          <span class="alt-card-dir">${dirLabel}</span>
          <span class="alt-card-price">$${fmtPrice}</span>
        </div>
        <div class="alt-card-meta">
          <span class="alt-card-cd" title="Cooldown">⏱ ${cdLabel}</span>
          ${triggerCount > 0 ? `<span class="alt-card-triggers" title="Times triggered">🔥 ${triggerCount}</span>` : ''}
        </div>
      </div>
      <div class="alt-card-actions">
        <label class="alt-toggle" title="${a.enabled ? 'Disable' : 'Enable'}">
          <input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="toggleAlertEnabled(${a.id}, this.checked)" />
          <span class="alt-toggle-slider"></span>
        </label>
        <button class="alt-action-btn alt-edit-btn" onclick="editAlertById(${a.id})" title="Edit">✏️</button>
        <button class="alt-action-btn alt-del-btn" onclick="deleteAlertConfirm(${a.id})" title="Delete">🗑️</button>
      </div>
    </div>`
  }).join('')
}

function renderTriggerHistory() {
  const container = document.getElementById('altTriggersList')
  if (!container) return

  if (!altState.triggers.length) {
    container.innerHTML = `<div class="alt-empty">No triggers yet. Alerts will appear here when triggered.</div>`
    return
  }

  container.innerHTML = altState.triggers.slice(0, 50).map(t => {
    const time = formatTriggerTime(t.triggered_at)
    const sym = (t.symbol || '').replace('USDT', '')
    const data = typeof t.data === 'string' ? JSON.parse(t.data || '{}') : (t.data || {})
    const price = data.currentPrice ? `$${formatAlertPrice(data.currentPrice)}` : ''

    return `<div class="alt-trigger-row">
      <span class="alt-trigger-time">${time}</span>
      <span class="alt-trigger-sym">${escAttr(sym)}</span>
      <span class="alt-trigger-msg">${escAttr(t.message || '')}</span>
      ${price ? `<span class="alt-trigger-price">${price}</span>` : ''}
    </div>`
  }).join('')
}

// --- Helpers ---
function formatAlertPrice(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function formatTriggerTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z')
  const now = new Date()
  const diffMs = now - d
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function editAlertById(id) {
  const alert = altState.alerts.find(a => a.id === id)
  if (alert) toggleCreateForm(true, alert)
}

function deleteAlertConfirm(id) {
  const alert = altState.alerts.find(a => a.id === id)
  const sym = alert?.symbol?.replace('USDT', '') || 'alert'
  if (confirm(`Delete alert for ${sym}?`)) deleteAlertById(id)
}

function shakeElement(el) {
  if (!el) return
  el.classList.add('alt-shake')
  setTimeout(() => el.classList.remove('alt-shake'), 400)
}
