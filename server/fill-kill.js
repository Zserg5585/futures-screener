'use strict'
const { createLogger } = require('./logger')
const log = createLogger('fill-kill')

/**
 * Fill:Kill Ratio — Wall Authenticity / Spoof Detection
 *
 * Tracks significant order book walls over time:
 * - If a wall disappears AND price crossed it → FILLED (real demand/supply)
 * - If a wall disappears AND price did NOT cross it → KILLED (cancelled/spoof)
 *
 * Fill:Kill > 0.5 = genuine walls (real liquidity)
 * Fill:Kill < 0.3 = likely spoofing (fake walls to manipulate)
 *
 * Uses stateManager.books for wall tracking, ticker24hr for mark prices.
 * Checks every 10 seconds, rolling 30-minute window per symbol.
 */

const CHECK_INTERVAL_MS = 10_000    // check every 10s
const MIN_NOTIONAL = 50_000         // $50K minimum to track as "wall"
const WINDOW_PCT = 3                // ±3% from mark price
const HISTORY_WINDOW_MS = 30 * 60_000 // 30 min rolling window
const CLEANUP_INTERVAL_MS = 60_000

let _stateManager = null
let _getProxyCached = null
let _checkInterval = null
let _cleanupInterval = null

// symbol -> { walls: Map<priceKey, {price, notional, side, firstSeen, lastSeen}>, events: [{ts, type, price, notional, side}], stats: {filled, killed} }
const tracked = new Map()

// Mark price cache
let _markMap = new Map()
let _markTs = 0

function init({ stateManager, getProxyCached }) {
  _stateManager = stateManager
  _getProxyCached = getProxyCached

  _checkInterval = setInterval(checkWalls, CHECK_INTERVAL_MS)
  _cleanupInterval = setInterval(cleanupOld, CLEANUP_INTERVAL_MS)

  log.info({ intervalSec: CHECK_INTERVAL_MS / 1000, minNotional: MIN_NOTIONAL }, 'Fill:Kill tracker started')
}

function stop() {
  if (_checkInterval) { clearInterval(_checkInterval); _checkInterval = null }
  if (_cleanupInterval) { clearInterval(_cleanupInterval); _cleanupInterval = null }
  tracked.clear()
  log.info('Fill:Kill tracker stopped')
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
 * Main check loop — compare current walls vs previous snapshot
 */
function checkWalls() {
  if (!_stateManager) return

  refreshMarkPrices()
  const now = Date.now()

  for (const [symbol, book] of _stateManager.books) {
    const markPrice = _markMap.get(symbol)
    if (!markPrice) continue

    if (!tracked.has(symbol)) {
      tracked.set(symbol, { walls: new Map(), events: [], stats: { filled: 0, killed: 0 } })
    }

    const entry = tracked.get(symbol)
    const prevWalls = entry.walls
    const currentWalls = new Map()

    const minPrice = markPrice * (1 - WINDOW_PCT / 100)
    const maxPrice = markPrice * (1 + WINDOW_PCT / 100)

    // Scan current book for significant walls
    for (const [side, sideMap] of [['bid', book.bids], ['ask', book.asks]]) {
      if (!sideMap) continue
      for (const [price, data] of sideMap) {
        if (price < minPrice || price > maxPrice) continue
        if (!data.notional || data.notional < MIN_NOTIONAL) continue

        const key = `${side}:${price}`
        currentWalls.set(key, {
          price, notional: data.notional, side,
          firstSeen: data.firstSeen || now, lastSeen: now,
        })
      }
    }

    // Compare: find walls that disappeared
    for (const [key, prevWall] of prevWalls) {
      if (currentWalls.has(key)) continue // still there

      // Wall disappeared — was it filled or killed?
      const { price, side, notional } = prevWall
      let type = 'killed' // default: cancelled/spoofed

      if (side === 'bid' && markPrice <= price) {
        type = 'filled' // price dropped through bid wall → filled
      } else if (side === 'ask' && markPrice >= price) {
        type = 'filled' // price rose through ask wall → filled
      }

      entry.events.push({ ts: now, type, price, notional, side })
      entry.stats[type]++
    }

    // Update snapshot
    entry.walls = currentWalls
  }
}

/**
 * Cleanup old events beyond rolling window
 */
function cleanupOld() {
  const cutoff = Date.now() - HISTORY_WINDOW_MS
  for (const [symbol, entry] of tracked) {
    if (!entry.events.length) continue

    // Recount stats from remaining events
    const remaining = entry.events.filter(e => e.ts > cutoff)
    if (remaining.length !== entry.events.length) {
      entry.events = remaining
      entry.stats = { filled: 0, killed: 0 }
      for (const e of remaining) entry.stats[e.type]++
    }

    // Remove symbols with no walls and no events
    if (!entry.walls.size && !entry.events.length) {
      tracked.delete(symbol)
    }
  }
}

/**
 * Get Fill:Kill data for a single symbol
 */
function getData(symbol) {
  const entry = tracked.get(symbol)
  if (!entry) return null

  const total = entry.stats.filled + entry.stats.killed
  const ratio = total > 0 ? entry.stats.filled / total : null

  return {
    symbol,
    fillKillRatio: ratio != null ? +ratio.toFixed(3) : null,
    filled: entry.stats.filled,
    killed: entry.stats.killed,
    total,
    activeWalls: entry.walls.size,
    recentEvents: entry.events.slice(-20).reverse().map(e => ({
      ts: e.ts, type: e.type, side: e.side,
      price: e.price, notional: Math.round(e.notional),
    })),
  }
}

/**
 * Get all symbols with Fill:Kill data, sorted by ratio ascending (most spoofed first)
 */
function getAll() {
  const results = []
  for (const [symbol] of tracked) {
    const data = getData(symbol)
    if (data && data.total >= 3) results.push(data) // min 3 events for meaningful ratio
  }
  results.sort((a, b) => (a.fillKillRatio || 0) - (b.fillKillRatio || 0))
  return results
}

/**
 * Stats for monitoring
 */
function getStats() {
  const all = getAll()
  const spoofed = all.filter(d => d.fillKillRatio != null && d.fillKillRatio < 0.3)
  const genuine = all.filter(d => d.fillKillRatio != null && d.fillKillRatio > 0.5)
  return {
    trackedSymbols: tracked.size,
    withData: all.length,
    spoofSuspect: spoofed.length,
    genuineWalls: genuine.length,
    top5Spoofed: spoofed.slice(0, 5).map(d => ({ symbol: d.symbol, ratio: d.fillKillRatio, filled: d.filled, killed: d.killed })),
    top5Genuine: genuine.slice(-5).reverse().map(d => ({ symbol: d.symbol, ratio: d.fillKillRatio, filled: d.filled, killed: d.killed })),
  }
}

module.exports = { init, stop, getData, getAll, getStats }
