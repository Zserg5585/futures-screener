const fetch = require('node-fetch').default

const BASE_URL = 'https://fapi.binance.com'

// Simple retry with exponential backoff
async function retryWithBackoff(fn, maxAttempts = 3, initialDelay = 1000) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts) {
        const delay = initialDelay * Math.pow(2, attempt - 1)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}

async function getKlines({ symbol, interval = '5m', limit = 10 }) {
  const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res = await retryWithBackoff(async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }, 3, 1000)
  
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
