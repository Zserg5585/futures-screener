// scorer.js - Density Trust Scoring v2 (x-multiplier based)

function analyzeBehavior(bin, markPrice, natr, avg5mVol) {
  const now = Date.now();
  const lifetimeMs = now - bin.oldestSeen;
  const lifetimeMins = lifetimeMs / 60000;
  const distancePct = Math.abs(bin.anchorPrice - markPrice) / markPrice * 100;

  // x-multiplier: how many times bigger is the wall vs avg 5min volume
  const xMult = avg5mVol > 0 ? bin.notional / avg5mVol : 0;

  let trustScore = 0;
  const tags = [];

  // === Base score from x-multiplier ===
  // x4 = 20pts, x8 = 40pts, x15 = 60pts, x30+ = 80pts
  trustScore = Math.min(80, xMult * 5);

  // === Distance bonus/penalty ===
  // Closer walls are more meaningful
  if (distancePct <= 0.5) {
    trustScore += 15; // Very close — imminent
    tags.push('CLOSE');
  } else if (distancePct <= 1.0) {
    trustScore += 10;
  } else if (distancePct > 3.0) {
    trustScore -= 15;
    tags.push('FAR');
  }
  if (distancePct > 5.0) {
    trustScore -= 20;
    tags.push('SPOOF-FAR');
  }

  // === Lifetime bonus ===
  if (lifetimeMins >= 15) {
    trustScore += 15;
    tags.push('CONCRETE');
  } else if (lifetimeMins >= 5) {
    trustScore += 8;
    tags.push('HOLDING');
  } else if (lifetimeMins < 0.5 && distancePct > 2.0) {
    trustScore -= 10;
    tags.push('NEW-FAR');
  }

  // === Robot aggressor ===
  if (bin.isMovingTowardPrice) {
    trustScore += 20;
    tags.push('ROBOT-AGGRESSOR');
  }

  // === NATR alignment ===
  if (natr > 0) {
    const isNearNatr1 = Math.abs(distancePct - natr) < 0.3;
    const isNearNatr2 = Math.abs(distancePct - natr * 2) < 0.3;
    if (isNearNatr1 || isNearNatr2) {
      trustScore += 10;
      tags.push('TECH-NATR');
    }
  }

  // === Severity label ===
  let severity = 'L'; // Low
  if (xMult >= 15) {
    severity = 'S'; // Strong
  } else if (xMult >= 8) {
    severity = 'M'; // Medium
  }

  // Cap 0-100
  trustScore = Math.max(0, Math.min(100, Math.round(trustScore)));

  return { trustScore, tags, lifetimeMins, distancePct, xMult, severity };
}

module.exports = { analyzeBehavior };
