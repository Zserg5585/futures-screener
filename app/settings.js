/**
 * Settings Panel — Slide-out panel with sections
 * Sections: Charts, Densities, Signals, Layout, Reset
 * Persistence: localStorage (free) + server sync (pro, future)
 *
 * Usage: settingsPanel.get('candleType'), settingsPanel.onChange(cb)
 */
const settingsPanel = (() => {
  // --- Defaults ---
  const DEFAULTS = {
    // Charts
    candleType: 'Candlestick', // Candlestick, Bar, Line, Area
    logScale: false,
    volumeHeight: 15,          // % of chart
    barWidth: 2,               // thin=1, normal=2, wide=3
    showGrid: true,
    showWatermark: true,
    defaultTF: '5m',           // default timeframe

    // Sidebar & Grid
    cardsPerRow: 4,            // 3, 4, 5, 6
    cardSize: 'normal',        // compact, normal, large
    colChg: true,              // show Chg% column
    colNatr: true,             // show NATR column
    colVol: true,              // show Vol column

    // Watchlist
    watchlistOnly: false,      // show only watchlist coins in sidebar

    // Theme
    theme: 'dark',             // dark, darker, amoled
    candleUp: '#22c55e',       // green
    candleDown: '#ef4444',     // red

    // Densities
    densityEnabled: true,
    densitySeverityLarge: 5.0,    // multiplier for Large
    densitySeverityMedium: 3.5,   // multiplier for Medium
    densitySeveritySmall: 2.0,    // multiplier for Small
    densityDepthPct: 3.0,         // depth % from price
    densityTTLMin: 15,            // min lifetime in minutes

    // Signals
    signalMinRatio: 3,            // volume spike min ratio (2x-20x)
    signalNotifications: false,   // browser notifications
    signalSound: false,           // sound on new signal
    signalCooldown: 5,            // minutes between same-symbol alerts (1, 5, 15, 30)
    signalWatchlistOnly: false,   // only show signals for watchlist coins

    // Data
    autoRefresh: true,            // auto-refresh data
    refreshInterval: 30,          // seconds (10, 30, 60, 120)
    defaultSort: 'change',        // change, volume, natr, symbol
    defaultSortDir: 'asc',        // asc, desc
    minVolume: 50,                // min 24h volume in $M (0=off, 10, 50, 100, 250, 500)

    // Layout
    layout: '1',              // '1', '2h', '2v', '4', '1+3'

    // Drawing defaults
    drawLineStyle: 'solid',       // solid, dashed, dotted
    drawDefaultColor: '#ffffff',
  }

  const STORAGE_KEY = 'fs_settings'
  const WL_KEY = 'fs_watchlist'
  let settings = {}
  let listeners = []
  let panelOpen = false
  let watchlist = new Set()

  // --- Watchlist ---
  function loadWatchlist() {
    try { watchlist = new Set(JSON.parse(localStorage.getItem(WL_KEY) || '[]')) } catch { watchlist = new Set() }
  }
  function saveWatchlist() { localStorage.setItem(WL_KEY, JSON.stringify([...watchlist])) }
  function wlAdd(sym) { watchlist.add(sym); saveWatchlist(); notify('__watchlist', [...watchlist]) }
  function wlRemove(sym) { watchlist.delete(sym); saveWatchlist(); notify('__watchlist', [...watchlist]) }
  function wlToggle(sym) { watchlist.has(sym) ? wlRemove(sym) : wlAdd(sym) }
  function wlHas(sym) { return watchlist.has(sym) }
  function wlList() { return [...watchlist] }
  function wlClear() { watchlist.clear(); saveWatchlist(); notify('__watchlist', []) }

  // --- Load / Save ---
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
    } catch {
      settings = { ...DEFAULTS }
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    // Future: if pro, sync to server via authUI.authFetch
  }

  function get(key) {
    return settings[key] !== undefined ? settings[key] : DEFAULTS[key]
  }

  function set(key, value) {
    settings[key] = value
    save()
    notify(key, value)
  }

  function getAll() { return { ...settings } }

  function resetAll() {
    settings = { ...DEFAULTS }
    save()
    listeners.forEach(cb => cb('__reset', null))
    renderActiveSection()
  }

  // --- Change listeners ---
  function onChange(cb) { listeners.push(cb) }
  function notify(key, value) { listeners.forEach(cb => cb(key, value)) }

  // --- Panel DOM ---
  const SECTIONS = [
    { id: 'charts',    icon: '📊', label: 'Charts' },
    { id: 'densities', icon: '◉', label: 'Densities' },
    { id: 'signals',   icon: '🔔', label: 'Signals' },
    { id: 'watchlist', icon: '⭐', label: 'Watchlist' },
    { id: 'theme',     icon: '🎨', label: 'Theme' },
    { id: 'data',      icon: '📡', label: 'Data' },
    { id: 'layout',    icon: '⊞', label: 'Layout' },
    { id: 'reset',     icon: '🗑', label: 'Reset' },
  ]
  let activeSection = 'charts'

  function createPanel() {
    // Overlay
    const overlay = document.createElement('div')
    overlay.id = 'settingsOverlay'
    overlay.className = 'settings-overlay hidden'
    overlay.addEventListener('click', closePanel)

    // Panel
    const panel = document.createElement('div')
    panel.id = 'settingsPanel'
    panel.className = 'settings-panel hidden'

    panel.innerHTML = `
      <div class="sp-header">
        <button class="sp-back hidden" id="spBack">←</button>
        <h3 class="sp-title">Settings</h3>
        <button class="sp-close" id="spClose">&times;</button>
      </div>
      <div class="sp-body">
        <div class="sp-nav" id="spNav">
          ${SECTIONS.map(s => `
            <button class="sp-nav-item${s.id === activeSection ? ' active' : ''}" data-section="${s.id}">
              <span class="sp-nav-icon">${s.icon}</span>
              <span class="sp-nav-label">${s.label}</span>
            </button>
          `).join('')}
        </div>
        <div class="sp-content" id="spContent"></div>
      </div>
    `

    document.body.appendChild(overlay)
    document.body.appendChild(panel)

    // Events
    panel.querySelector('#spClose').addEventListener('click', closePanel)
    panel.querySelector('#spBack').addEventListener('click', () => {
      panel.querySelector('#spBack').classList.add('hidden')
      panel.querySelector('.sp-title').textContent = 'Settings'
      panel.querySelector('#spNav').classList.remove('hidden')
      panel.querySelector('#spContent').innerHTML = ''
    })

    panel.querySelectorAll('.sp-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        activeSection = btn.dataset.section
        panel.querySelectorAll('.sp-nav-item').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        renderActiveSection()

        // Mobile: hide nav, show back
        if (window.innerWidth < 600) {
          panel.querySelector('#spNav').classList.add('hidden')
          panel.querySelector('#spBack').classList.remove('hidden')
          panel.querySelector('.sp-title').textContent = SECTIONS.find(s => s.id === activeSection)?.label || 'Settings'
        }
      })
    })

    renderActiveSection()
  }

  function renderActiveSection() {
    const content = document.getElementById('spContent')
    if (!content) return

    switch (activeSection) {
      case 'charts': content.innerHTML = renderChartsSection(); break
      case 'densities': content.innerHTML = renderDensitiesSection(); break
      case 'signals': content.innerHTML = renderSignalsSection(); break
      case 'watchlist': content.innerHTML = renderWatchlistSection(); break
      case 'theme': content.innerHTML = renderThemeSection(); break
      case 'data': content.innerHTML = renderDataSection(); break
      case 'layout': content.innerHTML = renderLayoutSection(); break
      case 'reset': content.innerHTML = renderResetSection(); break
    }

    bindSectionEvents(content)
  }

  // --- Section Renderers ---

  function updateCandlePreview(container, up, down) {
    container.querySelectorAll('.sp-candle.up').forEach(c => c.style.setProperty('--c', up))
    container.querySelectorAll('.sp-candle.down').forEach(c => c.style.setProperty('--c', down))
  }

  const CANDLE_PRESETS = [
    { label: 'Classic', up: '#22c55e', down: '#ef4444' },
    { label: 'Blue/Orange', up: '#3b82f6', down: '#f97316' },
    { label: 'Cyan/Pink', up: '#06b6d4', down: '#ec4899' },
    { label: 'Lime/Purple', up: '#84cc16', down: '#a855f7' },
    { label: 'TradingView', up: '#26a69a', down: '#ef5350' },
    { label: 'Monochrome', up: '#94a3b8', down: '#475569' },
  ]

  function renderThemeSection() {
    const currentUp = get('candleUp')
    const currentDown = get('candleDown')
    return `
      <div class="sp-section">
        <div class="sp-section-title">Theme</div>
        <div class="sp-radio-group">
          ${['dark', 'darker', 'amoled'].map(t => `
            <label class="sp-radio">
              <input type="radio" name="theme" value="${t}" ${get('theme') === t ? 'checked' : ''} data-key="theme" />
              <span>${t.charAt(0).toUpperCase() + t.slice(1)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Candle Colors</div>
        <div class="sp-color-presets">
          ${CANDLE_PRESETS.map(p => `
            <button class="sp-color-preset${currentUp === p.up && currentDown === p.down ? ' active' : ''}"
                    data-up="${p.up}" data-down="${p.down}" title="${p.label}">
              <span class="sp-color-dot" style="background:${p.up}"></span>
              <span class="sp-color-dot" style="background:${p.down}"></span>
              <span class="sp-color-name">${p.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Custom Colors</div>
        <div class="sp-color-row">
          <label class="sp-color-label">
            <span>Up</span>
            <input type="color" value="${currentUp}" data-key="candleUp" class="sp-color-input" />
          </label>
          <label class="sp-color-label">
            <span>Down</span>
            <input type="color" value="${currentDown}" data-key="candleDown" class="sp-color-input" />
          </label>
        </div>
        <div class="sp-candle-preview">
          <div class="sp-candle up" style="--c:${currentUp}"></div>
          <div class="sp-candle down" style="--c:${currentDown}"></div>
          <div class="sp-candle up small" style="--c:${currentUp}"></div>
          <div class="sp-candle down" style="--c:${currentDown}"></div>
          <div class="sp-candle up" style="--c:${currentUp}"></div>
          <div class="sp-candle down small" style="--c:${currentDown}"></div>
        </div>
      </div>
    `
  }

  function renderWatchlistSection() {
    const list = wlList()
    return `
      <div class="sp-section">
        <div class="sp-section-title">Your Watchlist (${list.length})</div>
        ${list.length === 0 ? `<p class="sp-hint">Click ⭐ on any coin in the sidebar to add it</p>` : `
          <div class="sp-wl-list">
            ${list.map(sym => `
              <div class="sp-wl-item">
                <span class="sp-wl-name">${sym.replace('USDT', '')}</span>
                <button class="sp-wl-remove" data-sym="${sym}" title="Remove">✕</button>
              </div>
            `).join('')}
          </div>
        `}
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Filter</div>
        <label class="sp-toggle">
          <input type="checkbox" id="spWlOnly" ${get('watchlistOnly') ? 'checked' : ''} />
          <span>Show watchlist only in sidebar</span>
        </label>
      </div>
      ${list.length > 0 ? `
        <div class="sp-section">
          <button class="sp-danger-btn" id="spClearWatchlist">Clear watchlist</button>
        </div>
      ` : ''}
    `
  }

  function renderDataSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-title">Auto-Refresh</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('autoRefresh') ? 'checked' : ''} data-key="autoRefresh" />
          <span>Enable auto-refresh</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Refresh Interval</div>
        <div class="sp-radio-group">
          ${[10, 30, 60, 120].map(s => `
            <label class="sp-radio">
              <input type="radio" name="refreshInterval" value="${s}" ${get('refreshInterval') === s ? 'checked' : ''} data-key="refreshInterval" />
              <span>${s < 60 ? s + 's' : (s / 60) + 'min'}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Default Sort</div>
        <div class="sp-radio-group">
          ${[
            { v: 'change', l: 'Chg%' },
            { v: 'volume', l: 'Volume' },
            { v: 'natr', l: 'NATR' },
            { v: 'symbol', l: 'Name' },
          ].map(s => `
            <label class="sp-radio">
              <input type="radio" name="defaultSort" value="${s.v}" ${get('defaultSort') === s.v ? 'checked' : ''} data-key="defaultSort" />
              <span>${s.l}</span>
            </label>
          `).join('')}
        </div>
        <div style="margin-top:8px;">
          <div class="sp-radio-group">
            ${[
              { v: 'asc', l: '↑ Ascending' },
              { v: 'desc', l: '↓ Descending' },
            ].map(s => `
              <label class="sp-radio">
                <input type="radio" name="defaultSortDir" value="${s.v}" ${get('defaultSortDir') === s.v ? 'checked' : ''} data-key="defaultSortDir" />
                <span>${s.l}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Min 24h Volume</div>
        <div class="sp-radio-group">
          ${[
            { v: 0, l: 'Off' },
            { v: 10, l: '$10M+' },
            { v: 50, l: '$50M+' },
            { v: 100, l: '$100M+' },
            { v: 250, l: '$250M+' },
            { v: 500, l: '$500M+' },
          ].map(s => `
            <label class="sp-radio">
              <input type="radio" name="minVolume" value="${s.v}" ${get('minVolume') === s.v ? 'checked' : ''} data-key="minVolume" />
              <span>${s.l}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `
  }

  function renderLayoutSection() {
    const current = get('layout')
    const layouts = [
      { id: '1', label: '1', icon: '▣' },
      { id: '2h', label: '2', icon: '◫' },
      { id: '2v', label: '2V', icon: '⬒' },
      { id: '4', label: '2×2', icon: '⊞' },
      { id: '1+3', label: '1+3', icon: '◨' },
    ]
    return `
      <div class="sp-section">
        <div class="sp-section-title">Multi-Chart Layout</div>
        <div class="sp-layout-grid">
          ${layouts.map(l => `
            <button class="sp-layout-btn${current === l.id ? ' active' : ''}" data-key="layout" data-value="${l.id}" title="${l.label}">
              <span class="sp-layout-icon">${l.icon}</span>
              <span class="sp-layout-label">${l.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `
  }

  function renderChartsSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-title">Candle Type</div>
        <div class="sp-radio-group">
          ${['Candlestick', 'Bar', 'Line', 'Area'].map(t => `
            <label class="sp-radio">
              <input type="radio" name="candleType" value="${t}" ${get('candleType') === t ? 'checked' : ''} data-key="candleType" />
              <span>${t}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Price Scale</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('logScale') ? 'checked' : ''} data-key="logScale" />
          <span>Logarithmic scale</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Volume Height</div>
        <div class="sp-slider-row">
          <input type="range" min="5" max="40" value="${get('volumeHeight')}" data-key="volumeHeight" class="sp-slider" />
          <span class="sp-slider-val" data-for="volumeHeight">${get('volumeHeight')}%</span>
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Grid</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('showGrid') ? 'checked' : ''} data-key="showGrid" />
          <span>Show grid lines</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Watermark</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('showWatermark') ? 'checked' : ''} data-key="showWatermark" />
          <span>Show symbol watermark</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Default Timeframe</div>
        <div class="sp-radio-group">
          ${['1m', '5m', '15m', '1h', '4h', '1d'].map(t => `
            <label class="sp-radio">
              <input type="radio" name="defaultTF" value="${t}" ${get('defaultTF') === t ? 'checked' : ''} data-key="defaultTF" />
              <span>${t}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="sp-divider"></div>
      <div class="sp-section">
        <div class="sp-section-title">Cards per Row</div>
        <div class="sp-layout-grid">
          ${[1, 2, 3, 4, 5, 6].map(n => `
            <button class="sp-layout-btn${get('cardsPerRow') === n ? ' active' : ''}" data-key="cardsPerRow" data-value="${n}" title="${n} per row">
              <span class="sp-layout-label">${n}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Card Size</div>
        <div class="sp-radio-group">
          ${['compact', 'normal', 'large'].map(s => `
            <label class="sp-radio">
              <input type="radio" name="cardSize" value="${s}" ${get('cardSize') === s ? 'checked' : ''} data-key="cardSize" />
              <span>${s.charAt(0).toUpperCase() + s.slice(1)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Sidebar Columns</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('colChg') ? 'checked' : ''} data-key="colChg" />
          <span>Chg%</span>
        </label>
        <label class="sp-toggle">
          <input type="checkbox" ${get('colNatr') ? 'checked' : ''} data-key="colNatr" />
          <span>NATR</span>
        </label>
        <label class="sp-toggle">
          <input type="checkbox" ${get('colVol') ? 'checked' : ''} data-key="colVol" />
          <span>Volume</span>
        </label>
      </div>
    `
  }

  function renderDensitiesSection() {
    return `
      <div class="sp-section">
        <label class="sp-toggle">
          <input type="checkbox" ${get('densityEnabled') ? 'checked' : ''} data-key="densityEnabled" />
          <span>Show density levels on charts</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Severity Multipliers</div>
        <div class="sp-severity-row">
          <span class="sp-severity-dot large"></span>
          <span class="sp-severity-label">Large</span>
          <input type="number" value="${get('densitySeverityLarge')}" step="0.5" min="1" max="20" data-key="densitySeverityLarge" class="sp-num-input" />
          <span class="sp-severity-x">×</span>
        </div>
        <div class="sp-severity-row">
          <span class="sp-severity-dot medium"></span>
          <span class="sp-severity-label">Medium</span>
          <input type="number" value="${get('densitySeverityMedium')}" step="0.5" min="1" max="20" data-key="densitySeverityMedium" class="sp-num-input" />
          <span class="sp-severity-x">×</span>
        </div>
        <div class="sp-severity-row">
          <span class="sp-severity-dot small"></span>
          <span class="sp-severity-label">Small</span>
          <input type="number" value="${get('densitySeveritySmall')}" step="0.5" min="1" max="20" data-key="densitySeveritySmall" class="sp-num-input" />
          <span class="sp-severity-x">×</span>
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Depth from price</div>
        <div class="sp-slider-row">
          <input type="range" min="0.5" max="10" step="0.5" value="${get('densityDepthPct')}" data-key="densityDepthPct" class="sp-slider" />
          <span class="sp-slider-val" data-for="densityDepthPct">${get('densityDepthPct')}%</span>
        </div>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Min lifetime</div>
        <div class="sp-slider-row">
          <input type="range" min="1" max="60" value="${get('densityTTLMin')}" data-key="densityTTLMin" class="sp-slider" />
          <span class="sp-slider-val" data-for="densityTTLMin">${get('densityTTLMin')} min</span>
        </div>
      </div>
    `
  }

  function renderSignalsSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-title">Volume Spike Filter</div>
        <div class="sp-slider-row">
          <input type="range" min="2" max="20" step="1" value="${get('signalMinRatio')}" data-key="signalMinRatio" class="sp-slider" />
          <span class="sp-slider-val" data-for="signalMinRatio">${get('signalMinRatio')}x</span>
        </div>
        <p class="sp-hint">Show volume spikes ≥ this ratio vs SMA(20)</p>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Alert Cooldown</div>
        <div class="sp-radio-group">
          ${[1, 5, 15, 30].map(m => `
            <label class="sp-radio">
              <input type="radio" name="signalCooldown" value="${m}" ${get('signalCooldown') === m ? 'checked' : ''} data-key="signalCooldown" />
              <span>${m}min</span>
            </label>
          `).join('')}
        </div>
        <p class="sp-hint">Min time between alerts for the same symbol</p>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Filter</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('signalWatchlistOnly') ? 'checked' : ''} data-key="signalWatchlistOnly" />
          <span>Watchlist coins only</span>
        </label>
      </div>
      <div class="sp-section">
        <div class="sp-section-title">Notifications</div>
        <label class="sp-toggle">
          <input type="checkbox" ${get('signalNotifications') ? 'checked' : ''} data-key="signalNotifications" />
          <span>Browser notifications</span>
        </label>
        <label class="sp-toggle">
          <input type="checkbox" ${get('signalSound') ? 'checked' : ''} data-key="signalSound" />
          <span>Sound alert</span>
        </label>
        <p class="sp-hint">Telegram alerts coming soon</p>
      </div>
    `
  }

  function renderResetSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-title">Share Settings</div>
        <div style="display:flex; gap:8px;">
          <button class="sp-action-btn" id="spExportSettings" style="flex:1;">📤 Export</button>
          <button class="sp-action-btn" id="spImportSettings" style="flex:1;">📥 Import</button>
        </div>
        <p class="sp-hint">Export your settings as a code or import someone else's</p>
        <div id="spShareBox" class="sp-share-box hidden"></div>
      </div>
      <div class="sp-section">
        <button class="sp-danger-btn" id="spClearDrawings">Clear all drawings</button>
        <p class="sp-hint">Removes all lines, rays, fibs from all charts</p>
      </div>
      <div class="sp-section">
        <button class="sp-danger-btn orange" id="spResetSettings">Reset all settings</button>
        <p class="sp-hint">Restores all settings to defaults</p>
      </div>
    `
  }

  // --- Bind events for dynamic content ---
  function bindSectionEvents(container) {
    // Radio buttons
    const numericRadios = ['refreshInterval', 'minVolume', 'signalCooldown']
    container.querySelectorAll('input[type="radio"][data-key]').forEach(el => {
      el.addEventListener('change', () => {
        const val = numericRadios.includes(el.dataset.key) ? Number(el.value) : el.value
        set(el.dataset.key, val)
      })
    })

    // Checkboxes
    container.querySelectorAll('input[type="checkbox"][data-key]').forEach(el => {
      el.addEventListener('change', () => set(el.dataset.key, el.checked))
    })

    // Sliders
    container.querySelectorAll('input[type="range"][data-key]').forEach(el => {
      el.addEventListener('input', () => {
        const val = parseFloat(el.value)
        set(el.dataset.key, val)
        const label = container.querySelector(`[data-for="${el.dataset.key}"]`)
        if (label) {
          const suffix = el.dataset.key.includes('Ratio') ? 'x' : el.dataset.key.includes('Pct') ? '%' : el.dataset.key.includes('TTL') ? ' min' : '%'
          label.textContent = val + suffix
        }
      })
    })

    // Number inputs
    container.querySelectorAll('input[type="number"][data-key]').forEach(el => {
      el.addEventListener('change', () => set(el.dataset.key, parseFloat(el.value)))
    })

    // Layout buttons
    container.querySelectorAll('.sp-layout-btn[data-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Only deactivate siblings with same key
        container.querySelectorAll(`.sp-layout-btn[data-key="${btn.dataset.key}"]`).forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        const val = btn.dataset.value
        set(btn.dataset.key, isNaN(val) ? val : parseInt(val))
      })
    })

    // Cleanup buttons
    const clearBtn = container.querySelector('#spClearDrawings')
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        // Clear all drawings from localStorage
        const keys = Object.keys(localStorage).filter(k => k.startsWith('drawings_'))
        keys.forEach(k => localStorage.removeItem(k))
        clearBtn.textContent = 'Cleared!'
        clearBtn.disabled = true
        setTimeout(() => { clearBtn.textContent = 'Clear all drawings'; clearBtn.disabled = false }, 2000)
        notify('__clearDrawings', true)
      })
    }

    const resetBtn = container.querySelector('#spResetSettings')
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset all settings to defaults?')) {
          resetAll()
          resetBtn.textContent = 'Reset!'
          setTimeout(() => { resetBtn.textContent = 'Reset all settings' }, 2000)
        }
      })
    }

    // Color presets
    container.querySelectorAll('.sp-color-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.sp-color-preset').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        set('candleUp', btn.dataset.up)
        set('candleDown', btn.dataset.down)
        // Update custom color inputs + preview
        const upInput = container.querySelector('[data-key="candleUp"]')
        const downInput = container.querySelector('[data-key="candleDown"]')
        if (upInput) upInput.value = btn.dataset.up
        if (downInput) downInput.value = btn.dataset.down
        updateCandlePreview(container, btn.dataset.up, btn.dataset.down)
      })
    })

    // Color inputs
    container.querySelectorAll('.sp-color-input').forEach(el => {
      el.addEventListener('input', () => {
        set(el.dataset.key, el.value)
        container.querySelectorAll('.sp-color-preset').forEach(b => b.classList.remove('active'))
        const up = get('candleUp'), down = get('candleDown')
        updateCandlePreview(container, up, down)
      })
    })

    // Watchlist remove buttons
    container.querySelectorAll('.sp-wl-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        wlRemove(btn.dataset.sym)
        showToast(btn.dataset.sym.replace('USDT', '') + ' removed')
        renderActiveSection()
      })
    })

    // Watchlist only toggle
    const wlOnlyToggle = container.querySelector('#spWlOnly')
    if (wlOnlyToggle) {
      wlOnlyToggle.addEventListener('change', () => {
        set('watchlistOnly', wlOnlyToggle.checked)
        showToast(wlOnlyToggle.checked ? 'Watchlist filter ON' : 'Watchlist filter OFF')
      })
    }

    // Clear watchlist
    const clearWlBtn = container.querySelector('#spClearWatchlist')
    if (clearWlBtn) {
      clearWlBtn.addEventListener('click', () => {
        if (confirm('Clear entire watchlist?')) {
          wlClear()
          showToast('Watchlist cleared')
          renderActiveSection()
        }
      })
    }

    // Export settings
    const exportBtn = container.querySelector('#spExportSettings')
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const box = container.querySelector('#spShareBox')
        const data = getAll()
        const code = btoa(JSON.stringify(data))
        box.classList.remove('hidden')
        box.innerHTML = `
          <div class="sp-share-label">Your settings code:</div>
          <textarea class="sp-share-textarea" id="spShareCode" readonly rows="3">${code}</textarea>
          <button class="sp-action-btn small" id="spCopyCode">📋 Copy</button>
        `
        const copyBtn = box.querySelector('#spCopyCode')
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = '✅ Copied!'
            showToast('Settings code copied')
            setTimeout(() => { copyBtn.textContent = '📋 Copy' }, 2000)
          })
        })
      })
    }

    // Import settings
    const importBtn = container.querySelector('#spImportSettings')
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        const box = container.querySelector('#spShareBox')
        box.classList.remove('hidden')
        box.innerHTML = `
          <div class="sp-share-label">Paste settings code:</div>
          <textarea class="sp-share-textarea" id="spPasteCode" rows="3" placeholder="Paste code here..."></textarea>
          <button class="sp-action-btn small" id="spApplyCode">✅ Apply</button>
        `
        const applyBtn = box.querySelector('#spApplyCode')
        applyBtn.addEventListener('click', () => {
          const textarea = box.querySelector('#spPasteCode')
          const code = textarea.value.trim()
          if (!code) return
          try {
            const data = JSON.parse(atob(code))
            if (typeof data !== 'object') throw new Error('bad')
            // Apply each setting
            Object.entries(data).forEach(([k, v]) => {
              if (DEFAULTS.hasOwnProperty(k)) set(k, v)
            })
            applyBtn.textContent = '🎉 Applied!'
            showToast('Settings imported successfully')
            setTimeout(() => { box.classList.add('hidden') }, 1500)
          } catch(e) {
            textarea.style.borderColor = '#ef4444'
            showToast('Invalid settings code')
          }
        })
      })
    }
  }

  // --- Open / Close ---
  function openPanel() {
    const panel = document.getElementById('settingsPanel')
    const overlay = document.getElementById('settingsOverlay')
    if (!panel) createPanel()
    document.getElementById('settingsPanel').classList.remove('hidden')
    document.getElementById('settingsOverlay').classList.remove('hidden')
    panelOpen = true
    renderActiveSection()
  }

  function closePanel() {
    const panel = document.getElementById('settingsPanel')
    const overlay = document.getElementById('settingsOverlay')
    if (panel) panel.classList.add('hidden')
    if (overlay) overlay.classList.add('hidden')
    panelOpen = false
  }

  function isOpen() { return panelOpen }

  // --- Wire up Settings button in header ---
  const settingsBtn = document.getElementById('toggleFiltersBtn')
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openPanel()
    })
  }

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) closePanel()
  })

  // --- Toast notification ---
  function showToast(msg) {
    let toast = document.getElementById('settingsToast')
    if (!toast) {
      toast = document.createElement('div')
      toast.id = 'settingsToast'
      toast.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:rgba(34,197,94,0.9); color:#fff; padding:8px 20px; border-radius:8px; font-size:13px; font-weight:600; z-index:9999; opacity:0; transition:opacity 0.3s; pointer-events:none;'
      document.body.appendChild(toast)
    }
    toast.textContent = msg
    toast.style.opacity = '1'
    clearTimeout(toast._timer)
    toast._timer = setTimeout(() => { toast.style.opacity = '0' }, 2000)
  }

  // --- Init ---
  load()
  loadWatchlist()

  return {
    get,
    set,
    getAll,
    resetAll,
    onChange,
    openPanel,
    closePanel,
    isOpen,
    showToast,
    wlAdd, wlRemove, wlToggle, wlHas, wlList, wlClear,
  }
})()
