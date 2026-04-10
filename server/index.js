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

// Custom Modules
const wsManager = require('./ws');
const stateManager = require('./state');
const { binLevels } = require('./logic');
const { analyzeBehavior } = require('./scorer');

// Connect WebSockets on Start
wsManager.connect();

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

// Multiplier for mm0 (minimum candidate) - default 2.0x
const mmSeedMultiplier = Number(process.env.MM_SEED_MULTIPLIER) || 2.0

// Scoring parameters
const SCORE_DECAY_PCT = 0.45
const SCORE_MM_BOOST = 1.8

// K-lines timeframe (5 minutes in ms)
const KLINE_INTERVAL = '5m'
const KLINE_LIMIT = 20

// Binance K-lines order: index 0 = oldest, last = newest
// After reverse(): bars[0] = newest (t), bars[1] = prev (t-1), bars[2] = oldest (t-2)
// So: vol1 = newest (t), vol2 = prev (t-1), vol3 = oldest (t-2)
// Note: Variable names now match time order, not index order

function filterLevelsByWindow(levels, markPrice, windowPct) {
  return levels.filter(level => {
    const distPct = Math.abs(level.price - markPrice) / markPrice * 100;
    return distPct <= windowPct;
  });
}

// Group close levels into clusters (for MM detection)
// levels: array of {price, notional, distancePct}
// maxGapPct: max distance between levels in same cluster (%)
function groupCloseLevels(levels, maxGapPct = 0.2) {
  if (!levels || levels.length === 0) return []

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price)

  const clusters = []
  let currentCluster = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const level = sorted[i]
    const prevLevel = sorted[i - 1]

    // Calculate gap in % relative to price
    const gapPct = Math.abs(level.price - prevLevel.price) / prevLevel.price * 100

    if (gapPct <= maxGapPct) {
      // Add to current cluster
      currentCluster.push(level)
    } else {
      // Close current cluster and start new one
      if (currentCluster.length >= 2) {
        clusters.push(currentCluster)
      }
      currentCluster = [level]
    }
  }

  // Don't forget the last cluster
  if (currentCluster.length >= 2) {
    clusters.push(currentCluster)
  }

  return clusters
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

// Scoring function: enhanced with Time To Eat, NATR, and lifetime
function calcScore({ notional, distancePct, isMM, timeToEatMinutes, natr, lifetimeSec }) {
  let score = notional / 1000000; // Base score in millions
  score = score / (1 + distancePct); // Penalty for distance

  if (timeToEatMinutes > 60) score *= 1.5; // Huge wall compared to 25m passing volume
  if (natr > 1.0) score *= 1.2; // Bonus for high volatility coins
  if (lifetimeSec > 300) score *= 1.2; // Bonus for proven walls (5+ mins old)
  if (isMM) score *= 1.5; // Bonus for clustered MM levels

  return score;
}

// In-memory cache (TTL: 3 seconds)
const cache = new Map()
const CACHE_TTL_MS = 3000

// --- Level History State ---
const levelHistory = new Map()
// Очистка старых уровней (TTL: 1 минута без обновлений)
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of levelHistory.entries()) {
    if (now - val.lastUpdate > 60000) {
      levelHistory.delete(key)
    }
  }
}, 30000)

// --- Telegram Alerts Scaffold ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

async function sendTelegramAlert(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    })
  } catch (e) {
    console.error('Telegram Error:', e.message)
  }
}

function getCacheKey(req) {
  return JSON.stringify({
    symbols: req.query.symbols || 'all',
    minNotional: req.query.minNotional || 50000,
    depthLimit: req.query.depthLimit || 100,
    windowPct: req.query.windowPct || 1.0,
    minScore: req.query.minScore || 0,
    concurrency: req.query.concurrency || 6
  })
}

function getCached(req) {
  const key = getCacheKey(req)
  const entry = cache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.data
  }
  return null
}

function setCached(req, data) {
  const key = getCacheKey(req)
  cache.set(key, { data, ts: Date.now() })
}

// Retry/backoff helper for Binance requests
async function bgetWithRetry(path, maxRetries = 3, baseDelay = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await bget(path)
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Binance GET ${path} failed after ${maxRetries} attempts: ${err.message}`)
      }
      const delay = baseDelay * Math.pow(2, attempt - 1)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

// Получить K-lines и рассчитать объёмы + ATR
async function getKlinesWithStats(symbol) {
  try {
    // Получаем K-lines параллельно: 1d (для NATR) и 5m (для объемов)
    const [klines1d, klines5m] = await Promise.all([
      bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=${14}`),
      bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=${5}`)
    ])

    let natr = 0;
    
    // Расчет NATR по 1-дневным свечам
    if (klines1d && klines1d.length > 0) {
      const convert = (k) => ({
        high: toNumber(k[2]),
        low: toNumber(k[3]),
        close: toNumber(k[4])
      })
      const bars = klines1d.map(convert)
      
      const trValues = []
      // True Range
      for (let i = 1; i < bars.length; i++) {
        const highLow = bars[i].high - bars[i].low
        const highPrevClose = Math.abs(bars[i].high - bars[i - 1].close)
        const lowPrevClose = Math.abs(bars[i].low - bars[i - 1].close)
        const tr = Math.max(highLow, highPrevClose, lowPrevClose)
        trValues.push(tr)
      }

      if (trValues.length > 0) {
        const atr = trValues.reduce((a, b) => a + b, 0) / trValues.length
        const latestClose = bars[bars.length - 1].close
        natr = latestClose > 0 ? (atr / latestClose) * 100 : 0
      } else if (bars.length === 1) { // Если монета совсем новая
        const latestClose = bars[0].close
        const highLow = bars[0].high - bars[0].low
        natr = latestClose > 0 ? (highLow / latestClose) * 100 : 0
      }
    }

    let vol1 = 0, vol2 = 0, vol3 = 0, vol4 = 0, vol5 = 0;

    // Объемы по 5-минутным свечам
    if (klines5m && klines5m.length > 0) {
      const convert5m = (k) => ({ volume: toNumber(k[7]) })
      const bars5m = klines5m.map(convert5m).reverse() // [newest, prev, oldest...]
      
      vol1 = bars5m[0] ? bars5m[0].volume : 0
      vol2 = bars5m[1] ? bars5m[1].volume : 0
      vol3 = bars5m[2] ? bars5m[2].volume : 0
      vol4 = bars5m[3] ? bars5m[3].volume : 0
      vol5 = bars5m[4] ? bars5m[4].volume : 0
    }

    return { vol1, vol2, vol3, vol4, vol5, natr }

  } catch (err) {
    // Если не удалось получить K-lines, возвращаем нули
    return { vol1: 0, vol2: 0, vol3: 0, vol4: 0, vol5: 0, natr: 0 }
  }
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

fastify.get('/densities.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('densities.js'))
})

fastify.get('/mini-charts.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('mini-charts.js'))
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
  const info = await bgetWithRetry('/fapi/v1/exchangeInfo')
  const symbols = (info.symbols || [])
    .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map(s => s.symbol)
  return { count: symbols.length, symbols }
})

fastify.get('/depth/:symbol', async (req) => {
  const symbol = String(req.params.symbol || '').toUpperCase()
  const limit = Number(req.query.limit || 100)
  const ob = await bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
  return { symbol, lastUpdateId: ob.lastUpdateId, bids: ob.bids, asks: ob.asks }
})

// NEW: simple flat output for UI (scoring, sorting, cache)
fastify.get('/densities/simple', async (req) => {
  const minNotional = Number(req.query.minNotional || 0)
  const depthLimit = Number(req.query.depthLimit || 100)
  const mmMode = req.query.mmMode === 'true'
  const windowPct = Number(req.query.windowPct || 5.0)  // 5% по умолчанию
  const mmMultiplier = Number(req.query.mmMultiplier || 4)  // 4x по умолчанию
  const xFilter = Number(req.query.xFilter || 0)  // фильтр по x (0 = без фильтра)
  const natrFilter = Number(req.query.natrFilter || 0)  // фильтр по NATR (0 = без фильтра)
  const minScore = Number(req.query.minScore || 0) // фильтр по Score
  const concurrency = Number(req.query.concurrency || 5)  // ускоренная загрузка (5 вместо 3)

  // Blacklist монет (топовые не торгуем в этой стратегии — исключаем из сканирования)
  const blacklistedSymbols = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'REPEUSDT', 'AVAXUSDT', 'TRXUSDT', 'NEARUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT', 'LTCUSDT', 'BCHUSDT', 'ETCUSDT', 'FILUSDT', 'AAVEUSDT', 'UNIUSDT', 'COMPUSDT'])

  let symbols
  if (req.query.symbols) {
    // Если символы переданы явно — не фильтруем через blacklist (пользователь знает, что делает)
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(s => s)
  } else {
    const info = await bgetWithRetry('/fapi/v1/exchangeInfo')
    symbols = (info.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING' && !blacklistedSymbols.has(s.symbol))
      .map(s => s.symbol)
  }

  // DEBUG: log symbols
  // console.log(`DEBUG symbols: ${JSON.stringify(symbols.slice(0, 5))}`)

  // Ограничиваем количество символов (чтобы не сканировать всё)
  const limitSymbols = Number(req.query.limitSymbols || 30)
  if (limitSymbols > 0 && symbols.length > limitSymbols) {
    symbols = symbols.slice(0, limitSymbols)
  }

  const marks = await bgetWithRetry('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  const rowsArr = await mapLimit(symbols, concurrency, async (sym) => {
    const price = markMap.get(sym)
    if (!price) return []

    // 1. Subscribe to WebSocket if not already tracked
    if (!wsManager.callbacks.has(sym)) {
      // Fetch initial snapshot to seed state
      const ob = await bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=1000`);
      stateManager.initBook(sym, ob.bids, ob.asks);
      
      wsManager.subscribe(sym, (payload) => {
        stateManager.processDelta(sym, payload);
      });
    }

    // 2. Get local state from memory (from WS deltas)
    const bidLevelsRaw = stateManager.getTopLevels(sym, 'bid', price, minNotional, depthLimit, windowPct);
    const askLevelsRaw = stateManager.getTopLevels(sym, 'ask', price, minNotional, depthLimit, windowPct);

    // Получить K-lines для объёмов и ATR
    const klinesStats = await getKlinesWithStats(sym)

    // 3. Binning & Density Analysis (New Logic)
    const processSide = (levels, sideKey) => {
      // Grouping orders in 0.1% dynamic bins
      const BIN_SIZE_PCT = 0.1;
      const rawBins = binLevels(levels, BIN_SIZE_PCT);

      // Filtering out empty bins and noise
      const validBins = rawBins.filter(b => b.notional >= minNotional);

      // --- ROBOT TRACKING ---
      // Pass valid bins to stateManager to figure out which ones moved recently
      const trackedBins = stateManager.trackAndEnrichBins(sym, sideKey, validBins, price);

      const scoredBins = trackedBins.map(bin => {
        const behavior = analyzeBehavior(bin, price, klinesStats.natr);

        const avg5mVol = (klinesStats.vol1 + klinesStats.vol2 + klinesStats.vol3 + klinesStats.vol4 + klinesStats.vol5) / 5;
        // Фильтр: плотность должна быть >= 3 * средний 5m объем
        if (avg5mVol > 0 && bin.notional < (avg5mVol * 3)) {
            return null; // Игнорируем слишком мелкие плотности
        }

        let tte = Infinity;
        if (avg5mVol > 0) {
            tte = bin.notional / (avg5mVol / 5); // рассчитываем время в минутах
        }

        return {
          symbol: sym,
          sideKey,
          price: Math.round(bin.anchorPrice * 10000) / 10000,
          notional: bin.notional,
          distancePct: behavior.distancePct,
          lifetimeMins: Math.round(behavior.lifetimeMins * 10) / 10,
          score: behavior.trustScore, 
          tags: behavior.tags,
          levelsCount: bin.levelsCount,
          natr: klinesStats.natr,
          vol1: klinesStats.vol1,
          vol2: klinesStats.vol2,
          vol3: klinesStats.vol3,
          vol4: klinesStats.vol4,
          vol5: klinesStats.vol5,
          timeToEatMinutes: tte
        };
      }).filter(Boolean);

      // Сортировка по Score (убывание) и дистанции
      scoredBins.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.distancePct - b.distancePct;
      });

      // Return Top 2 Zones per coin per side
      return scoredBins.slice(0, 2);
    };

    const bidResult = processSide(bidLevelsRaw, 'bid');
    const askResult = processSide(askLevelsRaw, 'ask');

    return [...bidResult, ...askResult];
  });

  // Получаем все уровни
  const allLevels = rowsArr.flat()

  // Дедупликация: Оставляем только ОДНУ самую сильную плотность на монету
  const maxPerSymbol = {};
  for (const entry of allLevels) {
      if (!maxPerSymbol[entry.symbol] || entry.score > maxPerSymbol[entry.symbol].score) {
          maxPerSymbol[entry.symbol] = entry;
      } else if (entry.score === maxPerSymbol[entry.symbol].score) {
          if (entry.notional > maxPerSymbol[entry.symbol].notional) {
              maxPerSymbol[entry.symbol] = entry;
          }
      }
  }

  let finalData = Object.values(maxPerSymbol);

  // Фильтрация по NATR (если natrFilter > 0, показываем только уровни с natr >= natrFilter%)
  if (natrFilter > 0) {
    finalData = finalData.filter(d => d.natr !== null && d.natr >= natrFilter)
  }

  // Фильтрация по Score
  if (minScore > 0) {
    finalData = finalData.filter(d => d.score >= minScore)
  }

  const result = {
    count: finalData.length,
    minNotional,
    depthLimit,
    concurrency,
    mmMode,
    windowPct,
    mmMultiplier,
    xFilter,
    natrFilter,
    data: finalData
  }

  // Return raw data — UI will handle sorting and filtering

  return result
})

// Cache stats endpoint
fastify.get('/_cache/stats', async () => ({
  size: cache.size,
  keys: [...cache.keys()]
}))

// ---- Binance Proxy for Mini-Charts (cached) ----
const proxyCache = new Map()

function getProxyCached(key, ttlMs) {
  const entry = proxyCache.get(key)
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data
  return null
}

function setProxyCached(key, data) {
  proxyCache.set(key, { data, ts: Date.now() })
}

// 24hr ticker — cached 30s (all pairs, heavy endpoint)
fastify.get('/api/ticker24hr', async () => {
  const cached = getProxyCached('ticker24hr', 30000)
  if (cached) return cached
  const data = await bgetWithRetry('/fapi/v1/ticker/24hr')
  setProxyCached('ticker24hr', data)
  return data
})

// Klines — cached 10s per symbol+interval combo
fastify.get('/api/klines', async (req) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  const interval = String(req.query.interval || '15m')
  const limit = Math.min(Number(req.query.limit || 200), 1500)
  const endTime = req.query.endTime ? Number(req.query.endTime) : null
  if (!symbol) return { error: 'symbol required' }

  const endSuffix = endTime ? `&endTime=${endTime}` : ''
  const key = `klines:${symbol}:${interval}:${limit}${endSuffix}`
  const cached = getProxyCached(key, 10000)
  if (cached) return cached

  const data = await bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}${endSuffix}`)
  setProxyCached(key, data)
  return data
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
