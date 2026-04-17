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
const auth = require('./auth');
const signals = require('./signals');

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

// Simple concurrency limiter (no deps) with optional per-item delay
async function mapLimit(items, limit, fn, delayMs = 0) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) break
      out[idx] = await fn(items[idx], idx)
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    }
  })
  await Promise.all(workers)
  return out
}

// Density endpoint result cache (avoid re-scanning 500+ symbols on every request)
let densityCache = { data: null, meta: null, ts: 0 }
const DENSITY_CACHE_TTL = 60000 // 60 seconds (was 30s)
// Disk cache helpers for density results (survive PM2 restarts)
const DENSITY_CACHE_FILE = require('path').join(__dirname, '..', 'data', 'density-cache.json')
function saveDensityToDisk(data, meta) {
  try {
    const dir = require('path').dirname(DENSITY_CACHE_FILE)
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true })
    require('fs').writeFileSync(DENSITY_CACHE_FILE, JSON.stringify({ data, meta, ts: Date.now() }))
  } catch (e) { console.log('[density-cache] disk save error:', e.message) }
}
function loadDensityFromDisk() {
  try {
    if (!require('fs').existsSync(DENSITY_CACHE_FILE)) return null
    const raw = JSON.parse(require('fs').readFileSync(DENSITY_CACHE_FILE, 'utf8'))
    // Accept disk cache up to 10 minutes old (stale but better than nothing)
    if (raw && raw.data && (Date.now() - raw.ts) < 600000) {
      console.log(`[density-cache] Loaded ${raw.data.length} walls from disk (age: ${((Date.now() - raw.ts) / 1000).toFixed(0)}s)`)
      return raw
    }
  } catch (e) { console.log('[density-cache] disk load error:', e.message) }
  return null
}
// Load disk cache on startup
const diskCache = loadDensityFromDisk()
if (diskCache) {
  densityCache = { data: diskCache.data, meta: diskCache.meta, ts: diskCache.ts }
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
// Cleanup expired cache entries every 10 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > CACHE_TTL_MS) cache.delete(key)
  }
}, 10000)

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

// Klines stats cache (TTL 60s) to avoid hammering Binance
const klinesStatsCache = new Map()
const KLINES_STATS_TTL = 60000

// Получить K-lines и рассчитать объёмы + ATR
async function getKlinesWithStats(symbol) {
  const cached = klinesStatsCache.get(symbol)
  if (cached && (Date.now() - cached.ts) < KLINES_STATS_TTL) return cached.data
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

    const result = { vol1, vol2, vol3, vol4, vol5, natr }
    klinesStatsCache.set(symbol, { data: result, ts: Date.now() })
    return result

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

fastify.get('/auth.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('auth.js'))
})

fastify.get('/signals.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('signals.js'))
})
fastify.get('/settings.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').send(readFileSafe('settings.js'))
})

fastify.get('/styles.css', async (req, reply) => {
  reply.type('text/css; charset=utf-8').send(readFileSafe('styles.css'))
})

fastify.get('/favicon.ico', async (req, reply) => {
  reply.code(204).send()
})

fastify.get('/manifest.json', async (req, reply) => {
  reply.type('application/manifest+json; charset=utf-8').send(readFileSafe('manifest.json'))
})

fastify.get('/sw.js', async (req, reply) => {
  reply.type('application/javascript; charset=utf-8').header('Service-Worker-Allowed', '/').send(readFileSafe('sw.js'))
})

fastify.get('/icon-192.svg', async (req, reply) => {
  reply.type('image/svg+xml').send(readFileSafe('icon-192.svg'))
})

fastify.get('/icon-512.svg', async (req, reply) => {
  reply.type('image/svg+xml').send(readFileSafe('icon-512.svg'))
})

// ---- Auth routes ----

// Attach user to every request (non-blocking)
fastify.addHook('onRequest', async (req) => {
  auth.authHook(req)
})

fastify.post('/api/auth/register', async (req, reply) => {
  const { email, password, name } = req.body || {}
  const result = auth.register(email, password, name)
  if (result.error) return reply.code(400).send(result)
  return result
})

fastify.post('/api/auth/login', async (req, reply) => {
  const { email, password } = req.body || {}
  const result = auth.login(email, password)
  if (result.error) return reply.code(401).send(result)
  return result
})

fastify.get('/api/auth/me', async (req, reply) => {
  if (!req.user) return reply.code(401).send({ error: 'Not authenticated' })
  return { success: true, user: req.user }
})

// Google OAuth
fastify.get('/api/auth/google/url', async () => {
  const url = auth.getGoogleAuthUrl()
  if (!url) return { error: 'Google OAuth not configured' }
  return { url }
})

fastify.post('/api/auth/google/callback', async (req, reply) => {
  const { code } = req.body || {}
  if (!code) return reply.code(400).send({ error: 'Code required' })
  const result = await auth.googleAuth(code)
  if (result.error) return reply.code(400).send(result)
  return result
})

// Admin: set user tier (requires admin tier)
fastify.post('/api/auth/set-tier', async (req, reply) => {
  if (!req.user || req.user.tier !== 'admin') {
    return reply.code(403).send({ error: 'Admin only' })
  }
  const { userId, tier } = req.body || {}
  if (!userId || !['free', 'pro', 'admin'].includes(tier)) {
    return reply.code(400).send({ error: 'Invalid userId or tier' })
  }
  const user = auth.setTier(userId, tier)
  return { success: true, user }
})

// Admin: list users
fastify.get('/api/auth/users', async (req, reply) => {
  if (!req.user || req.user.tier !== 'admin') {
    return reply.code(403).send({ error: 'Admin only' })
  }
  return { users: auth.listUsers(), count: auth.getUserCount() }
})

// ---- User Data routes (settings, watchlists, layouts, alerts) ----

// Settings
fastify.get('/api/settings', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  return { success: true, settings: auth.getSettings(req.user.id) }
})

fastify.put('/api/settings', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const settings = req.body || {}
  auth.saveSettings(req.user.id, settings)
  return { success: true }
})

// Watchlists
fastify.get('/api/watchlist', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  return { success: true, watchlist: auth.getWatchlist(req.user.id) }
})

fastify.post('/api/watchlist', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const { symbol, color, sort_order } = req.body || {}
  if (!symbol) return reply.code(400).send({ error: 'Symbol required' })
  auth.addToWatchlist(req.user.id, symbol, color, sort_order)
  return { success: true }
})

fastify.delete('/api/watchlist/:symbol', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  auth.removeFromWatchlist(req.user.id, req.params.symbol)
  return { success: true }
})

// Layouts
fastify.get('/api/layouts', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  return { success: true, layouts: auth.getLayouts(req.user.id), active: auth.getActiveLayout(req.user.id) }
})

fastify.post('/api/layouts', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const { name, layout_type, config } = req.body || {}
  const result = auth.createLayout(req.user.id, name || 'Layout', layout_type || '1', config || {})
  return { success: true, id: result.lastInsertRowid }
})

fastify.put('/api/layouts/:id', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const { config, layout_type } = req.body || {}
  auth.updateLayout(Number(req.params.id), req.user.id, config, layout_type)
  return { success: true }
})

// Alerts
fastify.get('/api/alerts', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  return { success: true, alerts: auth.getUserAlerts(req.user.id) }
})

fastify.post('/api/alerts', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const { type, symbol, condition, cooldown_sec } = req.body || {}
  if (!type) return reply.code(400).send({ error: 'Alert type required' })
  const result = auth.createUserAlert(req.user.id, type, symbol, condition || {}, cooldown_sec || 300)
  return { success: true, id: result.lastInsertRowid }
})

fastify.delete('/api/alerts/:id', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  auth.stmts.deleteAlert.run(Number(req.params.id), req.user.id)
  return { success: true }
})

fastify.get('/api/alerts/triggers', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const limit = Number(req.query.limit || 50)
  return { success: true, triggers: auth.getAlertTriggers(req.user.id, limit) }
})

// Signal stats (public)
fastify.get('/api/signals/stats', async () => {
  return { success: true, stats: auth.getSignalStats(), recent: auth.getRecentSignals(20) }
})

// Live signals (in-memory, real-time)
fastify.get('/api/signals/live', async (req) => {
  const { type, symbol, direction, minConfidence, limit } = req.query
  const data = signals.getLiveSignals({ type, symbol, direction, minConfidence, limit })
  return { success: true, count: data.length, data }
})

// Signal summary (counts, types)
fastify.get('/api/signals/summary', async () => {
  return { success: true, ...signals.getSignalSummary() }
})

// Signal history (from DB, with pagination)
fastify.get('/api/signals/history', async (req) => {
  const limit = Math.min(Number(req.query.limit || 50), 200)
  const recent = auth.getRecentSignals(limit)
  return { success: true, count: recent.length, data: recent }
})

// ---- API routes ----
fastify.get('/health', async () => {
  return { status: 'ok', service: process.env.SERVICE_NAME || 'futures-screener', users: auth.getUserCount() }
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
  const concurrency = Number(req.query.concurrency || 3)  // parallel Binance requests (3 to stay under rate limit)

  const isSpecificSymbols = !!req.query.symbols
  let symbols
  if (isSpecificSymbols) {
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(s => s)
  } else {
    // Full scan — always return from cache (warmup populates it)
    if (densityCache.data) {
      let finalData = [...densityCache.data]
      if (xFilter > 0) finalData = finalData.filter(d => d.xMult >= xFilter)
      if (natrFilter > 0) finalData = finalData.filter(d => d.natr !== null && d.natr >= natrFilter)
      if (minScore > 0) finalData = finalData.filter(d => d.score >= minScore)
      const ageSec = ((Date.now() - densityCache.ts) / 1000).toFixed(0)
      return { ...densityCache.meta, xFilter, natrFilter, data: finalData, cached: true, cacheAgeSec: Number(ageSec) }
    }
    // No cache at all — return empty (warmup will fill it)
    return { count: 0, data: [], cached: false, message: 'Warming up, try again in 30s' }
  }

  // Optional limit (0 = no limit, scan all)
  const limitSymbols = Number(req.query.limitSymbols || 0)
  if (limitSymbols > 0 && symbols.length > limitSymbols) {
    symbols = symbols.slice(0, limitSymbols)
  }

  const marks = await bgetWithRetry('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  // Delay between items to stay under Binance rate limit (2400/min)
  // Full scan: 500 symbols × ~3 calls each = 1500 calls, concurrency 3, delay 500ms
  // → ~6 calls/sec → ~360/min (safe margin)
  const itemDelay = isSpecificSymbols ? 0 : 500
  const rowsArr = await mapLimit(symbols, concurrency, async (sym) => {
    const price = markMap.get(sym)
    if (!price) return []

    // 1. If not yet WS-subscribed: for full scans, skip (no data yet).
    //    For specific symbol queries (charts), fetch depth on demand.
    if (!wsManager.callbacks.has(sym)) {
      if (!isSpecificSymbols) {
        return []; // Full scan: skip unsubscribed symbols, they'll warm up via chart views
      }
      try {
        const ob = await bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=1000`);
        stateManager.initBook(sym, ob.bids, ob.asks);
        wsManager.subscribe(sym, (payload) => { stateManager.processDelta(sym, payload); });
      } catch (err) {
        console.log(`[density] Skip ${sym}: ${err.message.slice(0, 80)}`);
        return [];
      }
    }

    // 2. Get local state from memory (from WS deltas)
    const bidLevelsRaw = stateManager.getTopLevels(sym, 'bid', price, minNotional, depthLimit, windowPct);
    const askLevelsRaw = stateManager.getTopLevels(sym, 'ask', price, minNotional, depthLimit, windowPct);

    // Получить K-lines для объёмов и ATR
    const klinesStats = await getKlinesWithStats(sym)

    // 3. Binning & Density Analysis v2 (x-multiplier based)
    const avg5mVol = (klinesStats.vol1 + klinesStats.vol2 + klinesStats.vol3 + klinesStats.vol4 + klinesStats.vol5) / 5;

    const processSide = (levels, sideKey) => {
      const BIN_SIZE_PCT = 0.1;
      const rawBins = binLevels(levels, BIN_SIZE_PCT);
      const validBins = rawBins.filter(b => b.notional >= minNotional);
      const trackedBins = stateManager.trackAndEnrichBins(sym, sideKey, validBins, price);

      const scoredBins = trackedBins.map(bin => {
        const behavior = analyzeBehavior(bin, price, klinesStats.natr, avg5mVol);

        // x-multiplier filter: only walls >= xFilter (default x4)
        const minX = xFilter > 0 ? xFilter : 4;
        if (behavior.xMult < minX) return null;

        let tte = Infinity;
        if (avg5mVol > 0) {
            tte = bin.notional / (avg5mVol / 5);
        }

        return {
          symbol: sym,
          sideKey,
          price: Math.round(bin.anchorPrice * 10000) / 10000,
          notional: bin.notional,
          distancePct: Math.round(behavior.distancePct * 100) / 100,
          lifetimeMins: Math.round(behavior.lifetimeMins * 10) / 10,
          score: behavior.trustScore,
          xMult: Math.round(behavior.xMult * 10) / 10,
          severity: behavior.severity,
          tags: behavior.tags,
          levelsCount: bin.levelsCount,
          natr: klinesStats.natr,
          avg5mVol: Math.round(avg5mVol),
          vol1: klinesStats.vol1,
          vol2: klinesStats.vol2,
          vol3: klinesStats.vol3,
          vol4: klinesStats.vol4,
          vol5: klinesStats.vol5,
          timeToEatMinutes: tte
        };
      }).filter(Boolean);

      scoredBins.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.distancePct - b.distancePct;
      });

      // Top 2 per side (best bid wall + best ask wall)
      return scoredBins.slice(0, 2);
    };

    const bidResult = processSide(bidLevelsRaw, 'bid');
    const askResult = processSide(askLevelsRaw, 'ask');

    return [...bidResult, ...askResult];
  }, itemDelay);

  // All levels flat, sorted by score desc
  const allLevels = rowsArr.flat().sort((a, b) => b.score - a.score);

  // Top 3 per symbol (best bid + best ask + next best)
  const perSymbol = {};
  for (const entry of allLevels) {
    if (!perSymbol[entry.symbol]) perSymbol[entry.symbol] = [];
    if (perSymbol[entry.symbol].length < 3) {
      perSymbol[entry.symbol].push(entry);
    }
  }

  let finalData = Object.values(perSymbol).flat();
  finalData.sort((a, b) => b.score - a.score);

  // Фильтрация по NATR (если natrFilter > 0, показываем только уровни с natr >= natrFilter%)
  if (natrFilter > 0) {
    finalData = finalData.filter(d => d.natr !== null && d.natr >= natrFilter)
  }

  // Фильтрация по Score
  if (minScore > 0) {
    finalData = finalData.filter(d => d.score >= minScore)
  }

  // Cache full unfiltered data for subsequent requests
  if (!isSpecificSymbols) {
    // Store unfiltered data (before xFilter/natrFilter/minScore applied by params)
    // allLevels already has all scored walls, perSymbol top 3 = finalData before natr/score filters
    const unfilteredData = Object.values(perSymbol).flat()
    unfilteredData.sort((a, b) => b.score - a.score)
    const meta = { count: unfilteredData.length, minNotional, depthLimit, concurrency, mmMode, windowPct, mmMultiplier }
    densityCache = { data: unfilteredData, meta, ts: Date.now() }
    // Persist to disk so data survives PM2 restarts
    saveDensityToDisk(unfilteredData, meta)
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

  return result
})

// Cache stats endpoint
fastify.get('/_cache/stats', async () => ({
  size: cache.size,
  keys: [...cache.keys()]
}))

// ---- Binance Proxy for Mini-Charts (cached) ----
const proxyCache = new Map()
const PROXY_MAX_TTL_MS = 300000 // 5 min max TTL for cleanup
// Cleanup expired proxy cache entries every 30 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of proxyCache.entries()) {
    if (now - entry.ts > PROXY_MAX_TTL_MS) proxyCache.delete(key)
  }
}, 30000)

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

// Klines — cached 10s for latest, 5min for historical (with endTime)
fastify.get('/api/klines', async (req) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  const interval = String(req.query.interval || '15m')
  const limit = Math.min(Number(req.query.limit || 200), 1500)
  const endTime = req.query.endTime ? Number(req.query.endTime) : null
  if (!symbol) return { error: 'symbol required' }

  const endSuffix = endTime ? `&endTime=${endTime}` : ''
  const key = `klines:${symbol}:${interval}:${limit}${endSuffix}`
  // Historical pages (with endTime) don't change — cache 5 min
  // Latest candles — cache 10s for live updates
  const ttl = endTime ? 300000 : 10000
  const cached = getProxyCached(key, ttl)
  if (cached) return cached

  const data = await bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}${endSuffix}`)
  setProxyCached(key, data)
  return data
})

// Batch klines — fetch multiple symbols in one request (for mini-charts fast load)
fastify.post('/api/klines-batch', async (req) => {
  const symbols = req.body?.symbols
  const interval = String(req.body?.interval || '15m')
  const limit = Math.min(Number(req.body?.limit || 200), 500)
  if (!Array.isArray(symbols) || symbols.length === 0) return { error: 'symbols[] required' }

  // Cap at 30 symbols per batch
  const syms = symbols.slice(0, 30).map(s => String(s).toUpperCase())
  const result = {}

  // Fetch all in parallel (server-side, no rate limit issues with Binance for reasonable batch)
  const promises = syms.map(async (symbol) => {
    try {
      const key = `klines:${symbol}:${interval}:${limit}`
      let data = getProxyCached(key, 10000)
      if (!data) {
        data = await bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`)
        if (data) setProxyCached(key, data)
      }
      if (Array.isArray(data)) result[symbol] = data
    } catch(e) { /* skip */ }
  })
  await Promise.all(promises)
  return result
})

// NATR(14) for all USDT pairs — cached 5min
fastify.get('/api/natr', async (req) => {
  const interval = String(req.query.interval || '15m')
  const cached = getProxyCached(`natr:${interval}`, 300000) // 5 min cache
  if (cached) return cached

  // Get all USDT pairs from ticker
  const tickerCached = getProxyCached('ticker24hr', 30000)
  const ticker = tickerCached || await bgetWithRetry('/fapi/v1/ticker/24hr')
  if (!tickerCached) setProxyCached('ticker24hr', ticker)

  const usdtPairs = ticker
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 10000000) // >$10M vol only
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 200) // top 200 by volume

  // Fetch klines in parallel batches of 20
  const result = {}
  const batchSize = 20
  for (let i = 0; i < usdtPairs.length; i += batchSize) {
    const batch = usdtPairs.slice(i, i + batchSize)
    const promises = batch.map(async (t) => {
      try {
        const key = `klines:${t.symbol}:${interval}:50`
        let klines = getProxyCached(key, 10000)
        if (!klines) {
          klines = await bgetWithRetry(`/fapi/v1/klines?symbol=${t.symbol}&interval=${interval}&limit=50`)
          setProxyCached(key, klines)
        }
        if (!Array.isArray(klines) || klines.length < 15) return
        // Calculate ATR(14)
        const candles = klines.map(k => ({
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
        }))
        let trSum = 0
        for (let j = candles.length - 14; j < candles.length; j++) {
          const h = candles[j].high
          const l = candles[j].low
          const pc = candles[j - 1].close
          trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
        }
        const atr = trSum / 14
        const lastClose = candles[candles.length - 1].close
        if (lastClose > 0) result[t.symbol] = parseFloat(((atr / lastClose) * 100).toFixed(2))
      } catch(e) { /* skip pair */ }
    })
    await Promise.all(promises)
    // Small delay between batches to avoid rate limits
    if (i + batchSize < usdtPairs.length) await new Promise(r => setTimeout(r, 200))
  }

  setProxyCached(`natr:${interval}`, result)
  return result
})

// ---- start ----
const port = Number(process.env.PORT || 3200)

const start = async () => {
  try {
    await fastify.listen({ port, host: '0.0.0.0' })
    fastify.log.info(`listening on 127.0.0.1:${port}`)
    // Init signals scanner (after server up so proxyCache is available)
    signals.init({ getProxyCached, bgetWithRetry, auth, stateManager })
    // Background warmup: subscribe top symbols to WS gradually (rate-limit safe)
    warmupDensitySubscriptions()
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

// Gradually subscribe symbols to depth WS and build density cache
async function warmupDensitySubscriptions() {
  try {
    const info = await bgetWithRetry('/fapi/v1/exchangeInfo')
    const allSymbols = (info.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol)

    const BATCH = 10
    const BATCH_PAUSE = 20000 // 20s between batches
    const ITEM_DELAY = 300   // 300ms between items
    console.log(`[warmup] ${allSymbols.length} symbols, ${BATCH}/batch, ${BATCH_PAUSE/1000}s pause`)
    let subscribed = 0

    for (let i = 0; i < allSymbols.length; i += BATCH) {
      const batch = allSymbols.slice(i, i + BATCH)
      for (const sym of batch) {
        if (wsManager.callbacks.has(sym)) { subscribed++; continue }
        try {
          const ob = await bgetWithRetry(`/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=1000`)
          stateManager.initBook(sym, ob.bids, ob.asks)
          wsManager.subscribe(sym, (payload) => { stateManager.processDelta(sym, payload) })
          subscribed++
        } catch (err) {
          console.log(`[warmup] Error ${sym}: ${err.message.slice(0, 60)}, pausing 60s...`)
          await new Promise(r => setTimeout(r, 60000))
          i -= BATCH // retry this batch
          break
        }
        await new Promise(r => setTimeout(r, ITEM_DELAY))
      }

      // After every 5 batches (50 symbols), rebuild density cache
      const batchNum = Math.floor(i / BATCH) + 1
      if (batchNum % 5 === 0 || i + BATCH >= allSymbols.length) {
        try { await rebuildDensityCache(allSymbols) } catch (_) {}
        console.log(`[warmup] ${subscribed}/${allSymbols.length} subscribed, cache: ${densityCache.data ? densityCache.data.length : 0} walls`)
      }

      if (i + BATCH < allSymbols.length) {
        await new Promise(r => setTimeout(r, BATCH_PAUSE))
      }
    }
    console.log(`[warmup] Done: ${subscribed} symbols`)
    // After density warmup, pre-warm klines cache for fast chart loads
    warmupKlinesCache()
  } catch (err) {
    console.log(`[warmup] Failed: ${err.message.slice(0, 100)}`)
  }
}

// Pre-warm klines cache: top 200 by volume × main TFs → instant chart opens
async function warmupKlinesCache() {
  try {
    // Get top 200 symbols by 24h volume
    const ticker = await bgetWithRetry('/fapi/v1/ticker/24hr')
    const sorted = ticker
      .filter(t => t.symbol.endsWith('USDT'))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 200)
      .map(t => t.symbol)

    const TFS = ['15m', '1h', '4h']
    const LIMITS = { '15m': 1500, '1h': 1500, '4h': 1500 }
    const total = sorted.length * TFS.length
    let done = 0, cached = 0

    console.log(`[klines-warmup] Starting: ${sorted.length} symbols × ${TFS.length} TFs = ${total} requests`)

    for (const tf of TFS) {
      for (let i = 0; i < sorted.length; i++) {
        const sym = sorted[i]
        const limit = LIMITS[tf]
        const key = `klines:${sym}:${tf}:${limit}`

        // Skip if already cached
        if (getProxyCached(key, 300000)) { done++; cached++; continue }

        try {
          const data = await bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${limit}`)
          setProxyCached(key, data)
          done++
        } catch (err) {
          // Rate limit — pause 30s and continue
          console.log(`[klines-warmup] Rate limited at ${done}/${total}, pausing 30s...`)
          await new Promise(r => setTimeout(r, 30000))
          i-- // retry this symbol
          continue
        }

        // Throttle: 150ms between requests (concurrency 1, ~400 req/min safe)
        await new Promise(r => setTimeout(r, 150))

        // Progress every 100 requests
        if (done % 100 === 0) {
          console.log(`[klines-warmup] ${done}/${total} (${cached} from cache)`)
        }
      }
    }
    console.log(`[klines-warmup] Done: ${done}/${total} cached (${cached} already had)`)
  } catch (err) {
    console.log(`[klines-warmup] Failed: ${err.message.slice(0, 100)}`)
  }
}

// Rebuild density cache from currently subscribed symbols (no Binance depth calls)
async function rebuildDensityCache(allSymbols) {
  const marks = await bgetWithRetry('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  const subscribedSyms = allSymbols.filter(s => wsManager.callbacks.has(s))
  const allWalls = []

  for (const sym of subscribedSyms) {
    const price = markMap.get(sym)
    if (!price) continue

    const bidLevelsRaw = stateManager.getTopLevels(sym, 'bid', price, 0, 100, 5.0)
    const askLevelsRaw = stateManager.getTopLevels(sym, 'ask', price, 0, 100, 5.0)

    let klinesStats
    try { klinesStats = await getKlinesWithStats(sym) } catch (_) { continue }
    const avg5mVol = (klinesStats.vol1 + klinesStats.vol2 + klinesStats.vol3 + klinesStats.vol4 + klinesStats.vol5) / 5

    const processSide = (levels, sideKey) => {
      const BIN_SIZE_PCT = 0.1
      const rawBins = binLevels(levels, BIN_SIZE_PCT)
      const validBins = rawBins.filter(b => b.notional >= 0)
      const trackedBins = stateManager.trackAndEnrichBins(sym, sideKey, validBins, price)
      return trackedBins.map(bin => {
        const behavior = analyzeBehavior(bin, price, klinesStats.natr, avg5mVol)
        if (behavior.xMult < 4) return null
        let tte = avg5mVol > 0 ? bin.notional / (avg5mVol / 5) : Infinity
        return {
          symbol: sym, sideKey, price: Math.round(bin.anchorPrice * 10000) / 10000,
          notional: bin.notional, distancePct: Math.round(behavior.distancePct * 100) / 100,
          lifetimeMins: Math.round(behavior.lifetimeMins * 10) / 10,
          score: behavior.trustScore, xMult: Math.round(behavior.xMult * 10) / 10,
          severity: behavior.severity, tags: behavior.tags, levelsCount: bin.levelsCount,
          natr: klinesStats.natr, avg5mVol: Math.round(avg5mVol),
          vol1: klinesStats.vol1, vol2: klinesStats.vol2, vol3: klinesStats.vol3,
          vol4: klinesStats.vol4, vol5: klinesStats.vol5, timeToEatMinutes: tte
        }
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 2)
    }

    allWalls.push(...processSide(bidLevelsRaw, 'bid'), ...processSide(askLevelsRaw, 'ask'))
  }

  allWalls.sort((a, b) => b.score - a.score)
  // Top 3 per symbol
  const perSym = {}
  for (const w of allWalls) {
    if (!perSym[w.symbol]) perSym[w.symbol] = []
    if (perSym[w.symbol].length < 3) perSym[w.symbol].push(w)
  }
  const finalData = Object.values(perSym).flat().sort((a, b) => b.score - a.score)
  const meta = { count: finalData.length, minNotional: 0, depthLimit: 100, concurrency: 0, mmMode: false, windowPct: 5, mmMultiplier: 4 }
  densityCache = { data: finalData, meta, ts: Date.now() }
  saveDensityToDisk(finalData, meta)
}

start()
