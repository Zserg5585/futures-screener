// Drawing Manager — integrates lightweight-charts-drawing library
// Features: click-to-create, drag, settings popup, price alerts, fib levels/colors

const DM = (() => {
    const LCD = window.LightweightChartsDrawing;
    if (!LCD) {
        console.warn('[DM] LightweightChartsDrawing library not loaded');
        return null;
    }

    const registry = LCD.getToolRegistry();
    if (!registry) {
        console.warn('[DM] ToolRegistry not available');
        return null;
    }

    const STORE_KEY = 'fs_dm_drawings';
    const ALERT_KEY = 'fs_dm_alerts';     // {drawingId: {sym, price, color}}
    const FIB_CFG_KEY = 'fs_fib_config';  // {levels: [...], colors: {...}}
    let manager = null;
    let currentSym = null;
    let currentChart = null;
    let currentSeries = null;
    let currentContainer = null;

    // Tool state
    let activeTool = null;
    let pendingAnchors = [];
    let requiredAnchors = 0;
    let _onToolDone = null;

    // Our toolbar IDs → library tool types
    const TOOL_MAP = {
        'hline': 'horizontal-line',
        'ray': 'horizontal-ray',
        'trendline': 'trend-line',
        'fib': 'fib-retracement',
        'rect': 'rectangle',
        'cursor': null,
    };

    // Default styles
    const DEFAULT_STYLES = {
        'horizontal-line': { lineColor: '#2962FF', lineWidth: 2 },
        'horizontal-ray': { lineColor: '#FF6D00', lineWidth: 2 },
        'trend-line': { lineColor: '#2962FF', lineWidth: 2 },
        'fib-retracement': { lineColor: '#9C27B0', lineWidth: 1 },
        'rectangle': { lineColor: '#00BCD4', lineWidth: 1, fillColor: 'rgba(0,188,212,0.15)' },
    };

    const COLOR_PRESETS = [
        '#2962FF', '#FF6D00', '#E91E63', '#00BCD4',
        '#4CAF50', '#FF5252', '#9C27B0', '#FFD600',
        '#FFFFFF', '#B0BEC5',
    ];
    const WIDTH_OPTIONS = [1, 2, 3, 4];
    const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
    const DEFAULT_FIB_COLORS = {
        '0': '#787B86', '0.236': '#F44336', '0.382': '#4CAF50', '0.5': '#FF9800',
        '0.618': '#2962FF', '0.786': '#9C27B0', '1': '#787B86',
        '1.618': '#00BCD4', '2.618': '#E91E63',
    };

    let _clickUnsub = null;
    let _idCounter = 0;
    let _settingsEl = null;

    function _genId() { return `dm_${Date.now()}_${++_idCounter}`; }

    // ── Fib Config Persistence ──────────────────────────

    function _loadFibConfig() {
        try {
            const raw = localStorage.getItem(FIB_CFG_KEY);
            if (raw) {
                const c = JSON.parse(raw);
                return {
                    levels: c.levels || DEFAULT_FIB_LEVELS,
                    colors: c.colors || DEFAULT_FIB_COLORS,
                };
            }
        } catch (e) {}
        return { levels: [...DEFAULT_FIB_LEVELS], colors: { ...DEFAULT_FIB_COLORS } };
    }

    function _saveFibConfig(cfg) {
        try { localStorage.setItem(FIB_CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
    }

    // ── Alert Persistence ───────────────────────────────

    function _loadAlerts() {
        try { return JSON.parse(localStorage.getItem(ALERT_KEY) || '{}'); } catch { return {}; }
    }

    function _saveAlerts(alerts) {
        try { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); } catch (e) {}
    }

    // ── Attach / Detach ─────────────────────────────────

    function attach(chart, series, container, sym, onToolDone) {
        detach();
        currentChart = chart;
        currentSeries = series;
        currentContainer = container;
        currentSym = sym;
        _onToolDone = onToolDone || null;

        try {
            manager = new LCD.DrawingManager();
            manager.attach(chart, series, container);

            _clickUnsub = (param) => _handleChartClick(param);
            chart.subscribeClick(_clickUnsub);

            manager.on('drawing:added', () => _save(sym));
            manager.on('drawing:updated', () => _save(sym));
            manager.on('drawing:removed', () => _save(sym));

            _load(sym);
            console.log(`[DM] Attached to ${sym}`);
        } catch (e) {
            console.error('[DM] Attach failed:', e);
            manager = null;
        }
    }

    function detach() {
        _cancelPending();
        _hideSettings();
        if (manager && currentChart && _clickUnsub) {
            try { currentChart.unsubscribeClick(_clickUnsub); } catch (e) {}
        }
        if (manager) {
            if (currentSym) _save(currentSym);
            try { manager.detach(); } catch (e) {}
            manager = null;
        }
        _clickUnsub = null;
        currentChart = null;
        currentSeries = null;
        currentContainer = null;
        activeTool = null;
        _onToolDone = null;
    }

    // ── Tool Selection ──────────────────────────────────

    function setTool(toolId) {
        if (!manager) return false;
        _cancelPending();
        _hideSettings();

        const libType = TOOL_MAP[toolId];
        if (toolId === 'cursor' || libType === undefined) {
            activeTool = null;
            manager.setActiveTool(null);
            return true;
        }

        const def = registry.get(libType);
        if (!def) return false;

        activeTool = libType;
        requiredAnchors = def.requiredAnchors;
        pendingAnchors = [];
        manager.setActiveTool(libType);
        return true;
    }

    // ── Click Handler ───────────────────────────────────

    function _handleChartClick(param) {
        if (!activeTool) {
            _handleSelectionClick(param);
            return;
        }
        if (!manager || !currentSeries) return;
        if (!param.time && !param.point) return;

        const time = param.time;
        let price = param.point ? currentSeries.coordinateToPrice(param.point.y) : null;
        if (time == null || price == null) return;

        pendingAnchors.push({ time, price });

        if (pendingAnchors.length >= requiredAnchors) {
            _createDrawing(activeTool, [...pendingAnchors]);
            pendingAnchors = [];
            _resetToCursor();
        }
    }

    function _handleSelectionClick(param) {
        if (!manager || !param.point) return;
        setTimeout(() => {
            const sel = manager.getSelectedDrawing ? manager.getSelectedDrawing() : null;
            if (sel) {
                _showSettings(param.point.x, param.point.y, sel);
            } else {
                _hideSettings();
            }
        }, 50);
    }

    function _createDrawing(type, anchors) {
        const id = _genId();
        const style = { ...(DEFAULT_STYLES[type] || {}) };
        const opts = {};

        // Apply custom fib config
        if (type === 'fib-retracement') {
            const cfg = _loadFibConfig();
            opts.levels = cfg.levels;
        }

        try {
            const drawing = registry.createDrawing(type, id, anchors, style, opts);
            if (drawing) {
                // Apply per-level fib colors
                if (type === 'fib-retracement' && drawing.setFibOptions) {
                    const cfg = _loadFibConfig();
                    // Library uses levels array, colors applied via line style per level
                    drawing.setFibOptions({ levels: cfg.levels });
                }
                manager.addDrawing(drawing);
            }
        } catch (e) {
            console.error(`[DM] Failed to create ${type}:`, e);
        }
    }

    function _resetToCursor() {
        activeTool = null;
        pendingAnchors = [];
        if (manager) manager.setActiveTool(null);
        if (_onToolDone) _onToolDone();
    }

    function _cancelPending() { pendingAnchors = []; }

    // ── Settings Popup ──────────────────────────────────

    function _showSettings(x, y, drawing) {
        _hideSettings();
        if (!currentContainer) return;

        const popup = document.createElement('div');
        popup.className = 'dm-settings';
        const cRect = currentContainer.getBoundingClientRect();
        let left = Math.min(x + 10, cRect.width - 200);
        let top = Math.max(y - 100, 10);
        popup.style.cssText = `position:absolute;left:${left}px;top:${top}px;z-index:1000;
            background:#1e222d;border:1px solid #363a45;border-radius:8px;padding:10px;
            display:flex;flex-direction:column;gap:6px;box-shadow:0 4px 16px rgba(0,0,0,0.5);
            min-width:170px;font-size:12px;`;

        // ─ Color row
        const colorRow = document.createElement('div');
        colorRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
        const currentColor = drawing._style?.lineColor || '#2962FF';
        COLOR_PRESETS.forEach(c => {
            const sw = document.createElement('div');
            sw.style.cssText = `width:20px;height:20px;border-radius:4px;cursor:pointer;
                background:${c};border:2px solid ${c === currentColor ? '#fff' : 'transparent'};`;
            sw.onclick = (e) => {
                e.stopPropagation();
                try { drawing.applyStyle({ lineColor: c }); } catch (err) {}
                _save(currentSym);
                _showSettings(x, y, drawing);
            };
            colorRow.appendChild(sw);
        });
        popup.appendChild(colorRow);

        // ─ Width row
        const widthRow = document.createElement('div');
        widthRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
        const wl = document.createElement('span');
        wl.textContent = 'Width';
        wl.style.cssText = 'color:#787b86;font-size:11px;margin-right:4px;';
        widthRow.appendChild(wl);
        const currentWidth = drawing._style?.lineWidth || 2;
        WIDTH_OPTIONS.forEach(w => {
            const btn = document.createElement('div');
            btn.style.cssText = `width:24px;height:20px;display:flex;align-items:center;justify-content:center;
                cursor:pointer;border-radius:4px;font-size:11px;color:#d1d4dc;
                background:${w === currentWidth ? '#363a45' : 'transparent'};`;
            btn.textContent = w;
            btn.onclick = (e) => {
                e.stopPropagation();
                try { drawing.applyStyle({ lineWidth: w }); } catch (err) {}
                _save(currentSym);
                _showSettings(x, y, drawing);
            };
            widthRow.appendChild(btn);
        });
        popup.appendChild(widthRow);

        // ─ Alert toggle (for line-type drawings)
        const isLine = ['horizontal-line', 'horizontal-ray', 'trend-line'].includes(drawing.type);
        if (isLine) {
            const alerts = _loadAlerts();
            const hasAlert = !!alerts[drawing.id];
            const alertRow = document.createElement('div');
            alertRow.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0;';
            alertRow.innerHTML = `<span style="font-size:14px">${hasAlert ? '🔔' : '🔕'}</span>
                <span style="color:${hasAlert ? '#FFD600' : '#787b86'}">Price Alert ${hasAlert ? 'ON' : 'OFF'}</span>`;
            alertRow.onclick = (e) => {
                e.stopPropagation();
                const al = _loadAlerts();
                if (al[drawing.id]) {
                    delete al[drawing.id];
                } else {
                    // Get price from first anchor
                    const price = drawing._anchors?.[0]?.price;
                    const color = drawing._style?.lineColor || '#2962FF';
                    if (price != null) {
                        al[drawing.id] = { sym: currentSym, price, color };
                    }
                }
                _saveAlerts(al);
                _showSettings(x, y, drawing);
            };
            popup.appendChild(alertRow);
        }

        // ─ Fib settings (for fib-retracement)
        if (drawing.type === 'fib-retracement') {
            _appendFibSettings(popup, drawing);
        }

        // ─ Delete button
        const delRow = document.createElement('div');
        delRow.style.cssText = `display:flex;align-items:center;justify-content:center;gap:4px;
            padding:4px 0;cursor:pointer;color:#FF5252;border-top:1px solid #363a45;
            margin-top:2px;padding-top:6px;`;
        delRow.innerHTML = '🗑 Delete';
        delRow.onclick = (e) => {
            e.stopPropagation();
            // Clean up alert if exists
            const al = _loadAlerts();
            if (al[drawing.id]) { delete al[drawing.id]; _saveAlerts(al); }
            manager.removeDrawing(drawing.id);
            _save(currentSym);
            _hideSettings();
        };
        popup.appendChild(delRow);

        // Close on outside click
        setTimeout(() => {
            popup._closeHandler = (e) => {
                if (!popup.contains(e.target)) _hideSettings();
            };
            document.addEventListener('click', popup._closeHandler, { capture: true, once: true });
        }, 100);

        currentContainer.appendChild(popup);
        _settingsEl = popup;
    }

    // ── Fib Level Settings ──────────────────────────────

    function _appendFibSettings(popup, drawing) {
        const cfg = _loadFibConfig();
        const header = document.createElement('div');
        header.style.cssText = 'color:#787b86;font-size:11px;border-top:1px solid #363a45;padding-top:6px;margin-top:2px;';
        header.textContent = 'Fibonacci Levels';
        popup.appendChild(header);

        const levelsWrap = document.createElement('div');
        levelsWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;max-height:200px;overflow-y:auto;';

        cfg.levels.forEach((lvl, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:4px;';

            // Color swatch for this level
            const key = String(lvl);
            const lvlColor = cfg.colors[key] || '#787B86';
            const colorBtn = document.createElement('div');
            colorBtn.style.cssText = `width:16px;height:16px;border-radius:3px;cursor:pointer;
                background:${lvlColor};border:1px solid #555;flex-shrink:0;`;
            colorBtn.title = `Color for ${lvl}`;
            colorBtn.onclick = (e) => {
                e.stopPropagation();
                _showColorPicker(colorBtn, lvlColor, (newColor) => {
                    cfg.colors[key] = newColor;
                    _saveFibConfig(cfg);
                    // Update drawing if possible
                    _applyFibColors(drawing, cfg);
                    colorBtn.style.background = newColor;
                });
            };
            row.appendChild(colorBtn);

            // Level value
            const valSpan = document.createElement('span');
            valSpan.style.cssText = 'color:#d1d4dc;font-size:11px;min-width:40px;';
            valSpan.textContent = lvl === 0 ? '0' : lvl;
            row.appendChild(valSpan);

            // Remove button
            if (lvl !== 0 && lvl !== 1) {
                const rmBtn = document.createElement('span');
                rmBtn.style.cssText = 'color:#FF5252;cursor:pointer;font-size:13px;margin-left:auto;';
                rmBtn.textContent = '✕';
                rmBtn.onclick = (e) => {
                    e.stopPropagation();
                    cfg.levels.splice(i, 1);
                    delete cfg.colors[key];
                    _saveFibConfig(cfg);
                    if (drawing.setFibOptions) drawing.setFibOptions({ levels: cfg.levels });
                    _save(currentSym);
                    // Refresh popup
                    _hideSettings();
                };
                row.appendChild(rmBtn);
            }

            levelsWrap.appendChild(row);
        });

        popup.appendChild(levelsWrap);

        // Add level button
        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '0.01';
        inp.placeholder = 'e.g. 1.272';
        inp.style.cssText = 'width:70px;background:#131722;border:1px solid #363a45;border-radius:4px;color:#d1d4dc;padding:2px 4px;font-size:11px;';
        const addBtn = document.createElement('span');
        addBtn.textContent = '+ Add';
        addBtn.style.cssText = 'color:#4CAF50;cursor:pointer;font-size:11px;';
        addBtn.onclick = (e) => {
            e.stopPropagation();
            const v = parseFloat(inp.value);
            if (isNaN(v) || cfg.levels.includes(v)) return;
            cfg.levels.push(v);
            cfg.levels.sort((a, b) => a - b);
            cfg.colors[String(v)] = '#2962FF';
            _saveFibConfig(cfg);
            if (drawing.setFibOptions) drawing.setFibOptions({ levels: cfg.levels });
            _save(currentSym);
            _hideSettings();
        };
        addRow.appendChild(inp);
        addRow.appendChild(addBtn);

        // Reset button
        const resetBtn = document.createElement('span');
        resetBtn.textContent = 'Reset';
        resetBtn.style.cssText = 'color:#787b86;cursor:pointer;font-size:11px;margin-left:auto;';
        resetBtn.onclick = (e) => {
            e.stopPropagation();
            _saveFibConfig({ levels: [...DEFAULT_FIB_LEVELS], colors: { ...DEFAULT_FIB_COLORS } });
            if (drawing.setFibOptions) drawing.setFibOptions({ levels: DEFAULT_FIB_LEVELS });
            _save(currentSym);
            _hideSettings();
        };
        addRow.appendChild(resetBtn);
        popup.appendChild(addRow);
    }

    function _applyFibColors(drawing, cfg) {
        // Library uses a single lineColor style; per-level colors need to be set via levels array
        // The library doesn't natively support per-level colors, but we store them for reference
        // Apply the primary color from the 0.618 level as main lineColor
        const primary = cfg.colors['0.618'] || cfg.colors['0.5'] || '#2962FF';
        try { drawing.applyStyle({ lineColor: primary }); } catch (e) {}
        _save(currentSym);
    }

    // Mini color picker dropdown
    function _showColorPicker(anchor, currentColor, onPick) {
        // Remove existing picker
        document.querySelectorAll('.dm-color-picker').forEach(el => el.remove());

        const picker = document.createElement('div');
        picker.className = 'dm-color-picker';
        const rect = anchor.getBoundingClientRect();
        const cRect = currentContainer.getBoundingClientRect();
        picker.style.cssText = `position:absolute;left:${rect.left - cRect.left}px;top:${rect.bottom - cRect.top + 4}px;
            z-index:1001;background:#1e222d;border:1px solid #363a45;border-radius:6px;padding:6px;
            display:flex;gap:3px;flex-wrap:wrap;width:130px;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;

        COLOR_PRESETS.forEach(c => {
            const sw = document.createElement('div');
            sw.style.cssText = `width:18px;height:18px;border-radius:3px;cursor:pointer;
                background:${c};border:2px solid ${c === currentColor ? '#fff' : 'transparent'};`;
            sw.onclick = (e) => {
                e.stopPropagation();
                onPick(c);
                picker.remove();
            };
            picker.appendChild(sw);
        });

        setTimeout(() => {
            const handler = (e) => {
                if (!picker.contains(e.target)) picker.remove();
                document.removeEventListener('click', handler, true);
            };
            document.addEventListener('click', handler, { capture: true });
        }, 50);

        currentContainer.appendChild(picker);
    }

    function _hideSettings() {
        if (_settingsEl) {
            if (_settingsEl._closeHandler) {
                document.removeEventListener('click', _settingsEl._closeHandler, { capture: true });
            }
            _settingsEl.remove();
            _settingsEl = null;
        }
        document.querySelectorAll('.dm-color-picker').forEach(el => el.remove());
    }

    // ── Actions ─────────────────────────────────────────

    function clearAll() {
        if (!manager) return;
        _cancelPending();
        _hideSettings();
        // Clean up all alerts for this symbol
        const al = _loadAlerts();
        let changed = false;
        for (const [id, a] of Object.entries(al)) {
            if (a.sym === currentSym) { delete al[id]; changed = true; }
        }
        if (changed) _saveAlerts(al);
        manager.clearAll();
        if (currentSym) _save(currentSym);
    }

    function deleteSelected() {
        if (!manager) return;
        _hideSettings();
        const sel = manager.getSelectedDrawing();
        if (sel) {
            const al = _loadAlerts();
            if (al[sel.id]) { delete al[sel.id]; _saveAlerts(al); }
            manager.removeDrawing(sel.id);
            if (currentSym) _save(currentSym);
        }
    }

    // ── Price Alert Checking (called from WS tick) ──────

    const alertCooldowns = {};
    const COOLDOWN_MS = 60000;
    const lastAlertPrices = {};

    function checkAlerts(sym, currentPrice) {
        const alerts = _loadAlerts();
        const prevPrice = lastAlertPrices[sym];
        lastAlertPrices[sym] = currentPrice;
        if (prevPrice === undefined) return;

        for (const [drawingId, al] of Object.entries(alerts)) {
            if (al.sym !== sym) continue;
            const alertPrice = al.price;

            const crossedUp = prevPrice < alertPrice && currentPrice >= alertPrice;
            const crossedDown = prevPrice > alertPrice && currentPrice <= alertPrice;
            if (!crossedUp && !crossedDown) continue;

            const coolKey = `${drawingId}`;
            const now = Date.now();
            if (alertCooldowns[coolKey] && now - alertCooldowns[coolKey] < COOLDOWN_MS) continue;
            alertCooldowns[coolKey] = now;

            const dir = crossedUp ? '▲ Above' : '▼ Below';
            const ticker = sym.replace('USDT', '');
            _fireAlert(sym, ticker, currentPrice, alertPrice, dir, al.color);
        }
    }

    function _fireAlert(sym, ticker, price, level, dir, color) {
        // Reuse existing showAlertToast if available (from mini-charts.js)
        if (typeof showAlertToast === 'function') {
            showAlertToast(sym, ticker, price, level, dir, color);
            return;
        }
        // Fallback: browser notification
        if (Notification.permission === 'granted') {
            new Notification(`🔔 ${ticker} ${dir} $${level.toFixed(2)}`, {
                body: `Price: $${price.toFixed(2)}`,
                icon: '/icon-192.png',
            });
        }
    }

    // ── Persistence ─────────────────────────────────────

    function _loadStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
    }

    function _save(sym) {
        if (!manager || !sym) return;
        try {
            const store = _loadStore();
            store[sym] = manager.exportDrawings();
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
        } catch (e) { console.warn('[DM] Save failed:', e); }
    }

    function _load(sym) {
        if (!manager || !sym) return;
        try {
            const store = _loadStore();
            const data = store[sym];
            if (data) manager.importDrawings(data);
        } catch (e) { console.warn('[DM] Load failed:', e); }
    }

    // ── Public API ──────────────────────────────────────

    return {
        attach, detach, setTool, clearAll, deleteSelected, checkAlerts,
        isActive: () => !!manager,
        getActiveTool: () => activeTool,
        getManager: () => manager,
        isDragging: () => manager ? manager._isDragging : false,
        TOOL_MAP,
    };
})();
