// Futures Screener - Densities UI
// Utilities and Core Helpers
const el = (id) => document.getElementById(id)
const qs = (selector) => document.querySelector(selector)
const qsa = (selector) => document.querySelectorAll(selector)

// Configuration
const CONFIG = {
    API_BASE_URL: '/densities/simple',
    DEFAULT_MIN_NOTIONAL: 50000,
    DEFAULT_SYMBOLS: '',
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
    minNotional: 0,
    windowPct: 5.0,
    depthLimit: 100,
    minScore: 0, // фильтр по Score
    symbols: '',
    concurrency: 6,
    xFilter: 0,
    natrFilter: 0,
    interval: CONFIG.DEFAULT_INTERVAL,
    sortField: 'score', // сортировка по умолчанию
    sortAsc: false,
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

    if (el('minScore')) {
        el('minScore').addEventListener('input', (e) => {
            state.minScore = Number(e.target.value)
            loadDensities()
        })
    }

    el('windowPct').addEventListener('input', (e) => {
        state.windowPct = Number(e.target.value)
        loadDensities()
    })

    el('depthLimit').addEventListener('input', (e) => {
        state.depthLimit = Number(e.target.value)
        loadDensities()
    })

    el('symbols').addEventListener('input', (e) => {
        state.symbols = e.target.value
        loadDensities()
    })

    el('concurrency').addEventListener('input', (e) => {
        state.concurrency = Number(e.target.value)
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
        el('tbody').innerHTML = `<tr><td colspan="16" class="muted">No data available</td></tr>`
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

    // Modal controls (mobile)
    if (el('filterToggle') && el('filterModal')) {
        el('filterToggle').addEventListener('click', () => {
            el('modalMinNotional').value = state.minNotional
            el('modalMinScore').value = state.minScore
            el('modalWindowPct').value = state.windowPct
            el('modalDepthLimit').value = state.depthLimit
            el('modalSymbols').value = state.symbols
            el('modalConcurrency').value = state.concurrency
            el('modalNatrFilter').value = state.natrFilter
            el('filterModal').classList.remove('hidden')
        })
        el('modalClose').addEventListener('click', () => {
            el('filterModal').classList.add('hidden')
        })
        el('modalClear').addEventListener('click', () => {
            el('modalMinNotional').value = CONFIG.DEFAULT_MIN_NOTIONAL
            if (el('modalMinScore')) el('modalMinScore').value = 0
            el('modalWindowPct').value = 5.0
            el('modalDepthLimit').value = 100
            el('modalSymbols').value = ''
            el('modalConcurrency').value = 6
            el('modalNatrFilter').value = 0
            el('xFilter').value = 0
        })
        el('modalApply').addEventListener('click', () => {
            state.minNotional = Number(el('modalMinNotional').value)
            if (el('modalMinScore')) state.minScore = Number(el('modalMinScore').value)
            state.windowPct = Number(el('modalWindowPct').value)
            state.depthLimit = Number(el('modalDepthLimit').value)
            state.symbols = el('modalSymbols').value
            state.concurrency = Number(el('modalConcurrency').value)
            state.natrFilter = Number(el('modalNatrFilter').value)
            updateControlsFromState()
            el('filterModal').classList.add('hidden')
            loadDensities()
        })
    }

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

    // Сортировка таблицы
    document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort
            if (state.sortField === field) {
                state.sortAsc = !state.sortAsc
            } else {
                state.sortField = field
                state.sortAsc = false // по умолчанию по убыванию
            }
            // Update UI arrows
            document.querySelectorAll('th.sortable').forEach(el => el.textContent = el.textContent.replace(/[▲▼]/g, '').trim())
            th.textContent = `${th.textContent.trim()} ${state.sortAsc ? '▲' : '▼'}`

            // Re-render only if data exists
            if (state.cache.data) {
                renderDensities(state.cache.data)
            }
        })
    })
}

function updateControlsFromState() {
    el('minNotional').value = state.minNotional
    if (el('minScore')) el('minScore').value = state.minScore
    el('windowPct').value = state.windowPct
    el('depthLimit').value = state.depthLimit
    el('symbols').value = state.symbols
    el('concurrency').value = state.concurrency
    el('interval').value = state.interval
    el('auto').checked = state.autoRefresh
    el('onlyMM').checked = state.onlyMM || true
    el('xFilter').value = state.xFilter || 0
    el('natrFilter').value = state.natrFilter || 0
}

function getCacheKey() {
    return JSON.stringify({
        minNotional: state.minNotional,
        minScore: state.minScore,
        windowPct: state.windowPct,
        depthLimit: state.depthLimit,
        symbols: state.symbols,
        concurrency: state.concurrency,
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
            minScore: state.minScore,
            windowPct: state.windowPct,
            depthLimit: state.depthLimit,
            xFilter: state.xFilter,
            natrFilter: state.natrFilter,
            concurrency: state.concurrency,
            mmMode: state.onlyMM ? 'true' : 'false'
        })
        if (state.symbols && state.symbols.trim() !== '') {
            params.set('symbols', state.symbols.trim())
        }
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
        tbody.innerHTML = `<tr><td colspan="16" class="muted">Нет данных</td></tr>`
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

    // Преобразуем в массив и сортируем по максимальному значению поля
    const sorted = [...grouped.entries()].sort((a, b) => {
        const getVal = (data, field) => {
            const v1 = data.bid ? data.bid[field] : -999999999
            const v2 = data.ask ? data.ask[field] : -999999999
            return Math.max(v1 || 0, v2 || 0)
        }

        // Для символа сортируем как строки
        if (state.sortField === 'symbol') {
            return state.sortAsc ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0])
        }

        // Мапинг полей сортировки
        let fieldMap = state.sortField
        if (fieldMap === 'distance') fieldMap = 'distancePct'
        if (fieldMap === 'speed') fieldMap = 'eatSpeed'
        if (fieldMap === 'life') fieldMap = 'lifetimeSec'

        const valA = getVal(a[1], fieldMap)
        const valB = getVal(b[1], fieldMap)

        return state.sortAsc ? (valA - valB) : (valB - valA)
    })

    const rows = sorted.map(([symbol, data]) => {
        const { bid, ask } = data
        const score = Math.max(bid?.score || 0, ask?.score || 0)
        const vol3 = bid?.vol3 || ask?.vol3 || 0
        const inWatchlist = isSymbolInWatchlist(symbol)

        // Вспомогательная функция для рендера ячейки side
        const renderSideCell = (sideEntry) => {
            if (!sideEntry) {
                return `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>`
            }
            return `
                <td>${formatNumber(sideEntry.price, 2)}</td>
                <td>${formatPercent(sideEntry.distancePct)}</td>
                <td>${formatNotional(sideEntry.notional)}</td>
                <td>${sideEntry.x ? sideEntry.x.toFixed(2) + 'x' : '—'}</td>
            `
        }

        const natr = bid?.natr || ask?.natr || 0
        const vol1 = bid?.vol1 || ask?.vol1 || 0
        const vol2 = bid?.vol2 || ask?.vol2 || 0
        const isMM = ((bid?.mmCount || 0) > 1) || ((ask?.mmCount || 0) > 1)

        const topState = bid?.state || ask?.state || 'APPEARED'
        let stateDot = '<span style="color:#10b981;">●</span> APPEARED' // green
        if (topState === 'UPDATED') stateDot = '<span style="color:#f59e0b;">●</span> UPDATED' // yellow
        if (topState === 'MOVED') stateDot = '<span style="color:#ef4444;">●</span> MOVED' // red
        if (topState === 'STANDING') stateDot = '<span style="color:#3b82f6;">●</span> STANDING' // blue

        const life = Math.max(bid?.lifetimeSec || 0, ask?.lifetimeSec || 0)
        const lifeStr = life > 60 ? `${Math.floor(life / 60)}m ${life % 60}s` : `${life}s`
        const speed = Math.max(bid?.eatSpeed || 0, ask?.eatSpeed || 0)

        return `
        <tr class="${isMM ? 'isMM' : ''}">
            <td class="sym">${symbol}</td>
            ${renderSideCell(bid)}
            <td>${natr > 0 ? natr.toFixed(2) + '%' : '—'}</td>
            <td>${formatNotional(vol1)}</td>
            <td>${formatNotional(vol2)}</td>
            <td>${formatNotional(vol3)}</td>
            ${renderSideCell(ask)}
            <td class="score">${score.toFixed(4)}</td>
            <td class="state-cell">${stateDot}</td>
            <td>${lifeStr}</td>
            <td>${formatNotional(speed)}/s</td>
            <td style="text-align: center;">${isMM ? '⭐' : '—'}</td>
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
    // Авто-определение mobile/desktop
    const isMobile = window.innerWidth <= 768 || /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    console.log('renderDensities:', isMobile, 'entries:', entries?.length)

    const cardsContainer = el('cardsContent')
    const tableContainer = el('table-container')

    console.log('Containers:', { cardsContainer: !!cardsContainer, tableContainer: !!tableContainer })

    if (isMobile) {
        console.log('Using cards')
        if (!cardsContainer) {
            console.error('cardsContent element not found!')
            // Fallback: show error on page
            document.body.innerHTML += `< div style = "color:red;padding:20px;" > ERROR: cardsContent element not found</div > `
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

function renderSide(entry, side) {
    const sideData = entry[side]
    if (!sideData) {
        return `
        < td class="muted" >—</td >
            <td class="muted">—</td>
            <td class="muted">—</td>
    `
    }

    return `
        < td > ${formatNumber(sideData.levelPrice, 2)}</td >
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

    if (grouped.size === 0) {
        container.innerHTML = `<div style="padding:20px;color:#f00;">DEBUG: grouped.size == 0</div>`
        return
    }

    const cards = [...grouped.entries()].map(([symbol, data]) => {
        const { bid, ask } = data
        const score = Math.max(bid?.score || 0, ask?.score || 0)
        const vol1 = bid?.vol1 || ask?.vol1 || 0
        const vol2 = bid?.vol2 || ask?.vol2 || 0
        const vol3 = bid?.vol3 || ask?.vol3 || 0
        const natr = bid?.natr || ask?.natr || 0
        const isMM = ((bid?.mmCount || 0) > 1) || ((ask?.mmCount || 0) > 1)
        const inWatchlist = isSymbolInWatchlist(symbol)

        const topState = bid?.state || ask?.state || 'APPEARED'
        let stateDot = '<span style="color:#10b981;">●</span> APPEARED'
        if (topState === 'UPDATED') stateDot = '<span style="color:#f59e0b;">●</span> UPDATED'
        if (topState === 'MOVED') stateDot = '<span style="color:#ef4444;">●</span> MOVED'
        if (topState === 'STANDING') stateDot = '<span style="color:#3b82f6;">●</span> STANDING'

        const life = Math.max(bid?.lifetimeSec || 0, ask?.lifetimeSec || 0)
        const lifeStr = life > 60 ? `${Math.floor(life / 60)}m ${life % 60}s` : `${life}s`
        const speed = Math.max(bid?.eatSpeed || 0, ask?.eatSpeed || 0)

        return `
        <div class="card ${isMM ? 'isMM' : ''}" data-symbol="${symbol}">
            <div class="card-header">
                <div>
                    <a href="https://www.binance.com/en/futures/${symbol}" target="_blank">${symbol}</a>
                    <span class="mm-badge ${isMM ? 'active' : ''}">${isMM ? 'MM' : ''}</span>
                    <button class="btn-star ${inWatchlist ? 'active' : ''}" style="margin-left:8px; background:none; border:none; color:inherit; cursor:pointer;" onclick="toggleWatchlist('${symbol}')">${inWatchlist ? '⭐' : '☆'}</button>
                </div>
                <div style="font-size:12px; opacity:0.8">${stateDot}</div>
            </div>
            <div class="card-body">
                <div class="card-row bid ${(bid?.mmCount || 0) > 1 ? 'isMM' : ''}">
                    <span class="label">🔴 BID</span>
                    <span class="value">
                        ${bid ? formatNumber(bid.price, 2) : '—'}
                        <span class="dist">${bid ? formatPercent(bid.distancePct) : '—'}</span>
                    </span>
                    <span class="notional">${bid ? formatNotional(bid.notional) : '—'} <span style="font-size:10px; opacity:0.6">${bid?.x ? bid.x.toFixed(1) + 'x' : ''}</span></span>
                </div>
                <div class="card-row ask ${(ask?.mmCount || 0) > 1 ? 'isMM' : ''}">
                    <span class="label">🟢 ASK</span>
                    <span class="value">
                        ${ask ? formatNumber(ask.price, 2) : '—'}
                        <span class="dist">${ask ? formatPercent(ask.distancePct) : '—'}</span>
                    </span>
                    <span class="notional">${ask ? formatNotional(ask.notional) : '—'} <span style="font-size:10px; opacity:0.6">${ask?.x ? ask.x.toFixed(1) + 'x' : ''}</span></span>
                </div>
                <div class="card-row" style="margin-top:8px; padding-top:8px; border-top:1px solid #333;">
                    <span class="label">NATR:</span>
                    <span class="value">${natr > 0 ? natr.toFixed(2) + '%' : '—'}</span>
                    <span class="label" style="margin-left:10px">Score:</span>
                    <span class="value" style="color:var(--text-bright)">${score.toFixed(2)}</span>
                </div>
                <div class="card-row" style="margin-top:4px;">
                    <span class="label">Time:</span>
                    <span class="value">${lifeStr}</span>
                    <span class="label" style="margin-left:10px">Speed:</span>
                    <span class="value">${formatNotional(speed)}/s</span>
                </div>
                <div class="card-row" style="margin-top:4px;">
                    <span class="label">Vols (1/2/3):</span>
                    <span class="value" style="font-size:12px">${formatNotional(vol1)}/${formatNotional(vol2)}/${formatNotional(vol3)}</span>
                </div>
            </div>
        </div>
        `
    }).join('')

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
window.toggleWatchlist = function (symbol) {
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
            table.innerHTML = `<table class="table"><thead><tr><th colspan="19" style="text-align:center;color:var(--text-muted);">Watchlist пуст. Добавьте символы, нажав на ⭐.</th></tr></thead></table>`
        }
        return
    }

    // Для watchlist показываем только символы из списка
    const watchlistEntries = entries.filter(d => state.watchlist.includes(d.symbol))

    if (watchlistEntries.length === 0) {
        if (el('cardsContent').style.display !== 'none') {
            container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</p>`
        } else {
            table.innerHTML = `<table class="table"><thead><tr><th colspan="19" style="text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</th></tr></thead></table>`
        }
        return
    }

    renderDensities(watchlistEntries)
}
