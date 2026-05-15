import { describe, it, expect, beforeEach, vi } from 'vitest'

const sm = require('../server/state.js')

describe('StateManager — getTopLevels', () => {
  beforeEach(() => {
    sm.books.clear()
    sm.binHistory.clear()
  })

  it('returns top levels by notional within window', () => {
    sm.initBook('BTCUSDT', [
      ['49500', '1'], // notional 49500
      ['49800', '2'], // notional 99600
      ['49900', '0.5'], // notional 24950
    ], [])

    const levels = sm.getTopLevels('BTCUSDT', 'bid', 50000, 10000, 10, 2)
    expect(levels.length).toBe(3)
    // Sorted by notional desc
    expect(levels[0].notional).toBe(99600)
    expect(levels[0].price).toBe(49800)
  })

  it('filters by minNotional', () => {
    sm.initBook('BTCUSDT', [
      ['49500', '1'],  // 49500
      ['49800', '2'],  // 99600
    ], [])

    const levels = sm.getTopLevels('BTCUSDT', 'bid', 50000, 60000, 10, 2)
    expect(levels.length).toBe(1)
    expect(levels[0].price).toBe(49800)
  })

  it('filters by windowPct', () => {
    sm.initBook('BTCUSDT', [
      ['49000', '2'], // 98000, within 2% of 50000
      ['45000', '3'], // 135000, but 10% away — outside window
    ], [])

    const levels = sm.getTopLevels('BTCUSDT', 'bid', 50000, 0, 10, 2)
    expect(levels.length).toBe(1)
    expect(levels[0].price).toBe(49000)
  })

  it('respects limit', () => {
    sm.initBook('BTCUSDT', [
      ['49500', '1'],
      ['49600', '2'],
      ['49700', '3'],
      ['49800', '4'],
    ], [])

    const levels = sm.getTopLevels('BTCUSDT', 'bid', 50000, 0, 2, 2)
    expect(levels.length).toBe(2)
  })

  it('returns ask side correctly', () => {
    sm.initBook('BTCUSDT', [], [
      ['50100', '2'], // 100200
      ['50200', '3'], // 150600
    ])

    const levels = sm.getTopLevels('BTCUSDT', 'ask', 50000, 0, 10, 2)
    expect(levels.length).toBe(2)
    expect(levels[0].price).toBe(50200) // highest notional first
  })

  it('returns empty for unknown symbol', () => {
    expect(sm.getTopLevels('UNKNOWN', 'bid', 100, 0, 10, 2)).toEqual([])
  })

  it('includes distancePct in results', () => {
    sm.initBook('BTCUSDT', [['49500', '2']], [])
    const levels = sm.getTopLevels('BTCUSDT', 'bid', 50000, 0, 10, 2)
    expect(levels[0].distancePct).toBeCloseTo(1.0, 1) // (50000-49500)/50000*100 = 1%
  })
})

describe('StateManager — trackAndEnrichBins', () => {
  beforeEach(() => {
    sm.books.clear()
    sm.binHistory.clear()
    sm._lastBinCleanup = null
  })

  it('creates new history entry for first-seen bin', () => {
    const bins = [{ anchorPrice: 50000, notional: 100000, oldestSeen: null }]
    const enriched = sm.trackAndEnrichBins('BTCUSDT', 'BID', bins, 50500)

    expect(enriched.length).toBe(1)
    expect(enriched[0].isMovingTowardPrice).toBe(false)
    expect(sm.binHistory.size).toBe(1)
  })

  it('updates existing bin history', () => {
    const bins1 = [{ anchorPrice: 50000, notional: 80000 }]
    sm.trackAndEnrichBins('BTCUSDT', 'BID', bins1, 50500)

    const bins2 = [{ anchorPrice: 50000, notional: 120000 }]
    sm.trackAndEnrichBins('BTCUSDT', 'BID', bins2, 50500)

    const entry = sm.binHistory.get('BTCUSDT:BID:50000')
    expect(entry.maxNotional).toBe(120000) // updated to higher
  })

  it('returns enriched bins with oldestSeen from history', () => {
    const bins1 = [{ anchorPrice: 50000, notional: 80000 }]
    sm.trackAndEnrichBins('BTCUSDT', 'BID', bins1, 50500)

    // Simulate a later call
    const bins2 = [{ anchorPrice: 50000, notional: 90000 }]
    const enriched = sm.trackAndEnrichBins('BTCUSDT', 'BID', bins2, 50500)

    expect(enriched[0].oldestSeen).toBeDefined()
    expect(enriched[0].oldestSeen).toBeLessThanOrEqual(Date.now())
  })

  it('enforces hard cap 5000 on binHistory', () => {
    // Force cleanup to run by setting _lastBinCleanup to old
    sm._lastBinCleanup = 0
    // Fill binHistory beyond 5000
    for (let i = 0; i < 5100; i++) {
      sm.binHistory.set(`SYM:BID:${i}`, { oldestSeen: Date.now(), maxNotional: 100, lastUpdate: Date.now() - 90000, isMovingTowardPrice: false })
    }
    // Trigger cleanup via trackAndEnrichBins
    const bins = [{ anchorPrice: 99999, notional: 1000 }]
    sm.trackAndEnrichBins('XXUSDT', 'BID', bins, 100000)

    // After cleanup: stale entries (>60s) should be removed, and hard cap applied
    expect(sm.binHistory.size).toBeLessThanOrEqual(5000)
  })
})

describe('StateManager — MAX_BOOKS eviction', () => {
  beforeEach(() => {
    sm.books.clear()
    sm.binHistory.clear()
  })

  it('evicts oldest book when at capacity', () => {
    sm.MAX_BOOKS = 3 // temp lower for test

    sm.initBook('AAA', [['100', '1']], [])
    sm.books.get('AAA')._lastActivity = 1000 // oldest

    sm.initBook('BBB', [['200', '1']], [])
    sm.books.get('BBB')._lastActivity = 2000

    sm.initBook('CCC', [['300', '1']], [])
    sm.books.get('CCC')._lastActivity = 3000

    // Adding 4th should evict AAA (oldest)
    sm.initBook('DDD', [['400', '1']], [])

    expect(sm.books.has('AAA')).toBe(false)
    expect(sm.books.has('DDD')).toBe(true)
    expect(sm.books.size).toBe(3)

    sm.MAX_BOOKS = 600 // restore
  })
})

describe('StateManager — gap detection / resync', () => {
  beforeEach(() => {
    sm.books.clear()
    sm.binHistory.clear()
    sm._resyncHandler = null
  })

  it('calls resync handler on gap', () => {
    const handler = vi.fn()
    sm.setResyncHandler(handler)

    sm.initBook('BTCUSDT', [['50000', '1']], [])
    sm.books.get('BTCUSDT').lastUpdateId = 100

    // Gap: expected 101, got 200
    sm.processDelta('BTCUSDT', { U: 200, u: 210, b: [['49000', '1']], a: [] })

    expect(handler).toHaveBeenCalledWith('BTCUSDT')
  })

  it('does not apply delta when gap detected', () => {
    sm.setResyncHandler(vi.fn())
    sm.initBook('BTCUSDT', [['50000', '1']], [])
    sm.books.get('BTCUSDT').lastUpdateId = 100

    sm.processDelta('BTCUSDT', { U: 200, u: 210, b: [['49000', '5']], a: [] })

    const book = sm.books.get('BTCUSDT')
    expect(book.bids.has(49000)).toBe(false) // delta was dropped
    expect(book.lastUpdateId).toBe(100) // not updated
  })

  it('fires resync handler on every gap (throttling in index.js)', () => {
    const handler = vi.fn()
    sm.setResyncHandler(handler)

    sm.initBook('BTCUSDT', [['50000', '1']], [])
    sm.books.get('BTCUSDT').lastUpdateId = 100

    // First gap triggers resync
    sm.processDelta('BTCUSDT', { U: 200, u: 210, b: [], a: [] })
    expect(handler).toHaveBeenCalledTimes(1)

    // Second gap — also fires (cooldown is caller's responsibility)
    sm.processDelta('BTCUSDT', { U: 300, u: 310, b: [], a: [] })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('applies delta normally when sequence is valid', () => {
    sm.setResyncHandler(vi.fn())
    sm.initBook('BTCUSDT', [['50000', '1']], [])
    sm.books.get('BTCUSDT').lastUpdateId = 100

    // Valid sequence: U=101 (first) u=105 (last)
    sm.processDelta('BTCUSDT', { U: 101, u: 105, b: [['49000', '2']], a: [] })

    const book = sm.books.get('BTCUSDT')
    expect(book.bids.has(49000)).toBe(true)
    expect(book.lastUpdateId).toBe(105)
  })
})

describe('StateManager — removeBook', () => {
  beforeEach(() => {
    sm.books.clear()
  })

  it('removes a book by symbol', () => {
    sm.initBook('BTCUSDT', [['50000', '1']], [])
    expect(sm.books.has('BTCUSDT')).toBe(true)
    sm.removeBook('BTCUSDT')
    expect(sm.books.has('BTCUSDT')).toBe(false)
  })

  it('does nothing for unknown symbol', () => {
    sm.removeBook('UNKNOWN') // should not throw
    expect(sm.books.size).toBe(0)
  })
})
