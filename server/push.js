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
 * Send notification with retry for transient network errors.
 * Fire-and-forget: runs in background, never blocks caller.
 * Retries: 2 attempts with 1s/3s backoff. Only retries network errors (no statusCode).
 * 410/404 = expired subscription → delete. Other 4xx = permanent, don't retry.
 */
async function sendWithRetry(pushSub, payload, endpoint, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await webpush.sendNotification(pushSub, payload, { TTL: 300, timeout: 10000 })
      try { _stmts.resetPushFail.run(endpoint) } catch {}
      return // success
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        try { _stmts.deletePushSub.run(endpoint) } catch {}
        console.log('[Push] Removed expired subscription')
        return
      }
      // Network error (no statusCode) — retry
      const isTransient = !err.statusCode
      if (isTransient && attempt < maxRetries) {
        const delay = (attempt + 1) * 2000 // 2s, 4s
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      // Give up
      try { _stmts.incrementPushFail.run(endpoint) } catch {}
      if (attempt === maxRetries && isTransient) {
        console.warn(`[Push] Failed after ${maxRetries + 1} attempts: ${err.message}`)
      } else {
        console.error(`[Push] Send error (${err.statusCode}): ${err.message}`)
      }
      return
    }
  }
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
  const iconMap = { volume_spike: '📊', liq_sweep: '🎯', oi_cvd: '🔮', oi_divergence: '🔀', oi_funding_squeeze: '⚡', channel: '📐' }
  const icon = iconMap[signal.type] || '🔮'
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
      // Channel TF filter: skip if user disabled this timeframe
      if (signal.type === 'channel' && filters.channelTimeframes?.length) {
        const sigTf = signal.metadata?.interval
        if (sigTf && !filters.channelTimeframes.includes(sigTf)) continue
      }
    } catch {}

    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    }

    sent++
    sendWithRetry(pushSub, payload, sub.endpoint)
  }

  if (sent > 0) {
    console.log(`[Push] Signal ${signal.symbol} ${signal.type} → sent to ${sent}/${subs.length} subscribers`)
  }
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null
}

/**
 * Send push notification to a specific user (by user_id)
 * Used for price alerts — only sends to subscriptions linked to this user
 */
function sendPushToUser(userId, payload) {
  if (!_enabled || !_stmts) return

  const subs = _stmts.getPushSubsByUser ? _stmts.getPushSubsByUser.all(userId) : []
  if (!subs.length) return

  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
  let sent = 0

  for (const sub of subs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    }
    sent++
    sendWithRetry(pushSub, payloadStr, sub.endpoint)
  }

  if (sent > 0) {
    console.log(`[Push] Alert → user #${userId}: sent to ${sent} subscription(s)`)
  }
}

function isEnabled() {
  return _enabled
}

module.exports = { init, sendPushForSignal, sendPushToUser, getVapidPublicKey, isEnabled }
