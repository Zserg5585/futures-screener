/**
 * Signals Scanner — detects trading signals from market data
 * Types: volume_spike, big_mover, natr_spike, density_break
 * Runs every 60s, stores in memory + SQLite via auth.logSignal()
 */

const SCAN_INTERVAL_MS = 60_000

// Thresholds
const VOL_SPIKE_X = 3.0       // volume > 3x median → spike
const BIG_MOVE_PCT = 5.0       // |change%| > 5% in 24h
const NATR_SPIKE_PCT = 5.0     // NATR > 5% → high volatility
const MIN_VOLUME_USD = 20_000_000 // skip low-volume coins

// In-memory signal buffer (latest signals, max 200)
const liveSignals = []
const MAX_LIVE = 200

// Dedup: type:symbol → timestamp (prevent same signal within cooldown)
const cooldowns = new Map()
const COOLDOWN_MS = 15 * 60_000 // 15 min cooldown per signal

let _getProxyCached = null
let _bgetWithRetry = null
let _auth = null
let _stateManager = null
let _scanTimer = null

function init({ getProxyCached, bgetWithRetry, auth, stateManager }) {
  _getProxyCached = getProxyCached
  _bgetWithRetry = bgetWithRetry
  _auth = auth
  _stateManager = stateManager

  // Start scanning
  _scanTimer = setInterval(scan, SCAN_INTERVAL_MS)
  // First scan after 10s (let caches warm up)
  setTimeout(scan, 10_000)
  console.log(`[Signals] Scanner started, interval ${SCAN_INTERVAL_MS / 1000}s`)
}

function stop() {
  if (_scanTimer) clearInterval(_scanTimer)
}

async function scan() {
  try {
    const ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) return

    const usdtPairs = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_USD)

    // Compute median volume for spike detection
    const volumes = usdtPairs.map(t => parseFloat(t.quoteVolume)).sort((a, b) => a - b)
    const medianVol = volumes[Math.floor(volumes.length / 2)] || 1

    const now = Date.now()

    for (const t of usdtPairs) {
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      const change = parseFloat(t.priceChangePercent)
      const vol = parseFloat(t.quoteVolume)
      const high = parseFloat(t.highPrice)
      const low = parseFloat(t.lowPrice)

      // --- Volume Spike ---
      if (vol > medianVol * VOL_SPIKE_X) {
        const volX = (vol / medianVol).toFixed(1)
        emitSignal({
          type: 'volume_spike',
          symbol,
          direction: change > 0 ? 'LONG' : 'SHORT',
          price,
          confidence: Math.min(95, 50 + (vol / medianVol) * 5),
          description: `Volume ${volX}x median ($${fmtVol(vol)})`,
          metadata: { volX: parseFloat(volX), volume: vol, change }
        })
      }

      // --- Big Mover ---
      if (Math.abs(change) >= BIG_MOVE_PCT) {
        emitSignal({
          type: 'big_mover',
          symbol,
          direction: change > 0 ? 'LONG' : 'SHORT',
          price,
          confidence: Math.min(95, 50 + Math.abs(change) * 3),
          description: `${change > 0 ? '🚀' : '💥'} ${change > 0 ? '+' : ''}${change.toFixed(1)}% in 24h`,
          metadata: { change, high, low }
        })
      }

      // --- NATR Spike (high volatility from price range) ---
      const atr = high - low
      const natr = price > 0 ? (atr / price) * 100 : 0
      if (natr >= NATR_SPIKE_PCT) {
        emitSignal({
          type: 'natr_spike',
          symbol,
          direction: change > 0 ? 'LONG' : 'SHORT',
          price,
          confidence: Math.min(90, 50 + natr * 5),
          description: `NATR ${natr.toFixed(1)}% — high volatility range`,
          metadata: { natr: parseFloat(natr.toFixed(2)), high, low, change }
        })
      }
    }

    // --- Density Wall Breaks ---
    if (_stateManager) {
      scanDensityBreaks(usdtPairs)
    }

    // Cleanup old cooldowns
    for (const [key, ts] of cooldowns.entries()) {
      if (now - ts > COOLDOWN_MS) cooldowns.delete(key)
    }
  } catch (err) {
    console.error('[Signals] Scan error:', err.message)
  }
}

function scanDensityBreaks(tickers) {
  const tickerMap = new Map(tickers.map(t => [t.symbol, t]))

  for (const [symbol, book] of _stateManager.books.entries()) {
    const t = tickerMap.get(symbol)
    if (!t) continue
    const price = parseFloat(t.lastPrice)
    if (!price) continue

    // Check for big walls within 0.5% of price that were consumed
    const checkSide = (levels, side) => {
      for (const [wallPrice, data] of levels.entries()) {
        const distPct = Math.abs(wallPrice - price) / price * 100
        // Wall within 0.3% of current price and large notional = being tested
        if (distPct < 0.3 && data.notional > 50_000) {
          emitSignal({
            type: 'density_break',
            symbol,
            direction: side === 'asks' ? 'LONG' : 'SHORT',
            price,
            confidence: Math.min(85, 50 + (data.notional / 100_000) * 10),
            description: `${side === 'asks' ? 'Ask' : 'Bid'} wall $${fmtVol(data.notional)} at ${wallPrice} — price testing`,
            metadata: { wallPrice, notional: data.notional, side, distPct: parseFloat(distPct.toFixed(3)) }
          })
        }
      }
    }

    checkSide(book.bids, 'bids')
    checkSide(book.asks, 'asks')
  }
}

function emitSignal({ type, symbol, direction, price, confidence, description, metadata }) {
  const key = `${type}:${symbol}`
  const now = Date.now()

  // Cooldown check
  if (cooldowns.has(key) && now - cooldowns.get(key) < COOLDOWN_MS) return
  cooldowns.set(key, now)

  const signal = {
    id: `${now}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    symbol,
    direction,
    price,
    confidence: Math.round(confidence),
    description,
    metadata,
    created_at: new Date().toISOString()
  }

  // Add to live buffer
  liveSignals.unshift(signal)
  if (liveSignals.length > MAX_LIVE) liveSignals.length = MAX_LIVE

  // Persist to DB
  try {
    _auth.stmts.logSignal.run(type, symbol, direction, price, confidence, JSON.stringify(metadata))
  } catch (err) {
    console.error('[Signals] DB log error:', err.message)
  }
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K'
  return v.toFixed(0)
}

// --- API Helpers ---

function getLiveSignals(filters = {}) {
  let result = [...liveSignals]

  if (filters.type) {
    result = result.filter(s => s.type === filters.type)
  }
  if (filters.symbol) {
    result = result.filter(s => s.symbol.includes(filters.symbol.toUpperCase()))
  }
  if (filters.direction) {
    result = result.filter(s => s.direction === filters.direction.toUpperCase())
  }
  if (filters.minConfidence) {
    result = result.filter(s => s.confidence >= Number(filters.minConfidence))
  }

  const limit = Math.min(Number(filters.limit) || 50, MAX_LIVE)
  return result.slice(0, limit)
}

function getSignalTypes() {
  return [
    { id: 'volume_spike', label: 'Volume Spike', icon: '📊', color: '#3b82f6' },
    { id: 'big_mover', label: 'Big Mover', icon: '🚀', color: '#f59e0b' },
    { id: 'natr_spike', label: 'NATR Spike', icon: '⚡', color: '#ef4444' },
    { id: 'density_break', label: 'Density Break', icon: '🧱', color: '#8b5cf6' },
  ]
}

function getSignalSummary() {
  const now = Date.now()
  const last1h = liveSignals.filter(s => now - new Date(s.created_at).getTime() < 3600_000)
  const byType = {}
  for (const s of last1h) {
    byType[s.type] = (byType[s.type] || 0) + 1
  }
  return {
    total: liveSignals.length,
    last_1h: last1h.length,
    by_type: byType,
    types: getSignalTypes()
  }
}

module.exports = { init, stop, getLiveSignals, getSignalSummary, getSignalTypes, liveSignals }
