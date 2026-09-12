const CACHE = 'shiti-iphone-0898c22d1ab7';
const FILES = ['./', './index.html', './styles.css', './app.js', './app-config.js', './pwa.js', './core.js', './storage.js', './sync-client.js', './document-export.js', './vendor/lucide.js', './vendor/docx.js', './manifest.webmanifest', './assets/icon-192.png', './assets/icon-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('shiti-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(caches.open(CACHE).then(async cache => {
      const complete = await Promise.all(FILES.map(file => cache.match(file)));
      event.ports[0]?.postMessage({ ready: complete.every(Boolean) });
    }));
  }
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isAsset = FILES.some(file => new URL(file, self.registration.scope).href === url.href);
  if (!isAsset && event.request.mode !== 'navigate') return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    return fetch(event.request);
  }));
});
