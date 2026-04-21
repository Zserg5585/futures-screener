// Drawing Manager integration with lightweight-charts-drawing library
// Wraps LightweightChartsDrawing.DrawingManager for our multi-chart setup

const DM = (() => {
    const LCD = window.LightweightChartsDrawing;
    if (!LCD) {
        console.warn('[DrawingManager] LightweightChartsDrawing not loaded');
        return null;
    }

    const STORE_KEY = 'fs_dm_drawings'; // separate from old mc_drawings
    let manager = null;
    let currentSym = null;
    let currentChart = null;
    let currentSeries = null;
    let currentContainer = null;

    // Tool name mapping: our toolbar IDs → library tool types
    const TOOL_MAP = {
        'hline': 'horizontal-line',
        'ray': 'horizontal-ray',
        'trendline': 'trend-line',
        'fib': 'fib-retracement',
        'rect': 'rectangle',
        'cursor': null, // deactivates tool
    };

    function attach(chart, series, container, sym) {
        // Detach previous if exists
        detach();

        currentChart = chart;
        currentSeries = series;
        currentContainer = container;
        currentSym = sym;

        try {
            manager = new LCD.DrawingManager();
            manager.attach(chart, series, container);

            // Load saved drawings for this symbol
            loadDrawings(sym);

            // Auto-save on changes
            manager.on('drawing:created', () => saveDrawings(sym));
            manager.on('drawing:modified', () => saveDrawings(sym));
            manager.on('drawing:removed', () => saveDrawings(sym));

            console.log(`[DM] Attached to ${sym}`);
        } catch (e) {
            console.error('[DM] Failed to attach:', e);
            manager = null;
        }
    }

    function detach() {
        if (manager) {
            // Save before detaching
            if (currentSym) saveDrawings(currentSym);
            try {
                manager.detach();
            } catch (e) {}
            manager = null;
        }
        currentChart = null;
        currentSeries = null;
        currentContainer = null;
    }

    function setTool(toolId) {
        if (!manager) return false;

        if (toolId === 'cursor' || !TOOL_MAP[toolId]) {
            manager.setActiveTool(null);
            return true;
        }

        const libTool = TOOL_MAP[toolId];
        if (libTool) {
            try {
                manager.setActiveTool(libTool);
                return true;
            } catch (e) {
                console.warn('[DM] Tool not available:', libTool, e);
                return false;
            }
        }
        return false;
    }

    function clearAll() {
        if (!manager) return;
        manager.clearAll();
        if (currentSym) saveDrawings(currentSym);
    }

    function deleteSelected() {
        if (!manager) return;
        const sel = manager.getSelectedDrawing();
        if (sel) {
            manager.removeDrawing(sel.id);
            if (currentSym) saveDrawings(currentSym);
        }
    }

    // Persistence
    function loadStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
    }

    function saveDrawings(sym) {
        if (!manager || !sym) return;
        try {
            const store = loadStore();
            store[sym] = manager.exportDrawings();
            localStorage.setItem(STORE_KEY, JSON.stringify(store));
        } catch (e) {
            console.warn('[DM] Save failed:', e);
        }
    }

    function loadDrawings(sym) {
        if (!manager || !sym) return;
        try {
            const store = loadStore();
            const data = store[sym];
            if (data) {
                manager.importDrawings(data);
            }
        } catch (e) {
            console.warn('[DM] Load failed:', e);
        }
    }

    function isActive() {
        return !!manager;
    }

    function getManager() {
        return manager;
    }

    return {
        attach,
        detach,
        setTool,
        clearAll,
        deleteSelected,
        isActive,
        getManager,
        TOOL_MAP,
    };
})();
