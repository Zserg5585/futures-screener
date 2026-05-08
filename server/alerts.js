'use strict'
const { createLogger } = require('./logger')
const log = createLogger('alerts')

/**
 * Multi-Condition Alert Engine (TradingView-style)
 *
 * Supports single price alerts (legacy) AND multi-condition rules.
 * Runs every 5s, evaluates all enabled alerts against live market data.
 *
 * Condition types:
 *   price            — crosses_above / crosses_below / crosses
 *   price_change_pct — % change in 24h (from ticker)
 *   volume_24h       — 24h quote volume (from ticker)
 *   funding_rate     — current funding rate % (from premiumIndex)
 *   rsi              — RSI indicator (computed from klines, cached 60s)
 *
 * Format:
 *   Legacy: { price: 95000, direction: "crosses_above" }
 *   Multi:  { rules: [...], logic: "AND" | "OR" }
 */

const CHECK_INTERVAL_MS = 5_000
const RSI_CACHE_TTL = 60_000 // cache RSI values for 60s

const lastPrices = new Map()    // symbol -> last known markPrice
const cooldowns = new Map()     // alertId -> last trigger timestamp
const rsiCache = new Map()      // "BTCUSDT:14:5m" -> { value, ts }

let _interval = null
let _auth, _push, _getProxyCached, _bgetWithRetry

function fmtPrice(p) {
  if (p >= 1000) return p.toFixed(2)
  if (p >= 1) return p.toFixed(4)
  return p.toFixed(6)
}

function init({ auth, push, getProxyCached, bgetWithRetry }) {
  _auth = auth
  _push = push
  _getProxyCached = getProxyCached
  _bgetWithRetry = bgetWithRetry

  _interval = setInterval(() => {
    checkAlerts().catch(() => {})
  }, CHECK_INTERVAL_MS)

  log.info({ intervalSec: CHECK_INTERVAL_MS / 1000 }, 'Multi-condition alert engine started')
}

// ─── Market data getters (use caches, minimize API calls) ──────────

function getMarkPrices() {
  let marks = _getProxyCached('marks', 10_000)
  if (marks && Array.isArray(marks)) return marks
  return null // will be fetched in checkAlerts if needed
}

function getTicker24h() {
  return _getProxyCached('ticker24h', 30_000)
}

async function computeRSI(symbol, period = 14, tf = '5m') {
  const cacheKey = `${symbol}:${period}:${tf}`
  const cached = rsiCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < RSI_CACHE_TTL) return cached.value

  try {
    const limit = period + 2 // need period+1 data points minimum
    const klines = await _bgetWithRetry(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`)
    if (!Array.isArray(klines) || klines.length < period + 1) return null

    const closes = klines.map(k => parseFloat(k[4]))
    let gains = 0, losses = 0

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff > 0) gains += diff
      else losses -= diff
    }

    let avgGain = gains / period
    let avgLoss = losses / period

    // Apply smoothing for remaining bars
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    const rsi = 100 - (100 / (1 + rs))

    rsiCache.set(cacheKey, { value: rsi, ts: Date.now() })
    return rsi
  } catch (err) {
    log.warn({ symbol, err: err.message }, 'RSI computation failed')
    return null
  }
}

// ─── Condition evaluators ──────────────────────────────────────────

function evalPriceCrossing(symbol, direction, targetPrice, markMap) {
  const currentPrice = markMap.get(symbol)
  if (currentPrice == null) return { met: false }

  const prevPrice = lastPrices.get(symbol)
  if (prevPrice == null) return { met: false }

  const crossedAbove = prevPrice < targetPrice && currentPrice >= targetPrice
  const crossedBelow = prevPrice > targetPrice && currentPrice <= targetPrice

  let met = false
  let label = ''

  if (direction === 'crosses_above' && crossedAbove) {
    met = true; label = `▲ Above $${fmtPrice(targetPrice)}`
  } else if (direction === 'crosses_below' && crossedBelow) {
    met = true; label = `▼ Below $${fmtPrice(targetPrice)}`
  } else if (direction === 'crosses' && (crossedAbove || crossedBelow)) {
    met = true; label = crossedAbove ? `▲ Above $${fmtPrice(targetPrice)}` : `▼ Below $${fmtPrice(targetPrice)}`
  }

  return { met, label, currentPrice }
}

function compareOp(actual, op, target) {
  switch (op) {
    case 'gt': case 'greater_than': return actual > target
    case 'gte': return actual >= target
    case 'lt': case 'less_than': return actual < target
    case 'lte': return actual <= target
    case 'eq': return Math.abs(actual - target) < 0.0001
    default: return false
  }
}

function opLabel(op) {
  switch (op) {
    case 'gt': case 'greater_than': return '>'
    case 'gte': return '>='
    case 'lt': case 'less_than': return '<'
    case 'lte': return '<='
    case 'eq': return '='
    default: return op
  }
}

async function evaluateRule(rule, symbol, markMap, tickerMap, fundingMap) {
  const { type, op, value, params } = rule

  switch (type) {
    case 'price': {
      // Crossing-type condition
      const direction = op || rule.direction || 'crosses_above'
      const targetPrice = value || rule.price
      const result = evalPriceCrossing(symbol, direction, targetPrice, markMap)
      return {
        met: result.met,
        label: result.label || `Price ${opLabel(op)} $${fmtPrice(targetPrice)}`,
        actual: result.currentPrice,
      }
    }

    case 'price_change_pct': {
      const ticker = tickerMap?.get(symbol)
      if (!ticker) return { met: false }
      const pct = parseFloat(ticker.priceChangePercent)
      if (isNaN(pct)) return { met: false }
      const met = compareOp(pct, op, value)
      return { met, label: `24h Change ${pct.toFixed(2)}% ${opLabel(op)} ${value}%`, actual: pct }
    }

    case 'volume_24h': {
      const ticker = tickerMap?.get(symbol)
      if (!ticker) return { met: false }
      const vol = parseFloat(ticker.quoteVolume)
      if (isNaN(vol)) return { met: false }
      const met = compareOp(vol, op, value)
      const volStr = vol >= 1e9 ? (vol / 1e9).toFixed(1) + 'B' : vol >= 1e6 ? (vol / 1e6).toFixed(0) + 'M' : vol.toFixed(0)
      const valStr = value >= 1e9 ? (value / 1e9).toFixed(1) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(0) + 'M' : value.toFixed(0)
      return { met, label: `Vol $${volStr} ${opLabel(op)} $${valStr}`, actual: vol }
    }

    case 'funding_rate': case 'funding': {
      const funding = fundingMap?.get(symbol)
      if (funding == null) return { met: false }
      const pct = funding * 100 // convert to percentage
      const met = compareOp(pct, op, value)
      return { met, label: `Funding ${pct.toFixed(4)}% ${opLabel(op)} ${value}%`, actual: pct }
    }

    case 'rsi': {
      const period = params?.period || 14
      const tf = params?.tf || '5m'
      const rsi = await computeRSI(symbol, period, tf)
      if (rsi == null) return { met: false }
      const met = compareOp(rsi, op, value)
      return { met, label: `RSI(${period}) ${rsi.toFixed(1)} ${opLabel(op)} ${value}`, actual: rsi }
    }

    default:
      return { met: false, label: `Unknown condition: ${type}` }
  }
}

// ─── Main checker loop ─────────────────────────────────────────────

async function checkAlerts() {
  try {
    const alerts = _auth.getAllEnabledAlerts()
    if (!alerts.length) return

    // Gather market data (use caches, one API call max)
    let marks = getMarkPrices()
    if (!marks) {
      try {
        marks = await _bgetWithRetry('/fapi/v1/premiumIndex')
      } catch { return }
    }
    if (!Array.isArray(marks) || !marks.length) return

    const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))
    const fundingMap = new Map(marks.map(m => [m.symbol, Number(m.lastFundingRate)]))

    // Ticker data (cached in proxy)
    let tickers = getTicker24h()
    const tickerMap = new Map()
    if (Array.isArray(tickers)) {
      for (const t of tickers) tickerMap.set(t.symbol, t)
    }

    const now = Date.now()

    for (const alert of alerts) {
      try {
        const { id, user_id, symbol, condition, cooldown_sec } = alert

        // Cooldown check (early exit)
        const cooldownMs = (cooldown_sec || 300) * 1000
        const lastTrigger = cooldowns.get(id)
        if (lastTrigger && (now - lastTrigger) < cooldownMs) continue

        // Determine format: legacy or multi-condition
        const isMulti = condition.rules && Array.isArray(condition.rules)

        let triggered = false
        let message = ''
        let triggerData = {}

        if (isMulti) {
          // ── Multi-condition evaluation ──
          const logic = (condition.logic || 'AND').toUpperCase()
          const results = []

          for (const rule of condition.rules) {
            const result = await evaluateRule(rule, symbol, markMap, tickerMap, fundingMap)
            results.push(result)
          }

          if (logic === 'OR') {
            triggered = results.some(r => r.met)
          } else {
            triggered = results.length > 0 && results.every(r => r.met)
          }

          if (triggered) {
            const metLabels = results.filter(r => r.met).map(r => r.label)
            message = `${symbol} ${metLabels.join(' & ')}`
            triggerData = {
              rules: results.map((r, i) => ({
                type: condition.rules[i].type,
                met: r.met,
                label: r.label,
                actual: r.actual,
              })),
              logic,
            }
          }
        } else {
          // ── Legacy single price condition ──
          const { price: targetPrice, direction } = condition
          if (!targetPrice || !direction) continue

          const result = evalPriceCrossing(symbol, direction, targetPrice, markMap)
          triggered = result.met

          if (triggered) {
            message = `${symbol} ${result.label}`
            triggerData = {
              targetPrice,
              currentPrice: result.currentPrice,
              direction,
              previousPrice: lastPrices.get(symbol),
            }
          }
        }

        if (!triggered) continue

        // Mark cooldown
        cooldowns.set(id, now)

        // Log trigger to DB
        _auth.logAlertTrigger(id, user_id, symbol, message, triggerData)
        log.info({ symbol, message, alertId: id, userId: user_id, multi: isMulti }, 'Alert triggered')

        // Send push notification
        if (_push && _push.isEnabled() && _push.sendPushToUser) {
          try {
            const sym = symbol.replace('USDT', '')
            _push.sendPushToUser(user_id, {
              title: `🔔 ${sym} Alert`,
              body: message.replace(symbol, sym),
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: `alert-${id}`,
              data: { symbol, alertId: id, type: isMulti ? 'multi_alert' : 'price_alert' },
              vibrate: [200, 100, 200],
            })
          } catch (pushErr) {
            log.warn({ alertId: id, err: pushErr.message }, 'Push failed for alert')
          }
        }
      } catch (alertErr) {
        log.warn({ alertId: alert.id, err: alertErr.message }, 'Error checking alert')
      }
    }

    // Update last known prices (after processing all alerts)
    for (const [symbol, price] of markMap) {
      lastPrices.set(symbol, price)
    }
  } catch (err) {
    log.error({ err: err.message }, 'checkAlerts error')
  }
}

// ─── RSI cache cleanup (every 5 min) ──────────────────────────────
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of rsiCache) {
    if (now - val.ts > RSI_CACHE_TTL * 5) rsiCache.delete(key)
  }
}, 300_000)

function stop() {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  log.info('Alert engine stopped')
}

// Export condition types for frontend validation
const CONDITION_TYPES = {
  price: { label: 'Price', ops: ['crosses_above', 'crosses_below', 'crosses'], hasValue: true, valueLabel: 'Price ($)' },
  price_change_pct: { label: '24h Change %', ops: ['gt', 'lt', 'gte', 'lte'], hasValue: true, valueLabel: 'Percent (%)' },
  volume_24h: { label: '24h Volume', ops: ['gt', 'lt'], hasValue: true, valueLabel: 'Volume ($)' },
  funding_rate: { label: 'Funding Rate', ops: ['gt', 'lt'], hasValue: true, valueLabel: 'Rate (%)' },
  rsi: { label: 'RSI', ops: ['gt', 'lt', 'gte', 'lte'], hasValue: true, valueLabel: 'RSI Value', params: ['period', 'tf'] },
}

module.exports = { init, stop, CONDITION_TYPES }
