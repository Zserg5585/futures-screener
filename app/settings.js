/**
 * Settings Panel — Slide-out panel with sections
 * Sections: Grid, Charts, Densities, Cleanup
 * Persistence: localStorage (free) + server sync (pro, future)
 *
 * Usage: settingsPanel.get('candleType'), settingsPanel.onChange(cb)
 */
const settingsPanel = (() => {
  // --- Defaults ---
  const DEFAULTS = {
    // Grid / Layout
    layout: '1',              // '1', '2h', '2v', '4', '1+3'

    // Charts
    candleType: 'Candlestick', // Candlestick, Bar, Line, Area
    logScale: false,
    volumeHeight: 15,          // % of chart
    barWidth: 2,               // thin=1, normal=2, wide=3
    showGrid: true,
    showWatermark: true,

    // Densities
    densityEnabled: true,
    densitySeverityLarge: 5.0,    // multiplier for Large
    densitySeverityMedium: 3.5,   // multiplier for Medium
    densitySeveritySmall: 2.0,    // multiplier for Small
    densityDepthPct: 3.0,         // depth % from price
    densityTTLMin: 15,            // min lifetime in minutes

    // Alerts
    impulseEnabled: false,
    impulsePct: 5,                // min % move
    impulseDirection: 'any',      // any, up, down
    volumeSpikeMultiplier: 3,     // x average
    soundEnabled: false,

    // Drawing defaults
    drawLineStyle: 'solid',       // solid, dashed, dotted
    drawDefaultColor: '#ffffff',
  }

  const STORAGE_KEY = 'fs_settings'
  let settings = {}
  let listeners = []
  let panelOpen = false

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
    { id: 'grid',      icon: '⊞', label: 'Grid' },
    { id: 'charts',    icon: '📊', label: 'Charts' },
    { id: 'densities', icon: '◉', label: 'Densities' },
    { id: 'cleanup',   icon: '🗑', label: 'Cleanup' },
  ]
  let activeSection = 'grid'

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
      case 'grid': content.innerHTML = renderGridSection(); break
      case 'charts': content.innerHTML = renderChartsSection(); break
      case 'densities': content.innerHTML = renderDensitiesSection(); break
      case 'cleanup': content.innerHTML = renderCleanupSection(); break
    }

    bindSectionEvents(content)
  }

  // --- Section Renderers ---

  function renderGridSection() {
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
        <div class="sp-section-title">Layout</div>
        <div class="sp-layout-grid">
          ${layouts.map(l => `
            <button class="sp-layout-btn${current === l.id ? ' active' : ''}" data-key="layout" data-value="${l.id}" title="${l.label}">
              <span class="sp-layout-icon">${l.icon}</span>
              <span class="sp-layout-label">${l.label}</span>
            </button>
          `).join('')}
        </div>
        <p class="sp-hint">Multi-chart layouts coming in Phase 2</p>
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

  function renderCleanupSection() {
    return `
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
    container.querySelectorAll('input[type="radio"][data-key]').forEach(el => {
      el.addEventListener('change', () => set(el.dataset.key, el.value))
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
          const suffix = el.dataset.key.includes('Pct') ? '%' : el.dataset.key.includes('TTL') ? ' min' : '%'
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
        container.querySelectorAll('.sp-layout-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        set(btn.dataset.key, btn.dataset.value)
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
      // Only intercept on Mini-Charts tab
      const mcTab = document.querySelector('.tab[data-tab="mini-charts"]')
      if (mcTab && mcTab.classList.contains('active')) {
        e.stopPropagation()
        openPanel()
      }
    })
  }

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) closePanel()
  })

  // --- Init ---
  load()

  return {
    get,
    set,
    getAll,
    resetAll,
    onChange,
    openPanel,
    closePanel,
    isOpen,
  }
})()
