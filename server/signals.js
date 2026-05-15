const { createLogger } = require('./logger')
const log = createLogger('signals')

/**
 * Signals Scanner — detects trading signals from market data
 * Types: volume_spike (5m klines SMA20-based), oi_cvd, oi_divergence, oi_funding_squeeze, liq_sweep
 * Volume scan (60s): fetches 5m klines for liquid symbols, compares current candle vs SMA(20)
 * OI+CVD scan (5min): uses Binance openInterestHist 1h period + taker ratio
 * Liq Sweep scan (60s): detects pin bars that sweep liquidity levels
 * Outcome tracker: snapshots at 5m/15m/1h/4h/1d + MFE/MAE tracking
 */

const { scanLiqSweep, stopCleanup: stopLiqCleanup } = require('./liq-sweep')
const { initChannelScanners, stopChannelScanners } = require('./channel-signal')

const SCAN_INTERVAL_MS = 60_000
const OI_CVD_INTERVAL_MS = 5 * 60_000
const LIQ_SWEEP_INTERVAL_MS = 60_000
const OUTCOME_CHECK_MS = 30_000

// Volume spike: current 5m candle vs SMA(20) of 5m candles
const VOL_SMA_PERIOD = 20
const VOL_MIN_RATIO = 2.0            // server emits from 2x, frontend filters by user setting
const MIN_VOLUME_24H_USD = 30_000_000 // only scan symbols with 24h vol >= $30M
const MIN_AVG_5M_VOL = 100_000       // skip if avg 5m vol < $100K (too illiquid)
const OI_CHANGE_PCT = 3.0      // OI 1h change >3% → signal
const OI_CVD_TOP_N = 50
const OI_CVD_DELAY_MS = 200
const CVD_MIN_SKEW = 0.1      // |buySellRatio - 1| must exceed this
const PRICE_DIVERGENCE_PCT = 0.5  // price move threshold for divergence detection

// Funding rate thresholds for OI gating (values in %, e.g. 0.03 = 0.03%)
// Neutral funding = 0.01%. Crypto markets are naturally net-long.
const FUNDING_GATE_LONGS = 0.04    // skip oi_longs when funding > +0.04% (4x neutral)
const FUNDING_GATE_SHORTS = -0.03  // skip oi_shorts when funding < -0.03% (3x neg neutral)
const FUNDING_EXTREME_POS = 0.04   // boost oi_liquidation confidence
const FUNDING_EXTREME_NEG = -0.04  // boost oi_squeeze confidence (symmetric with POS)
const FUNDING_SQUEEZE_POS = 0.07   // trigger oi_funding_squeeze SHORT (7x = genuinely overcrowded)
const FUNDING_SQUEEZE_NEG = -0.05  // trigger oi_funding_squeeze LONG (5x = shorts genuinely overcrowded)
const OI_DIV_TREND_PCT = 2.0       // min OI trend % over window for divergence
const OI_DIV_PRICE_PCT = 1.0       // min price change % for divergence

// VPIN toxicity thresholds
const VPIN_THRESHOLD = 0.5          // emit signal when VPIN exceeds this
const VPIN_BUY_LONG = 0.55          // buyPct > 55% → LONG
const VPIN_SELL_SHORT = 0.45        // buyPct < 45% → SHORT
const VPIN_SCAN_INTERVAL_MS = 60_000

const liveSignals = []
const MAX_LIVE = 200

const cooldowns = new Map()
const COOLDOWN_MS = 60 * 60_000  // 60 min (OI data is hourly, no point alerting more often)

// Market regime cache
let _marketRegime = { direction: null, btcPrice: 0, ema20: 0, updatedAt: 0 }

// MFE/MAE in-memory tracker: signalId → { entryPrice, direction, mfe, mae }
const mfeTracker = new Map()

let _getProxyCached = null
let _setProxyCached = null
let _bgetWithRetry = null
let _auth = null
let _push = null
let _scanTimer = null
let _oiCvdTimer = null
let _liqSweepTimer = null
let _outcomeTimer = null

// Extra deps for liq_sweep (optional — passed from index.js)
let _klinesCache = null
let _stateManager = null
let _densityV2 = null
let _persistenceMap = null
let _vpinScanner = null
let _vpinTimer = null

// ticker/24hr helper — uses proxy cache then Bottleneck (maxConcurrent=50 supports weight=40)
async function _fetchTicker24hr() {
  const cached = _getProxyCached('ticker24hr', 60_000)
  if (Array.isArray(cached) && cached.length > 0) return cached
  const data = await _bgetWithRetry('/fapi/v1/ticker/24hr')
  _setProxyCached('ticker24hr', data)
  return data
}

function init({ getProxyCached, setProxyCached, bgetWithRetry, auth, push, klinesCache, stateManager, densityV2, persistenceMap, vpinScanner }) {
  _getProxyCached = getProxyCached
  _setProxyCached = setProxyCached
  _bgetWithRetry = bgetWithRetry
  _auth = auth
  _push = push || null
  _klinesCache = klinesCache || null
  _stateManager = stateManager || null
  _densityV2 = densityV2 || null
  _persistenceMap = persistenceMap || null
  _vpinScanner = vpinScanner || null

  _scanTimer = setInterval(scan, SCAN_INTERVAL_MS)
  _oiCvdTimer = setInterval(scanOiCvd, OI_CVD_INTERVAL_MS)
  _outcomeTimer = setInterval(checkOutcomes, OUTCOME_CHECK_MS)
  setTimeout(scan, 45_000)       // 45s — wait for NATR warmup (starts at 5s, takes ~30s)
  setTimeout(scanOiCvd, 50_000)  // 50s — after first volume scan + NATR ready

  // Liq Sweep scanner (only if klinesCache available)
  if (_klinesCache) {
    _liqSweepTimer = setInterval(_runLiqSweep, LIQ_SWEEP_INTERVAL_MS)
    setTimeout(_runLiqSweep, 20_000) // first run 20s after start
  }

  // Channel Signal scanner (multi-TF: 5m/15m/1h with confluence)
  initChannelScanners({
    getProxyCached: _getProxyCached,
    bgetWithRetry: _bgetWithRetry,
    klinesCache: _klinesCache,
    emitSignal,
    getMarketRegime,
    getFundingMap,
    getNatrMap,
  })

  // VPIN toxicity scanner (only if vpinScanner available)
  if (_vpinScanner) {
    _vpinTimer = setInterval(scanVPIN, VPIN_SCAN_INTERVAL_MS)
    setTimeout(scanVPIN, 90_000) // 90s — wait for VPIN cache to populate
  }

  log.info({ volInterval: SCAN_INTERVAL_MS / 1000, oiInterval: OI_CVD_INTERVAL_MS / 1000, liqInterval: LIQ_SWEEP_INTERVAL_MS / 1000, outcomeInterval: OUTCOME_CHECK_MS / 1000 }, 'Scanner started')
}

/** Wrapper to call scanLiqSweep with injected deps */
function _runLiqSweep() {
  scanLiqSweep({
    getProxyCached: _getProxyCached,
    bgetWithRetry: _bgetWithRetry,
    klinesCache: _klinesCache,
    stateManager: _stateManager,
    densityV2: _densityV2,
    persistenceMap: _persistenceMap,
    emitSignal,
    getMarketRegime,
    getFundingMap,
  }).catch(err => log.error({ err: err.message }, 'liq_sweep wrapper error'))
}

function stop() {
  if (_scanTimer) clearInterval(_scanTimer)
  if (_oiCvdTimer) clearInterval(_oiCvdTimer)
  if (_liqSweepTimer) clearInterval(_liqSweepTimer)
  if (_outcomeTimer) clearInterval(_outcomeTimer)
  if (_vpinTimer) clearInterval(_vpinTimer)
  stopChannelScanners()
  stopLiqCleanup()
}

// ======================== MARKET CONTEXT HELPERS ========================

/** Build a map of funding rates (cached 5min, stale fallback 10min on API error) */
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
  } catch (e) {
    // On API failure, return stale data (10min TTL) instead of empty map
    const stale = _getProxyCached('funding_rates', 600_000)
    if (stale) {
      log.warn({ err: e.message }, 'getFundingMap failed, using stale cache')
      return stale
    }
    log.warn({ err: e.message }, 'getFundingMap failed, no cache')
    return {}
  }
}

/** Get NATR map from cache (computed by /api/natr endpoint, refreshed every 4.5min)
 *  Read TTL 600s (10min) > refresh interval (4.5min) to avoid race condition:
 *  refresh takes 30-60s to compute 200 symbols, old cache must survive during that window */
let _natrWarnedAt = 0
function getNatrMap() {
  const map = _getProxyCached('natr:15m', 600_000)
  if (!map && Date.now() - _natrWarnedAt > 300_000) {
    log.warn('NATR cache empty — OI signal metadata will have natr:null')
    _natrWarnedAt = Date.now()
  }
  return map || {}
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
    trades24h: Number(t.count) || 0,
    fundingPct: fundingMap[t.symbol] != null ? parseFloat((fundingMap[t.symbol] * 100).toFixed(4)) : null,
    pricePosition,
    marketRank: rank,
  }
}

/** Market Regime — BTC EMA20 on 1h, cached 5min */
async function getMarketRegime() {
  const now = Date.now()
  if (_marketRegime.direction && now - _marketRegime.updatedAt < 300_000) return _marketRegime

  try {
    const klines = await _bgetWithRetry('/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=25')
    if (!Array.isArray(klines) || klines.length < 21) {
      if (!_marketRegime.direction) log.warn('Market regime: BTC klines insufficient, regime=null — trend adjustments disabled')
      return _marketRegime
    }

    // EMA20 calculation
    const closes = klines.map(k => parseFloat(k[4]))
    const period = 20
    const mult = 2 / (period + 1)
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * mult + ema
    }

    const btcPrice = closes[closes.length - 1]
    _marketRegime = {
      direction: btcPrice > ema ? 'BULLISH' : 'BEARISH',
      btcPrice,
      ema20: parseFloat(ema.toFixed(2)),
      updatedAt: now,
    }
  } catch (e) {
    log.warn({ err: e.message }, 'Market regime fetch error')
  }
  return _marketRegime
}

// ======================== VOLUME SPIKE SCANNER (60s) ========================
// Fetches 5m klines for liquid symbols, compares latest candle volume vs SMA(20)

const VOL_SCAN_DELAY_MS = 150 // delay between klines requests

async function scan() {
  try {
    let ticker
    try { ticker = await _fetchTicker24hr() } catch { return }
    if (!Array.isArray(ticker) || ticker.length === 0) return

    const liquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H_USD)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))

    // Pre-load market context data
    const natrMap = getNatrMap()
    const fundingMap = await getFundingMap()

    const now = Date.now()
    let signalCount = 0
    let errCount = 0

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
        errCount++
      }

      await new Promise(r => setTimeout(r, VOL_SCAN_DELAY_MS))
    }

    // Cleanup old cooldowns
    for (const [key, ts] of cooldowns.entries()) {
      if (now - ts > COOLDOWN_MS) cooldowns.delete(key)
    }

    log.info({ symbols: liquid.length, spikes: signalCount, minRatio: VOL_MIN_RATIO, errors: errCount || undefined }, 'Volume scan complete')
  } catch (err) {
    log.error({ err: err.message }, 'Volume scan error')
  }
}

// ======================== OI + CVD SCANNER (5min, 1h period) ========================

async function scanOiCvd() {
  try {
    let ticker
    try { ticker = await _fetchTicker24hr() } catch { return }
    if (!Array.isArray(ticker) || ticker.length === 0) return

    const allLiquid = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_VOLUME_24H_USD)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    const top = allLiquid.slice(0, OI_CVD_TOP_N)

    // Pre-load market context data
    const natrMap = getNatrMap()
    const fundingMap = await getFundingMap()
    const regime = await getMarketRegime()

    const now = Date.now()
    let signalCount = 0
    let errCount = 0

    log.info({ symbols: top.length, regime: regime.direction, btcPrice: regime.btcPrice, ema20: regime.ema20 }, 'OI+CVD scan started')

    for (let idx = 0; idx < top.length; idx++) {
      const t = top[idx]
      const symbol = t.symbol
      const price = parseFloat(t.lastPrice)
      const change = parseFloat(t.priceChangePercent)
      if (!price) continue

      try {
        // Fetch OI history (1h candles, last 6 for divergence+ROC) + taker ratio in parallel
        const [oiHist, takerData] = await Promise.all([
          _bgetWithRetry(`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=6`),
          _bgetWithRetry(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=1`),
        ])

        // OI 1h delta: use last 2 candles (prev-to-last vs last)
        if (!Array.isArray(oiHist) || oiHist.length < 2) continue
        const lastIdx = oiHist.length - 1
        const oiPrev = parseFloat(oiHist[lastIdx - 1].sumOpenInterest)
        const oiCurr = parseFloat(oiHist[lastIdx].sumOpenInterest)
        const oiValueUsd = parseFloat(oiHist[lastIdx].sumOpenInterestValue || 0)
        if (!oiPrev || oiPrev === 0) continue
        const oiChangePct = ((oiCurr - oiPrev) / oiPrev) * 100

        // --- OI ROC: 3-candle acceleration ---
        let oiRocAdj = 0
        if (oiHist.length >= 3) {
          const oi0 = parseFloat(oiHist[lastIdx - 2].sumOpenInterest)
          const oi1 = parseFloat(oiHist[lastIdx - 1].sumOpenInterest)
          const oi2 = parseFloat(oiHist[lastIdx].sumOpenInterest)
          if (oi0 > 0 && oi1 > 0) {
            const delta1 = (oi1 - oi0) / oi0 * 100
            const delta2 = (oi2 - oi1) / oi1 * 100
            if (Math.sign(delta1) === Math.sign(delta2) && Math.abs(delta2) > Math.abs(delta1)) {
              oiRocAdj = +5  // accelerating OI change
            } else if (Math.sign(delta1) !== Math.sign(delta2)) {
              oiRocAdj = -5  // reversing direction
            }
          }
        }

        // --- Funding rate for this symbol ---
        const fundingRate = fundingMap[symbol] || 0
        const fundingPct = fundingRate * 100  // convert to %, e.g. 0.0003 → 0.03%

        // CVD from taker buy/sell ratio
        let cvdDirection = null
        let buySellRatio = null

        if (Array.isArray(takerData) && takerData.length > 0) {
          buySellRatio = parseFloat(takerData[0].buySellRatio) || 1
          cvdDirection = buySellRatio > 1 ? 'BUY' : 'SELL'
        }

        if (Math.abs(oiChangePct) < OI_CHANGE_PCT || !cvdDirection) continue

        // CVD strength gate — skip weak CVD (ratio near 1.0)
        const cvdSkew = Math.abs(buySellRatio - 1)
        if (cvdSkew < CVD_MIN_SKEW) continue

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

        // --- Funding rate gate: skip signals when crowd is already on our side ---
        let fundingAdj = 0
        if (subType === 'oi_longs' && fundingPct > FUNDING_GATE_LONGS) {
          continue  // longs already overcrowded, skip accumulation signal
        } else if (subType === 'oi_shorts' && fundingPct < FUNDING_GATE_SHORTS) {
          continue  // shorts already overcrowded, skip
        } else if (subType === 'oi_squeeze' && fundingPct < FUNDING_EXTREME_NEG) {
          fundingAdj = +10  // extreme neg funding = shorts overcrowded → squeeze very likely
        } else if (subType === 'oi_liquidation' && fundingPct > FUNDING_EXTREME_POS) {
          fundingAdj = +10  // extreme pos funding = longs overcrowded → liquidation likely
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
        const confRatio = Math.min(10, cvdSkew * 10)

        // --- Market Regime adjustment ---
        let regimeAdj = 0
        const regimeTag = []
        if (regime.direction) {
          const withTrend = (regime.direction === 'BULLISH' && signalDir === 'LONG') ||
                            (regime.direction === 'BEARISH' && signalDir === 'SHORT')
          if (withTrend) {
            regimeAdj = +5
            regimeTag.push(`📈 With trend (BTC ${regime.direction})`)
          } else {
            regimeAdj = -15
            regimeTag.push(`⚠️ Against trend (BTC ${regime.direction})`)
          }
        }

        // --- Divergence detection: OI direction vs Price direction ---
        let divAdj = 0
        // Derive 1h price change from OI candles: price ≈ sumOpenInterestValue / sumOpenInterest
        const oiValPrev = parseFloat(oiHist[lastIdx - 1].sumOpenInterestValue || 0)
        const oiValCurr = parseFloat(oiHist[lastIdx].sumOpenInterestValue || 0)
        const pricePrev1h = oiPrev > 0 ? oiValPrev / oiPrev : 0
        const priceCurr1h = oiCurr > 0 ? oiValCurr / oiCurr : 0
        const priceChange1h = pricePrev1h > 0 ? ((priceCurr1h - pricePrev1h) / pricePrev1h) * 100 : change // fallback to 24h if no data
        // Divergence: OI up but price down, or OI down but price up
        const priceMoveDir = priceChange1h > PRICE_DIVERGENCE_PCT ? 'UP' : priceChange1h < -PRICE_DIVERGENCE_PCT ? 'DOWN' : 'FLAT'
        const oiMoveDir = oiUp ? 'UP' : 'DOWN'

        if (fundingAdj > 0) regimeTag.push(`💰 Funding confirms (${fundingPct > 0 ? '+' : ''}${fundingPct.toFixed(3)}%)`)
        if (oiRocAdj > 0) regimeTag.push('🔥 OI accelerating')
        else if (oiRocAdj < 0) regimeTag.push('⏸️ OI decelerating')

        if (priceMoveDir !== 'FLAT' && oiMoveDir !== priceMoveDir) {
          // Divergence detected!
          // Bullish div: OI UP + Price DOWN → hidden accumulation → expect UP
          // Bearish div: OI DOWN + Price UP → hidden distribution → expect DOWN
          const divExpectedDir = oiUp ? 'LONG' : 'SHORT' // OI UP = accumulation = bullish
          if (divExpectedDir === signalDir) {
            divAdj = +10
            regimeTag.push('🔀 OI Divergence confirms')
          } else {
            divAdj = -5
            regimeTag.push('🔀 OI Divergence conflicts')
          }
        }

        const finalConf = Math.max(30, Math.min(95, confBase + confRatio + regimeAdj + divAdj + fundingAdj + oiRocAdj))

        // Enhanced description
        const tagStr = regimeTag.length > 0 ? ' | ' + regimeTag.join(' ') : ''
        const enhancedDesc = signalDesc + tagStr

        // Use OI candle timestamp (not scan time)
        const oiCandleMs = parseInt(oiHist[lastIdx].timestamp)

        // Market context
        const ctx = buildMarketContext(t, { natrMap, fundingMap, rank: idx + 1 })

        emitSignal({
          type: 'oi_cvd',
          symbol, price,
          signalTime: new Date(oiCandleMs).toISOString(),
          direction: signalDir,
          confidence: Math.round(finalConf),
          description: enhancedDesc,
          metadata: {
            oiChangePct: parseFloat(oiChangePct.toFixed(2)),
            oiValue: oiValueUsd,
            buySellRatio: buySellRatio ? parseFloat(buySellRatio.toFixed(3)) : null,
            cvdDirection, subType, change,
            fundingPct: parseFloat(fundingPct.toFixed(4)),
            oiRocAdj,
            marketRegime: regime.direction || 'UNKNOWN',
            divergence: divAdj !== 0 ? (divAdj > 0 ? 'confirms' : 'conflicts') : null,
            ...ctx,
          }
        })
        signalCount++

        // === OI DIVERGENCE standalone signal ===
        // Price trending one way, OI trending the other = exhaustion or hidden accumulation
        if (oiHist.length >= 4) {
          const oiValues = oiHist.map(h => parseFloat(h.sumOpenInterest))
          const oiFirst = oiValues[0]
          const oiLast = oiValues[oiValues.length - 1]
          const oiTrendPct = ((oiLast - oiFirst) / oiFirst) * 100
          const oiTrending = Math.abs(oiTrendPct) > OI_DIV_TREND_PCT

          // Derive price change over the SAME window as OI (not 24h ticker change)
          // price ≈ sumOpenInterestValue / sumOpenInterest
          const oiValFirst = parseFloat(oiHist[0].sumOpenInterestValue || 0)
          const oiValLast = parseFloat(oiHist[lastIdx].sumOpenInterestValue || 0)
          const priceFirst = oiFirst > 0 ? oiValFirst / oiFirst : 0
          const priceLast = oiLast > 0 ? oiValLast / oiLast : 0
          const priceChangeSameWindow = priceFirst > 0 ? ((priceLast - priceFirst) / priceFirst) * 100 : change
          const priceTrending = Math.abs(priceChangeSameWindow) > OI_DIV_PRICE_PCT

          if (oiTrending && priceTrending) {
            const oiTrendDir = oiTrendPct > 0 ? 'UP' : 'DOWN'
            const priceTrendDir = priceChangeSameWindow > 0 ? 'UP' : 'DOWN'

            if (oiTrendDir !== priceTrendDir) {
              let divDirection, divDesc
              if (priceTrendDir === 'UP' && oiTrendDir === 'DOWN') {
                divDirection = 'SHORT'
                divDesc = `🔀 OI Divergence (exhaustion) — Price +${priceChangeSameWindow.toFixed(1)}% but OI ${oiTrendPct.toFixed(1)}% (${oiHist.length}h)`
              } else {
                divDirection = 'LONG'
                divDesc = `🔀 OI Divergence (accumulation) — Price ${priceChangeSameWindow.toFixed(1)}% but OI +${oiTrendPct.toFixed(1)}% (${oiHist.length}h)`
              }

              // Confidence: stronger divergence = higher conf
              let divConf = 50
                + Math.min(15, Math.abs(oiTrendPct) * 2)
                + Math.min(10, Math.abs(priceChangeSameWindow) * 2)
              if (regime.direction) {
                const withTrend = (regime.direction === 'BULLISH' && divDirection === 'LONG') ||
                                  (regime.direction === 'BEARISH' && divDirection === 'SHORT')
                divConf += withTrend ? 5 : -5
              }

              emitSignal({
                type: 'oi_divergence',
                symbol, price,
                signalTime: new Date(parseInt(oiHist[lastIdx].timestamp)).toISOString(),
                direction: divDirection,
                confidence: Math.max(30, Math.min(95, Math.round(divConf))),
                description: divDesc,
                metadata: {
                  oiTrendPct: parseFloat(oiTrendPct.toFixed(2)),
                  priceChange: parseFloat(priceChangeSameWindow.toFixed(2)),
                  oiCandles: oiHist.length,
                  subType: 'oi_divergence',
                  fundingPct: parseFloat(fundingPct.toFixed(4)),
                  marketRegime: regime.direction || 'UNKNOWN',
                  ...ctx,
                }
              })
            }
          }
        }

        // === OI FUNDING SQUEEZE contrarian signal ===
        // Extreme funding = one side overcrowded → trade against them
        // OI spike strengthens signal, but extreme funding alone is enough
        {
          let sqDir = null, sqDesc = null
          const oiLabel = oiChangePct > 0 ? `+${oiChangePct.toFixed(1)}` : oiChangePct.toFixed(1)

          if (fundingPct > FUNDING_SQUEEZE_POS) {
            sqDir = 'SHORT'
            sqDesc = `⚡ Funding Squeeze — OI ${oiLabel}%/1h + funding +${fundingPct.toFixed(3)}% (longs overcrowded)`
          } else if (fundingPct < FUNDING_SQUEEZE_NEG) {
            sqDir = 'LONG'
            sqDesc = `⚡ Funding Squeeze — OI ${oiLabel}%/1h + funding ${fundingPct.toFixed(3)}% (shorts overcrowded)`
          }

          if (sqDir) {
            const fundingExtreme = Math.abs(fundingPct)
            const oiBoost = oiChangePct > OI_CHANGE_PCT ? Math.min(10, (oiChangePct - OI_CHANGE_PCT) * 2) : 0
            let sqConf = 55
              + Math.min(15, fundingExtreme * 100)
              + oiBoost
            if (regime.direction) {
              const withTrend = (regime.direction === 'BULLISH' && sqDir === 'LONG') ||
                                (regime.direction === 'BEARISH' && sqDir === 'SHORT')
              sqConf += withTrend ? 5 : -5
            }

            emitSignal({
              type: 'oi_funding_squeeze',
              symbol, price,
              signalTime: new Date(parseInt(oiHist[lastIdx].timestamp)).toISOString(),
              direction: sqDir,
              confidence: Math.max(30, Math.min(95, Math.round(sqConf))),
              description: sqDesc,
              metadata: {
                oiChangePct: parseFloat(oiChangePct.toFixed(2)),
                fundingPct: parseFloat(fundingPct.toFixed(4)),
                subType: 'oi_funding_squeeze',
                marketRegime: regime.direction || 'UNKNOWN',
                ...ctx,
              }
            })
          }
        }

      } catch (e) {
        errCount++
      }

      await new Promise(r => setTimeout(r, OI_CVD_DELAY_MS))
    }

    log.info({ symbols: top.length, signals: signalCount, errors: errCount || undefined }, 'OI+CVD scan done')
  } catch (err) {
    log.error({ err: err.message }, 'OI+CVD scan error')
  }
}

// ======================== OUTCOME TRACKER (MFE/MAE) ========================

async function checkOutcomes() {
  try {
    const pending = _auth.stmts.getPendingSignals.all()
    if (!pending || pending.length === 0) return

    // Try cache first, then fetch fresh if stale (fixes: no tracking when UI is idle)
    let ticker
    try { ticker = await _fetchTicker24hr() } catch { /* will retry next cycle */ }
    if (!Array.isArray(ticker) || ticker.length === 0) return

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
        // Restore from DB to survive PM2 restarts (avoid overwriting real MFE/MAE with 0)
        track = { mfe: sig.mfe_pct || 0, mae: sig.mae_pct || 0, createdAt: now }
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
      const mfeChanged = track.mfe > (sig.mfe_pct || 0) || track.mae < (sig.mae_pct || 0)

      if (!updated && !shouldFinalize && !mfeChanged) continue

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
      } catch (e) { log.error({ signalId: sig.id, err: e.message }, 'Outcome update failed') }
    }

    // Cleanup stale MFE trackers (older than 25h)
    for (const [key, track] of mfeTracker.entries()) {
      const age = now - (track.createdAt || 0)
      if (age > 25 * 3600_000) mfeTracker.delete(key)
    }
  } catch (err) {
    log.error({ err: err.message }, 'Outcome check error')
  }
}

// ======================== VPIN TOXICITY ========================

function scanVPIN() {
  if (!_vpinScanner) return
  try {
    const all = _vpinScanner.getAll()
    const tickers = _getProxyCached('ticker24hr', 60_000)
    const priceMap = {}
    if (Array.isArray(tickers)) {
      for (const t of tickers) priceMap[t.symbol] = parseFloat(t.lastPrice)
    }

    let emitted = 0
    for (const entry of all) {
      if (entry.vpin < VPIN_THRESHOLD) break // sorted desc, no more above threshold

      const price = priceMap[entry.symbol] || 0
      if (!price) continue

      // Direction from buy/sell ratio
      let direction = 'LONG'
      let dirLabel = 'aggressive buying'
      if (entry.buyPct < VPIN_SELL_SHORT) {
        direction = 'SHORT'
        dirLabel = 'aggressive selling'
      } else if (entry.buyPct <= VPIN_BUY_LONG) {
        direction = 'NEUTRAL'
        dirLabel = 'direction unclear'
      }

      // Confidence: VPIN 0.5→50, 0.7→70, 0.9→90, cap 95
      const confidence = Math.min(95, Math.round(40 + (entry.vpin - 0.4) * 100))

      const buyPctFmt = (entry.buyPct * 100).toFixed(1)
      const description = direction === 'NEUTRAL'
        ? `VPIN ${entry.vpin.toFixed(3)} — high toxicity, ${dirLabel} (${buyPctFmt}% buy)`
        : `VPIN ${entry.vpin.toFixed(3)} — ${dirLabel} (${buyPctFmt}% buy)`

      emitSignal({
        type: 'vpin_toxicity',
        symbol: entry.symbol,
        direction,
        price,
        confidence,
        description,
        metadata: {
          subType: 'vpin_toxicity',
          vpin: +entry.vpin.toFixed(4),
          buyPct: +buyPctFmt,
          sellPct: +((1 - entry.buyPct) * 100).toFixed(1),
          totalVol: entry.totalVol,
          buckets: entry.buckets,
        },
      })
      emitted++
    }
    if (emitted) log.info({ emitted }, 'VPIN signals emitted')
  } catch (err) {
    log.error({ err: err.message }, 'VPIN scan error')
  }
}

// ======================== EMIT ========================

function emitSignal({ type, symbol, direction, price, confidence, description, metadata, signalTime }) {
  // For channel signals, include subType in cooldown key so bounce/reversal/acceleration don't block each other
  const subType = metadata?.subType
  const dedupKey = (type === 'channel' && subType) ? `${subType}:${symbol}` : `${type}:${symbol}`
  const now = Date.now()

  // In-memory cooldown (fast path)
  if (cooldowns.has(dedupKey) && now - cooldowns.get(dedupKey) < COOLDOWN_MS) return

  // DB-based dedup (survives restarts)
  try {
    let recent
    if (type === 'channel' && subType) {
      recent = _auth.db.prepare(
        "SELECT id FROM signal_log WHERE type = ? AND symbol = ? AND json_extract(metadata, '$.subType') = ? AND created_at > datetime('now', '-' || ? || ' minutes') LIMIT 1"
      ).get(type, symbol, subType, Math.floor(COOLDOWN_MS / 60_000))
    } else {
      recent = _auth.db.prepare(
        "SELECT id FROM signal_log WHERE type = ? AND symbol = ? AND created_at > datetime('now', '-' || ? || ' minutes') LIMIT 1"
      ).get(type, symbol, Math.floor(COOLDOWN_MS / 60_000))
    }
    if (recent) { cooldowns.set(dedupKey, now); return }
  } catch (e) { log.warn({ err: e.message }, 'DB dedup check failed') }

  cooldowns.set(dedupKey, now)

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
    const info = _auth.stmts.logSignal.run(type, symbol, direction, price, confidence, JSON.stringify(metadata), dbTs)
    // Use DB rowid so push signalId matches API response id
    signal.id = String(info.lastInsertRowid)
  } catch (err) {
    log.error({ err: err.message }, 'DB log error')
  }

  // Send Web Push immediately (fire-and-forget, never blocks)
  if (_push) {
    try { _push.sendPushForSignal(signal) } catch (e) {
      log.error({ err: e.message }, 'Push notification error')
    }
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
      } else if (s.type === 'oi_divergence' && m.oiTrendPct !== undefined) {
        const divType = m.oiTrendPct < 0 ? 'exhaustion' : 'accumulation'
        s.description = `🔀 OI Divergence (${divType}) — Price ${m.priceChange > 0 ? '+' : ''}${m.priceChange}% but OI ${m.oiTrendPct > 0 ? '+' : ''}${m.oiTrendPct}%`
      } else if (s.type === 'oi_funding_squeeze' && m.fundingPct !== undefined) {
        const crowd = m.fundingPct > 0 ? 'longs overcrowded' : 'shorts overcrowded'
        s.description = `⚡ Funding Squeeze — OI ${m.oiChangePct > 0 ? '+' : ''}${m.oiChangePct}%/1h + funding ${m.fundingPct > 0 ? '+' : ''}${m.fundingPct}% (${crowd})`
      } else if (s.type === 'liq_sweep' && m.sweptLevel) {
        const dir = s.direction === 'LONG' ? 'Bullish' : 'Bearish'
        const lvl = (m.levelType || '').replace('_', ' ')
        const wick = m.wickRatio ? `${(m.wickRatio * 100).toFixed(0)}% wick` : ''
        s.description = `🎯 ${dir} sweep — took ${lvl} at ${m.sweptLevel}${wick ? ', ' + wick : ''}`
      } else if (s.type === 'channel' && m.subType) {
        const icons = { channel_bounce: '↩️', channel_reversal: '🔄', channel_acceleration: '🚀' }
        const labels = { channel_bounce: 'Bounce', channel_reversal: 'Reversal', channel_acceleration: 'Acceleration' }
        const icon = icons[m.subType] || '📐'
        const label = labels[m.subType] || m.subType
        const stars = m.confluence >= 3 ? ' ★★★' : m.confluence >= 2 ? ' ★★' : ''
        const tfStr = m.timeframes && m.timeframes.length > 1 ? ` [${m.timeframes.join(',')}]` : m.interval ? ` [${m.interval}]` : ''
        const touchStr = m.touchCount > 1 ? ` ${m.touchCount}${m.touchCount===2?'nd':m.touchCount===3?'rd':'th'} touch` : ''
        const r2 = m.r2 ? ` R²=${m.r2.toFixed(2)}` : ''
        s.description = `${icon} Channel ${label}${stars} — ${m.slopeDir || ''} ${m.reason || ''}${touchStr}${tfStr}${r2}`
      }
    }
  } catch (err) {
    log.error({ err: err.message }, 'DB read error, falling back to memory')
    result = [...liveSignals]
  }

  if (filters.type) {
    const types = filters.type.includes(',') ? new Set(filters.type.split(',')) : null
    result = types ? result.filter(s => types.has(s.type)) : result.filter(s => s.type === filters.type)
  }
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
    { id: 'oi_divergence', label: 'OI Divergence', icon: '🔀', color: '#f59e0b' },
    { id: 'oi_funding_squeeze', label: 'Funding Squeeze', icon: '⚡', color: '#f97316' },
    { id: 'liq_sweep', label: 'Liq Sweep', icon: '🎯', color: '#ef4444' },
    { id: 'channel', label: 'Channel', icon: '📐', color: '#06b6d4' },
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
