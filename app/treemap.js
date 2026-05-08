/**
 * RSI / Momentum Treemap — market visualization tab.
 * Squarified treemap, sized by volume, colored by RSI or 24h%.
 * Click cell → open modal chart.
 */
const treemapUI = (() => {
  let _container = null
  let _data = []
  let _colorMode = 'rsi' // 'rsi' | 'change'
  let _refreshTimer = null
  let _loading = false
  const REFRESH_MS = 30_000

  // ── Squarified treemap layout ───────────────────────────────────
  function squarify(items, rect) {
    if (!items.length) return []
    const totalValue = items.reduce((s, i) => s + i.value, 0)
    if (totalValue <= 0) return []

    const rects = []
    const remaining = items.map(i => ({ ...i, area: (i.value / totalValue) * rect.w * rect.h }))
    let cur = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }

    function layoutRow(row, w) {
      const rowArea = row.reduce((s, r) => s + r.area, 0)
      const isHoriz = cur.w >= cur.h
      const rowLen = rowArea / (isHoriz ? cur.h : cur.w)

      let pos = 0
      for (const item of row) {
        const itemLen = item.area / rowLen
        if (isHoriz) {
          rects.push({ ...item, x: cur.x, y: cur.y + pos, w: rowLen, h: itemLen })
        } else {
          rects.push({ ...item, x: cur.x + pos, y: cur.y, w: itemLen, h: rowLen })
        }
        pos += itemLen
      }

      // Shrink remaining rect
      if (isHoriz) {
        cur = { x: cur.x + rowLen, y: cur.y, w: cur.w - rowLen, h: cur.h }
      } else {
        cur = { x: cur.x, y: cur.y + rowLen, w: cur.w, h: cur.h - rowLen }
      }
    }

    function worstRatio(row, w) {
      const s = row.reduce((a, r) => a + r.area, 0)
      const maxA = Math.max(...row.map(r => r.area))
      const minA = Math.min(...row.map(r => r.area))
      return Math.max((w * w * maxA) / (s * s), (s * s) / (w * w * minA))
    }

    let currentRow = []
    let idx = 0
    while (idx < remaining.length) {
      const shortSide = Math.min(cur.w, cur.h)
      if (shortSide <= 0) break

      const candidate = [...currentRow, remaining[idx]]
      if (currentRow.length === 0 || worstRatio(candidate, shortSide) <= worstRatio(currentRow, shortSide)) {
        currentRow.push(remaining[idx])
        idx++
      } else {
        layoutRow(currentRow, shortSide)
        currentRow = []
      }
    }
    if (currentRow.length) layoutRow(currentRow, Math.min(cur.w, cur.h))

    return rects
  }

  // ── Color mapping ──────────────────────────────────────────────
  function rsiToColor(rsi) {
    if (rsi === null || rsi === undefined) return 'rgba(80,80,100,0.7)'
    // Oversold (<30) = green, Neutral (30-70) = gray/blue, Overbought (>70) = red
    if (rsi <= 20) return 'rgba(0,200,80,0.9)'
    if (rsi <= 30) return 'rgba(40,180,80,0.8)'
    if (rsi <= 40) return 'rgba(60,140,80,0.6)'
    if (rsi <= 50) return 'rgba(80,100,120,0.5)'
    if (rsi <= 60) return 'rgba(120,100,80,0.5)'
    if (rsi <= 70) return 'rgba(160,80,60,0.6)'
    if (rsi <= 80) return 'rgba(200,60,40,0.8)'
    return 'rgba(240,40,30,0.9)'
  }

  function changeToColor(pct) {
    if (pct === null || pct === undefined) return 'rgba(80,80,100,0.7)'
    const abs = Math.abs(pct)
    const alpha = Math.min(0.9, 0.3 + abs * 0.1)
    if (pct >= 5) return `rgba(0,200,80,${alpha})`
    if (pct >= 2) return `rgba(40,180,80,${alpha})`
    if (pct >= 0.5) return `rgba(60,140,80,${alpha})`
    if (pct >= -0.5) return `rgba(80,100,120,0.4)`
    if (pct >= -2) return `rgba(200,80,60,${alpha})`
    if (pct >= -5) return `rgba(220,50,40,${alpha})`
    return `rgba(240,30,20,${alpha})`
  }

  function getColor(item) {
    return _colorMode === 'rsi' ? rsiToColor(item.rsi) : changeToColor(item.changePct)
  }

  // ── Render ─────────────────────────────────────────────────────
  function render() {
    if (!_container || !_data.length) return

    const wrapper = _container.querySelector('.tm-wrapper')
    if (!wrapper) return
    wrapper.innerHTML = ''

    const rect = wrapper.getBoundingClientRect()
    const W = rect.width || 800
    const H = rect.height || 500

    // Prepare items sorted by volume desc
    const items = _data
      .filter(d => d.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .map(d => ({ ...d, value: Math.sqrt(d.volume) })) // sqrt so BTC doesn't dominate 80%

    const cells = squarify(items, { x: 0, y: 0, w: W, h: H })

    for (const cell of cells) {
      const div = document.createElement('div')
      div.className = 'tm-cell'
      div.style.cssText = `
        position:absolute;
        left:${cell.x}px; top:${cell.y}px;
        width:${cell.w}px; height:${cell.h}px;
        background:${getColor(cell)};
        border:1px solid rgba(0,0,0,0.3);
        overflow:hidden;
        cursor:pointer;
        display:flex; flex-direction:column;
        align-items:center; justify-content:center;
        transition: filter 0.15s;
      `

      // Label sizing based on cell area
      const area = cell.w * cell.h
      const showFull = area > 4000
      const showMini = area > 1500

      if (showFull) {
        const sign = cell.changePct >= 0 ? '+' : ''
        const rsiStr = cell.rsi !== null ? `RSI ${cell.rsi}` : ''
        div.innerHTML = `
          <span style="font-weight:700;font-size:${Math.min(16, cell.w / 6)}px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.6);line-height:1.2">${cell.symbol}</span>
          <span style="font-size:${Math.min(12, cell.w / 8)}px;color:rgba(255,255,255,0.85);line-height:1.3">${sign}${cell.changePct}%</span>
          ${rsiStr ? `<span style="font-size:${Math.min(10, cell.w / 10)}px;color:rgba(255,255,255,0.6);line-height:1.3">${rsiStr}</span>` : ''}
        `
      } else if (showMini) {
        div.innerHTML = `<span style="font-weight:600;font-size:${Math.min(11, cell.w / 5)}px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.6)">${cell.symbol}</span>`
      }

      div.title = `${cell.symbol} | $${cell.price} | ${cell.changePct >= 0 ? '+' : ''}${cell.changePct}% | Vol $${(cell.volume / 1e6).toFixed(0)}M | RSI ${cell.rsi ?? '—'}`

      // Hover
      div.addEventListener('mouseenter', () => { div.style.filter = 'brightness(1.3)' })
      div.addEventListener('mouseleave', () => { div.style.filter = '' })

      // Click → open modal chart
      div.addEventListener('click', () => {
        if (typeof openCoinModal === 'function') {
          openCoinModal(cell.pair)
        }
      })

      wrapper.appendChild(div)
    }
  }

  // ── Data fetch ─────────────────────────────────────────────────
  async function fetchData() {
    if (_loading) return
    _loading = true
    try {
      const resp = await fetch('/api/treemap')
      const json = await resp.json()
      if (json.success && Array.isArray(json.data)) {
        _data = json.data
        render()
      }
    } catch (err) {
      console.warn('[treemap] fetch error:', err.message)
    } finally {
      _loading = false
    }
  }

  // ── Init / Stop ────────────────────────────────────────────────
  function init() {
    _container = document.getElementById('tab-treemap')
    if (!_container) return

    // Build toolbar + wrapper if first init
    if (!_container.querySelector('.tm-wrapper')) {
      _container.innerHTML = `
        <div class="tm-toolbar" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="font-size:13px;color:var(--text-muted);font-weight:600;">Color by:</span>
          <button class="tm-mode-btn mc-tf-btn active" data-mode="rsi" style="font-size:11px;padding:2px 10px;">RSI</button>
          <button class="tm-mode-btn mc-tf-btn" data-mode="change" style="font-size:11px;padding:2px 10px;">24h %</button>
          <div style="flex:1"></div>
          <span class="tm-legend" style="font-size:10px;color:var(--text-muted);">
            ${_colorMode === 'rsi'
              ? '🟢 Oversold ← RSI → Overbought 🔴'
              : '🔴 Falling ← 24h% → Rising 🟢'}
          </span>
        </div>
        <div class="tm-wrapper" style="position:relative;flex:1;min-height:0;overflow:hidden;"></div>
      `

      // Mode toggle buttons
      _container.querySelectorAll('.tm-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          _colorMode = btn.dataset.mode
          _container.querySelectorAll('.tm-mode-btn').forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
          // Update legend
          const legend = _container.querySelector('.tm-legend')
          if (legend) {
            legend.textContent = _colorMode === 'rsi'
              ? '🟢 Oversold ← RSI → Overbought 🔴'
              : '🔴 Falling ← 24h% → Rising 🟢'
          }
          render()
        })
      })

      // Resize handler
      const ro = new ResizeObserver(() => { if (_data.length) render() })
      ro.observe(_container.querySelector('.tm-wrapper'))
    }

    fetchData()
    if (_refreshTimer) clearInterval(_refreshTimer)
    _refreshTimer = setInterval(fetchData, REFRESH_MS)
  }

  function stop() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null }
  }

  return { init, stop, render }
})()
