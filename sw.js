const CACHE_VERSION = 'chordpro-v14';

const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './css/app.css',
  './js/app.bundle.js'
];

const OPTIONAL_CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/pdfmake.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/vfs_fonts.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async cache => {
      await cache.addAll(LOCAL_ASSETS);
      await Promise.all(
        OPTIONAL_CDN.map(url =>
          fetch(url, { mode: 'cors' })
            .then(res => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept local Stage Server API or WebSocket endpoints
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/ws')) {
    return;
  }

  if (url.origin === location.origin) {
    // Network-first for local app files so HTML, CSS & JS always stay in sync;
    // falls back seamlessly to Cache when offline (e.g. on stage without internet).
    const cleanKey = new URL(url.pathname === '/' ? '/index.html' : url.pathname, url.origin).href;
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(cleanKey, copy));
          }
          return res;
        })
        .catch(async () => {
          const c = await caches.open(CACHE_VERSION);
          return (await c.match(cleanKey)) || (await c.match(req, { ignoreSearch: true })) || (await c.match('./index.html'));
        })
    );
  } else if (OPTIONAL_CDN.includes(req.url)) {
    // Cache-first for pinned immutable CDN libraries
    event.respondWith(
      caches.open(CACHE_VERSION).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 503 });
        }
      })
    );
  }
});
