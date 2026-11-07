// 声区メーター：オフラインでも開けるようにする Service Worker
const CACHE = 'voice-meter-v0.2.0';
const FILES = [
  './', 'index.html', 'manifest.json', 'css/style.css',
  'js/main.js', 'js/dsp.js', 'js/score.js', 'js/store.js', 'js/tracker.js', 'js/synth.js', 'js/demo.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットが使えるときは最新を取り、だめならキャッシュを返す
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
