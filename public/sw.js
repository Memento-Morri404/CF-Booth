/* Card Fair Booth: lets the booth open with no signal at the venue.
   Pages load fresh when online and fall back to the last copy when offline.
   Your data is never cached here; it lives in the browser and on your server. */
const CACHE = 'cardfair-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && !res.redirected && res.type === 'basic') { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate' && url.pathname.startsWith('/booth')) { const b = await caches.match('/booth'); if (b) return b; }
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
