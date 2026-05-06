/**
 * API Integration Tests
 *
 * These test the API validation and response format logic without
 * requiring a live Binance connection. We spin up a minimal Fastify
 * instance that replicates the key route validation patterns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const Fastify = require('../server/node_modules/fastify')

const VALID_INTERVALS = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']

let app

beforeAll(async () => {
  app = Fastify()

  // Replicate /depth/:symbol validation
  app.get('/depth/:symbol', async (req, reply) => {
    const symbol = String(req.params.symbol || '').toUpperCase()
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
      reply.code(400)
      return { error: 'Invalid symbol format' }
    }
    return { symbol, bids: [], asks: [] }
  })

  // Replicate /api/klines validation
  app.get('/api/klines', async (req, reply) => {
    const symbol = String(req.query.symbol || '').toUpperCase()
    const interval = String(req.query.interval || '15m')
    const limit = Math.min(Number(req.query.limit || 200), 1500)
    if (!symbol || !/^[A-Z0-9]{2,20}$/.test(symbol)) {
      reply.code(400)
      return { error: 'Invalid or missing symbol' }
    }
    if (!VALID_INTERVALS.includes(interval)) {
      reply.code(400)
      return { error: 'Invalid interval' }
    }
    return { success: true, data: { symbol, interval, limit, candles: [] } }
  })

  // Replicate /api/klines-batch validation
  app.post('/api/klines-batch', async (req, reply) => {
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
    return { success: true, data: { symbols: syms, interval, limit } }
  })

  // Replicate /api/signals/history validation
  app.get('/api/signals/history', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500)
    const offset = Math.max(Number(req.query.offset || 0), 0)
    const type = req.query.type || null
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null
    return { success: true, data: { limit, offset, type, symbol, signals: [] } }
  })

  // Replicate /api/rate-limiter (always works)
  app.get('/api/rate-limiter', async () => ({
    usedWeight: 100,
    softCap: 1800,
    hardCap: 2200,
    status: 'OK',
  }))

  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ---- /depth/:symbol ----
describe('GET /depth/:symbol', () => {
  it('validates symbol format', async () => {
    const res = await app.inject({ method: 'GET', url: '/depth/valid_symbol!' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid symbol format')
  })

  it('rejects too-short symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/depth/X' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects too-long symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/depth/ABCDEFGHIJKLMNOPQRSTUVWXYZ' })
    expect(res.statusCode).toBe(400)
  })

  it('accepts valid symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/depth/BTCUSDT' })
    expect(res.statusCode).toBe(200)
    expect(res.json().symbol).toBe('BTCUSDT')
  })

  it('uppercases symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/depth/btcusdt' })
    expect(res.statusCode).toBe(200)
    expect(res.json().symbol).toBe('BTCUSDT')
  })
})

// ---- /api/klines ----
describe('GET /api/klines', () => {
  it('rejects missing symbol', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('symbol')
  })

  it('rejects invalid symbol format', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines?symbol=BTC/USDT' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid interval', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines?symbol=BTCUSDT&interval=7m' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('interval')
  })

  it('accepts valid request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines?symbol=BTCUSDT&interval=5m&limit=100' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.symbol).toBe('BTCUSDT')
    expect(body.data.interval).toBe('5m')
    expect(body.data.limit).toBe(100)
  })

  it('clamps limit to max 1500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines?symbol=BTCUSDT&limit=9999' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.limit).toBe(1500)
  })

  it('defaults interval to 15m', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/klines?symbol=ETHUSDT' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.interval).toBe('15m')
  })

  it('accepts all valid Binance intervals', async () => {
    for (const int of VALID_INTERVALS) {
      const res = await app.inject({ method: 'GET', url: `/api/klines?symbol=BTCUSDT&interval=${int}` })
      expect(res.statusCode).toBe(200)
    }
  })
})

// ---- /api/klines-batch ----
describe('POST /api/klines-batch', () => {
  it('rejects missing symbols array', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { interval: '5m' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('symbols[]')
  })

  it('rejects empty symbols array', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { symbols: [], interval: '5m' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid interval', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { symbols: ['BTCUSDT'], interval: '99m' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('interval')
  })

  it('accepts valid request', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { symbols: ['BTCUSDT', 'ETHUSDT'], interval: '1h', limit: 300 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.symbols).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(body.data.interval).toBe('1h')
    expect(body.data.limit).toBe(300)
  })

  it('caps at 30 symbols', async () => {
    const syms = Array.from({ length: 50 }, (_, i) => `SYM${i}USDT`)
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { symbols: syms, interval: '5m' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.symbols.length).toBeLessThanOrEqual(30)
  })

  it('filters out invalid symbols', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/klines-batch',
      payload: { symbols: ['BTCUSDT', 'INVALID!@#', 'ETHUSDT'], interval: '5m' },
    })
    expect(res.statusCode).toBe(200)
    const syms = res.json().data.symbols
    expect(syms).toContain('BTCUSDT')
    expect(syms).toContain('ETHUSDT')
    expect(syms).not.toContain('INVALID!@#')
  })
})

// ---- /api/signals/history ----
describe('GET /api/signals/history', () => {
  it('returns correct default params', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals/history' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.limit).toBe(100)
    expect(body.data.offset).toBe(0)
  })

  it('clamps limit to max 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals/history?limit=9999' })
    expect(res.json().data.limit).toBe(500)
  })

  it('clamps limit to min 1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals/history?limit=-5' })
    expect(res.json().data.limit).toBe(1)
  })

  it('uppercases symbol filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals/history?symbol=btcusdt' })
    expect(res.json().data.symbol).toBe('BTCUSDT')
  })
})

// ---- /api/rate-limiter ----
describe('GET /api/rate-limiter', () => {
  it('returns rate limiter status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rate-limiter' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.usedWeight).toBeDefined()
    expect(body.softCap).toBe(1800)
    expect(body.hardCap).toBe(2200)
    expect(body.status).toBe('OK')
  })
})
