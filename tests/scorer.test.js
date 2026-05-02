import { describe, it, expect } from 'vitest';
import { analyzeBehavior } from '../server/scorer.js';

describe('analyzeBehavior', () => {
  const baseBin = {
    anchorPrice: 100,
    notional: 50000,
    oldestSeen: Date.now() - 20 * 60000, // 20 min ago
    isMovingTowardPrice: false,
  };

  it('returns trustScore between 0 and 100', () => {
    const result = analyzeBehavior(baseBin, 100.5, 1.5, 5000);
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
    expect(result.trustScore).toBeLessThanOrEqual(100);
  });

  it('higher xMult gives higher score', () => {
    const small = analyzeBehavior({ ...baseBin, notional: 10000 }, 100, 1, 5000); // x2
    const large = analyzeBehavior({ ...baseBin, notional: 100000 }, 100, 1, 5000); // x20
    expect(large.trustScore).toBeGreaterThan(small.trustScore);
  });

  it('close walls get CLOSE tag', () => {
    const result = analyzeBehavior(baseBin, 100.3, 1, 5000); // 0.3% away
    expect(result.tags).toContain('CLOSE');
  });

  it('far walls get FAR tag', () => {
    const result = analyzeBehavior({ ...baseBin, anchorPrice: 96 }, 100, 1, 5000); // 4% away
    expect(result.tags).toContain('FAR');
  });

  it('old walls get CONCRETE tag', () => {
    const oldBin = { ...baseBin, oldestSeen: Date.now() - 30 * 60000 }; // 30 min
    const result = analyzeBehavior(oldBin, 100, 1, 5000);
    expect(result.tags).toContain('CONCRETE');
  });

  it('robot aggressor gets bonus', () => {
    const normal = analyzeBehavior(baseBin, 100, 1, 5000);
    const robot = analyzeBehavior({ ...baseBin, isMovingTowardPrice: true }, 100, 1, 5000);
    expect(robot.trustScore).toBeGreaterThan(normal.trustScore);
    expect(robot.tags).toContain('ROBOT-AGGRESSOR');
  });

  it('severity S for xMult >= 15', () => {
    const result = analyzeBehavior({ ...baseBin, notional: 80000 }, 100, 1, 5000); // x16
    expect(result.severity).toBe('S');
  });

  it('severity M for xMult >= 8', () => {
    const result = analyzeBehavior({ ...baseBin, notional: 45000 }, 100, 1, 5000); // x9
    expect(result.severity).toBe('M');
  });

  it('severity L for xMult < 8', () => {
    const result = analyzeBehavior({ ...baseBin, notional: 15000 }, 100, 1, 5000); // x3
    expect(result.severity).toBe('L');
  });
});
