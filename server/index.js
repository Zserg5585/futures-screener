const fastify = require('fastify')({ logger: true })

// Binance Futures (USDT-M) REST base
const BINANCE_FAPI = 'https://fapi.binance.com'

// ---- helpers ----
async function bget(path) {
  const res = await fetch(BINANCE_FAPI + path, { method: 'GET' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Binance GET ${path} failed: ${res.status} ${txt}`)
  }
  return res.json()
}

function toNumber(x) { return Number(x) }

function calcNearestDensities({ price, bids, asks, minNotional }) {
  // bids/asks are arrays: [priceStr, qtyStr]
  let nearestBid = null
  let nearestAsk = null

  for (const [pStr, qStr] of bids) {
    const p = toNumber(pStr), q = toNumber(qStr)
    const notional = p * q
    if (notional >= minNotional) {
      const distPct = ((price - p) / price) * 100
      if (distPct >= 0) {
        if (!nearestBid || distPct < nearestBid.distancePct) {
          nearestBid = { side: 'bid', price: p, qty: q, notional, distancePct: distPct }
        }
      }
    }
  }

  for (const [pStr, qStr] of asks) {
    const p = toNumber(pStr), q = toNumber(qStr)
    const notional = p * q
    if (notional >= minNotional) {
      const distPct = ((p - price) / price) * 100
      if (distPct >= 0) {
        if (!nearestAsk || distPct < nearestAsk.distancePct) {
          nearestAsk = { side: 'ask', price: p, qty: q, notional, distancePct: distPct }
        }
      }
    }
  }

  return { nearestBid, nearestAsk }
}

// Simple concurrency limiter (no deps)
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

// ---- routes ----
fastify.get('/health', async () => {
  return { status: 'ok', service: process.env.SERVICE_NAME || 'futures-screener' }
})

fastify.get('/symbols', async () => {
  // USDT-M perpetual symbols that are trading
  const info = await bget('/fapi/v1/exchangeInfo')
  const symbols = (info.symbols || [])
    .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map(s => s.symbol)
  return { count: symbols.length, symbols }
})

fastify.get('/depth/:symbol', async (req) => {
  const symbol = String(req.params.symbol || '').toUpperCase()
  const limit = Number(req.query.limit || 100) // 5/10/20/50/100/500/1000
  const ob = await bget(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
  return { symbol, lastUpdateId: ob.lastUpdateId, bids: ob.bids, asks: ob.asks }
})

// Existing endpoint (as-is)
fastify.get('/densities', async (req) => {
  // Query:
  //   ?minNotional=50000&symbols=BTCUSDT,ETHUSDT&limitSymbols=50&depthLimit=100&concurrency=8
  const minNotional = Number(req.query.minNotional || 50000)
  const depthLimit = Number(req.query.depthLimit || 100)
  const concurrency = Number(req.query.concurrency || 6)

  let symbols = []
  if (req.query.symbols) {
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  } else {
    const info = await bget('/fapi/v1/exchangeInfo')
    symbols = (info.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol)
  }

  const limitSymbols = Number(req.query.limitSymbols || 0)
  if (limitSymbols > 0) symbols = symbols.slice(0, limitSymbols)

  // mark prices in one call
  const marks = await bget('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  const results = await mapLimit(symbols, concurrency, async (sym) => {
    const price = markMap.get(sym)
    if (!price) return null

    const ob = await bget(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=${depthLimit}`)
    const { nearestBid, nearestAsk } = calcNearestDensities({
      price,
      bids: ob.bids,
      asks: ob.asks,
      minNotional
    })

    if (!nearestBid && !nearestAsk) return null

    return {
      symbol: sym,
      price,
      minNotional,
      nearestBid,
      nearestAsk
    }
  })

  const filtered = results.filter(Boolean)
  return { count: filtered.length, minNotional, depthLimit, concurrency, data: filtered }
})

// NEW: simple flat output for UI (no scoring, no sorting, no filters beyond minNotional)
fastify.get('/densities/simple', async (req) => {
  // Query:
  //   ?minNotional=50000&symbols=BTCUSDT,ETHUSDT&limitSymbols=50&depthLimit=100&concurrency=6
  const minNotional = Number(req.query.minNotional || 50000)
  const depthLimit = Number(req.query.depthLimit || 100)
  const concurrency = Number(req.query.concurrency || 6)

  let symbols = []
  if (req.query.symbols) {
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  } else {
    const info = await bget('/fapi/v1/exchangeInfo')
    symbols = (info.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol)
  }

  const limitSymbols = Number(req.query.limitSymbols || 0)
  if (limitSymbols > 0) symbols = symbols.slice(0, limitSymbols)

  const marks = await bget('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  const rowsArr = await mapLimit(symbols, concurrency, async (sym) => {
    const price = markMap.get(sym)
    if (!price) return []

    const ob = await bget(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=${depthLimit}`)
    const { nearestBid, nearestAsk } = calcNearestDensities({
      price,
      bids: ob.bids,
      asks: ob.asks,
      minNotional
    })

    const rows = []
    if (nearestBid) rows.push({
      symbol: sym,
      side: 'bid',
      markPrice: price,
      levelPrice: nearestBid.price,
      qty: nearestBid.qty,
      notional: nearestBid.notional,
      distancePct: nearestBid.distancePct
    })
    if (nearestAsk) rows.push({
      symbol: sym,
      side: 'ask',
      markPrice: price,
      levelPrice: nearestAsk.price,
      qty: nearestAsk.qty,
      notional: nearestAsk.notional,
      distancePct: nearestAsk.distancePct
    })

    return rows
  })

  const data = rowsArr.flat()
  return { count: data.length, minNotional, depthLimit, concurrency, data }
})

// ---- start ----
const port = Number(process.env.PORT || 3100)

const start = async () => {
  try {
    // only local listen; nginx proxy does external
    await fastify.listen({ port, host: '127.0.0.1' })
    fastify.log.info(`listening on 127.0.0.1:${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
