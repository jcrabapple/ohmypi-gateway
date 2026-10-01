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

// Web Push: "needs you". The gateway only pushes when no client is watching
// the session, so showing the notification unconditionally is safe (a push
// may also arrive while the page is open, after the watcher left mid-flight).
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'omp', body: event.data ? event.data.text() : '' };
  }
  const data = { url: payload.url || '/#/usage', gwId: payload.gwId || null };
  event.waitUntil(
    self.registration.showNotification(payload.title || 'omp', {
      body: payload.body || '',
      tag: payload.tag || 'omp-dialog',
      data,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Keep the notification on screen until answered; a dialog nobody
      // dismisses is exactly the thing worth being noisy about.
      requireInteraction: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus an existing window and route it; never open a second app window.
      for (const client of all) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          if ('navigate' in client) await client.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
