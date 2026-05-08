const { createLogger } = require('./logger')
const log = createLogger('channel')
const BINANCE_FAPI = 'https://fapi.binance.com'

/**
 * Channel Signal v2 — Regression Channel with Trend-Aware Logic
 *
 * Three sub-types:
 * 1. channel_bounce      — with-trend reversion from band (main signal)
 * 2. channel_reversal    — counter-trend breakout (trend change)
 * 3. channel_acceleration — with-trend breakout (momentum)
 *
 * Flat channels: only bounce (both sides), no breakout signals.
 *
 * Multi-TF: 5m, 15m, 1h — independent scans with confluence detection (★★/★★★)
 * Touch count: tracks # of approaches to band, adjusts confidence
 */

// ======================== CONFIGURATION ========================

const TIMEFRAMES = [
  { interval: '5m', scanMs: 60_000, startDelay: 35_000, label: '5m' },
  { interval: '15m', scanMs: 90_000, startDelay: 45_000, label: '15m' },
  { interval: '1h', scanMs: 5 * 60_000, startDelay: 60_000, label: '1h' },
]

const KLINES_LIMIT = 220  // must cover max regression period (200) + buffer
const MIN_VOLUME_24H = 30_000_000
const MIN_R2 = 0.65
const BAND_MULT = 2.0
const TOP_N_SYMBOLS = 80
const MIN_BANDWIDTH_PCT = 0.5         // skip channels narrower than 0.5% (noise, not tradeable)

// Slope thresholds (% per candle, normalized)
const SLOPE_FLAT_THRESHOLD = 0.015   // |slope| < 0.015% = flat
const SLOPE_STRONG_THRESHOLD = 0.06  // |slope| > 0.06% = strong trend

// Volume gates
const VOL_GATE_BOUNCE = 1.2          // bounce needs some interest
const VOL_GATE_REVERSAL = 2.0        // counter-trend break needs conviction (was 3.0, lowered for 5m/15m)
const VOL_GATE_ACCELERATION = 2.5    // with-trend break needs momentum

// Quality filters
const MIN_NATR_PCT = 0.5             // skip low-volatility coins (NATR < 0.5%)

// Signal detection
const MIN_PENETRATION_PCT = 0.1      // min % beyond band for breakout
const APPROACH_ZONE_PCT = 0.3        // within 0.3% of band = "approaching"
const WICK_REJECTION_MIN = 0.3       // wick must be ≥30% of candle for rejection

// Confidence
const BASE_CONF = { bounce: 60, reversal: 50, acceleration: 50 }
const CONF_R2_MAX = 12               // +12 at R²=0.95
const CONF_STRONG_SLOPE = 5          // +5 for strong trend
const CONF_WICK_REJECTION = 10       // +10 for wick + return
const CONF_VOL_PER_X = 3             // +3 per extra 1x volume (max +10)
const CONF_VOL_MAX = 10
const CONF_BTC_ALIGN = 5             // +5 if BTC trend aligns
const CONF_TOUCH = { 1: 0, 2: 8, 3: 12, '4+_bounce': -5, '4+_breakout': 10 }
const CONF_CONFLUENCE = { 2: 10, 3: 15 }

const CONF_MIN = 35
const CONF_MAX = 95

// Confluence window: signals within this time window count as confluence
const CONFLUENCE_WINDOW_MS = 60 * 60_000 // 1 hour

// ======================== STATE ========================

// Recent signals for confluence: [{symbol, direction, subType, interval, time}]
const recentChannelSignals = []
const MAX_RECENT_SIGNALS = 500

// ======================== REGRESSION CHANNEL ========================

function computeRegressionChannel(closes, mult = BAND_MULT) {
  const n = closes.length
  if (n < 30) return null

  let bestScore = -Infinity, bestPeriod = 50, bestR2 = 0
  const periods = [20, 30, 50, 75, 100, 150, 200].filter(p => p <= n)

  for (const period of periods) {
    const start = n - period
    let sx = 0, sy = 0, sxy = 0, sxx = 0
    for (let i = start; i < n; i++) {
      const x = i - start
      const y = closes[i]
      sx += x; sy += y; sxy += x * y; sxx += x * x
    }
    const denom = period * sxx - sx * sx
    if (denom === 0) continue
    const slope = (period * sxy - sx * sy) / denom
    const intercept = (sy - slope * sx) / period

    let ssRes = 0, ssTot = 0
    const meanY = sy / period
    for (let i = start; i < n; i++) {
      const x = i - start
      const predicted = intercept + slope * x
      ssRes += (closes[i] - predicted) ** 2
      ssTot += (closes[i] - meanY) ** 2
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0
    const score = r2 * Math.log(period)
    if (score > bestScore) { bestScore = score; bestPeriod = period; bestR2 = r2 }
  }

  if (bestR2 < MIN_R2) return null

  const start = n - bestPeriod
  let sx = 0, sy = 0, sxy = 0, sxx = 0
  for (let i = start; i < n; i++) {
    const x = i - start; const y = closes[i]
    sx += x; sy += y; sxy += x * y; sxx += x * x
  }
  const denom = bestPeriod * sxx - sx * sx
  if (denom === 0) return null
  const slope = (bestPeriod * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / bestPeriod

  let sumSqDev = 0
  for (let i = start; i < n; i++) {
    const x = i - start
    const dev = closes[i] - (intercept + slope * x)
    sumSqDev += dev * dev
  }
  const sigma = Math.sqrt(sumSqDev / bestPeriod)

  const lastX = bestPeriod - 1
  const mid = intercept + slope * lastX
  const upper = mid + sigma * mult
  const lower = mid - sigma * mult
  const slopePct = mid > 0 ? (slope / mid * 100) : 0

  // Classify slope
  const absSlopePct = Math.abs(slopePct)
  const slopeClass = absSlopePct < SLOPE_FLAT_THRESHOLD ? 'flat'
    : absSlopePct < SLOPE_STRONG_THRESHOLD ? 'mild' : 'strong'
  const slopeDir = slopePct > SLOPE_FLAT_THRESHOLD ? 'up'
    : slopePct < -SLOPE_FLAT_THRESHOLD ? 'down' : 'flat'

  return {
    mid, upper, lower, sigma, slope, slopePct, slopeClass, slopeDir,
    r2: bestR2, period: bestPeriod,
    bandWidth: upper - lower,
    bandWidthPct: mid > 0 ? ((upper - lower) / mid * 100) : 0,
    intercept, start,
  }
}

// ======================== TOUCH COUNT ========================

function getTouchCount(symbol, side, tf, channel, candles) {
  // Count approaches within the channel's period window
  const periodCandles = candles.slice(-channel.period)
  const band = side === 'upper' ? channel.upper : channel.lower
  const zone = band * (APPROACH_ZONE_PCT / 100)

  let touches = 0
  let lastTouchIdx = -10 // prevent double-counting adjacent candles
  for (let i = 0; i < periodCandles.length; i++) {
    const c = periodCandles[i]
    const nearBand = side === 'upper'
      ? (c.high >= band - zone)
      : (c.low <= band + zone)
    if (nearBand && i - lastTouchIdx >= 3) { // min 3 candles between touches
      touches++
      lastTouchIdx = i
    }
  }

  return touches
}

// ======================== SIGNAL DETECTION ========================

function detectChannelSignal(candles, volumeSma, tf) {
  if (!candles || candles.length < 30) return null

  const closes = candles.map(c => c.close)
  const channel = computeRegressionChannel(closes)
  if (!channel) return null
  if (channel.bandWidthPct < MIN_BANDWIDTH_PCT) return null // too narrow, noise

  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const { upper, lower, mid, r2, slopeDir, slopeClass, slopePct } = channel

  const volRatio = volumeSma > 0 ? last.volume / volumeSma : 1
  const candleRange = last.high - last.low
  if (candleRange === 0) return null

  const signals = [] // can detect multiple conditions

  // ==================== FLAT CHANNEL ====================
  if (slopeDir === 'flat') {
    // Only bounce from both sides
    // Upper bounce → SHORT
    if (last.high >= upper * (1 - APPROACH_ZONE_PCT / 100) && last.close < upper && volRatio >= VOL_GATE_BOUNCE) {
      const wickAbove = last.high - Math.max(last.open, last.close)
      const wickRejection = wickAbove / candleRange >= WICK_REJECTION_MIN
      const penetrated = last.high > upper
      signals.push({
        subType: 'channel_bounce',
        direction: 'SHORT',
        reason: 'flat_upper_bounce',
        wickRejection: wickRejection || penetrated,
        penetration: penetrated ? (last.high - upper) / upper * 100 : 0,
        volRatio, channel, side: 'upper',
      })
    }
    // Lower bounce → LONG
    if (last.low <= lower * (1 + APPROACH_ZONE_PCT / 100) && last.close > lower && volRatio >= VOL_GATE_BOUNCE) {
      const wickBelow = Math.min(last.open, last.close) - last.low
      const wickRejection = wickBelow / candleRange >= WICK_REJECTION_MIN
      const penetrated = last.low < lower
      signals.push({
        subType: 'channel_bounce',
        direction: 'LONG',
        reason: 'flat_lower_bounce',
        wickRejection: wickRejection || penetrated,
        penetration: penetrated ? (lower - last.low) / lower * 100 : 0,
        volRatio, channel, side: 'lower',
      })
    }
    // Return best signal (highest priority)
    return signals.length > 0 ? signals[0] : null
  }

  // ==================== TRENDING CHANNEL ====================

  // --- BOUNCE (with-trend) ---
  if (slopeDir === 'up') {
    // Ascending: LONG from lower band
    if (last.low <= lower * (1 + APPROACH_ZONE_PCT / 100) && last.close > lower && volRatio >= VOL_GATE_BOUNCE) {
      const wickBelow = Math.min(last.open, last.close) - last.low
      const wickRejection = wickBelow / candleRange >= WICK_REJECTION_MIN
      const penetrated = last.low < lower
      signals.push({
        subType: 'channel_bounce',
        direction: 'LONG',
        reason: 'ascending_lower_bounce',
        wickRejection: wickRejection || penetrated,
        penetration: penetrated ? (lower - last.low) / lower * 100 : 0,
        volRatio, channel, side: 'lower',
      })
    }
  } else if (slopeDir === 'down') {
    // Descending: SHORT from upper band
    if (last.high >= upper * (1 - APPROACH_ZONE_PCT / 100) && last.close < upper && volRatio >= VOL_GATE_BOUNCE) {
      const wickAbove = last.high - Math.max(last.open, last.close)
      const wickRejection = wickAbove / candleRange >= WICK_REJECTION_MIN
      const penetrated = last.high > upper
      signals.push({
        subType: 'channel_bounce',
        direction: 'SHORT',
        reason: 'descending_upper_bounce',
        wickRejection: wickRejection || penetrated,
        penetration: penetrated ? (last.high - upper) / upper * 100 : 0,
        volRatio, channel, side: 'upper',
      })
    }
  }

  // --- REVERSAL (counter-trend breakout) ---
  if (slopeDir === 'down' && last.close > upper && volRatio >= VOL_GATE_REVERSAL) {
    // Descending channel + break above upper → LONG reversal
    const penetration = (last.close - upper) / upper * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      const prevWasInside = prev.close <= upper * 1.002
      if (prevWasInside) {
        signals.push({
          subType: 'channel_reversal',
          direction: 'LONG',
          reason: 'descending_upper_breakout',
          wickRejection: false,
          penetration,
          volRatio, channel, side: 'upper',
        })
      }
    }
  }
  if (slopeDir === 'up' && last.close < lower && volRatio >= VOL_GATE_REVERSAL) {
    // Ascending channel + break below lower → SHORT reversal
    const penetration = (lower - last.close) / lower * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      const prevWasInside = prev.close >= lower * 0.998
      if (prevWasInside) {
        signals.push({
          subType: 'channel_reversal',
          direction: 'SHORT',
          reason: 'ascending_lower_breakout',
          wickRejection: false,
          penetration,
          volRatio, channel, side: 'lower',
        })
      }
    }
  }

  // --- ACCELERATION (with-trend breakout) ---
  if (slopeDir === 'up' && last.close > upper && volRatio >= VOL_GATE_ACCELERATION) {
    // Ascending + break above upper → LONG acceleration
    const penetration = (last.close - upper) / upper * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      const prevWasInside = prev.close <= upper * 1.002
      if (prevWasInside) {
        signals.push({
          subType: 'channel_acceleration',
          direction: 'LONG',
          reason: 'ascending_upper_breakout',
          wickRejection: false,
          penetration,
          volRatio, channel, side: 'upper',
        })
      }
    }
  }
  if (slopeDir === 'down' && last.close < lower && volRatio >= VOL_GATE_ACCELERATION) {
    // Descending + break below lower → SHORT acceleration
    const penetration = (lower - last.close) / lower * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      const prevWasInside = prev.close >= lower * 0.998
      if (prevWasInside) {
        signals.push({
          subType: 'channel_acceleration',
          direction: 'SHORT',
          reason: 'descending_lower_breakout',
          wickRejection: false,
          penetration,
          volRatio, channel, side: 'lower',
        })
      }
    }
  }

  // Return first signal found (priority: bounce > reversal > acceleration)
  return signals.length > 0 ? signals[0] : null
}

// ======================== CONFLUENCE ========================

function checkConfluence(symbol, direction, subType, interval) {
  const now = Date.now()
  const matching = recentChannelSignals.filter(s =>
    s.symbol === symbol &&
    s.direction === direction &&
    s.interval !== interval && // different TF
    now - s.time < CONFLUENCE_WINDOW_MS
  )
  const tfs = new Set(matching.map(s => s.interval))
  tfs.add(interval) // include current
  return { count: tfs.size, timeframes: [...tfs].sort() }
}

function recordSignalForConfluence(symbol, direction, subType, interval) {
  recentChannelSignals.push({ symbol, direction, subType, interval, time: Date.now() })
  // Trim old entries
  while (recentChannelSignals.length > MAX_RECENT_SIGNALS) recentChannelSignals.shift()
}

// ======================== CONFIDENCE CALCULATOR ========================

function calcConfidence(sig, touchCount, confluence, regime) {
  const isBreakout = sig.subType !== 'channel_bounce'
  let conf = BASE_CONF[sig.subType.replace('channel_', '')] || 50

  // R² boost (linear from MIN_R2 to 0.95)
  const r2Boost = Math.min(CONF_R2_MAX, ((sig.channel.r2 - MIN_R2) / (0.95 - MIN_R2)) * CONF_R2_MAX)
  conf += Math.max(0, r2Boost)

  // Strong slope boost
  if (sig.channel.slopeClass === 'strong') conf += CONF_STRONG_SLOPE

  // Wick rejection (bounce only)
  if (sig.subType === 'channel_bounce' && sig.wickRejection) conf += CONF_WICK_REJECTION

  // Volume boost
  const baseVol = isBreakout ? VOL_GATE_REVERSAL : VOL_GATE_BOUNCE
  const volExtra = Math.max(0, sig.volRatio - baseVol)
  conf += Math.min(CONF_VOL_MAX, Math.floor(volExtra * CONF_VOL_PER_X))

  // Touch count
  if (touchCount >= 4) {
    conf += isBreakout ? CONF_TOUCH['4+_breakout'] : CONF_TOUCH['4+_bounce']
  } else if (CONF_TOUCH[touchCount] !== undefined) {
    conf += CONF_TOUCH[touchCount]
  }

  // Multi-TF confluence
  if (confluence.count >= 3) conf += CONF_CONFLUENCE[3]
  else if (confluence.count >= 2) conf += CONF_CONFLUENCE[2]

  // BTC trend alignment
  if (regime && regime.direction) {
    const aligned = (
      (sig.direction === 'LONG' && regime.direction === 'BULLISH') ||
      (sig.direction === 'SHORT' && regime.direction === 'BEARISH')
    )
    if (aligned) conf += CONF_BTC_ALIGN
  }

  // Penetration boost for breakouts
  if (isBreakout && sig.penetration > 0) {
    conf += Math.min(5, Math.floor(sig.penetration * 3))
  }

  return Math.max(CONF_MIN, Math.min(CONF_MAX, Math.round(conf)))
}

// ======================== DESCRIPTION BUILDER ========================

function buildDescription(sig, touchCount, confluence, interval) {
  const icons = { channel_bounce: '↩️', channel_reversal: '🔄', channel_acceleration: '🚀' }
  const labels = { channel_bounce: 'Bounce', channel_reversal: 'Reversal', channel_acceleration: 'Acceleration' }

  const icon = icons[sig.subType] || '📐'
  const label = labels[sig.subType] || sig.subType

  // Stars for confluence
  const stars = confluence.count >= 3 ? ' ★★★' : confluence.count >= 2 ? ' ★★' : ''
  const tfStr = confluence.count > 1 ? ` [${confluence.timeframes.join(',')}]` : ` [${interval}]`

  // Touch info
  const touchStr = touchCount > 1 ? `, ${touchCount}${touchCount === 2 ? 'nd' : touchCount === 3 ? 'rd' : 'th'} touch` : ''

  // Wick rejection
  const wickStr = sig.wickRejection ? ', wick rejection' : ''

  // Channel direction
  const dirLabel = sig.channel.slopeDir === 'up' ? 'ascending' : sig.channel.slopeDir === 'down' ? 'descending' : 'flat'
  const bandSide = sig.side === 'upper' ? 'upper' : 'lower'

  // Volume for breakouts
  const volStr = sig.subType !== 'channel_bounce' ? ` vol ${sig.volRatio.toFixed(1)}x` : ''

  return `${icon} Channel ${label}${stars} — ${dirLabel} ${bandSide} band${touchStr}${wickStr}${tfStr} R²=${sig.channel.r2.toFixed(2)}${volStr}`
}

// ======================== SCANNER ========================

async function scanChannelSignals({ getProxyCached, bgetWithRetry, klinesCache, emitSignal, getMarketRegime, getFundingMap, getNatrMap }, tfConfig) {
  const { interval, label } = tfConfig
  const scanStart = Date.now()
  let signalCount = 0, skipped = 0, errors = 0

  try {
    let ticker = getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) {
      try {
        const resp = await fetch(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(15_000) })
        if (resp.ok) ticker = await resp.json()
      } catch { return }
      if (!Array.isArray(ticker)) return
    }

    const liquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_N_SYMBOLS)

    const fundingMap = await getFundingMap()
    const regime = await getMarketRegime()
    const natrMap = getNatrMap ? getNatrMap() : {}

    for (const t of liquid) {
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      if (!price) continue

      // NATR filter — skip low-volatility coins
      const natr = natrMap[symbol]
      if (natr != null && natr < MIN_NATR_PCT) { skipped++; continue }

      try {
        // Fetch klines (cache first, API fallback)
        let candles = klinesCache ? klinesCache.getCandles(symbol, interval, KLINES_LIMIT) : []
        if (!candles || candles.length < 50) {
          const raw = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${KLINES_LIMIT}`)
          if (!Array.isArray(raw) || raw.length < 50) { skipped++; continue }
          candles = raw.map(k => ({
            time: Math.floor(parseInt(k[0]) / 1000),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[7]),
          }))
        }

        if (candles.length < 50) { skipped++; continue }

        // Volume SMA(20) from candles before last
        const recentVols = candles.slice(-21, -1)
        const volumeSma = recentVols.reduce((s, c) => s + c.volume, 0) / recentVols.length

        // Detect signal
        const sig = detectChannelSignal(candles, volumeSma, interval)
        if (!sig) continue

        // Touch count
        const touchCount = getTouchCount(symbol, sig.side, interval, sig.channel, candles)

        // Confluence check
        const confluence = checkConfluence(symbol, sig.direction, sig.subType, interval)

        // Calculate confidence
        const confidence = calcConfidence(sig, touchCount, confluence, regime)

        // Build description
        const description = buildDescription(sig, touchCount, confluence, interval)

        // Build metadata
        const metadata = {
          subType: sig.subType,
          reason: sig.reason,
          interval,
          slopePct: parseFloat(sig.channel.slopePct.toFixed(4)),
          slopeClass: sig.channel.slopeClass,
          slopeDir: sig.channel.slopeDir,
          r2: parseFloat(sig.channel.r2.toFixed(3)),
          period: sig.channel.period,
          channelUpper: parseFloat(sig.channel.upper.toFixed(4)),
          channelMid: parseFloat(sig.channel.mid.toFixed(4)),
          channelLower: parseFloat(sig.channel.lower.toFixed(4)),
          bandWidthPct: parseFloat(sig.channel.bandWidthPct.toFixed(2)),
          touchCount,
          penetrationPct: parseFloat((sig.penetration || 0).toFixed(3)),
          wickRejection: !!sig.wickRejection,
          volumeRatio: parseFloat(sig.volRatio.toFixed(2)),
          confluence: confluence.count,
          timeframes: confluence.timeframes,
          fundingRate: fundingMap[symbol] != null ? parseFloat((fundingMap[symbol] * 100).toFixed(4)) : null,
          natr: natrMap[symbol] || null,
          volume24h: Math.round(parseFloat(t.quoteVolume)),
        }

        // Emit — use type 'channel' with subType in metadata for cooldown keying
        const signalTime = new Date(candles[candles.length - 1].time * 1000).toISOString()
        emitSignal({
          type: 'channel',
          symbol,
          direction: sig.direction,
          price,
          confidence,
          description,
          metadata,
          signalTime,
        })

        // Record for confluence tracking
        recordSignalForConfluence(symbol, sig.direction, sig.subType, interval)
        signalCount++

      } catch (e) {
        errors++
        if (errors <= 3) log.warn({ tf: label, symbol, err: e.message }, 'Scan error')
      }

      // Rate limit between symbols
      await new Promise(r => setTimeout(r, 80))
    }

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1)
    if (signalCount > 0 || errors > 0) {
      log.info({ tf: label, signals: signalCount, skipped, errors, elapsedSec: elapsed }, 'Scan done')
    }
  } catch (err) {
    log.error({ tf: label, err: err.message }, 'Scanner error')
  }
}

// ======================== INIT (multi-TF) ========================

const _timers = []

function initChannelScanners(deps) {
  for (const tf of TIMEFRAMES) {
    const timer = setInterval(() => scanChannelSignals(deps, tf), tf.scanMs)
    setTimeout(() => scanChannelSignals(deps, tf), tf.startDelay)
    _timers.push(timer)
  }
  log.info({ timeframes: TIMEFRAMES.map(t => `${t.label}(${t.scanMs / 1000}s)`) }, 'Multi-TF scanners started')
}

function stopChannelScanners() {
  _timers.forEach(t => clearInterval(t))
  _timers.length = 0
}

module.exports = {
  initChannelScanners, stopChannelScanners, scanChannelSignals, computeRegressionChannel,
  // Exported for testing
  detectChannelSignal, calcConfidence, checkConfluence, recordSignalForConfluence,
  getTouchCount, recentChannelSignals,
}
