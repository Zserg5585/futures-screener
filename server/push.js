/**
 * Web Push Module — real server-sent push notifications
 * Each signal triggers immediate push to all subscribers
 * Works even when browser is closed (via browser push service)
 */

const webpush = require('web-push')

let _stmts = null
let _enabled = false

function init({ stmts }) {
  _stmts = stmts

  const vapidPublic = process.env.VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@szhub.space'

  if (!vapidPublic || !vapidPrivate) {
    console.warn('[Push] VAPID keys not configured — push disabled. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars.')
    return
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)
  _enabled = true

  const count = _stmts.countPushSubs.get()?.count || 0
  console.log(`[Push] Web Push initialized (${count} subscriptions)`)
}

/**
 * Send push notification for a signal — called immediately from emitSignal()
 * Fire-and-forget: never blocks signal emission
 */
function sendPushForSignal(signal) {
  if (!_enabled || !_stmts) return

  // Never push test signals
  if (String(signal.id).startsWith('test-')) return

  const subs = _stmts.getAllPushSubs.all()
  if (!subs.length) return

  const ticker = signal.symbol.replace('USDT', '')
  const dir = signal.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'
  const icon = signal.type === 'volume_spike' ? '📊' : '🔮'
  const confStr = `Conf ${signal.confidence}%`

  const payload = JSON.stringify({
    title: `${icon} ${ticker} ${dir}`,
    body: `${confStr} • ${signal.description || ''}`.slice(0, 200),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: `signal-${signal.id}`,
    data: { symbol: signal.symbol, signalId: signal.id, type: signal.type },
    vibrate: [200, 100, 200],
  })

  let sent = 0
  for (const sub of subs) {
    // Server-side filtering per subscriber preferences
    try {
      const filters = JSON.parse(sub.filters || '{}')
      if (filters.minConfidence && signal.confidence < filters.minConfidence) continue
      if (filters.minRatio && signal.type === 'volume_spike' &&
          (signal.metadata?.ratio || 0) < filters.minRatio) continue
      if (filters.types?.length && !filters.types.includes(signal.type)) continue
      if (filters.watchlistOnly && filters.watchlist?.length &&
          !filters.watchlist.includes(signal.symbol)) continue
    } catch {}

    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    }

    sent++
    webpush.sendNotification(pushSub, payload, { TTL: 300 })
      .then(() => {
        try { _stmts.resetPushFail.run(sub.endpoint) } catch {}
      })
      .catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired / unsubscribed — clean up
          try { _stmts.deletePushSub.run(sub.endpoint) } catch {}
          console.log(`[Push] Removed expired subscription`)
        } else {
          try { _stmts.incrementPushFail.run(sub.endpoint) } catch {}
          console.error(`[Push] Send error (${err.statusCode}): ${err.message}`)
        }
      })
  }

  if (sent > 0) {
    console.log(`[Push] Signal ${signal.symbol} ${signal.type} → sent to ${sent}/${subs.length} subscribers`)
  }
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null
}

function isEnabled() {
  return _enabled
}

module.exports = { init, sendPushForSignal, getVapidPublicKey, isEnabled }
