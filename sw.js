const CACHE = 'bp-log-v26';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll uses default fetch semantics, so it can satisfy these requests
      // from the browser's HTTP cache. Pages serves index.html with a max-age,
      // which meant a freshly installed worker could populate its brand-new
      // cache with the PREVIOUS deploy's files -- the reason an update used to
      // need a second close-and-reopen to appear. Force revalidation instead.
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// How long the app shell waits for the network before falling back to cache.
// Long enough to beat a slow connection, short enough that a dead one doesn't
// visibly stall startup.
const NAV_TIMEOUT = 2500;

// Store a good same-origin response and hand it back untouched.
function keep(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}

function shellFromCache(req) {
  return caches.match(req).then(hit => hit || caches.match('./index.html'));
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // The app shell is network-first. Under cache-first the OUTGOING worker
  // answered the navigation from its own cache before the incoming worker
  // could claim the page, so a deploy stayed invisible until the second
  // launch -- no amount of skipWaiting() fixes that, because the HTML has
  // already been served by then. Offline is preserved: a rejection, a
  // non-OK status, or NAV_TIMEOUT elapsing all fall back to the cached shell.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      Promise.race([
        fetch(e.request)
          .then(res => (res && res.ok) ? keep(e.request, res) : null)
          .catch(() => null),
        new Promise(res => setTimeout(() => res(null), NAV_TIMEOUT))
      ]).then(res => res || shellFromCache(e.request))
    );
    return;
  }

  // Everything else stays cache-first with background revalidation. The icons
  // and manifest only change when the shell does, so serving them instantly
  // costs nothing.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request)
        .then(res => keep(e.request, res))
        .catch(() => cached);
      return cached || network;
    })
  );
});



