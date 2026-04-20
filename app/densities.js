// Futures Screener - Densities V2 UI
// Statistical Walls + Bid/Ask Imbalance + Persistence

const el = (id) => document.getElementById(id)

// State
const dv2 = {
    data: null,
    cache: { data: null, ts: 0 },
    sortField: 'supportScore',
    sortAsc: false,
    autoTimer: null,
    loading: false,
    blacklist: [] // ['GRIFFAIN', 'NEIRO', ...]
}

// ---- Blacklist persistence ----
function loadBlacklist() {
    try {
        const saved = localStorage.getItem('dv2-blacklist')
        if (saved) {
            const parsed = JSON.parse(saved)
            if (Array.isArray(parsed)) {
                dv2.blacklist = parsed.filter(s => typeof s === 'string' && s.trim().length >= 2)
            }
        }
    } catch (_) {
        localStorage.removeItem('dv2-blacklist')
        dv2.blacklist = []
    }
}
function saveBlacklist() {
    localStorage.setItem('dv2-blacklist', JSON.stringify(dv2.blacklist))
}
function isBlacklisted(symbol) {
    const coin = symbol.replace('USDT', '').toUpperCase()
    return dv2.blacklist.some(b => coin === b.toUpperCase())
}

// ---- Init ----
function init() {
    console.log('[DensityV2] init')
    loadBlacklist()
    setupDv2Events()
    // Check which tab is active and init accordingly
    const activeTab = document.querySelector('.tab.active')
    const tabName = activeTab ? activeTab.dataset.tab : 'mini-charts'
    if (tabName === 'mini-charts') {
        if (typeof initMiniCharts === 'function') initMiniCharts()
    } else if (tabName === 'densities') {
        loadDensitiesV2(true)
    } else if (tabName === 'signals') {
        if (typeof initSignals === 'function') initSignals()
    }
}

function setupDv2Events() {
    // Refresh button
    const refreshBtn = el('dv2Refresh')
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadDensitiesV2(true))

    // Auto-refresh toggle
    const autoCheck = el('dv2Auto')
    if (autoCheck) autoCheck.addEventListener('change', () => {
        if (autoCheck.checked) {
            dv2.autoTimer = setInterval(() => loadDensitiesV2(), 15000)
        } else {
            clearInterval(dv2.autoTimer)
            dv2.autoTimer = null
        }
    })

    // Filter changes → reload
    ;['dv2Window', 'dv2MinVol', 'dv2Sigma'].forEach(id => {
        const sel = el(id)
        if (sel) sel.addEventListener('change', () => loadDensitiesV2(true))
    })

    // Blacklist button
    const blBtn = el('dv2BlacklistBtn')
    if (blBtn) blBtn.addEventListener('click', openBlacklistModal)

    // Sort headers
    document.querySelectorAll('.dv2-table th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort
            if (dv2.sortField === field) {
                dv2.sortAsc = !dv2.sortAsc
            } else {
                dv2.sortField = field
                dv2.sortAsc = false
            }
            document.querySelectorAll('.dv2-table th.sortable').forEach(h => {
                h.classList.remove('sort-asc', 'sort-desc')
            })
            th.classList.add(dv2.sortAsc ? 'sort-asc' : 'sort-desc')
            if (dv2.data) renderDv2Table(dv2.data)
        })
    })

    // Tab click → load
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab
            document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none')
            const target = document.getElementById(`tab-${tabName}`)
            if (target) target.style.display = 'block'
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
            tab.classList.add('active')

            if (tabName === 'densities') {
                if (typeof stopSignals === 'function') stopSignals()
                if (!dv2.data) loadDensitiesV2(true)
                else renderDv2Table(dv2.data)
            } else if (tabName === 'mini-charts') {
                if (typeof stopSignals === 'function') stopSignals()
                if (typeof initMiniCharts === 'function') initMiniCharts()
            } else if (tabName === 'signals') {
                if (typeof initSignals === 'function') initSignals()
            }
        })
    })
}

// ---- Blacklist Modal ----
function openBlacklistModal() {
    // Remove existing modal if any
    const old = document.getElementById('dv2BlModal')
    if (old) old.remove()

    const modal = document.createElement('div')
    modal.id = 'dv2BlModal'
    modal.className = 'dv2-bl-overlay'
    modal.innerHTML = `
        <div class="dv2-bl-modal">
            <div class="dv2-bl-header">
                <span>Blacklist</span>
                <button class="dv2-bl-close" id="dv2BlClose">✕</button>
            </div>
            <div class="dv2-bl-add">
                <input type="text" id="dv2BlInput" class="dv2-bl-input" placeholder="COIN (e.g. GRIFFAIN)" autocomplete="off" />
                <button class="dv2-bl-add-btn" id="dv2BlAddBtn">Add</button>
            </div>
            <div class="dv2-bl-list" id="dv2BlList"></div>
            <div class="dv2-bl-footer">
                <span class="dv2-bl-count">${dv2.blacklist.length} blocked</span>
            </div>
        </div>
    `
    document.body.appendChild(modal)

    renderBlacklistItems()

    // Events
    document.getElementById('dv2BlClose').addEventListener('click', closeBlacklistModal)
    modal.addEventListener('click', (e) => { if (e.target === modal) closeBlacklistModal() })

    const input = document.getElementById('dv2BlInput')
    const addBtn = document.getElementById('dv2BlAddBtn')

    const doAdd = () => {
        const raw = input.value.trim().toUpperCase().replace(/USDT$/i, '')
        if (!raw || raw.length < 2) { input.value = ''; return }
        if (!dv2.blacklist.includes(raw)) {
            dv2.blacklist.push(raw)
            saveBlacklist()
            renderBlacklistItems()
            updateBlBadge()
            if (dv2.data) renderDv2Table(dv2.data)
        }
        input.value = ''
        input.focus()
    }

    addBtn.addEventListener('click', doAdd)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd() })
    input.focus()
}

function closeBlacklistModal() {
    const modal = document.getElementById('dv2BlModal')
    if (modal) modal.remove()
}

function renderBlacklistItems() {
    const listEl = document.getElementById('dv2BlList')
    const countEl = document.querySelector('.dv2-bl-count')
    if (!listEl) return

    if (dv2.blacklist.length === 0) {
        listEl.innerHTML = '<div class="dv2-bl-empty">No coins blocked</div>'
    } else {
        listEl.innerHTML = dv2.blacklist.map(coin => `
            <div class="dv2-bl-item">
                <span class="dv2-bl-coin">${coin}</span>
                <button class="dv2-bl-rm" onclick="removeBl('${coin}')">✕</button>
            </div>
        `).join('')
    }
    if (countEl) countEl.textContent = `${dv2.blacklist.length} blocked`
}

// Global for onclick
window.removeBl = function(coin) {
    dv2.blacklist = dv2.blacklist.filter(c => c !== coin)
    saveBlacklist()
    renderBlacklistItems()
    updateBlBadge()
    if (dv2.data) renderDv2Table(dv2.data)
}

function updateBlBadge() {
    const badge = el('dv2BlBadge')
    if (badge) {
        badge.textContent = dv2.blacklist.length
        badge.style.display = dv2.blacklist.length > 0 ? 'inline-flex' : 'none'
    }
}

// ---- Load Data ----
async function loadDensitiesV2(force = false) {
    if (dv2.loading) return
    const statusEl = el('dv2Status')
    const errorEl = el('error')

    if (!force && dv2.cache.data && (Date.now() - dv2.cache.ts) < 10000) {
        renderDv2Table(dv2.cache.data)
        return
    }

    dv2.loading = true
    if (statusEl) statusEl.textContent = 'Loading...'
    if (errorEl) errorEl.classList.add('hidden')

    try {
        const windowPct = el('dv2Window')?.value || 2
        const minVol = el('dv2MinVol')?.value || 50000000
        const nSigma = el('dv2Sigma')?.value || 2

        const params = new URLSearchParams({
            windowPct,
            minVolume24h: minVol,
            nSigma,
            force: force ? 'true' : 'false'
        })

        const resp = await fetch(`/densities/v2?${params}&_t=${Date.now()}`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

        const result = await resp.json()
        const data = result.data || []

        dv2.data = data
        dv2.cache = { data, ts: Date.now() }

        const tabContent = el('tab-densities')
        if (tabContent && tabContent.style.display !== 'none') {
            renderDv2Table(data)
        }

        if (statusEl) {
            statusEl.textContent = `Walls: ${data.length} · ${new Date().toLocaleTimeString()}`
        }
    } catch (err) {
        console.error('[DensityV2] Load error:', err)
        if (statusEl) statusEl.textContent = `Error: ${err.message}`
        if (errorEl) {
            errorEl.textContent = err.message
            errorEl.classList.remove('hidden')
        }
    } finally {
        dv2.loading = false
    }
}

// ---- Render Table ----
function renderDv2Table(entries) {
    const tbody = el('tbody')
    const cardsEl = el('cardsContent')
    const tableEl = el('table-container')
    const isMobile = window.innerWidth <= 768

    if (isMobile) {
        if (cardsEl) { cardsEl.style.display = 'flex'; renderDv2Cards(entries) }
        if (tableEl) tableEl.style.display = 'none'
        return
    }
    if (cardsEl) cardsEl.style.display = 'none'
    if (tableEl) tableEl.style.display = 'block'

    // Apply blacklist filter
    let filtered = entries || []
    if (dv2.blacklist.length > 0) {
        filtered = filtered.filter(e => !isBlacklisted(e.symbol))
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted);">No walls found. Warmup in progress — try again in 30s</td></tr>'
        return
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
        let va, vb
        switch (dv2.sortField) {
            case 'symbol':
                return dv2.sortAsc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol)
            case 'imbalance':
                va = a.imbalance; vb = b.imbalance; break
            case 'supportScore':
                va = a.support?.score || 0; vb = b.support?.score || 0; break
            case 'resistScore':
                va = a.resistance?.score || 0; vb = b.resistance?.score || 0; break
            case 'volume24h':
                va = a.volume24h || 0; vb = b.volume24h || 0; break
            default:
                va = a.support?.score || 0; vb = b.support?.score || 0
        }
        return dv2.sortAsc ? va - vb : vb - va
    })

    tbody.innerHTML = sorted.map(entry => {
        const sym = entry.symbol.replace('USDT', '')
        const s = entry.support
        const r = entry.resistance

        return `<tr class="dv2-row" data-symbol="${entry.symbol}">
            <td class="dv2-coin">
                <a href="#" onclick="event.preventDefault(); if(typeof openCoinModal==='function') openCoinModal('${entry.symbol}');">${sym}</a>
            </td>
            ${renderImbalance(entry.imbalance, entry.imbalanceLabel)}
            ${renderWallCells(s, 'bid')}
            ${renderWallCells(r, 'ask')}
            <td class="dv2-vol">${fmtCompact(entry.volume24h)}</td>
        </tr>`
    }).join('')
}

// ---- Render helpers ----
function renderImbalance(value, label) {
    const pct = Math.round(value * 100)
    const abs = Math.abs(pct)

    let color = 'var(--text-muted)'
    let barColor = 'rgba(255,255,255,0.08)'
    if (label === 'BULLISH') { color = '#22c55e'; barColor = 'rgba(34,197,94,0.2)' }
    else if (label === 'BEARISH') { color = '#ef4444'; barColor = 'rgba(239,68,68,0.2)' }

    const barWidth = Math.min(abs, 50) * 2

    return `<td class="dv2-imbalance">
        <div class="dv2-imb-wrap">
            <div class="dv2-imb-bar" style="width:${barWidth}%;background:${barColor}"></div>
            <span class="dv2-imb-text" style="color:${color}">${pct > 0 ? '+' : ''}${pct}%</span>
        </div>
    </td>`
}

function renderWallCells(wall, side) {
    if (!wall) {
        return `<td class="dv2-wall-empty"><span style="color:var(--text-muted)">—</span></td>
                <td class="dv2-wall-empty"><span style="color:var(--text-muted)">—</span></td>
                <td class="dv2-wall-empty"><span style="color:var(--text-muted)">—</span></td>
                <td class="dv2-wall-empty"><span style="color:var(--text-muted)">—</span></td>`
    }

    const color = side === 'bid' ? '#22c55e' : '#ef4444'
    const statusIcon = wall.status === 'strong' ? '🧱' : wall.status === 'confirmed' ? '✓' : ''
    const statusColor = wall.status === 'strong' ? '#22c55e' : wall.status === 'confirmed' ? '#60a5fa' : 'var(--text-muted)'

    const sizeBarWidth = Math.min((wall.sizeVsMedian || 0) / 30 * 100, 100)
    const sizeBarColor = side === 'bid' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'

    return `<td class="dv2-wall-price">
                <span style="color:${color};font-weight:600">${fmtPrice(wall.price)}</span>
            </td>
            <td class="dv2-wall-dist">
                <span style="color:var(--text-secondary)">${wall.distancePct.toFixed(2)}%</span>
            </td>
            <td class="dv2-wall-size">
                <div class="dv2-size-wrap">
                    <div class="dv2-size-bar" style="width:${sizeBarWidth}%;background:${sizeBarColor}"></div>
                    <span class="dv2-size-text">${fmtCompact(wall.notional)}</span>
                    <span class="dv2-size-mult" style="color:${color}">${wall.sizeVsMedian}x</span>
                </div>
            </td>
            <td class="dv2-wall-age">
                <span style="color:${statusColor}" title="${wall.status}">${statusIcon}</span>
                <span class="dv2-age-text">${fmtAge(wall.ageMins)}</span>
            </td>`
}

function renderDv2Cards(entries) {
    const container = el('cardsContent')

    let filtered = entries || []
    if (dv2.blacklist.length > 0) {
        filtered = filtered.filter(e => !isBlacklisted(e.symbol))
    }

    if (filtered.length === 0) {
        container.innerHTML = '<p style="padding:40px 20px;text-align:center;color:var(--text-muted);">No walls found</p>'
        return
    }

    const sorted = [...filtered].sort((a, b) => {
        const va = Math.max(a.support?.score || 0, a.resistance?.score || 0)
        const vb = Math.max(b.support?.score || 0, b.resistance?.score || 0)
        return vb - va
    })

    container.innerHTML = sorted.map(entry => {
        const sym = entry.symbol.replace('USDT', '')
        const s = entry.support
        const r = entry.resistance
        const pct = Math.round(entry.imbalance * 100)
        const imbColor = entry.imbalanceLabel === 'BULLISH' ? '#22c55e' : entry.imbalanceLabel === 'BEARISH' ? '#ef4444' : 'var(--text-muted)'

        return `<div class="card dv2-card" onclick="if(typeof openCoinModal==='function') openCoinModal('${entry.symbol}')">
            <div class="card-header">
                <span class="dv2-card-sym">${sym}</span>
                <span class="dv2-card-imb" style="color:${imbColor}">${pct > 0 ? '+' : ''}${pct}%</span>
            </div>
            <div class="card-body">
                ${s ? `<div class="dv2-card-wall dv2-card-bid">
                    <span class="dv2-card-side">SUP</span>
                    <span class="dv2-card-price" style="color:#22c55e">${fmtPrice(s.price)}</span>
                    <span class="dv2-card-dist">${s.distancePct.toFixed(2)}%</span>
                    <span class="dv2-card-notional">${fmtCompact(s.notional)}</span>
                    <span class="dv2-card-mult" style="color:#22c55e">${s.sizeVsMedian}x</span>
                </div>` : '<div class="dv2-card-wall"><span style="color:var(--text-muted)">No support</span></div>'}
                ${r ? `<div class="dv2-card-wall dv2-card-ask">
                    <span class="dv2-card-side">RES</span>
                    <span class="dv2-card-price" style="color:#ef4444">${fmtPrice(r.price)}</span>
                    <span class="dv2-card-dist">${r.distancePct.toFixed(2)}%</span>
                    <span class="dv2-card-notional">${fmtCompact(r.notional)}</span>
                    <span class="dv2-card-mult" style="color:#ef4444">${r.sizeVsMedian}x</span>
                </div>` : '<div class="dv2-card-wall"><span style="color:var(--text-muted)">No resistance</span></div>'}
            </div>
        </div>`
    }).join('')
}

// ---- Format helpers ----
function fmtPrice(price) {
    if (!price) return '—'
    if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 1 })
    if (price >= 1) return price.toFixed(3)
    return price.toPrecision(4)
}

function fmtCompact(value) {
    if (!value) return '—'
    if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
    if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
    if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`
    return `$${Math.round(value)}`
}

function fmtAge(mins) {
    if (mins === null || mins === undefined) return '0m'
    if (mins < 1) return '<1m'
    if (mins < 60) return `${Math.round(mins)}m`
    return `${Math.floor(mins / 60)}h${Math.round(mins % 60)}m`
}

// Auto-init
document.addEventListener('DOMContentLoaded', () => {
    init()
    updateBlBadge()
})
