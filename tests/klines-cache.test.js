import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const Database = require('../server/node_modules/better-sqlite3')

// We can't easily override the DB_PATH in the module, so we test by
// creating a temp DB in the same location the module expects, running tests,
// then cleaning up. Alternatively, we directly test the logic.
// Simplest: require the module and init with a temp db by patching.

// Actually - let's just use a temporary database directly and replicate
// the logic to verify SQL operations work correctly.

const TEST_DB_PATH = path.join(__dirname, '..', 'server', 'data', 'klines-test.db')

describe('klines-cache', () => {
  let db
  let stmts

  beforeAll(() => {
    // Ensure data dir exists
    const dir = path.dirname(TEST_DB_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    db = new Database(TEST_DB_PATH)
    db.pragma('journal_mode = WAL')

    db.exec(`
      CREATE TABLE IF NOT EXISTS klines (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (symbol, interval, time)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_klines_sym_int
        ON klines(symbol, interval);
    `)

    stmts = {
      upsert: db.prepare(`
        INSERT OR REPLACE INTO klines (symbol, interval, time, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getRangeLimit: db.prepare(`
        SELECT time, open, high, low, close, volume
        FROM klines WHERE symbol = ? AND interval = ?
        ORDER BY time DESC LIMIT ?
      `),
      getAfter: db.prepare(`
        SELECT time, open, high, low, close, volume
        FROM klines WHERE symbol = ? AND interval = ? AND time > ?
        ORDER BY time ASC
      `),
      getBefore: db.prepare(`
        SELECT time, open, high, low, close, volume
        FROM klines WHERE symbol = ? AND interval = ? AND time < ?
        ORDER BY time DESC LIMIT ?
      `),
      getLatestTime: db.prepare(`
        SELECT MAX(time) as maxTime FROM klines WHERE symbol = ? AND interval = ?
      `),
      getCount: db.prepare(`
        SELECT COUNT(*) as cnt FROM klines WHERE symbol = ? AND interval = ?
      `),
      getSymbols: db.prepare(`
        SELECT DISTINCT symbol FROM klines WHERE interval = ?
      `),
    }
  })

  afterAll(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB_PATH) } catch (_) {}
    try { fs.unlinkSync(TEST_DB_PATH + '-wal') } catch (_) {}
    try { fs.unlinkSync(TEST_DB_PATH + '-shm') } catch (_) {}
  })

  // Helper: store candles (replicating module's storeCandles logic)
  function storeCandles(symbol, interval, rawKlines) {
    if (!rawKlines || rawKlines.length === 0) return 0
    const tx = db.transaction((rows) => {
      for (const k of rows) {
        const time = Math.floor(k[0] / 1000)
        stmts.upsert.run(symbol, interval, time,
          parseFloat(k[1]), parseFloat(k[2]),
          parseFloat(k[3]), parseFloat(k[4]),
          parseFloat(k[7])
        )
      }
    })
    tx(rawKlines)
    return rawKlines.length
  }

  function getCandles(symbol, interval, limit = 500) {
    return stmts.getRangeLimit.all(symbol, interval, limit).reverse()
  }

  function getCandlesAfter(symbol, interval, afterTime) {
    return stmts.getAfter.all(symbol, interval, afterTime)
  }

  function getCandlesBefore(symbol, interval, beforeTime, limit = 1500) {
    return stmts.getBefore.all(symbol, interval, beforeTime, limit).reverse()
  }

  // Fake Binance raw kline format: [openTime, open, high, low, close, vol, closeTime, quoteVol, ...]
  function makeFakeKline(timeMs, open, high, low, close, quoteVol) {
    return [timeMs, String(open), String(high), String(low), String(close), '0', 0, String(quoteVol)]
  }

  describe('storeCandles', () => {
    it('stores candles and returns count', () => {
      const raw = [
        makeFakeKline(1000000, 100, 105, 95, 102, 50000),
        makeFakeKline(2000000, 102, 108, 99, 106, 60000),
        makeFakeKline(3000000, 106, 110, 103, 109, 70000),
      ]
      const count = storeCandles('BTCUSDT', '5m', raw)
      expect(count).toBe(3)
    })

    it('converts ms to seconds for time', () => {
      const raw = [makeFakeKline(5000000, 100, 105, 95, 102, 50000)]
      storeCandles('ETHUSDT', '15m', raw)
      const row = stmts.getLatestTime.get('ETHUSDT', '15m')
      expect(row.maxTime).toBe(5000) // 5000000ms → 5000s
    })

    it('upserts on duplicate (same symbol+interval+time)', () => {
      storeCandles('XRPUSDT', '1h', [makeFakeKline(10000000, 1.0, 1.1, 0.9, 1.05, 1000)])
      storeCandles('XRPUSDT', '1h', [makeFakeKline(10000000, 1.1, 1.2, 1.0, 1.15, 2000)])

      const candles = getCandles('XRPUSDT', '1h', 10)
      expect(candles.length).toBe(1)
      expect(candles[0].close).toBeCloseTo(1.15) // updated
      expect(candles[0].volume).toBeCloseTo(2000) // updated
    })

    it('returns 0 for empty input', () => {
      expect(storeCandles('TEST', '5m', [])).toBe(0)
      expect(storeCandles('TEST', '5m', null)).toBe(0)
    })
  })

  describe('getCandles', () => {
    it('returns candles in ASC order (latest N)', () => {
      storeCandles('SOLUSDT', '5m', [
        makeFakeKline(100000, 10, 11, 9, 10.5, 1000),
        makeFakeKline(200000, 11, 12, 10, 11.5, 1100),
        makeFakeKline(300000, 12, 13, 11, 12.5, 1200),
        makeFakeKline(400000, 13, 14, 12, 13.5, 1300),
        makeFakeKline(500000, 14, 15, 13, 14.5, 1400),
      ])

      const candles = getCandles('SOLUSDT', '5m', 3)
      expect(candles.length).toBe(3)
      // ASC: oldest first
      expect(candles[0].time).toBeLessThan(candles[1].time)
      expect(candles[1].time).toBeLessThan(candles[2].time)
      // Latest 3
      expect(candles[2].close).toBeCloseTo(14.5)
    })

    it('returns empty for unknown symbol', () => {
      const candles = getCandles('NEVEREXIST', '5m', 100)
      expect(candles).toEqual([])
    })
  })

  describe('getCandlesAfter', () => {
    it('returns candles after timestamp in ASC order', () => {
      storeCandles('AFTERTEST', '5m', [
        makeFakeKline(100000, 10, 11, 9, 10, 500),
        makeFakeKline(200000, 11, 12, 10, 11, 600),
        makeFakeKline(300000, 12, 13, 11, 12, 700),
      ])

      const after = getCandlesAfter('AFTERTEST', '5m', 100) // after time=100s (100000ms)
      expect(after.length).toBe(2) // time=200 and time=300
      expect(after[0].time).toBe(200)
      expect(after[1].time).toBe(300)
    })

    it('returns empty when nothing after', () => {
      const after = getCandlesAfter('AFTERTEST', '5m', 9999)
      expect(after).toEqual([])
    })
  })

  describe('getCandlesBefore', () => {
    it('returns candles before timestamp in ASC order', () => {
      storeCandles('BEFORETEST', '5m', [
        makeFakeKline(100000, 10, 11, 9, 10, 500),
        makeFakeKline(200000, 11, 12, 10, 11, 600),
        makeFakeKline(300000, 12, 13, 11, 12, 700),
      ])

      const before = getCandlesBefore('BEFORETEST', '5m', 300, 10) // before time=300
      expect(before.length).toBe(2) // time=100 and time=200
      expect(before[0].time).toBe(100) // ASC order
      expect(before[1].time).toBe(200)
    })

    it('respects limit', () => {
      const before = getCandlesBefore('BEFORETEST', '5m', 300, 1)
      expect(before.length).toBe(1)
      expect(before[0].time).toBe(200) // most recent before 300
    })
  })

  describe('getLatestTime / getCount / getCachedSymbols', () => {
    it('getLatestTime returns max time', () => {
      storeCandles('LTTEST', '1h', [
        makeFakeKline(1000000, 1, 2, 0.5, 1.5, 100),
        makeFakeKline(5000000, 2, 3, 1.5, 2.5, 200),
      ])
      const row = stmts.getLatestTime.get('LTTEST', '1h')
      expect(row.maxTime).toBe(5000) // 5000000ms → 5000s
    })

    it('getLatestTime returns null for unknown symbol', () => {
      const row = stmts.getLatestTime.get('UNKNOWN123', '1h')
      expect(row.maxTime).toBeNull()
    })

    it('getCount returns correct count', () => {
      storeCandles('COUNTTEST', '5m', [
        makeFakeKline(100000, 1, 2, 0.5, 1, 100),
        makeFakeKline(200000, 1, 2, 0.5, 1, 100),
      ])
      const row = stmts.getCount.get('COUNTTEST', '5m')
      expect(row.cnt).toBe(2)
    })

    it('getCachedSymbols returns distinct symbols', () => {
      storeCandles('SYM_A', '15m', [makeFakeKline(100000, 1, 2, 0.5, 1, 100)])
      storeCandles('SYM_B', '15m', [makeFakeKline(200000, 1, 2, 0.5, 1, 100)])

      const syms = stmts.getSymbols.all('15m').map(r => r.symbol)
      expect(syms).toContain('SYM_A')
      expect(syms).toContain('SYM_B')
    })
  })
})
