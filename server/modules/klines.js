'use strict'
/**
 * Klines module — uses centralized binance-client for rate-limited fetches.
 * Previously used raw fetch() bypassing the rate limiter.
 */
const { bgetWithRetry } = require('../binance-client')

async function getKlines({ symbol, interval = '5m', limit = 10 }) {
  const res = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
  
  // [time, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
  return res.map(row => ({
    time: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  }))
}

function calculateATR(klines, period = 14) {
  const actualPeriod = Math.min(period, klines.length - 1)
  if (actualPeriod < 1) return null
  
  let trSum = 0
  for (let i = klines.length - actualPeriod; i < klines.length; i++) {
    const high = klines[i].high
    const low = klines[i].low
    const prevClose = klines[i - 1].close
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trSum += tr
  }
  
  const atr = trSum / actualPeriod
  const currentClose = klines[klines.length - 1].close
  const natr = (atr / currentClose) * 100
  
  return {
    atr,
    natr
  }
}

module.exports = {
  getKlines,
  calculateATR
}
