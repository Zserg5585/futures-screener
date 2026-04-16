// scorer.js - Trust Scoring & Behavior Classification

function analyzeBehavior(bin, markPrice, natr) {
  // bin: { anchorPrice, startPrice, endPrice, notional, oldestSeen, newestUpdate, levels: [] }
  const now = Date.now();
  const lifetimeMs = now - bin.oldestSeen;
  const lifetimeMins = lifetimeMs / 60000;
  const distancePct = Math.abs(bin.anchorPrice - markPrice) / markPrice * 100;
  
  let trustScore = 50; // Base neutral score
  let tags = [];

  // 1. Penalties (Spoofers)
  // Distance penalty
  if (distancePct > 5.0 || (natr > 0 && distancePct > natr * 2)) {
    trustScore -= 30;
    tags.push('SPOOF-FAR');
  }

  // To do proper Flickering detection, we need historical bins. 
  // For now, if it's very new and very large but far away, it's suspect.
  if (lifetimeMins < 0.5 && distancePct > 2.0) {
    trustScore -= 20;
    tags.push('NEW-FAR');
  }

  // 2. Bonuses (True Liquidity)
  if (lifetimeMins >= 5) {
    trustScore += 20;
    tags.push('CONCRETE-5M');
  }
  if (lifetimeMins >= 15) {
    trustScore += 20;
    tags.push('CONCRETE-15M');
  }

  // 3. Technical Alignment
  // Example: If distance is exactly near a 1x NATR or 2x NATR psychological level
  if (natr > 0) {
    const isNearNatr1 = Math.abs(distancePct - natr) < 0.2;
    const isNearNatr2 = Math.abs(distancePct - natr * 2) < 0.2;
    if (isNearNatr1 || isNearNatr2) {
      trustScore += 15;
      tags.push('TECH-NATR');
    }
  }

  // Robot / Aggressor tracking needs delta tracking across bins over time.
  // We will pass in a historical flag from the state manager if we detected movement
  if (bin.isMovingTowardPrice) {
    trustScore += 30; // Very positive pattern
    tags.push('ROBOT-AGGRESSOR');
  }

  // Cap score 0-100
  trustScore = Math.max(0, Math.min(100, trustScore));

  return { trustScore, tags, lifetimeMins, distancePct };
}

module.exports = {
  analyzeBehavior
};
