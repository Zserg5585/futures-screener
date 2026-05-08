/**
 * Alerts Tab — TradingView-style multi-condition alerts
 * Backend: server/alerts.js (rule engine, 5s checker)
 * Supports: price crossing, price change %, volume, funding rate, RSI
 */

const ALERT_REFRESH_MS = 15_000
const DIRECTION_LABELS = { crosses_above: 'Crosses Above', crosses_below: 'Crosses Below', crosses: 'Crosses' }
const DIRECTION_ICONS = { crosses_above: '📈', crosses_below: '📉', crosses: '↕️' }
const OP_LABELS = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=', crosses_above: 'Crosses Above', crosses_below: 'Crosses Below', crosses: 'Crosses' }
const COOLDOWN_OPTIONS = [
  { value: 60, label: '1m' }, { value: 300, label: '5m' }, { value: 600, label: '10m' },
  { value: 1800, label: '30m' }, { value: 3600, label: '1h' }, { value: 7200, label: '2h' },
]

// Condition type definitions (mirrored from server, enriched for UI)
const COND_TYPES = {
  price: { label: 'Price', icon: '💰', ops: [
    { value: 'crosses_above', label: 'Crosses Above' },
    { value: 'crosses_below', label: 'Crosses Below' },
    { value: 'crosses', label: 'Crosses (any)' },
  ], placeholder: '95000', unit: '$' },
  price_change_pct: { label: '24h Change', icon: '📊', ops: [
    { value: 'gt', label: '>' }, { value: 'lt', label: '<' },
    { value: 'gte', label: '>=' }, { value: 'lte', label: '<=' },
  ], placeholder: '5', unit: '%' },
  volume_24h: { label: '24h Volume', icon: '📶', ops: [
    { value: 'gt', label: '>' }, { value: 'lt', label: '<' },
  ], placeholder: '500000000', unit: '$' },
  funding_rate: { label: 'Funding Rate', icon: '💸', ops: [
    { value: 'gt', label: '>' }, { value: 'lt', label: '<' },
  ], placeholder: '0.03', unit: '%' },
  rsi: { label: 'RSI', icon: '📐', ops: [
    { value: 'gt', label: '>' }, { value: 'lt', label: '<' },
    { value: 'gte', label: '>=' }, { value: 'lte', label: '<=' },
  ], placeholder: '30', unit: '', params: true },
}

const altState = {
  alerts: [], triggers: [], refreshTimer: null, active: false,
  editingId: null, coins: [], formOpen: false, rules: [],
}

// ─── Init / Destroy ────────────────────────────────────────────────
function initAlerts() {
  altState.active = true
  const wrap = document.getElementById('altContent')
  if (!wrap) return

  if (!authUI.isLoggedIn()) {
    wrap.innerHTML = `<div class="alt-auth-msg">
      <div class="alt-auth-icon">🔔</div>
      <h3>Multi-Condition Alerts</h3>
      <p>Login to create TradingView-style alerts with push notifications</p>
      <button class="alt-login-btn" onclick="authUI.openModal()">Login / Register</button>
    </div>`
    return
  }

  if (!document.getElementById('altAlertsList')) {
    wrap.innerHTML = buildAlertsSkeleton()
    setupAlertsListeners()
  }

  fetchAlerts(); fetchTriggers(); loadAlertCoins()
  clearInterval(altState.refreshTimer)
  altState.refreshTimer = setInterval(() => {
    if (altState.active) { fetchAlerts(); fetchTriggers() }
  }, ALERT_REFRESH_MS)
}

function stopAlerts() {
  altState.active = false
  clearInterval(altState.refreshTimer)
}

// ─── Skeleton ──────────────────────────────────────────────────────
function buildAlertsSkeleton() {
  return `
    <div class="alt-toolbar">
      <button class="alt-new-btn" id="altNewBtn">+ New Alert</button>
      <div class="alt-stats" id="altStats"></div>
    </div>
    <div class="alt-create-form" id="altCreateForm" style="display:none">
      <div class="alt-form-header">
        <div class="alt-form-row">
          <div class="alt-field">
            <label>Symbol</label>
            <input type="text" id="altSymbol" list="altCoinList" placeholder="BTCUSDT" spellcheck="false" autocomplete="off" />
            <datalist id="altCoinList"></datalist>
          </div>
          <div class="alt-field">
            <label>Logic</label>
            <select id="altLogic">
              <option value="AND">ALL conditions (AND)</option>
              <option value="OR">ANY condition (OR)</option>
            </select>
          </div>
          <div class="alt-field">
            <label>Cooldown</label>
            <select id="altCooldown">
              ${COOLDOWN_OPTIONS.map(o => `<option value="${o.value}"${o.value === 300 ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="alt-rules-container" id="altRulesContainer">
        <!-- Condition rules added dynamically -->
      </div>
      <div class="alt-form-actions">
        <button class="alt-add-rule-btn" id="altAddRuleBtn">+ Add Condition</button>
        <div class="alt-form-btns">
          <button class="alt-save-btn" id="altSaveBtn">Create Alert</button>
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

// ─── Rule row builder ──────────────────────────────────────────────
function buildRuleRow(index, rule = null) {
  const typeValue = rule?.type || 'price'
  const opValue = rule?.op || rule?.direction || ''
  const valValue = rule?.value || rule?.price || ''
  const condType = COND_TYPES[typeValue] || COND_TYPES.price

  return `<div class="alt-rule-row" data-rule-index="${index}">
    <span class="alt-rule-num">${index + 1}</span>
    <select class="alt-rule-type" data-idx="${index}" onchange="altUpdateRuleOps(${index})">
      ${Object.entries(COND_TYPES).map(([k, v]) => `<option value="${k}" ${k === typeValue ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}
    </select>
    <select class="alt-rule-op" data-idx="${index}" id="altRuleOp${index}">
      ${condType.ops.map(o => `<option value="${o.value}" ${o.value === opValue ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select>
    <div class="alt-rule-value-wrap">
      <input type="number" class="alt-rule-value" data-idx="${index}" step="any" placeholder="${condType.placeholder}" value="${valValue}" />
      <span class="alt-rule-unit">${condType.unit}</span>
    </div>
    ${condType.params ? `<div class="alt-rule-params">
      <select class="alt-rule-tf" data-idx="${index}" title="Timeframe">
        <option value="5m" ${rule?.params?.tf === '5m' ? 'selected' : ''}>5m</option>
        <option value="15m" ${rule?.params?.tf === '15m' ? 'selected' : ''}>15m</option>
        <option value="1h" ${rule?.params?.tf === '1h' ? 'selected' : ''}>1h</option>
        <option value="4h" ${rule?.params?.tf === '4h' ? 'selected' : ''}>4h</option>
      </select>
    </div>` : ''}
    <button class="alt-rule-del" onclick="altRemoveRule(${index})" title="Remove">&times;</button>
  </div>`
}

function altUpdateRuleOps(index) {
  const typeSelect = document.querySelector(`.alt-rule-type[data-idx="${index}"]`)
  const opSelect = document.getElementById(`altRuleOp${index}`)
  const valueInput = document.querySelector(`.alt-rule-value[data-idx="${index}"]`)
  const row = document.querySelector(`.alt-rule-row[data-rule-index="${index}"]`)
  if (!typeSelect || !opSelect) return

  const cType = COND_TYPES[typeSelect.value] || COND_TYPES.price
  opSelect.innerHTML = cType.ops.map(o => `<option value="${o.value}">${o.label}</option>`).join('')
  if (valueInput) valueInput.placeholder = cType.placeholder

  // Update unit
  const unitEl = row?.querySelector('.alt-rule-unit')
  if (unitEl) unitEl.textContent = cType.unit

  // Toggle params visibility
  const paramsEl = row?.querySelector('.alt-rule-params')
  if (cType.params && !paramsEl) {
    const wrap = row.querySelector('.alt-rule-value-wrap')
    if (wrap) {
      const div = document.createElement('div')
      div.className = 'alt-rule-params'
      div.innerHTML = `<select class="alt-rule-tf" data-idx="${index}" title="Timeframe">
        <option value="5m">5m</option><option value="15m">15m</option>
        <option value="1h">1h</option><option value="4h">4h</option></select>`
      wrap.after(div)
    }
  } else if (!cType.params && paramsEl) {
    paramsEl.remove()
  }
}

function altAddRule() {
  const container = document.getElementById('altRulesContainer')
  if (!container) return
  const index = container.children.length
  container.insertAdjacentHTML('beforeend', buildRuleRow(index))
}

function altRemoveRule(index) {
  const row = document.querySelector(`.alt-rule-row[data-rule-index="${index}"]`)
  if (row) row.remove()
  // Re-number remaining rules
  const rows = document.querySelectorAll('.alt-rule-row')
  rows.forEach((r, i) => {
    r.dataset.ruleIndex = i
    const num = r.querySelector('.alt-rule-num')
    if (num) num.textContent = i + 1
  })
}

// ─── Event Listeners ───────────────────────────────────────────────
function setupAlertsListeners() {
  document.getElementById('altNewBtn')?.addEventListener('click', () => toggleCreateForm(true))
  document.getElementById('altCancelBtn')?.addEventListener('click', () => toggleCreateForm(false))
  document.getElementById('altSaveBtn')?.addEventListener('click', saveAlert)
  document.getElementById('altAddRuleBtn')?.addEventListener('click', altAddRule)
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
    const logicSelect = document.getElementById('altLogic')
    const cdSelect = document.getElementById('altCooldown')
    const saveBtn = document.getElementById('altSaveBtn')
    const container = document.getElementById('altRulesContainer')

    if (editAlert) {
      symInput.value = editAlert.symbol || ''
      symInput.disabled = true
      cdSelect.value = editAlert.cooldown_sec || 300
      saveBtn.textContent = 'Update Alert'

      // Populate rules
      container.innerHTML = ''
      const cond = editAlert.condition || {}
      if (cond.rules) {
        logicSelect.value = cond.logic || 'AND'
        cond.rules.forEach((r, i) => container.insertAdjacentHTML('beforeend', buildRuleRow(i, r)))
      } else if (cond.price) {
        // Legacy price alert → convert to single rule
        logicSelect.value = 'AND'
        container.innerHTML = buildRuleRow(0, { type: 'price', op: cond.direction, value: cond.price })
      }
    } else {
      symInput.value = ''
      symInput.disabled = false
      logicSelect.value = 'AND'
      cdSelect.value = '300'
      saveBtn.textContent = 'Create Alert'
      container.innerHTML = ''
      altAddRule() // start with one empty rule
    }
    symInput.focus()
  }
}

// ─── API calls ─────────────────────────────────────────────────────
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
  if (!symbol) { shakeElement(document.getElementById('altSymbol')); return }

  const logic = document.getElementById('altLogic')?.value || 'AND'
  const cooldown_sec = parseInt(document.getElementById('altCooldown')?.value)

  // Collect rules from UI
  const ruleRows = document.querySelectorAll('.alt-rule-row')
  const rules = []
  for (const row of ruleRows) {
    const idx = row.dataset.ruleIndex
    const type = row.querySelector('.alt-rule-type')?.value
    const op = row.querySelector('.alt-rule-op')?.value
    const value = parseFloat(row.querySelector('.alt-rule-value')?.value)
    if (!type || !op || isNaN(value)) {
      shakeElement(row.querySelector('.alt-rule-value'))
      return
    }
    const rule = { type, op, value }
    // RSI params
    const tf = row.querySelector('.alt-rule-tf')?.value
    if (tf) rule.params = { period: 14, tf }
    rules.push(rule)
  }

  if (rules.length === 0) { altAddRule(); return }

  // Build condition object
  let condition
  if (rules.length === 1 && rules[0].type === 'price') {
    // Single price rule → legacy format for backward compat
    condition = { price: rules[0].value, direction: rules[0].op }
  } else {
    condition = { rules, logic }
  }

  try {
    if (altState.editingId) {
      await authUI.authFetch(`/api/alerts/${altState.editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition, cooldown_sec })
      })
    } else {
      const type = rules.length > 1 || rules[0]?.type !== 'price' ? 'multi' : 'price'
      await authUI.authFetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, symbol, condition, cooldown_sec })
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
    const alert = altState.alerts.find(a => a.id === id)
    const sym = alert?.symbol
    await authUI.authFetch(`/api/alerts/${id}`, { method: 'DELETE' })
    if (typeof priceAlertStore !== 'undefined') {
      await priceAlertStore.remove(id)
      priceAlertStore.invalidateCache()
    }
    if (sym && typeof removeAlertLineFromChart === 'function') {
      const series = (typeof modal !== 'undefined' && modal.series) ? modal.series : null
      removeAlertLineFromChart(sym, id, series)
    }
    fetchAlerts()
  } catch (e) { console.error('[Alerts] delete error:', e) }
}

// ─── Render ────────────────────────────────────────────────────────
function updateStats() {
  const statsEl = document.getElementById('altStats')
  if (!statsEl) return
  const active = altState.alerts.filter(a => a.enabled).length
  const total = altState.alerts.length
  statsEl.innerHTML = `<span class="alt-stat">${active} active</span><span class="alt-stat-sep">/</span><span class="alt-stat">${total} total</span>`
}

function describeCondition(cond) {
  if (!cond) return '—'
  if (cond.rules && Array.isArray(cond.rules)) {
    const parts = cond.rules.map(r => {
      const ct = COND_TYPES[r.type] || { icon: '❓', label: r.type }
      const opStr = OP_LABELS[r.op] || r.op
      const valStr = r.type === 'volume_24h'
        ? (r.value >= 1e9 ? (r.value / 1e9).toFixed(1) + 'B' : r.value >= 1e6 ? (r.value / 1e6).toFixed(0) + 'M' : r.value)
        : r.value
      const unit = ct === COND_TYPES.price ? '$' : (COND_TYPES[r.type]?.unit || '')
      const paramsStr = r.params?.tf ? ` [${r.params.tf}]` : ''
      return `<span class="alt-cond-chip">${ct.icon} ${ct.label} ${opStr} ${unit}${valStr}${paramsStr}</span>`
    })
    const logic = cond.logic === 'OR' ? '<span class="alt-logic-badge alt-logic-or">OR</span>' : '<span class="alt-logic-badge">AND</span>'
    return parts.join(logic)
  }
  // Legacy
  const dir = cond.direction || 'crosses'
  const icon = DIRECTION_ICONS[dir] || '🔔'
  return `${icon} ${DIRECTION_LABELS[dir] || dir} $${formatAlertPrice(cond.price || 0)}`
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
    const sym = (a.symbol || '').replace('USDT', '')
    const cdLabel = COOLDOWN_OPTIONS.find(o => o.value === a.cooldown_sec)?.label || `${a.cooldown_sec}s`
    const enabledClass = a.enabled ? 'alt-enabled' : 'alt-disabled'
    const triggerCount = altState.triggers.filter(t => t.alert_id === a.id).length
    const isMulti = cond.rules && cond.rules.length > 1
    const typeBadge = isMulti ? '<span class="alt-type-badge">MULTI</span>' : ''

    return `<div class="alt-card ${enabledClass}" data-id="${a.id}">
      <div class="alt-card-main">
        <div class="alt-card-header">
          <span class="alt-card-symbol">${escAttr(sym)}</span>
          ${typeBadge}
        </div>
        <div class="alt-card-conditions">${describeCondition(cond)}</div>
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

// ─── Helpers ───────────────────────────────────────────────────────
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
