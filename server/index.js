const { createLogger } = require('./logger')
const log = createLogger('server')
const fastify = require('fastify')({ logger: false })

// CORS — whitelist known origins only
const ALLOWED_ORIGINS = [
  'https://futures-screener.szhub.space',
  'http://localhost:3200',
  'http://127.0.0.1:3200'
]
const cors = require('@fastify/cors')
fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow same-origin requests (no origin header) and whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true)
    } else {
      cb(null, false)
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
})

// Rate limiting
const rateLimit = require('@fastify/rate-limit')
fastify.register(rateLimit, {
  max: 100,        // 100 requests per minute (global default)
  timeWindow: 60000,
  keyGenerator: (req) => req.ip,
  addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
  addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'retry-after': true }
})

// Centralized Binance REST client (Bottleneck rate limiting)
const { bget, bgetWithRetry, RateLimitError, rateLimiter, BINANCE_FAPI, getStats: getBinanceStats } = require('./binance-client')

// Custom Modules
const wsManager = require('./ws');
const stateManager = require('./state');
const { binLevels } = require('./logic');
const { analyzeBehavior } = require('./scorer');
const densityV2 = require('./densityV2');
const auth = require('./auth');
const signals = require('./signals');
const push = require('./push');
const alertChecker = require('./alerts');
const depthHeatmap = require('./depth-heatmap');
const vpinScanner = require('./vpin');
const fillKill = require('./fill-kill');
const resilience = require('./resilience')
const treemapProvider = require('./treemap');
const klinesCache = require('./klines-cache');

// WS connects lazily on first subscribe() — no eager connect needed

// ---- helpers ----

function toNumber(x) { return Number(x) }

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
    // Returns promise so shutdown can await it
    return require('fs').promises.writeFile(DENSITY_CACHE_FILE, JSON.stringify({ data, meta, ts: Date.now() }))
      .catch(e => log.debug({ err: e.message }, 'Density cache: disk save error'))
  } catch (e) { log.debug({ err: e.message }, 'Density cache: disk save error') }
}
function loadDensityFromDisk() {
  try {
    if (!require('fs').existsSync(DENSITY_CACHE_FILE)) return null
    // Sync read OK here — only called once at startup
    const raw = JSON.parse(require('fs').readFileSync(DENSITY_CACHE_FILE, 'utf8'))
    // Accept disk cache up to 10 minutes old (stale but better than nothing)
    if (raw && raw.data && (Date.now() - raw.ts) < 600000) {
      log.info({ walls: raw.data.length, ageSec: ((Date.now() - raw.ts) / 1000).toFixed(0) }, 'Density cache: loaded from disk')
      return raw
    }
  } catch (e) { log.debug({ err: e.message }, 'Density cache: disk load error') }
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

// Track all intervals for graceful shutdown cleanup
const _intervals = []

// In-memory cache (TTL: 3 seconds)
const cache = new Map()
const CACHE_TTL_MS = 3000
// Cleanup expired cache entries every 10 seconds
_intervals.push(setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > CACHE_TTL_MS) cache.delete(key)
  }
}, 10000))

// --- Level History State ---
const levelHistory = new Map()
// Очистка старых уровней (TTL: 1 минута без обновлений)
_intervals.push(setInterval(() => {
  const now = Date.now()
  for (const [key, val] of levelHistory.entries()) {
    if (now - val.lastUpdate > 60000) {
      levelHistory.delete(key)
    }
  }
}, 30000))

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
    log.error({ err: e.message }, 'Telegram send error')
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

// bget / bgetWithRetry / RateLimitError / rateLimiter — imported from ./binance-client.js

// Resync handler with global queue: max 3 concurrent, debounced, deduped, cooldown
const _resyncPending = new Set()
const _resyncCooldown = new Map() // symbol → timestamp (prevent re-add within 60s)
let _resyncRunning = 0
const RESYNC_MAX_CONCURRENT = 3
const RESYNC_DELAY_MS = 500
const RESYNC_MAX_PENDING = 10      // cap pending to prevent queue explosion after WS reconnect
const RESYNC_COOLDOWN_MS = 60_000  // don't re-add same symbol within 60s

async function processResyncQueue() {
  while (_resyncPending.size > 0 && _resyncRunning < RESYNC_MAX_CONCURRENT) {
    const symbol = _resyncPending.values().next().value
    _resyncPending.delete(symbol)
    _resyncRunning++
    ;(async () => {
      try {
        // Direct fetch (bypasses Bottleneck) — limit=100 (weight=2), WS fills the rest
        const controller = new AbortController()
        const tid = setTimeout(() => controller.abort(), 10_000)
        try {
          const res = await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`, { signal: controller.signal })
          if (!res.ok) throw new Error(`depth ${symbol}: ${res.status}`)
          const ob = await res.json()
          stateManager.initBook(symbol, ob.bids, ob.asks)
          log.info({ symbol, pending: _resyncPending.size }, 'Resync completed')
        } finally {
          clearTimeout(tid)
        }
      } catch (err) {
        log.error({ symbol, err: err.message }, 'Resync failed')
      } finally {
        _resyncRunning--
        if (_resyncPending.size > 0) setTimeout(processResyncQueue, RESYNC_DELAY_MS)
      }
    })()
  }
}

// Cleanup stale cooldowns every 2 min
_intervals.push(setInterval(() => {
  const now = Date.now()
  for (const [sym, ts] of _resyncCooldown) {
    if (now - ts > RESYNC_COOLDOWN_MS) _resyncCooldown.delete(sym)
  }
}, 120_000))

let _resyncDebounce = null
stateManager.setResyncHandler((symbol) => {
  // Cooldown: skip if recently resynced or attempted
  const now = Date.now()
  if (_resyncCooldown.has(symbol) && now - _resyncCooldown.get(symbol) < RESYNC_COOLDOWN_MS) return
  _resyncCooldown.set(symbol, now)

  // Cap pending to prevent queue explosion after mass WS reconnect
  if (_resyncPending.size >= RESYNC_MAX_PENDING) return
  _resyncPending.add(symbol)

  if (!_resyncDebounce) {
    _resyncDebounce = setTimeout(() => {
      _resyncDebounce = null
      log.info({ pending: _resyncPending.size, running: _resyncRunning }, 'Resync queue processing')
      processResyncQueue()
    }, 2000) // 2s debounce — collect gaps after WS reconnect
  }
})

// Klines stats cache (TTL 60s) to avoid hammering Binance
const klinesStatsCache = new Map()
const KLINES_STATS_TTL = 60000

// Periodic cleanup of stale klinesStats entries (every 5min)
_intervals.push(setInterval(() => {
  const now = Date.now()
  let evicted = 0
  for (const [symbol, entry] of klinesStatsCache) {
    if (now - entry.ts > KLINES_STATS_TTL * 5) { // 5x TTL = 5min
      klinesStatsCache.delete(symbol)
      evicted++
    }
  }
  if (evicted > 0) log.debug({ evicted, remaining: klinesStatsCache.size }, 'Klines stats cache cleanup')
}, 5 * 60_000))

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
    // On failure: return stale cache if available (better than dropping symbol)
    const stale = klinesStatsCache.get(symbol)
    if (stale) {
      log.warn({ symbol, err: err.message, staleSec: ((Date.now() - stale.ts) / 1000).toFixed(0) }, 'Klines stats failed, using stale cache')
      return stale.data
    }
    log.warn({ symbol, err: err.message }, 'Klines stats failed, no cache available')
    return null
  }
}

// ---- UI (static files from ../app, cached in memory at startup) ----
const path = require('path')
const fs = require('fs')
const APP_DIR = path.resolve(__dirname, '..', 'app')

// Pre-load static files into memory (hot-reload without PM2 restart via POST /api/reload-static)
const staticCache = new Map()
function getStatic(relPath) {
  if (staticCache.has(relPath)) return staticCache.get(relPath)
  const p = path.join(APP_DIR, relPath)
  const buf = fs.readFileSync(p)
  staticCache.set(relPath, buf)
  return buf
}
function reloadAllStatic() {
  staticCache.clear()
  for (const f of STATIC_FILES) {
    try { getStatic(f) } catch (e) { log.warn({ file: f, err: e.message }, 'Static: reload failed') }
  }
  log.info({ count: STATIC_FILES.length }, 'Static: hot-reloaded')
}

// Pre-warm all static files at module load
const STATIC_FILES = [
  'index.html', 'app.js', 'densities.js', 'mini-charts.js', 'auth.js',
  'drawing-manager.js', 'signals.js', 'settings.js', 'alerts.js', 'gapless-scale.js', 'depth-heatmap-ui.js', 'treemap.js',
  'styles.css', 'manifest.json', 'sw.js', 'icon-192.svg', 'icon-512.svg'
]
for (const f of STATIC_FILES) {
  try { getStatic(f) } catch (e) { log.warn({ file: f, err: e.message }, 'Static: failed to pre-load') }
}

// Also cache the UMD library
const LWC_DRAWING_PATH = path.resolve(__dirname, '..', 'node_modules', 'lightweight-charts-drawing', 'dist', 'lightweight-charts-drawing.umd.js')
let lwcDrawingBuf
try { lwcDrawingBuf = fs.readFileSync(LWC_DRAWING_PATH) } catch (e) { log.warn('Static: lightweight-charts-drawing UMD not found') }

// Cache headers: HTML = must-revalidate (cache-buster URLs update), assets = 1 day (have ?v= buster)
const ASSET_CACHE = 'public, max-age=86400' // 1 day
const HTML_CACHE = 'no-cache'               // always revalidate

fastify.get('/', async (req, reply) => {
  reply.header('Cache-Control', HTML_CACHE).type('text/html; charset=utf-8').send(getStatic('index.html'))
})

fastify.get('/app.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('app.js'))
})

fastify.get('/densities.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('densities.js'))
})

fastify.get('/mini-charts.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('mini-charts.js'))
})

fastify.get('/auth.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('auth.js'))
})

fastify.get('/drawing-manager.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('drawing-manager.js'))
})
fastify.get('/signals.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('signals.js'))
})
fastify.get('/settings.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('settings.js'))
})
fastify.get('/alerts.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('alerts.js'))
})
fastify.get('/gapless-scale.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('gapless-scale.js'))
})
fastify.get('/depth-heatmap-ui.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('depth-heatmap-ui.js'))
})
fastify.get('/treemap.js', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(getStatic('treemap.js'))
})

fastify.get('/styles.css', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('text/css; charset=utf-8').send(getStatic('styles.css'))
})

fastify.get('/lightweight-charts-drawing.umd.js', async (req, reply) => {
  if (!lwcDrawingBuf) return reply.code(404).send('Not found')
  reply.header('Cache-Control', ASSET_CACHE).type('application/javascript; charset=utf-8').send(lwcDrawingBuf)
})

fastify.get('/favicon.ico', async (req, reply) => {
  reply.code(204).send()
})

fastify.get('/manifest.json', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('application/manifest+json; charset=utf-8').send(getStatic('manifest.json'))
})

fastify.get('/sw.js', async (req, reply) => {
  reply.header('Cache-Control', 'no-cache').type('application/javascript; charset=utf-8').header('Service-Worker-Allowed', '/').send(getStatic('sw.js'))
})

fastify.get('/icon-192.svg', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('image/svg+xml').send(getStatic('icon-192.svg'))
})

fastify.get('/icon-512.svg', async (req, reply) => {
  reply.header('Cache-Control', ASSET_CACHE).type('image/svg+xml').send(getStatic('icon-512.svg'))
})

// ---- Auth routes ----

// Attach user to every request (non-blocking)
fastify.addHook('onRequest', async (req) => {
  auth.authHook(req)
})

fastify.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: 60000 } } }, async (req, reply) => {
  const { email, password, name } = req.body || {}
  const result = auth.register(email, password, name)
  if (result.error) return reply.code(400).send(result)
  return result
})

fastify.post('/api/auth/login', { config: { rateLimit: { max: 15, timeWindow: 60000 } } }, async (req, reply) => {
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

fastify.patch('/api/alerts/:id', async (req, reply) => {
  if (!auth.requireAuth(req, reply)) return
  const { enabled, condition, cooldown_sec } = req.body || {}
  const id = Number(req.params.id)
  if (enabled !== undefined) {
    auth.stmts.toggleAlert.run(enabled ? 1 : 0, id, req.user.id)
  }
  if (condition !== undefined || cooldown_sec !== undefined) {
    const existing = auth.getUserAlerts(req.user.id).find(a => a.id === id)
    if (existing) {
      auth.stmts.updateAlert.run(
        JSON.stringify(condition !== undefined ? condition : existing.condition),
        enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        cooldown_sec !== undefined ? cooldown_sec : existing.cooldown_sec,
        id, req.user.id
      )
    }
  }
  return { success: true }
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

// Alert condition types (for frontend builder)
fastify.get('/api/alerts/types', async () => {
  return { success: true, types: alertChecker.CONDITION_TYPES }
})

// Depth Heatmap (Bookmap-style)
fastify.get('/api/depth-heatmap', async (req) => {
  const { symbol } = req.query
  if (!symbol) return { success: false, error: 'symbol required' }
  depthHeatmap.track(symbol)
  const data = depthHeatmap.getData(symbol)
  if (!data || !data.count) return { success: true, data: { symbol, snapshots: [], count: 0, message: 'Collecting data, retry in 10s' } }
  return { success: true, data }
})

fastify.get('/api/depth-heatmap/stats', async () => {
  return { success: true, data: depthHeatmap.getStats() }
})

// VPIN — Volume-Synchronized Probability of Informed Trading
fastify.get('/api/vpin', async (req) => {
  const { symbol } = req.query
  if (symbol) {
    const data = await vpinScanner.getVPIN(symbol)
    return { success: true, data: data || { symbol, vpin: null, message: 'No data yet' } }
  }
  return { success: true, data: vpinScanner.getAll() }
})

fastify.get('/api/vpin/stats', async () => {
  return { success: true, data: vpinScanner.getStats() }
})

// Fill:Kill Ratio — Wall Authenticity / Spoof Detection
fastify.get('/api/fill-kill', async (req) => {
  const { symbol } = req.query
  if (symbol) {
    const data = fillKill.getData(symbol)
    return { success: true, data: data || { symbol, fillKillRatio: null, message: 'No data yet' } }
  }
  return { success: true, data: fillKill.getAll() }
})

fastify.get('/api/fill-kill/stats', async () => {
  return { success: true, data: fillKill.getStats() }
})

// Market Resilience — Book Recovery Speed
fastify.get('/api/resilience', async (req) => {
  const { symbol } = req.query
  if (symbol) {
    const data = resilience.getData(symbol)
    return { success: true, data: data || { symbol, stability: null, message: 'No data yet' } }
  }
  return { success: true, data: resilience.getAll() }
})

fastify.get('/api/resilience/stats', async () => {
  return { success: true, data: resilience.getStats() }
})

// RSI/Momentum Treemap
fastify.get('/api/treemap', async () => {
  const data = await treemapProvider.getData()
  return { success: true, data }
})

fastify.get('/api/treemap/stats', async () => {
  return { success: true, data: treemapProvider.getStats() }
})

// Signal stats (public)
fastify.get('/api/signals/stats', async () => {
  return { success: true, stats: auth.getSignalStats(), recent: auth.getRecentSignals(20) }
})

// Live signals (in-memory, real-time)
fastify.get('/api/signals/live', async (req) => {
  const { type, symbol, direction, minConfidence, limit, hours } = req.query
  const data = signals.getLiveSignals({ type, symbol, direction, minConfidence, limit, hours })
  return { success: true, count: data.length, data }
})

// Signal summary (counts, types)
fastify.get('/api/signals/summary', async () => {
  return { success: true, ...signals.getSignalSummary() }
})

// Outcome stats (WIN/LOSS by type)
fastify.get('/api/signals/outcomes', async () => {
  return { success: true, stats: signals.getOutcomeStats() }
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

fastify.get('/depth/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').toUpperCase()
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    reply.code(400)
    return { error: 'Invalid symbol format' }
  }
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 5), 1000)
  // Direct fetch — bypasses Bottleneck for user requests
  const _depthCtrl = new AbortController()
  const _depthTid = setTimeout(() => _depthCtrl.abort(), 10_000)
  let ob
  try {
    const _depthRes = await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`, { signal: _depthCtrl.signal })
    if (!_depthRes.ok) throw new Error(`depth: ${_depthRes.status}`)
    ob = await _depthRes.json()
  } finally { clearTimeout(_depthTid) }
  return { symbol, lastUpdateId: ob.lastUpdateId, bids: ob.bids, asks: ob.asks }
})

// NEW: simple flat output for UI (scoring, sorting, cache)
fastify.get('/densities/simple', async (req, reply) => {
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
    reply.code(503).header('Retry-After', '30')
    return { count: 0, data: [], cached: false, message: 'Warming up, try again in 30s' }
  }

  // Optional limit (0 = no limit, scan all)
  const limitSymbols = Number(req.query.limitSymbols || 0)
  if (limitSymbols > 0 && symbols.length > limitSymbols) {
    symbols = symbols.slice(0, limitSymbols)
  }

  // Direct fetch — bypasses Bottleneck for user-facing requests
  let marks
  const _premCached = getProxyCached('premiumIndex', 30000)
  if (_premCached) {
    marks = _premCached
  } else {
    const _pCtrl = new AbortController()
    const _pTid = setTimeout(() => _pCtrl.abort(), 10_000)
    try {
      const _pRes = await fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex`, { signal: _pCtrl.signal })
      if (!_pRes.ok) throw new Error(`premiumIndex: ${_pRes.status}`)
      marks = await _pRes.json()
      setProxyCached('premiumIndex', marks)
    } finally { clearTimeout(_pTid) }
  }
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
      // Prevent concurrent subscribe for the same symbol
      if (_subscribingSymbols.has(sym)) return [];
      _subscribingSymbols.add(sym);
      const _dsCtrl = new AbortController()
      const _dsTid = setTimeout(() => _dsCtrl.abort(), 10_000)
      try {
        const _dsRes = await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=1000`, { signal: _dsCtrl.signal })
        if (!_dsRes.ok) throw new Error(`depth ${sym}: ${_dsRes.status}`)
        const ob = await _dsRes.json()
        stateManager.initBook(sym, ob.bids, ob.asks);
        wsManager.subscribe(sym, (payload) => { stateManager.processDelta(sym, payload); });
      } catch (err) {
        log.debug({ symbol: sym, err: err.message.slice(0, 80) }, 'Density: skip symbol');
        return [];
      } finally {
        clearTimeout(_dsTid)
        _subscribingSymbols.delete(sym);
      }
    }

    // 2. Get local state from memory (from WS deltas)
    const bidLevelsRaw = stateManager.getTopLevels(sym, 'bid', price, minNotional, depthLimit, windowPct);
    const askLevelsRaw = stateManager.getTopLevels(sym, 'ask', price, minNotional, depthLimit, windowPct);

    // Получить K-lines для объёмов и ATR
    const klinesStats = await getKlinesWithStats(sym)
    if (!klinesStats) return [] // skip symbol if klines unavailable

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

// Guard: prevent concurrent on-demand subscriptions for the same symbol
const _subscribingSymbols = new Set()

// ---- Density V2: Statistical Walls + Imbalance ----
const densityV2PersistenceMap = new Map()
let densityV2Cache = { data: null, ts: 0 }
const DENSITY_V2_CACHE_TTL = 15000 // 15 seconds

// Persistence map disk save/load (survive PM2 restarts)
const PERSISTENCE_MAP_FILE = require('path').join(__dirname, '..', 'data', 'density-persistence.json')

function savePersistenceMapToDisk() {
  try {
    const dir = require('path').dirname(PERSISTENCE_MAP_FILE)
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true })
    // Snapshot the map synchronously to avoid mutation during async write
    const snapshot = JSON.stringify({ map: Object.fromEntries(densityV2PersistenceMap), ts: Date.now() })
    return require('fs').promises.writeFile(PERSISTENCE_MAP_FILE, snapshot)
      .catch(e => log.debug({ err: e.message }, 'Persistence map: disk save error'))
  } catch (e) { log.debug({ err: e.message }, 'Persistence map: disk save error') }
}

function loadPersistenceMapFromDisk() {
  try {
    if (!require('fs').existsSync(PERSISTENCE_MAP_FILE)) return
    const raw = JSON.parse(require('fs').readFileSync(PERSISTENCE_MAP_FILE, 'utf8'))
    // Accept up to 30 minutes old (walls older than that are stale anyway)
    if (!raw || !raw.map || (Date.now() - raw.ts) > 1800000) return
    const now = Date.now()
    let loaded = 0
    for (const [key, val] of Object.entries(raw.map)) {
      // Skip entries not seen in last 5 min (same as cleanupPersistence)
      if (val.lastSeen && (now - val.lastSeen) > 300000) continue
      densityV2PersistenceMap.set(key, val)
      loaded++
    }
    if (loaded > 0) log.info({ loaded, ageSec: ((Date.now() - raw.ts) / 1000).toFixed(0) }, 'Persistence map: loaded from disk')
  } catch (e) { log.debug({ err: e.message }, 'Persistence map: disk load error') }
}

// Load on startup
loadPersistenceMapFromDisk()

// Save every 30s (lightweight — typically a few hundred entries)
_intervals.push(setInterval(savePersistenceMapToDisk, 30000))

// Cleanup persistence every 60s
_intervals.push(setInterval(() => densityV2.cleanupPersistence(densityV2PersistenceMap), 60000))

fastify.get('/densities/v2', async (req) => {
  const windowPct = Number(req.query.windowPct || 2)
  const nSigma = Number(req.query.nSigma || 2)
  const minVolume24h = Number(req.query.minVolume24h || 50000000) // $50M default
  const minImbalance = Number(req.query.minImbalance || 0) // 0 = show all
  const isSpecific = !!req.query.symbols
  const forceRefresh = req.query.force === 'true'

  // Return cached data if fresh enough (full scan only)
  if (!isSpecific && !forceRefresh && densityV2Cache.data && (Date.now() - densityV2Cache.ts) < DENSITY_V2_CACHE_TTL) {
    let filtered = [...densityV2Cache.data]
    if (minImbalance > 0) filtered = filtered.filter(d => Math.abs(d.imbalance) >= minImbalance)
    return { count: filtered.length, data: filtered, cached: true, cacheAgeSec: Math.round((Date.now() - densityV2Cache.ts) / 1000) }
  }

  // Get 24h ticker for volume filter (direct fetch, weight=40 exceeds Bottleneck)
  let ticker24h
  try {
    ticker24h = await fetchTicker24hr()
  } catch (err) {
    return { count: 0, data: [], error: 'Ticker data temporarily unavailable' }
  }
  const volumeMap = new Map(ticker24h.map(t => [t.symbol, Number(t.quoteVolume)]))

  // Get mark prices (direct fetch — bypasses congested Bottleneck queue)
  let marks
  const premiumCached = getProxyCached('premiumIndex', 30000)
  if (premiumCached) {
    marks = premiumCached
  } else {
    const _ctrl = new AbortController()
    const _tid = setTimeout(() => _ctrl.abort(), 10_000)
    try {
      const _res = await fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex`, { signal: _ctrl.signal })
      if (!_res.ok) throw new Error(`premiumIndex: ${_res.status}`)
      marks = await _res.json()
      setProxyCached('premiumIndex', marks)
    } finally { clearTimeout(_tid) }
  }
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  // Determine symbols to analyze
  let symbols
  if (isSpecific) {
    symbols = String(req.query.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  } else {
    // All subscribed symbols filtered by volume
    symbols = [...wsManager.callbacks.keys()].filter(sym => {
      const vol = volumeMap.get(sym) || 0
      return vol >= minVolume24h && markMap.has(sym)
    })
  }

  const results = []

  for (const sym of symbols) {
    const price = markMap.get(sym)
    if (!price) continue

    // If not yet WS-subscribed and specific symbol requested: fetch depth on demand
    if (!wsManager.callbacks.has(sym)) {
      if (!isSpecific) continue // Full scan: skip unsubscribed
      if (_subscribingSymbols.has(sym)) continue
      _subscribingSymbols.add(sym)
      const _dCtrl = new AbortController()
      const _dTid = setTimeout(() => _dCtrl.abort(), 10_000)
      try {
        const _dRes = await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=1000`, { signal: _dCtrl.signal })
        if (!_dRes.ok) throw new Error(`depth ${sym}: ${_dRes.status}`)
        const ob = await _dRes.json()
        stateManager.initBook(sym, ob.bids, ob.asks)
        wsManager.subscribe(sym, (payload) => { stateManager.processDelta(sym, payload) })
      } catch (err) {
        continue
      } finally {
        clearTimeout(_dTid)
        _subscribingSymbols.delete(sym)
      }
    }

    // Get raw levels from WS state (wider window for analysis, windowPct for filtering)
    const bidLevels = stateManager.getTopLevels(sym, 'bid', price, 0, 500, windowPct + 1)
    const askLevels = stateManager.getTopLevels(sym, 'ask', price, 0, 500, windowPct + 1)

    if (bidLevels.length < 3 && askLevels.length < 3) continue // not enough data

    try {
      const analysis = densityV2.analyzeSymbol({
        symbol: sym,
        markPrice: price,
        bidLevels,
        askLevels,
        persistenceMap: densityV2PersistenceMap,
        windowPct,
        nSigma
      })

      // Only include if has at least one wall
      if (analysis.wallCount > 0) {
        // Add volume info
        analysis.volume24h = volumeMap.get(sym) || 0

        // Calculate erosion time for each wall (avg 5m volume from last 14 candles)
        let avgVol5m = 0
        try {
          const candles5m = klinesCache.getCandles(sym, '5m', 14)
          if (candles5m && candles5m.length >= 3) {
            avgVol5m = candles5m.reduce((sum, c) => sum + c.volume, 0) / candles5m.length
          }
        } catch (_) {}

        const addErosion = (wall) => {
          if (!wall) return wall
          wall.erosionMins = avgVol5m > 0
            ? Math.round(wall.notional * 5 / avgVol5m * 10) / 10
            : null
          return wall
        }

        addErosion(analysis.support)
        addErosion(analysis.resistance)
        if (analysis.bidWalls) analysis.bidWalls.forEach(addErosion)
        if (analysis.askWalls) analysis.askWalls.forEach(addErosion)

        results.push(analysis)
      }
    } catch (err) {
      // Skip problematic symbols silently
      continue
    }
  }

  // Sort by strongest wall score (support or resistance, whichever is bigger)
  results.sort((a, b) => {
    const scoreA = Math.max(a.support?.score || 0, a.resistance?.score || 0)
    const scoreB = Math.max(b.support?.score || 0, b.resistance?.score || 0)
    return scoreB - scoreA
  })

  // Cache for full scans
  if (!isSpecific) {
    densityV2Cache = { data: results, ts: Date.now() }
  }

  let finalData = results
  if (minImbalance > 0) finalData = finalData.filter(d => Math.abs(d.imbalance) >= minImbalance)

  return { count: finalData.length, data: finalData, cached: false }
})

// Cache stats endpoint
fastify.get('/_cache/stats', async () => ({
  size: cache.size,
  keys: [...cache.keys()]
}))

// ---- Binance Proxy for Mini-Charts (cached) ----
const proxyCache = new Map()
const PROXY_MAX_TTL_MS = 600000 // 10 min max TTL for cleanup (NATR read TTL is 600s, must survive refresh gaps)
const PROXY_CACHE_MAX_ENTRIES = 5000
// Cleanup expired proxy cache entries every 30 seconds
_intervals.push(setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of proxyCache.entries()) {
    if (now - entry.ts > PROXY_MAX_TTL_MS) proxyCache.delete(key)
  }
  // Hard cap: drop oldest if still over limit
  if (proxyCache.size > PROXY_CACHE_MAX_ENTRIES) {
    const sorted = [...proxyCache.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const toRemove = sorted.slice(0, proxyCache.size - PROXY_CACHE_MAX_ENTRIES)
    for (const [key] of toRemove) proxyCache.delete(key)
  }
}, 30000))

function getProxyCached(key, ttlMs) {
  const entry = proxyCache.get(key)
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data
  return null
}

function setProxyCached(key, data) {
  proxyCache.set(key, { data, ts: Date.now() })
}

// Shared ticker24hr fetcher — direct fetch (bypasses Bottleneck).
// Weight=40 would block Bottleneck queue and cause AbortController timeouts.
async function fetchTicker24hr() {
  const cached = getProxyCached('ticker24hr', 60000)
  if (cached) return cached
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`, { signal: controller.signal })
    if (!res.ok) throw new Error(`ticker24hr: ${res.status}`)
    const data = await res.json()
    setProxyCached('ticker24hr', data)
    return data
  } finally {
    clearTimeout(timeoutId)
  }
}

// 24hr ticker — cached 60s (all pairs, heavy endpoint)
// NOTE: ticker/24hr (all symbols) has Binance weight=40, which exceeds Bottleneck
// maxConcurrent=10. Direct fetch bypasses this limitation. Safe because it's called
// at most once per 60s (cached).
fastify.get('/api/ticker24hr', async () => {
  try {
    return await fetchTicker24hr()
  } catch (e) {
    log.warn({ err: e.message }, 'ticker24hr fetch failed, trying stale cache')
    const stale = getProxyCached('ticker24hr', 600000)
    if (stale) return stale
    return []
  }
})

// Klines — SQLite cache first, Binance fallback
const VALID_INTERVALS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']

fastify.get('/api/klines', async (req, reply) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  const interval = String(req.query.interval || '15m')
  const limit = Math.min(Number(req.query.limit || 200), 1500)
  const endTime = req.query.endTime ? Number(req.query.endTime) : null
  const startTime = req.query.startTime ? Number(req.query.startTime) : null
  if (!symbol || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
    reply.code(400)
    return { error: 'Invalid or missing symbol' }
  }
  if (!VALID_INTERVALS.includes(interval)) {
    reply.code(400)
    return { error: 'Invalid interval' }
  }

  // Delta request: return only candles after startTime (for client cache sync)
  if (startTime) {
    const delta = klinesCache.getCandlesAfter(symbol, interval, Math.floor(startTime / 1000))
    if (delta.length > 0) return { cached: true, data: delta }
    // Fallback: direct fetch from Binance (bypasses Bottleneck for user requests)
    const controller1 = new AbortController()
    const tid1 = setTimeout(() => controller1.abort(), 15_000)
    try {
      const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}&startTime=${startTime}`, { signal: controller1.signal })
      if (res.ok) { const data = await res.json(); if (Array.isArray(data)) klinesCache.storeCandles(symbol, interval, data); return data }
    } finally { clearTimeout(tid1) }
    return []
  }

  // Historical pagination (endTime) — check SQLite first
  if (endTime) {
    const beforeSec = Math.floor(endTime / 1000)
    const cached = klinesCache.getCandlesBefore(symbol, interval, beforeSec, limit)
    if (cached.length >= limit * 0.8) {
      return cached.map(c => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)])
    }
    const key = `klines:${symbol}:${interval}:${limit}:end${endTime}`
    const proxyCached = getProxyCached(key, 300000)
    if (proxyCached) return proxyCached
    // Direct fetch (bypasses Bottleneck)
    const controller2 = new AbortController()
    const tid2 = setTimeout(() => controller2.abort(), 15_000)
    try {
      const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}&endTime=${endTime}`, { signal: controller2.signal })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) { setProxyCached(key, data); klinesCache.storeCandles(symbol, interval, data) }
        return data
      }
    } finally { clearTimeout(tid2) }
    return []
  }

  // Latest candles — try SQLite cache (fresh or stale with background refresh)
  const cachedCount = klinesCache.getCount(symbol, interval)
  if (cachedCount >= limit) {
    const latestTime = klinesCache.getLatestTime(symbol, interval)
    const age = Date.now() / 1000 - (latestTime || 0)
    if (age < 300) {
      const rows = klinesCache.getCandles(symbol, interval, limit)
      const result = rows.map(c => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)])
      // Stale cache (>60s) — return immediately but trigger background refresh
      if (age >= 60) {
        bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=3`)
          .then(data => { if (Array.isArray(data)) klinesCache.storeCandles(symbol, interval, data) })
          .catch(() => {})
      }
      return result
    }
  }

  // Cache stale or miss — direct fetch from Binance (bypasses Bottleneck for user requests)
  const key = `klines:${symbol}:${interval}:${limit}`
  const proxyCached = getProxyCached(key, 10000)
  if (proxyCached) return proxyCached
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), 15_000)
    let data
    try {
      const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, { signal: controller.signal })
      if (res.ok) data = await res.json()
    } finally { clearTimeout(tid) }
    if (Array.isArray(data)) {
      setProxyCached(key, data)
      klinesCache.storeCandles(symbol, interval, data)
    }
    return data
  } catch (e) {
    // Rate limited — return whatever SQLite has
    const rows = klinesCache.getCandles(symbol, interval, limit)
    if (rows.length) return rows.map(c => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)])
    return []
  }
})

// Test signal — inject a fake signal for notification testing (auto-expires in 60s)
// ---- Web Push API ----

// Get VAPID public key (client needs this to subscribe)
fastify.get('/api/push/vapid-key', async () => {
  const key = push.getVapidPublicKey()
  if (!key) return { success: false, error: 'Push not configured' }
  return { success: true, key }
})

// Subscribe to push notifications
fastify.post('/api/push/subscribe', async (req) => {
  const { subscription, filters } = req.body || {}
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { success: false, error: 'Invalid subscription' }
  }
  auth.stmts.upsertPushSub.run(
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    JSON.stringify(filters || {})
  )
  // Link subscription to authenticated user (for per-user alert push)
  if (req.user) {
    try { auth.stmts.linkPushSubToUser.run(req.user.id, subscription.endpoint) } catch {}
  }
  const count = auth.stmts.countPushSubs.get()?.count || 0
  log.info({ total: count, userId: req.user?.id }, 'Push: new subscription registered')
  return { success: true, total: count }
})

// Unsubscribe from push notifications
fastify.post('/api/push/unsubscribe', async (req) => {
  const { endpoint } = req.body || {}
  if (!endpoint) return { success: false, error: 'Missing endpoint' }
  auth.stmts.deletePushSub.run(endpoint)
  return { success: true }
})

// ---- Test Signal ----
fastify.get('/api/signals/test', async (req, reply) => {
  // Require authenticated user to prevent public abuse
  if (!req.user) return reply.code(401).send({ error: 'Auth required' })
  const sig = {
    id: `test-${Date.now()}`,
    type: 'volume_spike',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    price: 94500,
    confidence: 85,
    description: 'Test signal — Volume 5.2x above SMA20 average',
    metadata: { ratio: 5.2, currentVol: 12000000, avgVol: 2300000 },
    created_at: new Date().toISOString(),
  }
  // Remove any old test signals first (splice to keep array reference — don't reassign!)
  for (let i = signals.liveSignals.length - 1; i >= 0; i--) {
    if (String(signals.liveSignals[i].id).startsWith('test-')) signals.liveSignals.splice(i, 1)
  }
  signals.liveSignals.unshift(sig)
  // Auto-remove after 60s (splice to keep reference)
  setTimeout(() => {
    const idx = signals.liveSignals.indexOf(sig)
    if (idx >= 0) signals.liveSignals.splice(idx, 1)
  }, 60_000)
  // Test signals do NOT trigger push — only real signals do
  return { success: true, signal: sig, pushEnabled: push.isEnabled() }
})

// OI history — proxied from Binance /futures/data/openInterestHist
fastify.get('/api/oi-history', async (req, reply) => {
  const symbol = String(req.query.symbol || '').toUpperCase()
  const period = String(req.query.period || '5m')
  const limit = Math.min(Number(req.query.limit || 500), 500)
  if (!symbol) return { error: 'symbol required' }

  const key = `oiHist:${symbol}:${period}:${limit}`
  const cached = getProxyCached(key, 60000) // cache 1 min
  if (cached) return cached

  // Direct fetch — bypasses congested Bottleneck queue for user requests
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`, { signal: controller.signal })
    if (!res.ok) throw new Error(`OI history: ${res.status}`)
    const data = await res.json()
    setProxyCached(key, data)
    return data
  } catch (e) {
    reply.code(503)
    return { error: 'Failed to fetch OI history', message: e.message }
  } finally {
    clearTimeout(tid)
  }
})

// Batch klines — SQLite cache first, Binance fallback
fastify.post('/api/klines-batch', async (req, reply) => {
  const symbols = req.body?.symbols
  const interval = String(req.body?.interval || '15m')
  const limit = Math.min(Number(req.body?.limit || 200), 1500)
  if (!Array.isArray(symbols) || symbols.length === 0) {
    reply.code(400)
    return { error: 'symbols[] required' }
  }
  if (!VALID_INTERVALS.includes(interval)) {
    reply.code(400)
    return { error: 'Invalid interval' }
  }

  const syms = symbols.slice(0, 30)
    .map(s => String(s).toUpperCase())
    .filter(s => /^[A-Z0-9]{2,20}$/.test(s))
  const result = {}
  const needFetch = []

  // Try SQLite cache first for each symbol (fresh <60s instant, stale <300s with bg refresh)
  const nowSec = Math.floor(Date.now() / 1000)
  const bgRefresh = [] // symbols with stale cache — refresh in background
  for (const symbol of syms) {
    const cachedCount = klinesCache.getCount(symbol, interval)
    if (cachedCount >= limit) {
      const latestTime = klinesCache.getLatestTime(symbol, interval)
      const age = latestTime ? nowSec - latestTime : Infinity
      if (age <= 300) {
        const rows = klinesCache.getCandles(symbol, interval, limit)
        result[symbol] = rows.map(c => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)])
        if (age > 60) bgRefresh.push(symbol) // schedule background update
      } else {
        needFetch.push(symbol) // too stale (>5min) — must refetch
      }
    } else {
      needFetch.push(symbol)
    }
  }
  // Background refresh for stale-but-usable cache (non-blocking)
  if (bgRefresh.length > 0) {
    Promise.allSettled(bgRefresh.map(symbol =>
      bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=3`)
        .then(data => { if (Array.isArray(data)) klinesCache.storeCandles(symbol, interval, data) })
    )).catch(() => {})
  }

  // Fetch uncached from Binance in parallel (direct fetch — bypasses Bottleneck
  // so user requests aren't blocked by warmup/scanner queue)
  if (needFetch.length > 0) {
    const promises = needFetch.map(async (symbol) => {
      try {
        const key = `klines:${symbol}:${interval}:${limit}`
        let data = getProxyCached(key, 10000)
        if (!data) {
          const controller = new AbortController()
          const tid = setTimeout(() => controller.abort(), 15_000)
          try {
            const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, { signal: controller.signal })
            if (res.ok) data = await res.json()
          } finally { clearTimeout(tid) }
          if (data) {
            setProxyCached(key, data)
            klinesCache.storeCandles(symbol, interval, data)
          }
        }
        if (Array.isArray(data)) result[symbol] = data
      } catch(e) { /* skip */ }
    })
    await Promise.all(promises).catch(e => log.error({ err: e.message }, 'Klines batch error'))
  }

  return result
})

// NATR(14) for all USDT pairs — cached 5min
fastify.get('/api/natr', async (req, reply) => {
  const interval = String(req.query.interval || '15m')
  const cached = getProxyCached(`natr:${interval}`, 300000) // 5 min cache
  if (cached) return cached

  // If rate limited, return stale cache (up to 30min) or empty
  if (rateLimiter.pauseUntil > Date.now()) {
    const stale = getProxyCached(`natr:${interval}`, 1800000)
    return stale || {}
  }

  // Get all USDT pairs from ticker
  let ticker
  try {
    ticker = await fetchTicker24hr()
  } catch (e) {
    const stale = getProxyCached(`natr:${interval}`, 1800000)
    return stale || {}
  }

  const usdtPairs = ticker
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => parseFloat(t.quoteVolume) > 10000000) // >$10M vol only
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 200) // top 200 by volume

  // Fetch klines: SQLite first, then direct fetch (bypasses Bottleneck) for uncached
  const result = {}
  const needFetch = []

  // 1. Try SQLite cache for all symbols (instant, no API calls)
  for (const t of usdtPairs) {
    try {
      const rows = klinesCache ? klinesCache.getCandles(t.symbol, interval, 50) : []
      if (rows && rows.length >= 15) {
        const candles = rows.map(r => ({ high: r.high, low: r.low, close: r.close }))
        let trSum = 0
        for (let j = candles.length - 14; j < candles.length; j++) {
          const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close
          trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
        }
        const atr = trSum / 14
        const lastClose = candles[candles.length - 1].close
        if (lastClose > 0) result[t.symbol] = parseFloat(((atr / lastClose) * 100).toFixed(2))
        continue
      }
    } catch (_) {}
    needFetch.push(t)
  }

  // 2. Direct fetch for uncached (no Bottleneck — avoids 50ms×N throttle)
  if (needFetch.length > 0) {
    const batchSize = 20
    for (let i = 0; i < needFetch.length; i += batchSize) {
      const batch = needFetch.slice(i, i + batchSize)
      await Promise.all(batch.map(async (t) => {
        try {
          const controller = new AbortController()
          const tid = setTimeout(() => controller.abort(), 10_000)
          try {
            const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${t.symbol}&interval=${interval}&limit=50`, { signal: controller.signal })
            if (!res.ok) return
            const klines = await res.json()
            if (!Array.isArray(klines) || klines.length < 15) return
            // Store in SQLite for next time
            if (klinesCache) try { klinesCache.storeCandles(t.symbol, interval, klines) } catch (_) {}
            const candles = klines.map(k => ({ high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }))
            let trSum = 0
            for (let j = candles.length - 14; j < candles.length; j++) {
              const h = candles[j].high, l = candles[j].low, pc = candles[j - 1].close
              trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
            }
            const atr = trSum / 14
            const lastClose = candles[candles.length - 1].close
            if (lastClose > 0) result[t.symbol] = parseFloat(((atr / lastClose) * 100).toFixed(2))
          } finally { clearTimeout(tid) }
        } catch (_) {}
      })).catch(() => {})
      if (i + batchSize < needFetch.length) await new Promise(r => setTimeout(r, 100))
    }
  }

  setProxyCached(`natr:${interval}`, result)
  return result
})

// Klines cache stats
fastify.get('/api/klines-cache/stats', async () => {
  try { return klinesCache.getStats() } catch(e) { return { error: e.message } }
})

// Background klines updater — refreshes cached symbols every 30s
let _klinesUpdaterInterval = null
function startKlinesUpdater() {
  const UPDATE_INTERVAL = 30000 // 30s
  const BATCH_SIZE = 10         // symbols per batch
  const BATCH_DELAY = 2000      // 2s between batches (rate-limit safe)

  _klinesUpdaterInterval = setInterval(async () => {
    try {
      // Get the current TF from most common cached interval
      const intervals = ['1m', '5m', '15m', '1h', '4h'] // all used TFs
      for (const interval of intervals) {
        const symbols = klinesCache.getCachedSymbols(interval)
        if (symbols.length === 0) continue

        // Process in batches
        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
          const batch = symbols.slice(i, i + BATCH_SIZE)
          const promises = batch.map(async (symbol) => {
            try {
              // Fetch only last 3 candles (latest + 2 for safety)
              const data = await bgetWithRetry(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=3`)
              if (Array.isArray(data) && data.length > 0) {
                klinesCache.storeCandles(symbol, interval, data)
              }
            } catch(e) { /* skip individual failures */ }
          })
          await Promise.all(promises)
          if (i + BATCH_SIZE < symbols.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY))
          }
        }
      }
    } catch(e) {
      log.error({ err: e.message }, 'KlinesUpdater error')
    }
  }, UPDATE_INTERVAL)
  log.info('KlinesUpdater started (30s interval)')
}

// ---- rate limiter status + reset endpoint ----
fastify.post('/api/rate-limiter/reset', async () => {
  rateLimiter.pauseUntil = 0
  rateLimiter.usedWeight = 0
  savePauseToDisk(0)
  log.info('Rate limiter: manual reset via API')
  return { success: true, status: 'OK' }
})

// Log level management — runtime control without restart
const { setLevel, getLevels } = require('./logger')
fastify.get('/api/log-levels', async () => ({ success: true, levels: getLevels() }))
fastify.post('/api/log-levels', async (req) => {
  const { module, level } = req.body || {}
  if (!module || !level) return { success: false, error: 'module and level required' }
  const result = setLevel(module, level)
  log.info({ module, level }, 'Log level changed via API')
  return { success: true, ...result }
})

// Binance rate limiter stats — monitor weight usage and Bottleneck queue
fastify.get('/api/rate-limit', async () => ({ success: true, ...(await getBinanceStats()) }))

// Hot-reload static files from disk (no PM2 restart needed → no Binance ban)
fastify.post('/api/reload-static', async () => {
  reloadAllStatic()
  return { success: true, files: STATIC_FILES.length }
})
fastify.get('/api/rate-limiter', async () => ({
  usedWeight: rateLimiter.usedWeight,
  weightUpdatedAt: rateLimiter.weightUpdatedAt,
  weightAge: Date.now() - rateLimiter.weightUpdatedAt,
  pauseUntil: rateLimiter.pauseUntil,
  pauseRemaining: Math.max(0, rateLimiter.pauseUntil - Date.now()),
  softLimit: rateLimiter.WEIGHT_SOFT_LIMIT,
  hardLimit: rateLimiter.WEIGHT_HARD_LIMIT,
  binanceLimit: 2400,
  status: rateLimiter.pauseUntil > Date.now() ? 'PAUSED'
    : rateLimiter.usedWeight >= rateLimiter.WEIGHT_HARD_LIMIT ? 'HARD_THROTTLE'
    : rateLimiter.usedWeight >= rateLimiter.WEIGHT_SOFT_LIMIT ? 'SOFT_THROTTLE'
    : 'OK'
}))

// ---- start ----
const port = Number(process.env.PORT || 3200)

const start = async () => {
  try {
    await fastify.listen({ port, host: '0.0.0.0' })
    fastify.log.info(`listening on 0.0.0.0:${port}`)
    // Init signals scanner (after server up so proxyCache is available)
    push.init({ stmts: auth.stmts })
    // Init klines SQLite cache (before signals so liq_sweep can use it)
    klinesCache.initDB()
    signals.init({ getProxyCached, setProxyCached, bgetWithRetry, auth, push, klinesCache, stateManager, densityV2, persistenceMap: densityV2PersistenceMap })
    alertChecker.init({ auth, push, getProxyCached, bgetWithRetry })
    depthHeatmap.init({ stateManager, getProxyCached })
    vpinScanner.init({ bgetWithRetry, getProxyCached })
    fillKill.init({ stateManager, getProxyCached })
    resilience.init({ stateManager, getProxyCached })
    treemapProvider.init({ getProxyCached, BINANCE_FAPI })
    // Start background klines updater (every 30s, updates cached symbols)
    startKlinesUpdater()
    // Pre-warm NATR cache so signals scanner has data from first scan
    // Delay 45s to let Binance rate limit window expire after restart
    setTimeout(async () => {
      if (rateLimiter.pauseUntil > Date.now()) {
        log.info('Startup: NATR warmup skipped — rate limiter paused')
        return
      }
      try {
        log.info('Startup: pre-warming NATR cache (15m)')
        await fastify.inject({ method: 'GET', url: '/api/natr?interval=15m' })
        log.info('Startup: NATR cache warmed')
      } catch (e) { log.warn({ err: e.message }, 'Startup: NATR warmup failed') }
    }, 45_000)
    // Periodic NATR refresh every 5 min (cache TTL is 5min, so re-compute before expiry)
    _intervals.push(setInterval(async () => {
      try {
        await fastify.inject({ method: 'GET', url: '/api/natr?interval=15m' })
      } catch (e) { log.warn({ err: e.message }, 'NATR refresh failed') }
    }, 270_000)) // 4.5 min (slightly before 5min TTL expiry)
    // Background warmup: subscribe top symbols to WS gradually (rate-limit safe)
    setTimeout(() => {
      if (rateLimiter.pauseUntil > Date.now()) {
        log.info('Startup: density warmup skipped — rate limiter paused')
        return
      }
      warmupDensitySubscriptions()
    }, 60_000)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

// Graceful shutdown — clean up resources on PM2 restart / kill
async function gracefulShutdown(signal) {
  log.info({ signal }, 'Shutdown: signal received, closing gracefully')
  try {
    // Stop all intervals
    for (const id of _intervals) clearInterval(id)
    if (_klinesUpdaterInterval) clearInterval(_klinesUpdaterInterval)
    // Stop liq-sweep cache cleanup interval
    try { const liqSweep = require('./liq-sweep'); clearInterval(liqSweep._cleanupInterval) } catch (_) {}
    // Stop signal scanners
    try { signals.stop() } catch (_) {}
    try { alertChecker.stop() } catch (_) {}
    try { depthHeatmap.stop() } catch (_) {}
    try { vpinScanner.stop() } catch (_) {}
    try { fillKill.stop() } catch (_) {}
    try { resilience.stop() } catch (_) {}
    log.info({ intervals: _intervals.length + 1 }, 'Shutdown: cleared intervals + signal scanners')
    // Close Fastify (stop accepting new requests, finish in-flight)
    await fastify.close()
    // Close WebSocket connections
    if (wsManager.connections && wsManager.connections.length > 0) {
      log.info({ connections: wsManager.connections.length }, 'Shutdown: closing WS connections')
      for (const conn of wsManager.connections) {
        conn.destroy()
      }
      wsManager.connections = []
      wsManager.streamToConn.clear()
      wsManager.callbacks.clear()
    }
    // Save density cache + persistence map to disk before exit
    const flushes = []
    if (densityCache.data) {
      flushes.push(saveDensityToDisk(densityCache.data, densityCache.meta))
    }
    if (densityV2PersistenceMap.size > 0) {
      flushes.push(savePersistenceMapToDisk())
    }
    // Wait for disk writes to complete (with timeout)
    if (flushes.length > 0) {
      await Promise.race([
        Promise.allSettled(flushes),
        new Promise(r => setTimeout(r, 2000)) // 2s max wait
      ])
    }
    log.info('Shutdown: clean exit')
    process.exit(0)
  } catch (err) {
    log.error({ err: err.message }, 'Shutdown: error during cleanup')
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

process.on('unhandledRejection', (reason, promise) => {
  log.error({ err: reason }, 'Unhandled rejection')
})

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception')
  gracefulShutdown('uncaughtException')
})

// Gradually subscribe symbols to depth WS and build density cache
async function warmupDensitySubscriptions() {
  try {
    const info = await bgetWithRetry('/fapi/v1/exchangeInfo')
    const allPerpetuals = (info.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol)

    // Prioritize top symbols by volume (warm the rest lazily via resync)
    let allSymbols = allPerpetuals
    try {
      const ticker = await fetchTicker24hr()
      if (Array.isArray(ticker) && ticker.length > 0) {
        const volMap = new Map(ticker.map(t => [t.symbol, parseFloat(t.quoteVolume) || 0]))
        allSymbols = allPerpetuals
          .sort((a, b) => (volMap.get(b) || 0) - (volMap.get(a) || 0))
          .slice(0, 200) // top 200 by volume — rest will warm lazily via WS gaps
      }
    } catch { /* use all symbols if ticker fails */ }

    // Rate budget: depth/1000 = weight 20 per call, Binance limit 2400/min
    // Share budget with signal scanners (~600/min) → warmup gets ~1000/min = 50 calls/min
    const BATCH = 5
    const BATCH_PAUSE = 10000  // 10s between batches
    const ITEM_DELAY = 1000    // 1s between items (5 items × 1s + 10s pause = 15s/batch = 100 weight/15s = 400/min)
    log.info({ symbols: allSymbols.length, batchSize: BATCH, pauseSec: BATCH_PAUSE/1000 }, 'Warmup: starting')
    let subscribed = 0
    let batchRetries = 0
    const MAX_BATCH_RETRIES = 3

    for (let i = 0; i < allSymbols.length; i += BATCH) {
      const batch = allSymbols.slice(i, i + BATCH)
      let batchFailed = false
      for (const sym of batch) {
        if (wsManager.callbacks.has(sym)) { subscribed++; continue }
        try {
          // Direct fetch (bypasses Bottleneck) — limit=100 (weight=2), WS fills the rest
          // 200+ warmup requests would exhaust Bottleneck reservoir and cause AbortController timeouts
          const _ctrl = new AbortController()
          const _tid = setTimeout(() => _ctrl.abort(), 10_000)
          let ob
          try {
            const _res = await fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=100`, { signal: _ctrl.signal })
            if (!_res.ok) throw new Error(`depth ${sym}: ${_res.status}`)
            ob = await _res.json()
          } finally { clearTimeout(_tid) }
          stateManager.initBook(sym, ob.bids, ob.asks)
          wsManager.subscribe(sym, (payload) => { stateManager.processDelta(sym, payload) })
          subscribed++
        } catch (err) {
          log.warn({ symbol: sym, err: err.message.slice(0, 60), retry: batchRetries + 1, maxRetries: MAX_BATCH_RETRIES }, 'Warmup: error, pausing 60s')
          await new Promise(r => setTimeout(r, 60000))
          if (batchRetries < MAX_BATCH_RETRIES) {
            batchRetries++
            i -= BATCH // retry this batch
          } else {
            log.warn({ maxRetries: MAX_BATCH_RETRIES }, 'Warmup: skipping batch after max retries')
            batchRetries = 0
          }
          batchFailed = true
          break
        }
        await new Promise(r => setTimeout(r, ITEM_DELAY))
      }
      if (!batchFailed) batchRetries = 0

      // After every 5 batches (50 symbols), rebuild density cache
      const batchNum = Math.floor(i / BATCH) + 1
      if (batchNum % 5 === 0 || i + BATCH >= allSymbols.length) {
        try { await rebuildDensityCache(allSymbols) } catch (_) {}
        log.info({ subscribed, total: allSymbols.length, walls: densityCache.data ? densityCache.data.length : 0 }, 'Warmup: progress')
      }

      if (i + BATCH < allSymbols.length) {
        await new Promise(r => setTimeout(r, BATCH_PAUSE))
      }
    }
    log.info({ subscribed }, 'Warmup: done')
    // After density warmup, pre-warm klines cache for fast chart loads
    warmupKlinesCache()
  } catch (err) {
    log.error({ err: err.message.slice(0, 100) }, 'Warmup: failed')
  }
}

// Pre-warm klines cache: top 200 by volume × main TFs → instant chart opens
// Phase 1: SQLite check (instant), Phase 2: direct fetch for missing (parallel batches)
async function warmupKlinesCache() {
  try {
    const ticker = await fetchTicker24hr()
    const sorted = ticker
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 200)
      .map(t => t.symbol)

    const TFS = ['15m', '1h', '4h']
    const LIMITS = { '15m': 1500, '1h': 1500, '4h': 1500 }
    const total = sorted.length * TFS.length
    const needFetch = []
    let fromSqlite = 0, fromProxy = 0

    // Phase 1: Check proxyCache + SQLite (instant, zero API calls)
    for (const tf of TFS) {
      for (const sym of sorted) {
        const limit = LIMITS[tf]
        const key = `klines:${sym}:${tf}:${limit}`

        if (getProxyCached(key, 300000)) { fromProxy++; continue }

        // Check SQLite — data survives PM2 restarts
        if (klinesCache) {
          const latestTime = klinesCache.getLatestTime(sym, tf)
          if (latestTime && (Date.now() / 1000 - latestTime) < 3600) {
            // Fresh enough in SQLite (< 1 hour), load into proxyCache
            const rows = klinesCache.getCandles(sym, tf, limit)
            if (rows && rows.length > 100) {
              const data = rows.map(r => [r.time * 1000, String(r.open), String(r.high), String(r.low), String(r.close), '0', 0, String(r.volume)])
              setProxyCached(key, data)
              fromSqlite++
              continue
            }
          }
        }
        needFetch.push({ sym, tf, limit, key })
      }
    }

    log.info({ total, fromSqlite, fromProxy, needFetch: needFetch.length }, 'Klines warmup: SQLite check done')

    // Phase 2: Direct fetch for missing (bypass Bottleneck, parallel batches of 10)
    // Rate budget: ~1200 weight/min (half of 2400, leaving room for user requests)
    // limit=1500 → weight=20. 1200/20 = 60 req/min → batch of 10 every 10s
    const BATCH = 10
    let fetched = 0, errors = 0
    for (let i = 0; i < needFetch.length; i += BATCH) {
      const batch = needFetch.slice(i, i + BATCH)
      await Promise.all(batch.map(async ({ sym, tf, limit, key }) => {
        const controller = new AbortController()
        const tid = setTimeout(() => controller.abort(), 15_000)
        try {
          const res = await fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${limit}`, { signal: controller.signal })
          if (!res.ok) { errors++; return }
          const data = await res.json()
          if (!Array.isArray(data)) { errors++; return }
          setProxyCached(key, data)
          if (klinesCache) try { klinesCache.storeCandles(sym, tf, data) } catch (_) {}
          fetched++
        } catch (_) { errors++ }
        finally { clearTimeout(tid) }
      }))

      // Progress every 5 batches
      if ((i / BATCH) % 5 === 0 && i > 0) {
        log.info({ fetched, errors, remaining: needFetch.length - i - BATCH }, 'Klines warmup: progress')
      }

      // Rate limit: 10 × weight 20 = 200 weight/batch. 10s between → 1200 weight/min
      if (i + BATCH < needFetch.length) await new Promise(r => setTimeout(r, 10_000))
    }

    log.info({ total, fromSqlite, fromProxy, fetched, errors }, 'Klines warmup: done')
  } catch (err) {
    log.error({ err: err.message.slice(0, 100) }, 'Klines warmup: failed')
  }
}

// Rebuild density cache from currently subscribed symbols (no Binance depth calls)
async function rebuildDensityCache(allSymbols) {
  const marks = await bgetWithRetry('/fapi/v1/premiumIndex')
  const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))

  const subscribedSyms = allSymbols.filter(s => wsManager.callbacks.has(s))
  const allWalls = []
  let skipped = 0

  for (const sym of subscribedSyms) {
    const price = markMap.get(sym)
    if (!price) continue

    const bidLevelsRaw = stateManager.getTopLevels(sym, 'bid', price, 0, 100, 5.0)
    const askLevelsRaw = stateManager.getTopLevels(sym, 'ask', price, 0, 100, 5.0)

    const klinesStats = await getKlinesWithStats(sym)
    if (!klinesStats) { skipped++; continue }
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
  if (skipped) log.warn({ skipped, total: subscribedSyms.length }, 'Density rebuild: symbols skipped (klines unavailable)')
}

start()
