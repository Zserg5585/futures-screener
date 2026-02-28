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
    // Получаем K-lines: open, high, low, close, volume, time
    const klines = await bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`)

    if (!klines || klines.length < 5) {
      return { vol1: 0, vol2: 0, vol3: 0, vol4: 0, vol5: 0, natr: 0 }
    }

    // Из K-line берём: [time, open, high, low, close, volume, ...]
    const convert = (k) => ({
      open: toNumber(k[1]),
      high: toNumber(k[2]),
      low: toNumber(k[3]),
      close: toNumber(k[4]),
      volume: toNumber(k[7]) // Quote asset volume (USDT)
    })

    const bars = klines.map(convert) // Binance returns oldest first

    // Расчёт ATR (Average True Range)
    // True Range = max(high - low, |high - prev_close|, |low - prev_close|)
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
    const natrPeriod = Math.min(period, trValues.length > 0 ? trValues.length : 1)
    const atrValues = trValues.slice(-natrPeriod)
    const atr = (atrValues.reduce((a, b) => a + b, 0) / natrPeriod)

    const latestClose = bars[bars.length - 1] ? bars[bars.length - 1].close : 0
    const natr = latestClose > 0 ? (atr / latestClose) * 100 : 0

    const revBars = [...bars].reverse() // [newest, prev, oldest...]
    // Объёмы: vol1=newest (t), vol2=prev (t-1), vol3=oldest (t-2)
    const vol1 = revBars[0] ? revBars[0].volume : 0 // newest (t)
    const vol2 = revBars[1] ? revBars[1].volume : 0 // prev (t-1)
    const vol3 = revBars[2] ? revBars[2].volume : 0 // oldest (t-2)
    const vol4 = revBars[3] ? revBars[3].volume : 0
    const vol5 = revBars[4] ? revBars[4].volume : 0

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

      // === ГРУППИРОВКА УРОВНЕЙ В UI-КЛАСТЕРЫ (OPTION 1) ===
      const CLUSTER_UI_GAP_PCT = 0.5
      const uiGroupedLevels = []
      let currentGroup = []

      for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i]
        if (currentGroup.length === 0) {
          currentGroup.push(lvl)
        } else {
          const frontPrice = currentGroup[0].price
          const dist = Math.abs(lvl.price - frontPrice) / frontPrice * 100
          if (dist <= CLUSTER_UI_GAP_PCT) {
            currentGroup.push(lvl)
          } else {
            uiGroupedLevels.push(currentGroup)
            currentGroup = [lvl]
          }
        }
      }
      if (currentGroup.length > 0) {
        uiGroupedLevels.push(currentGroup)
      }

      // Превращаем группы в единичные "плотности"
      const levelsWithX = uiGroupedLevels.map(group => {
        const frontLevel = group[0]
        const sumNotional = group.reduce((sum, l) => sum + l.notional, 0)

        // Считаем x для суммарного объема
        const x = mmBase > 0 ? sumNotional / mmBase : 0
        const mmCount = group.length

        return {
          ...frontLevel,
          notional: sumNotional,
          x,
          mmCount,
          isUiCluster: mmCount > 1
        }
      })

      // ============================================
      // Вычисляем Time To Eat, историю (Touches), Score и сортируем
      // ============================================
      const now = Date.now()
      const isBid = sideKey === 'bid'

      const totalVol = klinesStats.vol1 + klinesStats.vol2 + klinesStats.vol3 + klinesStats.vol4 + klinesStats.vol5
      const avgVolPerMin = totalVol / 25

      const scoredLevels = levelsWithX.map(level => {
        const cacheKey = `${sym}:${isBid ? 'BID' : 'ASK'}:${level.price}`
        let history = levelHistory.get(cacheKey)
        let isMoved = false

        if (!history) {
          // Проверяем: ищем этот же кластер по старой цене (если цена сдвинулась)
          for (const [k, v] of levelHistory.entries()) {
            if (k.startsWith(`${sym}:${isBid ? 'BID' : 'ASK'}`)) {
              const oldPrice = parseFloat(k.split(':')[2])
              const dist = Math.abs(level.price - oldPrice) / oldPrice * 100
              // Кластеры у нас шириной 0.5%, поэтому если старая цена в пределах 0.5% - это тот же кластер
              if (dist < 0.5 && (now - v.lastUpdate) > 1000) {
                isMoved = true
                history = { ...v, lastUpdate: now, state: 'MOVED' }
                levelHistory.delete(k)
                break
              }
            }
          }

          if (!history) {
            history = {
              firstSeen: now,
              lastUpdate: now,
              maxNotional: level.notional,
              touches: 0,
              isCurrentlyTouching: false,
              state: 'APPEARED'
            }
          }
        } else {
          history.lastUpdate = now
          if (level.notional > history.maxNotional) {
            history.maxNotional = level.notional
          }

          // Логика Касаний (Touches)
          if (level.distancePct <= 0.15) {
            history.isCurrentlyTouching = true
          } else {
            if (history.isCurrentlyTouching) {
              history.touches = (history.touches || 0) + 1
              history.isCurrentlyTouching = false
            }
          }

          if (level.notional < history.maxNotional * 0.95 && history.state !== 'MOVED') {
            history.state = 'UPDATED' // объем съедают
          } else {
            if (history.state !== 'MOVED') history.state = 'APPEARED'
          }
        }
        levelHistory.set(cacheKey, history)

        const lifetimeSec = Math.floor((now - history.firstSeen) / 1000)
        let eatSpeed = 0
        if (lifetimeSec > 3) {
          eatSpeed = (history.maxNotional - level.notional) / lifetimeSec
        }

        const timeToEatMinutes = avgVolPerMin > 0 ? (level.notional / avgVolPerMin) : Infinity

        const score = calcScore({
          notional: level.notional,
          distancePct: level.distancePct,
          isMM: level.mmCount > 1,
          timeToEatMinutes,
          natr: klinesStats.natr,
          lifetimeSec
        })

        // Telegram Alerts
        if (score >= 5.0 && level.distancePct <= 0.3 && history.state !== 'MOVED') {
          if (!history.alerted || (now - history.alerted) > 300000) { // раз в 5 минут на уровень
            const sideIcon = isBid ? '🟢' : '🔴'
            sendTelegramAlert(`🚨 <b>${sym}</b> ${sideIcon} ${isBid ? 'LONG (BID)' : 'SHORT (ASK)'}
Цена: <b>${level.price}</b>
Дистанция: <b>${level.distancePct.toFixed(2)}%</b>
Объем: <b>$${(level.notional / 1000000).toFixed(2)}M</b>
Score: <b>${score.toFixed(1)}</b>`)
            history.alerted = now
          }
        }

        return {
          ...level,
          score,
          lifetimeSec,
          timeToEatMinutes,
          touches: history.touches || 0,
          state: history.state,
          maxNotional: history.maxNotional,
          eatSpeed: Math.max(0, Math.floor(eatSpeed))
        }
      }).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (a.distancePct !== b.distancePct) return a.distancePct - b.distancePct
        return b.notional - a.notional
      })

      // Оставляем только 1 лучший кластер на каждую сторону для монеты, чтобы не спамить таблицу
      const topN = scoredLevels.slice(0, 1)

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
          sideKey,
          symbol: sym,
          natr: klinesStats.natr,
          vol1: klinesStats.vol1,
          vol2: klinesStats.vol2,
          vol3: klinesStats.vol3,
          vol4: klinesStats.vol4,
          vol5: klinesStats.vol5,
          mmBaseBid: sideKey === 'bid' ? mmBase : undefined,
          mmBaseAsk: sideKey === 'ask' ? mmBase : undefined,
        }))
      };
    };

    const bidResult = processSide(bidLevels, 'bid');
    const askResult = processSide(askLevels, 'ask');

    // Теперь нам не нужен второй мап, мы всё сделали внутри processSide!
    return [...bidResult.levels, ...askResult.levels];
  });

  // Получаем все уровни (без фильтрации по x)
  const allLevels = rowsArr.flat()

  // Фильтрация уровней — показываем только те плотности, у которых x >= xFilter
  let finalData = allLevels
  if (xFilter > 0) {
    finalData = allLevels.filter(d => d.x >= xFilter)
  }

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
