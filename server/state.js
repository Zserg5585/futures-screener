class StateManager {
  constructor() {
    // symbol -> Map<price, {notional, firstSeen, lastUpdate, isMM}>
    this.books = new Map();

    // Hard cap: max symbols in books (prevents unbounded memory growth)
    this.MAX_BOOKS = 600;
    // Hard cap: max levels per side per symbol
    this.MAX_LEVELS_PER_SIDE = 2000;

    // Resync callback: called when order book goes out-of-sync
    // Set via setResyncHandler(fn(symbol))
    this._resyncHandler = null;
    // Throttle: don't resync the same symbol more than once per 30s
    this._resyncCooldowns = new Map();

    // Cache to track dynamically created bins over time to detect robots
    // cacheKey: "SYMBOL:SIDE:BIN_ANCHOR" -> { oldestSeen, maxNotional, lastUpdate, isMovingTowardPrice }
    this.binHistory = new Map();
  }

  setResyncHandler(fn) {
    this._resyncHandler = fn;
  }

  initBook(symbol, bids, asks) {
    // Evict oldest book if at capacity
    if (!this.books.has(symbol) && this.books.size >= this.MAX_BOOKS) {
      let oldestSym = null, oldestTime = Infinity;
      for (const [sym, st] of this.books.entries()) {
        const t = st._lastActivity || 0;
        if (t < oldestTime) { oldestTime = t; oldestSym = sym; }
      }
      if (oldestSym) this.books.delete(oldestSym);
    }

    if (!this.books.has(symbol)) {
      this.books.set(symbol, {
        bids: new Map(),
        asks: new Map(),
        lastUpdateId: 0,
        _lastActivity: Date.now()
      });
    }

    const state = this.books.get(symbol);
    const now = Date.now();
    state._lastActivity = now;

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

  removeBook(symbol) {
    this.books.delete(symbol);
  }

  processDelta(symbol, payload) {
    if (!this.books.has(symbol)) return;

    const state = this.books.get(symbol);

    // Binance sequence: payload.U = first updateId, payload.u = last updateId
    // Drop stale deltas
    if (payload.u <= state.lastUpdateId) return;

    // Gap detection: if first updateId of this delta > lastUpdateId+1, we missed deltas
    if (state.lastUpdateId > 0 && payload.U > state.lastUpdateId + 1) {
      const now = Date.now();
      const cooldown = this._resyncCooldowns.get(symbol) || 0;
      if (this._resyncHandler && now - cooldown > 30000) {
        this._resyncCooldowns.set(symbol, now);
        console.log(`[state] Gap detected for ${symbol}: expected ${state.lastUpdateId + 1}, got ${payload.U}. Requesting resync.`);
        // Fire-and-forget — resync will call initBook which resets state
        this._resyncHandler(symbol);
      }
      return; // Drop this delta — book is stale until resync
    }

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

    state._lastActivity = now;

    // Cleanup stale price levels not updated in 2 minutes
    if (!state._lastCleanup || now - state._lastCleanup > 60000) {
      state._lastCleanup = now;
      const staleMs = 120000;
      for (const [price, data] of state.bids.entries()) {
        if (now - data.lastUpdate > staleMs) state.bids.delete(price);
      }
      for (const [price, data] of state.asks.entries()) {
        if (now - data.lastUpdate > staleMs) state.asks.delete(price);
      }
      // Hard cap: trim to MAX_LEVELS_PER_SIDE by removing smallest notional
      for (const side of [state.bids, state.asks]) {
        if (side.size > this.MAX_LEVELS_PER_SIDE) {
          const sorted = [...side.entries()].sort((a, b) => a[1].notional - b[1].notional);
          const toRemove = sorted.slice(0, side.size - this.MAX_LEVELS_PER_SIDE);
          for (const [price] of toRemove) side.delete(price);
        }
      }
    }
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

    // Cleanup very old bins (not seen in 1 minute) — deterministic, every 30s
    if (!this._lastBinCleanup || now - this._lastBinCleanup > 30000) {
      this._lastBinCleanup = now;
      for (const [k, v] of this.binHistory.entries()) {
        if (now - v.lastUpdate > 60000) {
          this.binHistory.delete(k);
        }
      }
      // Hard cap: if map still too large, drop oldest entries
      if (this.binHistory.size > 5000) {
        const sorted = [...this.binHistory.entries()].sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);
        const toRemove = sorted.slice(0, sorted.length - 4000);
        for (const [k] of toRemove) this.binHistory.delete(k);
      }
    }

    return enrichedBins;
  }
}

module.exports = new StateManager();
