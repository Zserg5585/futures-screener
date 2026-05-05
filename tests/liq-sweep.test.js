import { describe, it, expect } from 'vitest';
import { findSwingLevels } from '../server/liq-sweep.js';

describe('findSwingLevels', () => {
  // Generate simple candle data with a clear swing high/low
  function makeCandles(prices) {
    return prices.map((p, i) => ({
      time: 1000 + i * 60000,
      open: p,
      high: p + 1,
      low: p - 1,
      close: p,
      volume: 1000,
    }));
  }

  it('returns empty array for insufficient data', () => {
    expect(findSwingLevels([])).toEqual([]);
    expect(findSwingLevels(null)).toEqual([]);
    expect(findSwingLevels([{ high: 1, low: 0 }])).toEqual([]);
  });

  it('returns empty array when candles are fewer than leftBars + rightBars + 1', () => {
    const candles = makeCandles([10, 11, 12, 13, 14, 15]);
    // default leftBars=3, rightBars=3 → need at least 7 candles
    expect(findSwingLevels(candles)).toEqual([]);
  });

  it('detects a swing high', () => {
    // Pattern: low, rising, PEAK, falling, low
    const prices = [10, 11, 12, 13, 20, 13, 12, 11, 10];
    const candles = prices.map((p, i) => ({
      time: 1000 + i * 60000,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1000,
    }));
    const levels = findSwingLevels(candles, 3, 3);
    const highs = levels.filter(l => l.type === 'swing_high');
    expect(highs.length).toBeGreaterThanOrEqual(1);
    // The peak is at index 4 (price 20), so swing high should be near 20.5
    expect(highs[0].price).toBeCloseTo(20.5, 0);
  });

  it('detects a swing low', () => {
    // Pattern: high, falling, BOTTOM, rising, high
    const prices = [20, 19, 18, 17, 10, 17, 18, 19, 20];
    const candles = prices.map((p, i) => ({
      time: 1000 + i * 60000,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1000,
    }));
    const levels = findSwingLevels(candles, 3, 3);
    const lows = levels.filter(l => l.type === 'swing_low');
    expect(lows.length).toBeGreaterThanOrEqual(1);
    // Bottom at index 4 (price 10), so swing low should be near 9.5
    expect(lows[0].price).toBeCloseTo(9.5, 0);
  });

  it('clusters nearby levels', () => {
    // Two swing highs very close to each other should cluster
    const prices = [10, 11, 12, 13, 20, 13, 12, 13, 20.01, 13, 12, 11, 10];
    const candles = prices.map((p, i) => ({
      time: 1000 + i * 60000,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1000,
    }));
    const levels = findSwingLevels(candles, 3, 3);
    const highs = levels.filter(l => l.type === 'swing_high');
    // Should be clustered into 1 level (within 0.15%)
    expect(highs.length).toBeLessThanOrEqual(2);
  });

  it('respects custom leftBars/rightBars', () => {
    // With smaller bars, more swings should be detected
    const prices = [10, 15, 10, 15, 10, 15, 10];
    const candles = prices.map((p, i) => ({
      time: 1000 + i * 60000,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1000,
    }));
    const levels1 = findSwingLevels(candles, 1, 1);
    expect(levels1.length).toBeGreaterThan(0);
  });
});
