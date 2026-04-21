// ==========================================
// Mini-Charts v3 — Full Market Screener
// Uses IntersectionObserver to only render visible charts
// ==========================================
const FLAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
const mc = {
    sortBy: 'change',
    sortDir: 'asc',
    globalTF: '5m',
    loaded: false,
    allPairs: [],        // all fetched pairs (unfiltered)
    filteredPairs: [],   // after filters applied
    charts: {},          // { sym: { chart, series, lines[] } } — only visible ones
    loadedData: {},      // { sym: true } — tracks which symbols have been loaded
    observer: null,      // IntersectionObserver
    loadQueue: [],       // queue for staggered loading
    loadingActive: false,
    filters: { minVol: 50, minNatr: 0, minTrades: 0 },
    searchQuery: '',     // coin search filter
    flags: {},           // { sym: '#color' } — color flags, persisted in localStorage
    ws: null,            // Binance kline WebSocket
    wsStreams: new Set(), // currently subscribed streams
    wsPending: new Set() // streams waiting to subscribe
};

// Load flags from localStorage
try { mc.flags = JSON.parse(localStorage.getItem('mc_flags') || '{}'); } catch(e) { mc.flags = {}; }

// --- Settings helpers ---
const _sp = () => typeof settingsPanel !== 'undefined' ? settingsPanel : null
function spGet(key, fallback) { const sp = _sp(); return sp ? sp.get(key) : fallback }
function getGridOpts() {
  const show = spGet('showGrid', true)
  const c = show ? 'rgba(255,255,255,0.03)' : 'transparent'
  return { vertLines: { color: c }, horzLines: { color: c } }
}
function getVolScaleTop() { return 1 - (spGet('volumeHeight', 15) / 100) }
function getPriceScaleMode() { return spGet('logScale', false) ? 1 : 0 }
function addMainSeries(chart, prec, minMove) {
  const type = spGet('candleType', 'Candlestick')
  const up = spGet('candleUp', '#22c55e')
  const down = spGet('candleDown', '#ef4444')
  const pf = { type: 'price', precision: prec, minMove }
  if (type === 'Line') return chart.addSeries(LightweightCharts.LineSeries, { color: up, lineWidth: 2, priceFormat: pf })
  if (type === 'Area') return chart.addSeries(LightweightCharts.AreaSeries, { topColor: up + '66', bottomColor: up + '0d', lineColor: up, lineWidth: 2, priceFormat: pf })
  if (type === 'Bar') return chart.addSeries(LightweightCharts.BarSeries, { upColor: up, downColor: down, priceFormat: pf })
  return chart.addSeries(LightweightCharts.CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceFormat: pf })
}

function saveFlags() {
    localStorage.setItem('mc_flags', JSON.stringify(mc.flags));
}

// --- Sidebar & Grid settings ---
const CARD_HEIGHTS = { compact: 200, normal: 270, large: 360 }

function applyGridColumns(n) {
    const grid = document.querySelector('.mc-grid')
    if (grid) grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`
}

function applyCardSize(size) {
    const grid = document.querySelector('.mc-grid')
    if (grid) grid.style.gridAutoRows = (CARD_HEIGHTS[size] || 270) + 'px'
    // Resize existing charts
    Object.values(mc.charts).forEach(c => { try { c.chart.resize() } catch(e) {} })
    setTimeout(() => Object.values(mc.charts).forEach(c => { try { c.chart.applyOptions({ autoSize: true }) } catch(e) {} }), 100)
}

function applySidebarColumns() {
    const showChg = spGet('colChg', true)
    const showNatr = spGet('colNatr', true)
    const showVol = spGet('colVol', true)

    // Build grid-template-columns: flag(20px) name(1fr) ★(18px) copy(16px) [chg 50px] [natr 34px] [vol 40px]
    let cols = '20px 1fr 18px 16px'
    if (showChg) cols += ' 50px'
    if (showNatr) cols += ' 34px'
    if (showVol) cols += ' 40px'

    // Apply to header
    const hdr = document.getElementById('mcColHeaders')
    if (hdr) {
        hdr.style.gridTemplateColumns = cols
        // Show/hide header spans
        const spans = hdr.querySelectorAll('.mc-col-hdr')
        spans.forEach(s => {
            if (s.dataset.sort === 'change') s.style.display = showChg ? '' : 'none'
            if (s.dataset.sort === 'natr') s.style.display = showNatr ? '' : 'none'
            if (s.dataset.sort === 'volume') s.style.display = showVol ? '' : 'none'
        })
    }

    // Apply to all coin items
    document.querySelectorAll('.mc-coin-item').forEach(item => {
        item.style.gridTemplateColumns = cols
        const chgEl = item.querySelector('.mc-coin-change')
        const natrEl = item.querySelector('.mc-coin-natr')
        const volEl = item.querySelector('.mc-coin-vol')
        if (chgEl) chgEl.style.display = showChg ? '' : 'none'
        if (natrEl) natrEl.style.display = showNatr ? '' : 'none'
        if (volEl) volEl.style.display = showVol ? '' : 'none'
    })
}

function applyAllLayoutSettings() {
    applyGridColumns(spGet('cardsPerRow', 4))
    applyCardSize(spGet('cardSize', 'normal'))
    applySidebarColumns()
}

// Rebuild all visible charts (called when chart settings change)
function rebuildAllCharts() {
    // Destroy all mini-chart instances, remember which were loaded
    const syms = Object.keys(mc.charts)
    syms.forEach(sym => {
        try { mc.charts[sym].chart.remove() } catch(e) {}
    })
    mc.charts = {}
    mc.loadedData = {}

    // Re-create them
    syms.forEach(sym => {
        createChartInstance(sym)
        mc.loadQueue.push(sym)
    })
    processLoadQueue()

    // Rebuild modal if open
    if (modal.chart && modal.currentSym) {
        loadModalChart(modal.currentSym, modal.currentTF)
    }

    // Rebuild multi-chart slots
    if (typeof mch !== 'undefined' && mch.slots) {
        mch.slots.forEach((slot, i) => {
            if (slot.chart && slot.sym) {
                try { slot.chart.remove() } catch(e) {}
                slot.chart = null
                slot.series = null
                slot.volSeries = null
                createSlotChart(i)
                loadSlotChart(i)
            }
        })
    }

    showSettingsToast('Settings applied ✓')
}

function showSettingsToast(msg) {
    const sp = _sp()
    if (sp) sp.showToast(msg)
}

async function initMiniCharts() {
    if (!mc.loaded) {
        mc.loaded = true;

        // Apply saved theme
        const savedTheme = spGet('theme', 'dark')
        if (savedTheme !== 'dark') document.body.classList.add('theme-' + savedTheme)

        // Apply saved data settings
        mc.sortBy = spGet('defaultSort', 'change')
        mc.sortDir = spGet('defaultSortDir', 'asc')
        mc.filters.minVol = spGet('minVolume', 50)

        // Sync sort headers with settings
        const colHeaders = document.getElementById('mcColHeaders')
        if (colHeaders) {
            colHeaders.querySelectorAll('.mc-col-hdr').forEach(h => {
                h.classList.remove('active', 'asc', 'desc')
                if (h.dataset.sort === mc.sortBy) h.classList.add('active', mc.sortDir)
            })
        }
        // Sync volume dropdown
        const volSel = el('mcFilterVol')
        if (volSel) volSel.value = mc.filters.minVol

        // Apply saved layout settings
        applyAllLayoutSettings()

        // Apply default TF from settings
        const savedTF = spGet('defaultTF', '5m')
        if (savedTF) mc.globalTF = savedTF

        // Listen for settings changes
        const sp = _sp()
        if (sp) {
            sp.onChange((key, val) => {
                const chartKeys = ['candleType', 'logScale', 'volumeHeight', 'showGrid', 'showWatermark', 'candleUp', 'candleDown']
                if (chartKeys.includes(key)) {
                    rebuildAllCharts()
                } else if (key === 'defaultTF') {
                    mc.globalTF = val
                    // Update active TF button
                    const tfGroup = el('mcGlobalTF')
                    if (tfGroup) {
                        tfGroup.querySelectorAll('.mc-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === val))
                    }
                    mc.loadedData = {}
                    Object.keys(mc.charts).forEach(sym => mc.loadQueue.push(sym))
                    processLoadQueue()
                    showSettingsToast('Timeframe → ' + val)
                } else if (key === 'densityEnabled') {
                    if (!val) {
                        // Remove density lines from all charts
                        Object.values(mc.charts).forEach(c => {
                            if (c.densityLines) { c.densityLines.forEach(pl => { try { c.series.removePriceLine(pl) } catch(e){} }); c.densityLines = [] }
                        })
                        if (modal.chart && modal.densityLines) { modal.densityLines.forEach(pl => { try { modal.series.removePriceLine(pl) } catch(e){} }); modal.densityLines = [] }
                    } else {
                        // Re-apply densities to all visible charts
                        const visibleSyms = Object.keys(mc.charts).filter(s => mc.charts[s] && mc.charts[s].series)
                        if (visibleSyms.length > 0) applyDensityToBatch(visibleSyms)
                        if (modal.chart && modal.currentSym) applyDensityToModal()
                    }
                    showSettingsToast(val ? 'Densities enabled' : 'Densities disabled')
                } else if (['densityDepthPct', 'densityTTLMin', 'densitySeveritySmall', 'densitySeverityMedium', 'densitySeverityLarge', 'densityBlacklist'].includes(key)) {
                    // Re-apply densities with new filters
                    if (spGet('densityEnabled', true)) {
                        const visibleSyms = Object.keys(mc.charts).filter(s => mc.charts[s] && mc.charts[s].series)
                        if (visibleSyms.length > 0) applyDensityToBatch(visibleSyms)
                        if (modal.chart && modal.currentSym) applyDensityToModal()
                    }
                    showSettingsToast('Density filter updated')
                } else if (key === 'signalMinRatio') {
                    showSettingsToast('Signal ratio → ' + val + 'x')
                } else if (key === 'cardsPerRow') {
                    applyGridColumns(val)
                    showSettingsToast('Cards per row → ' + val)
                } else if (key === 'cardSize') {
                    applyCardSize(val)
                    showSettingsToast('Card size → ' + val)
                } else if (key === 'colChg' || key === 'colNatr' || key === 'colVol') {
                    applySidebarColumns()
                    renderSidebar()
                    showSettingsToast('Sidebar updated')
                } else if (key === 'defaultSort') {
                    mc.sortBy = val
                    renderSidebar()
                    showSettingsToast('Sort → ' + val)
                } else if (key === 'defaultSortDir') {
                    mc.sortDir = val
                    renderSidebar()
                    showSettingsToast('Sort direction → ' + val)
                } else if (key === 'minVolume') {
                    mc.filters.minVol = val
                    // Sync the toolbar dropdown if exists
                    const volSel = el('mcFilterVol')
                    if (volSel) volSel.value = val
                    applyFiltersAndRebuild()
                    showSettingsToast(val > 0 ? 'Min volume → $' + val + 'M' : 'Volume filter OFF')
                } else if (key === 'layout') {
                    // Map settings layout to multi-chart layout
                    if (val === '1') {
                        switchLayout('grid')
                    } else {
                        switchLayout(val)
                    }
                    showSettingsToast('Layout → ' + val)
                } else if (key === 'theme') {
                    document.body.className = document.body.className.replace(/theme-\w+/g, '')
                    if (val !== 'dark') document.body.classList.add('theme-' + val)
                    showSettingsToast('Theme → ' + val)
                } else if (key === 'indicatorOI' || key === 'indicatorOIColor') {
                    // Modal
                    if (modal.chart && modal.currentSym) applyOIOverlay(modal.chart, modal.currentSym)
                    // Mini-charts
                    const visSyms = Object.keys(mc.charts).filter(s => mc.charts[s] && mc.charts[s].chart)
                    if (visSyms.length > 0) applyOIToBatch(visSyms)
                    // Multi-chart slots
                    if (typeof mch !== 'undefined') mch.slots.forEach((slot, i) => { if (slot.chart && slot.sym) applyOI(slot, slot.sym, slot.tf) })
                    showSettingsToast(key === 'indicatorOI' ? (val ? 'OI indicator ON' : 'OI indicator OFF') : 'OI color updated')
                } else if (key === 'watchlistOnly') {
                    renderSidebar()
                } else if (key === '__watchlist') {
                    renderSidebar()
                }
            })
        }

        // Global TF buttons — sync active with settings default
        const tfGroup = el('mcGlobalTF');
        if (tfGroup) {
            tfGroup.querySelectorAll('.mc-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === mc.globalTF));
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
                // Refresh NATR for new TF
                fetchServerNATR(mc.globalTF);
            });
        }

        // Sort by column headers in sidebar
        const colHeaders2 = document.getElementById('mcColHeaders');
        if (colHeaders2) {
            colHeaders2.querySelectorAll('.mc-col-hdr').forEach(hdr => {
                hdr.addEventListener('click', () => {
                    const key = hdr.dataset.sort;
                    // Toggle direction if same column, else set desc
                    if (mc.sortBy === key) {
                        mc.sortDir = mc.sortDir === 'desc' ? 'asc' : 'desc';
                    } else {
                        mc.sortBy = key;
                        mc.sortDir = 'desc';
                    }
                    // Update header classes
                    colHeaders2.querySelectorAll('.mc-col-hdr').forEach(h => h.classList.remove('active', 'asc', 'desc'));
                    hdr.classList.add('active', mc.sortDir);
                    applyFiltersAndRebuild();
                });
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

        // Density toggle checkbox
        const densityToggle = el('mcDensityToggle');
        if (densityToggle) {
            densityToggle.checked = spGet('densityEnabled', true);
            densityToggle.addEventListener('change', () => {
                const enabled = densityToggle.checked;
                const sp = _sp();
                if (sp) sp.set('densityEnabled', enabled);
                if (!enabled) {
                    // Remove density lines from all mini-charts
                    Object.values(mc.charts).forEach(c => {
                        if (c.densityLines) { c.densityLines.forEach(pl => { try { c.series.removePriceLine(pl) } catch(e){} }); c.densityLines = [] }
                    });
                    // Remove from modal
                    if (modal.densityLines) { modal.densityLines.forEach(pl => { try { modal.series.removePriceLine(pl) } catch(e){} }); modal.densityLines = [] }
                } else {
                    // Re-apply densities
                    const visibleSyms = Object.keys(mc.charts).filter(s => mc.charts[s].series);
                    if (visibleSyms.length > 0) applyDensityToBatch(visibleSyms);
                    if (modal.chart && modal.currentSym) applyDensityToModal();
                }
            });
        }

        // Mobile sidebar toggle (hamburger)
        const sidebarToggle = el('mcSidebarToggle');
        const sidebarOverlay = el('mcSidebarOverlay');
        const sidebar = el('mcSidebar');
        if (sidebarToggle && sidebar) {
            const openSidebar = () => {
                sidebar.classList.add('mobile-open');
                if (sidebarOverlay) sidebarOverlay.classList.add('active');
            };
            const closeSidebar = () => {
                sidebar.classList.remove('mobile-open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('active');
            };
            sidebarToggle.addEventListener('click', () => {
                sidebar.classList.contains('mobile-open') ? closeSidebar() : openSidebar();
            });
            if (sidebarOverlay) {
                sidebarOverlay.addEventListener('click', closeSidebar);
            }
            // Close sidebar when coin is clicked (mobile)
            sidebar.addEventListener('click', (e) => {
                if (e.target.closest('.mc-coin-item') && window.innerWidth <= 768) {
                    closeSidebar();
                }
            });
        }

        // Search input
        const searchInput = el('mcSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                mc.searchQuery = e.target.value.trim().toUpperCase();
                renderSidebar();
            });
        }

        // Close flag popups on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.mc-flag-btn') && !e.target.closest('.mc-flag-popup')) {
                document.querySelectorAll('.mc-flag-popup').forEach(p => p.remove());
            }
        });

        // Init modal events
        initModalEvents();

        // Init layout picker (multi-chart)
        initLayoutPicker();

        // Setup IntersectionObserver with debounced batch loading
        mc._queueFlushTimer = null;
        mc.observer = new IntersectionObserver((entries) => {
            let added = 0;
            entries.forEach(entry => {
                const sym = entry.target.dataset.symbol;
                if (!sym) return;
                if (entry.isIntersecting) {
                    // Card scrolled into view — create chart & queue for batch load
                    if (!mc.charts[sym]) {
                        createChartInstance(sym);
                        mc.loadQueue.push(sym);
                        added++;
                    }
                } else {
                    // Card scrolled out — destroy chart & unsubscribe WS
                    if (mc.charts[sym]) {
                        mc.charts[sym].chart.remove();
                        delete mc.charts[sym];
                        delete mc.loadedData[sym];
                        // Unsub this symbol's stream
                        const stream = `${sym.toLowerCase()}@kline_${mc.globalTF}`;
                        if (mc.wsStreams.has(stream) && mc.ws && mc.ws.readyState === WebSocket.OPEN) {
                            mc.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [stream], id: Date.now() }));
                        }
                        mc.wsStreams.delete(stream);
                    }
                }
            });
            // Debounce: wait 50ms for all visible cards to register, then flush as one big batch
            if (added > 0) {
                clearTimeout(mc._queueFlushTimer);
                mc._queueFlushTimer = setTimeout(() => processLoadQueue(), 50);
            }
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

        // Fetch real NATR from server (background)
        fetchServerNATR(mc.globalTF);
    } catch (e) {
        console.error('Mini-Charts fetch error:', e);
        if (status) status.textContent = 'Error';
    }
}

async function fetchServerNATR(tf) {
    try {
        const res = await fetch(`/api/natr?interval=${tf}`);
        const natrMap = await res.json();
        if (!natrMap || typeof natrMap !== 'object') return;

        // Update all pairs with real NATR
        mc.allPairs.forEach(p => {
            if (natrMap[p.symbol] !== undefined) {
                p.proxyNatr = natrMap[p.symbol];
            }
        });

        // Update displayed values on visible chart cards
        Object.keys(natrMap).forEach(sym => {
            const card = document.getElementById(`mc-card-${sym}`);
            if (card) {
                const span = card.querySelector('.mc-natr');
                if (span) span.textContent = natrMap[sym].toFixed(1) + '%';
            }
        });

        // Update sidebar NATR values
        const sidebarItems = document.querySelectorAll('.mc-coin-item');
        sidebarItems.forEach(item => {
            const sym = item.dataset.symbol;
            if (sym && natrMap[sym] !== undefined) {
                const natrSpan = item.querySelector('.mc-coin-natr');
                if (natrSpan) natrSpan.textContent = natrMap[sym].toFixed(1);
            }
        });

        // Re-sort if sorting by NATR
        if (mc.sortBy === 'natr') {
            sortPairs();
            renderSidebar();
            // Reorder cards in DOM without destroying charts
            const grid = el('chartsGrid');
            if (grid) {
                mc.filteredPairs.forEach(p => {
                    const card = document.getElementById(`mc-card-${p.symbol}`);
                    if (card) grid.appendChild(card);
                });
            }
        }
    } catch(e) {
        console.error('NATR fetch error:', e);
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
    // Unsubscribe all WS streams
    wsUnsubscribeAll();

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
        const natr = p.proxyNatr ? p.proxyNatr.toFixed(1) : '—';
        const trades = p.tradesCount >= 1e6 ? (p.tradesCount / 1e6).toFixed(1) + 'M' : p.tradesCount >= 1e3 ? (p.tradesCount / 1e3).toFixed(0) + 'K' : p.tradesCount;

        return `<div class="mc-chart-card" data-symbol="${sym}" id="mc-card-${sym}">
            <div class="mc-chart-header">
                <span class="mc-chart-symbol">${ticker}</span>
                <button class="mc-copy-btn mc-copy-card" data-ticker="${sym.toLowerCase()}" title="Copy ${sym.toLowerCase()}"><svg width="10" height="10" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
                <div class="mc-chart-metrics">
                    <span class="${chgClass}">${chgSign}${chg.toFixed(2)}%</span>
                    <span class="mc-metric-muted" title="24h Volume"><svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:1px"><rect x="1" y="5" width="2" height="5" fill="currentColor" opacity="0.5"/><rect x="4" y="2" width="2" height="8" fill="currentColor" opacity="0.7"/><rect x="7" y="0" width="2" height="10" fill="currentColor"/></svg>${vol}</span>
                    <span class="mc-metric-muted" title="NATR Volatility"><svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:1px"><path d="M0 7L3 3L5 6L7 1L10 5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg><span class="mc-natr">—</span></span>
                    <span class="mc-metric-muted" title="24h Trades"><svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:1px"><path d="M1 3h3M6 3h3M1 7h3M6 7h3" stroke="currentColor" stroke-width="1.2"/></svg>${trades}</span>
                </div>
            </div>
            <div class="mc-chart-body" id="mc-body-${sym}"></div>
        </div>`;
    }).join('');

    // Copy ticker on mini-chart cards
    grid.querySelectorAll('.mc-copy-card').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(btn.dataset.ticker).then(() => {
                btn.classList.add('mc-copy-ok');
                setTimeout(() => btn.classList.remove('mc-copy-ok'), 800);
            });
        });
    });

    // Observe all cards + click to open modal
    grid.querySelectorAll('.mc-chart-card').forEach(card => {
        mc.observer.observe(card);
        card.querySelector('.mc-chart-header').addEventListener('click', () => {
            handleSidebarCoinClick(card.dataset.symbol);
        });
    });
}

function sortPairs() {
    const dir = mc.sortDir === 'desc' ? 1 : -1;
    const sorter = (a, b) => {
        if (mc.sortBy === 'symbol') return dir * a.symbol.localeCompare(b.symbol);
        if (mc.sortBy === 'natr') return dir * (b.proxyNatr - a.proxyNatr);
        if (mc.sortBy === 'trades') return dir * (b.tradesCount - a.tradesCount);
        if (mc.sortBy === 'change') return dir * (b.priceChange - a.priceChange);
        return dir * (b.quoteVol - a.quoteVol); // volume default
    };
    mc.allPairs.sort(sorter);
    mc.filteredPairs.sort(sorter);
}

function renderSidebar() {
    const list = el('mcCoinList');
    const countEl = el('mcCoinCount');
    if (!list) return;

    // Filter by search query
    let pairs = mc.filteredPairs;
    if (mc.searchQuery) {
        pairs = pairs.filter(p => p.symbol.replace('USDT', '').includes(mc.searchQuery));
    }

    // Watchlist-only filter
    const sp = _sp()
    if (sp && spGet('watchlistOnly', false)) {
        pairs = pairs.filter(p => sp.wlHas(p.symbol));
    }

    // Sort: watchlist first, then flagged, then by current sort column
    const dir = mc.sortDir === 'desc' ? 1 : -1;
    pairs = [...pairs].sort((a, b) => {
        // Watchlist coins first
        const wa = sp && sp.wlHas(a.symbol) ? 1 : 0;
        const wb = sp && sp.wlHas(b.symbol) ? 1 : 0;
        if (wb !== wa) return wb - wa;
        const fa = mc.flags[a.symbol] ? 1 : 0;
        const fb = mc.flags[b.symbol] ? 1 : 0;
        if (fb !== fa) return fb - fa;
        if (mc.sortBy === 'symbol') return dir * a.symbol.localeCompare(b.symbol);
        if (mc.sortBy === 'natr') return dir * ((b.proxyNatr || 0) - (a.proxyNatr || 0));
        if (mc.sortBy === 'change') return dir * (b.priceChange - a.priceChange);
        return dir * (b.quoteVol - a.quoteVol);
    });

    if (countEl) countEl.textContent = pairs.length;

    list.innerHTML = pairs.map(p => {
        const sym = p.symbol;
        const ticker = sym.replace('USDT', '');
        const chg = p.priceChange;
        const chgClass = chg >= 0 ? 'mc-metric-green' : 'mc-metric-red';
        const chgSign = chg >= 0 ? '+' : '';
        const vol = p.quoteVol >= 1e9 ? (p.quoteVol / 1e9).toFixed(1) + 'B' : (p.quoteVol / 1e6).toFixed(0) + 'M';
        const natr = p.proxyNatr ? p.proxyNatr.toFixed(1) : '—';
        const flagColor = mc.flags[sym] || '';
        const flagStyle = flagColor ? `background:${flagColor}; border-color:transparent;` : '';
        const flagClass = flagColor ? 'mc-flag-btn flagged' : 'mc-flag-btn';

        const showChg = spGet('colChg', true)
        const showNatr = spGet('colNatr', true)
        const showVol = spGet('colVol', true)
        const isWl = sp && sp.wlHas(sym)

        return `<div class="mc-coin-item${isWl ? ' mc-wl' : ''}" data-symbol="${sym}">
            <button class="${flagClass}" style="${flagStyle}" data-flag="${sym}" title="Set color flag"></button>
            <span class="mc-coin-name">${ticker}</span>
            <button class="mc-wl-btn${isWl ? ' active' : ''}" data-wl="${sym}" title="${isWl ? 'Remove from watchlist' : 'Add to watchlist'}">★</button>
            <button class="mc-copy-btn" data-ticker="${ticker.toLowerCase()}usdt" title="Copy ${ticker.toLowerCase()}usdt">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            ${showChg ? `<span class="mc-coin-change ${chgClass}">${chgSign}${chg.toFixed(1)}%</span>` : ''}
            ${showNatr ? `<span class="mc-coin-natr">${natr}</span>` : ''}
            ${showVol ? `<span class="mc-coin-vol">${vol}</span>` : ''}
        </div>`;
    }).join('');

    // Flag button click — show color picker
    list.querySelectorAll('.mc-flag-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sym = btn.dataset.flag;
            document.querySelectorAll('.mc-flag-popup').forEach(p => p.remove());
            const popup = document.createElement('div');
            popup.className = 'mc-flag-popup';
            popup.innerHTML = FLAG_COLORS.map(c =>
                `<div class="mc-flag-color" data-color="${c}" style="background:${c};"></div>`
            ).join('') + `<button class="mc-flag-clear" title="Remove flag">&times;</button>`;
            btn.style.position = 'relative';
            btn.appendChild(popup);
            popup.querySelectorAll('.mc-flag-color').forEach(dot => {
                dot.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    mc.flags[sym] = dot.dataset.color;
                    saveFlags();
                    popup.remove();
                    renderSidebar();
                });
            });
            popup.querySelector('.mc-flag-clear').addEventListener('click', (ev) => {
                ev.stopPropagation();
                delete mc.flags[sym];
                saveFlags();
                popup.remove();
                renderSidebar();
            });
        });
    });

    // Watchlist ★ button
    list.querySelectorAll('.mc-wl-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sym = btn.dataset.wl;
            if (sp) {
                sp.wlToggle(sym);
                btn.classList.toggle('active');
                const item = btn.closest('.mc-coin-item');
                if (item) item.classList.toggle('mc-wl');
            }
        });
    });

    // Copy ticker button
    list.querySelectorAll('.mc-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ticker = btn.dataset.ticker;
            navigator.clipboard.writeText(ticker).then(() => {
                btn.classList.add('mc-copy-ok');
                setTimeout(() => btn.classList.remove('mc-copy-ok'), 800);
            });
        });
    });

    // Click handler — open coin modal or assign to multi-chart slot
    list.querySelectorAll('.mc-coin-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.mc-flag-btn') || e.target.closest('.mc-flag-popup') || e.target.closest('.mc-copy-btn') || e.target.closest('.mc-wl-btn')) return;
            handleSidebarCoinClick(item.dataset.symbol);
        });
    });

    // Apply column visibility from settings
    applySidebarColumns()
}


function getPricePrecision(price) {
    if (price >= 1000) return 1;
    if (price >= 100) return 2;
    if (price >= 1) return 3;
    if (price >= 0.01) return 4;
    if (price >= 0.001) return 5;
    return 6;
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
        ...localChartOptions,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#64748b', fontSize: 9 },
        grid: getGridOpts(),
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0.1 }, minimumWidth: 32, mode: getPriceScaleMode() },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: false, rightOffset: 10, tickMarkFormatter: localTickFormatter },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    const series = addMainSeries(chart, prec, minMove);

    // Volume histogram
    const volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100,116,139,0.3)',
    });
    chart.priceScale('vol').applyOptions({
        scaleMargins: { top: getVolScaleTop(), bottom: 0 },
        drawTicks: false,
        borderVisible: false,
    });

    mc.charts[sym] = { chart, series, volSeries, lines: [], oiSeries: null, candleData: null };

    // Drawing tools on mini-chart — switch context on interaction
    chartEl.addEventListener('mousedown', () => {
        if (drawCtx.source !== 'mini:' + sym) {
            setDrawCtxMini(sym);
            renderDrawToolbar(chartEl);
        }
    }, true);
    chartEl.addEventListener('touchstart', () => {
        if (drawCtx.source !== 'mini:' + sym) {
            setDrawCtxMini(sym);
            renderDrawToolbar(chartEl);
        }
    }, { capture: true, passive: true });

    // Attach ruler + drawing handlers
    attachRuler(chartEl, chart, series);
    setupDrawingHandlers(chartEl);
}

// Batch load queue — fetches multiple symbols at once via server batch endpoint
async function processLoadQueue() {
    if (mc.loadingActive) return;
    mc.loadingActive = true;

    while (mc.loadQueue.length > 0) {
        // Grab up to 20 symbols from queue (all visible cards at once)
        const batch = [];
        while (mc.loadQueue.length > 0 && batch.length < 20) {
            const sym = mc.loadQueue.shift();
            if (!mc.charts[sym]) continue; // already scrolled away
            if (mc.loadedData[sym]) continue; // already loaded
            batch.push(sym);
        }
        if (batch.length === 0) continue;

        try {
            const res = await fetch('/api/klines-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: batch, interval: mc.globalTF, limit: 500 })
            });
            const allData = await res.json();

            // Apply data to all charts simultaneously (no awaits — pure DOM ops)
            const loadedSyms = [];
            for (const sym of batch) {
                if (!mc.charts[sym]) continue;
                if (allData[sym] && Array.isArray(allData[sym])) {
                    const parsed = parseKlines(allData[sym]);
                    if (parsed.length > 0) {
                        mc.charts[sym].candleData = parsed;
                        mc.charts[sym].series.setData(parsed);
                        mc.charts[sym].volSeries?.setData(extractVolume(parsed));
                        const visibleCount = Math.min(100, parsed.length);
                        mc.charts[sym].chart.timeScale().setVisibleLogicalRange({
                            from: parsed.length - visibleCount,
                            to: parsed.length - 1 + 10
                        });
                        mc.loadedData[sym] = true;
                        const realNatr = calcNATR(parsed);
                        if (realNatr > 0) updateCardNATR(sym, realNatr);
                        applyDrawingsToMiniChart(sym);
                        wsSubscribe(sym);
                        loadedSyms.push(sym);
                    }
                }
            }
            // Batch density load for all loaded symbols (one request instead of N)
            if (loadedSyms.length > 0) {
                applyDensityToBatch(loadedSyms);
                applyOIToBatch(loadedSyms);
            }
        } catch(e) {
            // Fallback: load individually
            for (const sym of batch) {
                if (!mc.charts[sym] || mc.loadedData[sym]) continue;
                await loadChartData(sym, mc.globalTF);
                await new Promise(r => setTimeout(r, 80));
            }
        }
    }

    mc.loadingActive = false;
}

// NO manual TZ offset — timestamps are pure UTC seconds.
// All time formatting done via Date() which uses browser's local timezone.
const TZ_OFFSET_SEC = 0;

// Local time formatters for LightweightCharts
const localTimeFormatter = (utcSec) => {
    const d = new Date(utcSec * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};
const localTickFormatter = (utcSec, tickMarkType, locale) => {
    const d = new Date(utcSec * 1000);
    // tickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
    if (tickMarkType <= 1) return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
    if (tickMarkType === 2) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
};
const localChartOptions = {
    localization: { timeFormatter: localTimeFormatter },
};

function parseKlines(json) {
    return json.map(k => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
    }));
}

function extractVolume(data) {
    return data.map(d => ({
        time: d.time,
        value: d.volume,
        color: d.close >= d.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
    }));
}

// Apply saved drawings (hlines, fibs) to mini-chart
function applyDrawingsToMiniChart(sym) {
    const c = mc.charts[sym];
    if (!c || !c.series) return;

    // Clear old drawing objects
    if (c.drawObjs) {
        c.drawObjs.forEach(obj => {
            if (obj.priceLine) try { c.series.removePriceLine(obj.priceLine); } catch(e) {}
            if (obj.lineSeries) try { c.chart.removeSeries(obj.lineSeries); } catch(e) {}
        });
    }
    c.drawObjs = [];

    const saved = drawStore.load(sym);
    if (!saved || saved.length === 0) return;

    saved.forEach(s => {
        if (s.type === 'hline' && s.data) {
            const pl = c.series.createPriceLine({
                price: s.data.price,
                color: s.color || '#5b9cf6',
                lineWidth: 1,
                lineStyle: 2, // dashed on mini
                axisLabelVisible: false,
                title: '',
            });
            c.drawObjs.push({ priceLine: pl });
        } else if (s.type === 'fib' && s.data) {
            const rawLevels = s.data.levels || FIB_DEFAULTS_OBJ;
            const diff = s.data.p2 - s.data.p1;
            rawLevels.forEach((item, i) => {
                const lvl = typeof item === 'number' ? item : item.level;
                const clr = (typeof item === 'object' && item.color) ? item.color : (s.color || '#5b9cf6');
                const price = s.data.p1 + diff * lvl;
                const pl = c.series.createPriceLine({
                    price,
                    color: clr,
                    lineWidth: 1,
                    lineStyle: 0,
                    axisLabelVisible: false,
                    title: '',
                });
                c.drawObjs.push({ priceLine: pl });
            });
        } else if ((s.type === 'ray' || s.type === 'trendline') && s.data) {
            const { t1, p1, t2, p2 } = s.data;
            const points = [];
            if (s.type === 'ray') {
                const dt = t2 - t1;
                const dp = p2 - p1;
                const steps = 200;
                const seen = new Set();
                for (let i = 0; i <= steps; i++) {
                    const ratio = i / 5;
                    const t = Math.round(t1 + dt * ratio);
                    if (seen.has(t)) continue;
                    seen.add(t);
                    points.push({ time: t, value: p1 + dp * ratio });
                }
                points.sort((a, b) => a.time - b.time);
            } else {
                points.push({ time: t1, value: p1 });
                points.push({ time: t2, value: p2 });
            }
            const ls = c.chart.addSeries(LightweightCharts.LineSeries, {
                color: s.color || '#5b9cf6',
                lineWidth: 1,
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false,
                pointMarkersVisible: false,
            });
            ls.setData(points);
            c.drawObjs.push({ lineSeries: ls });
        } else if (s.type === 'rect' && s.data) {
            // Rectangle on mini-chart: top + bottom border lines
            const { t1, p1, t2, p2 } = s.data;
            const clr = s.color || '#5b9cf6';
            const topLs = c.chart.addSeries(LightweightCharts.LineSeries, {
                color: clr, lineWidth: 1, crosshairMarkerVisible: false,
                lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
            });
            topLs.setData([{ time: t1, value: Math.max(p1, p2) }, { time: t2, value: Math.max(p1, p2) }]);
            c.drawObjs.push({ lineSeries: topLs });

            const botLs = c.chart.addSeries(LightweightCharts.LineSeries, {
                color: clr, lineWidth: 1, crosshairMarkerVisible: false,
                lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
            });
            botLs.setData([{ time: t1, value: Math.min(p1, p2) }, { time: t2, value: Math.min(p1, p2) }]);
            c.drawObjs.push({ lineSeries: botLs });
        }
    });
}

// Calculate real ATR(14) / close * 100 = NATR from candle data
function calcNATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const h = candles[i].high;
        const l = candles[i].low;
        const pc = candles[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    // SMA of last `period` TRs
    const recent = trs.slice(-period);
    const atr = recent.reduce((s, v) => s + v, 0) / recent.length;
    const lastClose = candles[candles.length - 1].close;
    return lastClose > 0 ? (atr / lastClose) * 100 : 0;
}

// Update NATR display on mini-chart card after real calc
function updateCardNATR(sym, natr) {
    const card = document.getElementById(`mc-card-${sym}`);
    if (!card) return;
    const natrSpan = card.querySelector('.mc-natr');
    if (natrSpan) natrSpan.textContent = natr.toFixed(1) + '%';
    // Update pair data for sorting
    const pair = mc.allPairs.find(p => p.symbol === sym);
    if (pair) pair.proxyNatr = natr;
}

async function loadChartData(sym, tf) {
    if (!mc.charts[sym]) return;
    try {
        // Phase 1: fast load — last 100 candles for instant render
        const res1 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=100`);
        const json1 = await res1.json();
        if (!Array.isArray(json1) || !mc.charts[sym]) return;

        const data1 = parseKlines(json1);
        mc.charts[sym].series.setData(data1);
        mc.charts[sym].volSeries.setData(extractVolume(data1));
        mc.loadedData[sym] = true;

        // Show all 100 candles
        mc.charts[sym].chart.timeScale().setVisibleLogicalRange({ from: 0, to: data1.length - 1 });

        // Calculate real NATR from candle data
        const realNatr = calcNATR(data1);
        if (realNatr > 0) updateCardNATR(sym, realNatr);

        // Apply saved drawings to mini-chart
        applyDrawingsToMiniChart(sym);

        // Apply density walls to mini-chart
        applyDensityToMiniChart(sym);

        // Subscribe to live WS updates immediately
        wsSubscribe(sym);

        // Phase 2: background load — 500 candles
        setTimeout(async () => {
            if (!mc.charts[sym]) return;
            try {
                const res2 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=500`);
                const json2 = await res2.json();
                if (!Array.isArray(json2) || !mc.charts[sym]) return;

                const data2 = parseKlines(json2);
                const visRange = mc.charts[sym].chart.timeScale().getVisibleLogicalRange();
                mc.charts[sym].series.setData(data2);
                mc.charts[sym].volSeries.setData(extractVolume(data2));

                const added = data2.length - data1.length;
                if (visRange) {
                    mc.charts[sym].chart.timeScale().setVisibleLogicalRange({
                        from: visRange.from + added,
                        to: visRange.to + added
                    });
                }

                // Re-apply drawings after full data load
                applyDrawingsToMiniChart(sym);
            } catch (e) { /* background load failed */ }
        }, 300);

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
// Live WebSocket — Binance kline stream
// ==========================================
const BINANCE_WS = 'wss://fstream.binance.com/stream';

function wsConnect() {
    if (mc.ws && mc.ws.readyState <= 1) return; // CONNECTING or OPEN

    mc.ws = new WebSocket(BINANCE_WS);
    mc.ws.onopen = () => {
        console.log('[MC-WS] Connected');
        // Subscribe any pending streams
        if (mc.wsStreams.size > 0) {
            const params = [...mc.wsStreams];
            mc.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 }));
        }
    };
    mc.ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (!msg.data || msg.data.e !== 'kline') return;
            const k = msg.data.k;
            const sym = k.s;
            const candle = {
                time: Math.floor(k.t / 1000),
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
            };

            const vol = parseFloat(k.v);

            // Check price alerts
            checkPriceAlerts(sym, candle.close);

            // Update mini-chart
            if (mc.charts[sym]) {
                mc.charts[sym].series.update(candle);
                mc.charts[sym].volSeries.update({
                    time: candle.time,
                    value: vol,
                    color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
                });
            }

            // Update multi-chart slots
            for (const slot of mch.slots) {
                if (slot.sym === sym && slot.chart && slot.series) {
                    const slotStream = `${sym.toLowerCase()}@kline_${slot.tf}`;
                    const incomingStream = msg.stream || '';
                    if (incomingStream === slotStream) {
                        // Prevent auto-scroll if user has panned away from right edge
                        const slotTs = slot.chart.timeScale();
                        const slotRange = slotTs.getVisibleLogicalRange();
                        const slotScroll = slotTs.scrollPosition();
                        slot.series.update(candle);
                        if (slot.volSeries) slot.volSeries.update({
                            time: candle.time,
                            value: vol,
                            color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
                        });
                        if (slotRange && slotScroll < 5) {
                            slotTs.setVisibleLogicalRange(slotRange);
                        }
                        // Update header price/change
                        const pair = mc.allPairs.find(p => p.symbol === sym);
                        if (pair) {
                            const prec = getPricePrecision(candle.close);
                            const priceEl = slot.el.querySelector('.mch-slot-price');
                            if (priceEl) priceEl.textContent = '$' + candle.close.toFixed(prec);
                        }
                    }
                }
            }

            // Update modal chart if same symbol & TF
            if (modal.chart && modal.currentSym === sym) {
                const modalStream = `${sym.toLowerCase()}@kline_${modal.currentTF}`;
                const incomingStream = msg.stream || '';
                if (incomingStream === modalStream || modal.wsStream === `${sym.toLowerCase()}@kline_${k.i}`) {
                    // Prevent auto-scroll if user has panned away from right edge
                    const ts = modal.chart.timeScale();
                    const rangeBefore = ts.getVisibleLogicalRange();
                    const scrollPos = ts.scrollPosition();
                    modal.series.update(candle);
                    if (modal.volSeries) modal.volSeries.update({
                        time: candle.time,
                        value: vol,
                        color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
                    });
                    // If user was scrolled left (scrollPos < rightOffset threshold), restore position
                    if (rangeBefore && scrollPos < 5) {
                        ts.setVisibleLogicalRange(rangeBefore);
                    }
                }
            }
        } catch (e) { /* ignore parse errors */ }
    };
    mc.ws.onclose = () => {
        console.log('[MC-WS] Disconnected, reconnecting in 3s...');
        setTimeout(wsConnect, 3000);
    };
    mc.ws.onerror = () => {}; // onclose will handle reconnect
}

function wsSubscribe(sym) {
    const stream = `${sym.toLowerCase()}@kline_${mc.globalTF}`;
    if (mc.wsStreams.has(stream)) return;
    mc.wsStreams.add(stream);

    if (!mc.ws || mc.ws.readyState !== WebSocket.OPEN) {
        wsConnect();
        return; // onopen will subscribe all pending
    }
    mc.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [stream], id: Date.now() }));
}

function wsUnsubscribeAll() {
    if (mc.ws && mc.ws.readyState === WebSocket.OPEN && mc.wsStreams.size > 0) {
        mc.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [...mc.wsStreams], id: Date.now() }));
    }
    mc.wsStreams.clear();
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

        // Calculate time duration
        const curTime = chart.timeScale().coordinateToTime(curX);
        let timeStr = '';
        if (startTime && curTime) {
            const timeDiffSec = Math.abs(curTime - startTime);
            if (timeDiffSec < 3600) {
                timeStr = Math.round(timeDiffSec / 60) + 'm';
            } else if (timeDiffSec < 86400) {
                timeStr = (timeDiffSec / 3600).toFixed(1) + 'h';
            } else {
                timeStr = (timeDiffSec / 86400).toFixed(1) + 'd';
            }
        }

        // Position label at midpoint
        const midX = (startX + curX) / 2;
        const midY = Math.min(startY, curY) - 8;
        label.style.left = midX + 'px';
        label.style.top = Math.max(2, midY) + 'px';
        label.style.transform = 'translateX(-50%)';
        label.style.display = 'block';
        label.style.background = priceDiff >= 0 ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)';
        const timeInfo = timeStr ? ` | ${timeStr}` : '';
        label.textContent = `${sign}${priceDiff.toFixed(prec)}  (${sign}${pctDiff.toFixed(2)}%)${timeInfo}`;
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
    currentTF: '15m',
    wsStream: null
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
    const cmCopyBtn = el('cmCopyBtn');
    if (cmCopyBtn) {
        cmCopyBtn.dataset.ticker = sym.toLowerCase();
        cmCopyBtn.title = `Copy ${sym.toLowerCase()}`;
        cmCopyBtn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(sym.toLowerCase()).then(() => {
                cmCopyBtn.classList.add('mc-copy-ok');
                setTimeout(() => cmCopyBtn.classList.remove('mc-copy-ok'), 800);
            });
        };
    }
    el('cmPrice').textContent = '$' + pair.lastPrice.toFixed(prec);
    const cmChange = el('cmChange');
    cmChange.textContent = chgSign + chg.toFixed(2) + '%';
    cmChange.className = 'mc-modal-change ' + chgClass;

    // Metrics in header (icons, no text labels)
    const vol = pair.quoteVol >= 1e9 ? (pair.quoteVol / 1e9).toFixed(2) + 'B' : (pair.quoteVol / 1e6).toFixed(1) + 'M';
    const tradesStr = pair.tradesCount >= 1e6 ? (pair.tradesCount / 1e6).toFixed(1) + 'M'
        : pair.tradesCount >= 1e3 ? (pair.tradesCount / 1e3).toFixed(1) + 'K'
        : pair.tradesCount.toString();
    el('cmStats').innerHTML = `
        <span class="cm-metric" title="24h Volume"><svg width="11" height="11" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:2px"><rect x="1" y="5" width="2" height="5" fill="currentColor" opacity="0.5"/><rect x="4" y="2" width="2" height="8" fill="currentColor" opacity="0.7"/><rect x="7" y="0" width="2" height="10" fill="currentColor"/></svg>$${vol}</span>
        <span class="cm-metric" title="NATR Volatility"><svg width="11" height="11" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:2px"><path d="M0 7L3 3L5 6L7 1L10 5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg><span id="cmNatr">${pair.proxyNatr.toFixed(1)}%</span></span>
        <span class="cm-metric" title="24h Trades"><svg width="11" height="11" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:2px"><path d="M1 3h3M6 3h3M1 7h3M6 7h3" stroke="currentColor" stroke-width="1.2"/></svg>${tradesStr}</span>
        <span class="cm-metric" title="24h High"><svg width="11" height="11" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:2px"><path d="M5 1L8 5H2L5 1Z" fill="#22c55e" opacity="0.8"/></svg>${parseFloat(pair.highPrice).toFixed(prec)}</span>
        <span class="cm-metric" title="24h Low"><svg width="11" height="11" viewBox="0 0 10 10" style="vertical-align:-1px;margin-right:2px"><path d="M5 9L2 5H8L5 9Z" fill="#ef4444" opacity="0.8"/></svg>${parseFloat(pair.lowPrice).toFixed(prec)}</span>
    `;


    // TF buttons — set active
    const tfBtns = el('cmTFButtons');
    tfBtns.querySelectorAll('.mc-tf-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tf === modal.currentTF);
    });

    // Show modal (CSS: visibility:hidden→visible, NOT display:none)
    el('coinModal').classList.remove('hidden');

    // Create or recreate chart
    if (modal.chart) {
        modal.chart.remove();
        modal.chart = null;
    }

    const chartEl = el('cmChartBody');
    // Clean up stale DOM children (legend, ruler, toolbar) left from previous chart
    chartEl.innerHTML = '';

    const cw = chartEl.clientWidth, ch = chartEl.clientHeight;
    console.log('[modal] chartEl dimensions:', cw, 'x', ch, '| children cleared');

    const minMove = parseFloat((1 / Math.pow(10, prec)).toFixed(prec));

    const wmText = spGet('showWatermark', true) ? sym.replace('USDT', '/USDT') : '';
    modal.chart = LightweightCharts.createChart(chartEl, {
        width: cw,
        height: ch,
        ...localChartOptions,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8' },
        grid: getGridOpts(),
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 50, mode: getPriceScaleMode() },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 10, tickMarkFormatter: localTickFormatter },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    modal.series = addMainSeries(modal.chart, prec, minMove);

    if (wmText) {
        try {
            LightweightCharts.createTextWatermark(modal.chart, { lines: [{ text: wmText, color: 'rgba(255,255,255,0.04)', fontSize: 48 }] });
        } catch (e) {
            console.warn('[modal] createTextWatermark failed (LWC v5 compat):', e.message);
        }
    }

    modal.volSeries = modal.chart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100,116,139,0.3)',
    });
    modal.chart.priceScale('vol').applyOptions({
        scaleMargins: { top: getVolScaleTop(), bottom: 0 },
        drawTicks: false,
        borderVisible: false,
    });

    // ResizeObserver for window resize + safety net for initial render
    if (modal._resizeObserver) modal._resizeObserver.disconnect();
    modal._resizeObserver = new ResizeObserver(entries => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0 && modal.chart) {
            console.log('[modal] ResizeObserver:', width, 'x', height);
            modal.chart.resize(width, height);
        }
    });
    modal._resizeObserver.observe(chartEl);

    modal.lines = [];
    modal.drawings = [];

    // Attach ruler to modal chart
    attachRuler(chartEl, modal.chart, modal.series);

    // OHLCV legend on crosshair move
    const legend = document.createElement('div');
    legend.className = 'mc-ohlcv-legend';
    chartEl.appendChild(legend);
    modal.legend = legend;

    modal.chart.subscribeCrosshairMove(param => {
        if (!param || !param.time || !modal.legend) {
            if (modal.legend) modal.legend.style.display = 'none';
            return;
        }
        const data = param.seriesData.get(modal.series);
        if (!data) { modal.legend.style.display = 'none'; return; }
        const p = getPricePrecision(data.close || data.open || 1);
        const o = (data.open || 0).toFixed(p);
        const h = (data.high || 0).toFixed(p);
        const l = (data.low || 0).toFixed(p);
        const c = (data.close || 0).toFixed(p);
        const volData = param.seriesData.get(modal.volSeries);
        const v = volData ? (volData.value >= 1e6 ? (volData.value/1e6).toFixed(1)+'M' : (volData.value >= 1e3 ? (volData.value/1e3).toFixed(0)+'K' : volData.value.toFixed(0))) : '—';
        const chg = data.close >= data.open;
        const color = chg ? '#22c55e' : '#ef4444';
        modal.legend.style.display = 'flex';
        modal.legend.innerHTML = `<span style="color:${color}">O <b>${o}</b></span><span style="color:${color}">H <b>${h}</b></span><span style="color:${color}">L <b>${l}</b></span><span style="color:${color}">C <b>${c}</b></span><span style="color:var(--text-muted)">V <b>${v}</b></span>`;
    });

    setDrawCtxModal();
    renderDrawToolbar();
    setupDrawingHandlers();
    updateModalCursor();

    // Attach library DrawingManager
    if (typeof DM !== 'undefined' && DM && DM.attach) {
        DM.attach(modal.chart, modal.series, chartEl, sym);
    }

    loadModalChart(sym, modal.currentTF);
    startCountdown();
}

// ---- Candle Countdown Timer ----
const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000, '12h': 43200000, '1d': 86400000 };

function startCountdown() {
    if (modal._countdownTimer) clearInterval(modal._countdownTimer);
    updateCountdown();
    modal._countdownTimer = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
    const cdEl = document.getElementById('cmChartCountdown');
    if (!cdEl || !modal.currentTF) return;
    const ms = TF_MS[modal.currentTF];
    if (!ms) { cdEl.textContent = ''; return; }
    const now = Date.now();
    const remaining = ms - (now % ms);
    const totalSec = Math.floor(remaining / 1000);
    if (ms <= 3600000) {
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        cdEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    } else {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        cdEl.textContent = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
}

async function loadModalChart(sym, tf) {
    // Unsubscribe previous modal WS stream
    if (modal.wsStream) {
        if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
            mc.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [modal.wsStream], id: Date.now() }));
        }
        mc.wsStreams.delete(modal.wsStream);
        modal.wsStream = null;
    }

    try {
        // Phase 1: fast — 1000 candles (pre-warmed in server cache)
        const res1 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=1000`);
        const json1 = await res1.json();
        if (!Array.isArray(json1) || !modal.chart) return;

        const data1 = parseKlines(json1);
        modal.candleData = data1;
        if (drawCtx.source === 'modal') drawCtx.candleData = data1;

        console.log('[modal] setData:', data1.length, 'candles, chart size:', modal.chart.timeScale().width(), 'x', el('cmChartBody').clientHeight);
        modal.series.setData(data1);
        if (modal.volSeries) modal.volSeries.setData(extractVolume(data1));

        // Show last ~100 candles in viewport
        const visFrom = Math.max(0, data1.length - 100);
        const visTo = data1.length - 1 + 10;
        modal.chart.timeScale().setVisibleLogicalRange({ from: visFrom, to: visTo });
        console.log('[modal] visibleRange set:', visFrom, '-', visTo);

        // Safety net: if chart internal width was 0 when range was set,
        // re-apply range after layout settles (fixes LWC v5 first-open bug)
        const tsWidth = modal.chart.timeScale().width();
        if (tsWidth <= 0) {
            console.log('[modal] timeScale width=0, scheduling fitContent fallback');
            setTimeout(() => {
                if (!modal.chart) return;
                const w2 = modal.chart.timeScale().width();
                console.log('[modal] fallback: timeScale width now=', w2);
                if (w2 > 0 && modal.candleData) {
                    const vf = Math.max(0, modal.candleData.length - 100);
                    modal.chart.timeScale().setVisibleLogicalRange({ from: vf, to: modal.candleData.length - 1 + 10 });
                } else {
                    modal.chart.timeScale().fitContent();
                }
            }, 150);
        }

        // Update modal NATR with real value
        const modalNatr = calcNATR(data1);
        const cmNatrEl = document.getElementById('cmNatr');
        if (cmNatrEl && modalNatr > 0) cmNatrEl.textContent = modalNatr.toFixed(1) + '%';

        // Restore saved drawings for this symbol
        restoreDrawings();

        // Signal marker (from Signals tab "Open Chart")
        if (window._pendingSignalMarker && modal.series) {
          const m = window._pendingSignalMarker;
          window._pendingSignalMarker = null;
          // Find nearest candle (apply same TZ offset as klines)
          const target = m.time; // both marker and candles are now UTC, same space
          let best = data1[data1.length - 1];
          let bestDiff = Infinity;
          for (const c of data1) {
            const diff = Math.abs(c.time - target);
            if (diff < bestDiff) { bestDiff = diff; best = c; }
          }
          const isLong = m.direction === 'LONG';
          try {
              if (modal._markers) modal._markers.setMarkers([]);
              modal._markers = LightweightCharts.createSeriesMarkers(modal.series, [{
                time: best.time,
                position: isLong ? 'belowBar' : 'aboveBar',
                color: isLong ? '#22c55e' : '#ef4444',
                shape: isLong ? 'arrowUp' : 'arrowDown',
                text: `${m.type === 'oi_cvd' ? '🔮 OI+CVD' : m.type === 'volume_spike' ? '📊 Vol' : m.type === 'big_mover' ? '🚀 Mover' : '⚡ NATR'} ${m.direction}`,
              }]);
          } catch (e) {
              console.warn('[modal] createSeriesMarkers failed:', e.message);
          }
        }

        // Apply density walls to modal
        applyDensityToModal();

        // Apply OI overlay if enabled
        applyOIOverlay(modal.chart, sym);

        // Subscribe modal to live WS
        const stream = `${sym.toLowerCase()}@kline_${tf}`;
        modal.wsStream = stream;
        mc.wsStreams.add(stream);
        if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
            mc.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [stream], id: Date.now() }));
        } else {
            wsConnect();
        }

        // Phase 2: background — paginate up to 20,000 candles
        setTimeout(async () => {
            if (!modal.chart || modal.currentSym !== sym || modal.currentTF !== tf) return;
            try {
                // First batch: 1500 most recent
                const res2 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=1500`);
                const json2 = await res2.json();
                if (!Array.isArray(json2) || !modal.chart) return;

                let fullData = parseKlines(json2);
                // Save visible TIME range (not logical) — stable across setData
                const visTimeRange = modal.chart.timeScale().getVisibleRange();
                const TARGET = 20000;

                // Paginate backwards until we hit target or run out of data
                let oldestTime = json2.length > 0 ? json2[0][0] : null;
                while (fullData.length < TARGET && oldestTime) {
                    if (!modal.chart || modal.currentSym !== sym || modal.currentTF !== tf) break;
                    try {
                        const res = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=1500&endTime=${oldestTime - 1}`);
                        const json = await res.json();
                        if (!Array.isArray(json) || json.length === 0) break;
                        const olderData = parseKlines(json);
                        fullData = [...olderData, ...fullData];
                        oldestTime = json[0][0];
                        // Minimal delay (server caches, no direct Binance rate limit issue)
                        await new Promise(r => setTimeout(r, 20));
                    } catch(e) { break; }
                }

                if (!modal.chart || modal.currentSym !== sym) return;
                modal.candleData = fullData;
                if (drawCtx.source === 'modal') drawCtx.candleData = fullData;
                modal.series.setData(fullData);
                if (modal.volSeries) modal.volSeries.setData(extractVolume(fullData));
                // Restore by time range (absolute, no offset math needed)
                if (visTimeRange) {
                    modal.chart.timeScale().setVisibleRange(visTimeRange);
                }
                console.log(`[Modal] ${sym} loaded ${fullData.length} candles`);
            } catch (e) { /* background load failed */ }
        }, 400);
    } catch (e) {
        console.error('Modal chart error:', e);
    }
}

// ---- OI Indicator (bottom pane, like TradingView) ----
const OI_PANE_HEIGHT = 0.10; // 10% of chart height for OI pane
const OI_TF_MAP = { '1m': '5m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '4h', '12h': '1d', '1d': '1d' };
const OI_FMT = (v) => v >= 1e9 ? (v/1e9).toFixed(1) + 'B' : v >= 1e6 ? (v/1e6).toFixed(0) + 'M' : v.toFixed(0);

// Adjust candle + volume margins when OI pane is toggled
function adjustChartMargins(chartObj, hasOI) {
    // chartObj = { chart, series, volSeries } — works for modal, mc.charts[sym], mch.slots[i]
    if (!chartObj || !chartObj.chart) return;
    const bot = hasOI ? OI_PANE_HEIGHT + 0.02 : 0.05;
    chartObj.chart.priceScale('right').applyOptions({
        scaleMargins: { top: 0.05, bottom: bot },
    });
    if (chartObj.volSeries) {
        const volH = spGet('volumeHeight', 15) / 100;
        const volTop = hasOI ? (1 - OI_PANE_HEIGHT - 0.02 - volH) : (1 - volH);
        const volBot = hasOI ? (OI_PANE_HEIGHT + 0.02) : 0;
        try {
            chartObj.chart.priceScale('vol').applyOptions({
                scaleMargins: { top: volTop, bottom: volBot },
            });
        } catch(e) {}
    }
}

// Generic: add OI line to any chart object. chartObj must have { chart, oiSeries? }
async function applyOI(chartObj, sym, tf) {
    if (!chartObj || !chartObj.chart) return;

    // Remove existing
    if (chartObj.oiSeries) {
        try { chartObj.chart.removeSeries(chartObj.oiSeries); } catch(e) {}
        chartObj.oiSeries = null;
    }

    const enabled = spGet('indicatorOI', false);
    if (!enabled || !sym) {
        adjustChartMargins(chartObj, false);
        return;
    }

    const period = OI_TF_MAP[tf || '5m'] || '5m';

    try {
        const res = await fetch(`/api/oi-history?symbol=${sym}&period=${period}&limit=500`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
            adjustChartMargins(chartObj, false);
            return;
        }

        const color = spGet('indicatorOIColor', '#eab308');

        chartObj.oiSeries = chartObj.chart.addSeries(LightweightCharts.LineSeries, {
            color: color,
            lineWidth: 1.5,
            priceScaleId: 'oi',
            priceFormat: { type: 'custom', formatter: OI_FMT },
            title: 'OI',
            lastValueVisible: true,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 3,
        });
        chartObj.chart.priceScale('oi').applyOptions({
            scaleMargins: { top: 1 - OI_PANE_HEIGHT, bottom: 0 },
            drawTicks: false,
            borderVisible: false,
            entireTextOnly: true,
        });

        const oiData = data.map(d => ({
            time: Math.floor(d.timestamp / 1000),
            value: parseFloat(d.sumOpenInterestValue || d.sumOpenInterest || 0),
        }));
        chartObj.oiSeries.setData(oiData);
        adjustChartMargins(chartObj, true);

    } catch (e) {
        console.error('[OI] Error:', sym, e);
        adjustChartMargins(chartObj, false);
    }
}

// Wrapper for modal (backward compat)
async function applyOIOverlay(chart, sym) {
    await applyOI(modal, sym, modal.currentTF);
}

// Batch OI for mini-charts (throttled, non-blocking)
async function applyOIToBatch(symbols) {
    if (!spGet('indicatorOI', false)) return;
    for (const sym of symbols) {
        const c = mc.charts[sym];
        if (!c || !c.chart) continue;
        applyOI(c, sym, mc.globalTF); // fire-and-forget, no await to avoid blocking
        await new Promise(r => setTimeout(r, 50)); // 50ms throttle between fetches
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


// ==========================================
// Drawing Tools — Modal only
// ==========================================
const DRAW_TOOLS = [
    { id: 'cursor', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 2L4.5 14L8 10.5L11.5 16L13 15L9.5 9.5L14 9.5L4.5 2Z" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>', title: 'Cursor (Esc)', key: 'Escape' },
    { id: 'hline', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><line x1="1" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/></svg>', title: 'Horizontal Line (H)', key: 'h' },
    { id: 'ray', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="3" cy="9" r="2" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1"/><line x1="5" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.5"/><path d="M14 6.5L17 9L14 11.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>', title: 'Horizontal Ray (R)', key: 'r' },
    { id: 'trendline', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><line x1="3" y1="14" x2="15" y2="4" stroke="currentColor" stroke-width="1.5"/><circle cx="3" cy="14" r="2" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1"/><circle cx="15" cy="4" r="2" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1"/></svg>', title: 'Trend Line (T)', key: 't' },
    { id: 'fib', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><line x1="2" y1="3" x2="16" y2="3" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="7" x2="16" y2="7" stroke="currentColor" stroke-width="1" opacity="0.6"/><line x1="2" y1="11" x2="16" y2="11" stroke="currentColor" stroke-width="1" opacity="0.6"/><line x1="2" y1="15" x2="16" y2="15" stroke="currentColor" stroke-width="1.2"/><text x="1" y="6.5" font-size="5" fill="currentColor" opacity="0.5">0</text><text x="1" y="14.5" font-size="5" fill="currentColor" opacity="0.5">1</text></svg>', title: 'Fibonacci (F)', key: 'f' },
    { id: 'rect', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="3" y="4" width="12" height="10" stroke="currentColor" stroke-width="1.3" fill="currentColor" fill-opacity="0.08"/><circle cx="3" cy="4" r="1.5" fill="currentColor" opacity="0.4"/><circle cx="15" cy="14" r="1.5" fill="currentColor" opacity="0.4"/></svg>', title: 'Rectangle (B)', key: 'b' },
    { id: 'ruler', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><line x1="3" y1="15" x2="15" y2="3" stroke="currentColor" stroke-width="1.4"/><line x1="3" y1="15" x2="3" y2="3" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.4"/><line x1="3" y1="3" x2="15" y2="3" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.4"/><path d="M12 5.5h3v-3" stroke="currentColor" stroke-width="1" opacity="0.6" fill="none"/><path d="M6 12.5H3v3" stroke="currentColor" stroke-width="1" opacity="0.6" fill="none"/></svg>', title: 'Ruler / Measure (M)', key: 'm' },
    { id: 'trash', icon: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 5h10l-1 10.5H5L4 5z" stroke="currentColor" stroke-width="1.2" fill="currentColor" fill-opacity="0.05" stroke-linejoin="round"/><line x1="3" y1="5" x2="15" y2="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 5V3.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V5" stroke="currentColor" stroke-width="1.1"/><line x1="7.5" y1="7.5" x2="7.5" y2="13" stroke="currentColor" stroke-width="0.8" opacity="0.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13" stroke="currentColor" stroke-width="0.8" opacity="0.5"/></svg>', title: 'Clear All', key: 'Delete' },
];

const DRAW_COLORS = ['#5b9cf6', '#ef4444', '#f97316', '#eab308', '#22c55e', '#a855f7', '#ec4899', '#ffffff'];
let drawIdCounter = 0;

// Persistent drawing storage (localStorage)
const drawStore = (() => {
    const KEY = 'mc_drawings';
    function loadAll() {
        try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e) { return {}; }
    }
    function saveAll(store) {
        localStorage.setItem(KEY, JSON.stringify(store));
    }
    return {
        save(sym, drawings) {
            const store = loadAll();
            store[sym] = drawings.map(d => ({
                type: d.type, color: d.color, locked: d.locked,
                data: d.data, alert: d.alert || false
            }));
            saveAll(store);
        },
        load(sym) {
            const store = loadAll();
            return store[sym] || [];
        },
        loadAll,
        remove(sym) {
            const store = loadAll();
            delete store[sym];
            saveAll(store);
        }
    };
})();

// ==========================================
// Price Alert System
// ==========================================
const alertState = {
    // Track last known price per symbol to detect crossings
    lastPrices: {},
    // Cooldown per alert to avoid spam (key: "sym:price", value: timestamp)
    cooldowns: {},
    COOLDOWN_MS: 60000, // 1 min cooldown per alert
};

function checkPriceAlerts(sym, currentPrice) {
    const allDrawings = drawStore.loadAll();
    const symDrawings = allDrawings[sym];
    if (!symDrawings || symDrawings.length === 0) return;

    const lastPrice = alertState.lastPrices[sym];
    alertState.lastPrices[sym] = currentPrice;
    if (lastPrice === undefined) return; // first tick, no crossing possible

    symDrawings.forEach(d => {
        if (!d.alert) return;
        if (d.type !== 'hline' && d.type !== 'ray') return;
        const alertPrice = d.data.price;
        if (!alertPrice) return;

        // Check crossing: last was below, now above (or vice versa)
        const crossedUp = lastPrice < alertPrice && currentPrice >= alertPrice;
        const crossedDown = lastPrice > alertPrice && currentPrice <= alertPrice;
        if (!crossedUp && !crossedDown) return;

        // Cooldown check
        const cooldownKey = `${sym}:${alertPrice.toFixed(8)}`;
        const now = Date.now();
        if (alertState.cooldowns[cooldownKey] && now - alertState.cooldowns[cooldownKey] < alertState.COOLDOWN_MS) return;
        alertState.cooldowns[cooldownKey] = now;

        const direction = crossedUp ? '▲ Crossed Above' : '▼ Crossed Below';
        const ticker = sym.replace('USDT', '');
        showAlertToast(sym, ticker, currentPrice, alertPrice, direction, d.color);
    });
}

function showAlertToast(sym, ticker, currentPrice, alertPrice, direction, color) {
    // Remove old toasts if too many
    const existing = document.querySelectorAll('.alert-toast');
    if (existing.length >= 5) existing[0].remove();

    const prec = getPricePrecision(currentPrice);
    const toast = document.createElement('div');
    toast.className = 'alert-toast';
    toast.style.borderLeftColor = color || '#5b9cf6';
    toast.innerHTML = `
        <div class="alert-toast-header">
            <span class="alert-toast-icon">🔔</span>
            <span class="alert-toast-sym">${ticker}/USDT</span>
            <button class="alert-toast-close">&times;</button>
        </div>
        <div class="alert-toast-body">
            <div class="alert-toast-dir" style="color:${direction.includes('Above') ? '#22c55e' : '#ef4444'}">${direction}</div>
            <div class="alert-toast-price">Level: <b>$${alertPrice.toFixed(prec)}</b></div>
            <div class="alert-toast-current">Price: <b>$${currentPrice.toFixed(prec)}</b></div>
        </div>
    `;

    // Click toast → open modal
    toast.addEventListener('click', (e) => {
        if (e.target.closest('.alert-toast-close')) {
            toast.remove();
            return;
        }
        toast.remove();
        openCoinModal(sym);
    });

    // Close button
    toast.querySelector('.alert-toast-close').addEventListener('click', (e) => {
        e.stopPropagation();
        toast.remove();
    });

    document.body.appendChild(toast);

    // Auto-remove after 10s
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 10000);

    // Also try browser Notification API
    if (Notification.permission === 'granted') {
        try {
            new Notification(`${ticker}/USDT — ${direction}`, {
                body: `Level: $${alertPrice.toFixed(prec)} | Price: $${currentPrice.toFixed(prec)}`,
                icon: '🔔',
                tag: `alert-${sym}-${alertPrice}`,
            });
        } catch(e) {}
    }
}

// Fibonacci levels config (customizable, persisted in localStorage)
// Format: [{level: 0, color: '#4caf50'}, ...] — each level has its own color
const FIB_DEFAULT_COLORS = ['#787b86', '#f44336', '#ff9800', '#4caf50', '#2196f3', '#9c27b0', '#787b86', '#e91e63', '#00bcd4', '#8bc34a'];
const FIB_DEFAULTS_OBJ = [
    { level: 0, color: '#4caf50' },
    { level: 0.236, color: '#2196f3' },
    { level: 0.382, color: '#ff9800' },
    { level: 0.5, color: '#f59e0b' },
    { level: 0.618, color: '#ff9800' },
    { level: 0.786, color: '#2196f3' },
    { level: 1, color: '#4caf50' },
];
const fibConfig = (() => {
    const KEY = 'mc_fib_levels';
    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(KEY));
            if (Array.isArray(saved) && saved.length > 0) {
                // Migration: old format was plain numbers → convert to {level, color}
                if (typeof saved[0] === 'number') {
                    return saved.map((lvl, i) => ({ level: lvl, color: FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length] }));
                }
                return saved;
            }
        } catch(e) {}
        return FIB_DEFAULTS_OBJ.map(o => ({ ...o }));
    }
    function save(levels) {
        localStorage.setItem(KEY, JSON.stringify(levels));
    }
    // Helper: extract plain level numbers from config
    function levels(cfg) { return (cfg || load()).map(o => typeof o === 'number' ? o : o.level); }
    function colorAt(cfg, i) { const c = cfg || load(); const item = c[i]; return (item && item.color) || FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length]; }
    return { load, save, levels, colorAt };
})();

let drawMagnet = localStorage.getItem('fs_magnet') !== 'false'; // default ON

const draw = {
    activeTool: 'cursor',
    clickCount: 0,
    startPrice: 0,
    startTime: 0,
    tempLine: null,
    drawings: [],    // { id, type, color, locked, priceLine/lineSeries/fibLines, data }
    overlay: null,   // canvas overlay for live preview
    selected: null,  // selected drawing id
    dragging: false, // drag in progress
    justDragged: false, // suppress click after drag
    dragStartY: 0,
    dragStartPrice: 0,
};

// Drawing Context — points to the active chart for drawing tools
// All drawing functions use drawCtx instead of hardcoded modal.*
// Switched when user activates a multi-chart slot or opens modal
const drawCtx = {
    chart: null,     // LightweightCharts instance
    series: null,    // main candle series
    candleData: null,// array of OHLCV
    chartEl: null,   // DOM element containing the chart
    sym: null,       // current symbol
    tf: null,        // current timeframe
    source: 'modal', // 'modal' | 'slot:0' | 'slot:1' etc
};

function setDrawCtx(source, chart, series, candleData, chartEl, sym, tf) {
    drawCtx.chart = chart;
    drawCtx.series = series;
    drawCtx.candleData = candleData;
    drawCtx.chartEl = chartEl;
    drawCtx.sym = sym;
    drawCtx.tf = tf;
    drawCtx.source = source;
}

function setDrawCtxModal() {
    setDrawCtx('modal', modal.chart, modal.series, modal.candleData, el('cmChartBody'), modal.currentSym, modal.currentTF);
}

function setDrawCtxSlot(slotIndex) {
    const slot = mch.slots[slotIndex];
    if (!slot || !slot.chart) return;
    const chartEl = el('mch-chart-' + slotIndex);
    setDrawCtx('slot:' + slotIndex, slot.chart, slot.series, slot.candleData || null, chartEl, slot.sym, slot.tf);
}

function setDrawCtxMini(sym) {
    const c = mc.charts[sym];
    if (!c || !c.chart) return;
    const chartEl = el('mc-body-' + sym);
    setDrawCtx('mini:' + sym, c.chart, c.series, c.candleData || null, chartEl, sym, mc.globalTF);
}

function renderDrawToolbar(targetEl) {
    const chartEl = targetEl || drawCtx.chartEl || el('cmChartBody');
    if (!chartEl) return;

    // Remove old toolbar if exists
    const old = chartEl.querySelector('.dt-tools');
    if (old) old.remove();

    const container = document.createElement('div');
    container.className = 'dt-tools';
    container.innerHTML = DRAW_TOOLS.map(t => {
        const active = draw.activeTool === t.id ? ' dt-active' : '';
        return `<button class="dt-btn${active}" data-tool="${t.id}" title="${t.title}">${t.icon}</button>`;
    }).join('') + `<div class="dt-divider"></div><button class="dt-btn dt-magnet${drawMagnet ? ' dt-active' : ''}" data-tool="magnet" title="Magnet (snap to OHLC)"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 2v5a4 4 0 008 0V2" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="3.5" y="1" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1" fill="currentColor" fill-opacity="0.2"/><rect x="11.5" y="1" width="3" height="3" rx="0.5" stroke="currentColor" stroke-width="1" fill="currentColor" fill-opacity="0.2"/><line x1="7" y1="10" x2="7" y2="12" stroke="currentColor" stroke-width="0.8" opacity="0.5"/><line x1="9" y1="11" x2="9" y2="14" stroke="currentColor" stroke-width="0.8" opacity="0.5"/><line x1="11" y1="10" x2="11" y2="12" stroke="currentColor" stroke-width="0.8" opacity="0.5"/></svg></button>`;

    chartEl.appendChild(container);

    // Magnet toggle
    const magnetBtn = container.querySelector('.dt-magnet');
    if (magnetBtn) {
        magnetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            drawMagnet = !drawMagnet;
            localStorage.setItem('fs_magnet', drawMagnet);
            magnetBtn.classList.toggle('dt-active', drawMagnet);
        });
    }

    container.querySelectorAll('.dt-btn:not(.dt-magnet)').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tool = btn.dataset.tool;
            if (tool === 'trash') {
                if (typeof DM !== 'undefined' && DM && DM.isActive()) DM.clearAll();
                clearAllDrawings();
                return;
            }
            draw.activeTool = tool;
            draw.clickCount = 0;
            removePreviewOverlay();
            if (tool !== 'ruler') removeRulerMeasurement();
            // Activate library drawing tool if available
            if (typeof DM !== 'undefined' && DM && DM.isActive() && DM.TOOL_MAP[tool] !== undefined) {
                DM.setTool(tool);
            }
            renderDrawToolbar();
            updateModalCursor();
        });
    });
}

function updateModalCursor() {
    const chartEl = drawCtx.chartEl || el('cmChartBody');
    if (!chartEl) return;
    const chart = drawCtx.chart || modal.chart;
    if (draw.activeTool === 'cursor') {
        chartEl.style.cursor = '';
        if (chart) {
            chart.applyOptions({
                handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
                handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
            });
        }
    } else {
        chartEl.style.cursor = 'crosshair';
        if (chart) {
            chart.applyOptions({
                handleScroll: false,
                handleScale: false,
            });
        }
    }
}

// Keyboard shortcuts for tools
document.addEventListener('keydown', (e) => {
    if (!drawCtx.chart && !modal.chart) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const tool = DRAW_TOOLS.find(t => t.key && t.key.toLowerCase() === e.key.toLowerCase());
    if (tool) {
        if (tool.id === 'Escape') {
            draw.activeTool = 'cursor';
        } else {
            draw.activeTool = tool.id;
        }
        draw.clickCount = 0;
        removePreviewOverlay();
        // Sync library tool
        if (typeof DM !== 'undefined' && DM && DM.isActive() && DM.TOOL_MAP[draw.activeTool] !== undefined) {
            DM.setTool(draw.activeTool);
        }
        renderDrawToolbar();
        updateModalCursor();
    }
    if (e.key === 'Delete' && (drawCtx.chart || modal.chart)) {
        if (typeof DM !== 'undefined' && DM && DM.isActive()) DM.deleteSelected();
        if (draw.selected !== null) {
            deleteDrawing(draw.selected);
        } else {
            clearAllDrawings();
        }
    }
});

function clearAllDrawings() {
    draw.drawings.forEach(d => removeDrawingFromChart(d));
    draw.drawings = [];
    draw.clickCount = 0;
    draw.selected = null;
    hideDrawingPanel();
    removePreviewOverlay();
    removeRulerMeasurement();
    persistDrawings();
}

function deleteDrawing(id) {
    const idx = draw.drawings.findIndex(d => d.id === id);
    if (idx === -1) return;
    const d = draw.drawings[idx];
    removeDrawingFromChart(d);
    draw.drawings.splice(idx, 1);
    if (draw.selected === id) {
        draw.selected = null;
        hideDrawingPanel();
    }
    persistDrawings();
}

function removeDrawingFromChart(d) {
    const _s = drawCtx.series || modal.series;
    const _c = drawCtx.chart || modal.chart;
    if (d.priceLine && _s) {
        try { _s.removePriceLine(d.priceLine); } catch(e) {}
    }
    if (d.lineSeries && _c) {
        try { _c.removeSeries(d.lineSeries); } catch(e) {}
    }
    if (d.fibLines && _s) {
        d.fibLines.forEach(fl => {
            try { _s.removePriceLine(fl); } catch(e) {}
        });
    }
    if (d.rectLines && _c) {
        d.rectLines.forEach(ls => {
            try { _c.removeSeries(ls); } catch(e) {}
        });
    }
    if (d.fillSeries && _c) {
        try { _c.removeSeries(d.fillSeries); } catch(e) {}
    }
    if (d.bottomPriceLine && _s) {
        try { _s.removePriceLine(d.bottomPriceLine); } catch(e) {}
    }
}

function selectDrawing(id) {
    draw.selected = id;
    const d = draw.drawings.find(dd => dd.id === id);
    if (!d) return;
    showDrawingPanel(d);
}

function deselectDrawing() {
    draw.selected = null;
    hideDrawingPanel();
}

function showDrawingPanel(d) {
    hideDrawingPanel();
    const chartEl = drawCtx.chartEl || el('cmChartBody');
    if (!chartEl) return;

    const panel = document.createElement('div');
    panel.id = 'drawPanel';
    panel.className = 'draw-panel';

    // Stop ALL events on the panel from reaching chart handlers
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('mouseup', (e) => e.stopPropagation());
    panel.addEventListener('touchstart', (e) => e.stopPropagation());
    panel.addEventListener('touchend', (e) => e.stopPropagation());

    // Color dots
    const colorsHtml = DRAW_COLORS.map(c => {
        const sel = c === d.color ? ' draw-color-active' : '';
        return `<div class="draw-color-dot${sel}" data-color="${c}" style="background:${c};"></div>`;
    }).join('');

    const lockIcon = d.locked ? '🔒' : '🔓';
    const fibBtn = d.type === 'fib' ? `<button class="draw-panel-btn" data-action="fib-settings" title="Fib Levels">&#9881;</button>` : '';
    const alertBtn = (d.type === 'hline' || d.type === 'ray')
        ? `<button class="draw-panel-btn${d.alert ? ' draw-alert-active' : ''}" data-action="alert" title="${d.alert ? 'Disable Alert' : 'Enable Alert'}">🔔</button>`
        : '';
    panel.innerHTML = `
        <div class="draw-panel-colors">${colorsHtml}</div>
        ${alertBtn}
        ${fibBtn}
        <button class="draw-panel-btn" data-action="lock" title="${d.locked ? 'Unlock' : 'Lock'}">${lockIcon}</button>
        <button class="draw-panel-btn draw-panel-delete" data-action="delete" title="Delete">&#10005;</button>
    `;

    chartEl.appendChild(panel);

    // Color click
    panel.querySelectorAll('.draw-color-dot').forEach(dot => {
        dot.addEventListener('click', () => changeDrawingColor(d.id, dot.dataset.color));
    });

    // Lock
    panel.querySelector('[data-action="lock"]').addEventListener('click', () => {
        d.locked = !d.locked;
        persistDrawings();
        showDrawingPanel(d);
    });

    // Delete
    panel.querySelector('[data-action="delete"]').addEventListener('click', () => deleteDrawing(d.id));

    // Alert toggle
    const alertToggle = panel.querySelector('[data-action="alert"]');
    if (alertToggle) {
        alertToggle.addEventListener('click', () => {
            d.alert = !d.alert;
            persistDrawings();
            showDrawingPanel(d); // refresh
            // Request browser notification permission
            if (d.alert && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        });
    }

    // Fib settings
    const fibSettingsBtn = panel.querySelector('[data-action="fib-settings"]');
    if (fibSettingsBtn) {
        fibSettingsBtn.addEventListener('click', () => showFibLevelsPopup(d));
    }
}

function showFibColorPicker(dotEl) {
    // Remove old picker if exists
    const oldPicker = document.getElementById('fibColorPicker');
    if (oldPicker) oldPicker.remove();

    const colors = ['#4caf50', '#2196f3', '#ff9800', '#f59e0b', '#f44336', '#9c27b0', '#e91e63', '#00bcd4', '#8bc34a', '#787b86', '#ffffff', '#5b9cf6'];
    const picker = document.createElement('div');
    picker.id = 'fibColorPicker';
    picker.className = 'fib-color-picker';

    // Position relative to dot
    const dotRect = dotEl.getBoundingClientRect();
    const popupEl = dotEl.closest('.fib-levels-popup');
    const popupRect = popupEl.getBoundingClientRect();
    picker.style.top = (dotRect.top - popupRect.top + dotRect.height + 4) + 'px';
    picker.style.left = (dotRect.left - popupRect.left) + 'px';

    picker.innerHTML = colors.map(c =>
        `<span class="fib-color-opt${c === dotEl.dataset.color ? ' active' : ''}" data-c="${c}" style="background:${c}"></span>`
    ).join('');

    picker.addEventListener('click', (e) => {
        e.stopPropagation();
        const opt = e.target.closest('.fib-color-opt');
        if (!opt) return;
        const newColor = opt.dataset.c;
        dotEl.style.background = newColor;
        dotEl.dataset.color = newColor;
        picker.remove();
    });
    picker.addEventListener('mousedown', (e) => e.stopPropagation());

    popupEl.appendChild(picker);

    // Close on outside click
    const closeHandler = (ev) => {
        if (!picker.contains(ev.target) && ev.target !== dotEl) {
            picker.remove();
            document.removeEventListener('click', closeHandler, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}

function showFibLevelsPopup(d) {
    // Remove old popup if exists
    const oldPopup = document.getElementById('fibLevelsPopup');
    if (oldPopup) oldPopup.remove();

    const chartEl = el('cmChartBody');
    if (!chartEl) return;

    const rawLevels = d.data.levels || fibConfig.load();
    // Normalize: support both old format (number[]) and new ({level,color}[])
    const levels = rawLevels.map((item, i) => {
        if (typeof item === 'number') return { level: item, color: FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length] };
        return { level: item.level, color: item.color || FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length] };
    });

    const popup = document.createElement('div');
    popup.id = 'fibLevelsPopup';
    popup.className = 'fib-levels-popup';
    popup.innerHTML = `
        <div class="fib-popup-title">Fibonacci Levels</div>
        <div class="fib-popup-list" id="fibLevelsList">
            ${levels.map((item, i) => `
                <div class="fib-level-row" data-idx="${i}">
                    <span class="fib-level-color" style="background:${item.color}" data-color="${item.color}" title="Change color"></span>
                    <input type="number" class="fib-level-input" value="${(item.level * 100).toFixed(1)}" step="0.1" />
                    <span class="fib-level-pct">%</span>
                    <button class="fib-level-remove" title="Remove">×</button>
                </div>
            `).join('')}
        </div>
        <div class="fib-popup-actions">
            <button class="fib-popup-btn fib-add-btn" id="fibAddLevel">+ Add</button>
            <button class="fib-popup-btn fib-reset-btn" id="fibResetLevels">Reset</button>
            <button class="fib-popup-btn fib-apply-btn" id="fibApplyLevels">Apply</button>
        </div>
    `;
    // Block all events from reaching chart handlers
    popup.addEventListener('click', (e) => e.stopPropagation());
    popup.addEventListener('mousedown', (e) => e.stopPropagation());
    popup.addEventListener('mouseup', (e) => e.stopPropagation());
    popup.addEventListener('touchstart', (e) => e.stopPropagation());
    popup.addEventListener('touchend', (e) => e.stopPropagation());

    chartEl.appendChild(popup);

    // Add level
    popup.querySelector('#fibAddLevel').addEventListener('click', (e) => {
        e.stopPropagation();
        const list = popup.querySelector('#fibLevelsList');
        const idx = list.children.length;
        const defColor = FIB_DEFAULT_COLORS[idx % FIB_DEFAULT_COLORS.length];
        const row = document.createElement('div');
        row.className = 'fib-level-row';
        row.dataset.idx = idx;
        row.innerHTML = `
            <span class="fib-level-color" style="background:${defColor}" data-color="${defColor}" title="Change color"></span>
            <input type="number" class="fib-level-input" value="50.0" step="0.1" />
            <span class="fib-level-pct">%</span>
            <button class="fib-level-remove" title="Remove">×</button>
        `;
        list.appendChild(row);
        row.querySelector('.fib-level-remove').addEventListener('click', (ev) => {
            ev.stopPropagation();
            row.remove();
        });
        row.querySelector('.fib-level-color').addEventListener('click', (ev) => {
            ev.stopPropagation();
            showFibColorPicker(ev.target);
        });
    });

    // Remove level buttons
    popup.querySelectorAll('.fib-level-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.closest('.fib-level-row').remove();
        });
    });

    // Color picker on each dot
    popup.querySelectorAll('.fib-level-color').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            showFibColorPicker(dot);
        });
    });

    // Reset
    popup.querySelector('#fibResetLevels').addEventListener('click', (e) => {
        e.stopPropagation();
        const list = popup.querySelector('#fibLevelsList');
        list.innerHTML = FIB_DEFAULTS_OBJ.map((item, i) => `
            <div class="fib-level-row" data-idx="${i}">
                <span class="fib-level-color" style="background:${item.color}" data-color="${item.color}" title="Change color"></span>
                <input type="number" class="fib-level-input" value="${(item.level * 100).toFixed(1)}" step="0.1" />
                <span class="fib-level-pct">%</span>
                <button class="fib-level-remove" title="Remove">×</button>
            </div>
        `).join('');
        list.querySelectorAll('.fib-level-remove').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                btn.closest('.fib-level-row').remove();
            });
        });
        list.querySelectorAll('.fib-level-color').forEach(dot => {
            dot.addEventListener('click', (ev) => {
                ev.stopPropagation();
                showFibColorPicker(dot);
            });
        });
    });

    // Apply
    popup.querySelector('#fibApplyLevels').addEventListener('click', (e) => {
        e.stopPropagation();
        const rows = popup.querySelectorAll('.fib-level-row');
        const newLevels = [];
        rows.forEach(row => {
            const inp = row.querySelector('.fib-level-input');
            const colorDot = row.querySelector('.fib-level-color');
            const val = parseFloat(inp.value);
            if (!isNaN(val)) {
                newLevels.push({
                    level: val / 100,
                    color: colorDot ? colorDot.dataset.color : FIB_DEFAULT_COLORS[newLevels.length % FIB_DEFAULT_COLORS.length]
                });
            }
        });
        newLevels.sort((a, b) => a.level - b.level);

        // Save globally
        fibConfig.save(newLevels);

        // Update this drawing
        const _s2 = drawCtx.series || modal.series;
        if (d.fibLines && _s2) {
            d.fibLines.forEach(fl => {
                try { _s2.removePriceLine(fl); } catch(ex) {}
            });
        }
        d.data.levels = newLevels;
        const diff = d.data.p2 - d.data.p1;
        d.fibLines = newLevels.map((item, i) => {
            const price = d.data.p1 + diff * item.level;
            return _s2.createPriceLine({
                price,
                color: item.color,
                lineWidth: 1.5,
                lineStyle: 0,
                axisLabelVisible: true,
                title: `${(item.level * 100).toFixed(1)}%`,
            });
        });
        persistDrawings();
        popup.remove();
    });

}

function hideDrawingPanel() {
    const p = document.getElementById('drawPanel');
    if (p) p.remove();
    const fp = document.getElementById('fibLevelsPopup');
    if (fp) fp.remove();
}

function changeDrawingColor(id, color) {
    const d = draw.drawings.find(dd => dd.id === id);
    if (!d) return;
    d.color = color;
    const _s = drawCtx.series || modal.series;
    const _c = drawCtx.chart || modal.chart;

    // Recreate with new color
    if (d.type === 'hline' && d.priceLine && _s) {
        const price = d.data.price;
        try { _s.removePriceLine(d.priceLine); } catch(e) {}
        d.priceLine = _s.createPriceLine({
            price, color, lineWidth: 2, lineStyle: 0,
            axisLabelVisible: true, title: '',
        });
    } else if ((d.type === 'ray' || d.type === 'trendline') && d.lineSeries) {
        d.lineSeries.applyOptions({ color });
    } else if (d.type === 'fib' && d.fibLines && _s) {
        d.fibLines.forEach(fl => {
            try { _s.removePriceLine(fl); } catch(e) {}
        });
        const rawLevels = d.data.levels || fibConfig.load();
        const diff = d.data.p2 - d.data.p1;
        d.fibLines = rawLevels.map((item, i) => {
            const lvl = typeof item === 'number' ? item : item.level;
            const price = d.data.p1 + diff * lvl;
            return _s.createPriceLine({
                price, color, lineWidth: 1, lineStyle: 0,
                axisLabelVisible: true, title: `${(lvl * 100).toFixed(1)}%`,
            });
        });
        if (Array.isArray(d.data.levels)) {
            d.data.levels = d.data.levels.map(item => {
                if (typeof item === 'number') return { level: item, color };
                return { ...item, color };
            });
        }
    } else if (d.type === 'rect' && d.rectLines && _c) {
        d.rectLines.forEach(ls => ls.applyOptions({ color }));
        if (d.fillSeries) {
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            d.fillSeries.applyOptions({
                topColor: `rgba(${r}, ${g}, ${b}, 0.08)`,
                lineColor: 'transparent',
            });
        }
    }
    persistDrawings();
    showDrawingPanel(d); // refresh panel
}

// Find drawing near a price (for click-to-select)
function findDrawingNearPrice(price) {
    if (!(drawCtx.series || modal.series)) return null;
    const threshold = Math.abs(price) * 0.005; // 0.5% tolerance

    for (const d of draw.drawings) {
        if (d.type === 'hline' && d.data) {
            if (Math.abs(d.data.price - price) < threshold) return d;
        }
        if (d.type === 'ray' && d.data) {
            if (Math.abs(d.data.price - price) < threshold) return d;
        }
        if (d.type === 'fib' && d.data) {
            const diff = d.data.p2 - d.data.p1;
            const rawLevels = d.data.levels || fibConfig.load();
            for (const item of rawLevels) {
                const lvl = typeof item === 'number' ? item : item.level;
                const fibPrice = d.data.p1 + diff * lvl;
                if (Math.abs(fibPrice - price) < threshold) return d;
            }
        }
        if (d.type === 'rect' && d.data) {
            // Select if price is near top or bottom border
            if (Math.abs(d.data.p1 - price) < threshold || Math.abs(d.data.p2 - price) < threshold) return d;
            // Or if price is inside the rectangle
            if (price >= Math.min(d.data.p1, d.data.p2) && price <= Math.max(d.data.p1, d.data.p2)) return d;
        }
    }
    return null;
}

// Save current drawings to localStorage
function persistDrawings() {
    const sym = drawCtx.sym || modal.currentSym;
    if (sym) {
        drawStore.save(sym, draw.drawings);
    }
}

// Restore drawings from localStorage for current symbol
function restoreDrawings() {
    const _sym = drawCtx.sym || modal.currentSym;
    const _s = drawCtx.series || modal.series;
    const _c = drawCtx.chart || modal.chart;
    if (!_sym || !_s || !_c) return;
    const saved = drawStore.load(_sym);
    saved.forEach(s => {
        if (s.type === 'hline') {
            drawHorizontalLine(s.data.price, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'ray') {
            drawHorizontalRay(s.data.price, s.data.startTime, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'trendline') {
            drawTwoPointLine(s.type, s.data.t1, s.data.p1, s.data.t2, s.data.p2, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'fib') {
            drawFibonacci(s.data.p1, s.data.p2, null, s.data.levels);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'rect') {
            drawRectangle(s.data.t1, s.data.p1, s.data.t2, s.data.p2, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        }
    });
}

function removePreviewOverlay() {
    if (draw.overlay) {
        draw.overlay.remove();
        draw.overlay = null;
    }
}

function getPreviewCanvas() {
    if (draw.overlay) return draw.overlay;
    const chartEl = drawCtx.chartEl || el('cmChartBody');
    if (!chartEl) return null;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;';
    canvas.width = chartEl.clientWidth;
    canvas.height = chartEl.clientHeight;
    chartEl.appendChild(canvas);
    draw.overlay = canvas;
    return canvas;
}

// ============================================
// Drawing — click handlers (works on any chart via drawCtx)
// ============================================
function setupDrawingHandlers(targetEl) {
    const chartEl = targetEl || el('cmChartBody');
    if (!chartEl) return;

    // Remove old listeners by replacing element reference approach — use data attribute
    if (chartEl.dataset.drawInit) return;
    chartEl.dataset.drawInit = '1';

    // Getter helpers — always resolve to active drawCtx (or modal fallback)
    const DC = () => drawCtx.chart || modal.chart;
    const DS = () => drawCtx.series || modal.series;
    const DD = () => drawCtx.candleData || modal.candleData;
    const DTF = () => drawCtx.tf || modal.currentTF;

    // Snap price to nearest OHLC of closest candle (magnet mode)
    function snapToCandle(time, price) {
        const data = DD();
        if (!data || data.length === 0) return { time, price };

        // Binary search for closest candle by time
        let lo = 0, hi = data.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (data[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        // Check neighbors for closest (up to 2 in each direction)
        let bestIdx = lo;
        let bestDist = Math.abs(data[lo].time - time);
        for (let i = Math.max(0, lo - 2); i <= Math.min(data.length - 1, lo + 2); i++) {
            const d = Math.abs(data[i].time - time);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }

        const c = data[bestIdx];
        const ohlc = [c.open, c.high, c.low, c.close];
        // Find nearest OHLC value to cursor price
        let nearestVal = ohlc[0];
        let nearestDist = Math.abs(ohlc[0] - price);
        for (const v of ohlc) {
            const d = Math.abs(v - price);
            if (d < nearestDist) { nearestDist = d; nearestVal = v; }
        }
        // Snap threshold: within 40% of candle range (tight but usable)
        const range = c.high - c.low || Math.abs(c.close) * 0.005;
        if (nearestDist > range * 0.4) return { time: c.time, price };
        return { time: c.time, price: nearestVal };
    }

    // Unified handler for both click and touch
    function handleDrawClick(clientX, clientY) {
        const _c = drawCtx.chart || modal.chart;
        const _s = drawCtx.series || modal.series;
        if (!_c || !_s) return;
        if (draw.activeTool === 'cursor') return;

        const rect = chartEl.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        let price = _s.coordinateToPrice(y);
        let time = _c.timeScale().coordinateToTime(x);
        if (price === null || time === null) return;

        // Magnet snap to nearest OHLC
        if (drawMagnet) {
            const snapped = snapToCandle(time, price);
            price = snapped.price;
            time = snapped.time;
        }

        if (draw.activeTool === 'hline') {
            drawHorizontalLine(price);
            draw.activeTool = 'cursor';
            renderDrawToolbar();
            updateModalCursor();
        } else if (draw.activeTool === 'ray') {
            drawHorizontalRay(price, time);
            draw.activeTool = 'cursor';
            renderDrawToolbar();
            updateModalCursor();
        } else if (draw.activeTool === 'trendline') {
            if (draw.clickCount === 0) {
                draw.startPrice = price;
                draw.startTime = time;
                draw.clickCount = 1;
            } else {
                drawTwoPointLine(draw.activeTool, draw.startTime, draw.startPrice, time, price);
                draw.clickCount = 0;
                removePreviewOverlay();
                draw.activeTool = 'cursor';
                renderDrawToolbar();
                updateModalCursor();
            }
        } else if (draw.activeTool === 'fib') {
            if (draw.clickCount === 0) {
                draw.startPrice = price;
                draw.startTime = time;
                draw.clickCount = 1;
            } else {
                drawFibonacci(draw.startPrice, price);
                draw.clickCount = 0;
                removePreviewOverlay();
                draw.activeTool = 'cursor';
                renderDrawToolbar();
                updateModalCursor();
            }
        } else if (draw.activeTool === 'rect') {
            if (draw.clickCount === 0) {
                draw.startPrice = price;
                draw.startTime = time;
                draw.clickCount = 1;
            } else {
                drawRectangle(draw.startTime, draw.startPrice, time, price);
                draw.clickCount = 0;
                removePreviewOverlay();
                draw.activeTool = 'cursor';
                renderDrawToolbar();
                updateModalCursor();
            }
        } else if (draw.activeTool === 'ruler') {
            if (draw.clickCount === 0) {
                draw.startPrice = price;
                draw.startTime = time;
                draw.clickCount = 1;
                // Remove old ruler measurement if exists
                removeRulerMeasurement();
            } else {
                showRulerMeasurement(draw.startTime, draw.startPrice, time, price);
                draw.clickCount = 0;
                removePreviewOverlay();
                draw.activeTool = 'cursor';
                renderDrawToolbar();
                updateModalCursor();
            }
        }
    }

    // Clear ruler on any click/tap in cursor mode
    chartEl.addEventListener('mousedown', () => {
        if (draw.activeTool === 'cursor' && rulerOverlay) removeRulerMeasurement();
    }, true);
    chartEl.addEventListener('touchstart', () => {
        if (draw.activeTool === 'cursor' && rulerOverlay) removeRulerMeasurement();
    }, { capture: true, passive: true });

    // Desktop click
    chartEl.addEventListener('click', (e) => {
        // Suppress click right after drag ended
        if (draw.justDragged) {
            draw.justDragged = false;
            return;
        }
        if (draw.activeTool === 'cursor') {
            // Shift+click starts ruler (like TradingView)
            const _sc = drawCtx.series || modal.series;
            const _cc = drawCtx.chart || modal.chart;
            if (e.shiftKey && _sc && _cc) {
                const rect = chartEl.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                let price = _sc.coordinateToPrice(y);
                let time = _cc.timeScale().coordinateToTime(x);
                if (price !== null && time !== null) {
                    if (drawMagnet) { const snapped = snapToCandle(time, price); price = snapped.price; time = snapped.time; }
                    removeRulerMeasurement();
                    draw.activeTool = 'ruler';
                    draw.startPrice = price;
                    draw.startTime = time;
                    draw.clickCount = 1;
                    renderDrawToolbar();
                    updateModalCursor();
                }
                return;
            }
            // Select/deselect drawing
            const rect2 = chartEl.getBoundingClientRect();
            const y2 = e.clientY - rect2.top;
            const price2 = _sc ? _sc.coordinateToPrice(y2) : null;
            if (price2 !== null) {
                const found = findDrawingNearPrice(price2);
                if (found) {
                    selectDrawing(found.id);
                } else {
                    deselectDrawing();
                }
            }
            return;
        }
        handleDrawClick(e.clientX, e.clientY);
    });

    // Mobile touch — use touchend so we get final position
    chartEl.addEventListener('touchend', (e) => {
        if (draw.dragging) {
            draw.dragging = false;
            draw.justDragged = true;
            persistDrawings();
            updateModalCursor();
            return;
        }
        if (draw.activeTool === 'cursor') {
            // Select drawing on tap
            const touch = e.changedTouches[0];
            if (!touch) return;
            const tRect = chartEl.getBoundingClientRect();
            const tY = touch.clientY - tRect.top;
            const tPrice = (drawCtx.series || modal.series)?.coordinateToPrice(tY) ?? null;
            if (tPrice !== null) {
                const found = findDrawingNearPrice(tPrice);
                if (found) {
                    selectDrawing(found.id);
                } else {
                    deselectDrawing();
                }
            }
            return;
        }
        e.preventDefault();
        const touch = e.changedTouches[0];
        if (!touch) return;
        handleDrawClick(touch.clientX, touch.clientY);
    }, { passive: false });

    // Drag support for hline and ray — mousedown
    chartEl.addEventListener('mousedown', (e) => {
        if (draw.activeTool !== 'cursor' || draw.selected === null) return;
        const d = draw.drawings.find(dd => dd.id === draw.selected);
        if (!d || d.locked || (d.type !== 'hline' && d.type !== 'ray')) return;

        const rect = chartEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const price = DS() ? DS().coordinateToPrice(y) : null;
        if (price === null) return;
        const dragPrice = d.data.price;
        const threshold = Math.abs(dragPrice) * 0.005;
        if (Math.abs(price - dragPrice) > threshold) return;

        e.preventDefault();
        draw.dragging = true;
        draw.dragStartY = e.clientY;
        draw.dragStartPrice = dragPrice;
        if (DC()) DC().applyOptions({ handleScroll: false, handleScale: false });
    });

    // Drag — mousemove
    chartEl.addEventListener('mousemove', (e) => {
        if (draw.dragging && draw.selected !== null) {
            const d = draw.drawings.find(dd => dd.id === draw.selected);
            if (!d || (d.type !== 'hline' && d.type !== 'ray')) return;
            const rect = chartEl.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const newPrice = DS() ? DS().coordinateToPrice(y) : null;
            if (newPrice === null) return;

            if (d.type === 'hline') {
                try { DS().removePriceLine(d.priceLine); } catch(ex) {}
                d.priceLine = DS().createPriceLine({
                    price: newPrice, color: d.color, lineWidth: 2, lineStyle: 0,
                    axisLabelVisible: true, title: '',
                });
                d.data.price = newPrice;
            } else if (d.type === 'ray') {
                if (d.lineSeries) {
                    try { DC().removeSeries(d.lineSeries); } catch(ex) {}
                }
                const startTime = d.data.startTime;
                const farTime = startTime + 365 * 24 * 3600;
                const ls = DC().addSeries(LightweightCharts.LineSeries, {
                    color: d.color, lineWidth: 2,
                    crosshairMarkerVisible: false, lastValueVisible: false,
                    priceLineVisible: false, pointMarkersVisible: false,
                });
                ls.setData([
                    { time: startTime, value: newPrice },
                    { time: farTime, value: newPrice },
                ]);
                d.lineSeries = ls;
                d.data.price = newPrice;
            }
        }
    });

    // Drag — mouseup
    chartEl.addEventListener('mouseup', () => {
        if (draw.dragging) {
            draw.dragging = false;
            draw.justDragged = true;
            persistDrawings();
            updateModalCursor();
        }
    });

    // Touch drag for hline and ray
    chartEl.addEventListener('touchstart', (e) => {
        if (draw.activeTool !== 'cursor' || draw.selected === null) return;
        const d = draw.drawings.find(dd => dd.id === draw.selected);
        if (!d || d.locked || (d.type !== 'hline' && d.type !== 'ray')) return;

        const touch = e.touches[0];
        const rect = chartEl.getBoundingClientRect();
        const y = touch.clientY - rect.top;
        const price = DS() ? DS().coordinateToPrice(y) : null;
        if (price === null) return;
        const dragPrice = d.data.price;
        const threshold = Math.abs(dragPrice) * 0.008;
        if (Math.abs(price - dragPrice) > threshold) return;

        e.preventDefault();
        draw.dragging = true;
        if (DC()) DC().applyOptions({ handleScroll: false, handleScale: false });
    }, { passive: false });

    chartEl.addEventListener('touchmove', (e) => {
        if (draw.dragging && draw.selected !== null) {
            e.preventDefault();
            const d = draw.drawings.find(dd => dd.id === draw.selected);
            if (!d || (d.type !== 'hline' && d.type !== 'ray')) return;
            const touch = e.touches[0];
            const rect = chartEl.getBoundingClientRect();
            const y = touch.clientY - rect.top;
            const newPrice = DS() ? DS().coordinateToPrice(y) : null;
            if (newPrice === null) return;

            if (d.type === 'hline') {
                try { DS().removePriceLine(d.priceLine); } catch(ex) {}
                d.priceLine = DS().createPriceLine({
                    price: newPrice, color: d.color, lineWidth: 2, lineStyle: 0,
                    axisLabelVisible: true, title: '',
                });
                d.data.price = newPrice;
            } else if (d.type === 'ray') {
                if (d.lineSeries) try { DC().removeSeries(d.lineSeries); } catch(ex) {}
                const startTime = d.data.startTime;
                const farTime = startTime + 365 * 24 * 3600;
                const ls = DC().addSeries(LightweightCharts.LineSeries, {
                    color: d.color, lineWidth: 2,
                    crosshairMarkerVisible: false, lastValueVisible: false,
                    priceLineVisible: false, pointMarkersVisible: false,
                });
                ls.setData([
                    { time: startTime, value: newPrice },
                    { time: farTime, value: newPrice },
                ]);
                d.lineSeries = ls;
                d.data.price = newPrice;
            }
        }
    }, { passive: false });

    // Live preview for 2-click tools
    chartEl.addEventListener('mousemove', (e) => {
        if (!DC() || !DS()) return;
        if (draw.clickCount !== 1) return;
        if (draw.activeTool !== 'trendline' && draw.activeTool !== 'fib' && draw.activeTool !== 'rect' && draw.activeTool !== 'ruler') return;

        const rect = chartEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let y = e.clientY - rect.top;
        let price = DS().coordinateToPrice(y);
        if (price === null) return;

        // Snap to nearest candle OHLC (if magnet enabled)
        if (drawMagnet) {
            const curTime = DC().timeScale().coordinateToTime(x);
            if (curTime !== null) {
                const snapped = snapToCandle(curTime, price);
                price = snapped.price;
                const snapY = DS().priceToCoordinate(price);
                if (snapY !== null) y = snapY;
            }
        }

        const canvas = getPreviewCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = chartEl.clientWidth;
        canvas.height = chartEl.clientHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const startY2 = DS().priceToCoordinate(draw.startPrice);
        const startX2 = DC().timeScale().timeToCoordinate(draw.startTime);
        if (startY2 === null || startX2 === null) return;

        ctx.strokeStyle = '#5b9cf6';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);

        if (draw.activeTool === 'fib') {
            // Preview fib levels
            const fibCfg = fibConfig.load();
            const diff = price - draw.startPrice;
            fibCfg.forEach((item, i) => {
                const lvl = typeof item === 'number' ? item : item.level;
                const clr = (typeof item === 'object' && item.color) ? item.color : FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length];
                const fibPrice = draw.startPrice + diff * lvl;
                const fibY = DS().priceToCoordinate(fibPrice);
                if (fibY === null) return;
                ctx.strokeStyle = clr;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(0, fibY);
                ctx.lineTo(canvas.width, fibY);
                ctx.stroke();
                ctx.fillStyle = clr;
                ctx.font = '10px Inter, sans-serif';
                ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${fibPrice.toFixed(getPricePrecision(fibPrice))}`, 5, fibY - 3);
            });
        } else if (draw.activeTool === 'rect') {
            // Preview rectangle
            const w = x - startX2;
            const h = y - startY2;
            ctx.strokeStyle = '#5b9cf6';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(startX2, startY2, w, h);
            ctx.fillStyle = 'rgba(91, 156, 246, 0.08)';
            ctx.fillRect(startX2, startY2, w, h);
        } else if (draw.activeTool === 'ruler') {
            // Preview ruler measurement
            const curTime = DC().timeScale().coordinateToTime(x);
            const priceDiff = price - draw.startPrice;
            const pctDiff = draw.startPrice !== 0 ? (priceDiff / draw.startPrice * 100) : 0;
            const isUp = priceDiff >= 0;
            const color = isUp ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
            const colorFill = isUp ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';

            // Dashed lines (L-shape: vertical + horizontal)
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            // Vertical from start
            ctx.beginPath(); ctx.moveTo(startX2, startY2); ctx.lineTo(startX2, y); ctx.stroke();
            // Horizontal to end
            ctx.beginPath(); ctx.moveTo(startX2, y); ctx.lineTo(x, y); ctx.stroke();

            // Main diagonal line
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(startX2, startY2); ctx.lineTo(x, y); ctx.stroke();

            // Fill area
            ctx.fillStyle = colorFill;
            ctx.beginPath(); ctx.moveTo(startX2, startY2); ctx.lineTo(startX2, y); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();

            // Dots at start/end
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(startX2, startY2, 3, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();

            // Label
            const prec = getPricePrecision(Math.abs(draw.startPrice));
            const sign = isUp ? '+' : '';
            let timeStr = '';
            let barsStr = '';
            if (draw.startTime && curTime) {
                const timeDiffSec = Math.abs(curTime - draw.startTime);
                if (timeDiffSec < 60) timeStr = Math.round(timeDiffSec) + 's';
                else if (timeDiffSec < 3600) timeStr = Math.round(timeDiffSec / 60) + 'm';
                else if (timeDiffSec < 86400) timeStr = (timeDiffSec / 3600).toFixed(1) + 'h';
                else timeStr = (timeDiffSec / 86400).toFixed(1) + 'd';
                // Bars count based on modal TF
                const tfSec = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[DTF()] || 300;
                barsStr = Math.round(timeDiffSec / tfSec) + ' bars';
            }

            const labelText = `${sign}${priceDiff.toFixed(prec)}  (${sign}${pctDiff.toFixed(2)}%)`;
            const labelText2 = timeStr ? `${timeStr}  •  ${barsStr}` : '';

            // Background box
            const midX = (startX2 + x) / 2;
            const labelY = Math.min(startY2, y) - 12;
            ctx.font = '600 12px Inter, sans-serif';
            const w1 = ctx.measureText(labelText).width;
            ctx.font = '11px Inter, sans-serif';
            const w2 = labelText2 ? ctx.measureText(labelText2).width : 0;
            const boxW = Math.max(w1, w2) + 16;
            const boxH = labelText2 ? 38 : 22;
            const boxX = midX - boxW / 2;
            const boxY = Math.max(2, labelY - boxH);

            ctx.fillStyle = isUp ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)';
            ctx.beginPath();
            const r = 5;
            ctx.moveTo(boxX + r, boxY); ctx.lineTo(boxX + boxW - r, boxY);
            ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
            ctx.lineTo(boxX + boxW, boxY + boxH - r);
            ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
            ctx.lineTo(boxX + r, boxY + boxH);
            ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
            ctx.lineTo(boxX, boxY + r);
            ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
            ctx.fill();

            // Text
            ctx.fillStyle = '#fff';
            ctx.font = '600 12px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(labelText, midX, boxY + 15);
            if (labelText2) {
                ctx.font = '11px Inter, sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.fillText(labelText2, midX, boxY + 30);
            }
            ctx.textAlign = 'start';
        } else {
            // Preview trendline
            ctx.beginPath();
            ctx.moveTo(startX2, startY2);
            ctx.lineTo(x, y);
            ctx.stroke();
        }
    });
}

// ============================================
// Drawing implementations
// ============================================
function drawHorizontalLine(price, color) {
    const _s = drawCtx.series || modal.series;
    if (!_s) return;
    const c = color || '#5b9cf6';
    const priceLine = _s.createPriceLine({
        price: price,
        color: c,
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: '',
    });
    draw.drawings.push({ id: ++drawIdCounter, type: 'hline', color: c, locked: false, priceLine, data: { price } });
    persistDrawings();
}

function drawHorizontalRay(price, startTime, color) {
    const _c = drawCtx.chart || modal.chart;
    if (!_c) return;
    const c = color || '#5b9cf6';
    const farTime = startTime + 365 * 24 * 3600; // 1 year forward

    const lineSeries = _c.addSeries(LightweightCharts.LineSeries, {
        color: c, lineWidth: 2,
        crosshairMarkerVisible: false, lastValueVisible: false,
        priceLineVisible: false, pointMarkersVisible: false,
    });
    lineSeries.setData([
        { time: startTime, value: price },
        { time: farTime, value: price },
    ]);
    draw.drawings.push({
        id: ++drawIdCounter, type: 'ray', color: c, locked: false,
        lineSeries, data: { price, startTime }
    });
    persistDrawings();
}

function drawTwoPointLine(type, t1, p1, t2, p2, color) {
    const _c = drawCtx.chart || modal.chart;
    if (!_c) return;
    const c = color || '#5b9cf6';
    const points = [];

    points.push({ time: t1, value: p1 });
    points.push({ time: t2, value: p2 });

    const seen = new Set();
    const uniquePoints = points.filter(p => {
        if (seen.has(p.time)) return false;
        seen.add(p.time);
        return true;
    }).sort((a, b) => a.time - b.time);

    const lineSeries = _c.addSeries(LightweightCharts.LineSeries, {
        color: c,
        lineWidth: 2,
        lineStyle: type === 'ray' ? 0 : 0,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        pointMarkersVisible: false,
    });
    lineSeries.setData(uniquePoints);
    draw.drawings.push({ id: ++drawIdCounter, type, color: c, locked: false, lineSeries, data: { t1, p1, t2, p2 } });
    persistDrawings();
}

function drawRectangle(t1, p1, t2, p2, color) {
    const _c = drawCtx.chart || modal.chart;
    const _s = drawCtx.series || modal.series;
    if (!_c || !_s) return;
    const c = color || '#5b9cf6';

    const tMin = Math.min(t1, t2);
    const tMax = Math.max(t1, t2);
    const pMin = Math.min(p1, p2);
    const pMax = Math.max(p1, p2);

    const topLine = _c.addSeries(LightweightCharts.LineSeries, {
        color: c, lineWidth: 1.5, crosshairMarkerVisible: false,
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
    });
    topLine.setData([{ time: tMin, value: pMax }, { time: tMax, value: pMax }]);

    const bottomLine = _c.addSeries(LightweightCharts.LineSeries, {
        color: c, lineWidth: 1.5, crosshairMarkerVisible: false,
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
    });
    bottomLine.setData([{ time: tMin, value: pMin }, { time: tMax, value: pMin }]);

    const leftLine = _c.addSeries(LightweightCharts.LineSeries, {
        color: c, lineWidth: 1.5, crosshairMarkerVisible: false,
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
    });
    leftLine.setData([{ time: tMin, value: pMin }, { time: tMin + 1, value: pMax }]);

    const rightLine = _c.addSeries(LightweightCharts.LineSeries, {
        color: c, lineWidth: 1.5, crosshairMarkerVisible: false,
        lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
    });
    rightLine.setData([{ time: tMax, value: pMin }, { time: tMax + 1, value: pMax }]);

    // Fill area
    const hexToFill = (hex) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, 0.08)`;
    };
    const fillSeries = _c.addSeries(LightweightCharts.AreaSeries, {
        topColor: hexToFill(c),
        bottomColor: 'transparent',
        lineColor: 'transparent',
        lineWidth: 0,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
    });
    // Generate fill data points
    const fillPoints = [];
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
        const t = Math.round(tMin + (tMax - tMin) * i / steps);
        fillPoints.push({ time: t, value: pMax });
    }
    // Deduplicate times
    const seenTimes = new Set();
    const uniqueFill = fillPoints.filter(p => {
        if (seenTimes.has(p.time)) return false;
        seenTimes.add(p.time);
        return true;
    });
    fillSeries.setData(uniqueFill);

    // Bottom price line for visual boundary
    const bottomPriceLine = _s.createPriceLine({
        price: pMin, color: 'transparent', lineWidth: 0, lineStyle: 2,
        axisLabelVisible: false, title: '',
    });

    draw.drawings.push({
        id: ++drawIdCounter, type: 'rect', color: c, locked: false,
        rectLines: [topLine, bottomLine, leftLine, rightLine],
        fillSeries, bottomPriceLine,
        data: { t1: tMin, p1: pMin, t2: tMax, p2: pMax }
    });
    persistDrawings();
}

// ---- Ruler Measurement ----
let rulerOverlay = null;

function removeRulerMeasurement() {
    if (rulerOverlay) {
        if (rulerOverlay._unsub) rulerOverlay._unsub();
        rulerOverlay.remove();
        rulerOverlay = null;
    }
}

function showRulerMeasurement(t1, p1, t2, p2) {
    const _c = drawCtx.chart || modal.chart;
    const _s = drawCtx.series || modal.series;
    if (!_c || !_s) return;
    removeRulerMeasurement();

    const chartEl = drawCtx.chartEl || el('cmChartBody');
    if (!chartEl) return;

    // Create persistent overlay
    const overlay = document.createElement('canvas');
    overlay.className = 'ruler-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99;';
    chartEl.appendChild(overlay);
    rulerOverlay = overlay;

    function render() {
        if (!rulerOverlay || !_c || !_s) return;
        const w = chartEl.clientWidth;
        const h = chartEl.clientHeight;
        overlay.width = w;
        overlay.height = h;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, w, h);

        const sx = _c.timeScale().timeToCoordinate(t1);
        const sy = _s.priceToCoordinate(p1);
        const ex = _c.timeScale().timeToCoordinate(t2);
        const ey = _s.priceToCoordinate(p2);
        if (sx === null || sy === null || ex === null || ey === null) return;

        const priceDiff = p2 - p1;
        const pctDiff = p1 !== 0 ? (priceDiff / p1 * 100) : 0;
        const isUp = priceDiff >= 0;
        const color = isUp ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
        const colorFill = isUp ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';

        // Dashed L-shape
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, ey); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx, ey); ctx.lineTo(ex, ey); ctx.stroke();

        // Main line
        ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        // Fill triangle
        ctx.fillStyle = colorFill;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, ey); ctx.lineTo(ex, ey); ctx.closePath(); ctx.fill();

        // Dots
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();

        // Label
        const prec = getPricePrecision(Math.abs(p1));
        const sign = isUp ? '+' : '';
        const timeDiffSec = Math.abs(t2 - t1);
        let timeStr = '';
        if (timeDiffSec < 60) timeStr = Math.round(timeDiffSec) + 's';
        else if (timeDiffSec < 3600) timeStr = Math.round(timeDiffSec / 60) + 'm';
        else if (timeDiffSec < 86400) timeStr = (timeDiffSec / 3600).toFixed(1) + 'h';
        else timeStr = (timeDiffSec / 86400).toFixed(1) + 'd';
        const tfSec = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }[modal.currentTF] || 300;
        const bars = Math.round(timeDiffSec / tfSec);

        const line1 = `${sign}${priceDiff.toFixed(prec)}  (${sign}${pctDiff.toFixed(2)}%)`;
        const line2 = `${timeStr}  •  ${bars} bars`;

        const midX = (sx + ex) / 2;
        const labelY = Math.min(sy, ey) - 12;
        ctx.font = '600 12px Inter, sans-serif';
        const w1 = ctx.measureText(line1).width;
        ctx.font = '11px Inter, sans-serif';
        const w2 = ctx.measureText(line2).width;
        const boxW = Math.max(w1, w2) + 16;
        const boxH = 38;
        const boxX = midX - boxW / 2;
        const boxY = Math.max(2, labelY - boxH);

        ctx.fillStyle = isUp ? 'rgba(34,197,94,0.92)' : 'rgba(239,68,68,0.92)';
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(boxX + r, boxY); ctx.lineTo(boxX + boxW - r, boxY);
        ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
        ctx.lineTo(boxX + boxW, boxY + boxH - r);
        ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
        ctx.lineTo(boxX + r, boxY + boxH);
        ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
        ctx.lineTo(boxX, boxY + r);
        ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
        ctx.fill();

        ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
        ctx.font = '600 12px Inter, sans-serif';
        ctx.fillText(line1, midX, boxY + 15);
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText(line2, midX, boxY + 30);
        ctx.textAlign = 'start';
    }

    render();

    // Re-render on scroll/zoom so ruler follows the chart
    const subId = _c.timeScale().subscribeVisibleTimeRangeChange(render);
    overlay._unsub = () => {
        try { _c.timeScale().unsubscribeVisibleTimeRangeChange(render); } catch(e) {}
    };
}

function drawFibonacci(p1, p2, color, customLevels) {
    const _s = drawCtx.series || modal.series;
    if (!_s) return;
    const rawLevels = customLevels || fibConfig.load();
    const levels = rawLevels.map((item, i) => {
        if (typeof item === 'number') return { level: item, color: color || FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length] };
        return { level: item.level, color: color || item.color || FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length] };
    });
    const diff = p2 - p1;
    const fibLines = [];

    levels.forEach((item, i) => {
        const price = p1 + diff * item.level;
        const label = `${(item.level * 100).toFixed(1)}%`;
        const priceLine = _s.createPriceLine({
            price: price,
            color: item.color,
            lineWidth: 1.5,
            lineStyle: 0,
            axisLabelVisible: true,
            title: label,
        });
        fibLines.push(priceLine);
    });

    const savedColor = color || levels[0]?.color || '#4caf50';
    draw.drawings.push({
        id: ++drawIdCounter, type: 'fib', color: savedColor, locked: false,
        fibLines, priceLine: null, data: { p1, p2, levels }
    });
    persistDrawings();
}

function closeCoinModal() {
    const closingSym = modal.currentSym;
    el('coinModal').classList.add('hidden');
    removeRulerMeasurement();
    // Cleanup ResizeObserver
    if (modal._resizeObserver) { modal._resizeObserver.disconnect(); modal._resizeObserver = null; }
    // Detach library DrawingManager
    if (typeof DM !== 'undefined' && DM && DM.detach) DM.detach();
    // Stop countdown timer
    if (modal._countdownTimer) { clearInterval(modal._countdownTimer); modal._countdownTimer = null; }
    // Clear signal markers
    if (modal._markers) { modal._markers.setMarkers([]); modal._markers = null; }
    window._pendingSignalMarker = null;
    // Unsubscribe modal WS stream
    if (modal.wsStream) {
        if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
            mc.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [modal.wsStream], id: Date.now() }));
        }
        mc.wsStreams.delete(modal.wsStream);
        modal.wsStream = null;
    }
    if (modal.chart) {
        modal.chart.remove();
        modal.chart = null;
        modal.series = null;
        modal.volSeries = null;
        modal.lines = [];
        modal.legend = null;
    }
    modal.currentSym = null;
    // Clear drawing chart objects (data already persisted in localStorage)
    draw.drawings = [];
    draw.selected = null;
    draw.activeTool = 'cursor';
    draw.clickCount = 0;
    hideDrawingPanel();
    removePreviewOverlay();

    // Refresh drawings on mini-chart (user may have added/removed drawings)
    if (closingSym && mc.charts[closingSym]) {
        applyDrawingsToMiniChart(closingSym);
    }
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
        // Clear chart objects before reload (data stays in localStorage)
        draw.drawings.forEach(d => removeDrawingFromChart(d));
        draw.drawings = [];
        loadModalChart(modal.currentSym, modal.currentTF);
        startCountdown();
    });
}

// ==========================================
// Multi-Chart Layout System
// ==========================================
const mch = {
    layout: 'grid',      // 'grid' | '1' | '2' | '4'
    activeSlot: 0,        // which slot receives next symbol click
    slots: [],            // { sym, tf, chart, series, volSeries, legend }
};

// Restore layout from localStorage
try { mch.layout = localStorage.getItem('mch_layout') || 'grid'; } catch(e) {}

function initLayoutPicker() {
    const picker = el('mcLayoutPicker');
    if (!picker) return;

    // Set initial active state
    picker.querySelectorAll('.mc-layout-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.layout === mch.layout);
    });

    picker.addEventListener('click', (e) => {
        const btn = e.target.closest('.mc-layout-btn');
        if (!btn) return;
        const layout = btn.dataset.layout;
        if (layout === mch.layout) return;

        picker.querySelectorAll('.mc-layout-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        switchLayout(layout);
    });

    // Apply saved layout on init
    if (mch.layout !== 'grid') {
        switchLayout(mch.layout);
    }
}

function switchLayout(layout) {
    mch.layout = layout;
    localStorage.setItem('mch_layout', layout);

    const miniChartsLayout = el('mcMiniChartsLayout');
    const multiChart = el('mcMultiChart');
    const sidebar = el('mcSidebar');

    if (layout === 'grid') {
        // Show mini-charts grid, hide multi-chart
        miniChartsLayout.style.display = 'flex';
        multiChart.style.display = 'none';
        // Sidebar stays inside mc-layout
        if (sidebar.parentElement !== miniChartsLayout) {
            miniChartsLayout.appendChild(sidebar);
        }
    } else {
        // Hide mini-charts grid, show multi-chart
        miniChartsLayout.style.display = 'none';
        multiChart.style.display = 'flex';
        // Move sidebar into multi-chart container
        if (sidebar.parentElement !== multiChart) {
            multiChart.appendChild(sidebar);
        }
        renderMultiChartSlots(layout);
    }
}

function renderMultiChartSlots(layout) {
    const grid = el('mchGrid');
    grid.dataset.layout = layout;
    const countMap = { '2h': 2, '2v': 2, '4': 4, '1+3': 4 };
    const count = countMap[layout] || parseInt(layout) || 2;

    // Preserve existing slot symbols
    const savedSyms = mch.slots.map(s => s.sym);

    // Restore from localStorage if first time
    if (savedSyms.length === 0) {
        try {
            const saved = JSON.parse(localStorage.getItem('mch_slots') || '[]');
            for (let i = 0; i < count; i++) {
                savedSyms[i] = saved[i] || null;
            }
        } catch(e) {}
    }

    // Destroy old chart instances
    mch.slots.forEach(slot => {
        if (slot.chart) {
            try { slot.chart.remove(); } catch(e) {}
        }
    });
    mch.slots = [];
    grid.innerHTML = '';

    for (let i = 0; i < count; i++) {
        const slot = document.createElement('div');
        slot.className = 'mch-slot' + (i === mch.activeSlot ? ' active' : '');
        slot.dataset.index = i;

        const sym = savedSyms[i] || null;

        slot.innerHTML = `
            <div class="mch-slot-header">
                <span class="mch-slot-sym">${sym ? sym.replace('USDT','') + '/USDT' : '—'}</span>
                ${sym ? `<button class="mch-copy-btn" data-ticker="${sym.toLowerCase()}" title="Copy ${sym.toLowerCase()}"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` : ''}
                <span class="mch-slot-price"></span>
                <span class="mch-slot-change"></span>
                <div class="mch-slot-tf">
                    <button class="mc-tf-btn" data-tf="1m">1m</button>
                    <button class="mc-tf-btn" data-tf="5m">5m</button>
                    <button class="mc-tf-btn active" data-tf="15m">15m</button>
                    <button class="mc-tf-btn" data-tf="1h">1h</button>
                    <button class="mc-tf-btn" data-tf="4h">4h</button>
                    <button class="mc-tf-btn" data-tf="1d">1d</button>
                </div>
            </div>
            ${sym ? '<div class="mch-slot-chart" id="mch-chart-' + i + '"></div>' : '<div class="mch-slot-empty">Click a coin in sidebar</div>'}
        `;

        // Copy ticker button
        const copyBtn = slot.querySelector('.mch-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(copyBtn.dataset.ticker).then(() => {
                    copyBtn.classList.add('mc-copy-ok');
                    setTimeout(() => copyBtn.classList.remove('mc-copy-ok'), 800);
                });
            });
        }

        // Click slot to make it active
        slot.addEventListener('click', (e) => {
            if (e.target.closest('.mc-tf-btn') || e.target.closest('.mch-copy-btn')) return;
            setActiveSlot(i);
        });

        // TF buttons per slot
        slot.querySelector('.mch-slot-tf').addEventListener('click', (e) => {
            const btn = e.target.closest('.mc-tf-btn');
            if (!btn) return;
            const slotData = mch.slots[i];
            if (!slotData || !slotData.sym) return;
            slot.querySelectorAll('.mch-slot-tf .mc-tf-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Unsubscribe old TF stream, subscribe new
            mchWsUnsubscribe(slotData.sym, slotData.tf);
            slotData.tf = btn.dataset.tf;
            mchWsSubscribe(slotData.sym, slotData.tf);
            loadSlotChart(i);
        });

        grid.appendChild(slot);

        mch.slots.push({
            sym: sym,
            tf: mc.globalTF,
            chart: null,
            series: null,
            volSeries: null,
            legend: null,
            el: slot
        });

        // If slot has a symbol, create chart + subscribe WS
        if (sym) {
            createSlotChart(i);
            loadSlotChart(i);
            mchWsSubscribe(sym, mc.globalTF);
        }
    }
}

function setActiveSlot(index) {
    mch.activeSlot = index;
    document.querySelectorAll('.mch-slot').forEach((s, i) => {
        s.classList.toggle('active', i === index);
    });
    // Switch drawing context to active slot
    const slot = mch.slots[index];
    if (slot && slot.chart && slot.sym) {
        // Save current drawings before switching
        persistDrawings();
        // Clear current drawings from chart
        draw.drawings.forEach(d => removeDrawingFromChart(d));
        draw.drawings = [];
        draw.selected = null;
        draw.activeTool = 'cursor';
        draw.clickCount = 0;
        hideDrawingPanel();
        removePreviewOverlay();

        setDrawCtxSlot(index);
        // Restore drawings for new symbol
        restoreDrawings();
        updateModalCursor();
    }
}

function assignSymbolToSlot(sym, slotIndex) {
    const slot = mch.slots[slotIndex];
    if (!slot) return;

    // Unsubscribe old symbol WS stream
    if (slot.sym) {
        mchWsUnsubscribe(slot.sym, slot.tf);
    }

    // Destroy old chart
    if (slot.chart) {
        try { slot.chart.remove(); } catch(e) {}
        slot.chart = null;
        slot.series = null;
        slot.volSeries = null;
    }

    slot.sym = sym;
    const pair = mc.allPairs.find(p => p.symbol === sym);

    // Update header
    const header = slot.el.querySelector('.mch-slot-sym');
    header.textContent = sym ? sym.replace('USDT','') + '/USDT' : '—';

    // Update or create copy button
    let copyBtn = slot.el.querySelector('.mch-copy-btn');
    if (sym) {
        if (!copyBtn) {
            copyBtn = document.createElement('button');
            copyBtn.className = 'mch-copy-btn';
            copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1 1 0 011-1h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
            header.after(copyBtn);
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(copyBtn.dataset.ticker).then(() => {
                    copyBtn.classList.add('mc-copy-ok');
                    setTimeout(() => copyBtn.classList.remove('mc-copy-ok'), 800);
                });
            });
        }
        copyBtn.dataset.ticker = sym.toLowerCase();
        copyBtn.title = `Copy ${sym.toLowerCase()}`;
    } else if (copyBtn) {
        copyBtn.remove();
    }

    if (pair) {
        const prec = getPricePrecision(pair.lastPrice);
        slot.el.querySelector('.mch-slot-price').textContent = '$' + pair.lastPrice.toFixed(prec);
        const chg = pair.priceChange;
        const chgEl = slot.el.querySelector('.mch-slot-change');
        chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        chgEl.style.color = chg >= 0 ? '#22c55e' : '#ef4444';
    }

    // Replace empty placeholder with chart div
    const empty = slot.el.querySelector('.mch-slot-empty');
    if (empty) {
        const chartDiv = document.createElement('div');
        chartDiv.className = 'mch-slot-chart';
        chartDiv.id = 'mch-chart-' + slotIndex;
        empty.replaceWith(chartDiv);
    }

    createSlotChart(slotIndex);
    loadSlotChart(slotIndex);
    saveSlotSymbols();

    // Subscribe to WS for live updates
    mchWsSubscribe(sym, slot.tf);

    // Auto-advance to next slot
    const nextSlot = (slotIndex + 1) % mch.slots.length;
    setActiveSlot(nextSlot);
}

function createSlotChart(slotIndex) {
    const slot = mch.slots[slotIndex];
    const chartEl = el('mch-chart-' + slotIndex);
    if (!chartEl || !slot.sym) return;

    const pair = mc.allPairs.find(p => p.symbol === slot.sym);
    const price = pair ? pair.lastPrice : 1;
    const prec = getPricePrecision(price);
    const minMove = parseFloat((1 / Math.pow(10, prec)).toFixed(prec));

    slot.chart = LightweightCharts.createChart(chartEl, {
        autoSize: true,
        ...localChartOptions,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8', fontSize: 10 },
        grid: getGridOpts(),
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 45, mode: getPriceScaleMode() },
        timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 10, tickMarkFormatter: localTickFormatter },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { mouseWheel: true, pinch: true },
    });

    slot.series = addMainSeries(slot.chart, prec, minMove);

    slot.volSeries = slot.chart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100,116,139,0.3)',
    });
    slot.chart.priceScale('vol').applyOptions({
        scaleMargins: { top: getVolScaleTop(), bottom: 0 },
        drawTicks: false,
        borderVisible: false,
    });

    // OHLCV legend
    const legend = document.createElement('div');
    legend.className = 'mc-ohlcv-legend';
    chartEl.appendChild(legend);
    slot.legend = legend;

    slot.chart.subscribeCrosshairMove(param => {
        if (!param || !param.time || !slot.legend) {
            if (slot.legend) slot.legend.style.display = 'none';
            return;
        }
        const data = param.seriesData.get(slot.series);
        if (!data) { slot.legend.style.display = 'none'; return; }
        const p = getPricePrecision(data.close || data.open || 1);
        const o = (data.open||0).toFixed(p), h = (data.high||0).toFixed(p);
        const l = (data.low||0).toFixed(p), c = (data.close||0).toFixed(p);
        const volData = param.seriesData.get(slot.volSeries);
        const v = volData ? (volData.value >= 1e6 ? (volData.value/1e6).toFixed(1)+'M' : (volData.value >= 1e3 ? (volData.value/1e3).toFixed(0)+'K' : volData.value.toFixed(0))) : '—';
        const color = data.close >= data.open ? '#22c55e' : '#ef4444';
        slot.legend.style.display = 'flex';
        slot.legend.innerHTML = `<span style="color:${color}">O <b>${o}</b></span><span style="color:${color}">H <b>${h}</b></span><span style="color:${color}">L <b>${l}</b></span><span style="color:${color}">C <b>${c}</b></span><span style="color:var(--text-muted)">V <b>${v}</b></span>`;
    });

    // Drawing tools on slot — switch context on any interaction
    chartEl.addEventListener('mousedown', () => {
        if (drawCtx.source !== 'slot:' + slotIndex) {
            setDrawCtxSlot(slotIndex);
            // Move toolbar to this slot
            renderDrawToolbar(chartEl);
        }
    }, true);
    chartEl.addEventListener('touchstart', () => {
        if (drawCtx.source !== 'slot:' + slotIndex) {
            setDrawCtxSlot(slotIndex);
            renderDrawToolbar(chartEl);
        }
    }, { capture: true, passive: true });

    // Attach ruler + drawing handlers
    attachRuler(chartEl, slot.chart, slot.series);
    setupDrawingHandlers(chartEl);

    // Render compact toolbar
    setDrawCtxSlot(slotIndex);
    renderDrawToolbar(chartEl);
    // Reset ctx back to modal if modal is open
    if (modal.chart) setDrawCtxModal();
}

async function loadSlotChart(slotIndex) {
    const slot = mch.slots[slotIndex];
    if (!slot || !slot.sym || !slot.series) return;

    try {
        const res = await fetch(`/api/klines?symbol=${slot.sym}&interval=${slot.tf}&limit=500`);
        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) return;

        const parsed = parseKlines(raw);
        slot.candleData = parsed;
        slot.series.setData(parsed);
        slot.volSeries?.setData(extractVolume(parsed));

        // Update drawCtx if this slot is active
        if (drawCtx.source === 'slot:' + slotIndex) drawCtx.candleData = parsed;

        // Scroll to end respecting rightOffset
        slot.chart.timeScale().scrollToRealTime();

        // Apply saved drawings (per-symbol, visible on all TFs)
        applyDrawingsToSlot(slotIndex);

        // Fetch and render density walls
        applyDensityToSlot(slotIndex);

        // OI indicator
        applyOI(slot, slot.sym, slot.tf);
    } catch(e) {
        console.error('[MCH] Load error slot', slotIndex, e);
    }
}

// Client-side density wall filter using settings
function filterDensityWalls(walls) {
    const depthPct = spGet('densityDepthPct', 5.0);
    const ttlMin = spGet('densityTTLMin', 1);
    const xSmall = spGet('densitySeveritySmall', 2.0);
    const blacklistRaw = spGet('densityBlacklist', 'USDC,FDUSD,TUSD,USDP,DAI,USDD,EUR');
    const blacklist = blacklistRaw ? blacklistRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];

    return walls.filter(w => {
        // Blacklist filter
        if (blacklist.length > 0 && blacklist.some(b => w.symbol && w.symbol.includes(b))) return false;
        // Depth filter — distancePct from current price
        if (w.distancePct !== undefined && Math.abs(w.distancePct) > depthPct) return false;
        // TTL filter — minimum lifetime in minutes
        if (w.lifetimeMins !== undefined && w.lifetimeMins < ttlMin) return false;
        // Severity filter — xMult must be >= smallest severity setting
        if (w.xMult !== undefined && w.xMult < xSmall) return false;
        return true;
    });
}

async function applyDensityToSlot(slotIndex) {
    if (!spGet('densityEnabled', true)) return;
    const slot = mch.slots[slotIndex];
    if (!slot || !slot.sym || !slot.chart || !slot.series) return;

    // Clear old density lines
    if (slot.densityObjs) {
        slot.densityObjs.forEach(obj => {
            if (obj.priceLine) try { slot.series.removePriceLine(obj.priceLine); } catch(e) {}
        });
    }
    slot.densityObjs = [];

    try {
        const res = await fetch(`/densities/v2?symbols=${slot.sym}`);
        const json = await res.json();
        const items = json.data || [];
        if (items.length === 0) return;

        const entry = items[0];
        const walls = [];
        if (entry.support) walls.push({ ...entry.support, side: 'bid' });
        if (entry.resistance) walls.push({ ...entry.resistance, side: 'ask' });
        // Add extra bid/ask walls if available
        (entry.bidWalls || []).slice(1, 3).forEach(w => walls.push({ ...w, side: 'bid' }));
        (entry.askWalls || []).slice(1, 3).forEach(w => walls.push({ ...w, side: 'ask' }));

        walls.forEach(w => {
            const isBid = w.side === 'bid';
            const color = isBid ? '#22c55e' : '#ef4444';
            const notionalStr = w.notional >= 1e6 ? (w.notional / 1e6).toFixed(1) + 'M' : Math.round(w.notional / 1e3) + 'K';
            const label = `$${notionalStr} ${w.sizeVsMedian}x`;

            const priceLine = slot.series.createPriceLine({
                price: w.price,
                color: color,
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: label,
            });
            slot.densityObjs.push({ priceLine });
        });
    } catch(e) {
        // silently ignore density fetch errors
    }
}

// Apply density walls to mini-chart card (grid view)
// Batch density load — one request for all visible symbols
async function applyDensityToBatch(symbols) {
    if (!spGet('densityEnabled', true)) return;
    try {
        const res = await fetch(`/densities/v2?symbols=${symbols.join(',')}`);
        const json = await res.json();
        const items = json.data || [];
        if (items.length === 0) return;

        // Build map: symbol → flat wall list
        const bySymbol = {};
        items.forEach(entry => {
            const walls = [];
            if (entry.support) walls.push({ ...entry.support, side: 'bid' });
            if (entry.resistance) walls.push({ ...entry.resistance, side: 'ask' });
            (entry.bidWalls || []).slice(1, 2).forEach(w => walls.push({ ...w, side: 'bid' }));
            (entry.askWalls || []).slice(1, 2).forEach(w => walls.push({ ...w, side: 'ask' }));
            if (walls.length > 0) bySymbol[entry.symbol] = walls;
        });

        // Apply to each chart
        for (const sym of symbols) {
            const chartObj = mc.charts[sym];
            if (!chartObj || !chartObj.series) continue;

            if (chartObj.densityLines) {
                chartObj.densityLines.forEach(pl => { try { chartObj.series.removePriceLine(pl); } catch(e) {} });
            }
            chartObj.densityLines = [];

            const symWalls = bySymbol[sym] || [];
            symWalls.forEach(w => {
                const color = w.side === 'bid' ? '#22c55e' : '#ef4444';
                const notionalStr = w.notional >= 1e6 ? (w.notional / 1e6).toFixed(1) + 'M' : Math.round(w.notional / 1e3) + 'K';
                const priceLine = chartObj.series.createPriceLine({
                    price: w.price, color, lineWidth: 1, lineStyle: 2,
                    axisLabelVisible: false, title: `$${notionalStr} ${w.sizeVsMedian}x`,
                });
                chartObj.densityLines.push(priceLine);
            });
        }
    } catch(e) { /* ignore */ }
}

async function applyDensityToMiniChart(sym) {
    if (!spGet('densityEnabled', true)) return;
    const chartObj = mc.charts[sym];
    if (!chartObj || !chartObj.series) return;

    // Clear old density lines
    if (chartObj.densityLines) {
        chartObj.densityLines.forEach(pl => {
            try { chartObj.series.removePriceLine(pl); } catch(e) {}
        });
    }
    chartObj.densityLines = [];

    try {
        const res = await fetch(`/densities/simple?symbols=${sym}&limitSymbols=1&xFilter=2`);
        const json = await res.json();
        const walls = filterDensityWalls(json.data || []);
        if (walls.length === 0) return;

        walls.forEach(w => {
            const color = w.sideKey === 'bid' ? '#22c55e' : '#ef4444';
            const notionalStr = w.notional >= 1e6 ? (w.notional / 1e6).toFixed(1) + 'M' : Math.round(w.notional / 1e3) + 'K';
            const priceLine = chartObj.series.createPriceLine({
                price: w.price,
                color,
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: false,
                title: `$${notionalStr} x${w.xMult}`,
            });
            chartObj.densityLines.push(priceLine);
        });
    } catch(e) { /* ignore */ }
}

// Apply density walls to modal chart
async function applyDensityToModal() {
    if (!spGet('densityEnabled', true)) return;
    if (!modal.chart || !modal.series || !modal.currentSym) return;

    // Clear old density lines
    if (modal.densityLines) {
        modal.densityLines.forEach(pl => {
            try { modal.series.removePriceLine(pl); } catch(e) {}
        });
    }
    modal.densityLines = [];

    try {
        const res = await fetch(`/densities/v2?symbols=${modal.currentSym}`);
        const json = await res.json();
        const items = json.data || [];
        if (items.length === 0) return;

        const entry = items[0];
        const walls = [];
        if (entry.support) walls.push({ ...entry.support, side: 'bid' });
        if (entry.resistance) walls.push({ ...entry.resistance, side: 'ask' });
        // Add extra walls (up to 5 per side)
        (entry.bidWalls || []).slice(1, 5).forEach(w => walls.push({ ...w, side: 'bid' }));
        (entry.askWalls || []).slice(1, 5).forEach(w => walls.push({ ...w, side: 'ask' }));

        walls.forEach(w => {
            const isBid = w.side === 'bid';
            const color = isBid ? '#22c55e' : '#ef4444';
            const notionalStr = w.notional >= 1e6 ? (w.notional / 1e6).toFixed(1) + 'M' : Math.round(w.notional / 1e3) + 'K';
            const statusTag = w.status === 'strong' ? ' 🧱' : w.status === 'confirmed' ? ' ✓' : '';
            const priceLine = modal.series.createPriceLine({
                price: w.price,
                color,
                lineWidth: w.sizeVsMedian >= 10 ? 2 : 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: `$${notionalStr} ${w.sizeVsMedian}x${statusTag}`,
            });
            modal.densityLines.push(priceLine);
        });
    } catch(e) { /* ignore */ }
}

function applyDrawingsToSlot(slotIndex) {
    const slot = mch.slots[slotIndex];
    if (!slot || !slot.sym || !slot.chart || !slot.series) return;

    // Clear old drawing objects
    if (slot.drawObjs) {
        slot.drawObjs.forEach(obj => {
            if (obj.priceLine) try { slot.series.removePriceLine(obj.priceLine); } catch(e) {}
            if (obj.lineSeries) try { slot.chart.removeSeries(obj.lineSeries); } catch(e) {}
        });
    }
    slot.drawObjs = [];

    const saved = drawStore.load(slot.sym);
    if (!saved || saved.length === 0) return;

    saved.forEach(s => {
        if (s.type === 'hline' && s.data) {
            const pl = slot.series.createPriceLine({
                price: s.data.price,
                color: s.color || '#5b9cf6',
                lineWidth: 2,
                lineStyle: 0,
                axisLabelVisible: true,
                title: '',
            });
            slot.drawObjs.push({ priceLine: pl });
        } else if (s.type === 'fib' && s.data) {
            const rawLevels = s.data.levels || FIB_DEFAULTS_OBJ;
            const diff = s.data.p2 - s.data.p1;
            rawLevels.forEach((item, i) => {
                const lvl = typeof item === 'number' ? item : item.level;
                const clr = (typeof item === 'object' && item.color) ? item.color : (s.color || FIB_DEFAULT_COLORS[i % FIB_DEFAULT_COLORS.length]);
                const price = s.data.p1 + diff * lvl;
                const pl = slot.series.createPriceLine({
                    price,
                    color: clr,
                    lineWidth: 1.5,
                    lineStyle: 0,
                    axisLabelVisible: true,
                    title: `${(lvl * 100).toFixed(1)}%`,
                });
                slot.drawObjs.push({ priceLine: pl });
            });
        } else if (s.type === 'ray' && s.data) {
            const startTime = s.data.startTime || s.data.t1;
            const farTime = startTime + 365 * 24 * 3600;
            const ls = slot.chart.addSeries(LightweightCharts.LineSeries, {
                color: s.color || '#5b9cf6',
                lineWidth: 2,
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false,
                pointMarkersVisible: false,
            });
            ls.setData([
                { time: startTime, value: s.data.price },
                { time: farTime, value: s.data.price },
            ]);
            slot.drawObjs.push({ lineSeries: ls });
        } else if (s.type === 'trendline' && s.data) {
            const ls = slot.chart.addSeries(LightweightCharts.LineSeries, {
                color: s.color || '#5b9cf6',
                lineWidth: 2,
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false,
                pointMarkersVisible: false,
            });
            ls.setData([
                { time: s.data.t1, value: s.data.p1 },
                { time: s.data.t2, value: s.data.p2 },
            ]);
            slot.drawObjs.push({ lineSeries: ls });
        } else if (s.type === 'rect' && s.data) {
            const { t1, p1, t2, p2 } = s.data;
            const clr = s.color || '#5b9cf6';
            const pMax = Math.max(p1, p2);
            const pMin = Math.min(p1, p2);
            // Top border
            const topLs = slot.chart.addSeries(LightweightCharts.LineSeries, {
                color: clr, lineWidth: 1.5, crosshairMarkerVisible: false,
                lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
            });
            topLs.setData([{ time: t1, value: pMax }, { time: t2, value: pMax }]);
            slot.drawObjs.push({ lineSeries: topLs });
            // Bottom border
            const botLs = slot.chart.addSeries(LightweightCharts.LineSeries, {
                color: clr, lineWidth: 1.5, crosshairMarkerVisible: false,
                lastValueVisible: false, priceLineVisible: false, pointMarkersVisible: false,
            });
            botLs.setData([{ time: t1, value: pMin }, { time: t2, value: pMin }]);
            slot.drawObjs.push({ lineSeries: botLs });
        }
    });
}

function saveSlotSymbols() {
    const syms = mch.slots.map(s => s.sym || null);
    localStorage.setItem('mch_slots', JSON.stringify(syms));
}

// WS helpers for multi-chart slots
function mchWsSubscribe(sym, tf) {
    if (!sym) return;
    const stream = `${sym.toLowerCase()}@kline_${tf}`;
    if (mc.wsStreams.has(stream)) return;
    mc.wsStreams.add(stream);
    if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
        mc.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [stream], id: Date.now() }));
    } else {
        wsConnect();
    }
}

function mchWsUnsubscribe(sym, tf) {
    if (!sym) return;
    const stream = `${sym.toLowerCase()}@kline_${tf}`;
    // Only unsubscribe if no other slot uses same stream
    const othersUsing = mch.slots.some(s => s.sym === sym && s.tf === tf && s.chart);
    if (othersUsing) return;
    if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
        mc.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [stream], id: Date.now() }));
    }
    mc.wsStreams.delete(stream);
}

// Override sidebar click when in multi-chart mode
function handleSidebarCoinClick(sym) {
    if (mch.layout === 'grid') {
        openCoinModal(sym);
    } else {
        assignSymbolToSlot(sym, mch.activeSlot);
    }
}
