/**
 * Price Alert Checker — server-side alert engine
 * Runs on a 5-second interval, checks all enabled price alerts against current mark prices.
 * Detects crosses_above / crosses_below / crosses conditions with per-alert cooldown.
 * Logs triggers to DB and sends push notifications to alert owners.
 */

const CHECK_INTERVAL_MS = 5_000

const lastPrices = new Map()   // symbol -> last known markPrice
const cooldowns = new Map()    // alertId -> last trigger timestamp

let _interval = null
let _auth, _push, _getProxyCached, _bgetWithRetry

/**
 * Format price with appropriate decimal places:
 *   >= 1000 → 2 decimals, >= 1 → 4 decimals, else 6 decimals
 */
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

  console.log(`[Alerts] Price alert checker started (every ${CHECK_INTERVAL_MS / 1000}s)`)
}

async function checkAlerts() {
  try {
    const alerts = _auth.getAllEnabledAlerts().filter(a => a.type === 'price')
    if (!alerts.length) return

    // Get current mark prices — prefer cache, fallback to direct API call
    let marks = _getProxyCached('marks', 10_000)
    if (!marks) {
      try {
        marks = await _bgetWithRetry('/fapi/v1/premiumIndex')
      } catch {
        return // can't check without prices
      }
    }
    if (!Array.isArray(marks) || !marks.length) return

    const markMap = new Map(marks.map(m => [m.symbol, Number(m.markPrice)]))
    const now = Date.now()

    for (const alert of alerts) {
      try {
        const { id, user_id, symbol, condition, cooldown_sec } = alert
        const { price: targetPrice, direction } = condition
        if (!targetPrice || !direction) continue

        const currentPrice = markMap.get(symbol)
        if (currentPrice == null || isNaN(currentPrice)) continue

        const prevPrice = lastPrices.get(symbol)

        // Need a previous price to detect crossings
        if (prevPrice == null) continue

        // Detect crossing
        const crossedAbove = prevPrice < targetPrice && currentPrice >= targetPrice
        const crossedBelow = prevPrice > targetPrice && currentPrice <= targetPrice

        let triggered = false
        let dirLabel = ''

        if (direction === 'crosses_above' && crossedAbove) {
          triggered = true
          dirLabel = `▲ Above $${fmtPrice(targetPrice)}`
        } else if (direction === 'crosses_below' && crossedBelow) {
          triggered = true
          dirLabel = `▼ Below $${fmtPrice(targetPrice)}`
        } else if (direction === 'crosses' && (crossedAbove || crossedBelow)) {
          triggered = true
          dirLabel = crossedAbove
            ? `▲ Above $${fmtPrice(targetPrice)}`
            : `▼ Below $${fmtPrice(targetPrice)}`
        }

        if (!triggered) continue

        // Cooldown check
        const cooldownMs = (cooldown_sec || 300) * 1000
        const lastTrigger = cooldowns.get(id)
        if (lastTrigger && (now - lastTrigger) < cooldownMs) continue

        // Mark cooldown
        cooldowns.set(id, now)

        const message = `${symbol} ${dirLabel}`

        // Log trigger to DB
        _auth.logAlertTrigger(id, user_id, symbol, message, {
          targetPrice,
          currentPrice,
          direction,
          previousPrice: prevPrice,
        })

        console.log(`[Alerts] 🔔 ${symbol} ${dirLabel} (alert #${id}, user #${user_id})`)

        // Send push notification
        if (_push && _push.isEnabled() && _push.sendPushToUser) {
          try {
            _push.sendPushToUser(user_id, {
              title: `🔔 ${symbol.replace('USDT', '')} Price Alert`,
              body: `${dirLabel} — now $${fmtPrice(currentPrice)}`,
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: `alert-${id}`,
              data: { symbol, alertId: id, type: 'price_alert' },
              vibrate: [200, 100, 200],
            })
          } catch (pushErr) {
            console.warn(`[Alerts] Push failed for alert #${id}: ${pushErr.message}`)
          }
        }
      } catch (alertErr) {
        console.warn(`[Alerts] Error checking alert #${alert.id}: ${alertErr.message}`)
      }
    }

    // Update last known prices for all symbols (after processing alerts)
    for (const [symbol, price] of markMap) {
      lastPrices.set(symbol, price)
    }
  } catch (err) {
    console.error(`[Alerts] checkAlerts error: ${err.message}`)
  }
}

function stop() {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
  console.log('[Alerts] Price alert checker stopped')
}

module.exports = { init, stop }
