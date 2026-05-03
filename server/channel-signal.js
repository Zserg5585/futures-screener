/**
 * Channel Signal — Regression Channel Reversion & Breakout
 *
 * Two sub-types:
 * 1. channel_reversion — price wicks beyond ±2σ but closes back inside → mean reversion to mid
 * 2. channel_breakout  — price closes beyond ±2σ with volume → continuation trade
 *
 * Timeframe: 5m (configurable)
 * Lookback: adaptive (20-200 candles, best R²×log(period))
 * Bands: ±2σ from regression line
 */

// ======================== CONFIGURATION ========================

const INTERVAL = '5m'
const KLINES_LIMIT = 150          // enough for adaptive regression (max period 200, but 150 covers most)
const MIN_VOLUME_24H = 30_000_000 // $30M min 24h volume
const MIN_R2 = 0.65              // minimum R² for valid channel (skip choppy/ranging)
const VOLUME_GATE_REVERSION = 1.5 // min volume ratio for reversion (confirms interest)
const VOLUME_GATE_BREAKOUT = 2.5  // min volume ratio for breakout (confirms conviction)
const BAND_MULT = 2.0             // ±2σ bands
const MIN_PENETRATION_PCT = 0.15  // min % beyond band for signal (avoid noise)
const MAX_BODY_INSIDE_PCT = 0.7   // reversion: body must close ≥30% back inside band

// Confidence tuning
const BASE_CONF_REVERSION = 55
const BASE_CONF_BREAKOUT = 50
const R2_BOOST_MAX = 15           // +15 at R²=0.95
const VOL_BOOST_MAX = 10          // +10 at vol 5x+
const TREND_ALIGN_BOOST = 8       // +8 if signal aligns with BTC trend

// ======================== REGRESSION CHANNEL ========================

/**
 * Compute regression channel (ported from frontend mini-charts.js)
 * Adaptive period selection via R²×log(length) scoring
 */
function computeRegressionChannel(closes, mult = BAND_MULT) {
  const n = closes.length
  if (n < 30) return null

  // Scan multiple lookback periods, pick best by R² × log(length)
  let bestScore = -Infinity, bestPeriod = 50, bestR2 = 0
  const periods = [20, 30, 50, 75, 100, 150].filter(p => p <= n)

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

    // R²
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

  if (bestR2 < MIN_R2) return null // channel not well-defined, skip

  // Compute regression for best period
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

  // Standard deviation from regression line
  let sumSqDev = 0
  for (let i = start; i < n; i++) {
    const x = i - start
    const dev = closes[i] - (intercept + slope * x)
    sumSqDev += dev * dev
  }
  const sigma = Math.sqrt(sumSqDev / bestPeriod)

  // Last candle values
  const lastX = bestPeriod - 1
  const mid = intercept + slope * lastX
  const upper = mid + sigma * mult
  const lower = mid - sigma * mult

  // Slope as % per candle (normalized)
  const slopePct = mid > 0 ? (slope / mid * 100) : 0

  return {
    mid, upper, lower, sigma, slope, slopePct,
    r2: bestR2,
    period: bestPeriod,
    bandWidth: upper - lower,
    bandWidthPct: mid > 0 ? ((upper - lower) / mid * 100) : 0,
  }
}

// ======================== SIGNAL DETECTION ========================

/**
 * Analyze last closed candle against channel boundaries
 * Returns signal object or null
 */
function detectChannelSignal(candles, volumeSma) {
  if (!candles || candles.length < 30) return null

  const closes = candles.map(c => c.close)
  const channel = computeRegressionChannel(closes)
  if (!channel) return null

  const last = candles[candles.length - 1]    // last CLOSED candle
  const prev = candles[candles.length - 2]    // previous candle (for confirmation)
  const { upper, lower, mid, r2, bandWidthPct, slopePct, period } = channel

  // Current volume ratio
  const volRatio = volumeSma > 0 ? last.volume / volumeSma : 1

  // === REVERSION DETECTION ===
  // Condition: wick beyond band, but close returned inside
  // Upper band reversion (SHORT)
  if (last.high > upper && last.close <= upper) {
    const penetration = (last.high - upper) / upper * 100
    if (penetration >= MIN_PENETRATION_PCT && volRatio >= VOLUME_GATE_REVERSION) {
      // Check rejection quality: how much body returned inside
      const candleRange = last.high - last.low
      const bodyReturnPct = candleRange > 0 ? (last.high - Math.max(last.open, last.close)) / candleRange : 0
      if (bodyReturnPct >= 0.3) { // upper wick ≥30% of candle = rejection
        return {
          subType: 'channel_reversion',
          direction: 'SHORT',
          reason: 'upper_band_rejection',
          penetration,
          volRatio,
          bodyReturnPct,
          channel,
          targetMid: mid,
          targetPct: ((last.close - mid) / last.close * 100),
        }
      }
    }
  }

  // Lower band reversion (LONG)
  if (last.low < lower && last.close >= lower) {
    const penetration = (lower - last.low) / lower * 100
    if (penetration >= MIN_PENETRATION_PCT && volRatio >= VOLUME_GATE_REVERSION) {
      const candleRange = last.high - last.low
      const bodyReturnPct = candleRange > 0 ? (Math.min(last.open, last.close) - last.low) / candleRange : 0
      if (bodyReturnPct >= 0.3) { // lower wick ≥30% of candle = rejection
        return {
          subType: 'channel_reversion',
          direction: 'LONG',
          reason: 'lower_band_rejection',
          penetration,
          volRatio,
          bodyReturnPct,
          channel,
          targetMid: mid,
          targetPct: ((mid - last.close) / last.close * 100),
        }
      }
    }
  }

  // === BREAKOUT DETECTION ===
  // Condition: CLOSE beyond band (not just wick) + strong volume
  // Previous candle should have been inside (confirms fresh breakout, not continuation)

  // Upper breakout (LONG — momentum continuation)
  if (last.close > upper && volRatio >= VOLUME_GATE_BREAKOUT) {
    const penetration = (last.close - upper) / upper * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      // Confirm previous candle was inside or near band
      const prevWasInside = prev.close <= upper * 1.001 // allow tiny tolerance
      if (prevWasInside) {
        return {
          subType: 'channel_breakout',
          direction: 'LONG',
          reason: 'upper_band_breakout',
          penetration,
          volRatio,
          bodyReturnPct: 0,
          channel,
          targetMid: null,
          targetPct: penetration, // already moved this much, momentum
        }
      }
    }
  }

  // Lower breakout (SHORT — momentum continuation)
  if (last.close < lower && volRatio >= VOLUME_GATE_BREAKOUT) {
    const penetration = (lower - last.close) / lower * 100
    if (penetration >= MIN_PENETRATION_PCT) {
      const prevWasInside = prev.close >= lower * 0.999
      if (prevWasInside) {
        return {
          subType: 'channel_breakout',
          direction: 'SHORT',
          reason: 'lower_band_breakout',
          penetration,
          volRatio,
          bodyReturnPct: 0,
          channel,
          targetMid: null,
          targetPct: penetration,
        }
      }
    }
  }

  return null
}

// ======================== SCANNER ========================

/**
 * Main scanner function — called from signals.js
 * @param {Object} deps — injected dependencies
 */
async function scanChannelSignals({ getProxyCached, bgetWithRetry, klinesCache, emitSignal, getMarketRegime, getFundingMap }) {
  const scanStart = Date.now()
  let signalCount = 0, skipped = 0, errors = 0

  try {
    // Get ticker for liquid symbols
    let ticker = getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker)) {
      try { ticker = await bgetWithRetry('/fapi/v1/ticker/24hr') } catch { return }
    }

    const liquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 80) // top 80 by volume (balance coverage vs API calls)

    const fundingMap = await getFundingMap()
    const regime = await getMarketRegime()

    for (const t of liquid) {
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      if (!price) continue

      try {
        // Fetch 5m klines (cache returns parsed objects {time,open,high,low,close,volume})
        let candles = klinesCache ? klinesCache.getCandles(symbol, INTERVAL, KLINES_LIMIT) : []
        if (!candles || candles.length < 50) {
          // Fallback: fetch from Binance API (raw format)
          const raw = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${KLINES_LIMIT}`)
          if (!Array.isArray(raw) || raw.length < 50) { skipped++; continue }
          candles = raw.map(k => ({
            time: Math.floor(parseInt(k[0]) / 1000),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[7]), // quote volume (USDT)
          }))
        }

        if (candles.length < 50) { skipped++; continue }

        // Volume SMA(20)
        const recentVols = candles.slice(-21, -1) // 20 candles before last
        const volumeSma = recentVols.reduce((s, c) => s + c.volume, 0) / recentVols.length

        // Detect signal
        const sig = detectChannelSignal(candles, volumeSma)
        if (!sig) continue

        // Calculate confidence
        let conf = sig.subType === 'channel_reversion' ? BASE_CONF_REVERSION : BASE_CONF_BREAKOUT

        // R² boost: higher R² = more reliable channel
        const r2Boost = Math.min(R2_BOOST_MAX, ((sig.channel.r2 - MIN_R2) / (1 - MIN_R2)) * R2_BOOST_MAX)
        conf += r2Boost

        // Volume boost: stronger volume = more conviction
        const volBoost = Math.min(VOL_BOOST_MAX, (sig.volRatio - 1.5) / 3.5 * VOL_BOOST_MAX)
        conf += Math.max(0, volBoost)

        // Trend alignment: reversion WITH trend = stronger
        if (regime && regime.direction) {
          const trendAlign = (
            (sig.direction === 'LONG' && regime.direction === 'BULLISH') ||
            (sig.direction === 'SHORT' && regime.direction === 'BEARISH')
          )
          if (trendAlign) conf += TREND_ALIGN_BOOST
        }

        // Penetration boost for breakout: deeper = more confident
        if (sig.subType === 'channel_breakout') {
          conf += Math.min(5, sig.penetration * 5) // up to +5 for deep penetration
        }

        // Rejection quality boost for reversion
        if (sig.subType === 'channel_reversion') {
          conf += Math.min(5, sig.bodyReturnPct * 7) // up to +5 for strong rejection
        }

        conf = Math.min(95, Math.max(35, Math.round(conf)))

        // Build description
        const icon = sig.subType === 'channel_reversion' ? '↩️' : '🚀'
        const action = sig.subType === 'channel_reversion' ? 'Reversion' : 'Breakout'
        const band = sig.direction === 'LONG'
          ? (sig.subType === 'channel_reversion' ? 'lower' : 'upper')
          : (sig.subType === 'channel_reversion' ? 'upper' : 'lower')
        const targetStr = sig.targetMid
          ? ` → mid ${sig.targetMid.toFixed(2)} (${sig.targetPct.toFixed(1)}%)`
          : ''
        const description = `${icon} Channel ${action} — ${band} band ${sig.reason.replace(/_/g, ' ')} (R²=${sig.channel.r2.toFixed(2)}, vol ${sig.volRatio.toFixed(1)}x)${targetStr}`

        // Build metadata
        const metadata = {
          subType: sig.subType,
          reason: sig.reason,
          channelUpper: parseFloat(sig.channel.upper.toFixed(4)),
          channelMid: parseFloat(sig.channel.mid.toFixed(4)),
          channelLower: parseFloat(sig.channel.lower.toFixed(4)),
          bandWidthPct: parseFloat(sig.channel.bandWidthPct.toFixed(2)),
          slopePct: parseFloat(sig.channel.slopePct.toFixed(4)),
          r2: parseFloat(sig.channel.r2.toFixed(3)),
          period: sig.channel.period,
          penetrationPct: parseFloat(sig.penetration.toFixed(3)),
          volumeRatio: parseFloat(sig.volRatio.toFixed(2)),
          bodyReturnPct: parseFloat(sig.bodyReturnPct.toFixed(2)),
          targetMid: sig.targetMid ? parseFloat(sig.targetMid.toFixed(4)) : null,
          targetPct: sig.targetPct ? parseFloat(sig.targetPct.toFixed(2)) : null,
          fundingRate: fundingMap[symbol] != null ? parseFloat((fundingMap[symbol] * 100).toFixed(4)) : null,
          volume24h: Math.round(parseFloat(t.quoteVolume)),
          interval: INTERVAL,
        }

        // Emit signal — cooldown handled by emitSignal()
        const signalTime = new Date(candles[candles.length - 1].time * 1000).toISOString()
        emitSignal({
          type: 'channel',
          symbol,
          direction: sig.direction,
          price,
          confidence: conf,
          description,
          metadata,
          signalTime,
        })
        signalCount++

      } catch (e) {
        errors++
        if (errors <= 3) console.warn(`[Channel] Error ${symbol}:`, e.message)
      }

      // Rate limit: 100ms between symbols
      await new Promise(r => setTimeout(r, 100))
    }

    const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1)
    if (signalCount > 0 || errors > 0) {
      console.log(`[Channel] Scan done: ${signalCount} signals, ${skipped} skipped, ${errors} errors (${elapsed}s)`)
    }
  } catch (err) {
    console.error('[Channel] Scanner error:', err.message)
  }
}

module.exports = { scanChannelSignals, computeRegressionChannel, detectChannelSignal }
