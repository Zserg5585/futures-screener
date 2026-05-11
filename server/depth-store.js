'use strict'
const path = require('path')
const Database = require('better-sqlite3')
const { createLogger } = require('./logger')
const log = createLogger('depth-store')

/**
 * Depth Store — SQLite-backed order book snapshot storage
 *
 * Replaces in-memory depth-heatmap with persistent 4-hour rolling history.
 * Auto-tracks top symbols by volume. Data survives PM2 restarts.
 *
 * Used by: Heatmap UI (bookmap overlay on modal chart)
 * Future:  Density persistence migration, density overlay on heatmap
 */

const DB_PATH = path.join(__dirname, '..', 'data', 'depth.db')
const SNAPSHOT_INTERVAL_MS = 10_000   // snapshot every 10s
const MAX_HISTORY_MS = 4 * 3600_000   // 4 hours rolling window
const CLEANUP_INTERVAL_MS = 600_000   // cleanup every 10 min
const TRACK_UPDATE_MS = 60_000        // refresh tracked symbols every 60s
const TOP_SYMBOLS = 50                // auto-track top N by volume
const WINDOW_PCT = 3                  // ±3% from mark price
const BUCKET_DIVISOR = 0.001          // 0.1% price bands

let _db = null
let _stateManager = null
let _getProxyCached = null
let _snapshotTimer = null
let _cleanupTimer = null
let _trackTimer = null
let _trackedSymbols = new Set()
let _onDemandSymbols = new Map()  // symbol -> lastAccess timestamp
let _markPriceMap = new Map()
let _markPriceTs = 0
const ON_DEMAND_IDLE_MS = 300_000  // drop on-demand after 5 min idle

// Prepared statements (cached for performance)
let _stmtInsert = null
let _stmtSelect = null
let _stmtDelete = null
let _stmtStats = null

function init({ stateManager, getProxyCached }) {
  _stateManager = stateManager
  _getProxyCached = getProxyCached

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      mark_price REAL NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_sym_ts ON snapshots(symbol, ts);
  `)

  // Prepare statements
  _stmtInsert = _db.prepare('INSERT INTO snapshots (symbol, ts, mark_price, data) VALUES (?, ?, ?, ?)')
  _stmtSelect = _db.prepare('SELECT ts, mark_price, data FROM snapshots WHERE symbol = ? AND ts > ? ORDER BY ts')
  _stmtDelete = _db.prepare('DELETE FROM snapshots WHERE ts < ?')
  _stmtStats = _db.prepare('SELECT symbol, COUNT(*) as cnt, MAX(ts) as lastTs FROM snapshots GROUP BY symbol ORDER BY cnt DESC LIMIT 30')

  // Auto-track top symbols
  updateTrackedSymbols()
  _trackTimer = setInterval(updateTrackedSymbols, TRACK_UPDATE_MS)

  // Start snapshot collection
  _snapshotTimer = setInterval(takeSnapshots, SNAPSHOT_INTERVAL_MS)

  // Start cleanup
  cleanup()
  _cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS)

  const existing = _stmtStats.all()
  log.info({
    intervalSec: SNAPSHOT_INTERVAL_MS / 1000,
    maxHours: MAX_HISTORY_MS / 3600_000,
    existingSymbols: existing.length,
    existingSnapshots: existing.reduce((sum, r) => sum + r.cnt, 0)
  }, 'Depth store started (SQLite)')
}

function stop() {
  if (_snapshotTimer) { clearInterval(_snapshotTimer); _snapshotTimer = null }
  if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null }
  if (_trackTimer) { clearInterval(_trackTimer); _trackTimer = null }
  if (_db) { _db.close(); _db = null }
  log.info('Depth store stopped')
}

/**
 * Auto-track top symbols by 24h volume
 */
function updateTrackedSymbols() {
  if (!_getProxyCached) return
  const tickers = _getProxyCached('ticker24hr', 60_000)
  if (!Array.isArray(tickers)) return

  const sorted = tickers
    .filter(t => t.symbol && t.symbol.endsWith('USDT'))
    .map(t => ({ symbol: t.symbol, vol: parseFloat(t.quoteVolume) || 0 }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, TOP_SYMBOLS)

  _trackedSymbols = new Set(sorted.map(t => t.symbol))

  // Merge on-demand symbols (user-requested, not in top N)
  const now = Date.now()
  for (const [sym, lastAccess] of _onDemandSymbols) {
    if (now - lastAccess > ON_DEMAND_IDLE_MS) {
      _onDemandSymbols.delete(sym)
    } else {
      _trackedSymbols.add(sym)
    }
  }
}

/**
 * On-demand track a symbol (called from API when user opens modal)
 */
function track(symbol) {
  if (!symbol) return
  _onDemandSymbols.set(symbol, Date.now())
  _trackedSymbols.add(symbol)
}

/**
 * Take snapshots of all tracked symbols, write to SQLite
 */
function takeSnapshots() {
  if (!_stateManager || !_trackedSymbols.size || !_db) return

  // Refresh mark prices from ticker cache
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

  const rows = []
  for (const symbol of _trackedSymbols) {
    const book = _stateManager.books.get(symbol)
    if (!book) continue

    const markPrice = _markPriceMap.get(symbol) || 0
    if (!markPrice) continue

    const bucketSize = markPrice * BUCKET_DIVISOR
    const minPrice = markPrice * (1 - WINDOW_PCT / 100)
    const maxPrice = markPrice * (1 + WINDOW_PCT / 100)

    const bids = bucketSide(book.bids, bucketSize, minPrice, maxPrice)
    const asks = bucketSide(book.asks, bucketSize, minPrice, maxPrice)

    if (Object.keys(bids).length > 0 || Object.keys(asks).length > 0) {
      rows.push([symbol, now, markPrice, JSON.stringify({ bids, asks })])
    }
  }

  if (rows.length > 0) {
    const insertMany = _db.transaction((items) => {
      for (const r of items) _stmtInsert.run(r[0], r[1], r[2], r[3])
    })
    insertMany(rows)
  }
}

/**
 * Bucket one side of the order book into price bands
 */
function bucketSide(sideMap, bucketSize, minPrice, maxPrice) {
  const buckets = {}
  if (!sideMap || !bucketSize) return buckets

  for (const [price, data] of sideMap) {
    if (price < minPrice || price > maxPrice) continue
    if (!data.notional || data.notional <= 0) continue

    const bucketKey = +(Math.round(price / bucketSize) * bucketSize).toFixed(8)
    buckets[bucketKey] = (buckets[bucketKey] || 0) + data.notional
  }

  return buckets
}

/**
 * Get heatmap snapshots from SQLite
 * Returns same format as old depth-heatmap for frontend compatibility
 */
function getSnapshots(symbol, hours = 4) {
  if (!_db) return null

  const since = Date.now() - hours * 3600_000
  const rows = _stmtSelect.all(symbol, since)

  if (!rows.length) return null

  const lastRow = rows[rows.length - 1]
  const markPrice = lastRow.mark_price
  const bucketSize = markPrice * BUCKET_DIVISOR

  return {
    symbol,
    markPrice,
    bucketSize: +bucketSize.toFixed(8),
    windowPct: WINDOW_PCT,
    count: rows.length,
    snapshots: rows.map(r => {
      const d = JSON.parse(r.data)
      return { ts: r.ts, bids: d.bids, asks: d.asks }
    })
  }
}

/**
 * Cleanup snapshots older than MAX_HISTORY_MS
 */
function cleanup() {
  if (!_db) return
  const cutoff = Date.now() - MAX_HISTORY_MS
  const result = _stmtDelete.run(cutoff)
  if (result.changes > 0) {
    log.info({ deleted: result.changes }, 'Cleaned up old snapshots')
  }
}

/**
 * Stats for monitoring
 */
function getStats() {
  if (!_db) return { trackedSymbols: 0, symbols: [] }
  const total = _db.prepare('SELECT COUNT(*) as cnt FROM snapshots').get()
  const symbols = _stmtStats.all()
  return {
    trackedSymbols: _trackedSymbols.size,
    totalSnapshots: total.cnt,
    maxHours: MAX_HISTORY_MS / 3600_000,
    intervalSec: SNAPSHOT_INTERVAL_MS / 1000,
    symbols
  }
}

module.exports = { init, stop, track, getSnapshots, getStats }
