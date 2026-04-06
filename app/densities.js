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
