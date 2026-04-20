// densityV2.js — Statistical Walls + Bid/Ask Imbalance + Persistence
// Variant C: Hybrid Screener
//
// Algorithm:
// 1. Fetch order book (from stateManager WS data)
// 2. Adaptive bucketing: bucket_size = price × 0.05%
// 3. Statistical wall detection: volume > median + 2×stddev
// 4. Cluster adjacent flagged buckets into zones
// 5. Score: (size / median) × proximity × persistence
// 6. Bid/Ask Imbalance in ±2% window
// 7. Output: nearest support + nearest resistance per symbol

/**
 * Adaptive bucket size based on price
 * BTC ($67K) → ~$33 buckets
 * ETH ($3.5K) → ~$1.75 buckets
 * Small alt ($0.05) → ~$0.000025 buckets
 */
function getBucketSize(price) {
  return price * 0.0005 // 0.05%
}

/**
 * Bucket raw order book levels into price zones
 * @param {Array} levels - [{price, notional, firstSeen, lastUpdate}]
 * @param {number} bucketSize - absolute price bucket size
 * @returns {Array} [{anchorPrice, totalNotional, levelCount, minPrice, maxPrice, oldestSeen}]
 */
function bucketLevels(levels, bucketSize) {
  if (!levels || levels.length === 0) return []

  const bucketMap = new Map() // bucketIndex -> aggregated data

  for (const level of levels) {
    const bucketIdx = Math.floor(level.price / bucketSize)
    const anchorPrice = (bucketIdx + 0.5) * bucketSize // center of bucket

    if (!bucketMap.has(bucketIdx)) {
      bucketMap.set(bucketIdx, {
        anchorPrice,
        totalNotional: 0,
        levelCount: 0,
        minPrice: level.price,
        maxPrice: level.price,
        oldestSeen: level.firstSeen || Date.now(),
        newestUpdate: level.lastUpdate || Date.now()
      })
    }

    const bucket = bucketMap.get(bucketIdx)
    bucket.totalNotional += level.notional
    bucket.levelCount++
    bucket.minPrice = Math.min(bucket.minPrice, level.price)
    bucket.maxPrice = Math.max(bucket.maxPrice, level.price)
    bucket.oldestSeen = Math.min(bucket.oldestSeen, level.firstSeen || Date.now())
    bucket.newestUpdate = Math.max(bucket.newestUpdate, level.lastUpdate || Date.now())
  }

  return Array.from(bucketMap.values())
}

/**
 * Detect statistical outlier walls from bucketed data
 * Wall = bucket where notional > median + N×stddev
 * @param {Array} buckets - from bucketLevels()
 * @param {number} nSigma - number of standard deviations (default 2)
 * @returns {Object} {walls: [], median, stddev, threshold}
 */
function detectWalls(buckets, nSigma = 2.0) {
  if (!buckets || buckets.length < 3) return { walls: [], median: 0, stddev: 0, threshold: 0 }

  const notionals = buckets.map(b => b.totalNotional).sort((a, b) => a - b)

  // Median
  const mid = Math.floor(notionals.length / 2)
  const median = notionals.length % 2 === 0
    ? (notionals[mid - 1] + notionals[mid]) / 2
    : notionals[mid]

  // Standard deviation
  const mean = notionals.reduce((a, b) => a + b, 0) / notionals.length
  const variance = notionals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / notionals.length
  const stddev = Math.sqrt(variance)

  // Threshold: median + N×σ (using median not mean — more robust against outliers)
  // Also require at least 3× median as a floor
  const threshold = median + nSigma * stddev
  const effectiveThreshold = Math.max(threshold, median * 3)

  const walls = buckets
    .filter(b => b.totalNotional >= effectiveThreshold)
    .map(b => ({
      ...b,
      sizeVsMedian: median > 0 ? Math.min(b.totalNotional / median, 99.9) : 0
    }))
    .sort((a, b) => b.totalNotional - a.totalNotional)

  return { walls, median, stddev, threshold: effectiveThreshold }
}

/**
 * Cluster adjacent wall buckets into zones
 * If wall buckets are next to each other, merge them into a single zone
 * @param {Array} walls - detected wall buckets
 * @param {number} bucketSize - price bucket size
 * @param {number} maxGap - max gap in bucket units to merge (default 2 = merge if gap ≤ 2 buckets)
 */
function clusterWalls(walls, bucketSize, maxGap = 2) {
  if (!walls || walls.length === 0) return []

  const sorted = [...walls].sort((a, b) => a.anchorPrice - b.anchorPrice)
  const clusters = []
  let current = { ...sorted[0], priceStart: sorted[0].minPrice, priceEnd: sorted[0].maxPrice }

  for (let i = 1; i < sorted.length; i++) {
    const wall = sorted[i]
    const gapBuckets = Math.abs(wall.anchorPrice - current.anchorPrice) / bucketSize

    if (gapBuckets <= maxGap + 1) {
      // Merge into current cluster
      current.totalNotional += wall.totalNotional
      current.levelCount += wall.levelCount
      current.priceEnd = wall.maxPrice
      current.maxPrice = Math.max(current.maxPrice, wall.maxPrice)
      current.minPrice = Math.min(current.minPrice, wall.minPrice)
      current.oldestSeen = Math.min(current.oldestSeen, wall.oldestSeen)
      current.newestUpdate = Math.max(current.newestUpdate, wall.newestUpdate)
      // Recalculate anchor as notional-weighted center
      current.anchorPrice = (current.anchorPrice * (current.totalNotional - wall.totalNotional) + wall.anchorPrice * wall.totalNotional) / current.totalNotional
      current.sizeVsMedian = Math.max(current.sizeVsMedian || 0, wall.sizeVsMedian || 0)
    } else {
      clusters.push(current)
      current = { ...wall, priceStart: wall.minPrice, priceEnd: wall.maxPrice }
    }
  }
  clusters.push(current)

  return clusters
}

/**
 * Calculate Bid/Ask Imbalance in a price window
 * imbalance = (totalBids - totalAsks) / (totalBids + totalAsks)
 * > +0.3 = strong buy pressure (bullish)
 * < -0.3 = strong sell pressure (bearish)
 * @param {Array} bidLevels - raw bid levels from stateManager
 * @param {Array} askLevels - raw ask levels from stateManager
 * @returns {number} imbalance -1 to +1
 */
function calcImbalance(bidLevels, askLevels) {
  const totalBids = bidLevels.reduce((sum, l) => sum + l.notional, 0)
  const totalAsks = askLevels.reduce((sum, l) => sum + l.notional, 0)
  const total = totalBids + totalAsks
  if (total === 0) return 0
  return (totalBids - totalAsks) / total
}

/**
 * Persistence tracking — stored in a Map outside, passed in
 * Returns enriched wall with status: 'new' | 'confirmed' (>3min) | 'strong' (>10min)
 *
 * Key strategy: bucket index = floor(price / bucketSize) — stable across scans
 * Also does fuzzy match: if exact bucket not found, check ±1 neighbor buckets
 * (wall may shift by 1 bucket between scans due to order changes)
 */
function enrichWithPersistence(wall, persistenceMap, symbol, side, markPrice) {
  const now = Date.now()
  const bucketSize = getBucketSize(markPrice || wall.anchorPrice)
  const bucketIdx = Math.floor(wall.anchorPrice / bucketSize)
  const prefix = `${symbol}:${side}:`

  // Try exact key first, then ±1 neighbor, then ±2
  let record = null
  let matchKey = null
  for (const offset of [0, -1, 1, -2, 2]) {
    const tryKey = `${prefix}${bucketIdx + offset}`
    const existing = persistenceMap.get(tryKey)
    if (existing && (now - existing.lastSeen) < 120000) {
      record = existing
      matchKey = tryKey
      break
    }
  }

  const exactKey = `${prefix}${bucketIdx}`

  if (!record) {
    // Brand new wall
    record = { firstSeen: now, lastSeen: now, peakNotional: wall.totalNotional }
    persistenceMap.set(exactKey, record)
  } else {
    // Existing wall — update and migrate key if needed
    record.lastSeen = now
    record.peakNotional = Math.max(record.peakNotional, wall.totalNotional)
    if (matchKey && matchKey !== exactKey) {
      // Wall shifted bucket — migrate to new key, keep firstSeen
      persistenceMap.delete(matchKey)
      persistenceMap.set(exactKey, record)
    }
  }

  const ageMs = now - record.firstSeen
  const ageMins = ageMs / 60000

  let status = 'new'
  if (ageMins >= 10) status = 'strong'
  else if (ageMins >= 3) status = 'confirmed'

  return {
    ...wall,
    ageMins: Math.round(ageMins * 10) / 10,
    status,
    peakNotional: record.peakNotional
  }
}

/**
 * Clean up old persistence entries (not seen in 2 minutes)
 */
function cleanupPersistence(persistenceMap) {
  const now = Date.now()
  const STALE_MS = 300000 // 5 min — wall can disappear briefly and come back
  for (const [key, record] of persistenceMap.entries()) {
    if (now - record.lastSeen > STALE_MS) {
      persistenceMap.delete(key)
    }
  }
}

/**
 * Score a wall zone for ranking
 * score = sizeVsMedian × proximityWeight × persistenceMultiplier
 */
function scoreWall(wall, markPrice) {
  const distancePct = Math.abs(wall.anchorPrice - markPrice) / markPrice * 100

  // Size factor (capped at 50 to avoid extreme outliers dominating)
  const sizeFactor = Math.min(wall.sizeVsMedian || 1, 50)

  // Proximity weight: closer = better (1.0 at 0%, 0.2 at 5%)
  const proximityWeight = Math.max(0.2, 1.0 - distancePct * 0.16)

  // Persistence multiplier
  let persistMult = 1.0
  if (wall.status === 'strong') persistMult = 1.5
  else if (wall.status === 'confirmed') persistMult = 1.2

  const score = sizeFactor * proximityWeight * persistMult
  return Math.round(score * 10) / 10
}

/**
 * Main analysis function: process one symbol
 * @param {Object} params
 * @param {string} params.symbol
 * @param {number} params.markPrice
 * @param {Array} params.bidLevels - raw [{price, notional, firstSeen, lastUpdate}]
 * @param {Array} params.askLevels - raw [{price, notional, firstSeen, lastUpdate}]
 * @param {Map} params.persistenceMap - shared persistence store
 * @param {number} params.windowPct - % window around price (default 2)
 * @param {number} params.nSigma - statistical threshold (default 2)
 * @returns {Object} {symbol, support, resistance, imbalance, wallCount, bidWalls, askWalls}
 */
function analyzeSymbol({ symbol, markPrice, bidLevels, askLevels, persistenceMap, windowPct = 2, nSigma = 2.0 }) {
  const bucketSize = getBucketSize(markPrice)

  // Filter levels to window
  const filterWindow = (levels) => levels.filter(l => {
    const dist = Math.abs(l.price - markPrice) / markPrice * 100
    return dist <= windowPct
  })

  const bidsInWindow = filterWindow(bidLevels)
  const asksInWindow = filterWindow(askLevels)

  // Bucket levels
  const bidBuckets = bucketLevels(bidsInWindow, bucketSize)
  const askBuckets = bucketLevels(asksInWindow, bucketSize)
  const allBuckets = [...bidBuckets, ...askBuckets]

  // Detect walls using combined statistics (one threshold for both sides)
  const { walls: rawWalls, median, stddev, threshold } = detectWalls(allBuckets, nSigma)

  // Separate by side (bid = below price, ask = above price)
  const bidWallBuckets = rawWalls.filter(w => w.anchorPrice < markPrice)
  const askWallBuckets = rawWalls.filter(w => w.anchorPrice >= markPrice)

  // Cluster adjacent walls
  const bidClusters = clusterWalls(bidWallBuckets, bucketSize)
  const askClusters = clusterWalls(askWallBuckets, bucketSize)

  // Enrich with persistence
  const enrichedBidWalls = bidClusters.map(w => enrichWithPersistence(w, persistenceMap, symbol, 'bid', markPrice))
  const enrichedAskWalls = askClusters.map(w => enrichWithPersistence(w, persistenceMap, symbol, 'ask', markPrice))

  // Score all walls
  const scoredBidWalls = enrichedBidWalls.map(w => ({
    ...w,
    side: 'bid',
    distancePct: Math.round(Math.abs(w.anchorPrice - markPrice) / markPrice * 10000) / 100,
    score: scoreWall(w, markPrice)
  })).sort((a, b) => b.score - a.score)

  const scoredAskWalls = enrichedAskWalls.map(w => ({
    ...w,
    side: 'ask',
    distancePct: Math.round(Math.abs(w.anchorPrice - markPrice) / markPrice * 10000) / 100,
    score: scoreWall(w, markPrice)
  })).sort((a, b) => b.score - a.score)

  // Imbalance
  const imbalance = calcImbalance(bidsInWindow, asksInWindow)

  // Nearest support = best bid wall (closest to price first, then biggest)
  const support = scoredBidWalls.length > 0 ? scoredBidWalls[0] : null
  // Nearest resistance = best ask wall
  const resistance = scoredAskWalls.length > 0 ? scoredAskWalls[0] : null

  return {
    symbol,
    markPrice,
    support: support ? formatWall(support, markPrice) : null,
    resistance: resistance ? formatWall(resistance, markPrice) : null,
    imbalance: Math.round(imbalance * 1000) / 1000,
    imbalanceLabel: imbalance > 0.3 ? 'BULLISH' : imbalance < -0.3 ? 'BEARISH' : 'NEUTRAL',
    wallCount: scoredBidWalls.length + scoredAskWalls.length,
    bidWalls: scoredBidWalls.slice(0, 5).map(w => formatWall(w, markPrice)),
    askWalls: scoredAskWalls.slice(0, 5).map(w => formatWall(w, markPrice)),
    stats: { median: Math.round(median), stddev: Math.round(stddev), threshold: Math.round(threshold), bucketSize: Math.round(bucketSize * 10000) / 10000 }
  }
}

/**
 * Format a wall for API response
 */
function formatWall(wall, markPrice) {
  return {
    price: Math.round(wall.anchorPrice * 10000) / 10000,
    notional: Math.round(wall.totalNotional),
    distancePct: wall.distancePct,
    sizeVsMedian: Math.round((wall.sizeVsMedian || 0) * 10) / 10,
    levelCount: wall.levelCount,
    ageMins: wall.ageMins || 0,
    status: wall.status || 'new',
    score: wall.score,
    side: wall.side
  }
}

module.exports = {
  analyzeSymbol,
  bucketLevels,
  detectWalls,
  clusterWalls,
  calcImbalance,
  enrichWithPersistence,
  cleanupPersistence,
  scoreWall,
  getBucketSize
}
