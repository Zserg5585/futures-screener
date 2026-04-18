/**
 * Signals Scanner — detects trading signals from market data
 * Types: volume_spike, big_mover, natr_spike, oi_cvd
 * Fast scan (60s): ticker-based signals
 * OI+CVD scan (5min): uses Binance openInterestHist 1h period + taker ratio
 * Outcome tracker: snapshots at 5m/15m/1h/4h/1d + MFE/MAE tracking
 */

const SCAN_INTERVAL_MS = 60_000
const OI_CVD_INTERVAL_MS = 5 * 60_000
const OUTCOME_CHECK_MS = 30_000

// Thresholds
const VOL_SPIKE_X = 3.0
const BIG_MOVE_PCT = 5.0
const NATR_SPIKE_PCT = 5.0
const MIN_VOLUME_USD = 20_000_000
const OI_CHANGE_PCT = 3.0      // OI 1h change >3% → signal
const OI_CVD_TOP_N = 50
const OI_CVD_DELAY_MS = 200

const liveSignals = []
const MAX_LIVE = 200

const cooldowns = new Map()
const COOLDOWN_MS = 15 * 60_000

let prevSnapshot = new Map()

// MFE/MAE in-memory tracker: signalId → { entryPrice, direction, mfe, mae }
const mfeTracker = new Map()

let _getProxyCached = null
let _bgetWithRetry = null
let _auth = null
let _scanTimer = null
let _oiCvdTimer = null
let _outcomeTimer = null

function init({ getProxyCached, bgetWithRetry, auth }) {
  _getProxyCached = getProxyCached
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

// ======================== FAST SCANNER (60s) ========================

async function scan() {
  try {
    const ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) return

    const usdtPairs = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_USD)

    const volumes = usdtPairs.map(t => parseFloat(t.quoteVolume)).sort((a, b) => a - b)
    const medianVol = volumes[Math.floor(volumes.length / 2)] || 1

    const now = Date.now()
    const newSnapshot = new Map()

    for (const t of usdtPairs) {
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      const change = parseFloat(t.priceChangePercent)
      const vol = parseFloat(t.quoteVolume)
      const high = parseFloat(t.highPrice)
      const low = parseFloat(t.lowPrice)
      const closeTime = parseInt(t.closeTime) || now

      newSnapshot.set(symbol, { vol, price, change })
      const signalTime = new Date(closeTime).toISOString()

      // --- Volume Spike ---
      if (vol > medianVol * VOL_SPIKE_X) {
        const volX = parseFloat((vol / medianVol).toFixed(1))
        const prev = prevSnapshot.get(symbol)
        const volDelta = prev ? ((vol - prev.vol) / prev.vol * 100) : 0

        emitSignal({
          type: 'volume_spike',
          symbol, price, signalTime,
          direction: change > 0 ? 'LONG' : 'SHORT',
          confidence: Math.min(95, 50 + volX * 5),
          description: `Volume ${volX}x median ($${fmtVol(vol)})${volDelta > 10 ? ` ↑${volDelta.toFixed(0)}%` : ''}`,
          metadata: { volX, volume: vol, change, volDelta: parseFloat(volDelta.toFixed(1)) }
        })
      }

      // --- Big Mover ---
      if (Math.abs(change) >= BIG_MOVE_PCT) {
        emitSignal({
          type: 'big_mover',
          symbol, price, signalTime,
          direction: change > 0 ? 'LONG' : 'SHORT',
          confidence: Math.min(95, 50 + Math.abs(change) * 3),
          description: `${change > 0 ? '🚀' : '💥'} ${change > 0 ? '+' : ''}${change.toFixed(1)}% in 24h`,
          metadata: { change, high, low, range: parseFloat(((high - low) / low * 100).toFixed(2)) }
        })
      }

      // --- NATR Spike ---
      const natr = price > 0 ? ((high - low) / price) * 100 : 0
      if (natr >= NATR_SPIKE_PCT) {
        emitSignal({
          type: 'natr_spike',
          symbol, price, signalTime,
          direction: change > 0 ? 'LONG' : 'SHORT',
          confidence: Math.min(90, 50 + natr * 5),
          description: `NATR ${natr.toFixed(1)}% — high volatility`,
          metadata: { natr: parseFloat(natr.toFixed(2)), high, low, change }
        })
      }
    }

    prevSnapshot = newSnapshot

    for (const [key, ts] of cooldowns.entries()) {
      if (now - ts > COOLDOWN_MS) cooldowns.delete(key)
    }
  } catch (err) {
    console.error('[Signals] Scan error:', err.message)
  }
}

// ======================== OI + CVD SCANNER (5min, 1h period) ========================

async function scanOiCvd() {
  try {
    const ticker = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(ticker) || ticker.length === 0) return

    const top = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_USD)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, OI_CVD_TOP_N)

    const now = Date.now()
    let signalCount = 0

    for (const t of top) {
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

        const confBase = 55 + Math.min(30, Math.abs(oiChangePct) * 3)
        const confRatio = Math.abs(buySellRatio - 1) * 10
        emitSignal({
          type: 'oi_cvd',
          symbol, price,
          signalTime: new Date(now).toISOString(),
          direction: signalDir,
          confidence: Math.min(95, confBase + confRatio),
          description: signalDesc,
          metadata: {
            oiChangePct: parseFloat(oiChangePct.toFixed(2)),
            oiValue: oiValueUsd,
            buySellRatio: buySellRatio ? parseFloat(buySellRatio.toFixed(3)) : null,
            cvdDirection, subType, change,
          }
        })
        signalCount++

      } catch (e) { /* skip */ }

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

  if (cooldowns.has(key) && now - cooldowns.get(key) < COOLDOWN_MS) return
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
    _auth.stmts.logSignal.run(type, symbol, direction, price, confidence, JSON.stringify(metadata))
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
  let result = [...liveSignals]

  if (filters.type) result = result.filter(s => s.type === filters.type)
  if (filters.symbol) result = result.filter(s => s.symbol.includes(filters.symbol.toUpperCase()))
  if (filters.direction) result = result.filter(s => s.direction === filters.direction.toUpperCase())
  if (filters.minConfidence) result = result.filter(s => s.confidence >= Number(filters.minConfidence))

  const limit = Math.min(Number(filters.limit) || 50, MAX_LIVE)
  return result.slice(0, limit)
}

function getSignalTypes() {
  return [
    { id: 'volume_spike', label: 'Volume Spike', icon: '📊', color: '#3b82f6' },
    { id: 'big_mover', label: 'Big Mover', icon: '🚀', color: '#f59e0b' },
    { id: 'natr_spike', label: 'NATR Spike', icon: '⚡', color: '#ef4444' },
    { id: 'oi_cvd', label: 'OI + CVD', icon: '🔮', color: '#8b5cf6' },
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

function getOutcomeStats() {
  try {
    return _auth.stmts.getSignalStats.all()
  } catch { return [] }
}

module.exports = { init, stop, getLiveSignals, getSignalSummary, getSignalTypes, getOutcomeStats, liveSignals }
