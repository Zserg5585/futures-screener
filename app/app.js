// Futures Screener - Densities UI
// Utilities and Core Helpers
const el = (id) => document.getElementById(id)
const qs = (selector) => document.querySelector(selector)
const qsa = (selector) => document.querySelectorAll(selector)

// Configuration
const CONFIG = {
    API_BASE_URL: '/densities/simple',
    DEFAULT_MIN_NOTIONAL: 50000,
    DEFAULT_SYMBOLS: 'BTCUSDT,ETHUSDT,XRPUSDT',
    REFRESH_INTERVALS: [5000, 10000, 20000],
    DEFAULT_INTERVAL: 10000,
    CACHE_DURATION: 30000 // 30 seconds client-side cache
}

// State
let state = {
    minNotional: CONFIG.DEFAULT_MIN_NOTIONAL,
    symbols: CONFIG.DEFAULT_SYMBOLS,
    interval: CONFIG.DEFAULT_INTERVAL,
    autoRefresh: false,
    refreshTimer: null,
    cache: {
        data: null,
        timestamp: 0,
        cacheKey: null
    },
    lastError: null
}

// Initialize
function init() {
    setupEventListeners()
    updateControlsFromState()
    loadDensities()
}

function setupEventListeners() {
    // Controls
    el('minNotional').addEventListener('input', (e) => {
        state.minNotional = Number(e.target.value)
        loadDensities()
    })

    el('symbols').addEventListener('change', (e) => {
        state.symbols = e.target.value
        loadDensities()
    })

    el('interval').addEventListener('change', (e) => {
        state.interval = Number(e.target.value)
        if (state.autoRefresh) {
            clearInterval(state.refreshTimer)
            startAutoRefresh()
        }
    })

    // Buttons
    el('refresh').addEventListener('click', () => loadDensities(true))
    el('auto').addEventListener('change', (e) => {
        state.autoRefresh = e.target.checked
        if (state.autoRefresh) {
            startAutoRefresh()
        } else {
            stopAutoRefresh()
        }
    })

    // Mobile filter toggle
    el('filterToggle').addEventListener('click', () => {
        el('filterModal').classList.remove('hidden')
    })

    // Modal controls
    el('modalClose').addEventListener('click', () => el('filterModal').classList.add('hidden'))
    el('modalApply').addEventListener('click', () => {
        state.minNotional = Number(el('modalMinNotional').value)
        state.symbols = el('modalSymbols').value
        state.interval = Number(el('modalInterval').value)
        el('filterModal').classList.add('hidden')
        updateControlsFromState()
        loadDensities()
    })
    el('modalClear').addEventListener('click', () => {
        el('modalMinNotional').value = CONFIG.DEFAULT_MIN_NOTIONAL
        el('modalSymbols').value = CONFIG.DEFAULT_SYMBOLS
        el('modalInterval').value = CONFIG.DEFAULT_INTERVAL
    })
}

function updateControlsFromState() {
    el('minNotional').value = state.minNotional
    el('symbols').value = state.symbols
    el('interval').value = state.interval
    el('auto').checked = state.autoRefresh
}

function getCacheKey() {
    return JSON.stringify({
        symbols: state.symbols,
        minNotional: state.minNotional,
        interval: state.interval
    })
}

function isCacheValid() {
    const currentKey = getCacheKey()
    return state.cache.data && 
           state.cache.cacheKey === currentKey && 
           (Date.now() - state.cache.timestamp) < CONFIG.CACHE_DURATION
}

function updateCache(data) {
    state.cache = {
        data,
        timestamp: Date.now(),
        cacheKey: getCacheKey()
    }
}

// Load densities from API
async function loadDensities(forceRefresh = false) {
    const stateEl = el('state')
    const errorEl = el('error')

    // Show loading state
    stateEl.textContent = 'Loading'
    stateEl.classList.add('loading')
    errorEl.classList.add('hidden')

    try {
        // Check cache
        if (!forceRefresh && isCacheValid()) {
            renderDensities(state.cache.data)
            stateEl.textContent = `OK (${state.cache.data.length} rows)`
            stateEl.classList.remove('loading')
            return
        }

        // Build query params
        const params = new URLSearchParams({
            minNotional: state.minNotional,
            symbols: state.symbols,
            interval: state.interval
        })
        const url = `${CONFIG.API_BASE_URL}?${params.toString()}`

        // Fetch data
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`)
        }

        const result = await response.json()
        const data = result.data || []

        // Update cache
        updateCache(data)

        // Render
        renderDensities(data)

        // Update status
        stateEl.textContent = `OK (${data.length} rows)`
        stateEl.classList.remove('loading')
        el('updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`

    } catch (error) {
        console.error('Load error:', error)
        state.lastError = error.message
        errorEl.textContent = error.message
        errorEl.classList.remove('hidden')
        stateEl.textContent = 'Error'
        stateEl.classList.remove('loading')
    }
}

// Render table
function renderDensities(entries) {
    const tbody = el('tbody')
    
    if (!entries || entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">No data available</td></tr>`
        return
    }

    const rows = entries.map(entry => `
        <tr class="${entry.isMM ? 'isMM' : ''}">
            <td class="sym">${entry.symbol}</td>
            ${renderSide(entry, 'bid')}
            ${renderSide(entry, 'ask')}
        </tr>
    `).join('')

    tbody.innerHTML = rows
}

function renderSide(entry, side) {
    const sideData = entry[side]
    if (!sideData) {
        return `
            <td class="muted">—</td>
            <td class="muted">—</td>
            <td class="muted">—</td>
        `
    }

    const isMM = sideData.isMM || entry.isMM

    return `
        <td ${isMM ? 'class="isMM"' : ''}>
            ${formatNumber(sideData.levelPrice, 2)}
            ${isMM ? '<span class="mm-badge">★</span>' : ''}
        </td>
        <td>${formatPercent(sideData.distancePct)}</td>
        <td>${formatNotional(sideData.notional)}</td>
    `
}

// Format helpers
function formatNumber(value, decimals = 2) {
    if (!value) return '—'
    return Number(value).toFixed(decimals)
}

function formatPercent(value) {
    if (!value) return '—'
    return Number(value).toFixed(2) + '%'
}

function formatNotional(value) {
    if (!value) return '—'
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 0,
        notation: value >= 1000000 ? 'compact' : 'standard'
    }).format(value)
}

// Auto refresh
function startAutoRefresh() {
    stopAutoRefresh()
    state.refreshTimer = setInterval(() => loadDensities(), state.interval)
}

function stopAutoRefresh() {
    if (state.refreshTimer) {
        clearInterval(state.refreshTimer)
        state.refreshTimer = null
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init)
