'use strict'
const { createLogger } = require('./logger')
const log = createLogger('depth-heatmap')

/**
 * Depth Heatmap — Bookmap-style historical order book visualization
 *
 * Takes periodic snapshots of the order book from stateManager.books,
 * buckets prices into bands (0.1% of mark price), stores rolling window
 * of 30 minutes. Frontend renders as canvas overlay on modal chart.
 *
 * On-demand: only tracks symbols that are actively viewed.
 * Memory: ~50KB per symbol (360 snapshots × ~50 buckets × 8 bytes)
 */

const SNAPSHOT_INTERVAL_MS = 5_000   // snapshot every 5s
const MAX_SNAPSHOTS = 360            // 30 min rolling window (360 × 5s)
const WINDOW_PCT = 3                 // ±3% from mark price
const BUCKET_DIVISOR = 0.001         // 0.1% price bands
const IDLE_TIMEOUT_MS = 120_000      // stop tracking after 2min no requests
const CLEANUP_INTERVAL_MS = 30_000   // cleanup idle symbols every 30s

let _stateManager = null
let _getProxyCached = null
let _snapshotInterval = null
let _cleanupInterval = null

// symbol -> { snapshots: [{ts, bids: Map<bucket,notional>, asks: Map<bucket,notional>}], lastAccess, markPrice }
const tracked = new Map()

// Internal mark price cache (refreshed from ticker24hr every snapshot cycle)
let _markPriceMap = new Map() // symbol -> markPrice
let _markPriceTs = 0

function init({ stateManager, getProxyCached }) {
  _stateManager = stateManager
  _getProxyCached = getProxyCached

  _snapshotInterval = setInterval(takeSnapshots, SNAPSHOT_INTERVAL_MS)
  _cleanupInterval = setInterval(cleanupIdle, CLEANUP_INTERVAL_MS)

  log.info({ intervalSec: SNAPSHOT_INTERVAL_MS / 1000, maxMinutes: MAX_SNAPSHOTS * SNAPSHOT_INTERVAL_MS / 60000 }, 'Depth heatmap engine started')
}

function stop() {
  if (_snapshotInterval) { clearInterval(_snapshotInterval); _snapshotInterval = null }
  if (_cleanupInterval) { clearInterval(_cleanupInterval); _cleanupInterval = null }
  tracked.clear()
  log.info('Depth heatmap stopped')
}

/**
 * Start tracking a symbol (called when user opens modal chart)
 */
function track(symbol) {
  if (!tracked.has(symbol)) {
    tracked.set(symbol, { snapshots: [], lastAccess: Date.now(), markPrice: 0 })
    log.debug({ symbol }, 'Tracking started')
  } else {
    tracked.get(symbol).lastAccess = Date.now()
  }
}

/**
 * Get heatmap data for a symbol
 * Returns: { symbol, bucketSize, snapshots: [{ts, bids: {price: notional}, asks: {price: notional}}] }
 */
function getData(symbol, maxSnapshots = MAX_SNAPSHOTS) {
  const entry = tracked.get(symbol)
  if (!entry) return null

  entry.lastAccess = Date.now()

  const snaps = entry.snapshots.slice(-maxSnapshots)
  const markPrice = entry.markPrice || 0
  const bucketSize = markPrice * BUCKET_DIVISOR

  return {
    symbol,
    markPrice,
    bucketSize: +bucketSize.toFixed(8),
    windowPct: WINDOW_PCT,
    count: snaps.length,
    snapshots: snaps.map(s => ({
      ts: s.ts,
      bids: mapToObj(s.bids),
      asks: mapToObj(s.asks),
    })),
  }
}

function mapToObj(map) {
  const obj = {}
  for (const [k, v] of map) {
    obj[k] = v
  }
  return obj
}

/**
 * Take snapshots of all tracked symbols
 */
function takeSnapshots() {
  if (!_stateManager) return
  if (!tracked.size) return

  // Refresh mark prices from ticker24hr cache (every 10s max)
  const now = Date.now()
  if (now - _markPriceTs > 10_000 && _getProxyCached) {
    const tickers = _getProxyCached('ticker24hr', 60_000)
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        const p = parseFloat(t.lastPrice)
        if (p > 0) _markPriceMap.set(t.symbol, p)
      }
      _markPriceTs = now
    }
  }

  for (const [symbol, entry] of tracked) {
    const book = _stateManager.books.get(symbol)
    if (!book) continue

    // Get mark price from ticker24hr cache (no API calls)
    let markPrice = _markPriceMap.get(symbol) || 0
    if (!markPrice) continue
    entry.markPrice = markPrice

    const bucketSize = markPrice * BUCKET_DIVISOR
    const minPrice = markPrice * (1 - WINDOW_PCT / 100)
    const maxPrice = markPrice * (1 + WINDOW_PCT / 100)

    const bids = bucketSide(book.bids, bucketSize, minPrice, maxPrice)
    const asks = bucketSide(book.asks, bucketSize, minPrice, maxPrice)

    // Only store if there's actual data
    if (bids.size > 0 || asks.size > 0) {
      entry.snapshots.push({ ts: Date.now(), bids, asks })

      // Trim to rolling window
      if (entry.snapshots.length > MAX_SNAPSHOTS) {
        entry.snapshots = entry.snapshots.slice(-MAX_SNAPSHOTS)
      }
    }
  }
}

/**
 * Bucket one side of the order book into price bands
 * Returns Map<roundedPrice, totalNotional>
 */
function bucketSide(sideMap, bucketSize, minPrice, maxPrice) {
  const buckets = new Map()
  if (!sideMap || !bucketSize) return buckets

  for (const [price, data] of sideMap) {
    if (price < minPrice || price > maxPrice) continue
    if (!data.notional || data.notional <= 0) continue

    // Round to bucket
    const bucketKey = +(Math.round(price / bucketSize) * bucketSize).toFixed(8)
    const existing = buckets.get(bucketKey) || 0
    buckets.set(bucketKey, existing + data.notional)
  }

  return buckets
}

/**
 * Remove symbols that haven't been requested in IDLE_TIMEOUT_MS
 */
function cleanupIdle() {
  const now = Date.now()
  for (const [symbol, entry] of tracked) {
    if (now - entry.lastAccess > IDLE_TIMEOUT_MS) {
      tracked.delete(symbol)
      log.debug({ symbol, snapshotCount: entry.snapshots.length }, 'Tracking stopped (idle)')
    }
  }
}

/**
 * Stats for monitoring
 */
function getStats() {
  const stats = {}
  for (const [symbol, entry] of tracked) {
    stats[symbol] = {
      snapshots: entry.snapshots.length,
      lastAccess: entry.lastAccess,
      markPrice: entry.markPrice,
    }
  }
  return { trackedSymbols: tracked.size, symbols: stats }
}

module.exports = { init, stop, track, getData, getStats }
