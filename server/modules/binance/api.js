'use strict'
/**
 * Binance API helpers — all calls go through centralized binance-client.
 * Previously these used raw fetch() bypassing the rate limiter.
 */
const { bgetWithRetry } = require('../../binance-client')

async function getDepth(symbol, limit = 100) {
  return bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
}

async function get24hStats(symbol) {
  return bgetWithRetry(`/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`)
}

/* ---------- Cached mark price (per-symbol) ---------- */
const markCache = new Map() // symbol → { price, ts }

async function getMarkPrice(symbol) {
  const now = Date.now()
  const cached = markCache.get(symbol)
  if (cached && cached.price && now - cached.ts < 2000) {
    return cached
  }
  try {
    const data = await bgetWithRetry(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`)
    const markPrice = data.markPrice ? parseFloat(data.markPrice) : null
    if (markPrice) {
      const entry = { price: markPrice, ts: now }
      markCache.set(symbol, entry)
      return entry
    }
    return cached || { price: null, ts: 0 }
  } catch (_) {
    // fallback to lastPrice from 24h ticker
    const stats = await get24hStats(symbol)
    const lastPrice = stats && stats.lastPrice ? parseFloat(stats.lastPrice) : null
    if (lastPrice) {
      const entry = { price: lastPrice, ts: now }
      markCache.set(symbol, entry)
      return entry
    }
    return cached || { price: null, ts: 0 }
  }
}

module.exports = {
  getDepth,
  get24hStats,
  getMarkPrice
}
