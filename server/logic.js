function binLevels(levels, binSizePct) {
  if (!levels || levels.length === 0) return [];
  
  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const bins = [];
  
  // We use the first level in a bin as the anchor.
  let currentBin = {
    anchorPrice: sorted[0].price,
    startPrice: sorted[0].price,
    endPrice: sorted[0].price,
    notional: sorted[0].notional,
    levelsCount: 1,
    oldestSeen: sorted[0].firstSeen,
    newestUpdate: sorted[0].lastUpdate,
    levels: [sorted[0]] // Keep track if we need granular details later
  };
  
  for (let i = 1; i < sorted.length; i++) {
    const level = sorted[i];
    const distFromAnchor = Math.abs(level.price - currentBin.anchorPrice) / currentBin.anchorPrice * 100;
    
    if (distFromAnchor <= binSizePct) {
      // Add to current bin
      currentBin.endPrice = level.price;
      currentBin.notional += level.notional;
      currentBin.levelsCount++;
      currentBin.oldestSeen = Math.min(currentBin.oldestSeen, level.firstSeen);
      currentBin.newestUpdate = Math.max(currentBin.newestUpdate, level.lastUpdate);
      currentBin.levels.push(level);
    } else {
      // Finish current bin, start new one
      bins.push(currentBin);
      currentBin = {
        anchorPrice: level.price,
        startPrice: level.price,
        endPrice: level.price,
        notional: level.notional,
        levelsCount: 1,
        oldestSeen: level.firstSeen,
        newestUpdate: level.lastUpdate,
        levels: [level]
      };
    }
  }
  
  bins.push(currentBin);
  return bins;
}

module.exports = {
  binLevels
};
