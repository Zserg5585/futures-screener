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

// Multiplier for mm0 (minimum candidate) - default 2.0x
const mmSeedMultiplier = Number(process.env.MM_SEED_MULTIPLIER) || 2.0

// Scoring parameters
const SCORE_DECAY_PCT = 0.45
const SCORE_MM_BOOST = 1.8

// K-lines timeframe (5 minutes in ms)
const KLINE_INTERVAL = '5m'
const KLINE_LIMIT = 3

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

// Scoring function: score = log10(1 + notional) * exp(-distancePct / decayPct) * (isMM ? mmBoost : 1)
function calcScore({ notional, distancePct, isMM }) {
  const n = Math.log10(1 + notional)
  const d = Math.exp(-distancePct / SCORE_DECAY_PCT)
  const boost = isMM ? SCORE_MM_BOOST : 1
  return n * d * boost
}

// In-memory cache (TTL: 3 seconds)
const cache = new Map()
const CACHE_TTL_MS = 3000

function getCacheKey(req) {
  return JSON.stringify({
    symbols: req.query.symbols || 'all',
    minNotional: req.query.minNotional || 50000,
    depthLimit: req.query.depthLimit || 100,
    windowPct: req.query.windowPct || 1.0,
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
    // Получаем K-lines: open, high, low, close, volume, time
    const klines = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`)
    
    if (!klines || klines.length < 3) {
      return { vol1: 0, vol2: 0, vol3: 0, natr: 0 }
    }

    // Из K-line берём: [time, open, high, low, close, volume, ...]
    const convert = (k) => ({
      open: toNumber(k[1]),
      high: toNumber(k[2]),
      low: toNumber(k[3]),
      close: toNumber(k[4]),
      volume: toNumber(k[5])
    })
    
    const bars = klines.map(convert).reverse() // Binance returns oldest first; reverse => [newest, prev, oldest]

    // Объёмы: vol1=newest (t), vol2=prev (t-1), vol3=oldest (t-2)
    const vol1 = bars[0] ? bars[0].volume : 0 // newest (t)
    const vol2 = bars[1] ? bars[1].volume : 0 // prev (t-1)
    const vol3 = bars[2] ? bars[2].volume : 0 // oldest (t-2)

    // Расчёт ATR (Average True Range)
    // True Range = max(high - low, |high - prev_close|, |low - prev_close|)
    if (bars.length < 3) return { vol1, vol2, vol3, natr: 0 }

    const trValues = []
    for (let i = 1; i < bars.length; i++) {
      const highLow = bars[i].high - bars[i].low
      const highPrevClose = Math.abs(bars[i].high - bars[i - 1].close)
      const lowPrevClose = Math.abs(bars[i].low - bars[i - 1].close)
      const tr = Math.max(highLow, highPrevClose, lowPrevClose)
      trValues.push(tr)
    }

    // ATR = среднее по последним (period) TR
    const period = 14 // стандартный период ATR
    const natrPeriod = Math.min(period, trValues.length)
    const atrValues = trValues.slice(-natrPeriod)
    const natr = (atrValues.reduce((a, b) => a + b, 0) / natrPeriod)

    return { vol1, vol2, vol3, natr }

  } catch (err) {
    // Если не удалось получить K-lines, возвращаем нули
    return { vol1: 0, vol2: 0, vol3: 0, natr: 0 }
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

    // Получить K-lines для объёмов и ATR
    const klinesStats = await getKlinesWithStats(sym)

    const ob = await bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=${depthLimit}`)
    const { filteredLevels, bidLevels, askLevels } = calcNearestDensities({
      price,
      bids: ob.bids,
      asks: ob.asks,
      minNotional,
      windowPct
    })

    // MM cluster parameters
    const MM_WINDOW_PCT = 2.0  // искать MM в ±2% от цены
    const MAX_GAP_PCT = 0.2    // макс расстояние в кластере
    const MIN_CLUSTER_NOTIONAL = 20000
    const MIN_LEVELS_IN_CLUSTER = 2

    // Раздельная логика для bid и ask
    const processSide = (levels, sideKey) => {
      const notionals = levels.map(l => l.notional)
      
      // Двухшаговый percentile 70 для base (без кластеров)
      const baseAll = percentile(notionals, 70)
      const filteredNotionals = notionals.filter(n => n <= baseAll * 2)
      const finalBaseAll = percentile(filteredNotionals, 70) || (baseAll || 50000)

      // MM0 и кандидаты
      const mm0 = finalBaseAll * mmSeedMultiplier
      const mmCandidates = levels.filter(l => l.notional >= mm0)

      // === MM CLUSTERIZATION ===
      // Группируем уровни в кластеры
      const clusters = groupCloseLevels(levels, MAX_GAP_PCT)
      
      // Фильтруем кластеры по минимальному notional и кол-ву уровней
      const validClusters = clusters.filter(c => {
        const totalNotional = c.reduce((sum, l) => sum + l.notional, 0)
        return totalNotional >= MIN_CLUSTER_NOTIONAL && c.length >= MIN_LEVELS_IN_CLUSTER
      })
      
      // Расчёт mmBase из valid clusters
      const clusterNotionals = validClusters.map(c => 
        c.reduce((sum, l) => sum + l.notional, 0)
      )
      
      const mmBase = clusterNotionals.length >= 3
        ? percentile(clusterNotionals, 50)
        : (clusterNotionals.length > 0 ? percentile(clusterNotionals, 50) : (finalBaseAll || 50000))
      
      // === ПЕРЕСЧЁТ x ДЛЯ КАЖДОГО УРОВНЯ ===
      // Для каждого уровня считаем, к какому кластеру он относится
      const levelsWithX = levels.map(level => {
        // Находим ближайший кластер для этого уровня
        let bestCluster = null
        let minDist = Infinity
        
        validClusters.forEach(cluster => {
          cluster.forEach(cLevel => {
            const dist = Math.abs(level.price - cLevel.price) / cLevel.price * 100
            if (dist < minDist) {
              minDist = dist
              bestCluster = cluster
            }
          })
        })
        
        // Считаем totalNotional кластера
        const clusterTotalNotional = bestCluster 
          ? bestCluster.reduce((sum, l) => sum + l.notional, 0)
          : level.notional
        
        // x = level.notional / mmBase (для каждого уровня)
        const x = mmBase > 0 ? level.notional / mmBase : 0
        const mmCount = bestCluster ? bestCluster.length : 1
        
        return { ...level, x, mmCount }
      })
      
      // Вычисляем score и сортируем
      const scoredLevels = levelsWithX.map(level => {
        const score = calcScore({ notional: level.notional, distancePct: level.distancePct, isMM: false })
        return { ...level, score }
      }).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (a.distancePct !== b.distancePct) return a.distancePct - b.distancePct
        return b.notional - a.notional
      })

      // Берём top-N (настраиваемый через depthLimit)
      const topN = scoredLevels.slice(0, depthLimit)

      return {
        sym,
        finalBaseAll,
        mm0,
        mmCandidatesCount: mmCandidates.length,
        mmBase,
        levels: topN.map(l => ({
          ...l,
          score: Math.round(l.score * 10000) / 10000,
          mmBase: mmBase,
          sideKey
        }))
      }
    }

    const bidResult = processSide(bidLevels, 'bid')
    const askResult = processSide(askLevels, 'ask')

    // Сохраняем sym для всех уровней этого символа
    const symVal = bidResult.sym

    return [...bidResult.levels, ...askResult.levels].map(level => ({
      ...level,
      symbol: symVal,
      natr: klinesStats.natr,
      vol1: klinesStats.vol1,
      vol2: klinesStats.vol2,
      vol3: klinesStats.vol3,
      mmBaseBid: bidResult.mmBase,
      mmBaseAsk: askResult.mmBase
    }))
  })

  // Получаем все уровни (без фильтрации по x)
  const allLevels = rowsArr.flat()

  // Фильтрация символов — показываем только те, у которых есть уровни с x >= xFilter (если xFilter > 0)
  let finalData = allLevels
  if (xFilter > 0) {
    // Группируем по symbol и проверяем, есть ли у каждого символа хотя бы один уровень с x >= xFilter
    const symbolsWithHighX = new Set()
    allLevels.forEach(d => {
      if (d.x >= xFilter) {
        symbolsWithHighX.add(d.symbol)
      }
    })
    // Оставляем только уровни из символов, у которых есть высокий x
    finalData = allLevels.filter(d => symbolsWithHighX.has(d.symbol))
  }

  // Фильтрация по NATR (если natrFilter > 0, показываем только уровни с natr >= natrFilter%)
  if (natrFilter > 0) {
    finalData = finalData.filter(d => d.natr !== null && d.natr >= natrFilter)
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
