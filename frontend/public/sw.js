const CACHE_NAME = 'dimag-shell-v1';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const pageResponse = await fetch('/index.html', { cache: 'reload' });
    if (!pageResponse.ok) throw new Error(`Could not cache app shell: ${pageResponse.status}`);
    const html = await pageResponse.clone().text();
    await cache.put('/index.html', pageResponse.clone());
    await cache.put('/', pageResponse.clone());

    const assets = [...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"]+)"/g)]
      .map(([, path]) => new URL(path, self.location.origin))
      .filter((url) => url.origin === self.location.origin && !url.pathname.startsWith('/api/'))
      .map((url) => url.pathname);
    await Promise.all([...new Set([...SHELL_URLS.slice(2), ...assets])].map(async (path) => {
      const response = await fetch(path, { cache: 'reload' });
      if (!response.ok) throw new Error(`Could not cache app asset ${path}: ${response.status}`);
      await cache.put(path, response);
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name.startsWith('dimag-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (
      await caches.match('/') || Response.error()
    )));
    return;
  }

  const isAppAsset = requestUrl.pathname.startsWith('/assets/') ||
    requestUrl.pathname.startsWith('/icons/') ||
    requestUrl.pathname === '/favicon.svg' ||
    requestUrl.pathname === '/manifest.webmanifest';
  if (!isAppAsset) return;

  event.respondWith((async () => {
    const cachedResponse = await caches.match(event.request);
    if (cachedResponse) return cachedResponse;
    return fetch(event.request);
  })());
});
