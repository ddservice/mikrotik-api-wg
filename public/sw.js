const CACHE_NAME = 'mt-dashboard-pwa-v1';
const urlsToCache = ['/overview', '/login', '/globals.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.text() : 'แจ้งเตือนระบบ MikroTik';
  event.waitUntil(
    self.registration.showNotification('MT Management Alert', {
      body: data,
      icon: '/icon-192x192.png',
    })
  );
});
