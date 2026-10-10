// Service worker — aplikace funguje offline. Data (deník) jsou v localStorage, tady cachujeme jen kód.
// Strategie: network-first pro vlastní soubory (online vždy nejnovější verze),
// s cache jako záložkou pro offline režim.
const CACHE = 'kalorie-v18';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/conf.js',
  './js/learn.js',
  './js/app.js',
  './js/scan.js',
  './js/ai.js',
  './js/cgm.js',
  './js/jobs.js',
  './js/carb.js',
  './js/vendor/zxing.min.js',
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

  // Cizí domény (Open Food Facts, Anthropic API): jen síť, service worker se neplete.
  if (url.origin !== location.origin) return;

  // Vlastní soubory: nejdřív síť (aktuální verze), při výpadku cache.
  // cache: 'no-cache' = vždy ověřit u serveru (levné 304), jinak by HTTP cache prohlížeče
  // mohla ještě několik minut po nasazení vracet starý kód.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
