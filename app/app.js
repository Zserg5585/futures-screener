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
    CACHE_DURATION: 30000, // 30 seconds client-side cache
    PRESETS: {
        'custom': {
            name: 'Custom',
            windowPct: 5.0,
            minNotional: 0,
            depthLimit: 100
        }
    }
}

// State
let state = {
    minNotional: 0, // 0 по умолчанию
    windowPct: 5.0, // 5% по умолчанию
    depthLimit: 100,
    xFilter: 0, // Any (no filter)
    natrFilter: 0, // Any (no filter)
    interval: CONFIG.DEFAULT_INTERVAL,
    autoRefresh: false,
    refreshTimer: null,
    cache: {
        data: null,
        timestamp: 0,
        cacheKey: null
    },
    lastError: null,
    currentPreset: null,
    watchlist: [], // Список символов в watchlist (из localStorage)
    currentTab: 'densities', // текущая вкладка
    watchlistData: null // кэш данных watchlist
}

// Initialize
function init() {
    console.log('Futures Screener init')
    setupEventListeners()
    updateControlsFromState()
    // Load directly (no initial empty render)
    loadWatchlist() // Загрузить watchlist из localStorage
    loadDensities(true) // force refresh
}

function setupEventListeners() {
    // Controls
    el('minNotional').addEventListener('input', (e) => {
        state.minNotional = Number(e.target.value)
        loadDensities()
    })

    el('windowPct').addEventListener('input', (e) => {
        state.windowPct = Number(e.target.value)
        loadDensities()
    })

    el('depthLimit').addEventListener('input', (e) => {
        state.depthLimit = Number(e.target.value)
        loadDensities()
    })

    el('interval').addEventListener('change', (e) => {
        state.interval = Number(e.target.value)
        if (state.autoRefresh) {
            clearInterval(state.refreshTimer)
            startAutoRefresh()
        }
    })

    // Auto refresh checkbox
    el('auto').addEventListener('change', (e) => {
        state.autoRefresh = e.target.checked
        if (state.autoRefresh) {
            startAutoRefresh()
        } else {
            stopAutoRefresh()
        }
    })

    // Only MM checkbox
    el('onlyMM').addEventListener('change', (e) => {
        state.onlyMM = e.target.checked
        loadDensities()
    })

    // Reset button
    el('resetBtn').addEventListener('click', () => {
        state.cache.data = null
        el('tbody').innerHTML = `<tr><td colspan="11" class="muted">No data available</td></tr>`
        el('state').textContent = 'Загружаем...'
    })

    // x Filter selector
    el('xFilter').addEventListener('change', (e) => {
        state.xFilter = Number(e.target.value)
        loadDensities()
    })

    // NATR Filter selector
    el('natrFilter').addEventListener('change', (e) => {
        state.natrFilter = Number(e.target.value)
        loadDensities()
    })

    // Refresh button
    el('refreshBtn').addEventListener('click', () => {
        loadDensities(true) // force refresh
    })

    // Вкладки (tabs)
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
            tab.classList.add('active')
            
            const tabName = tab.dataset.tab
            state.currentTab = tabName
            
            // Обновить UI в зависимости от вкладки
            if (tabName === 'watchlist') {
                renderWatchlist(state.watchlistData || [])
            } else if (tabName === 'densities') {
                renderDensities(state.cache.data || [])
            }
        })
    })
}

function updateControlsFromState() {
    el('minNotional').value = state.minNotional
    el('windowPct').value = state.windowPct
    el('depthLimit').value = state.depthLimit
    el('interval').value = state.interval
    el('auto').checked = state.autoRefresh
    el('onlyMM').checked = state.onlyMM || true
    el('xFilter').value = state.xFilter || 0
    el('natrFilter').value = state.natrFilter || 0
}

function getCacheKey() {
    return JSON.stringify({
        minNotional: state.minNotional,
        windowPct: state.windowPct,
        depthLimit: state.depthLimit,
        xFilter: state.xFilter,
        natrFilter: state.natrFilter,
        onlyMM: state.onlyMM || false,
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
    // Сохранить данные для watchlist (используются при переключении вкладок)
    state.watchlistData = data
}

// Load densities from API
async function loadDensities(forceRefresh = false) {
    const stateEl = el('state')
    const errorEl = el('error')

    // Show loading state
    stateEl.textContent = 'Загрузка...'
    stateEl.classList.add('loading')
    errorEl.classList.add('hidden')

    try {
        // Check cache
        if (!forceRefresh && isCacheValid()) {
            renderDensities(state.cache.data)
            // Debug: count unique symbols
            const uniqueSymbols = new Set(state.cache.data.map(e => e.symbol))
            stateEl.textContent = `✅ Загружено: ${state.cache.data.length} уровней, ${uniqueSymbols.size} символов`
            stateEl.classList.remove('loading')
            return
        }

        // Build query params
        const params = new URLSearchParams({
            minNotional: state.minNotional,
            windowPct: state.windowPct,
            depthLimit: state.depthLimit,
            xFilter: state.xFilter,
            natrFilter: state.natrFilter,
            mmMode: state.onlyMM ? 'true' : 'false',
            symbols: 'BTCUSDT,ETHUSDT,XRPUSDT' // Default symbols
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
        const uniqueSymbols = new Set(data.map(e => e.symbol))
        stateEl.textContent = `✅ Загружено: ${data.length} уровней, ${uniqueSymbols.size} символов`
        stateEl.classList.remove('loading')
        el('updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`

    } catch (error) {
        console.error('Load error:', error)
        state.lastError = error.message
        errorEl.textContent = error.message
        errorEl.classList.remove('hidden')
        stateEl.textContent = '❌ Ошибка'
        stateEl.classList.remove('loading')
    }
}

// Render table (desktop)
function renderTable(entries) {
    const tbody = el('tbody')
    
    if (!entries || entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="muted">Нет данных</td></tr>`
        return
    }

    // Группируем по symbol (BID + ASK в одну строку)
    const grouped = new Map()
    entries.forEach(entry => {
        if (!grouped.has(entry.symbol)) {
            grouped.set(entry.symbol, { bid: null, ask: null })
        }
        if (entry.side === 'bid') {
            grouped.get(entry.symbol).bid = entry
        } else if (entry.side === 'ask') {
            grouped.get(entry.symbol).ask = entry
        }
    })

    // Преобразуем в массив и сортируем по максимальному score
    const sorted = [...grouped.entries()].sort((a, b) => {
        const scoreA = Math.max(a[1].bid?.score || 0, a[1].ask?.score || 0)
        const scoreB = Math.max(b[1].bid?.score || 0, b[1].ask?.score || 0)
        return scoreB - scoreA
    })

    const rows = sorted.map(([symbol, data]) => {
        const { bid, ask } = data
        const score = Math.max(bid?.score || 0, ask?.score || 0)
        const vol3 = bid?.vol3 || ask?.vol3 || 0
        const inWatchlist = isSymbolInWatchlist(symbol)

        // Вспомогательная функция для рендера ячейки side
        const renderSideCell = (sideEntry) => {
            if (!sideEntry) {
                return `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>`
            }
            return `
                <td>${formatNumber(sideEntry.price, 2)}</td>
                <td>${formatPercent(sideEntry.distancePct)}</td>
                <td>${formatNotional(sideEntry.notional)}</td>
            `
        }

        return `
        <tr>
            <td class="sym">${symbol}</td>
            ${renderSideCell(bid)}
            <td>${bid ? (bid.mmCount || 1) : '—'}</td>
            ${renderSideCell(ask)}
            <td>${ask ? (ask.mmCount || 1) : '—'}</td>
            <td class="score">${score.toFixed(4)}</td>
            <td>${formatNotional(vol3)}</td>
            <td class="watchlist-btn">
                <button class="btn-star ${inWatchlist ? 'active' : ''}" onclick="toggleWatchlist('${symbol}')">
                    ${inWatchlist ? '⭐' : '☆'}
                </button>
            </td>
        </tr>
    `}).join('')

    tbody.innerHTML = rows
}

// Render table
function renderDensities(entries) {
    // Для мобильных устройств — всегда карточки (для деск можно включить флаг ниже)
    const isMobile = true // принудительно включить карточки
    
    // Авто-определение mobile/desktop
    // const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768
    console.log('renderDensities:', isMobile, 'entries:', entries?.length)
    
    const cardsContainer = el('cardsContent')
    const tableContainer = el('table-container')
    
    console.log('Containers:', { cardsContainer: !!cardsContainer, tableContainer: !!tableContainer })
    
    if (isMobile) {
        console.log('Using cards')
        if (!cardsContainer) {
            console.error('cardsContent element not found!')
            // Fallback: show error on page
            document.body.innerHTML += `<div style="color:red;padding:20px;">ERROR: cardsContent element not found</div>`
            return
        }
        renderCards(entries)
        cardsContainer.style.display = 'flex'
        if (tableContainer) tableContainer.style.display = 'none'
    } else {
        console.log('Using table')
        renderTable(entries)
        if (cardsContainer) cardsContainer.style.display = 'none'
        if (tableContainer) tableContainer.style.display = 'block'
    }
}
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

    return `
        <td>${formatNumber(sideData.levelPrice, 2)}</td>
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

// Render cards (mobile)
function renderCards(entries) {
    const container = el('cardsContent')
    
    if (!entries || entries.length === 0) {
        container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">Нет данных</p>`
        return
    }

    console.log('renderCards: entries.length =', entries.length)
    
    // Группируем по symbol (BID + ASK в одну карточку)
    const grouped = new Map()
    entries.forEach(entry => {
        if (!grouped.has(entry.symbol)) {
            grouped.set(entry.symbol, { bid: null, ask: null })
        }
        if (entry.side === 'bid') {
            grouped.get(entry.symbol).bid = entry
        } else if (entry.side === 'ask') {
            grouped.get(entry.symbol).ask = entry
        }
    })
    
    console.log('renderCards: grouped.size =', grouped.size)

    // Если группировка не удалась — покажем raw данные для отладки
    if (grouped.size === 0) {
        console.error('Grouped size is 0! Raw entries:', entries.slice(0, 5))
        container.innerHTML = `
            <div style="padding:20px;background:#ff000010;color:#f00;">
                <h4>DEBUG: grouped.size == 0</h4>
                <p>Entries count: ${entries.length}</p>
                <pre>${JSON.stringify(entries.slice(0, 5), null, 2)}</pre>
            </div>
        `
        return
    }

    const cards = [...grouped.entries()].map(([symbol, data]) => {
        const { bid, ask } = data
        const score = Math.max(bid?.score || 0, ask?.score || 0)
        const vol3 = bid?.vol3 || ask?.vol3 || 0
        const isMM = ((bid?.mmCount || 0) > 1) || ((ask?.mmCount || 0) > 1)
        const inWatchlist = isSymbolInWatchlist(symbol)
        
        console.log(`renderCards: ${symbol} bid=${!!bid} ask=${!!ask}`)
        
        return `
        <div class="card ${isMM ? 'isMM' : ''}" data-symbol="${symbol}">
            <div class="card-header">
                <a href="https://www.binance.com/en/futures/${symbol}" target="_blank">${symbol}</a>
                <span class="mm-badge ${isMM ? 'active' : ''}">${isMM ? 'MM' : ''}</span>
            </div>
            <div class="card-body">
                <div class="card-row bid ${(bid?.mmCount || 0) > 1 ? 'isMM' : ''}">
                    <span class="label">🔴 BID</span>
                    <span class="value">
                        ${bid ? formatNumber(bid.price, 2) : '—'}
                        <span class="dist">${bid ? formatPercent(bid.distancePct) : '—'}</span>
                        <span class="notional">${bid ? formatNotional(bid.notional) : '—'}</span>
                        <span class="x-val">${bid ? (bid.x || 0).toFixed(2) + 'x' : '—'}</span>
                    </span>
                </div>
                <div class="card-row ask ${(ask?.mmCount || 0) > 1 ? 'isMM' : ''}">
                    <span class="label">🟢 ASK</span>
                    <span class="value">
                        ${ask ? formatNumber(ask.price, 2) : '—'}
                        <span class="dist">${ask ? formatPercent(ask.distancePct) : '—'}</span>
                        <span class="notional">${ask ? formatNotional(ask.notional) : '—'}</span>
                        <span class="x-val">${ask ? (ask.x || 0).toFixed(2) + 'x' : '—'}</span>
                    </span>
                </div>
            </div>
            <div class="card-footer">
                <span class="score">Score: ${score.toFixed(4)}</span>
                <span class="vol">Vol 3×5m: ${formatNotional(vol3)}</span>
                <button class="btn-star ${inWatchlist ? 'active' : ''}" onclick="toggleWatchlist('${symbol}')" style="border:none;background:transparent;cursor:pointer;">
                    ${inWatchlist ? '⭐' : '☆'}
                </button>
            </div>
        </div>
    `}).join('')

    container.innerHTML = cards
}

function renderCardRow(entry, side) {
    const sideData = entry[side]
    if (!sideData) {
        return `<div class="card-row muted"><span class="label">${side.toUpperCase()} —</span></div>`
    }
    
    const isMM = entry.isMM || false
    
    return `
        <div class="card-row ${side} ${isMM ? 'isMM' : ''}">
            <span class="label">
                ${side === 'bid' ? '🔴' : '🟢'} ${side.toUpperCase()}
            </span>
            <span class="value">
                <span>${formatNumber(sideData.levelPrice, 2)}</span>
                <span>${formatPercent(sideData.distancePct)}</span>
                <span>${formatNotional(sideData.notional)}</span>
                <span class="x-val">${(sideData.x || 0).toFixed(2)}x</span>
            </span>
        </div>
    `
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

// Watchlist functions
function loadWatchlist() {
    try {
        const saved = localStorage.getItem('futures-screener-watchlist')
        if (saved) {
            state.watchlist = JSON.parse(saved)
        }
    } catch (err) {
        console.error('Failed to load watchlist:', err)
        state.watchlist = []
    }
}

function saveWatchlist() {
    try {
        localStorage.setItem('futures-screener-watchlist', JSON.stringify(state.watchlist))
    } catch (err) {
        console.error('Failed to save watchlist:', err)
    }
}

function addToWatchlist(symbol) {
    if (!state.watchlist.includes(symbol)) {
        state.watchlist.push(symbol)
        saveWatchlist()
    }
}

function removeFromWatchlist(symbol) {
    state.watchlist = state.watchlist.filter(s => s !== symbol)
    saveWatchlist()
}

function isSymbolInWatchlist(symbol) {
    return state.watchlist.includes(symbol)
}

// Глобальная функция для кнопок (используется в onclick)
window.toggleWatchlist = function(symbol) {
    if (state.watchlist.includes(symbol)) {
        removeFromWatchlist(symbol)
    } else {
        addToWatchlist(symbol)
    }
    // Перерисовать watchlist, если сейчас на вкладке watchlist
    if (state.currentTab === 'watchlist') {
        renderWatchlist(state.watchlistData || [])
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init)

// Render watchlist view (mobile + desktop)
function renderWatchlist(entries) {
    const container = el('cardsContent')
    const table = el('table-container')
    
    if (!entries || entries.length === 0) {
        if (el('cardsContent').style.display !== 'none') {
            container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">Watchlist пуст. Добавьте символы, нажав на ⭐.</p>`
        } else {
            table.innerHTML = `<table class="table"><thead><tr><th colspan="11" style="text-align:center;color:var(--text-muted);">Watchlist пуст. Добавьте символы, нажав на ⭐.</th></tr></thead></table>`
        }
        return
    }
    
    // Для watchlist показываем только символы из списка
    const watchlistEntries = entries.filter(d => state.watchlist.includes(d.symbol))
    
    if (watchlistEntries.length === 0) {
        if (el('cardsContent').style.display !== 'none') {
            container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</p>`
        } else {
            table.innerHTML = `<table class="table"><thead><tr><th colspan="11" style="text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</th></tr></thead></table>`
        }
        return
    }
    
    renderDensities(watchlistEntries)
}
