const detector = require('./detector');
const binanceApi = require('../binance/api');

module.exports = {
  densities: new Map(),
  events: [],
  async scan(params) {
    const currentDensities = await detector.scan(params);
    const now = Date.now();

    // For each density, get current price and compute distance
    for (const density of currentDensities) {
      try {
        const { price } = await binanceApi.getMarkPrice(density.symbol);
        if (price) {
          density.currentPrice = price;
          density.distanceFromPricePct = Math.abs(price - density.price) / price;
          density.distanceFromPriceAbs = Math.abs(price - density.price);
        } else {
          // fallback: mark as null so filter can skip
          density.currentPrice = null;
          density.distanceFromPricePct = null;
          density.distanceFromPriceAbs = null;
        }
      } catch (e) {
        density.currentPrice = null;
        density.distanceFromPricePct = null;
        density.distanceFromPriceAbs = null;
      }
    }

    // Existing density tracking logic (simplified)
    for (const density of currentDensities) {
      const key = `${density.symbol}_${density.side}_${density.bucketedPrice}`;
      const prev = this.densities.get(key);

      if (!prev) {
        // APPEARED
        this.densities.set(key, { ...density, firstSeenAt: now, lastSeenAt: now, state: 'APPEARED', lifetimeSec: 0 });
        this.events.push({ ...density, event: 'APPEARED', timestamp: now });
      } else {
        // UPDATED or MOVED
        const deltaNotional = Math.abs(density.notional - prev.notional);
        const deltaT = (now - prev.lastSeenAt) / 1000;
        const eatSpeedUSDTperSec = deltaNotional / deltaT;

        this.densities.set(key, {
          ...density,
          state: 'UPDATED',
          lastSeenAt: now,
          lifetimeSec: (now - prev.firstSeenAt) / 1000,
          eatSpeedUSDTperSec,
          impactRatio: density.impactRatio
        });

        if (Math.abs(density.price - prev.price) / prev.price > 0.0003) {
          this.events.push({ ...density, event: 'MOVED', timestamp: now });
        } else {
          this.events.push({ ...density, event: 'UPDATED', timestamp: now });
        }
      }
    }

    return currentDensities;
  }
};