// WLM Ops Hub — service worker (root scope, covers all 3 portals).
//
// Deliberately conservative: caches ONLY static app-shell assets (the three
// HTML shells, the manifest, offline.html, icons, Google Fonts). NEVER
// caches /api/* — every data read/write and the sign-in route itself always
// go straight to the network, untouched by this file. There is no offline
// data/sync of any kind here — offline.html is the only thing served when
// a navigation fails with no network.
//
// CACHE_VERSION is the only thing that needs bumping to ship a new static
// asset — bumping it changes this file's own bytes, which is what makes the
// browser notice an update is available at all (see the 'install'/'waiting'
// dance below and each page's own registerServiceWorker()).
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `wlm-ops-static-${CACHE_VERSION}`;
const FONT_CACHE = `wlm-ops-fonts-${CACHE_VERSION}`;
const ALL_CACHES = [STATIC_CACHE, FONT_CACHE];

// The app shell — every file here is a static asset whose content never
// depends on who's signed in or what data exists; actual data always comes
// from /api/* at runtime, never from these cached files.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/user.html',
  '/client.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-512-maskable.png',
  '/assets/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      // Does NOT call skipWaiting() here — a newly-installed worker stays
      // WAITING until the page explicitly asks it to activate (see the
      // 'Update available' banner flow in each portal's own script), so an
      // already-open tab is never yanked onto new code out from under it.
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => !ALL_CACHES.includes(n)).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Page -> SW: 'SKIP_WAITING' (tap on the update banner) and
// 'CLEAR_CACHES' (sign-out, see each portal's own logout()) are the only
// two messages this worker understands.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (event.data === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))
    );
  }
});

function isApiOrAuthRequest(url) {
  // Every data/write/sign-in path in this app lives under /api/ — never
  // intercepted, always goes straight to the real network.
  return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch a write

  const url = new URL(req.url);
  if (isApiOrAuthRequest(url)) return; // let the browser handle it normally

  // Navigations (loading index.html/user.html/client.html directly, or a
  // reload) — network-first, so a signed-in user always gets the freshest
  // app shell when online; only falls back to the cached shell, then
  // offline.html, when the network genuinely fails.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then(cached => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // Google Fonts — the only cross-origin resource this app loads. Cache-
  // first (fonts are effectively immutable once fetched), populated at
  // runtime rather than precached, since the exact font URLs aren't static.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(FONT_CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Same-origin static assets (icons, manifest, offline.html itself) —
  // cache-first with a network fallback that opportunistically re-caches.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});
