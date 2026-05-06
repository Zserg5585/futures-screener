import { describe, it, expect } from 'vitest'
import {
  detectPinBar,
  confirmSweep,
  scoreConfidence,
  findRoundNumbers,
  mergeLevels,
  clusterLevels,
} from '../server/liq-sweep.js'

// ---- detectPinBar ----
describe('detectPinBar', () => {
  it('detects bullish pin bar (long lower wick)', () => {
    // open=100, high=101, low=90, close=100.5
    // range=11, lowerWick=10, body=0.5
    const candle = { open: 100, high: 101, low: 90, close: 100.5 }
    const result = detectPinBar(candle)
    expect(result).not.toBeNull()
    expect(result.direction).toBe('LONG')
    expect(result.wickRatio).toBeGreaterThan(0.6)
    expect(result.bodyRatio).toBeLessThan(0.33)
  })

  it('detects bearish pin bar (long upper wick)', () => {
    // open=100, high=111, low=99.5, close=100
    // range=11.5, upperWick=11, body=0
    const candle = { open: 100, high: 111, low: 99.5, close: 100 }
    const result = detectPinBar(candle)
    expect(result).not.toBeNull()
    expect(result.direction).toBe('SHORT')
    expect(result.wickRatio).toBeGreaterThan(0.6)
  })

  it('returns null for doji (no significant wick)', () => {
    const candle = { open: 100, high: 100.5, low: 99.5, close: 100.1 }
    const result = detectPinBar(candle)
    expect(result).toBeNull()
  })

  it('returns null for big body candle', () => {
    // body is most of range
    const candle = { open: 90, high: 101, low: 89, close: 100 }
    const result = detectPinBar(candle)
    expect(result).toBeNull()
  })

  it('returns null for zero-range candle', () => {
    const candle = { open: 100, high: 100, low: 100, close: 100 }
    expect(detectPinBar(candle)).toBeNull()
  })

  it('returns null for null input', () => {
    expect(detectPinBar(null)).toBeNull()
  })

  it('filters tiny candles when prevCandles provided', () => {
    // Previous candles have range ~10, but this candle has range ~1 (noise)
    const prevCandles = [
      { high: 110, low: 100 },
      { high: 112, low: 101 },
      { high: 109, low: 99 },
    ]
    // Tiny candle with pin bar shape but too small range
    const candle = { open: 100, high: 100.3, low: 99, close: 100.2 }
    const result = detectPinBar(candle, prevCandles)
    expect(result).toBeNull()
  })

  it('allows custom wick/body ratios', () => {
    // Candle with 50% wick — normally not enough, but with lowered threshold
    const candle = { open: 100, high: 100.5, low: 95, close: 100 }
    // range=5.5, lowerWick=5, bodyRatio=0 — wick is ~0.91
    const strict = detectPinBar(candle, [], { wickMinRatio: 0.95 })
    const relaxed = detectPinBar(candle, [], { wickMinRatio: 0.5 })
    expect(strict).toBeNull()
    expect(relaxed).not.toBeNull()
  })
})

// ---- confirmSweep ----
describe('confirmSweep', () => {
  it('confirms bullish sweep (wick below level, close above)', () => {
    // low=98.5, level=99 → penetration = (99-98.5)/99*100 = 0.505% (within 1.5%)
    const candle = { open: 100, high: 101, low: 98.5, close: 100.5 }
    const pinBar = { direction: 'LONG' }
    const levels = [
      { price: 99, type: 'swing_low', strength: 5, source: 'swing' },
    ]
    const result = confirmSweep(candle, pinBar, levels)
    expect(result).not.toBeNull()
    expect(result.sweptLevel).toBe(99)
    expect(result.levelType).toBe('swing_low')
    expect(result.sweepDepthPct).toBeGreaterThan(0)
    expect(result.sweepDepthPct).toBeLessThanOrEqual(1.5)
    expect(result.levelsSwept).toBe(1)
  })

  it('confirms bearish sweep (wick above level, close below)', () => {
    // high=101.5, level=101 → penetration = (101.5-101)/101*100 = 0.495%
    const candle = { open: 100, high: 101.5, low: 99.5, close: 99.8 }
    const pinBar = { direction: 'SHORT' }
    const levels = [
      { price: 101, type: 'swing_high', strength: 7, source: 'swing' },
    ]
    const result = confirmSweep(candle, pinBar, levels)
    expect(result).not.toBeNull()
    expect(result.sweptLevel).toBe(101)
    expect(result.sweepDepthPct).toBeGreaterThan(0)
    expect(result.sweepDepthPct).toBeLessThanOrEqual(1.5)
  })

  it('returns null when no levels swept', () => {
    const candle = { open: 100, high: 101, low: 99, close: 100.5 }
    const pinBar = { direction: 'LONG' }
    const levels = [
      { price: 90, type: 'swing_low', strength: 5, source: 'swing' }, // too far below
    ]
    expect(confirmSweep(candle, pinBar, levels)).toBeNull()
  })

  it('picks strongest level when multiple swept', () => {
    // low=98, levels at 99 and 98.5 → penetration < 1.5% for both
    const candle = { open: 100, high: 101, low: 98, close: 100.5 }
    const pinBar = { direction: 'LONG' }
    const levels = [
      { price: 99, type: 'swing_low', strength: 3, source: 'swing' },
      { price: 98.5, type: 'round_number', strength: 8, source: 'round' },
    ]
    const result = confirmSweep(candle, pinBar, levels)
    expect(result).not.toBeNull()
    expect(result.strength).toBe(8) // picks the stronger level
    expect(result.levelsSwept).toBe(2)
  })

  it('rejects too-deep penetration', () => {
    const candle = { open: 100, high: 101, low: 80, close: 100.5 }
    const pinBar = { direction: 'LONG' }
    const levels = [
      { price: 97, type: 'swing_low', strength: 5, source: 'swing' },
    ]
    // penetration = (97 - 80) / 97 * 100 = 17.5% — way over default 1.5%
    expect(confirmSweep(candle, pinBar, levels)).toBeNull()
  })

  it('returns null for null/empty inputs', () => {
    expect(confirmSweep(null, null, [])).toBeNull()
    expect(confirmSweep({}, { direction: 'LONG' }, [])).toBeNull()
  })
})

// ---- scoreConfidence ----
describe('scoreConfidence', () => {
  it('returns base score for minimal input', () => {
    const score = scoreConfidence({ wickRatio: 0.6, levelStrength: 1 })
    expect(score).toBeGreaterThanOrEqual(30)
    expect(score).toBeLessThanOrEqual(95)
  })

  it('increases with better wick ratio', () => {
    const low = scoreConfidence({ wickRatio: 0.6 })
    const high = scoreConfidence({ wickRatio: 0.9 })
    expect(high).toBeGreaterThan(low)
  })

  it('increases with stronger level', () => {
    const weak = scoreConfidence({ levelStrength: 1 })
    const strong = scoreConfidence({ levelStrength: 10 })
    expect(strong).toBeGreaterThan(weak)
  })

  it('increases with volume spike', () => {
    const noVol = scoreConfidence({ volumeRatio: null })
    const volSpike = scoreConfidence({ volumeRatio: 5 })
    expect(volSpike).toBeGreaterThan(noVol)
  })

  it('increases with OI drop', () => {
    const noOi = scoreConfidence({ oiChangePct: null })
    const oiDrop = scoreConfidence({ oiChangePct: -2 })
    expect(oiDrop).toBeGreaterThan(noOi)
  })

  it('increases with counter-trend context', () => {
    const none = scoreConfidence({ trendContext: null })
    const counter = scoreConfidence({ trendContext: 'counter' })
    expect(counter).toBeGreaterThan(none)
  })

  it('increases with wall absorbed', () => {
    const no = scoreConfidence({ wallAbsorbed: false })
    const yes = scoreConfidence({ wallAbsorbed: true })
    expect(yes).toBeGreaterThan(no)
  })

  it('clamps to 30-95 range', () => {
    // Minimum possible
    const min = scoreConfidence({ wickRatio: 0.6, levelStrength: 0 })
    expect(min).toBeGreaterThanOrEqual(30)

    // Maximum possible — all bonuses
    const max = scoreConfidence({
      wickRatio: 0.95,
      levelStrength: 10,
      levelsSwept: 3,
      volumeRatio: 10,
      oiChangePct: -5,
      trendContext: 'counter',
      fundingContext: 'extreme',
      wallAbsorbed: true,
    })
    expect(max).toBeLessThanOrEqual(95)
  })
})

// ---- findRoundNumbers ----
describe('findRoundNumbers', () => {
  it('returns round levels near BTC price', () => {
    const levels = findRoundNumbers(60500, 2)
    expect(levels.length).toBeGreaterThan(0)
    // Should include 60000 and 61000
    const prices = levels.map(l => l.price)
    expect(prices).toContain(60000)
    expect(prices).toContain(61000)
  })

  it('assigns higher strength to full round levels', () => {
    const levels = findRoundNumbers(60500, 2)
    const full = levels.find(l => l.price === 60000)
    const half = levels.find(l => l.price === 60500)
    expect(full.strength).toBeGreaterThan(half.strength)
  })

  it('handles small altcoin prices', () => {
    const levels = findRoundNumbers(1.5, 2)
    expect(levels.length).toBeGreaterThan(0)
    levels.forEach(l => {
      expect(l.type).toBe('round_number')
      expect(l.source).toBe('round')
    })
  })

  it('returns empty for zero/negative price', () => {
    expect(findRoundNumbers(0)).toEqual([])
    expect(findRoundNumbers(-10)).toEqual([])
  })

  it('respects windowPct', () => {
    const narrow = findRoundNumbers(60500, 0.5)
    const wide = findRoundNumbers(60500, 5)
    expect(wide.length).toBeGreaterThan(narrow.length)
  })
})

// ---- mergeLevels ----
describe('mergeLevels', () => {
  it('merges levels within 0.15% keeping stronger', () => {
    const levels = [
      { price: 100.00, strength: 3, type: 'swing_low' },
      { price: 100.10, strength: 7, type: 'round_number' }, // within 0.1%
    ]
    const merged = mergeLevels(levels)
    expect(merged.length).toBe(1)
    expect(merged[0].strength).toBe(7) // kept stronger
  })

  it('keeps distant levels separate', () => {
    const levels = [
      { price: 100, strength: 3, type: 'swing_low' },
      { price: 105, strength: 5, type: 'swing_high' },
    ]
    const merged = mergeLevels(levels)
    expect(merged.length).toBe(2)
  })

  it('returns empty for empty input', () => {
    expect(mergeLevels([])).toEqual([])
  })

  it('handles single level', () => {
    const levels = [{ price: 100, strength: 5, type: 'swing_low' }]
    const merged = mergeLevels(levels)
    expect(merged.length).toBe(1)
  })
})

// ---- clusterLevels ----
describe('clusterLevels', () => {
  it('clusters nearby same-type swings', () => {
    const raws = [
      { price: 100, type: 'swing_high', time: 1000, volume: 100 },
      { price: 100.1, type: 'swing_high', time: 2000, volume: 200 },
    ]
    const result = clusterLevels(raws, 0.0015)
    expect(result.length).toBe(1)
    expect(result[0].touches).toBe(2)
    expect(result[0].price).toBe(100.1) // freshest
  })

  it('does not cluster different types', () => {
    const raws = [
      { price: 100, type: 'swing_high', time: 1000, volume: 100 },
      { price: 100.1, type: 'swing_low', time: 2000, volume: 200 },
    ]
    const result = clusterLevels(raws, 0.0015)
    expect(result.length).toBe(2)
  })

  it('returns empty for empty input', () => {
    expect(clusterLevels([], 0.0015)).toEqual([])
  })

  it('strength increases with touches', () => {
    const raws = [
      { price: 100, type: 'swing_high', time: 1000, volume: 100 },
      { price: 100.05, type: 'swing_high', time: 2000, volume: 100 },
      { price: 100.1, type: 'swing_high', time: 3000, volume: 100 },
    ]
    const result = clusterLevels(raws, 0.0015)
    expect(result[0].touches).toBe(3)
    expect(result[0].strength).toBe(7) // min(10, 3*2+1)
  })
})
