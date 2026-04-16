class StateManager {
  constructor() {
    // symbol -> Map<price, {notional, firstSeen, lastUpdate, isMM}>
    this.books = new Map();

    // Cache to track dynamically created bins over time to detect robots
    // cacheKey: "SYMBOL:SIDE:BIN_ANCHOR" -> { oldestSeen, maxNotional, lastUpdate, isMovingTowardPrice }
    this.binHistory = new Map();
  }

  initBook(symbol, bids, asks) {
    if (!this.books.has(symbol)) {
      this.books.set(symbol, {
        bids: new Map(),
        asks: new Map(),
        lastUpdateId: 0
      });
    }

    const state = this.books.get(symbol);
    const now = Date.now();

    bids.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const notional = price * parseFloat(qtyStr);
      state.bids.set(price, { notional, firstSeen: now, lastUpdate: now });
    });

    asks.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const notional = price * parseFloat(qtyStr);
      state.asks.set(price, { notional, firstSeen: now, lastUpdate: now });
    });
  }

  processDelta(symbol, payload) {
    if (!this.books.has(symbol)) return;

    const state = this.books.get(symbol);
    
    // Binance sequence check (U <= lastUpdateId+1 AND u >= lastUpdateId+1)
    // Simplified for now: just apply deltas blindly for simplicity if not strictly syncing
    // To do strict sync: Drop out-of-order and fetch snapshot again
    if (payload.u <= state.lastUpdateId) return;

    const now = Date.now();

    // Process Bids
    payload.b.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      if (qty === 0) {
        state.bids.delete(price);
      } else {
        const notional = price * qty;
        const existing = state.bids.get(price);
        if (existing) {
          existing.notional = notional;
          existing.lastUpdate = now;
        } else {
          state.bids.set(price, { notional, firstSeen: now, lastUpdate: now });
        }
      }
    });

    // Process Asks
    payload.a.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      if (qty === 0) {
        state.asks.delete(price);
      } else {
        const notional = price * qty;
        const existing = state.asks.get(price);
        if (existing) {
          existing.notional = notional;
          existing.lastUpdate = now;
        } else {
          state.asks.set(price, { notional, firstSeen: now, lastUpdate: now });
        }
      }
    });

    state.lastUpdateId = payload.u;
  }

  getTopLevels(symbol, side, markPrice, minNotional, limit, windowPct) {
    if (!this.books.has(symbol)) return [];
    
    const state = this.books.get(symbol);
    const bookSide = side === 'bid' ? state.bids : state.asks;

    const ArrayOfLevels = [];
    const minPrice = markPrice * (1 - windowPct / 100);
    const maxPrice = markPrice * (1 + windowPct / 100);

    for (const [price, data] of bookSide.entries()) {
      if (price >= minPrice && price <= maxPrice && data.notional >= minNotional) {
        const distancePct = Math.abs(price - markPrice) / markPrice * 100;
        ArrayOfLevels.push({
          price,
          notional: data.notional,
          firstSeen: data.firstSeen,
          lastUpdate: data.lastUpdate,
          distancePct
        });
      }
    }

    // Sort heavily heavily heavily
    ArrayOfLevels.sort((a, b) => b.notional - a.notional);
    return ArrayOfLevels.slice(0, limit);
  }

  // --- Historical Bin Tracking for Robot Aggressor Detection ---
  trackAndEnrichBins(symbol, side, currentBins, markPrice) {
    const now = Date.now();
    const enrichedBins = [];
    const sideLabel = side.toUpperCase();

    // Size tolerance to consider two bins as "the same order moving"
    const NOTIONAL_TOLERANCE = 0.8; // current bin must be at least 80% of old bin

    for (const bin of currentBins) {
      const cacheKey = `${symbol}:${sideLabel}:${bin.anchorPrice}`;
      let history = this.binHistory.get(cacheKey);
      let isMovingTowardPrice = false;

      if (!history) {
        // Did it move from a previously active bin slightly further away?
        for (const [k, v] of this.binHistory.entries()) {
          // Check if same symbol and side
          if (k.startsWith(`${symbol}:${sideLabel}:`)) {
            const oldPrice = parseFloat(k.split(':')[2]);
            const distBetweenPrices = Math.abs(bin.anchorPrice - oldPrice) / oldPrice * 100;

            // Only consider recent bins (updated in last 5 seconds) 
            // that are within a small distance (0.5%) and have similar notional
            if (distBetweenPrices > 0 && distBetweenPrices < 0.5 && (now - v.lastUpdate) < 5000) {
              const oldDistToMark = Math.abs(oldPrice - markPrice);
              const newDistToMark = Math.abs(bin.anchorPrice - markPrice);

              // It moved closer to the mark price
              if (newDistToMark < oldDistToMark && bin.notional >= v.maxNotional * NOTIONAL_TOLERANCE) {
                isMovingTowardPrice = true;
                // Inherit history, rename key
                history = { ...v, lastUpdate: now, isMovingTowardPrice: true };
                this.binHistory.delete(k);
                break;
              }
            }
          }
        }

        if (!history) {
          // Completely new bin
          history = {
            oldestSeen: bin.oldestSeen || now,
            maxNotional: bin.notional,
            lastUpdate: now,
            isMovingTowardPrice: false
          };
        }
      } else {
        // Bin exists at this exact price, update it
        history.lastUpdate = now;
        if (bin.notional > history.maxNotional) {
          history.maxNotional = bin.notional;
        }
      }

      this.binHistory.set(cacheKey, history);

      enrichedBins.push({
        ...bin,
        oldestSeen: history.oldestSeen, // Use the history oldest time
        isMovingTowardPrice: history.isMovingTowardPrice
      });
    }

    // Cleanup very old bins (not seen in 1 minute)
    if (Math.random() < 0.05) { // Run randomly ~5% of calls to save CPU
      for (const [k, v] of this.binHistory.entries()) {
        if (now - v.lastUpdate > 60000) {
          this.binHistory.delete(k);
        }
      }
    }

    return enrichedBins;
  }
}

module.exports = new StateManager();
