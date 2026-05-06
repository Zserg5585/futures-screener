/**
 * Liquidity Sweep + Pin Bar Signal Detector
 *
 * Step 1: Swing level detection + round number levels
 * - findSwingLevels()  — fractal-based swing high/low from klines
 * - findRoundNumbers() — psychological round-number levels near price
 */

// ======================== SWING HIGH/LOW DETECTION ========================

/**
 * Find swing highs and lows using fractal method.
 * A swing high: candle.high > N candles on each side.
 * A swing low:  candle.low  < N candles on each side.
 *
 * @param {Array} candles — [{time, open, high, low, close, volume}, ...] ASC order
 * @param {number} leftBars  — candles to the left for confirmation (default 3)
 * @param {number} rightBars — candles to the right for confirmation (default 3)
 * @returns {Array} [{ price, type: 'swing_high'|'swing_low', time, strength, touches }]
 */
function findSwingLevels(candles, leftBars = 3, rightBars = 3) {
  if (!Array.isArray(candles) || candles.length < leftBars + rightBars + 1) return []

  const raws = [] // raw swing points before clustering

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const c = candles[i]

    // --- Swing High ---
    let isSwingHigh = true
    for (let l = 1; l <= leftBars; l++) {
      if (candles[i - l].high >= c.high) { isSwingHigh = false; break }
    }
    if (isSwingHigh) {
      for (let r = 1; r <= rightBars; r++) {
        if (candles[i + r].high >= c.high) { isSwingHigh = false; break }
      }
    }
    if (isSwingHigh) {
      raws.push({ price: c.high, type: 'swing_high', time: c.time, volume: c.volume })
    }

    // --- Swing Low ---
    let isSwingLow = true
    for (let l = 1; l <= leftBars; l++) {
      if (candles[i - l].low <= c.low) { isSwingLow = false; break }
    }
    if (isSwingLow) {
      for (let r = 1; r <= rightBars; r++) {
        if (candles[i + r].low <= c.low) { isSwingLow = false; break }
      }
    }
    if (isSwingLow) {
      raws.push({ price: c.low, type: 'swing_low', time: c.time, volume: c.volume })
    }
  }

  // --- Cluster nearby levels (within 0.15% of each other) ---
  // Keeps the strongest (most touches) and freshest level per cluster
  const CLUSTER_PCT = 0.0015
  const clustered = clusterLevels(raws, CLUSTER_PCT)

  return clustered
}

/**
 * Cluster raw swing points that are within pctThreshold of each other.
 * Returns deduplicated levels with touch count and strength score.
 */
function clusterLevels(raws, pctThreshold) {
  if (raws.length === 0) return []

  // Sort by price
  const sorted = [...raws].sort((a, b) => a.price - b.price)
  const clusters = []
  let current = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1]
    const pctDiff = Math.abs(sorted[i].price - prev.price) / prev.price

    if (pctDiff <= pctThreshold && sorted[i].type === prev.type) {
      current.push(sorted[i])
    } else {
      clusters.push(current)
      current = [sorted[i]]
    }
  }
  clusters.push(current)

  // Reduce each cluster to a single level
  return clusters.map(group => {
    const touches = group.length
    // Use the price with the most recent touch (freshest)
    const freshest = group.reduce((a, b) => a.time > b.time ? a : b)
    // Strength: more touches = stronger, capped at 10
    const strength = Math.min(10, touches * 2 + 1)

    return {
      price: freshest.price,
      type: freshest.type,
      time: freshest.time,
      touches,
      strength,
      source: 'swing',
    }
  })
}


// ======================== ORDER BOOK WALL LEVELS ========================

/**
 * Extract significant wall levels from the live order book.
 * Uses stateManager for raw levels and densityV2 for statistical detection.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {number} params.markPrice
 * @param {Object} params.stateManager — server/state.js singleton
 * @param {Object} params.densityV2   — server/densityV2.js module
 * @param {Map}    params.persistenceMap — densityV2 persistence store (from index.js)
 * @param {number} params.windowPct — price window % (default 3)
 * @returns {Array} [{ price, type: 'bid_wall'|'ask_wall', strength, notional, score, status, source }]
 */
function getWallLevels({ symbol, markPrice, stateManager, densityV2, persistenceMap, windowPct = 3 }) {
  if (!stateManager || !markPrice) return []

  // Check if we have WS data for this symbol
  if (!stateManager.books || !stateManager.books.has(symbol)) return []

  const book = stateManager.books.get(symbol)

  // Gather raw levels from the order book within the window
  const minPrice = markPrice * (1 - windowPct / 100)
  const maxPrice = markPrice * (1 + windowPct / 100)

  const bidLevels = []
  for (const [price, data] of book.bids.entries()) {
    if (price >= minPrice && price <= maxPrice) {
      bidLevels.push({ price, notional: data.notional, firstSeen: data.firstSeen, lastUpdate: data.lastUpdate })
    }
  }

  const askLevels = []
  for (const [price, data] of book.asks.entries()) {
    if (price >= minPrice && price <= maxPrice) {
      askLevels.push({ price, notional: data.notional, firstSeen: data.firstSeen, lastUpdate: data.lastUpdate })
    }
  }

  // If densityV2 and persistenceMap are available, use statistical wall detection
  if (densityV2 && persistenceMap) {
    try {
      const analysis = densityV2.analyzeSymbol({
        symbol, markPrice, bidLevels, askLevels, persistenceMap, windowPct, nSigma: 2.0
      })

      const walls = []

      // Convert bidWalls (support) to liquidity levels
      if (Array.isArray(analysis.bidWalls)) {
        for (const w of analysis.bidWalls) {
          walls.push({
            price: w.price,
            type: 'bid_wall',
            strength: Math.min(10, Math.round(w.score || 1)),
            notional: w.notional,
            score: w.score,
            status: w.status,
            distancePct: w.distancePct,
            source: 'wall',
            time: null,
            touches: 0,
          })
        }
      }

      // Convert askWalls (resistance) to liquidity levels
      if (Array.isArray(analysis.askWalls)) {
        for (const w of analysis.askWalls) {
          walls.push({
            price: w.price,
            type: 'ask_wall',
            strength: Math.min(10, Math.round(w.score || 1)),
            notional: w.notional,
            score: w.score,
            status: w.status,
            distancePct: w.distancePct,
            source: 'wall',
            time: null,
            touches: 0,
          })
        }
      }

      return walls
    } catch (e) {
      // Fallback: skip densityV2, return empty
      console.error('[LiqSweep] densityV2 error for', symbol, e.message)
    }
  }

  // Fallback without densityV2: return top raw levels by notional
  // (simple threshold: top 5 per side, min $50K notional)
  const MIN_NOTIONAL = 50_000
  const result = []

  const topBids = bidLevels.filter(l => l.notional >= MIN_NOTIONAL)
    .sort((a, b) => b.notional - a.notional).slice(0, 5)
  for (const l of topBids) {
    result.push({
      price: l.price, type: 'bid_wall', strength: 3,
      notional: l.notional, score: null, status: null,
      distancePct: Math.abs(l.price - markPrice) / markPrice * 100,
      source: 'wall', time: null, touches: 0,
    })
  }

  const topAsks = askLevels.filter(l => l.notional >= MIN_NOTIONAL)
    .sort((a, b) => b.notional - a.notional).slice(0, 5)
  for (const l of topAsks) {
    result.push({
      price: l.price, type: 'ask_wall', strength: 3,
      notional: l.notional, score: null, status: null,
      distancePct: Math.abs(l.price - markPrice) / markPrice * 100,
      source: 'wall', time: null, touches: 0,
    })
  }

  return result
}


// ======================== ROUND NUMBER LEVELS ========================

/**
 * Generate psychological round-number levels near the current price.
 * Adapts step size to the price magnitude.
 *
 * @param {number} price — current mark price
 * @param {number} windowPct — how far above/below to look (default 2%)
 * @returns {Array} [{ price, type: 'round_number', strength, source }]
 */
function findRoundNumbers(price, windowPct = 2) {
  if (!price || price <= 0) return []

  // Determine step based on price magnitude
  // BTC ~60000 → step 1000, ETH ~3000 → step 100, altcoin ~1.5 → step 0.1
  const step = getRoundStep(price)
  const halfStep = step / 2 // sub-levels (e.g. 500 for BTC)

  const windowAbs = price * (windowPct / 100)
  const lo = price - windowAbs
  const hi = price + windowAbs

  const levels = []

  // Start from the nearest round number below lo
  const start = Math.floor(lo / halfStep) * halfStep

  for (let p = start; p <= hi; p += halfStep) {
    if (p <= 0) continue
    if (p < lo) continue

    // Full round (e.g. 60000) is stronger than half (e.g. 60500)
    const isFull = Math.abs(p % step) < step * 0.001
    const strength = isFull ? 4 : 2

    levels.push({
      price: p,
      type: 'round_number',
      strength,
      source: 'round',
      time: null,
      touches: 0,
    })
  }

  return levels
}

/**
 * Determine the appropriate round-number step for a given price.
 */
function getRoundStep(price) {
  if (price >= 10000) return 1000      // BTC: 60000, 61000, ...
  if (price >= 1000)  return 100       // ETH: 3000, 3100, ...
  if (price >= 100)   return 10        // SOL: 150, 160, ...
  if (price >= 10)    return 1         // LINK: 14, 15, ...
  if (price >= 1)     return 0.1       // DOGE: 0.3, 0.4, ...
  if (price >= 0.01)  return 0.01      // SHIB-like: 0.01, 0.02, ...
  return 0.001
}


// ======================== PIN BAR DETECTION ========================

/**
 * Detect whether a candle is a pin bar (rejection candle).
 *
 * Bullish pin bar (LONG signal):
 *   - Long lower wick (≥ wickMinRatio of total range)
 *   - Small body (≤ bodyMaxRatio of total range)
 *   - Close in the upper portion of the range
 *
 * Bearish pin bar (SHORT signal):
 *   - Long upper wick (≥ wickMinRatio of total range)
 *   - Small body (≤ bodyMaxRatio of total range)
 *   - Close in the lower portion of the range
 *
 * Also filters out tiny-range noise candles by requiring the range
 * to exceed a minimum relative to the average range of previous candles.
 *
 * @param {Object} candle — { open, high, low, close, volume, time }
 * @param {Array}  prevCandles — preceding candles for avg range calc (5-20 recommended)
 * @param {Object} opts
 * @param {number} opts.wickMinRatio   — min wick / range (default 0.60)
 * @param {number} opts.bodyMaxRatio   — max body / range (default 0.33)
 * @param {number} opts.minRangeMult   — candle range must be ≥ this × avgRange (default 0.8)
 * @returns {null | { direction: 'LONG'|'SHORT', wickRatio, bodyRatio, range }}
 */
function detectPinBar(candle, prevCandles = [], opts = {}) {
  if (!candle) return null

  const {
    wickMinRatio = 0.60,
    bodyMaxRatio = 0.33,
    minRangeMult = 0.8,
  } = opts

  const { open, high, low, close } = candle
  const range = high - low
  if (range <= 0) return null

  // --- Filter out tiny candles (noise) ---
  if (prevCandles.length >= 3) {
    const avgRange = prevCandles.reduce((s, c) => s + (c.high - c.low), 0) / prevCandles.length
    if (avgRange > 0 && range < avgRange * minRangeMult) return null
  }

  const body = Math.abs(close - open)
  const bodyRatio = body / range

  // Body must be small
  if (bodyRatio > bodyMaxRatio) return null

  const upperWick = high - Math.max(open, close)
  const lowerWick = Math.min(open, close) - low

  const upperWickRatio = upperWick / range
  const lowerWickRatio = lowerWick / range

  // --- Bullish pin bar: long lower wick, close near the top ---
  if (lowerWickRatio >= wickMinRatio) {
    return {
      direction: 'LONG',
      wickRatio: parseFloat(lowerWickRatio.toFixed(3)),
      bodyRatio: parseFloat(bodyRatio.toFixed(3)),
      range,
    }
  }

  // --- Bearish pin bar: long upper wick, close near the bottom ---
  if (upperWickRatio >= wickMinRatio) {
    return {
      direction: 'SHORT',
      wickRatio: parseFloat(upperWickRatio.toFixed(3)),
      bodyRatio: parseFloat(bodyRatio.toFixed(3)),
      range,
    }
  }

  return null
}


// ======================== SWEEP CONFIRMATION ========================

/**
 * Check if a pin bar's wick actually swept (pierced) a liquidity level.
 *
 * For a bullish pin bar (LONG): the candle LOW must be BELOW a level,
 * and the CLOSE must be ABOVE that level (wick grabbed liquidity, price recovered).
 *
 * For a bearish pin bar (SHORT): the candle HIGH must be ABOVE a level,
 * and the CLOSE must be BELOW that level.
 *
 * If multiple levels were swept, returns the one with the highest strength.
 *
 * @param {Object} candle   — { open, high, low, close }
 * @param {Object} pinBar   — from detectPinBar(): { direction }
 * @param {Array}  levels   — [{ price, type, strength, source, ... }]
 * @param {Object} opts
 * @param {number} opts.maxPenetrationPct — max wick penetration past level in % of price (default 1.5)
 * @returns {null | { sweptLevel, levelType, levelSource, strength, sweepDepthPct, levelsSwept }}
 */
function confirmSweep(candle, pinBar, levels, opts = {}) {
  if (!candle || !pinBar || !Array.isArray(levels) || levels.length === 0) return null

  const { maxPenetrationPct = 1.5 } = opts

  const swept = []

  if (pinBar.direction === 'LONG') {
    // Wick went DOWN through a level, close recovered above it
    for (const lv of levels) {
      // Level should be below close (support zone) — sweep means low < level < close
      if (candle.low < lv.price && candle.close > lv.price) {
        const penetration = lv.price - candle.low
        const penetrationPct = (penetration / lv.price) * 100
        // Don't count absurdly deep sweeps — probably a dump, not a sweep
        if (penetrationPct <= maxPenetrationPct) {
          swept.push({
            sweptLevel: lv.price,
            levelType: lv.type,
            levelSource: lv.source,
            strength: lv.strength,
            sweepDepthPct: parseFloat(penetrationPct.toFixed(3)),
            notional: lv.notional || null,
          })
        }
      }
    }
  } else if (pinBar.direction === 'SHORT') {
    // Wick went UP through a level, close recovered below it
    for (const lv of levels) {
      // Level should be above close (resistance zone) — sweep means close < level < high
      if (candle.high > lv.price && candle.close < lv.price) {
        const penetration = candle.high - lv.price
        const penetrationPct = (penetration / lv.price) * 100
        if (penetrationPct <= maxPenetrationPct) {
          swept.push({
            sweptLevel: lv.price,
            levelType: lv.type,
            levelSource: lv.source,
            strength: lv.strength,
            sweepDepthPct: parseFloat(penetrationPct.toFixed(3)),
            notional: lv.notional || null,
          })
        }
      }
    }
  }

  if (swept.length === 0) return null

  // Pick the strongest swept level
  swept.sort((a, b) => b.strength - a.strength)
  const best = swept[0]
  best.levelsSwept = swept.length // how many levels were taken out at once

  return best
}


// ======================== CONFIDENCE SCORING ========================

/**
 * Calculate confidence score (30–95) for a confirmed sweep + pin bar signal.
 *
 * Components:
 *   Base          — 40 pts (a confirmed sweep+pinbar is already meaningful)
 *   Wick quality  — 0-15 pts (how clean the pin bar is)
 *   Level strength— 0-15 pts (swing touches, wall score, confluence)
 *   Volume spike  — 0-12 pts (candle volume vs average)
 *   OI drop       — 0-8 pts  (open interest decreased = liquidations)
 *   Wall absorbed — 0-5 pts  (density wall disappeared after sweep)
 *
 * @param {Object} params
 * @param {number} params.wickRatio      — from detectPinBar (0.6–1.0)
 * @param {number} params.levelStrength  — from the swept level (1–10)
 * @param {number} params.levelsSwept    — how many levels taken at once (1+)
 * @param {string} params.levelSource    — 'swing' | 'wall' | 'round'
 * @param {number} [params.volumeRatio]  — candle volume / SMA volume (null if unknown)
 * @param {number} [params.oiChangePct]  — OI change % on that candle (negative = drop)
 * @param {boolean}[params.wallAbsorbed] — density wall existed before and gone after
 * @returns {number} confidence 30–95
 */
function scoreConfidence({
  wickRatio = 0.6,
  levelStrength = 1,
  levelsSwept = 1,
  levelSource = 'swing',
  volumeRatio = null,
  oiChangePct = null,
  wallAbsorbed = false,
  trendContext = null, // 'counter' | 'with' | null
  fundingContext = null, // 'extreme' | null
}) {
  let score = 35 // base (lowered from 40 to make room for trend+funding)

  // --- Wick quality (0–15) ---
  // 0.60 → 0, 0.70 → 5, 0.80 → 10, 0.90+ → 15
  score += Math.min(15, Math.max(0, (wickRatio - 0.60) / 0.30 * 15))

  // --- Level strength (0–15) ---
  // strength 1→1.5, 5→7.5, 10→15 (wall confluence already adds +3 to strength)
  let lvlPts = Math.min(10, levelStrength * 1.5)
  // All signals are swing-based now (+3 base)
  lvlPts += 3
  // Confluence bonus: multiple levels swept at once
  if (levelsSwept >= 2) lvlPts += 2
  score += Math.min(15, lvlPts)

  // --- Volume spike (0–12) ---
  if (volumeRatio != null && volumeRatio > 1) {
    // 1.5x → 3, 2x → 6, 3x → 9, 5x+ → 12
    score += Math.min(12, Math.max(0, (volumeRatio - 1) * 3))
  }

  // --- OI drop (0–8) ---
  // Negative oiChangePct means OI decreased = stops hit / liquidations
  if (oiChangePct != null && oiChangePct < 0) {
    const drop = Math.abs(oiChangePct)
    // 0.5% → 2, 1% → 4, 2%+ → 8
    score += Math.min(8, drop * 4)
  }

  // --- Trend context (0–10) ---
  // Counter-trend sweep = exhaustion/reversal, much stronger signal
  // With-trend sweep = less reliable (might just be a pullback)
  if (trendContext === 'counter') {
    score += 10
  } else if (trendContext === 'with') {
    score += 2
  }

  // --- Funding extreme (0–5) ---
  // Sweep against overcrowded side = smart money liquidating the crowd
  if (fundingContext === 'extreme') {
    score += 5
  }

  // --- Wall absorbed (0–5) ---
  if (wallAbsorbed) {
    score += 5
  }

  return Math.max(30, Math.min(95, Math.round(score)))
}


// ======================== MERGE & DEDUPLICATE LEVELS ========================

/**
 * Merge levels from all sources and deduplicate nearby ones (within 0.15%).
 * Keeps the level with higher strength from each cluster.
 */
function mergeLevels(allLevels) {
  if (allLevels.length === 0) return []
  const sorted = [...allLevels].sort((a, b) => a.price - b.price)
  const result = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1]
    const pctDiff = Math.abs(sorted[i].price - prev.price) / prev.price
    if (pctDiff < 0.0015) {
      // Keep the stronger one
      if (sorted[i].strength > prev.strength) {
        result[result.length - 1] = sorted[i]
      }
    } else {
      result.push(sorted[i])
    }
  }
  return result
}


// ======================== SCAN LOOP ========================

const LIQ_SWEEP_SCAN_DELAY_MS = 150
const MIN_VOL_24H = 30_000_000
const MIN_VOLUME_RATIO = 5 // sweep candle volume must be >= 5x average

// In-memory 1h klines cache for sweep scanner (avoids 72 API calls per scan)
// Refreshed every 30min per symbol (1h candles don't change fast)
const _1hCache = new Map() // symbol → { candles, ts }
const _1H_CACHE_TTL = 30 * 60_000
const _1H_CACHE_MAX_AGE = 60 * 60_000 // evict entries older than 60min

// Periodic cleanup of stale 1h cache entries (every 10min)
const _cleanupInterval = setInterval(() => {
  const now = Date.now()
  let evicted = 0
  for (const [symbol, entry] of _1hCache) {
    if (now - entry.ts > _1H_CACHE_MAX_AGE) {
      _1hCache.delete(symbol)
      evicted++
    }
  }
  if (evicted > 0) console.log(`[liq-sweep] Cache cleanup: evicted ${evicted} stale entries, ${_1hCache.size} remaining`)
}, 10 * 60_000)

/**
 * Main scan function — called on a timer from signals.js.
 * Examines the latest closed 5m candle per liquid symbol for sweep + pin bar.
 *
 * @param {Object} deps — injected dependencies (same DI pattern as signals.js)
 * @param {Function} deps.getProxyCached
 * @param {Function} deps.bgetWithRetry
 * @param {Object}   deps.klinesCache
 * @param {Object}   deps.stateManager
 * @param {Object}   deps.densityV2
 * @param {Map}      deps.persistenceMap
 * @param {Function} deps.emitSignal
 */
async function scanLiqSweep(deps) {
  const {
    getProxyCached, bgetWithRetry, klinesCache,
    stateManager, densityV2, persistenceMap, emitSignal,
    getMarketRegime, getFundingMap,
  } = deps

  try {
    // --- Get liquid symbols from cached ticker ---
    let ticker = getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) {
      try { ticker = await bgetWithRetry('/fapi/v1/ticker/24hr') } catch { return }
      if (!Array.isArray(ticker)) return
    }

    const liquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOL_24H)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))

    // Get market regime once per scan (cached 5min)
    const regime = getMarketRegime ? await getMarketRegime() : { direction: null }

    // Funding rate map — reuse cached getFundingMap from signals.js (5min TTL)
    // Values are raw decimals (e.g. 0.0003), multiply by 100 for percentage when comparing
    const fundingRates = getFundingMap ? await getFundingMap() : {}

    let signalCount = 0
    let errCount = 0
    let pinBarCount = 0
    let sweepCount = 0
    let volGateSkipped = 0

    for (const t of liquid) {
      const symbol = t.symbol
      const markPrice = parseFloat(t.lastPrice)
      if (!markPrice) continue

      try {
        // --- 1. Get 5m candles (cache first, API fallback) ---
        let candles5m = klinesCache ? klinesCache.getCandles(symbol, '5m', 50) : []
        if (candles5m.length < 10) {
          // Fallback: fetch from Binance API (raw format)
          const raw = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=50`)
          if (!Array.isArray(raw) || raw.length < 10) continue
          candles5m = raw.map(k => ({
            time: Math.floor(k[0] / 1000),
            open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]),
            volume: parseFloat(k[7]), // quoteAssetVolume in USDT
          }))
        }

        // The last candle may still be forming — examine the second-to-last (latest closed)
        if (candles5m.length < 3) continue
        const targetCandle = candles5m[candles5m.length - 2]
        const prevCandles = candles5m.slice(Math.max(0, candles5m.length - 12), candles5m.length - 2) // 10 prior candles

        // --- 2. Detect pin bar ---
        const pinBar = detectPinBar(targetCandle, prevCandles)
        if (!pinBar) continue
        pinBarCount++

        // --- 3. Gather liquidity levels ---
        // 3a. Swing levels from 1h candles (SQLite cache → memory cache → API)
        let candles1h = klinesCache ? klinesCache.getCandles(symbol, '1h', 200) : null
        if (!candles1h || candles1h.length < 20) {
          // Check in-memory 1h cache
          const cached1h = _1hCache.get(symbol)
          if (cached1h && Date.now() - cached1h.ts < _1H_CACHE_TTL) {
            candles1h = cached1h.candles
          } else {
            try {
              const raw1h = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=200`)
              if (Array.isArray(raw1h) && raw1h.length >= 20) {
                candles1h = raw1h.map(k => ({
                  time: Math.floor(k[0] / 1000),
                  open: parseFloat(k[1]), high: parseFloat(k[2]),
                  low: parseFloat(k[3]), close: parseFloat(k[4]),
                  volume: parseFloat(k[7]),
                }))
                _1hCache.set(symbol, { candles: candles1h, ts: Date.now() })
              } else { candles1h = null }
            } catch { candles1h = null }
          }
        }
        const swingLevels = candles1h ? findSwingLevels(candles1h, 5, 3) : []

        // 3b. Order book walls — used as confluence boost, not standalone trigger
        const wallLevels = getWallLevels({ symbol, markPrice, stateManager, densityV2, persistenceMap })

        // 3c. Boost swing levels that coincide with walls (±0.2%)
        for (const sw of swingLevels) {
          const hasWallConfluence = wallLevels.some(w => Math.abs(w.price - sw.price) / sw.price < 0.002)
          if (hasWallConfluence) {
            sw.strength = (sw.strength || 1) + 3 // wall confluence bonus
            sw.wallConfluence = true
          }
        }

        // 3d. Only use swing levels (round numbers removed, walls are boost only)
        const allLevels = mergeLevels(swingLevels)
        if (allLevels.length === 0) continue

        // --- 4. Confirm sweep ---
        const sweep = confirmSweep(targetCandle, pinBar, allLevels)
        if (!sweep) continue
        sweepCount++

        // --- 5. Volume ratio (candle vol vs SMA of prior candles) ---
        // Gate: real sweeps ALWAYS have volume (stops/liquidations trigger).
        // Skip anything below MIN_VOLUME_RATIO — it's just noise.
        let volumeRatio = null
        if (prevCandles.length >= 5) {
          const avgVol = prevCandles.reduce((s, c) => s + (c.volume || 0), 0) / prevCandles.length
          if (avgVol > 0 && targetCandle.volume) {
            volumeRatio = targetCandle.volume / avgVol
          }
        }
        if (volumeRatio == null || volumeRatio < MIN_VOLUME_RATIO) { volGateSkipped++; continue }

        // --- 5b. OI change — confirms liquidations/stop hunts ---
        // Only fetched for signals that passed all gates (saves API calls)
        let oiChangePct = null
        try {
          const oiHist = await bgetWithRetry(
            `/futures/data/openInterestHist?symbol=${symbol}&period=5min&limit=3`
          )
          if (Array.isArray(oiHist) && oiHist.length >= 2) {
            const oiPrev = parseFloat(oiHist[oiHist.length - 2].sumOpenInterest)
            const oiCurr = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest)
            if (oiPrev > 0) {
              oiChangePct = ((oiCurr - oiPrev) / oiPrev) * 100
            }
          }
        } catch { /* OI data unavailable — score without it */ }

        // --- 5c. Trend context — counter-trend sweeps are stronger ---
        // LONG sweep in BEARISH market = counter-trend exhaustion → strongest
        // SHORT sweep in BULLISH market = counter-trend exhaustion → strongest
        let trendContext = null
        if (regime.direction) {
          const isCounter =
            (pinBar.direction === 'LONG' && regime.direction === 'BEARISH') ||
            (pinBar.direction === 'SHORT' && regime.direction === 'BULLISH')
          trendContext = isCounter ? 'counter' : 'with'
        }

        // --- 5d. Funding rate context ---
        // Extreme funding + sweep against the crowd = smart money
        // fundingRates values are raw decimals (0.0003 = 0.03%)
        const rawFunding = fundingRates[symbol]
        const fundingPct = rawFunding != null ? rawFunding * 100 : null
        let fundingContext = null
        if (fundingPct != null) {
          if (fundingPct > 0.03 && pinBar.direction === 'SHORT') fundingContext = 'extreme'
          else if (fundingPct < -0.02 && pinBar.direction === 'LONG') fundingContext = 'extreme'
        }

        // --- 6. Score confidence ---
        const confidence = scoreConfidence({
          wickRatio: pinBar.wickRatio,
          levelStrength: sweep.strength,
          levelsSwept: sweep.levelsSwept,
          levelSource: sweep.levelSource,
          volumeRatio,
          oiChangePct,
          wallAbsorbed: false,
          trendContext,
          fundingContext,
        })

        // --- 7. Emit signal ---
        const candleTimeIso = new Date(targetCandle.time * 1000).toISOString()

        emitSignal({
          type: 'liq_sweep',
          symbol,
          price: markPrice,
          signalTime: candleTimeIso,
          direction: pinBar.direction,
          confidence,
          description: `🎯 ${pinBar.direction === 'LONG' ? 'Bullish' : 'Bearish'} sweep — wick took ${sweep.levelType.replace('_', ' ')} at ${sweep.sweptLevel}, recovered (${(pinBar.wickRatio * 100).toFixed(0)}% wick)`,
          metadata: {
            sweptLevel: sweep.sweptLevel,
            levelType: sweep.levelType,
            levelSource: sweep.levelSource,
            sweepDepthPct: sweep.sweepDepthPct,
            levelsSwept: sweep.levelsSwept,
            wickRatio: pinBar.wickRatio,
            bodyRatio: pinBar.bodyRatio,
            candleRange: parseFloat(pinBar.range.toFixed(4)),
            volumeRatio: volumeRatio ? parseFloat(volumeRatio.toFixed(1)) : null,
            oiChangePct: oiChangePct != null ? parseFloat(oiChangePct.toFixed(2)) : null,
            trendContext: trendContext || 'unknown',
            fundingContext: fundingContext || 'normal',
            fundingPct: fundingPct != null ? parseFloat(fundingPct.toFixed(4)) : null,
            marketRegime: regime.direction || 'UNKNOWN',
            wallNotional: sweep.notional,
            change24h: parseFloat(t.priceChangePercent),
            volume24h: Math.round(parseFloat(t.quoteVolume)),
          },
        })
        signalCount++

      } catch (e) {
        errCount++
        if (errCount <= 3) console.warn(`[LiqSweep] ${symbol} error:`, e.message)
      }

      await new Promise(r => setTimeout(r, LIQ_SWEEP_SCAN_DELAY_MS))
    }

    console.log(`[LiqSweep] Scan done: ${liquid.length} symbols | pinBars: ${pinBarCount}, sweeps: ${sweepCount}, volGate(<${MIN_VOLUME_RATIO}x): ${volGateSkipped}, signals: ${signalCount}${errCount ? ` [${errCount} errors]` : ''}`)
  } catch (err) {
    console.error('[LiqSweep] Scan error:', err.message)
  }
}


// ======================== EXPORTS ========================

module.exports = {
  findSwingLevels,
  findRoundNumbers,
  getWallLevels,
  detectPinBar,
  confirmSweep,
  scoreConfidence,
  scanLiqSweep,
  // cleanup interval — register in _intervals for graceful shutdown
  _cleanupInterval,
  // internal — exported for testing
  mergeLevels,
  clusterLevels,
  getRoundStep,
}
