'use strict'
const { createLogger } = require('./logger')
const log = createLogger('resilience')

/**
 * Market Resilience — Order Book Recovery Speed
 *
 * Measures how stable and resilient the order book is by tracking
 * total depth near mark price (±0.5%) over time.
 *
 * Metrics per symbol:
 *   - depthScore: current total depth (bid+ask) within ±0.5% ($)
 *   - stability: 1 - CV (coefficient of variation) of depth over window
 *     1.0 = perfectly stable, 0 = wildly varying
 *   - recoveryEvents: count of depth-drop-then-recover events
 *   - avgRecoveryMs: average time to recover 80% of pre-drop depth
 *
 * Checks every 10 seconds, rolling 15-minute window (90 samples).
 */

const CHECK_INTERVAL_MS = 10_000
const WINDOW_SIZE = 90            // 15 min of 10s samples
const DEPTH_WINDOW_PCT = 0.5      // ±0.5% from mark price
const DROP_THRESHOLD = 0.4        // 40% drop = impact event
const RECOVERY_THRESHOLD = 0.8    // 80% recovery = recovered
const CLEANUP_INTERVAL_MS = 120_000

let _stateManager = null
let _getProxyCached = null
let _checkInterval = null
let _cleanupInterval = null

// Mark price cache
let _markMap = new Map()
let _markTs = 0

// symbol -> { samples: [depth...], recoveries: [{dropTs, recoveryMs}], currentDrop: {ts, baseline} | null }
const tracked = new Map()

function init({ stateManager, getProxyCached }) {
  _stateManager = stateManager
  _getProxyCached = getProxyCached

  _checkInterval = setInterval(checkResilience, CHECK_INTERVAL_MS)
  _cleanupInterval = setInterval(cleanupIdle, CLEANUP_INTERVAL_MS)

  log.info({ intervalSec: CHECK_INTERVAL_MS / 1000, windowSamples: WINDOW_SIZE }, 'Resilience tracker started')
}

function stop() {
  if (_checkInterval) { clearInterval(_checkInterval); _checkInterval = null }
  if (_cleanupInterval) { clearInterval(_cleanupInterval); _cleanupInterval = null }
  tracked.clear()
  log.info('Resilience tracker stopped')
}

function refreshMarkPrices() {
  const now = Date.now()
  if (now - _markTs < 15_000) return
  const tickers = _getProxyCached && _getProxyCached('ticker24hr', 60_000)
  if (Array.isArray(tickers)) {
    for (const t of tickers) {
      const p = parseFloat(t.lastPrice)
      if (p > 0) _markMap.set(t.symbol, p)
    }
    _markTs = now
  }
}

/**
 * Measure total depth (bid + ask notional) within ±windowPct% of mark price
 */
function measureDepth(book, markPrice) {
  const minP = markPrice * (1 - DEPTH_WINDOW_PCT / 100)
  const maxP = markPrice * (1 + DEPTH_WINDOW_PCT / 100)
  let total = 0

  for (const sideMap of [book.bids, book.asks]) {
    if (!sideMap) continue
    for (const [price, data] of sideMap) {
      if (price >= minP && price <= maxP && data.notional > 0) {
        total += data.notional
      }
    }
  }
  return total
}

/**
 * Main check loop
 */
function checkResilience() {
  if (!_stateManager) return
  refreshMarkPrices()
  const now = Date.now()

  for (const [symbol, book] of _stateManager.books) {
    const markPrice = _markMap.get(symbol)
    if (!markPrice) continue

    const depth = measureDepth(book, markPrice)
    if (depth <= 0) continue

    if (!tracked.has(symbol)) {
      tracked.set(symbol, { samples: [], recoveries: [], currentDrop: null, lastActivity: now })
    }

    const entry = tracked.get(symbol)
    entry.lastActivity = now
    entry.samples.push(depth)

    // Trim to window
    if (entry.samples.length > WINDOW_SIZE) {
      entry.samples = entry.samples.slice(-WINDOW_SIZE)
    }

    // Need at least 6 samples for meaningful analysis
    if (entry.samples.length < 6) continue

    // Compute rolling average (last 6 samples = ~60s baseline)
    const recentBaseline = entry.samples.slice(-7, -1)
    const avgBaseline = recentBaseline.reduce((s, v) => s + v, 0) / recentBaseline.length

    // Detect depth drop (impact event)
    if (!entry.currentDrop && depth < avgBaseline * (1 - DROP_THRESHOLD)) {
      entry.currentDrop = { ts: now, baseline: avgBaseline }
    }

    // Detect recovery
    if (entry.currentDrop && depth >= entry.currentDrop.baseline * RECOVERY_THRESHOLD) {
      const recoveryMs = now - entry.currentDrop.ts
      entry.recoveries.push({ dropTs: entry.currentDrop.ts, recoveryMs })
      // Keep last 20 recovery events
      if (entry.recoveries.length > 20) entry.recoveries = entry.recoveries.slice(-20)
      entry.currentDrop = null
    }

    // Timeout stale drops (>5 min without recovery = failed)
    if (entry.currentDrop && now - entry.currentDrop.ts > 300_000) {
      entry.recoveries.push({ dropTs: entry.currentDrop.ts, recoveryMs: 300_000 }) // cap at 5min
      entry.currentDrop = null
    }
  }
}

/**
 * Get resilience data for a symbol
 */
function getData(symbol) {
  const entry = tracked.get(symbol)
  if (!entry || entry.samples.length < 6) return null

  const samples = entry.samples
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length
  const stddev = Math.sqrt(variance)
  const cv = mean > 0 ? stddev / mean : 0
  const stability = Math.max(0, Math.min(1, 1 - cv))

  const avgRecoveryMs = entry.recoveries.length > 0
    ? entry.recoveries.reduce((s, r) => s + r.recoveryMs, 0) / entry.recoveries.length
    : null

  const current = samples[samples.length - 1]

  return {
    symbol,
    depthScore: Math.round(current),
    depthAvg: Math.round(mean),
    stability: +stability.toFixed(3),
    recoveryEvents: entry.recoveries.length,
    avgRecoverySec: avgRecoveryMs != null ? +(avgRecoveryMs / 1000).toFixed(1) : null,
    inDrop: !!entry.currentDrop,
    samples: samples.length,
  }
}

/**
 * Get all tracked symbols sorted by stability (most stable first)
 */
function getAll() {
  const results = []
  for (const [symbol] of tracked) {
    const data = getData(symbol)
    if (data) results.push(data)
  }
  results.sort((a, b) => b.stability - a.stability)
  return results
}

/**
 * Cleanup idle symbols
 */
function cleanupIdle() {
  const cutoff = Date.now() - 300_000 // 5 min idle
  for (const [symbol, entry] of tracked) {
    if (entry.lastActivity < cutoff) tracked.delete(symbol)
  }
}

function getStats() {
  const all = getAll()
  const fragile = all.filter(d => d.stability < 0.7)
  return {
    tracked: tracked.size,
    withData: all.length,
    fragile: fragile.length,
    top5Resilient: all.slice(0, 5).map(d => ({ s: d.symbol, stab: d.stability, depth: d.depthScore })),
    top5Fragile: all.slice(-5).reverse().map(d => ({ s: d.symbol, stab: d.stability, depth: d.depthScore })),
  }
}

module.exports = { init, stop, getData, getAll, getStats }
