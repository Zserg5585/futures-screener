const CACHE_NAME = 'fs-v40'
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/auth.js',
  '/settings.js',
  '/signals.js',
  '/densities.js',
  '/mini-charts.js',
  '/alerts.js',
  '/manifest.json',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      ),
      // Clear all existing notifications on SW update
      self.registration.getNotifications().then(nots => nots.forEach(n => n.close())),
    ])
  )
  self.clients.claim()
  // Notify all open tabs that a new SW version is active
  self.clients.matchAll({ type: 'window' }).then(cls => {
    for (const c of cls) c.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME })
  })
})

// Notification click — open PWA and navigate to coin modal
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const symbol = e.notification.data?.symbol
  const signalId = e.notification.data?.signalId
  const url = symbol ? `/?signal=${symbol}` : '/'

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      // Focus existing window if open
      for (const client of cls) {
        if (client.url.includes(self.registration.scope) || client.url.includes(self.location.origin)) {
          client.postMessage({ type: 'OPEN_SIGNAL', symbol, signalId })
          return client.focus()
        }
      }
      // No window open — open new one with signalId
      const openUrl = signalId ? `/?signal=${symbol}&sid=${signalId}` : url
      return clients.openWindow(openUrl)
    })
  )
})

// Web Push — receive server-sent push and show notification (works even when browser closed)
self.addEventListener('push', (e) => {
  if (!e.data) return

  let payload
  try { payload = e.data.json() } catch { return }

  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.svg',
    badge: payload.badge || '/icon-192.svg',
    tag: payload.tag || 'signal',
    data: payload.data || {},
    vibrate: payload.vibrate || [200, 100, 200],
    requireInteraction: false,
  }

  e.waitUntil(
    self.registration.showNotification(payload.title || 'Signal', options)
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // API/WS calls — network only
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/densities/') ||
      url.pathname.startsWith('/depth/') || url.pathname === '/health') {
    return
  }
  // Navigation (HTML) — ALWAYS bypass HTTP cache to get fresh version checks
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(res => {
        const clone = res.clone()
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
        return res
      }).catch(() => caches.match(e.request))
    )
    return
  }
  // Static assets — network first (bypass HTTP cache), fallback to SW cache
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      const clone = res.clone()
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
      return res
    }).catch(() => caches.match(e.request))
  )
})
