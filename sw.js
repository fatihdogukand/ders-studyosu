const CACHE = 'sohbet-okulu-v4.7.1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './cloud.js'
];
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/mhchem.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(CORE_ASSETS);
      await Promise.allSettled(CDN_ASSETS.map(url => c.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// İnternet varken güncel kodu çek, çevrimdışıysa önbellekten sun (yalnızca GET istekleri önbelleklenir)
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(req).then(cached => {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      })
    )
  );
});
