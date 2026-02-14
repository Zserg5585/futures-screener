// Utilities and Core Helpers
const el = (id) => document.getElementById(id)
const qs = (selector) => document.querySelector(selector)
const qsa = (selector) => document.querySelectorAll(selector)

// App State Management
const AppState = {
    currentTab: 'densities',
    isMobile: window.innerWidth <= 768,
    filters: {
        densities: {
            minNotional: 100000,
            symbols: '',
            side: 'all',
            interval: 10000,
            autoRefresh: false
        }
    },
    
    // Tab Management
    switchTab(tabName) {
        this.currentTab = tabName
        
        // Hide all tabs
        qsa('.tab-content').forEach(tab => {
            tab.classList.remove('active')
        })
        qsa('.tab').forEach(tab => {
            tab.classList.remove('active')
        })
        
        // Show selected tab
        el(`tab-${tabName}`).classList.add('active')
        qs(`[data-tab="${tabName}"]`).classList.add('active')
        
        // Tab-specific initialization
        if (tabName === 'densities') {
            this.initDensitiesTab()
        }
    },
    
    initDensitiesTab() {
        const state = this.filters.densities
        el('minNotional').value = state.minNotional
        el('symbols').value = state.symbols
        el('side').value = state.side
        el('interval').value = state.interval
        el('auto').checked = state.autoRefresh
    }
}

// Formatting Utilities
const Formatter = {
    number(x, decimals = 0) {
        if (x == null || isNaN(x)) return '—'
        return new Intl.NumberFormat('en-US', { 
            maximumFractionDigits: decimals 
        }).format(x)
    },
    price(x) { return this.number(x, 8) },
    percent(x) { return this.number(x, 3) }
}

// Error and State Management
const UIManager = {
    setState(s) { 
        el('state').textContent = s 
    },
    
    showError(msg) {
        const errorEl = el('error')
        errorEl.textContent = msg
        errorEl.classList.remove('hidden')
    },
    
    clearError() {
        const errorEl = el('error')
        errorEl.textContent = ''
        errorEl.classList.add('hidden')
    }
}

// API Interaction
class DensitiesAPI {
    static buildUrl(filters) {
        const qs = new URLSearchParams()
        qs.set('minNotional', String(filters.minNotional))
        qs.set('depthLimit', '100')
        
        if (filters.symbols.trim()) {
            qs.set('symbols', filters.symbols.trim())
        }
        
        return `/densities/simple?${qs.toString()}`
    }
    
    static async fetchData(filters) {
        try {
            const url = this.buildUrl(filters)
            const response = await fetch(url)
            
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`)
            }
            
            return await response.json()
        } catch (error) {
            UIManager.showError(error.message)
            throw error
        }
    }
}

// Rendering Logic
class DensitiesRenderer {
    static groupBySymbol(rows) {
        const map = new Map()
        
        for (const r of rows) {
            if (!map.has(r.symbol)) {
                map.set(r.symbol, { 
                    symbol: r.symbol, 
                    bid: null, 
                    ask: null 
                })
            }
            
            const entry = map.get(r.symbol)
            r.side === 'bid' ? entry.bid = r : entry.ask = r
        }
        
        return Array.from(map.values())
    }
    
    static sortEntries(entries) {
        return entries.sort((a, b) => {
            const distA = Math.min(
                a.bid?.distancePct ?? Infinity, 
                a.ask?.distancePct ?? Infinity
            )
            const distB = Math.min(
                b.bid?.distancePct ?? Infinity, 
                b.ask?.distancePct ?? Infinity
            )
            return distA - distB
        })
    }
    
    static renderTable(entries, sideFilter) {
        const tbody = el('tbody')
        
        const rowsHtml = entries.map(entry => {
            const { symbol, bid, ask } = entry
            
            const renderSide = (side, sideData) => 
                sideFilter === (side === 'bid' ? 'ask' : 'bid')
                    ? `<td class="muted">—</td><td class="muted">—</td><td class="muted">—</td>`
                    : `
                        <td>${Formatter.price(sideData?.levelPrice)}</td>
                        <td>${Formatter.percent(sideData?.distancePct)}</td>
                        <td>${Formatter.number(sideData?.notional)}</td>
                    `
            
            return `
                <tr>
                    <td class="sym">${symbol}</td>
                    ${renderSide('bid', bid)}
                    ${renderSide('ask', ask)}
                </tr>
            `
        }).join('')
        
        tbody.innerHTML = rowsHtml || 
            `<tr><td colspan="7" class="muted">No data</td></tr>`
    }
}

// Main Load and Refresh Logic
class DensitiesLoader {
    static async load() {
        UIManager.clearError()
        UIManager.setState('Loading...')
        
        const filters = AppState.filters.densities
        
        try {
            const result = await DensitiesAPI.fetchData(filters)
            const entries = DensitiesRenderer.groupBySymbol(result.data || [])
            const sortedEntries = DensitiesRenderer.sortEntries(entries)
            
            DensitiesRenderer.renderTable(sortedEntries, filters.side)
            
            el('updated').textContent = `Last updated: ${new Date().toLocaleTimeString()}`
            UIManager.setState(`OK (${entries.length} symbols)`)
        } catch (error) {
            UIManager.setState('Error')
        }
    }
    
    static setupAutoRefresh() {
        const filters = AppState.filters.densities
        const intervalMs = filters.interval
        
        // Clear any existing timer
        if (window.refreshTimer) {
            clearInterval(window.refreshTimer)
        }
        
        if (filters.autoRefresh) {
            window.refreshTimer = setInterval(
                this.load.bind(this), 
                intervalMs
            )
        }
    }
}

// Event Listeners
function initEventListeners() {
    // Tab switching
    qsa('.tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab
            AppState.switchTab(tabName)
        })
    })
    
    // Densities Tab Specific
    el('refresh').addEventListener('click', DensitiesLoader.load.bind(DensitiesLoader))
    
    el('auto').addEventListener('change', (e) => {
        AppState.filters.densities.autoRefresh = e.target.checked
        DensitiesLoader.setupAutoRefresh()
    })
    
    el('interval').addEventListener('change', (e) => {
        AppState.filters.densities.interval = Number(e.target.value)
        if (AppState.filters.densities.autoRefresh) {
            DensitiesLoader.setupAutoRefresh()
        }
    })
    
    el('side').addEventListener('change', (e) => {
        AppState.filters.densities.side = e.target.value
        DensitiesLoader.load()
    })
    
    el('minNotional').addEventListener('change', (e) => {
        AppState.filters.densities.minNotional = Number(e.target.value)
        DensitiesLoader.load()
    })
    
    el('symbols').addEventListener('change', (e) => {
        AppState.filters.densities.symbols = e.target.value
        DensitiesLoader.load()
    })
    
    // Responsive Design
    window.addEventListener('resize', () => {
        AppState.isMobile = window.innerWidth <= 768
        // TODO: Add mobile-specific layout adjustments
    })
}

// Initialization
function init() {
    // First load of densities tab
    AppState.switchTab('densities')
    DensitiesLoader.load()
    initEventListeners()
}

// Start the application
window.addEventListener('load', init)