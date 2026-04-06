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
    blacklist: '', // Список монет для исключения
    hideSqueezes: false, // скрывать маркет-мейкеров (Squeeze)
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
    currentTab: 'mini-charts', // текущая вкладка
    watchlistData: null // кэш данных watchlist
}

// Initialize
function init() {
    console.log('Futures Screener init')
    setupEventListeners()
    updateControlsFromState()
    // Load directly (no initial empty render)
    loadWatchlist() // Загрузить watchlist из localStorage
    // Default tab is mini-charts, init it on load
    if (state.currentTab === 'mini-charts') {
        initMiniCharts()
    } else {
        loadDensities(true)
    }
}

function setupEventListeners() {
    // Controls
    el('blacklist').addEventListener('input', (e) => {
        state.blacklist = e.target.value.toUpperCase()
        if (state.cache.data) renderDensities(state.cache.data)
    })

    el('hideSqueezes').addEventListener('change', (e) => {
        state.hideSqueezes = e.target.checked
        if (state.cache.data) renderDensities(state.cache.data)
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
    if (el('refreshBtn')) {
        el('refreshBtn').addEventListener('click', () => {
            loadDensities(true) // force refresh
            if (el('sidebar').classList.contains('open')) {
                el('sidebar').classList.remove('open')
            }
        })
    }

    // Sidebar overlay toggle
    if (el('toggleFiltersBtn') && el('sidebar')) {
        el('toggleFiltersBtn').addEventListener('click', () => {
            el('sidebar').classList.add('open')
        })
        if (el('closeFiltersBtn')) {
            el('closeFiltersBtn').addEventListener('click', () => {
                el('sidebar').classList.remove('open')
            })
        }
    }

    // Вкладки (tabs)
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
            tab.classList.add('active')

            const tabName = tab.dataset.tab
            state.currentTab = tabName

            // Скрыть все вкладки
            document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none')
            
            // Показать нужную
            const targetContent = document.getElementById(`tab-${tabName}`)
            if (targetContent) {
                targetContent.style.display = 'block'
            }

            // Обновить UI в зависимости от вкладки
            if (tabName === 'densities') {
                if (state.cache.data) renderDensities(state.cache.data)
            } else if (tabName === 'mini-charts') {
                if (typeof initMiniCharts === 'function') {
                    initMiniCharts()
                }
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
    if (el('blacklist')) el('blacklist').value = state.blacklist
    if (el('hideSqueezes')) el('hideSqueezes').checked = state.hideSqueezes
    el('interval').value = state.interval
    el('auto').checked = state.autoRefresh
    el('xFilter').value = state.xFilter || 0
    el('natrFilter').value = state.natrFilter || 0
}

function getCacheKey() {
    return JSON.stringify({
        xFilter: state.xFilter,
        natrFilter: state.natrFilter,
        interval: state.interval
        // blacklist and hideSqueezes apply locally, so they don't invalidate cache
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
            minNotional: 0,
            minScore: 0,
            windowPct: 5.0,
            depthLimit: 100,
            xFilter: state.xFilter,
            natrFilter: state.natrFilter,
            concurrency: 6,
            mmMode: 'false' // backend handles clustering logic natively
        })
        const url = `${CONFIG.API_BASE_URL}?${params.toString()}&_t=${Date.now()}`

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
        if (state.currentTab === 'densities') {
            renderDensities(data)
        }

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

// Функция для индикатора объемов (5 свечей по 5 минут)
function renderVolIndicator(vol1, vol2, vol3, vol4, vol5, density) {
    const getColor = (v) => {
        if (!v || !density) return 'low';
        if (v >= density * 0.5) return 'high';
        if (v >= density * 0.2) return 'med';
        return 'low';
    };

    // vol1 - самая новая свеча. Слева показываем самую старую (vol5), справа - самую новую (vol1)
    return `
        <div class="vol-indicator" title="Объемы (старые -> новые): ${formatNotional(vol5)} | ${formatNotional(vol4)} | ${formatNotional(vol3)} | ${formatNotional(vol2)} | ${formatNotional(vol1)}">
            <div class="vol-block ${getColor(vol5)}"></div>
            <div class="vol-block ${getColor(vol4)}"></div>
            <div class="vol-block ${getColor(vol3)}"></div>
            <div class="vol-block ${getColor(vol2)}"></div>
            <div class="vol-block ${getColor(vol1)}"></div>
        </div>
    `;
}

// Render table (desktop)
function renderTable(entries) {
    const tbody = el('tbody')

    if (!entries || entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center; padding: 20px;">Нет данных</td></tr>'
        return
    }

    // Сортируем данные напрямую (без группировки)
    const sorted = [...entries].sort((a, b) => {
        if (state.sortField === 'symbol') {
            return state.sortAsc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol)
        }

        let fieldMap = state.sortField
        if (fieldMap === 'distance') fieldMap = 'distancePct'
        if (fieldMap === 'speed') fieldMap = 'timeToEatMinutes'
        if (fieldMap === 'age') fieldMap = 'lifetimeSec'

        const valA = a[fieldMap] || 0
        const valB = b[fieldMap] || 0

        return state.sortAsc ? (valA - valB) : (valB - valA)
    })

    const rows = sorted.map(entry => {
        const symbol = entry.symbol
        const inWatchlist = isSymbolInWatchlist(symbol)

        const isMM = entry.levelsCount > 1
        let stateDot = '<span style="color:var(--text-muted);">🛡️</span> <span style="color:var(--text-muted);">Waiting</span>'

        if (entry.tags && entry.tags.length > 0) {
            if (entry.tags.includes('SPOOF-FAR') || entry.tags.includes('NEW-FAR')) {
                stateDot = '<span style="color:#ef4444;">❌</span> Спуфер'
            } else if (entry.tags.includes('ROBOT-AGGRESSOR')) {
                stateDot = '<span style="color:#f59e0b;">⚔️</span> Робот-толкач'
            } else if (entry.tags.includes('CONCRETE-15M') || entry.tags.includes('CONCRETE-5M')) {
                stateDot = '<span style="color:var(--neon-green);">🧱</span> Бетон'
            } else if (entry.tags.includes('TECH-NATR')) {
                 stateDot = '<span style="color:#a855f7;">🎯</span> Тех.Уровень'
            }
        }

        const sideBlock = entry.sideKey === 'bid'
            ? '<span style="color:#60a5fa; font-weight:600;">LONG (BID)</span>'
            : '<span style="color:#fb923c; font-weight:600;">SHORT (ASK)</span>'

        return `
        <tr class="${isMM ? 'isMM' : ''}">
            <td class="sym">
                <a href="https://www.bybit.com/trade/usdt/${symbol}" target="_blank" style="margin-right: 6px;">${symbol.replace('USDT', '')}</a>
                <a href="https://www.binance.com/en/futures/${symbol}" target="_blank" title="Binance Futures" style="text-decoration:none;">
                    <span style="display:inline-block; width:14px; height:14px; line-height:14px; text-align:center; background:#f3ba2f; color:#000; border-radius:50%; font-size:10px; font-weight:bold; vertical-align:middle; opacity:0.8; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'">B</span>
                </a>
            </td>
            <td>${sideBlock}</td>
            <td>
                <span style="color:#e2e8f0; font-weight:500;">${formatNumber(entry.price, 4)}</span><br>
                <span style="color:#94a3b8; font-size:11px;">${formatPercent(entry.distancePct)}</span>
            </td>
            <td style="font-family: monospace; font-size: 14px;">${formatNotional(entry.notional)}</td>
            <td>${renderVolIndicator(entry.vol1, entry.vol2, entry.vol3, entry.vol4, entry.vol5, entry.notional)}</td>
            <td class="natr">${(entry.natr || 0) > 0 ? entry.natr.toFixed(1) + '%' : '—'}</td>
            <td class="score" style="color:var(--neon-yellow);">${(entry.score || 0).toFixed(1)}</td>
            <td style="font-family: monospace; color: #a1a1aa;">${entry.lifetimeMins}m</td>
            <td class="state-cell">${stateDot}</td>
            <td style="font-family: monospace; color: #a1a1aa;">${formatTimeToEat(entry.timeToEatMinutes)}</td>
            <td class="watchlist-btn">
                <button class="btn-star ${inWatchlist ? 'active' : ''}" onclick="toggleWatchlist('${symbol}')">
                    ${inWatchlist ? '⭐' : '☆'}
                </button>
            </td>
        </tr>
        `
    }).join('')

    tbody.innerHTML = rows
}

// Render table
function renderDensities(entries) {
    if (!entries) return

    // Применяем локальные фильтры (Blacklist и HideSqueezes)
    let finalEntries = entries

    if (state.blacklist && state.blacklist.trim() !== '') {
        const blacklistArray = state.blacklist.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
        if (blacklistArray.length > 0) {
            finalEntries = finalEntries.filter(e => !blacklistArray.some(b => e.symbol.includes(b)))
        }
    }

    // Авто-определение mobile/desktop
    const isMobile = window.innerWidth <= 768 || /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    console.log('renderDensities:', isMobile, 'entries:', finalEntries.length)

    entries = finalEntries

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

function formatTimeToEat(minutes) {
    if (!minutes || minutes === Infinity) return '∞'
    if (minutes < 60) return `${Math.floor(minutes)}m`
    const hours = Math.floor(minutes / 60)
    const mins = Math.floor(minutes % 60)
    if (hours < 24) return `${hours}h ${mins}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

function formatAge(seconds) {
    if (seconds == null || isNaN(seconds)) return '—'
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    if (mins < 60) return `${mins}m ${seconds % 60}s`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ${mins % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
}

// Render cards (mobile)
function renderCards(entries) {
    const container = el('cardsContent')

    if (!entries || entries.length === 0) {
        container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">Нет данных</p>`
        return
    }

    const sorted = [...entries].sort((a, b) => {
        let fieldMap = state.sortField
        if (fieldMap === 'distance') fieldMap = 'distancePct'
        if (fieldMap === 'speed') fieldMap = 'timeToEatMinutes'
        if (fieldMap === 'age') fieldMap = 'lifetimeSec'
        const valA = a[fieldMap] || 0
        const valB = b[fieldMap] || 0
        return state.sortAsc ? (valA - valB) : (valB - valA)
    })

    const cards = sorted.map(entry => {
        const symbol = entry.symbol
        const inWatchlist = isSymbolInWatchlist(symbol)

        const isMM = entry.levelsCount > 1
        let stateDot = '<span style="color:var(--text-muted);">🛡️</span> <span style="color:var(--text-muted);">Waiting</span>'

        if (entry.tags && entry.tags.length > 0) {
            if (entry.tags.includes('SPOOF-FAR') || entry.tags.includes('NEW-FAR')) {
                stateDot = '<span style="color:#ef4444;">❌</span> Спуфер'
            } else if (entry.tags.includes('ROBOT-AGGRESSOR')) {
                stateDot = '<span style="color:#f59e0b;">⚔️</span> Робот-толкач'
            } else if (entry.tags.includes('CONCRETE-15M') || entry.tags.includes('CONCRETE-5M')) {
                stateDot = '<span style="color:var(--neon-green);">🧱</span> Бетон'
            } else if (entry.tags.includes('TECH-NATR')) {
                 stateDot = '<span style="color:#a855f7;">🎯</span> Тех.Уровень'
            }
        }

        const sideClass = entry.sideKey === 'bid' ? 'bid' : 'ask'
        const sideIcon = entry.sideKey === 'bid' ? '<span style="color:#60a5fa;">🔵 LONG (BID)</span>' : '<span style="color:#fb923c;">🟠 SHORT (ASK)</span>'

        return `
        <div class="card ${isMM ? 'isMM' : ''}" data-symbol="${symbol}">
            <div class="card-header">
                <div>
                    <a href="https://www.bybit.com/trade/usdt/${symbol}" target="_blank" style="margin-right: 6px;">${symbol.replace('USDT', '')}</a>
                    <a href="https://www.binance.com/en/futures/${symbol}" target="_blank" title="Binance Futures" style="text-decoration:none;">
                        <span style="display:inline-block; width:16px; height:16px; line-height:16px; text-align:center; background:#f3ba2f; color:#000; border-radius:50%; font-size:11px; font-weight:bold; vertical-align:text-bottom; opacity:0.8;">B</span>
                    </a>
                    
                    <button class="btn-star ${inWatchlist ? 'active' : ''}" style="margin-left:8px; background:none; border:none; color:inherit; cursor:pointer;" onclick="toggleWatchlist('${symbol}')">${inWatchlist ? '⭐' : '☆'}</button>
                </div>
                <div style="font-size:12px; opacity:0.8">${stateDot}</div>
            </div>
            <div class="card-body">
                <div class="card-row ${sideClass} ${isMM ? 'isMM' : ''}">
                    <span class="label">${sideIcon}</span>
                    <span class="value" style="display:flex; flex-direction:column; align-items:flex-end;">
                        <span style="font-weight:500; font-size:14px;">${formatNumber(entry.price, 4)}</span>
                        <span class="dist" style="font-size:11px; margin-top:2px;">${formatPercent(entry.distancePct)}</span>
                    </span>
                    <span class="notional">${formatNotional(entry.notional)}</span>
                </div>
                <div class="card-row" style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.05);">
                    <span class="label">Vol Indicator:</span>
                    <span class="value">${renderVolIndicator(entry.vol1, entry.vol2, entry.vol3, entry.vol4, entry.vol5, entry.notional)}</span>
                </div>
                <div class="card-row" style="margin-top:4px;">
                    <span class="label">NATR:</span>
                    <span class="value">${(entry.natr || 0) > 0 ? entry.natr.toFixed(1) + '%' : '—'}</span>
                    <span class="label" style="margin-left:10px">Score:</span>
                    <span class="value" style="color:var(--neon-yellow); font-weight: 600;">${(entry.score || 0).toFixed(1)}</span>
                </div>
                <div class="card-row" style="margin-top:4px;">
                    <span class="label">Age (Mins):</span>
                    <span class="value" style="color: #a1a1aa;">${entry.lifetimeMins}m</span>
                    <span class="label" style="margin-left:10px">Time To Eat:</span>
                    <span class="value" style="color: #a1a1aa;">${formatTimeToEat(entry.timeToEatMinutes)}</span>
                </div>
            </div>
        </div>
        `
    }).join('')

    container.innerHTML = cards
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
            table.innerHTML = `<table class="table"><thead><tr><th colspan="9" style="text-align:center;color:var(--text-muted);">Watchlist пуст. Добавьте символы, нажав на ⭐.</th></tr></thead></table>`
        }
        return
    }

    // Для watchlist показываем только символы из списка
    const watchlistEntries = entries.filter(d => state.watchlist.includes(d.symbol))

    if (watchlistEntries.length === 0) {
        if (el('cardsContent').style.display !== 'none') {
            container.innerHTML = `<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</p>`
        } else {
            table.innerHTML = `<table class="table"><thead><tr><th colspan="9" style="text-align:center;color:var(--text-muted);">В watchlist нет уровней с текущими фильтрами.</th></tr></thead></table>`
        }
        return
    }

    renderDensities(watchlistEntries)
}

// ==========================================
// Mini-Charts v3 — Full Market Screener
// Uses IntersectionObserver to only render visible charts
// ==========================================
const mc = {
    sortBy: 'volume',
    globalTF: '15m',
    loaded: false,
    allPairs: [],        // all fetched pairs (unfiltered)
    filteredPairs: [],   // after filters applied
    charts: {},          // { sym: { chart, series, lines[] } } — only visible ones
    loadedData: {},      // { sym: true } — tracks which symbols have been loaded
    observer: null,      // IntersectionObserver
    loadQueue: [],       // queue for staggered loading
    loadingActive: false,
    filters: { minVol: 50, minNatr: 0, minTrades: 0 }
};

async function initMiniCharts() {
    if (!mc.loaded) {
        mc.loaded = true;

        // Global TF buttons
        const tfGroup = el('mcGlobalTF');
        if (tfGroup) {
            tfGroup.addEventListener('click', (e) => {
                const btn = e.target.closest('.mc-tf-btn');
                if (!btn) return;
                tfGroup.querySelectorAll('.mc-tf-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mc.globalTF = btn.dataset.tf;
                // Reload all currently visible charts with new TF
                mc.loadedData = {};
                Object.keys(mc.charts).forEach(sym => {
                    mc.loadQueue.push(sym);
                });
                processLoadQueue();
            });
        }

        // Sort select
        const sortSel = el('mcSortBy');
        if (sortSel) {
            sortSel.addEventListener('change', (e) => {
                mc.sortBy = e.target.value;
                applyFiltersAndRebuild();
            });
        }

        // Filters
        ['mcFilterVol', 'mcFilterNatr', 'mcFilterTrades'].forEach(id => {
            const sel = el(id);
            if (sel) {
                sel.addEventListener('change', () => {
                    mc.filters.minVol = parseFloat(el('mcFilterVol').value);
                    mc.filters.minNatr = parseFloat(el('mcFilterNatr').value);
                    mc.filters.minTrades = parseFloat(el('mcFilterTrades').value);
                    applyFiltersAndRebuild();
                });
            }
        });

        // Refresh button
        const refreshBtn = el('mcRefreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => refreshMiniCharts());
        }

        // Init modal events
        initModalEvents();

        // Setup IntersectionObserver
        mc.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const sym = entry.target.dataset.symbol;
                if (!sym) return;
                if (entry.isIntersecting) {
                    // Card scrolled into view — create chart & load data
                    if (!mc.charts[sym]) {
                        createChartInstance(sym);
                        mc.loadQueue.push(sym);
                        processLoadQueue();
                    }
                } else {
                    // Card scrolled out — destroy chart to free memory
                    if (mc.charts[sym]) {
                        mc.charts[sym].chart.remove();
                        delete mc.charts[sym];
                        delete mc.loadedData[sym];
                    }
                }
            });
        }, {
            root: null,
            rootMargin: '200px', // preload 200px before visible
            threshold: 0
        });
    }

    if (mc.allPairs.length === 0) {
        await refreshMiniCharts();
    }
}

async function refreshMiniCharts() {
    const status = el('mcStatus');
    if (status) status.textContent = 'Loading...';

    try {
        const res = await fetch('/api/ticker24hr');
        const data = await res.json();

        let pairs = data.filter(d => d.symbol.endsWith('USDT') && !d.symbol.includes('_'));

        pairs.forEach(p => {
            const h = parseFloat(p.highPrice);
            const l = parseFloat(p.lowPrice);
            p.proxyNatr = l > 0 ? ((h - l) / l * 100) : 0;
            p.quoteVol = parseFloat(p.quoteVolume);
            p.tradesCount = parseInt(p.count);
            p.priceChange = parseFloat(p.priceChangePercent);
            p.lastPrice = parseFloat(p.lastPrice);
        });

        // Filter out frozen/halted/delisted pairs
        // Frozen pairs have closeTime far in the past (trading stopped)
        const now = Date.now();
        pairs = pairs.filter(p => {
            const closeTime = parseInt(p.closeTime);
            const age = now - closeTime;
            // If last trade was >1 hour ago, pair is frozen
            if (age > 3600000) return false;
            // Also filter flat pairs where high == low
            if (parseFloat(p.highPrice) === parseFloat(p.lowPrice)) return false;
            return true;
        });

        mc.allPairs = pairs;
        applyFiltersAndRebuild();

        if (status) {
            status.textContent = `${mc.filteredPairs.length}/${pairs.length}`;
        }
    } catch (e) {
        console.error('Mini-Charts fetch error:', e);
        if (status) status.textContent = 'Error';
    }
}

function applyFiltersAndRebuild() {
    mc.filteredPairs = mc.allPairs.filter(p => {
        if (mc.filters.minVol > 0 && p.quoteVol < mc.filters.minVol * 1e6) return false;
        if (mc.filters.minNatr > 0 && p.proxyNatr < mc.filters.minNatr) return false;
        if (mc.filters.minTrades > 0 && p.tradesCount < mc.filters.minTrades) return false;
        return true;
    });
    rebuildGrid();
    const status = el('mcStatus');
    if (status) status.textContent = `${mc.filteredPairs.length}/${mc.allPairs.length}`;
}

function rebuildGrid() {
    // Destroy all existing charts
    Object.keys(mc.charts).forEach(sym => {
        mc.charts[sym].chart.remove();
        delete mc.charts[sym];
    });
    mc.loadedData = {};
    mc.loadQueue = [];

    sortPairs();
    renderSidebar();

    const grid = el('chartsGrid');
    if (!grid) return;

    // Disconnect old observations
    mc.observer.disconnect();

    // Render ALL cards (lightweight — just header + empty body)
    grid.innerHTML = mc.filteredPairs.map(p => {
        const sym = p.symbol;
        const ticker = sym.replace('USDT', '');
        const chg = p.priceChange;
        const chgClass = chg >= 0 ? 'mc-metric-green' : 'mc-metric-red';
        const chgSign = chg >= 0 ? '+' : '';
        const vol = p.quoteVol >= 1e9 ? (p.quoteVol / 1e9).toFixed(1) + 'B' : (p.quoteVol / 1e6).toFixed(0) + 'M';
        const natr = p.proxyNatr.toFixed(1);

        return `<div class="mc-chart-card" data-symbol="${sym}" id="mc-card-${sym}">
            <div class="mc-chart-header">
                <span class="mc-chart-symbol">${ticker}</span>
                <div class="mc-chart-metrics">
                    <span class="${chgClass}">${chgSign}${chg.toFixed(2)}%</span>
                    <span class="mc-metric-muted">$${vol}</span>
                    <span class="mc-metric-muted">R${natr}%</span>
                </div>
            </div>
            <div class="mc-chart-body" id="mc-body-${sym}"></div>
        </div>`;
    }).join('');

    // Observe all cards + click to open modal
    grid.querySelectorAll('.mc-chart-card').forEach(card => {
        mc.observer.observe(card);
        card.querySelector('.mc-chart-header').addEventListener('click', () => {
            openCoinModal(card.dataset.symbol);
        });
    });
}

function sortPairs() {
    const sorter = (a, b) => {
        if (mc.sortBy === 'natr') return b.proxyNatr - a.proxyNatr;
        if (mc.sortBy === 'trades') return b.tradesCount - a.tradesCount;
        if (mc.sortBy === 'change') return Math.abs(b.priceChange) - Math.abs(a.priceChange);
        return b.quoteVol - a.quoteVol;
    };
    mc.allPairs.sort(sorter);
    mc.filteredPairs.sort(sorter);
}

function renderSidebar() {
    const list = el('mcCoinList');
    const countEl = el('mcCoinCount');
    if (!list) return;

    if (countEl) countEl.textContent = mc.filteredPairs.length;

    list.innerHTML = mc.filteredPairs.map(p => {
        const sym = p.symbol;
        const ticker = sym.replace('USDT', '');
        const chg = p.priceChange;
        const chgClass = chg >= 0 ? 'mc-metric-green' : 'mc-metric-red';
        const chgSign = chg >= 0 ? '+' : '';
        const vol = p.quoteVol >= 1e9 ? (p.quoteVol / 1e9).toFixed(1) + 'B' : (p.quoteVol / 1e6).toFixed(0) + 'M';

        return `<div class="mc-coin-item" data-symbol="${sym}">
            <div>
                <span class="mc-coin-name">${ticker}</span>
                <span class="mc-coin-vol">$${vol}</span>
            </div>
            <span class="mc-coin-change ${chgClass}">${chgSign}${chg.toFixed(2)}%</span>
        </div>`;
    }).join('');

    // Click handler — open coin modal
    list.querySelectorAll('.mc-coin-item').forEach(item => {
        item.addEventListener('click', () => {
            openCoinModal(item.dataset.symbol);
        });
    });
}

function getPricePrecision(price) {
    if (price >= 1000) return 2;
    if (price >= 1) return 4;
    if (price >= 0.01) return 5;
    if (price >= 0.001) return 6;
    return 8;
}

function createChartInstance(sym) {
    const chartEl = el(`mc-body-${sym}`);
    if (!chartEl || mc.charts[sym]) return;

    // Get price for precision
    const pair = mc.allPairs.find(p => p.symbol === sym);
    const price = pair ? pair.lastPrice : 1;
    const prec = getPricePrecision(price);
    const minMove = parseFloat((1 / Math.pow(10, prec)).toFixed(prec));

    const chart = LightweightCharts.createChart(chartEl, {
        autoSize: true,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#64748b' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.02)' }, horzLines: { color: 'rgba(255,255,255,0.02)' } },
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    const series = chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
        priceFormat: { type: 'price', precision: prec, minMove: minMove }
    });

    mc.charts[sym] = { chart, series, lines: [] };

    // Attach shift+drag ruler
    attachRuler(chartEl, chart, series);
}

// Staggered load queue — prevents Binance rate limiting
async function processLoadQueue() {
    if (mc.loadingActive) return;
    mc.loadingActive = true;

    while (mc.loadQueue.length > 0) {
        const sym = mc.loadQueue.shift();
        if (!mc.charts[sym]) continue; // already scrolled away
        if (mc.loadedData[sym]) continue; // already loaded this TF
        await loadChartData(sym, mc.globalTF);
        await new Promise(r => setTimeout(r, 80));
    }

    mc.loadingActive = false;
}

async function loadChartData(sym, tf) {
    if (!mc.charts[sym]) return;
    try {
        const res = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=200`);
        const json = await res.json();

        if (!Array.isArray(json)) return;

        const data = json.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            highRaw: parseFloat(k[2]),
            lowRaw: parseFloat(k[3])
        }));

        if (!mc.charts[sym]) return; // check again after await

        const series = mc.charts[sym].series;
        series.setData(data);
        mc.charts[sym].chart.timeScale().fitContent();
        mc.loadedData[sym] = true;

        setTimeout(() => {
            if (mc.charts[sym]) mc.charts[sym].chart.timeScale().fitContent();
        }, 150);

        // Auto-levels disabled for now
        // if (mc.charts[sym].lines.length > 0) {
        //     mc.charts[sym].lines.forEach(l => series.removePriceLine(l));
        // }
        // mc.charts[sym].lines = [];
        // drawAutoLevels(sym, data, series);

    } catch (e) {
        console.error(`Chart load error ${sym}:`, e);
    }
}

function drawAutoLevels(sym, data, series) {
    const WINDOW = 5;
    const highs = [];
    const lows = [];

    for (let i = WINDOW; i < data.length - WINDOW; i++) {
        let isHigh = true;
        let isLow = true;
        for (let j = i - WINDOW; j <= i + WINDOW; j++) {
            if (i === j) continue;
            if (data[j].highRaw >= data[i].highRaw) isHigh = false;
            if (data[j].lowRaw <= data[i].lowRaw) isLow = false;
        }
        if (isHigh) highs.push({ time: data[i].time, price: data[i].highRaw });
        if (isLow) lows.push({ time: data[i].time, price: data[i].lowRaw });
    }

    const THRESHOLD_PCT = 0.003;
    const levels = [];

    const findClusters = (pivots, type) => {
        const used = new Set();
        for (let i = 0; i < Math.min(pivots.length, 50); i++) {
            if (used.has(i)) continue;
            const cluster = [pivots[i]];
            for (let j = i + 1; j < pivots.length; j++) {
                if (used.has(j)) continue;
                if (Math.abs(pivots[i].price - pivots[j].price) / pivots[i].price < THRESHOLD_PCT) {
                    cluster.push(pivots[j]);
                    used.add(j);
                }
            }
            if (cluster.length >= 2) {
                const avgPrice = cluster.reduce((sum, p) => sum + p.price, 0) / cluster.length;
                levels.push({ price: avgPrice, type, weight: cluster.length });
            }
        }
    };

    findClusters(highs, 'resistance');
    findClusters(lows, 'support');

    const supports = levels.filter(l => l.type === 'support').sort((a, b) => b.weight - a.weight).slice(0, 2);
    const resists = levels.filter(l => l.type === 'resistance').sort((a, b) => b.weight - a.weight).slice(0, 2);

    [...supports, ...resists].forEach(l => {
        const line = series.createPriceLine({
            price: l.price,
            color: l.type === 'support' ? '#22c55e' : '#ef4444',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: '',
        });
        mc.charts[sym].lines.push(line);
    });
}

// ==========================================
// Shift+Drag Ruler (like TradingView)
// ==========================================
function attachRuler(chartEl, chart, series) {
    let rulerActive = false;
    let startX = 0, startY = 0;
    let startPrice = 0, startTime = 0;
    let line = null, label = null;

    function createOverlay() {
        // SVG line
        line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        line.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;';
        line.innerHTML = '<line x1="0" y1="0" x2="0" y2="0" stroke="#5b9cf6" stroke-width="1.5" stroke-dasharray="4,3"/>';
        chartEl.appendChild(line);

        // Label
        label = document.createElement('div');
        label.style.cssText = 'position:absolute;z-index:101;pointer-events:none;background:rgba(59,130,246,0.9);color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;white-space:nowrap;display:none;';
        chartEl.appendChild(label);
    }

    function removeOverlay() {
        if (line) { line.remove(); line = null; }
        if (label) { label.remove(); label = null; }
    }

    chartEl.addEventListener('mousedown', (e) => {
        if (!e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = chartEl.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;

        // Convert pixel to price/time
        startPrice = series.coordinateToPrice(startY);
        startTime = chart.timeScale().coordinateToTime(startX);
        if (startPrice === null) return;

        rulerActive = true;
        removeOverlay();
        createOverlay();

        // Temporarily disable chart interaction
        chart.applyOptions({ handleScroll: false, handleScale: false });
    });

    chartEl.addEventListener('mousemove', (e) => {
        if (!rulerActive || !line || !label) return;

        const rect = chartEl.getBoundingClientRect();
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;
        const curPrice = series.coordinateToPrice(curY);
        if (curPrice === null) return;

        // Update SVG line
        const svgLine = line.querySelector('line');
        svgLine.setAttribute('x1', startX);
        svgLine.setAttribute('y1', startY);
        svgLine.setAttribute('x2', curX);
        svgLine.setAttribute('y2', curY);

        // Calculate diff
        const priceDiff = curPrice - startPrice;
        const pctDiff = startPrice !== 0 ? (priceDiff / startPrice * 100) : 0;
        const prec = getPricePrecision(Math.abs(startPrice));
        const sign = priceDiff >= 0 ? '+' : '';
        const color = priceDiff >= 0 ? '#22c55e' : '#ef4444';

        // Position label
        const midX = (startX + curX) / 2;
        const midY = Math.min(startY, curY) - 8;
        label.style.left = midX + 'px';
        label.style.top = Math.max(2, midY) + 'px';
        label.style.transform = 'translateX(-50%)';
        label.style.display = 'block';
        label.style.background = priceDiff >= 0 ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
        label.textContent = `${sign}${priceDiff.toFixed(prec)}  (${sign}${pctDiff.toFixed(2)}%)`;
    });

    const endRuler = () => {
        if (!rulerActive) return;
        rulerActive = false;
        chart.applyOptions({
            handleScroll: { mouseWheel: true, pressedMouseMove: true },
            handleScale: { mouseWheel: true, pinch: true }
        });
        // Remove after 3 seconds
        setTimeout(removeOverlay, 3000);
    };

    chartEl.addEventListener('mouseup', endRuler);
    chartEl.addEventListener('mouseleave', endRuler);
}

// ==========================================
// Coin Detail Modal
// ==========================================
const modal = {
    chart: null,
    series: null,
    lines: [],
    currentSym: null,
    currentTF: '15m'
};

function openCoinModal(sym) {
    const pair = mc.allPairs.find(p => p.symbol === sym);
    if (!pair) return;

    modal.currentSym = sym;
    modal.currentTF = mc.globalTF;

    const ticker = sym.replace('USDT', '');
    const prec = getPricePrecision(pair.lastPrice);
    const chg = pair.priceChange;
    const chgClass = chg >= 0 ? 'mc-metric-green' : 'mc-metric-red';
    const chgSign = chg >= 0 ? '+' : '';

    // Header
    el('cmSymbol').textContent = ticker + '/USDT';
    el('cmPrice').textContent = '$' + pair.lastPrice.toFixed(prec);
    const cmChange = el('cmChange');
    cmChange.textContent = chgSign + chg.toFixed(2) + '%';
    cmChange.className = 'mc-modal-change ' + chgClass;

    // Stats
    const vol = pair.quoteVol >= 1e9 ? (pair.quoteVol / 1e9).toFixed(2) + 'B' : (pair.quoteVol / 1e6).toFixed(1) + 'M';
    const tradesStr = pair.tradesCount >= 1e6 ? (pair.tradesCount / 1e6).toFixed(1) + 'M'
        : pair.tradesCount >= 1e3 ? (pair.tradesCount / 1e3).toFixed(1) + 'K'
        : pair.tradesCount.toString();
    el('cmStats').innerHTML = `
        <div class="mc-stat"><span class="mc-stat-label">24h Vol:</span><span class="mc-stat-value">$${vol}</span></div>
        <div class="mc-stat"><span class="mc-stat-label">Range:</span><span class="mc-stat-value">${pair.proxyNatr.toFixed(1)}%</span></div>
        <div class="mc-stat"><span class="mc-stat-label">Trades:</span><span class="mc-stat-value">${tradesStr}</span></div>
        <div class="mc-stat"><span class="mc-stat-label">High:</span><span class="mc-stat-value">${parseFloat(pair.highPrice).toFixed(prec)}</span></div>
        <div class="mc-stat"><span class="mc-stat-label">Low:</span><span class="mc-stat-value">${parseFloat(pair.lowPrice).toFixed(prec)}</span></div>
    `;

    // Links
    el('cmLinks').innerHTML = `
        <a href="https://www.binance.com/en/futures/${sym}" target="_blank">Binance</a>
        <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${sym}.P" target="_blank">TradingView</a>
        <a href="https://www.coinglass.com/tv/${ticker}USDT" target="_blank">CoinGlass</a>
    `;

    // TF buttons — set active
    const tfBtns = el('cmTFButtons');
    tfBtns.querySelectorAll('.mc-tf-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tf === modal.currentTF);
    });

    // Show modal
    el('coinModal').classList.remove('hidden');

    // Create or recreate chart
    if (modal.chart) {
        modal.chart.remove();
        modal.chart = null;
    }

    const chartEl = el('cmChartBody');
    const minMove = parseFloat((1 / Math.pow(10, prec)).toFixed(prec));

    modal.chart = LightweightCharts.createChart(chartEl, {
        autoSize: true,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 } },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    modal.series = modal.chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
        priceFormat: { type: 'price', precision: prec, minMove: minMove }
    });

    modal.lines = [];

    // Attach ruler to modal chart
    attachRuler(el('cmChartBody'), modal.chart, modal.series);

    loadModalChart(sym, modal.currentTF);
}

async function loadModalChart(sym, tf) {
    try {
        const res = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=500`);
        const json = await res.json();
        if (!Array.isArray(json) || !modal.chart) return;

        const data = json.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            highRaw: parseFloat(k[2]),
            lowRaw: parseFloat(k[3])
        }));

        modal.series.setData(data);
        modal.chart.timeScale().fitContent();
        setTimeout(() => { if (modal.chart) modal.chart.timeScale().fitContent(); }, 150);

        // Auto-levels disabled for now
        // modal.lines.forEach(l => modal.series.removePriceLine(l));
        // modal.lines = [];
        // drawModalLevels(data);
    } catch (e) {
        console.error('Modal chart error:', e);
    }
}

function drawModalLevels(data) {
    const WINDOW = 5;
    const highs = [], lows = [];
    for (let i = WINDOW; i < data.length - WINDOW; i++) {
        let isHigh = true, isLow = true;
        for (let j = i - WINDOW; j <= i + WINDOW; j++) {
            if (i === j) continue;
            if (data[j].highRaw >= data[i].highRaw) isHigh = false;
            if (data[j].lowRaw <= data[i].lowRaw) isLow = false;
        }
        if (isHigh) highs.push(data[i].highRaw);
        if (isLow) lows.push(data[i].lowRaw);
    }

    const THRESHOLD = 0.003;
    const findClusters = (pivots, type) => {
        const used = new Set(), result = [];
        for (let i = 0; i < Math.min(pivots.length, 60); i++) {
            if (used.has(i)) continue;
            const cluster = [pivots[i]];
            for (let j = i + 1; j < pivots.length; j++) {
                if (used.has(j)) continue;
                if (Math.abs(pivots[i] - pivots[j]) / pivots[i] < THRESHOLD) {
                    cluster.push(pivots[j]);
                    used.add(j);
                }
            }
            if (cluster.length >= 2) {
                result.push({ price: cluster.reduce((s, p) => s + p, 0) / cluster.length, type, weight: cluster.length });
            }
        }
        return result;
    };

    const levels = [
        ...findClusters(highs, 'resistance').sort((a, b) => b.weight - a.weight).slice(0, 3),
        ...findClusters(lows, 'support').sort((a, b) => b.weight - a.weight).slice(0, 3)
    ];

    levels.forEach(l => {
        const line = modal.series.createPriceLine({
            price: l.price,
            color: l.type === 'support' ? '#22c55e' : '#ef4444',
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: l.type === 'support' ? `S×${l.weight}` : `R×${l.weight}`,
        });
        modal.lines.push(line);
    });
}

function closeCoinModal() {
    el('coinModal').classList.add('hidden');
    if (modal.chart) {
        modal.chart.remove();
        modal.chart = null;
        modal.series = null;
        modal.lines = [];
    }
    modal.currentSym = null;
}

// Init modal event listeners (called once in initMiniCharts)
function initModalEvents() {
    // Close button
    el('cmClose').addEventListener('click', closeCoinModal);

    // Overlay click
    document.querySelector('.mc-modal-overlay').addEventListener('click', closeCoinModal);

    // Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.currentSym) closeCoinModal();
    });

    // TF buttons in modal
    el('cmTFButtons').addEventListener('click', (e) => {
        const btn = e.target.closest('.mc-tf-btn');
        if (!btn || !modal.currentSym) return;
        el('cmTFButtons').querySelectorAll('.mc-tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modal.currentTF = btn.dataset.tf;
        loadModalChart(modal.currentSym, modal.currentTF);
    });
}
