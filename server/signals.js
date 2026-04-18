/**
 * Signals Scanner — detects trading signals from market data
 * Types: volume_spike (5m klines SMA20-based), oi_cvd
 * Volume scan (60s): fetches 5m klines for liquid symbols, compares current candle vs SMA(20)
 * OI+CVD scan (5min): uses Binance openInterestHist 1h period + taker ratio
 * Outcome tracker: snapshots at 5m/15m/1h/4h/1d + MFE/MAE tracking
 */

const SCAN_INTERVAL_MS = 60_000
const OI_CVD_INTERVAL_MS = 5 * 60_000
const OUTCOME_CHECK_MS = 30_000

// Volume spike: current 5m candle vs SMA(20) of 5m candles
const VOL_SMA_PERIOD = 20
const VOL_MIN_RATIO = 2.0            // server emits from 2x, frontend filters by user setting
const MIN_VOLUME_24H_USD = 30_000_000 // only scan symbols with 24h vol >= $30M
const MIN_AVG_5M_VOL = 100_000       // skip if avg 5m vol < $100K (too illiquid)
const OI_CHANGE_PCT = 3.0      // OI 1h change >3% → signal
const OI_CVD_TOP_N = 50
const OI_CVD_DELAY_MS = 200

const liveSignals = []
const MAX_LIVE = 200

const cooldowns = new Map()
const COOLDOWN_MS = 15 * 60_000

// MFE/MAE in-memory tracker: signalId → { entryPrice, direction, mfe, mae }
const mfeTracker = new Map()

let _getProxyCached = null
let _setProxyCached = null
let _bgetWithRetry = null
let _auth = null
let _scanTimer = null
let _oiCvdTimer = null
let _outcomeTimer = null

function init({ getProxyCached, setProxyCached, bgetWithRetry, auth }) {
  _getProxyCached = getProxyCached
  _setProxyCached = setProxyCached
  _bgetWithRetry = bgetWithRetry
  _auth = auth

  _scanTimer = setInterval(scan, SCAN_INTERVAL_MS)
  _oiCvdTimer = setInterval(scanOiCvd, OI_CVD_INTERVAL_MS)
  _outcomeTimer = setInterval(checkOutcomes, OUTCOME_CHECK_MS)
  setTimeout(scan, 10_000)
  setTimeout(scanOiCvd, 30_000)
  console.log(`[Signals] Scanner started (${SCAN_INTERVAL_MS / 1000}s fast, ${OI_CVD_INTERVAL_MS / 1000}s OI+CVD, ${OUTCOME_CHECK_MS / 1000}s outcomes)`)
}

function stop() {
  if (_scanTimer) clearInterval(_scanTimer)
  if (_oiCvdTimer) clearInterval(_oiCvdTimer)
  if (_outcomeTimer) clearInterval(_outcomeTimer)
}

// ======================== MARKET CONTEXT HELPERS ========================

/** Build a map of funding rates (cached 5min) */
async function getFundingMap() {
  const cached = _getProxyCached('funding_rates', 300_000)
  if (cached) return cached
  try {
    const data = await _bgetWithRetry('/fapi/v1/premiumIndex')
    if (!Array.isArray(data)) return {}
    const map = {}
    for (const d of data) {
      map[d.symbol] = parseFloat(d.lastFundingRate) || 0
    }
    _setProxyCached('funding_rates', map)
    return map
  } catch { return {} }
}

/** Get NATR map from cache (computed by /api/natr endpoint, 5min TTL) */
function getNatrMap() {
  return _getProxyCached('natr:15m', 300_000) || {}
}

/** Compute NATR(14) from klines array (any TF). Returns number or null */
function calcNatrFromKlines(klines) {
  if (!Array.isArray(klines) || klines.length < 15) return null
  const candles = klines.map(k => ({
    high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4])
  }))
  let trSum = 0
  for (let j = candles.length - 14; j < candles.length; j++) {
    const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  const atr = trSum / 14
  const lastClose = candles[candles.length - 1].close
  return lastClose > 0 ? parseFloat(((atr / lastClose) * 100).toFixed(2)) : null
}

/** Build enriched market context for a symbol at signal time */
function buildMarketContext(t, { natrMap, fundingMap, rank }) {
  const volume24h = parseFloat(t.quoteVolume) || 0
  const high24h = parseFloat(t.highPrice) || 0
  const low24h = parseFloat(t.lowPrice) || 0
  const price = parseFloat(t.lastPrice) || 0
  const range24h = high24h - low24h
  // 0% = at 24h low, 100% = at 24h high
  const pricePosition = range24h > 0 ? parseFloat(((price - low24h) / range24h * 100).toFixed(1)) : 50

  return {
    volume24h: Math.round(volume24h),
    natr: natrMap[t.symbol] || null,
    trades24h: parseInt(t.count) || 0,
    fundingRate: fundingMap[t.symbol] != null ? parseFloat((fundingMap[t.symbol] * 100).toFixed(4)) : null,
    pricePosition,
    marketRank: rank,
  }
}

// ======================== VOLUME SPIKE SCANNER (60s) ========================
// Fetches 5m klines for liquid symbols, compares latest candle volume vs SMA(20)

const VOL_SCAN_DELAY_MS = 150 // delay between klines requests

async function scan() {
  try {
    let ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) {
      try { ticker = await _bgetWithRetry('/fapi/v1/ticker/24hr') } catch { return }
      if (!Array.isArray(ticker)) return
    }

    const liquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H_USD)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))

    // Pre-load market context data
    const natrMap = getNatrMap()
    const fundingMap = await getFundingMap()

    const now = Date.now()
    let signalCount = 0

    for (let idx = 0; idx < liquid.length; idx++) {
      const t = liquid[idx]
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      const change = parseFloat(t.priceChangePercent)
      if (!price) continue

      try {
        // Fetch 21 x 5m klines: 20 for SMA + 1 current
        const klines = await _bgetWithRetry(
          `/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=${VOL_SMA_PERIOD + 1}`
        )
        if (!Array.isArray(klines) || klines.length < VOL_SMA_PERIOD + 1) continue

        // Parse quote volumes (index 7 = quoteAssetVolume in USDT)
        const vols = klines.map(k => parseFloat(k[7]))
        const currentVol = vols[vols.length - 1]
        const smaVols = vols.slice(0, VOL_SMA_PERIOD)
        const sma = smaVols.reduce((s, v) => s + v, 0) / VOL_SMA_PERIOD

        if (sma <= 0 || sma < MIN_AVG_5M_VOL) continue
        const ratio = currentVol / sma

        if (ratio >= VOL_MIN_RATIO) {
          // Direction from 5m price change (current candle)
          const lastCandle = klines[klines.length - 1]
          const candleOpen = parseFloat(lastCandle[1])
          const candleClose = parseFloat(lastCandle[4])
          const candleChange = ((candleClose - candleOpen) / candleOpen) * 100
          const direction = candleChange >= 0 ? 'LONG' : 'SHORT'

          // Confidence: 2x=55, 3x=65, 5x=75, 10x=90, 20x+=95
          const conf = Math.min(95, 50 + Math.log2(ratio) * 10)

          // Use candle openTime as signal time (not scan time)
          const candleOpenMs = parseInt(lastCandle[0])

          // Compute NATR from 5m klines as fallback if not in cache
          let natrVal = natrMap[symbol] || null
          if (!natrVal) natrVal = calcNatrFromKlines(klines)

          // Market context
          const ctx = buildMarketContext(t, { natrMap: { ...natrMap, [symbol]: natrVal }, fundingMap, rank: idx + 1 })

          emitSignal({
            type: 'volume_spike',
            symbol, price,
            signalTime: new Date(candleOpenMs).toISOString(),
            direction,
            confidence: Math.round(conf),
            description: `Volume ${ratio.toFixed(1)}x avg ($${fmtVol(currentVol)} vs avg $${fmtVol(sma)})`,
            metadata: {
              ratio: parseFloat(ratio.toFixed(1)),
              currentVol: Math.round(currentVol),
              avgVol: Math.round(sma),
              candleChange: parseFloat(candleChange.toFixed(2)),
              change24h: parseFloat(change),
              ...ctx,
            }
          })
          signalCount++
        }
      } catch (e) {
        // skip symbol on error
      }

      await new Promise(r => setTimeout(r, VOL_SCAN_DELAY_MS))
    }

    // Cleanup old cooldowns
    for (const [key, ts] of cooldowns.entries()) {
      if (now - ts > COOLDOWN_MS) cooldowns.delete(key)
    }

    console.log(`[Signals] Volume scan: ${liquid.length} symbols, ${signalCount} spikes (>=${VOL_MIN_RATIO}x)`)
  } catch (err) {
    console.error('[Signals] Volume scan error:', err.message)
  }
}

// ======================== OI + CVD SCANNER (5min, 1h period) ========================

async function scanOiCvd() {
  try {
    let ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) {
      // Ticker not cached yet — fetch it ourselves
      try { ticker = await _bgetWithRetry('/fapi/v1/ticker/24hr') } catch { return }
      if (!Array.isArray(ticker)) return
    }

    const allLiquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H_USD)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    const top = allLiquid.slice(0, OI_CVD_TOP_N)

    // Pre-load market context data
    const natrMap = getNatrMap()
    const fundingMap = await getFundingMap()

    const now = Date.now()
    let signalCount = 0

    for (let idx = 0; idx < top.length; idx++) {
      const t = top[idx]
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      const change = parseFloat(t.priceChangePercent)
      if (!price) continue

      try {
        // Fetch OI history (1h candles, last 2) + taker ratio in parallel
        const [oiHist, takerData] = await Promise.all([
          _bgetWithRetry(`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`),
          _bgetWithRetry(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`),
        ])

        // OI 1h delta from Binance history (no need for our own snapshots)
        if (!Array.isArray(oiHist) || oiHist.length < 2) continue
        const oiPrev = parseFloat(oiHist[0].sumOpenInterest)
        const oiCurr = parseFloat(oiHist[1].sumOpenInterest)
        const oiValueUsd = parseFloat(oiHist[1].sumOpenInterestValue || 0)
        if (!oiPrev || oiPrev === 0) continue
        const oiChangePct = ((oiCurr - oiPrev) / oiPrev) * 100

        // CVD from taker buy/sell ratio
        let cvdDirection = null
        let buySellRatio = null

        if (Array.isArray(takerData) && takerData.length > 0) {
          buySellRatio = parseFloat(takerData[0].buySellRatio || 1)
          cvdDirection = buySellRatio > 1 ? 'BUY' : 'SELL'
        }

        if (Math.abs(oiChangePct) < OI_CHANGE_PCT || !cvdDirection) continue

        // OI × CVD Matrix
        const oiUp = oiChangePct > 0
        let signalDir, signalDesc, subType

        if (oiUp && cvdDirection === 'BUY') {
          signalDir = 'LONG'
          signalDesc = `🟢 Longs accumulating — OI +${oiChangePct.toFixed(1)}%/1h, buyers ${buySellRatio.toFixed(2)}x`
          subType = 'oi_longs'
        } else if (oiUp && cvdDirection === 'SELL') {
          signalDir = 'SHORT'
          signalDesc = `🔴 Shorts accumulating — OI +${oiChangePct.toFixed(1)}%/1h, sellers ${(1/buySellRatio).toFixed(2)}x`
          subType = 'oi_shorts'
        } else if (!oiUp && cvdDirection === 'BUY') {
          signalDir = 'LONG'
          signalDesc = `🟡 Short squeeze — OI ${oiChangePct.toFixed(1)}%/1h, buying pressure`
          subType = 'oi_squeeze'
        } else {
          signalDir = 'SHORT'
          signalDesc = `🟡 Long liquidation — OI ${oiChangePct.toFixed(1)}%/1h, selling pressure`
          subType = 'oi_liquidation'
        }

        // Confidence: bell-curve on OI change — sweet spot 4-8%, extreme >10% = lagging signal
        const absOi = Math.abs(oiChangePct)
        let confOi
        if (absOi <= 8) {
          confOi = Math.min(20, absOi * 3)       // 3%→9, 5%→15, 8%→20
        } else {
          confOi = 20 - (absOi - 8) * 3           // 10%→14, 13%→5, 15%→-1
        }
        const confBase = 55 + Math.max(0, confOi)  // floor at 55
        const confRatio = Math.min(10, Math.abs(buySellRatio - 1) * 10)
        // Use OI candle timestamp (not scan time)
        const oiCandleMs = parseInt(oiHist[1].timestamp)

        // Market context
        const ctx = buildMarketContext(t, { natrMap, fundingMap, rank: idx + 1 })

        emitSignal({
          type: 'oi_cvd',
          symbol, price,
          signalTime: new Date(oiCandleMs).toISOString(),
          direction: signalDir,
          confidence: Math.min(95, confBase + confRatio),
          description: signalDesc,
          metadata: {
            oiChangePct: parseFloat(oiChangePct.toFixed(2)),
            oiValue: oiValueUsd,
            buySellRatio: buySellRatio ? parseFloat(buySellRatio.toFixed(3)) : null,
            cvdDirection, subType, change,
            ...ctx,
          }
        })
        signalCount++

      } catch (e) {
        if (signalCount === 0 && idx < 3) console.log(`[Signals] OI+CVD ${symbol} error: ${e.message}`)
      }

      await new Promise(r => setTimeout(r, OI_CVD_DELAY_MS))
    }

    console.log(`[Signals] OI+CVD scan done: ${top.length} symbols, ${signalCount} signals`)
  } catch (err) {
    console.error('[Signals] OI+CVD scan error:', err.message)
  }
}

// ======================== OUTCOME TRACKER (MFE/MAE) ========================

async function checkOutcomes() {
  try {
    const pending = _auth.stmts.getPendingSignals.all()
    if (!pending || pending.length === 0) return

    const ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker)) return

    const priceMap = new Map()
    for (const t of ticker) {
      priceMap.set(t.symbol, parseFloat(t.lastPrice))
    }

    const now = Date.now()

    for (const sig of pending) {
      const currentPrice = priceMap.get(sig.symbol)
      if (!currentPrice || !sig.entry_price) continue

      const ageMs = now - new Date(sig.created_at).getTime()
      const ageMin = ageMs / 60_000
      const dir = sig.direction === 'LONG' ? 1 : -1

      // Track MFE/MAE continuously (every 30s check)
      const pnlNow = dir * (currentPrice - sig.entry_price) / sig.entry_price * 100
      const trackKey = sig.id
      let track = mfeTracker.get(trackKey)
      if (!track) {
        track = { mfe: 0, mae: 0 }
        mfeTracker.set(trackKey, track)
      }
      if (pnlNow > track.mfe) track.mfe = pnlNow
      if (pnlNow < track.mae) track.mae = pnlNow

      // Progressive price snapshots
      let spot5m = sig.spot_after_5m
      let spot15m = sig.spot_after_15m
      let spot1h = sig.spot_after_1h
      let spot4h = sig.spot_after_4h
      let spot1d = sig.spot_after_1d

      let updated = false

      if (!spot5m && ageMin >= 5) { spot5m = currentPrice; updated = true }
      if (!spot15m && ageMin >= 15) { spot15m = currentPrice; updated = true }
      if (!spot1h && ageMin >= 60) { spot1h = currentPrice; updated = true }
      if (!spot4h && ageMin >= 240) { spot4h = currentPrice; updated = true }
      if (!spot1d && ageMin >= 1440) { spot1d = currentPrice; updated = true }

      // Always update MFE/MAE even if no new snapshot
      const shouldFinalize = !!spot1d // done after 1d

      if (!updated && !shouldFinalize) continue

      let outcome = null
      let pnlPct = null

      if (spot1d) {
        // Final outcome based on 1d price
        pnlPct = parseFloat((dir * (spot1d - sig.entry_price) / sig.entry_price * 100).toFixed(3))
        outcome = pnlPct > 0 ? 'WIN' : 'LOSS'
        // Cleanup tracker
        mfeTracker.delete(trackKey)
      }

      try {
        _auth.stmts.updateSignalOutcome.run(
          spot5m, spot15m, spot1h, spot4h, spot1d,
          outcome, pnlPct,
          parseFloat(track.mfe.toFixed(3)),
          parseFloat(track.mae.toFixed(3)),
          sig.id
        )
      } catch (e) { /* ignore */ }
    }

    // Cleanup stale MFE trackers (older than 25h)
    for (const [key] of mfeTracker.entries()) {
      const id = parseInt(key)
      if (id && now - id > 25 * 3600_000) mfeTracker.delete(key)
    }
  } catch (err) {
    console.error('[Signals] Outcome check error:', err.message)
  }
}

// ======================== EMIT ========================

function emitSignal({ type, symbol, direction, price, confidence, description, metadata, signalTime }) {
  const key = `${type}:${symbol}`
  const now = Date.now()

  // In-memory cooldown (fast path)
  if (cooldowns.has(key) && now - cooldowns.get(key) < COOLDOWN_MS) return

  // DB-based dedup (survives restarts)
  try {
    const recent = _auth.db.prepare(
      "SELECT id FROM signal_log WHERE type = ? AND symbol = ? AND created_at > datetime('now', '-' || ? || ' minutes') LIMIT 1"
    ).get(type, symbol, Math.floor(COOLDOWN_MS / 60_000))
    if (recent) { cooldowns.set(key, now); return }
  } catch {}

  cooldowns.set(key, now)

  const signal = {
    id: `${now}-${Math.random().toString(36).slice(2, 6)}`,
    type, symbol, direction, price,
    confidence: Math.round(confidence),
    description, metadata,
    created_at: signalTime || new Date().toISOString()
  }

  liveSignals.unshift(signal)
  if (liveSignals.length > MAX_LIVE) liveSignals.length = MAX_LIVE

  try {
    // Pass candle-based created_at to DB for accurate outcome tracking
    const dbTs = signal.created_at.replace('T', ' ').replace(/\.\d+Z$/, '')
    _auth.stmts.logSignal.run(type, symbol, direction, price, confidence, JSON.stringify(metadata), dbTs)
  } catch (err) {
    console.error('[Signals] DB log error:', err.message)
  }
}

// ======================== HELPERS ========================

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K'
  return v.toFixed(0)
}

// ======================== API ========================

function getLiveSignals(filters = {}) {
  // Read from DB (persists across restarts, 24h window)
  const hours = Number(filters.hours) || 24
  let result
  try {
    const rows = _auth.stmts.getSignalsSince.all(hours)
    result = rows.map(r => ({
      id: String(r.id),
      type: r.type,
      symbol: r.symbol,
      direction: r.direction,
      price: r.entry_price,
      confidence: r.confidence,
      description: null, // DB doesn't store description, build from metadata
      metadata: JSON.parse(r.metadata || '{}'),
      created_at: r.created_at,
      // Outcome data
      spot_after_5m: r.spot_after_5m,
      spot_after_15m: r.spot_after_15m,
      spot_after_1h: r.spot_after_1h,
      spot_after_4h: r.spot_after_4h,
      spot_after_1d: r.spot_after_1d,
      outcome: r.outcome,
      pnl_pct: r.pnl_pct,
      mfe_pct: r.mfe_pct,
      mae_pct: r.mae_pct,
    }))
    // Rebuild description from metadata
    for (const s of result) {
      const m = s.metadata
      if (s.type === 'volume_spike' && m.ratio) {
        s.description = `Volume ${m.ratio}x avg ($${fmtVol(m.currentVol)} vs avg $${fmtVol(m.avgVol)})`
      } else if (s.type === 'oi_cvd' && m.oiChangePct !== undefined) {
        const sub = m.subType || ''
        const labels = { oi_longs: '🟢 Longs accumulating', oi_shorts: '🔴 Shorts accumulating', oi_squeeze: '🟡 Short squeeze', oi_liquidation: '🟡 Long liquidation' }
        s.description = `${labels[sub] || sub} — OI ${m.oiChangePct > 0 ? '+' : ''}${m.oiChangePct}%/1h`
      }
    }
  } catch (err) {
    console.error('[Signals] DB read error, falling back to memory:', err.message)
    result = [...liveSignals]
  }

  if (filters.type) result = result.filter(s => s.type === filters.type)
  if (filters.symbol) result = result.filter(s => s.symbol.includes(filters.symbol.toUpperCase()))
  if (filters.direction) result = result.filter(s => s.direction === filters.direction.toUpperCase())
  if (filters.minConfidence) result = result.filter(s => s.confidence >= Number(filters.minConfidence))

  const limit = Math.min(Number(filters.limit) || 200, 500)
  return result.slice(0, limit)
}

function getSignalTypes() {
  return [
    { id: 'volume_spike', label: 'Volume Spike', icon: '📊', color: '#3b82f6' },
    { id: 'oi_cvd', label: 'OI + CVD', icon: '🔮', color: '#8b5cf6' },
  ]
}

function getSignalSummary() {
  try {
    const all24h = _auth.stmts.getSignalsSince.all(24)
    const now = Date.now()
    const last1h = all24h.filter(s => now - new Date(s.created_at).getTime() < 3600_000)
    const byType = {}
    for (const s of last1h) {
      byType[s.type] = (byType[s.type] || 0) + 1
    }
    return {
      total: all24h.length,
      last_1h: last1h.length,
      by_type: byType,
      types: getSignalTypes()
    }
  } catch {
    return { total: 0, last_1h: 0, by_type: {}, types: getSignalTypes() }
  }
}

function getOutcomeStats() {
  try {
    return _auth.stmts.getSignalStats.all()
  } catch { return [] }
}

module.exports = { init, stop, getLiveSignals, getSignalSummary, getSignalTypes, getOutcomeStats, liveSignals }
