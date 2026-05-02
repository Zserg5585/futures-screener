import { describe, it, expect } from 'vitest';
import { binLevels } from '../server/logic.js';

describe('binLevels', () => {
  it('returns empty array for empty input', () => {
    expect(binLevels([], 0.5)).toEqual([]);
    expect(binLevels(null, 0.5)).toEqual([]);
  });

  it('groups levels within binSize into one bin', () => {
    const levels = [
      { price: 100, notional: 5000, firstSeen: 1000, lastUpdate: 2000 },
      { price: 100.3, notional: 3000, firstSeen: 1100, lastUpdate: 2100 },
      { price: 100.4, notional: 2000, firstSeen: 1200, lastUpdate: 2200 },
    ];
    const bins = binLevels(levels, 0.5); // 0.5% bin
    expect(bins).toHaveLength(1);
    expect(bins[0].notional).toBe(10000);
    expect(bins[0].levelsCount).toBe(3);
  });

  it('splits levels beyond binSize into separate bins', () => {
    const levels = [
      { price: 100, notional: 5000, firstSeen: 1000, lastUpdate: 2000 },
      { price: 102, notional: 3000, firstSeen: 1100, lastUpdate: 2100 }, // 2% away
    ];
    const bins = binLevels(levels, 0.5);
    expect(bins).toHaveLength(2);
    expect(bins[0].notional).toBe(5000);
    expect(bins[1].notional).toBe(3000);
  });

  it('tracks oldest and newest timestamps', () => {
    const levels = [
      { price: 50, notional: 1000, firstSeen: 500, lastUpdate: 600 },
      { price: 50.1, notional: 2000, firstSeen: 300, lastUpdate: 800 },
    ];
    const bins = binLevels(levels, 1);
    expect(bins[0].oldestSeen).toBe(300);
    expect(bins[0].newestUpdate).toBe(800);
  });

  it('single level produces single bin', () => {
    const levels = [{ price: 42000, notional: 100000, firstSeen: 0, lastUpdate: 1 }];
    const bins = binLevels(levels, 0.05);
    expect(bins).toHaveLength(1);
    expect(bins[0].anchorPrice).toBe(42000);
  });
});
