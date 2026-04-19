const CACHE_NAME = 'fs-v14'
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/auth.js',
  '/settings.js',
  '/densities.js',
  '/mini-charts.js',
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
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // API/WS calls — network only
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/densities/') ||
      url.pathname.startsWith('/depth/') || url.pathname === '/health') {
    return
  }
  // Static — network first, fallback cache
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone()
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
      return res
    }).catch(() => caches.match(e.request))
  )
})
