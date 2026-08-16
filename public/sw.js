const CACHE = 'face-attendance-v3';
const APP_FILES = ['/', '/index.html', '/admin.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  // Never cache API writes: attendance must always reach the server.
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok && (new URL(request.url).origin === self.location.origin || request.url.includes('cdn.jsdelivr.net'))) {
          caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        }
        return response;
      });
      // Cached AI scripts/models make returning users work even when the
      // connection is slow or temporarily unavailable.
      return cached || network;
    })
  );
});
