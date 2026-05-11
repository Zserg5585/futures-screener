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
  const BID_COLOR = [0, 180, 120]   // softer green
  const ASK_COLOR = [200, 60, 60]   // softer red
  const MAX_OPACITY = 0.28          // much more transparent — candles visible through
  const MIN_INTENSITY = 0.04        // skip noise below 4% of max

  /**
   * Attach heatmap overlay to modal chart
   * @param {Object} modal — the modal object from mini-charts.js
   */
  function attach(modal) {
    if (!modal || !modal.chart || !modal.currentSym) return
    _modal = modal
    _enabled = true
    _visible = false  // always off by default, user clicks button to enable

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
   * Render heatmap cells on canvas — Bookmap-style
   * Each 5s snapshot = separate column for maximum detail
   */
  function render() {
    if (!_ctx || !_canvas || !_modal || !_modal.chart || !_modal.series || !_data || !_visible) return
    if (!_data.snapshots || !_data.snapshots.length) return

    const series = _modal.series
    const timeScale = _modal.chart.timeScale()
    const w = _canvas.width
    const h = _canvas.height

    _ctx.clearRect(0, 0, w, h)

    // Get visible time range in seconds for linear coordinate mapping
    const range = timeScale.getVisibleRange()
    if (!range) return
    const fromTs = typeof range.from === 'number' ? range.from : 0
    const toTs = typeof range.to === 'number' ? range.to : 0
    if (toTs <= fromTs) return

    // Establish px/sec ratio using two anchor points from chart
    const x1 = timeScale.timeToCoordinate(fromTs)
    const x2 = timeScale.timeToCoordinate(toTs)
    if (x1 == null || x2 == null || x2 <= x1) return
    const pxPerSec = (x2 - x1) / (toTs - fromTs)

    const bucketSize = _data.bucketSize || 1
    const snapshots = _data.snapshots

    // Cell width: calculate from actual snapshot interval (typically 10s) + slight overlap
    let snapIntervalSec = 10
    if (snapshots.length >= 2) {
      const dt = (snapshots[1].ts - snapshots[0].ts) / 1000
      if (dt > 0 && dt < 120) snapIntervalSec = dt
    }
    const cellW = Math.max(2, Math.ceil(snapIntervalSec * pxPerSec) + 1)

    // Find global max notional for normalization
    let maxNotional = 0
    for (const snap of snapshots) {
      for (const v of Object.values(snap.bids)) if (v > maxNotional) maxNotional = v
      for (const v of Object.values(snap.asks)) if (v > maxNotional) maxNotional = v
    }
    if (maxNotional <= 0) return

    // Render each snapshot as its own column (true bookmap detail)
    for (const snap of snapshots) {
      const snapSec = Math.floor(snap.ts / 1000)
      const xCoord = x1 + (snapSec - fromTs) * pxPerSec
      if (xCoord < -cellW || xCoord > w + cellW) continue

      drawSide(snap.bids, BID_COLOR, xCoord, cellW, bucketSize, maxNotional, series)
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

      // Map next price bucket to get cell height (+1px overlap for seamless fill)
      const yCoord2 = series.priceToCoordinate(price + bucketSize)
      let cellH = 4 // default minimum
      if (yCoord2 != null) {
        cellH = Math.ceil(Math.abs(yCoord2 - yCoord)) + 1
      }

      // Intensity based on relative notional
      const intensity = Math.min(1, notional / maxNotional)
      if (intensity < MIN_INTENSITY) continue  // skip noise
      // Apply sqrt for better visual distribution (small walls still visible)
      const alpha = Math.sqrt(intensity) * MAX_OPACITY

      const [r, g, b] = color
      _ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`
      _ctx.fillRect(xCoord - cellW / 2, yCoord - cellH / 2, cellW, cellH)
    }
  }

  return { attach, detach, toggle, isVisible }
})()
