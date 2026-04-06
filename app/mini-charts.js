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
    filters: { minVol: 50, minNatr: 0, minTrades: 0 },
    ws: null,            // Binance kline WebSocket
    wsStreams: new Set(), // currently subscribed streams
    wsPending: new Set() // streams waiting to subscribe
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
        const res = await fetch(`/api/klines?symbol=${sym}&interval=${tf}&limit=300`);
        const json = await res.json();

        if (!Array.isArray(json)) return;

        const data = json.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
        }));

        if (!mc.charts[sym]) return; // check again after await

        const series = mc.charts[sym].series;
        series.setData(data);
        mc.loadedData[sym] = true;

        // Show last ~80 candles (rest is scrollable history)
        const visibleBars = 80;
        const from = Math.max(0, data.length - visibleBars);
        mc.charts[sym].chart.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 });

        // Subscribe to live kline updates
        wsSubscribe(sym);

        setTimeout(() => {
            if (mc.charts[sym]) {
                mc.charts[sym].chart.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 });
            }
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
            const sym = k.s; // e.g. BTCUSDT
            if (!mc.charts[sym]) return;

            // Update the last candle in realtime
            mc.charts[sym].series.update({
                time: Math.floor(k.t / 1000),
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
            });
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
        // Show last 150 bars, rest is scrollable history
        const visibleBars = 150;
        const from = Math.max(0, data.length - visibleBars);
        modal.chart.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 });
        setTimeout(() => {
            if (modal.chart) {
                modal.chart.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 });
            }
        }, 150);

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
