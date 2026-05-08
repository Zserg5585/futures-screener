'use strict'
/**
 * Centralized Binance REST client with Bottleneck rate limiting.
 *
 * ALL Binance REST calls MUST go through bget() / bgetWithRetry() from this module.
 * Two layers of protection:
 *   1. Bottleneck — pre-flight: concurrency, spacing, reservoir (weight budget)
 *   2. Header tracking — post-flight: reads X-MBX-USED-WEIGHT-1M, syncs reservoir
 */
const Bottleneck = require('bottleneck')
const path = require('path')
const fs = require('fs')
const { createLogger } = require('./logger')

const log = createLogger('binance-client')

const BINANCE_FAPI = 'https://fapi.binance.com'
const FETCH_TIMEOUT_MS = 15_000
const RATE_LIMIT_FILE = path.resolve(__dirname, '..', 'data', 'rate-limit-pause.json')

// ─── Weight estimator (matches Binance docs) ───────────────────────────
function estimateWeight(apiPath) {
  if (apiPath.includes('/depth')) {
    const m = apiPath.match(/limit=(\d+)/)
    const limit = m ? parseInt(m[1]) : 100
    if (limit <= 5) return 2
    if (limit <= 50) return 5
    if (limit <= 500) return 10
    return 20 // limit=1000
  }
  if (apiPath.includes('/klines')) {
    const m = apiPath.match(/limit=(\d+)/)
    const limit = m ? parseInt(m[1]) : 10
    if (limit < 500) return 5
    if (limit < 1000) return 10
    return 20
  }
  if (apiPath.includes('/ticker/24hr')) {
    return apiPath.includes('symbol=') ? 1 : 40
  }
  if (apiPath.includes('/premiumIndex')) {
    return apiPath.includes('symbol=') ? 1 : 10
  }
  if (apiPath.includes('/openInterestHist')) return 30
  if (apiPath.includes('/takerlongshortRatio')) return 30
  if (apiPath.includes('/exchangeInfo')) return 1
  return 5 // conservative default
}

// ─── Disk persistence for pause state ──────────────────────────────────
function loadPauseFromDisk() {
  try {
    const raw = fs.readFileSync(RATE_LIMIT_FILE, 'utf8')
    const { pauseUntil } = JSON.parse(raw)
    if (pauseUntil && pauseUntil > Date.now()) {
      log.info({ remaining: Math.ceil((pauseUntil - Date.now()) / 1000) }, 'Restored pause from disk')
      return pauseUntil
    }
  } catch {}
  return 0
}

function savePauseToDisk(pauseUntil) {
  try {
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify({ pauseUntil, savedAt: new Date().toISOString() }))
  } catch {}
}

// ─── Bottleneck limiter ────────────────────────────────────────────────
const limiter = new Bottleneck({
  maxConcurrent: 50,       // must be >= max single request weight (ticker24hr=40, openInterestHist=30)
  minTime: 50,             // min 50ms between requests
  reservoir: 2400,         // Binance weight budget
  reservoirRefreshAmount: 2400,
  reservoirRefreshInterval: 60_000, // resets every minute
})

// Log when limiter is depleted
limiter.on('depleted', () => {
  log.warn('Bottleneck reservoir depleted — requests queued until refresh')
})

// ─── Header-based weight tracking (secondary safety) ───────────────────
const weightTracker = {
  usedWeight: 0,
  weightUpdatedAt: 0,
  pauseUntil: loadPauseFromDisk(),
  WEIGHT_SOFT_LIMIT: 1800,
  WEIGHT_HARD_LIMIT: 2200,

  update(headers) {
    const w = parseInt(headers.get('x-mbx-used-weight-1m') || '0', 10)
    if (w > 0) {
      this.usedWeight = w
      this.weightUpdatedAt = Date.now()
      // Sync Bottleneck reservoir with actual Binance weight
      const remaining = Math.max(2400 - w, 0)
      limiter.updateSettings({ reservoir: remaining })
    }
  },

  setPause(ms) {
    const until = Date.now() + ms
    if (until > this.pauseUntil) {
      this.pauseUntil = until
      savePauseToDisk(until)
      log.warn({ pauseMs: ms, until: new Date(until).toISOString().slice(11, 19) }, 'Global pause set')
    }
  },

  checkPause() {
    const now = Date.now()
    if (now < this.pauseUntil) {
      throw new RateLimitError('paused', this.pauseUntil - now, this.usedWeight)
    }
    // Weight is stale after 60s — Binance resets every minute
    if (now - this.weightUpdatedAt > 60_000) {
      this.usedWeight = 0
    }
  },

  status() {
    const paused = this.pauseUntil > Date.now()
    return `weight=${this.usedWeight}/2400, pause=${paused ? (this.pauseUntil - Date.now()) + 'ms' : 'none'}`
  }
}

// ─── Error class ───────────────────────────────────────────────────────
class RateLimitError extends Error {
  constructor(apiPath, retryAfterMs, usedWeight) {
    super(`Binance 429 rate limited: ${apiPath}`)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
    this.usedWeight = usedWeight
  }
}

// ─── Core fetch (single request, goes through Bottleneck) ──────────────
async function bget(apiPath) {
  // Check global pause BEFORE entering Bottleneck queue
  weightTracker.checkPause()

  const weight = estimateWeight(apiPath)

  return limiter.schedule({ weight }, async () => {
    // Re-check pause (may have changed while queued)
    weightTracker.checkPause()

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(BINANCE_FAPI + apiPath, { method: 'GET', signal: controller.signal })

      // Always track weight from response headers
      weightTracker.update(res.headers)

      if (res.status === 429 || res.status === 418) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
        const retryMs = retryAfter > 0 ? retryAfter * 1000 : (res.status === 418 ? 120_000 : 30_000)
        weightTracker.setPause(retryMs)
        throw new RateLimitError(apiPath, retryMs, weightTracker.usedWeight)
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`Binance GET ${apiPath} failed: ${res.status} ${txt}`)
      }
      return res.json()
    } finally {
      clearTimeout(timeoutId)
    }
  })
}

// ─── Retry wrapper ─────────────────────────────────────────────────────
async function bgetWithRetry(apiPath, maxRetries = 3, baseDelay = 500) {
  const MAX_RL_RETRIES = 3
  let attempt = 0
  let rlRetries = 0

  while (attempt < maxRetries) {
    try {
      return await bget(apiPath)
    } catch (err) {
      if (err instanceof RateLimitError) {
        rlRetries++
        if (rlRetries > MAX_RL_RETRIES) {
          throw new Error(`Binance GET ${apiPath} rate limited ${rlRetries}x, giving up (${weightTracker.status()})`)
        }
        const waitMs = Math.max(err.retryAfterMs || 30_000, 1000)
        log.warn({ path: apiPath.slice(0, 60), retry: rlRetries, waitMs }, '429 — retrying')
        await new Promise(r => setTimeout(r, waitMs))
        continue // does NOT count as a regular attempt
      }
      attempt++
      if (attempt >= maxRetries) {
        throw new Error(`Binance GET ${apiPath} failed after ${maxRetries} attempts: ${err.message}`)
      }
      const delay = baseDelay * Math.pow(2, attempt - 1)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error(`Binance GET ${apiPath} failed: exhausted all retries`)
}

// ─── Stats for monitoring ──────────────────────────────────────────────
function getStats() {
  const counts = limiter.counts()
  return {
    weight: weightTracker.usedWeight,
    weightLimit: 2400,
    paused: weightTracker.pauseUntil > Date.now(),
    pauseRemaining: Math.max(0, weightTracker.pauseUntil - Date.now()),
    bottleneck: {
      running: counts.RUNNING,
      queued: counts.QUEUED,
      reservoir: counts.RESERVOIR || 'unknown',
    }
  }
}

module.exports = {
  bget,
  bgetWithRetry,
  RateLimitError,
  rateLimiter: weightTracker, // backward-compatible name
  limiter,
  BINANCE_FAPI,
  estimateWeight,
  getStats,
}
