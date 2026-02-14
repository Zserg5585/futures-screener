// Utilities and Core Helpers
const el = (id) => document.getElementById(id)
const qs = (selector) => document.querySelector(selector)
const qsa = (selector) => document.querySelectorAll(selector)

// Configuration and State Management
const CONFIG = {
    API_BASE_URL: '/densities/simple',
    DEFAULT_MIN_NOTIONAL: 100000,
    DEFAULT_SYMBOLS: 'BTCUSDT,ETHUSDT',
    REFRESH_INTERVALS: [5000, 10000, 20000],
    DEFAULT_INTERVAL: 10000
}

class DensitiesApp {
    constructor() {
        this.state = {
            minNotional: CONFIG.DEFAULT_MIN_NOTIONAL,
            symbols: CONFIG.DEFAULT_SYMBOLS,
            side: 'all',
            interval: CONFIG.DEFAULT_INTERVAL,
            autoRefresh: false,
            refreshTimer: null,
            cache: {
                data: null,
                timestamp: 0,
                cacheKey: null
            }
        }

        this.initializeUI()
        this.bindEvents()
    }

    getCacheKey() {
        return JSON.stringify({
            minNotional: this.state.minNotional,
            symbols: this.state.symbols,
            side: this.state.side
        })
    }

    isCacheValid() {
        const CACHE_DURATION = 30000 // 30 секунд
        const currentKey = this.getCacheKey()
        return this.state.cache.data && 
               this.state.cache.cacheKey === currentKey && 
               (Date.now() - this.state.cache.timestamp) < CACHE_DURATION
    }

    updateCache(data) {
        this.state.cache = {
            data,
            timestamp: Date.now(),
            cacheKey: this.getCacheKey()
        }
    }

    initializeUI() {
        el('minNotional').value = this.state.minNotional
        el('symbols').value = this.state.symbols
        el('interval').value = this.state.interval
    }

    bindEvents() {
        el('refresh').addEventListener('click', () => this.loadDensities())
        el('minNotional').addEventListener('change', () => this.updateMinNotional())
        el('symbols').addEventListener('change', () => this.updateSymbols())
        el('side').addEventListener('change', () => this.updateSide())
        el('auto').addEventListener('change', () => this.toggleAutoRefresh())
        el('interval').addEventListener('change', () => this.updateInterval())
    }

    buildQueryParams() {
        const params = new URLSearchParams({
            minNotional: this.state.minNotional,
            symbols: this.state.symbols,
            side: this.state.side
        })
        return `${CONFIG.API_BASE_URL}?${params.toString()}`
    }

    async loadDensities(forceRefresh = false) {
        const stateEl = el('state')
        const errorEl = el('error')

        try {
            // Добавляем анимацию загрузки
            stateEl.classList.add('loading')
            stateEl.textContent = 'Loading...'
            errorEl.classList.add('hidden')

            // Проверка кэша
            if (!forceRefresh && this.isCacheValid()) {
                this.renderDensities(this.state.cache.data)
                stateEl.classList.remove('loading')
                stateEl.textContent = `OK (Cached: ${this.state.cache.data?.length || 0} symbols)`
                return
            }

            const response = await fetch(this.buildQueryParams())
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`)
            }

            const result = await response.json()
            const data = result.data || []

            // Обновляем кэш
            this.updateCache(data)
            this.renderDensities(data)

            // Убираем анимацию
            stateEl.classList.remove('loading')
            stateEl.textContent = `OK (${data.length} symbols)`
            el('updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`
        } catch (error) {
            console.error('Densities load error:', error)
            errorEl.textContent = error.message
            errorEl.classList.remove('hidden')
            
            // Убираем анимацию при ошибке
            stateEl.classList.remove('loading')
            stateEl.textContent = 'Error'
        }
    }

    renderDensities(entries) {
        const tbodyEl = el('tbody')
        const groupedEntries = this.groupEntriesBySymbol(entries)
        
        const rowsHtml = groupedEntries.map(entry => `
            <tr>
                <td>${entry.symbol}</td>
                ${this.renderSideData(entry.bid, 'bid')}
                ${this.renderSideData(entry.ask, 'ask')}
            </tr>
        `).join('')

        tbodyEl.innerHTML = rowsHtml || 
            `<tr><td colspan="7" class="muted">No data available</td></tr>`
    }

    groupEntriesBySymbol(entries) {
        const symbolMap = new Map()

        entries.forEach(entry => {
            if (!symbolMap.has(entry.symbol)) {
                symbolMap.set(entry.symbol, { symbol: entry.symbol, bid: null, ask: null })
            }
            const symbolEntry = symbolMap.get(entry.symbol)
            entry.side === 'bid' ? symbolEntry.bid = entry : symbolEntry.ask = entry
        })

        return Array.from(symbolMap.values())
    }

    renderSideData(sideData, side) {
        if (!sideData) return `
            <td class="muted">—</td>
            <td class="muted">—</td>
            <td class="muted">—</td>
        `

        return `
            <td>${this.formatPrice(sideData.levelPrice)}</td>
            <td>${this.formatPercent(sideData.distancePct)}</td>
            <td>${this.formatNotional(sideData.notional)}</td>
        `
    }

    formatPrice(value) {
        return value ? value.toFixed(8) : '—'
    }

    formatPercent(value) {
        return value ? value.toFixed(2) + '%' : '—'
    }

    formatNotional(value) {
        return value ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'
    }

    updateMinNotional() {
        this.state.minNotional = Number(el('minNotional').value)
        this.loadDensities()
    }

    updateSymbols() {
        this.state.symbols = el('symbols').value
        this.loadDensities()
    }

    updateSide() {
        this.state.side = el('side').value
        this.loadDensities()
    }

    toggleAutoRefresh() {
        this.state.autoRefresh = el('auto').checked
        if (this.state.autoRefresh) {
            this.startAutoRefresh()
        } else {
            this.stopAutoRefresh()
        }
    }

    startAutoRefresh() {
        this.stopAutoRefresh()
        this.state.refreshTimer = setInterval(() => this.loadDensities(), this.state.interval)
    }

    stopAutoRefresh() {
        if (this.state.refreshTimer) {
            clearInterval(this.state.refreshTimer)
            this.state.refreshTimer = null
        }
    }

    updateInterval() {
        this.state.interval = Number(el('interval').value)
        if (this.state.autoRefresh) {
            this.startAutoRefresh()
        }
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.densitiesApp = new DensitiesApp()
    window.densitiesApp.loadDensities()
})