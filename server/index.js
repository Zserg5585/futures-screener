const fastify = require('fastify')({ 
    logger: true,
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }
})

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

// Utility function to calculate percentile
function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
}

function filterLevelsByWindow(levels, markPrice, windowPct) {
  return levels.filter(level => {
    const distPct = Math.abs(level.price - markPrice) / markPrice * 100;
    return distPct <= windowPct;
  });
}

function calcNearestDensities({ price, bids, asks, minNotional, windowPct }) {
  // bids/asks are arrays: [priceStr, qtyStr]
  const filteredLevels = [];

  for (const [pStr, qStr] of bids) {
    const p = toNumber(pStr), q = toNumber(qStr)
    const notional = p * q
    if (notional >= minNotional) {
      const distPct = Math.abs((price - p) / price) * 100
      if (distPct <= windowPct) {
        filteredLevels.push({ 
          side: 'bid', 
          price: p, 
          qty: q, 
          notional, 
          distancePct: distPct 
        })
      }
    }
  }

  for (const [pStr, qStr] of asks) {
    const p = toNumber(pStr), q = toNumber(qStr)
    const notional = p * q
    if (notional >= minNotional) {
      const distPct = Math.abs((p - price) / price) * 100
      if (distPct <= windowPct) {
        filteredLevels.push({ 
          side: 'ask', 
          price: p, 
          qty: q, 
          notional, 
          distancePct: distPct 
        })
      }
    }
  }

  const bidLevels = filteredLevels.filter(l => l.side === 'bid');
  const askLevels = filteredLevels.filter(l => l.side === 'ask');

  return { filteredLevels, bidLevels, askLevels };
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

// ---- UI (static files from ../app) ----
const path = require('path')
const fs = require('fs')

const APP_DIR = path.resolve(__dirname, '..', 'app')

function readFileSafe(relPath) {
  const p = path.join(APP_DIR, relPath)
  return fs.readFileSync(p)
}

fastify.get('/', async (req, reply) => {
  reply.type('text/html; charset=utf-8').send(readFileSafe('index.html'))
})

fastify.get('/app.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('app.js'))
})

fastify.get('/styles.css', async (req, reply) => {
  reply.type('text/css; charset=utf-8').send(readFileSafe('styles.css'))
})

fastify.get('/favicon.ico', async (req, reply) => {
  reply.code(204).send()
})

// ---- API routes ----
fastify.get('/health', async () => {
  return { status: 'ok', service: process.env.SERVICE_NAME || 'futures-screener' }
})

fastify.get('/symbols', async () => {
  const info = await bget('/fapi/v1/exchangeInfo')
  const symbols = (info.symbols || [])
    .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map(s => s.symbol)
  return { count: symbols.length, symbols }
})

fastify.get('/depth/:symbol', async (req) => {
  const symbol = String(req.params.symbol || '').toUpperCase()
  const limit = Number(req.query.limit || 100)
  const ob = await bget(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
  return { symbol, lastUpdateId: ob.lastUpdateId, bids: ob.bids, asks: ob.asks }
})

// NEW: simple flat output for UI (no scoring, no sorting, no filters beyond minNotional)
fastify.get('/densities/simple', async (req) => {
  const minNotional = Number(req.query.minNotional || 50000)
  const depthLimit = Number(req.query.depthLimit || 100)
  const concurrency = Number(req.query.concurrency || 6)
  const mmMode = req.query.mmMode === 'true'
  const windowPct = Number(req.query.windowPct || 1.0)  // 1% по умолчанию
  const mmMultiplier = Number(req.query.mmMultiplier || 4)  // 4x по умолчанию

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
    const { filteredLevels, bidLevels, askLevels } = calcNearestDensities({
      price,
      bids: ob.bids,
      asks: ob.asks,
      minNotional,
      windowPct
    })

    // Расчет базового notional для bid и ask
    const bidNotionals = bidLevels.map(l => l.notional)
    const askNotionals = askLevels.map(l => l.notional)
    
    const baseNotionalBid = percentile(bidNotionals, 70)
    const baseNotionalAsk = percentile(askNotionals, 70)

    // Фильтрация и перерасчет базы
    const filteredBidNotionals = bidNotionals.filter(n => n <= baseNotionalBid * 2)
    const filteredAskNotionals = askNotionals.filter(n => n <= baseNotionalAsk * 2)

    const finalBaseNotionalBid = percentile(filteredBidNotionals, 70) 
    const finalBaseNotionalAsk = percentile(filteredAskNotionals, 70)

    const rows = filteredLevels.map(level => {
      const isMM = level.side === 'bid' 
        ? level.notional >= finalBaseNotionalBid * mmMultiplier
        : level.notional >= finalBaseNotionalAsk * mmMultiplier

      return {
        symbol: sym,
        side: level.side,
        markPrice: price,
        levelPrice: level.price,
        qty: level.qty,
        notional: level.notional,
        distancePct: level.distancePct,
        isMM,
        baseNotionalBid: finalBaseNotionalBid,
        baseNotionalAsk: finalBaseNotionalAsk,
        windowPct,
        mmMultiplier
      }
    }).filter(row => !mmMode || row.isMM)

    return rows
  })

  const data = rowsArr.flat()
  return { 
    count: data.length, 
    minNotional, 
    depthLimit, 
    concurrency, 
    mmMode,
    windowPct,
    mmMultiplier,
    data 
  }
})

// ---- start ----
const port = Number(process.env.PORT || 3200)

const start = async () => {
  try {
    await fastify.listen({ port, host: '0.0.0.0' })
    fastify.log.info(`listening on 127.0.0.1:${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
