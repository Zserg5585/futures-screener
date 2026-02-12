const BINANCE_FAPI = 'https://fapi.binance.com';

async function getDepth(symbol, limit = 100) {
  // existing depth implementation (placeholder)
  return await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
    .then(r => r.json());
}

async function get24hStats(symbol) {
  // existing 24h stats implementation (placeholder)
  return await fetch(`${BINANCE_FAPI}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`)
    .then(r => r.json());
}

/* ---------- NEW: cached mark price ---------- */
let cachedMark = { price: null, ts: 0 };
async function getMarkPrice(symbol) {
  const now = Date.now();
  if (cachedMark.price && now - cachedMark.ts < 2000) {
    return cachedMark;
  }
  try {
    const res = await fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    const markPrice = data.markPrice ? parseFloat(data.markPrice) : null;
    if (markPrice) {
      cachedMark = { price: markPrice, ts: now };
    }
    return cachedMark;
  } catch (_) {
    // fallback to lastPrice from 24h ticker
    const stats = await get24hStats(symbol);
    const lastPrice = stats && stats.lastPrice ? parseFloat(stats.lastPrice) : null;
    if (lastPrice) {
      cachedMark = { price: lastPrice, ts: now };
    }
    return cachedMark;
  }
}

module.exports = {
  getDepth,
  get24hStats,
  getMarkPrice
};