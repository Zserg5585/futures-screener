'use strict'
/**
 * Treemap data provider — batch RSI + momentum for all traded symbols.
 * Combines ticker24hr (price, change%, volume) with RSI-14 (5m).
 * Caches results 30s so the endpoint is cheap even with 200+ symbols.
 */

const { createLogger } = require('./logger')
const log = createLogger('treemap')

let _bgetWithRetry = null
let _getProxyCached = null

// Cache
let _cache = null       // { ts, data[] }
const CACHE_TTL = 30_000 // 30s

// RSI settings
const RSI_PERIOD = 14
const RSI_TF = '5m'
const RSI_KLINE_LIMIT = RSI_PERIOD + 2

// Concurrency control — don't hammer Binance
const MAX_CONCURRENT = 8

function init({ bgetWithRetry, getProxyCached }) {
  _bgetWithRetry = bgetWithRetry
  _getProxyCached = getProxyCached
  log.info('Treemap provider initialized')
}

/**
 * Compute RSI for a single symbol (same algo as alerts.js)
 */
async function computeRSI(symbol) {
  try {
    const klines = await _bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${RSI_TF}&limit=${RSI_KLINE_LIMIT}`)
    if (!Array.isArray(klines) || klines.length < RSI_PERIOD + 1) return null

    const closes = klines.map(k => parseFloat(k[4]))
    let gains = 0, losses = 0

    for (let i = 1; i <= RSI_PERIOD; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff > 0) gains += diff
      else losses -= diff
    }

    let avgGain = gains / RSI_PERIOD
    let avgLoss = losses / RSI_PERIOD

    for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      avgGain = (avgGain * (RSI_PERIOD - 1) + (diff > 0 ? diff : 0)) / RSI_PERIOD
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + (diff < 0 ? -diff : 0)) / RSI_PERIOD
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    return 100 - (100 / (1 + rs))
  } catch {
    return null
  }
}

/**
 * Batch-fetch RSI for symbols with concurrency limit
 */
async function batchRSI(symbols) {
  const results = new Map()
  const queue = [...symbols]

  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift()
      const rsi = await computeRSI(sym)
      results.set(sym, rsi)
    }
  }

  const workers = Array.from({ length: MAX_CONCURRENT }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Get treemap data — ticker + RSI merged. Cached 30s.
 * Returns: [{ symbol, price, changePct, volume, rsi, sector }]
 */
async function getData() {
  // Return cache if fresh
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    return _cache.data
  }

  try {
    // 1. Get ticker24hr for all symbols (cache → Bottleneck, maxConcurrent=50 supports weight=40)
    let tickers = _getProxyCached('ticker24hr', 60_000)
    if (!Array.isArray(tickers) || tickers.length === 0) {
      try {
        tickers = await _bgetWithRetry('/fapi/v1/ticker/24hr')
      } catch (e) {
        log.warn({ err: e.message }, 'Failed to fetch ticker24hr for treemap')
      }
    }
    if (!Array.isArray(tickers) || tickers.length === 0) {
      log.warn('No ticker data for treemap')
      return _cache ? _cache.data : []
    }

    // Filter USDT perpetuals, sort by volume, take top 100
    const usdtTickers = tickers
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 0)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)

    // 2. Batch compute RSI for top 100
    const symbols = usdtTickers.map(t => t.symbol)
    const rsiMap = await batchRSI(symbols)

    // 3. Merge into treemap items
    const data = usdtTickers.map(t => {
      const rsi = rsiMap.get(t.symbol)
      const changePct = parseFloat(t.priceChangePercent) || 0
      const volume = parseFloat(t.quoteVolume) || 0
      const price = parseFloat(t.lastPrice) || 0

      return {
        symbol: t.symbol.replace('USDT', ''),
        pair: t.symbol,
        price,
        changePct: Math.round(changePct * 100) / 100,
        volume: Math.round(volume),
        rsi: rsi !== null ? Math.round(rsi * 10) / 10 : null,
        // Classify sector by volume rank
        tier: volume > 1e9 ? 'mega' : volume > 2e8 ? 'large' : volume > 5e7 ? 'mid' : 'small'
      }
    })

    _cache = { ts: Date.now(), data }
    log.info({ count: data.length, withRSI: data.filter(d => d.rsi !== null).length }, 'Treemap data refreshed')
    return data
  } catch (err) {
    log.error({ err: err.message }, 'Treemap getData failed')
    return _cache ? _cache.data : []
  }
}

function getStats() {
  return {
    cached: _cache ? true : false,
    cacheAge: _cache ? Math.round((Date.now() - _cache.ts) / 1000) : null,
    symbols: _cache ? _cache.data.length : 0,
    withRSI: _cache ? _cache.data.filter(d => d.rsi !== null).length : 0
  }
}

module.exports = { init, getData, getStats }
