// Service worker — aplikace funguje offline. Data (deník) jsou v localStorage, tady cachujeme jen kód.
const CACHE = 'kalorie-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './js/scan.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Open Food Facts a jiné cizí domény: jen síť (necachovat, ať jsou data aktuální).
  if (url.origin !== location.origin) return;

  // Vlastní soubory: stale-while-revalidate — hned z cache (rychlé, funguje offline),
  // na pozadí se stáhne aktuální verze pro příště.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fetched = fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || fetched;
    })
  );
});
