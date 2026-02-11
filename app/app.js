const el = (id) => document.getElementById(id)

const minNotionalEl = el('minNotional')
const symbolsEl = el('symbols')
const sideEl = el('side')
const refreshEl = el('refresh')
const autoEl = el('auto')
const intervalEl = el('interval')
const stateEl = el('state')
const updatedEl = el('updated')
const errorEl = el('error')
const tbodyEl = el('tbody')

let timer = null
let inflight = false

function fmtNum(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(x)
}
function fmtPrice(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(x)
}
function fmtPct(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(x)
}

function setState(s) { stateEl.textContent = s }
function showError(msg) {
  errorEl.textContent = msg
  errorEl.classList.remove('hidden')
}
function clearError() {
  errorEl.textContent = ''
  errorEl.classList.add('hidden')
}

function buildUrl() {
  const minNotional = Number(minNotionalEl.value || 0)
  const symbols = symbolsEl.value.trim()
  const qs = new URLSearchParams()
  qs.set('minNotional', String(minNotional))
  qs.set('depthLimit', '100')
  if (symbols) qs.set('symbols', symbols)
  return `/densities/simple?${qs.toString()}`
}

function groupBySymbol(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.symbol)) map.set(r.symbol, { symbol: r.symbol, bid: null, ask: null })
    const entry = map.get(r.symbol)
    if (r.side === 'bid') entry.bid = r
    if (r.side === 'ask') entry.ask = r
  }
  return Array.from(map.values())
}

function bestDistance(entry) {
  const d1 = entry.bid?.distancePct
  const d2 = entry.ask?.distancePct
  const a = (typeof d1 === 'number') ? d1 : Infinity
  const b = (typeof d2 === 'number') ? d2 : Infinity
  return Math.min(a, b)
}

function render(entries) {
  const sideFilter = sideEl.value // all|bid|ask

  // sort: nearest to price first
  entries.sort((a, b) => bestDistance(a) - bestDistance(b))

  const rowsHtml = entries.map(e => {
    const bid = e.bid
    const ask = e.ask

    const bidCells = (sideFilter === 'ask')
      ? `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>`
      : `<td>${fmtPrice(bid?.levelPrice)}</td><td>${fmtPct(bid?.distancePct)}</td><td>${fmtNum(bid?.notional)}</td>`

    const askCells = (sideFilter === 'bid')
      ? `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>`
      : `<td>${fmtPrice(ask?.levelPrice)}</td><td>${fmtPct(ask?.distancePct)}</td><td>${fmtNum(ask?.notional)}</td>`

    return `<tr>
      <td class="sym">${e.symbol}</td>
      ${bidCells}
      ${askCells}
    </tr>`
  }).join('')

  tbodyEl.innerHTML = rowsHtml || `<tr><td colspan="7" class="muted">No data</td></tr>`
}

async function load() {
  if (inflight) return
  inflight = true

  clearError()
  setState('Loading...')

  try {
    const url = buildUrl()
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()

    const entries = groupBySymbol(json.data || [])
    render(entries)

    const now = new Date()
    updatedEl.textContent = `Last updated: ${now.toLocaleTimeString()}`
    setState(`OK (${entries.length} symbols)`)
  } catch (e) {
    setState('Error')
    showError(String(e?.message || e))
  } finally {
    inflight = false
  }
}

function startAuto() {
  stopAuto()
  const ms = Number(intervalEl.value || 10000)
  timer = setInterval(load, ms)
}
function stopAuto() {
  if (timer) clearInterval(timer)
  timer = null
}

refreshEl.addEventListener('click', load)

autoEl.addEventListener('change', () => {
  if (autoEl.checked) startAuto()
  else stopAuto()
})

intervalEl.addEventListener('change', () => {
  if (autoEl.checked) startAuto()
})

sideEl.addEventListener('change', load)

window.addEventListener('load', load)
