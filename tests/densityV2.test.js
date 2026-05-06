import { describe, it, expect } from 'vitest'
import {
  getBucketSize,
  bucketLevels,
  detectWalls,
  clusterWalls,
  calcImbalance,
  enrichWithPersistence,
  cleanupPersistence,
  scoreWall,
  analyzeSymbol
} from '../server/densityV2.js'

// ---- getBucketSize ----
describe('getBucketSize', () => {
  it('returns 0.05% of price', () => {
    expect(getBucketSize(60000)).toBeCloseTo(30, 1)    // BTC
    expect(getBucketSize(3500)).toBeCloseTo(1.75, 2)   // ETH
    expect(getBucketSize(0.05)).toBeCloseTo(0.000025, 6) // small alt
  })

  it('handles zero price', () => {
    expect(getBucketSize(0)).toBe(0)
  })
})

// ---- bucketLevels ----
describe('bucketLevels', () => {
  const levels = [
    { price: 100.1, notional: 5000, firstSeen: 1000, lastUpdate: 2000 },
    { price: 100.2, notional: 3000, firstSeen: 900,  lastUpdate: 2100 },
    { price: 105.0, notional: 7000, firstSeen: 1100, lastUpdate: 2200 },
  ]

  it('groups levels into buckets', () => {
    const buckets = bucketLevels(levels, 1.0) // $1 buckets
    expect(buckets.length).toBeGreaterThanOrEqual(2) // 100.x and 105.x in different buckets
  })

  it('aggregates notional within a bucket', () => {
    const buckets = bucketLevels(levels, 1.0)
    // 100.1 and 100.2 should be in the same bucket
    const bucket100 = buckets.find(b => b.anchorPrice >= 100 && b.anchorPrice <= 101)
    expect(bucket100).toBeDefined()
    expect(bucket100.totalNotional).toBe(8000) // 5000 + 3000
    expect(bucket100.levelCount).toBe(2)
  })

  it('tracks oldestSeen as minimum firstSeen', () => {
    const buckets = bucketLevels(levels, 1.0)
    const bucket100 = buckets.find(b => b.anchorPrice >= 100 && b.anchorPrice <= 101)
    expect(bucket100.oldestSeen).toBe(900) // min of 1000, 900
  })

  it('tracks newestUpdate as maximum lastUpdate', () => {
    const buckets = bucketLevels(levels, 1.0)
    const bucket100 = buckets.find(b => b.anchorPrice >= 100 && b.anchorPrice <= 101)
    expect(bucket100.newestUpdate).toBe(2100)
  })

  it('returns empty for empty input', () => {
    expect(bucketLevels([], 1)).toEqual([])
    expect(bucketLevels(null, 1)).toEqual([])
  })

  it('tracks min/max price within bucket', () => {
    const buckets = bucketLevels(levels, 1.0)
    const bucket100 = buckets.find(b => b.anchorPrice >= 100 && b.anchorPrice <= 101)
    expect(bucket100.minPrice).toBe(100.1)
    expect(bucket100.maxPrice).toBe(100.2)
  })
})

// ---- detectWalls ----
describe('detectWalls', () => {
  it('detects statistical outliers', () => {
    const buckets = [
      { totalNotional: 100, anchorPrice: 99 },
      { totalNotional: 120, anchorPrice: 100 },
      { totalNotional: 110, anchorPrice: 101 },
      { totalNotional: 90,  anchorPrice: 102 },
      { totalNotional: 5000, anchorPrice: 103 }, // outlier
    ]
    const { walls, median, stddev } = detectWalls(buckets, 2)
    expect(walls.length).toBe(1)
    expect(walls[0].anchorPrice).toBe(103)
    expect(walls[0].sizeVsMedian).toBeGreaterThan(10)
    expect(median).toBeGreaterThan(0)
    expect(stddev).toBeGreaterThan(0)
  })

  it('returns no walls if all values similar', () => {
    const buckets = [
      { totalNotional: 100, anchorPrice: 99 },
      { totalNotional: 105, anchorPrice: 100 },
      { totalNotional: 98,  anchorPrice: 101 },
      { totalNotional: 102, anchorPrice: 102 },
    ]
    const { walls } = detectWalls(buckets, 2)
    expect(walls.length).toBe(0)
  })

  it('handles fewer than 3 buckets', () => {
    const { walls } = detectWalls([{ totalNotional: 100 }], 2)
    expect(walls).toEqual([])
  })

  it('handles null/empty', () => {
    expect(detectWalls(null).walls).toEqual([])
    expect(detectWalls([]).walls).toEqual([])
  })

  it('caps sizeVsMedian at 99.9', () => {
    const buckets = [
      { totalNotional: 1, anchorPrice: 99 },
      { totalNotional: 1, anchorPrice: 100 },
      { totalNotional: 1, anchorPrice: 101 },
      { totalNotional: 1000000, anchorPrice: 102 },
    ]
    const { walls } = detectWalls(buckets, 2)
    expect(walls[0].sizeVsMedian).toBe(99.9)
  })
})

// ---- clusterWalls ----
describe('clusterWalls', () => {
  it('merges adjacent walls', () => {
    const walls = [
      { anchorPrice: 100.5, totalNotional: 5000, levelCount: 3, minPrice: 100, maxPrice: 101, oldestSeen: 1000, newestUpdate: 2000, sizeVsMedian: 10 },
      { anchorPrice: 101.5, totalNotional: 3000, levelCount: 2, minPrice: 101, maxPrice: 102, oldestSeen: 1100, newestUpdate: 2100, sizeVsMedian: 8 },
    ]
    const clusters = clusterWalls(walls, 1.0, 2)
    expect(clusters.length).toBe(1)
    expect(clusters[0].totalNotional).toBe(8000)
    expect(clusters[0].levelCount).toBe(5)
  })

  it('keeps distant walls separate', () => {
    const walls = [
      { anchorPrice: 100.5, totalNotional: 5000, levelCount: 3, minPrice: 100, maxPrice: 101, oldestSeen: 1000, newestUpdate: 2000, sizeVsMedian: 10 },
      { anchorPrice: 110.5, totalNotional: 3000, levelCount: 2, minPrice: 110, maxPrice: 111, oldestSeen: 1100, newestUpdate: 2100, sizeVsMedian: 8 },
    ]
    const clusters = clusterWalls(walls, 1.0, 2)
    expect(clusters.length).toBe(2)
  })

  it('returns empty for empty input', () => {
    expect(clusterWalls([], 1)).toEqual([])
    expect(clusterWalls(null, 1)).toEqual([])
  })
})

// ---- calcImbalance ----
describe('calcImbalance', () => {
  it('returns 0 for equal bids and asks', () => {
    const bids = [{ notional: 100 }, { notional: 200 }]
    const asks = [{ notional: 150 }, { notional: 150 }]
    expect(calcImbalance(bids, asks)).toBe(0)
  })

  it('returns positive for bid-heavy', () => {
    const bids = [{ notional: 800 }]
    const asks = [{ notional: 200 }]
    const imb = calcImbalance(bids, asks)
    expect(imb).toBeCloseTo(0.6, 2)
  })

  it('returns negative for ask-heavy', () => {
    const bids = [{ notional: 200 }]
    const asks = [{ notional: 800 }]
    const imb = calcImbalance(bids, asks)
    expect(imb).toBeCloseTo(-0.6, 2)
  })

  it('returns 0 for empty arrays', () => {
    expect(calcImbalance([], [])).toBe(0)
  })
})

// ---- enrichWithPersistence ----
describe('enrichWithPersistence', () => {
  it('marks new wall as "new"', () => {
    const map = new Map()
    const wall = { anchorPrice: 100, totalNotional: 5000 }
    const enriched = enrichWithPersistence(wall, map, 'BTCUSDT', 'bid', 100)
    expect(enriched.status).toBe('new')
    expect(enriched.ageMins).toBe(0)
    expect(map.size).toBe(1)
  })

  it('marks wall >3min as "confirmed"', () => {
    const map = new Map()
    const bucketSize = getBucketSize(100)
    const bucketIdx = Math.floor(100 / bucketSize)
    // Pre-seed a record 4 minutes old
    map.set(`BTCUSDT:bid:${bucketIdx}`, {
      firstSeen: Date.now() - 4 * 60000,
      lastSeen: Date.now() - 1000,
      peakNotional: 5000
    })
    const wall = { anchorPrice: 100, totalNotional: 5500 }
    const enriched = enrichWithPersistence(wall, map, 'BTCUSDT', 'bid', 100)
    expect(enriched.status).toBe('confirmed')
    expect(enriched.ageMins).toBeGreaterThanOrEqual(3)
  })

  it('marks wall >10min as "strong"', () => {
    const map = new Map()
    const bucketSize = getBucketSize(100)
    const bucketIdx = Math.floor(100 / bucketSize)
    map.set(`BTCUSDT:ask:${bucketIdx}`, {
      firstSeen: Date.now() - 15 * 60000,
      lastSeen: Date.now() - 1000,
      peakNotional: 4000
    })
    const wall = { anchorPrice: 100, totalNotional: 6000 }
    const enriched = enrichWithPersistence(wall, map, 'BTCUSDT', 'ask', 100)
    expect(enriched.status).toBe('strong')
    expect(enriched.peakNotional).toBe(6000) // updated peak
  })

  it('fuzzy matches ±1 bucket offset', () => {
    const map = new Map()
    const bucketSize = getBucketSize(100)
    const bucketIdx = Math.floor(100 / bucketSize)
    // Seed at neighboring bucket
    map.set(`BTCUSDT:bid:${bucketIdx - 1}`, {
      firstSeen: Date.now() - 5 * 60000,
      lastSeen: Date.now() - 500,
      peakNotional: 4000
    })
    const wall = { anchorPrice: 100, totalNotional: 5000 }
    const enriched = enrichWithPersistence(wall, map, 'BTCUSDT', 'bid', 100)
    expect(enriched.status).toBe('confirmed')
    // Old key should be migrated
    expect(map.has(`BTCUSDT:bid:${bucketIdx - 1}`)).toBe(false)
    expect(map.has(`BTCUSDT:bid:${bucketIdx}`)).toBe(true)
  })
})

// ---- cleanupPersistence ----
describe('cleanupPersistence', () => {
  it('removes entries older than 5 minutes', () => {
    const map = new Map()
    map.set('A', { lastSeen: Date.now() - 400000 }) // >5min
    map.set('B', { lastSeen: Date.now() - 100000 }) // <5min
    cleanupPersistence(map)
    expect(map.has('A')).toBe(false)
    expect(map.has('B')).toBe(true)
  })

  it('enforces hard cap of 10000', () => {
    const map = new Map()
    const now = Date.now()
    for (let i = 0; i < 10500; i++) {
      map.set(`key${i}`, { lastSeen: now }) // all fresh
    }
    cleanupPersistence(map)
    expect(map.size).toBeLessThanOrEqual(10000)
  })
})

// ---- scoreWall ----
describe('scoreWall', () => {
  it('scores higher for closer walls', () => {
    const close = scoreWall({ anchorPrice: 100, sizeVsMedian: 10, status: 'new' }, 101)
    const far = scoreWall({ anchorPrice: 100, sizeVsMedian: 10, status: 'new' }, 110)
    expect(close).toBeGreaterThan(far)
  })

  it('scores higher for larger walls', () => {
    const big = scoreWall({ anchorPrice: 100, sizeVsMedian: 20, status: 'new' }, 101)
    const small = scoreWall({ anchorPrice: 100, sizeVsMedian: 5, status: 'new' }, 101)
    expect(big).toBeGreaterThan(small)
  })

  it('multiplies persistence bonus', () => {
    const base = scoreWall({ anchorPrice: 100, sizeVsMedian: 10, status: 'new' }, 101)
    const confirmed = scoreWall({ anchorPrice: 100, sizeVsMedian: 10, status: 'confirmed' }, 101)
    const strong = scoreWall({ anchorPrice: 100, sizeVsMedian: 10, status: 'strong' }, 101)
    expect(confirmed).toBeGreaterThan(base)
    expect(strong).toBeGreaterThan(confirmed)
  })

  it('caps sizeVsMedian at 50', () => {
    const capped = scoreWall({ anchorPrice: 100, sizeVsMedian: 100, status: 'new' }, 101)
    const at50 = scoreWall({ anchorPrice: 100, sizeVsMedian: 50, status: 'new' }, 101)
    expect(capped).toBe(at50)
  })
})

// ---- analyzeSymbol (integration) ----
describe('analyzeSymbol', () => {
  it('returns full analysis structure', () => {
    // Build fake order book: one big bid wall + uniform noise
    const bidLevels = []
    const askLevels = []
    const markPrice = 100

    // Normal noise levels
    for (let i = 0; i < 50; i++) {
      bidLevels.push({ price: 99 - i * 0.01, notional: 100, firstSeen: Date.now(), lastUpdate: Date.now() })
      askLevels.push({ price: 101 + i * 0.01, notional: 100, firstSeen: Date.now(), lastUpdate: Date.now() })
    }
    // Big bid wall at 99.5
    bidLevels.push({ price: 99.5, notional: 50000, firstSeen: Date.now(), lastUpdate: Date.now() })

    const result = analyzeSymbol({
      symbol: 'TESTUSDT',
      markPrice,
      bidLevels,
      askLevels,
      persistenceMap: new Map(),
      windowPct: 2,
      nSigma: 2
    })

    expect(result.symbol).toBe('TESTUSDT')
    expect(result.markPrice).toBe(100)
    expect(result.imbalance).toBeDefined()
    expect(result.imbalanceLabel).toMatch(/BULLISH|BEARISH|NEUTRAL/)
    expect(result.wallCount).toBeGreaterThanOrEqual(1)
    expect(result.support).not.toBeNull()
    expect(result.stats).toBeDefined()
    expect(result.stats.bucketSize).toBeGreaterThan(0)
  })

  it('returns null support/resistance when no walls', () => {
    // All levels identical → no outliers
    const levels = Array.from({ length: 10 }, (_, i) => ({
      price: 100 + i * 0.01, notional: 100, firstSeen: Date.now(), lastUpdate: Date.now()
    }))
    const result = analyzeSymbol({
      symbol: 'TESTUSDT',
      markPrice: 100.05,
      bidLevels: levels.filter(l => l.price < 100.05),
      askLevels: levels.filter(l => l.price >= 100.05),
      persistenceMap: new Map(),
    })
    expect(result.support).toBeNull()
    expect(result.resistance).toBeNull()
    expect(result.wallCount).toBe(0)
  })
})
