/**
 * Depth Heatmap — Bookmap-style order book visualization overlay
 *
 * Renders a canvas overlay on the modal chart showing historical
 * order book depth as colored cells. Bids = green, Asks = red.
 * Intensity = relative notional size.
 *
 * Usage: called from mini-charts.js when modal opens/closes.
 *   depthHeatmapUI.attach(modal)  — start overlay
 *   depthHeatmapUI.detach()       — stop overlay
 *   depthHeatmapUI.toggle()       — show/hide
 */

/* eslint-disable no-unused-vars */
const depthHeatmapUI = (() => {
  'use strict'

  let _canvas = null
  let _ctx = null
  let _modal = null      // reference to mini-charts modal object
  let _enabled = false
  let _visible = false
  let _fetchTimer = null
  let _data = null        // latest heatmap data from server
  let _renderRAF = null

  const FETCH_INTERVAL = 5000   // fetch new data every 5s
  const BID_COLOR = [0, 200, 100]   // green
  const ASK_COLOR = [220, 50, 50]   // red
  const MAX_OPACITY = 0.55

  /**
   * Attach heatmap overlay to modal chart
   * @param {Object} modal — the modal object from mini-charts.js
   */
  function attach(modal) {
    if (!modal || !modal.chart || !modal.currentSym) return
    _modal = modal
    _enabled = true
    _visible = lsGet('heatmapVisible', false)

    // Create canvas overlay
    const chartEl = document.getElementById('cmChartBody')
    if (!chartEl) return

    _canvas = document.createElement('canvas')
    _canvas.id = 'depthHeatmapCanvas'
    _canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;'
    _canvas.width = chartEl.clientWidth
    _canvas.height = chartEl.clientHeight
    chartEl.style.position = 'relative'
    chartEl.appendChild(_canvas)
    _ctx = _canvas.getContext('2d')

    // Listen for chart resize
    _modal._heatmapResizeObs = new ResizeObserver(() => {
      if (!_canvas) return
      _canvas.width = chartEl.clientWidth
      _canvas.height = chartEl.clientHeight
      scheduleRender()
    })
    _modal._heatmapResizeObs.observe(chartEl)

    // Listen for visible range changes to re-render
    if (_modal.chart && _modal.chart.timeScale) {
      _modal._heatmapRangeUnsub = _modal.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        scheduleRender()
      })
    }

    // Start fetching
    fetchData()
    _fetchTimer = setInterval(fetchData, FETCH_INTERVAL)

    if (!_visible) hideCanvas()
  }

  /**
   * Detach and cleanup
   */
  function detach() {
    _enabled = false
    if (_fetchTimer) { clearInterval(_fetchTimer); _fetchTimer = null }
    if (_renderRAF) { cancelAnimationFrame(_renderRAF); _renderRAF = null }
    if (_modal && _modal._heatmapResizeObs) { _modal._heatmapResizeObs.disconnect(); _modal._heatmapResizeObs = null }
    if (_modal && _modal._heatmapRangeUnsub) { _modal._heatmapRangeUnsub(); _modal._heatmapRangeUnsub = null }
    if (_canvas && _canvas.parentNode) _canvas.parentNode.removeChild(_canvas)
    _canvas = null
    _ctx = null
    _modal = null
    _data = null
  }

  /**
   * Toggle visibility
   */
  function toggle() {
    _visible = !_visible
    lsSet('heatmapVisible', _visible)
    if (_visible) {
      showCanvas()
      fetchData()
      scheduleRender()
    } else {
      hideCanvas()
    }
    return _visible
  }

  function isVisible() { return _visible }

  function hideCanvas() { if (_canvas) _canvas.style.display = 'none' }
  function showCanvas() { if (_canvas) _canvas.style.display = '' }

  function lsGet(key, def) {
    try { const v = localStorage.getItem('hm_' + key); return v !== null ? JSON.parse(v) : def } catch (_) { return def }
  }
  function lsSet(key, val) {
    try { localStorage.setItem('hm_' + key, JSON.stringify(val)) } catch (_) {}
  }

  /**
   * Fetch heatmap data from server
   */
  async function fetchData() {
    if (!_enabled || !_visible || !_modal || !_modal.currentSym) return
    try {
      const resp = await fetch(`/api/depth-heatmap?symbol=${_modal.currentSym}`)
      const json = await resp.json()
      if (json.success && json.data) {
        _data = json.data
        scheduleRender()
      }
    } catch (_) {}
  }

  function scheduleRender() {
    if (_renderRAF) return
    _renderRAF = requestAnimationFrame(() => {
      _renderRAF = null
      render()
    })
  }

  /**
   * Render heatmap cells on canvas
   */
  function render() {
    if (!_ctx || !_canvas || !_modal || !_modal.chart || !_modal.series || !_data || !_visible) return
    if (!_data.snapshots || !_data.snapshots.length) return

    const chart = _modal.chart
    const series = _modal.series
    const gapless = _modal._gapless
    const timeScale = chart.timeScale()
    const w = _canvas.width
    const h = _canvas.height

    _ctx.clearRect(0, 0, w, h)

    // Get visible time range
    const visRange = timeScale.getVisibleLogicalRange()
    if (!visRange) return

    const bucketSize = _data.bucketSize || 1
    const snapshots = _data.snapshots

    // Find global max notional for normalization
    let maxNotional = 0
    for (const snap of snapshots) {
      for (const v of Object.values(snap.bids)) if (v > maxNotional) maxNotional = v
      for (const v of Object.values(snap.asks)) if (v > maxNotional) maxNotional = v
    }
    if (maxNotional <= 0) return

    // Calculate cell width based on time spacing
    // Each snapshot is ~5s apart; map to chart coordinates
    const totalBars = visRange.to - visRange.from
    if (totalBars <= 0) return

    // For each snapshot, find its position on the chart's time axis
    // Snapshots have real timestamps; we need to map them to the gapless index space
    for (let si = 0; si < snapshots.length; si++) {
      const snap = snapshots[si]
      const snapTs = Math.floor(snap.ts / 1000) // convert to seconds

      // Map timestamp to chart coordinate
      // For gapless charts, we need to find the nearest candle index
      let xCoord = null
      if (gapless && gapless._timeMap) {
        // Find closest mapped timestamp
        const idx = gapless._timeMap.get(snapTs)
        if (idx != null) {
          xCoord = timeScale.logicalToCoordinate(idx)
        } else {
          // Find nearest timestamp in the map
          let closest = null, closestDist = Infinity
          for (const [ts, i] of gapless._timeMap) {
            const dist = Math.abs(ts - snapTs)
            if (dist < closestDist) { closestDist = dist; closest = i }
          }
          if (closest != null && closestDist < 300) { // within 5min
            xCoord = timeScale.logicalToCoordinate(closest)
          }
        }
      }

      if (xCoord == null || xCoord < 0 || xCoord > w) continue

      // Cell width: approximate from bar spacing
      const nextSnap = snapshots[si + 1]
      let cellW = 6 // default
      if (nextSnap && gapless && gapless._timeMap) {
        const nextTs = Math.floor(nextSnap.ts / 1000)
        let nextIdx = null
        for (const [ts, i] of gapless._timeMap) {
          if (Math.abs(ts - nextTs) < 300) { nextIdx = i; break }
        }
        if (nextIdx != null) {
          const nextX = timeScale.logicalToCoordinate(nextIdx)
          if (nextX != null && nextX > xCoord) cellW = Math.max(2, nextX - xCoord)
        }
      }

      // Draw bid cells (green)
      drawSide(snap.bids, BID_COLOR, xCoord, cellW, bucketSize, maxNotional, series)
      // Draw ask cells (red)
      drawSide(snap.asks, ASK_COLOR, xCoord, cellW, bucketSize, maxNotional, series)
    }
  }

  /**
   * Draw one side (bids or asks) of a snapshot
   */
  function drawSide(levels, color, xCoord, cellW, bucketSize, maxNotional, series) {
    for (const [priceStr, notional] of Object.entries(levels)) {
      const price = parseFloat(priceStr)
      if (!price || notional <= 0) continue

      // Map price to y coordinate
      const yCoord = series.priceToCoordinate(price)
      if (yCoord == null || yCoord < 0 || yCoord > _canvas.height) continue

      // Map next price bucket to get cell height
      const yCoord2 = series.priceToCoordinate(price + bucketSize)
      let cellH = 4 // default minimum
      if (yCoord2 != null) {
        cellH = Math.max(2, Math.abs(yCoord2 - yCoord))
      }

      // Intensity based on relative notional
      const intensity = Math.min(1, notional / maxNotional)
      // Apply sqrt for better visual distribution (small walls still visible)
      const alpha = Math.sqrt(intensity) * MAX_OPACITY

      const [r, g, b] = color
      _ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`
      _ctx.fillRect(xCoord - cellW / 2, yCoord - cellH / 2, cellW, cellH)
    }
  }

  return { attach, detach, toggle, isVisible }
})()
