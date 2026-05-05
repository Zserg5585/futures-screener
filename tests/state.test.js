import { describe, it, expect, beforeEach } from 'vitest';

// state.js exports a singleton instance
const sm = require('../server/state.js');

describe('StateManager', () => {
  beforeEach(() => {
    // Clear state between tests
    sm.books.clear();
    sm.binHistory.clear();
  });

  describe('initBook', () => {
    it('creates a book entry for a symbol', () => {
      sm.initBook('BTCUSDT', [['50000', '1.5']], [['50100', '2.0']]);
      expect(sm.books.has('BTCUSDT')).toBe(true);
    });

    it('stores bids and asks with notional values', () => {
      sm.initBook('BTCUSDT', [['50000', '1.5']], [['50100', '2.0']]);
      const book = sm.books.get('BTCUSDT');

      expect(book.bids.has(50000)).toBe(true);
      expect(book.bids.get(50000).notional).toBe(75000); // 50000 * 1.5

      expect(book.asks.has(50100)).toBe(true);
      expect(book.asks.get(50100).notional).toBe(100200); // 50100 * 2.0
    });

    it('sets firstSeen and lastUpdate timestamps', () => {
      const before = Date.now();
      sm.initBook('ETHUSDT', [['3000', '10']], []);
      const after = Date.now();

      const book = sm.books.get('ETHUSDT');
      const bid = book.bids.get(3000);
      expect(bid.firstSeen).toBeGreaterThanOrEqual(before);
      expect(bid.firstSeen).toBeLessThanOrEqual(after);
    });

    it('does not overwrite existing book', () => {
      sm.initBook('BTCUSDT', [['50000', '1']], []);
      sm.initBook('BTCUSDT', [['51000', '2']], []);

      const book = sm.books.get('BTCUSDT');
      // Both should exist since initBook adds to existing
      expect(book.bids.has(50000)).toBe(true);
      expect(book.bids.has(51000)).toBe(true);
    });
  });

  describe('processDelta', () => {
    beforeEach(() => {
      sm.initBook('BTCUSDT', [['50000', '1']], [['50100', '1']]);
      sm.books.get('BTCUSDT').lastUpdateId = 100;
    });

    it('ignores deltas with u <= lastUpdateId', () => {
      sm.processDelta('BTCUSDT', { u: 100, b: [['49000', '5']], a: [] });
      const book = sm.books.get('BTCUSDT');
      expect(book.bids.has(49000)).toBe(false);
    });

    it('applies bid updates', () => {
      sm.processDelta('BTCUSDT', { u: 101, b: [['49000', '3']], a: [] });
      const book = sm.books.get('BTCUSDT');
      expect(book.bids.has(49000)).toBe(true);
      expect(book.bids.get(49000).notional).toBe(147000); // 49000 * 3
    });

    it('removes levels with qty=0', () => {
      sm.processDelta('BTCUSDT', { u: 101, b: [['50000', '0']], a: [] });
      const book = sm.books.get('BTCUSDT');
      expect(book.bids.has(50000)).toBe(false);
    });

    it('updates existing level notional without changing firstSeen', () => {
      const book = sm.books.get('BTCUSDT');
      const originalFirstSeen = book.bids.get(50000).firstSeen;

      sm.processDelta('BTCUSDT', { u: 101, b: [['50000', '5']], a: [] });

      expect(book.bids.get(50000).notional).toBe(250000); // 50000 * 5
      expect(book.bids.get(50000).firstSeen).toBe(originalFirstSeen);
    });

    it('ignores delta for unknown symbol', () => {
      // Should not throw
      sm.processDelta('UNKNOWN', { u: 200, b: [['100', '1']], a: [] });
    });
  });
});
