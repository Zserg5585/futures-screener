'use strict'
const { createLogger } = require('./logger')
const log = createLogger('vpin')

/**
 * VPIN — Volume-Synchronized Probability of Informed Trading
 *
 * Measures order flow toxicity by comparing buy vs sell volume
 * in equal-sized volume buckets. High VPIN (>0.5) = informed trading,
 * expect volatility. Leading indicator (precedes moves by minutes).
 *
 * Uses Binance taker buy/sell volume from klines (exact, not estimated).
 * Buckets: 50 (standard), each = totalVolume / 50.
 * VPIN = Σ|V_buy - V_sell| / (n × V_bucket)
 *
 * Scan runs periodically for top symbols by volume.
 */

const NUM_BUCKETS = 50
const SCAN_INTERVAL_MS = 60_000     // scan every 60s
const SCAN_KLINE_LIMIT = 100        // 100 candles for computation
const SCAN_INTERVAL_TF = '5m'       // 5-minute candles
const MAX_SYMBOLS = 60              // top 60 by volume
const CACHE_TTL_MS = 55_000         // cache results for 55s

let _bgetWithRetry = null
let _getProxyCached = null
let _scanInterval = null

// symbol -> { vpin, buyPct, sellPct, totalVol, ts }
const vpinCache = new Map()

function init({ bgetWithRetry, getProxyCached }) {
  _bgetWithRetry = bgetWithRetry
  _getProxyCached = getProxyCached

  // First scan after 30s (let server warm up)
  setTimeout(() => {
    scanAll().catch(() => {})
    _scanInterval = setInterval(() => scanAll().catch(() => {}), SCAN_INTERVAL_MS)
  }, 30_000)

  log.info({ intervalSec: SCAN_INTERVAL_MS / 1000, buckets: NUM_BUCKETS, tf: SCAN_INTERVAL_TF }, 'VPIN scanner started')
}

function stop() {
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null }
  vpinCache.clear()
  log.info('VPIN scanner stopped')
}

/**
 * Compute VPIN for a single symbol from kline data
 * Kline format: [time, open, high, low, close, vol, closeTime, quoteVol, trades, takerBuyBaseVol, takerBuyQuoteVol, ...]
 */
function computeVPIN(klines) {
  if (!Array.isArray(klines) || klines.length < 20) return null

  // Extract buy/sell quote volumes per candle
  const candles = klines.map(k => {
    const quoteVol = parseFloat(k[7])     // total quote volume
    const buyQuoteVol = parseFloat(k[10]) // taker buy quote volume
    const sellQuoteVol = quoteVol - buyQuoteVol
    return { quoteVol, buyQuoteVol, sellQuoteVol }
  })

  const totalVolume = candles.reduce((s, c) => s + c.quoteVol, 0)
  if (totalVolume <= 0) return null

  const bucketSize = totalVolume / NUM_BUCKETS

  // Fill volume buckets
  let bucketBuy = 0
  let bucketSell = 0
  let bucketFilled = 0
  let sumAbsDiff = 0
  let bucketsComplete = 0
  let totalBuy = 0
  let totalSell = 0

  for (const candle of candles) {
    let remainBuy = candle.buyQuoteVol
    let remainSell = candle.sellQuoteVol

    totalBuy += candle.buyQuoteVol
    totalSell += candle.sellQuoteVol

    while (remainBuy + remainSell > 0) {
      const remaining = bucketSize - bucketFilled
      const candleRemaining = remainBuy + remainSell

      if (candleRemaining >= remaining) {
        // This candle fills the bucket
        const ratio = remaining / candleRemaining
        bucketBuy += remainBuy * ratio
        bucketSell += remainSell * ratio
        remainBuy -= remainBuy * ratio
        remainSell -= remainSell * ratio

        sumAbsDiff += Math.abs(bucketBuy - bucketSell)
        bucketsComplete++
        bucketBuy = 0
        bucketSell = 0
        bucketFilled = 0
      } else {
        // Candle partially fills bucket
        bucketBuy += remainBuy
        bucketSell += remainSell
        bucketFilled += candleRemaining
        remainBuy = 0
        remainSell = 0
      }
    }
  }

  if (bucketsComplete < 10) return null // not enough data

  const vpin = sumAbsDiff / (bucketsComplete * bucketSize)
  const buyPct = totalBuy / totalVolume
  const sellPct = totalSell / totalVolume

  return {
    vpin: Math.min(1, Math.max(0, vpin)),
    buyPct,
    sellPct,
    totalVol: totalVolume,
    buckets: bucketsComplete,
  }
}

/**
 * Get VPIN for a single symbol (from cache or compute)
 */
async function getVPIN(symbol) {
  const cached = vpinCache.get(symbol)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached

  try {
    const klines = await _bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${SCAN_INTERVAL_TF}&limit=${SCAN_KLINE_LIMIT}`)
    if (!Array.isArray(klines)) return null

    const result = computeVPIN(klines)
    if (!result) return null

    const entry = { symbol, ...result, ts: Date.now() }
    vpinCache.set(symbol, entry)
    return entry
  } catch (err) {
    return vpinCache.get(symbol) || null // return stale on error
  }
}

/**
 * Scan top symbols by volume, compute VPIN for each
 */
async function scanAll() {
  if (!_getProxyCached || !_bgetWithRetry) return

  const tickers = _getProxyCached('ticker24hr', 60_000)
  if (!Array.isArray(tickers)) return

  // Sort by quote volume, take top N
  const sorted = tickers
    .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10_000_000)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, MAX_SYMBOLS)

  let computed = 0
  for (const t of sorted) {
    try {
      const result = await getVPIN(t.symbol)
      if (result) computed++
    } catch (_) {}
  }

  log.debug({ computed, total: sorted.length }, 'VPIN scan complete')
}

/**
 * Get all cached VPIN values, sorted by VPIN descending (most toxic first)
 */
function getAll() {
  const results = []
  const now = Date.now()
  for (const [, entry] of vpinCache) {
    if (now - entry.ts < CACHE_TTL_MS * 2) { // allow slightly stale
      results.push(entry)
    }
  }
  results.sort((a, b) => b.vpin - a.vpin)
  return results
}

/**
 * Get stats for monitoring
 */
function getStats() {
  const all = getAll()
  const avg = all.length ? all.reduce((s, e) => s + e.vpin, 0) / all.length : 0
  const high = all.filter(e => e.vpin > 0.5)
  return {
    cached: vpinCache.size,
    avgVpin: +avg.toFixed(4),
    highToxicity: high.length,
    top5: all.slice(0, 5).map(e => ({ symbol: e.symbol, vpin: +e.vpin.toFixed(4), buyPct: +(e.buyPct * 100).toFixed(1) })),
  }
}

module.exports = { init, stop, getVPIN, getAll, getStats, computeVPIN }
