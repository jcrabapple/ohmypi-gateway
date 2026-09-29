// omp service worker: keeps the app shell available when the network is not.
//   navigation      network first, cached "/" when offline
//   /assets/*       cache first (file names carry a content hash)
//   everything else untouched, above all /api, /auth, /omp-ws and /healthz
// The build inlines sw/routing.js at the marker below (one file, nothing to go stale) and stamps the
// cache name with a hash, so each deploy gets its own cache and old ones are deleted.
/*__ROUTING__*/

const CACHE = 'omp-shell-__BUILD__';
const SHELL = '/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    const type = res.headers.get('content-type') || '';
    if (res.ok && !res.redirected && type.includes('text/html')) await cache.put(SHELL, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(SHELL);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.status === 200) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const kind = self.ompSwRouting.route(
    { method: req.method, url: req.url, mode: req.mode, range: req.headers.has('range') },
    self.location.origin,
  );
  if (kind === 'navigate') event.respondWith(networkFirst(req));
  else if (kind === 'asset') event.respondWith(cacheFirst(req));
});
