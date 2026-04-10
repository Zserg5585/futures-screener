// ==========================================
// Mini-Charts v3 — Full Market Screener
// Uses IntersectionObserver to only render visible charts
// ==========================================
const FLAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
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
    filters: { minVol: 50, minNatr: 0, minTrades: 0 },
    searchQuery: '',     // coin search filter
    flags: {},           // { sym: '#color' } — color flags, persisted in localStorage
    ws: null,            // Binance kline WebSocket
    wsStreams: new Set(), // currently subscribed streams
    wsPending: new Set() // streams waiting to subscribe
};

// Load flags from localStorage
try { mc.flags = JSON.parse(localStorage.getItem('mc_flags') || '{}'); } catch(e) { mc.flags = {}; }

function saveFlags() {
    localStorage.setItem('mc_flags', JSON.stringify(mc.flags));
}

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

    // Filter by search query
    let pairs = mc.filteredPairs;
    if (mc.searchQuery) {
        pairs = pairs.filter(p => p.symbol.replace('USDT', '').includes(mc.searchQuery));
    }

    // Sort: flagged coins first, then by current sort
    pairs = [...pairs].sort((a, b) => {
        const fa = mc.flags[a.symbol] ? 1 : 0;
        const fb = mc.flags[b.symbol] ? 1 : 0;
        return fb - fa;
    });

    if (countEl) countEl.textContent = pairs.length;

    list.innerHTML = pairs.map(p => {
        const sym = p.symbol;
        const ticker = sym.replace('USDT', '');
        const chg = p.priceChange;
        const chgClass = chg >= 0 ? 'mc-metric-green' : 'mc-metric-red';
        const chgSign = chg >= 0 ? '+' : '';
        const vol = p.quoteVol >= 1e9 ? (p.quoteVol / 1e9).toFixed(1) + 'B' : (p.quoteVol / 1e6).toFixed(0) + 'M';
        const flagColor = mc.flags[sym] || '';
        const flagStyle = flagColor ? `background:${flagColor}; border-color:transparent;` : '';
        const flagClass = flagColor ? 'mc-flag-btn flagged' : 'mc-flag-btn';

        return `<div class="mc-coin-item" data-symbol="${sym}">
            <button class="${flagClass}" style="${flagStyle}" data-flag="${sym}" title="Set color flag"></button>
            <div style="flex:1; min-width:0; display:flex; align-items:center; gap:4px;">
                <span class="mc-coin-name">${ticker}</span>
                <span class="mc-coin-vol">$${vol}</span>
            </div>
            <span class="mc-coin-change ${chgClass}">${chgSign}${chg.toFixed(2)}%</span>
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

    // Click handler — open coin modal (skip flag clicks)
    list.querySelectorAll('.mc-coin-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.mc-flag-btn') || e.target.closest('.mc-flag-popup')) return;
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

    // Volume histogram
    const volSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100,116,139,0.3)',
    });
    chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
        drawTicks: false,
        borderVisible: false,
    });

    mc.charts[sym] = { chart, series, volSeries, lines: [] };

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

            // Update mini-chart
            if (mc.charts[sym]) {
                mc.charts[sym].series.update(candle);
                mc.charts[sym].volSeries.update({
                    time: candle.time,
                    value: vol,
                    color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
                });
            }

            // Update modal chart if same symbol & TF
            if (modal.chart && modal.currentSym === sym) {
                const modalStream = `${sym.toLowerCase()}@kline_${modal.currentTF}`;
                const incomingStream = msg.stream || '';
                if (incomingStream === modalStream || modal.wsStream === `${sym.toLowerCase()}@kline_${k.i}`) {
                    modal.series.update(candle);
                    if (modal.volSeries) modal.volSeries.update({
                        time: candle.time,
                        value: vol,
                        color: candle.close >= candle.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
                    });
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

    modal.volSeries = modal.chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        color: 'rgba(100,116,139,0.3)',
    });
    modal.chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        drawTicks: false,
        borderVisible: false,
    });

    modal.lines = [];
    modal.drawings = [];

    // Attach ruler to modal chart
    attachRuler(el('cmChartBody'), modal.chart, modal.series);

    // Drawing tools
    renderDrawToolbar();
    setupDrawingHandlers();
    updateModalCursor();

    loadModalChart(sym, modal.currentTF);
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
        // Phase 1: fast — 150 candles
        const res1 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=150`);
        const json1 = await res1.json();
        if (!Array.isArray(json1) || !modal.chart) return;

        const data1 = parseKlines(json1);
        modal.series.setData(data1);
        if (modal.volSeries) modal.volSeries.setData(extractVolume(data1));
        modal.chart.timeScale().setVisibleLogicalRange({ from: 0, to: data1.length - 1 });

        // Restore saved drawings for this symbol
        restoreDrawings();

        // Subscribe modal to live WS
        const stream = `${sym.toLowerCase()}@kline_${tf}`;
        modal.wsStream = stream;
        mc.wsStreams.add(stream);
        if (mc.ws && mc.ws.readyState === WebSocket.OPEN) {
            mc.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [stream], id: Date.now() }));
        } else {
            wsConnect();
        }

        // Phase 2: background — 1500 candles
        setTimeout(async () => {
            if (!modal.chart || modal.currentSym !== sym || modal.currentTF !== tf) return;
            try {
                const res2 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=1500`);
                const json2 = await res2.json();
                if (!Array.isArray(json2) || !modal.chart) return;

                let fullData = parseKlines(json2);
                const visRange = modal.chart.timeScale().getVisibleLogicalRange();

                // Phase 3: fetch another 1000 older candles for ~2500 total
                if (fullData.length >= 1400) {
                    try {
                        const oldest = json2[0][0]; // oldest candle open time
                        const res3 = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${oldest - 1}`);
                        const json3 = await res3.json();
                        if (Array.isArray(json3) && json3.length > 0 && modal.chart && modal.currentSym === sym) {
                            const olderData = parseKlines(json3);
                            fullData = [...olderData, ...fullData];
                        }
                    } catch(e) { /* older history failed, use 1500 */ }
                }

                if (!modal.chart || modal.currentSym !== sym) return;
                modal.series.setData(fullData);
                if (modal.volSeries) modal.volSeries.setData(extractVolume(fullData));
                const added = fullData.length - data1.length;
                if (visRange) {
                    modal.chart.timeScale().setVisibleLogicalRange({
                        from: visRange.from + added,
                        to: visRange.to + added
                    });
                }
            } catch (e) { /* background load failed */ }
        }, 400);
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


// ==========================================
// Drawing Tools — Modal only
// ==========================================
const DRAW_TOOLS = [
    { id: 'cursor', icon: '\u25B3', title: 'Cursor (Esc)', key: 'Escape' },
    { id: 'hline', icon: '\u2500', title: 'Horizontal Line (H)', key: 'h' },
    { id: 'ray', icon: '\u2571', title: 'Ray (R)', key: 'r' },
    { id: 'trendline', icon: '\u2572', title: 'Trend Line (T)', key: 't' },
    { id: 'fib', icon: 'Fib', title: 'Fibonacci Retracement (F)', key: 'f' },
    { id: 'ruler', icon: '\u{1F4CF}', title: 'Ruler (Shift+Drag)', key: null },
    { id: 'trash', icon: '\u{1F5D1}', title: 'Clear All Drawings', key: 'Delete' },
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
            // Serialize only data we can recreate from
            store[sym] = drawings.map(d => ({
                type: d.type, color: d.color, locked: d.locked, data: d.data
            }));
            saveAll(store);
        },
        load(sym) {
            const store = loadAll();
            return store[sym] || [];
        },
        remove(sym) {
            const store = loadAll();
            delete store[sym];
            saveAll(store);
        }
    };
})();

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
    dragStartY: 0,
    dragStartPrice: 0,
};

function renderDrawToolbar() {
    const container = el('cmDrawTools');
    if (!container) return;
    container.innerHTML = DRAW_TOOLS.map(t => {
        const active = draw.activeTool === t.id ? ' dt-active' : '';
        return `<button class="dt-btn${active}" data-tool="${t.id}" title="${t.title}">${t.icon}</button>`;
    }).join('');

    container.querySelectorAll('.dt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tool = btn.dataset.tool;
            if (tool === 'trash') {
                clearAllDrawings();
                return;
            }
            draw.activeTool = tool;
            draw.clickCount = 0;
            removePreviewOverlay();
            renderDrawToolbar();
            updateModalCursor();
        });
    });
}

function updateModalCursor() {
    const chartEl = el('cmChartBody');
    if (!chartEl) return;
    if (draw.activeTool === 'cursor') {
        chartEl.style.cursor = '';
        // Re-enable chart interaction
        if (modal.chart) {
            modal.chart.applyOptions({
                handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
                handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
            });
        }
    } else {
        chartEl.style.cursor = 'crosshair';
        // Disable chart interaction so touches go to our handler
        if (modal.chart) {
            modal.chart.applyOptions({
                handleScroll: false,
                handleScale: false,
            });
        }
    }
}

// Keyboard shortcuts for tools
document.addEventListener('keydown', (e) => {
    if (!modal.chart) return;
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
        renderDrawToolbar();
        updateModalCursor();
    }
    if (e.key === 'Delete' && modal.chart) {
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
    if (d.priceLine && modal.series) {
        try { modal.series.removePriceLine(d.priceLine); } catch(e) {}
    }
    if (d.lineSeries && modal.chart) {
        try { modal.chart.removeSeries(d.lineSeries); } catch(e) {}
    }
    if (d.fibLines && modal.series) {
        d.fibLines.forEach(fl => {
            try { modal.series.removePriceLine(fl); } catch(e) {}
        });
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
    const chartEl = el('cmChartBody');
    if (!chartEl) return;

    const panel = document.createElement('div');
    panel.id = 'drawPanel';
    panel.className = 'draw-panel';

    // Color dots
    const colorsHtml = DRAW_COLORS.map(c => {
        const sel = c === d.color ? ' draw-color-active' : '';
        return `<div class="draw-color-dot${sel}" data-color="${c}" style="background:${c};"></div>`;
    }).join('');

    const lockIcon = d.locked ? '🔒' : '🔓';
    panel.innerHTML = `
        <div class="draw-panel-colors">${colorsHtml}</div>
        <button class="draw-panel-btn" data-action="lock" title="${d.locked ? 'Unlock' : 'Lock'}">${lockIcon}</button>
        <button class="draw-panel-btn draw-panel-delete" data-action="delete" title="Delete">✕</button>
    `;

    chartEl.appendChild(panel);

    // Color click
    panel.querySelectorAll('.draw-color-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            changeDrawingColor(d.id, dot.dataset.color);
        });
    });

    // Lock
    panel.querySelector('[data-action="lock"]').addEventListener('click', (e) => {
        e.stopPropagation();
        d.locked = !d.locked;
        persistDrawings();
        showDrawingPanel(d); // refresh
    });

    // Delete
    panel.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteDrawing(d.id);
    });
}

function hideDrawingPanel() {
    const p = document.getElementById('drawPanel');
    if (p) p.remove();
}

function changeDrawingColor(id, color) {
    const d = draw.drawings.find(dd => dd.id === id);
    if (!d) return;
    d.color = color;

    // Recreate with new color
    if (d.type === 'hline' && d.priceLine && modal.series) {
        const price = d.data.price;
        try { modal.series.removePriceLine(d.priceLine); } catch(e) {}
        d.priceLine = modal.series.createPriceLine({
            price, color, lineWidth: 1, lineStyle: 0,
            axisLabelVisible: true, title: '',
        });
    } else if ((d.type === 'ray' || d.type === 'trendline') && d.lineSeries) {
        d.lineSeries.applyOptions({ color });
    } else if (d.type === 'fib' && d.fibLines && modal.series) {
        // Fib: recreate all lines with proportional colors based on selected
        // Keep original fib colors but tint — simpler: just update each line
        d.fibLines.forEach(fl => {
            try { modal.series.removePriceLine(fl); } catch(e) {}
        });
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const labels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%'];
        const diff = d.data.p2 - d.data.p1;
        d.fibLines = levels.map((lvl, i) => {
            const price = d.data.p1 + diff * lvl;
            return modal.series.createPriceLine({
                price, color, lineWidth: 1, lineStyle: 2,
                axisLabelVisible: true, title: labels[i],
            });
        });
    }
    persistDrawings();
    showDrawingPanel(d); // refresh panel
}

// Find drawing near a price (for click-to-select)
function findDrawingNearPrice(price) {
    if (!modal.series) return null;
    const threshold = Math.abs(price) * 0.005; // 0.5% tolerance

    for (const d of draw.drawings) {
        if (d.type === 'hline' && d.data) {
            if (Math.abs(d.data.price - price) < threshold) return d;
        }
        if (d.type === 'fib' && d.data) {
            const diff = d.data.p2 - d.data.p1;
            const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            for (const lvl of levels) {
                const fibPrice = d.data.p1 + diff * lvl;
                if (Math.abs(fibPrice - price) < threshold) return d;
            }
        }
    }
    return null;
}

// Save current drawings to localStorage
function persistDrawings() {
    if (modal.currentSym) {
        drawStore.save(modal.currentSym, draw.drawings);
    }
}

// Restore drawings from localStorage for current symbol
function restoreDrawings() {
    if (!modal.currentSym || !modal.series || !modal.chart) return;
    const saved = drawStore.load(modal.currentSym);
    saved.forEach(s => {
        if (s.type === 'hline') {
            drawHorizontalLine(s.data.price, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'ray' || s.type === 'trendline') {
            drawTwoPointLine(s.type, s.data.t1, s.data.p1, s.data.t2, s.data.p2, s.color);
            const d = draw.drawings[draw.drawings.length - 1];
            d.locked = s.locked;
        } else if (s.type === 'fib') {
            drawFibonacci(s.data.p1, s.data.p2, s.color);
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
    const chartEl = el('cmChartBody');
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
// Drawing — click handlers on modal chart
// ============================================
function setupDrawingHandlers() {
    const chartEl = el('cmChartBody');
    if (!chartEl) return;

    // Remove old listeners by replacing element reference approach — use data attribute
    if (chartEl.dataset.drawInit) return;
    chartEl.dataset.drawInit = '1';

    // Unified handler for both click and touch
    function handleDrawClick(clientX, clientY) {
        if (!modal.chart || !modal.series) return;
        if (draw.activeTool === 'cursor' || draw.activeTool === 'ruler') return;

        const rect = chartEl.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const price = modal.series.coordinateToPrice(y);
        const time = modal.chart.timeScale().coordinateToTime(x);
        if (price === null || time === null) return;

        if (draw.activeTool === 'hline') {
            drawHorizontalLine(price);
            draw.activeTool = 'cursor';
            renderDrawToolbar();
            updateModalCursor();
        } else if (draw.activeTool === 'ray' || draw.activeTool === 'trendline') {
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
        }
    }

    // Desktop click
    chartEl.addEventListener('click', (e) => {
        if (draw.activeTool === 'cursor') {
            // Select/deselect drawing
            const rect = chartEl.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const price = modal.series ? modal.series.coordinateToPrice(y) : null;
            if (price !== null) {
                const found = findDrawingNearPrice(price);
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
            persistDrawings();
            updateModalCursor();
            return;
        }
        if (draw.activeTool === 'cursor') {
            // Select drawing on tap
            const touch = e.changedTouches[0];
            if (!touch) return;
            const rect = chartEl.getBoundingClientRect();
            const y = touch.clientY - rect.top;
            const price = modal.series ? modal.series.coordinateToPrice(y) : null;
            if (price !== null) {
                const found = findDrawingNearPrice(price);
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

    // Drag support for hline — mousedown
    chartEl.addEventListener('mousedown', (e) => {
        if (draw.activeTool !== 'cursor' || draw.selected === null) return;
        const d = draw.drawings.find(dd => dd.id === draw.selected);
        if (!d || d.locked || d.type !== 'hline') return;

        const rect = chartEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const price = modal.series ? modal.series.coordinateToPrice(y) : null;
        if (price === null) return;
        const threshold = Math.abs(d.data.price) * 0.005;
        if (Math.abs(price - d.data.price) > threshold) return;

        e.preventDefault();
        draw.dragging = true;
        draw.dragStartY = e.clientY;
        draw.dragStartPrice = d.data.price;
        if (modal.chart) modal.chart.applyOptions({ handleScroll: false, handleScale: false });
    });

    // Drag — mousemove
    chartEl.addEventListener('mousemove', (e) => {
        if (draw.dragging && draw.selected !== null) {
            const d = draw.drawings.find(dd => dd.id === draw.selected);
            if (!d || d.type !== 'hline') return;
            const rect = chartEl.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const newPrice = modal.series ? modal.series.coordinateToPrice(y) : null;
            if (newPrice === null) return;

            // Update price line
            try { modal.series.removePriceLine(d.priceLine); } catch(ex) {}
            d.priceLine = modal.series.createPriceLine({
                price: newPrice, color: d.color, lineWidth: 1, lineStyle: 0,
                axisLabelVisible: true, title: '',
            });
            d.data.price = newPrice;
        }
    });

    // Drag — mouseup
    chartEl.addEventListener('mouseup', () => {
        if (draw.dragging) {
            draw.dragging = false;
            persistDrawings();
            updateModalCursor();
        }
    });

    // Touch drag for hline
    chartEl.addEventListener('touchstart', (e) => {
        if (draw.activeTool !== 'cursor' || draw.selected === null) return;
        const d = draw.drawings.find(dd => dd.id === draw.selected);
        if (!d || d.locked || d.type !== 'hline') return;

        const touch = e.touches[0];
        const rect = chartEl.getBoundingClientRect();
        const y = touch.clientY - rect.top;
        const price = modal.series ? modal.series.coordinateToPrice(y) : null;
        if (price === null) return;
        const threshold = Math.abs(d.data.price) * 0.008;
        if (Math.abs(price - d.data.price) > threshold) return;

        e.preventDefault();
        draw.dragging = true;
        if (modal.chart) modal.chart.applyOptions({ handleScroll: false, handleScale: false });
    }, { passive: false });

    chartEl.addEventListener('touchmove', (e) => {
        if (draw.dragging && draw.selected !== null) {
            e.preventDefault();
            const d = draw.drawings.find(dd => dd.id === draw.selected);
            if (!d || d.type !== 'hline') return;
            const touch = e.touches[0];
            const rect = chartEl.getBoundingClientRect();
            const y = touch.clientY - rect.top;
            const newPrice = modal.series ? modal.series.coordinateToPrice(y) : null;
            if (newPrice === null) return;

            try { modal.series.removePriceLine(d.priceLine); } catch(ex) {}
            d.priceLine = modal.series.createPriceLine({
                price: newPrice, color: d.color, lineWidth: 1, lineStyle: 0,
                axisLabelVisible: true, title: '',
            });
            d.data.price = newPrice;
        }
    }, { passive: false });

    // Live preview for 2-click tools
    chartEl.addEventListener('mousemove', (e) => {
        if (!modal.chart || !modal.series) return;
        if (draw.clickCount !== 1) return;
        if (draw.activeTool !== 'ray' && draw.activeTool !== 'trendline' && draw.activeTool !== 'fib') return;

        const rect = chartEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const price = modal.series.coordinateToPrice(y);
        if (price === null) return;

        const canvas = getPreviewCanvas();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        canvas.width = chartEl.clientWidth;
        canvas.height = chartEl.clientHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const startY2 = modal.series.priceToCoordinate(draw.startPrice);
        const startX2 = modal.chart.timeScale().timeToCoordinate(draw.startTime);
        if (startY2 === null || startX2 === null) return;

        ctx.strokeStyle = '#5b9cf6';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);

        if (draw.activeTool === 'fib') {
            // Preview fib levels
            const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            const fibColors = ['#787b86', '#f44336', '#ff9800', '#4caf50', '#2196f3', '#9c27b0', '#787b86'];
            const diff = price - draw.startPrice;
            levels.forEach((lvl, i) => {
                const fibPrice = draw.startPrice + diff * lvl;
                const fibY = modal.series.priceToCoordinate(fibPrice);
                if (fibY === null) return;
                ctx.strokeStyle = fibColors[i];
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(0, fibY);
                ctx.lineTo(canvas.width, fibY);
                ctx.stroke();
                ctx.fillStyle = fibColors[i];
                ctx.font = '10px Inter, sans-serif';
                ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${fibPrice.toFixed(getPricePrecision(fibPrice))}`, 5, fibY - 3);
            });
        } else {
            // Preview line/ray
            ctx.beginPath();
            ctx.moveTo(startX2, startY2);
            if (draw.activeTool === 'ray') {
                // Extend ray to edge
                const dx = x - startX2;
                const dy = y - startY2;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len > 0) {
                    const scale = Math.max(canvas.width, canvas.height) * 2 / len;
                    ctx.lineTo(startX2 + dx * scale, startY2 + dy * scale);
                }
            } else {
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    });
}

// ============================================
// Drawing implementations
// ============================================
function drawHorizontalLine(price, color) {
    if (!modal.series) return;
    const c = color || '#5b9cf6';
    const priceLine = modal.series.createPriceLine({
        price: price,
        color: c,
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: '',
    });
    draw.drawings.push({ id: ++drawIdCounter, type: 'hline', color: c, locked: false, priceLine, data: { price } });
    persistDrawings();
}

function drawTwoPointLine(type, t1, p1, t2, p2, color) {
    if (!modal.chart) return;
    const c = color || '#5b9cf6';
    const points = [];
    const dt = t2 - t1;
    const dp = p2 - p1;

    if (type === 'ray') {
        // Create many points extending forward
        const steps = 1000;
        const stepSize = Math.max(Math.abs(dt), 60) / 10;
        for (let i = 0; i <= steps; i++) {
            const ratio = i / 10;
            points.push({
                time: Math.round(t1 + dt * ratio),
                value: p1 + dp * ratio
            });
        }
    } else {
        // Trendline: just 2 points
        points.push({ time: t1, value: p1 });
        points.push({ time: t2, value: p2 });
    }

    // Deduplicate by time (LightweightCharts requires unique times)
    const seen = new Set();
    const uniquePoints = points.filter(p => {
        if (seen.has(p.time)) return false;
        seen.add(p.time);
        return true;
    }).sort((a, b) => a.time - b.time);

    const lineSeries = modal.chart.addLineSeries({
        color: c,
        lineWidth: 1.5,
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

function drawFibonacci(p1, p2, color) {
    if (!modal.series) return;
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const defaultColors = ['#787b86', '#f44336', '#ff9800', '#4caf50', '#2196f3', '#9c27b0', '#787b86'];
    const labels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%'];
    const diff = p2 - p1;
    const fibLines = [];

    levels.forEach((lvl, i) => {
        const price = p1 + diff * lvl;
        const priceLine = modal.series.createPriceLine({
            price: price,
            color: color || defaultColors[i],
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: labels[i],
        });
        fibLines.push(priceLine);
    });

    const savedColor = color || defaultColors[3];
    draw.drawings.push({ id: ++drawIdCounter, type: 'fib', color: savedColor, locked: false, fibLines, priceLine: null, data: { p1, p2 } });
    persistDrawings();
}

function closeCoinModal() {
    el('coinModal').classList.add('hidden');
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
    }
    modal.currentSym = null;
    // Clear drawing chart objects (data already persisted in localStorage)
    draw.drawings = [];
    draw.selected = null;
    draw.activeTool = 'cursor';
    draw.clickCount = 0;
    hideDrawingPanel();
    removePreviewOverlay();
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
    });
}
