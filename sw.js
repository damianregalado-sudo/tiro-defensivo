// Service worker with two strategies:
//  - same-origin app files (html/css/js/icons): NETWORK-FIRST, cache as an
//    offline fallback only. This is what makes "I updated the site but the
//    phone still shows the old version" go away — the browser always tries
//    the network first, so a redeploy shows up on the very next load as long
//    as there's a connection. The cache only kicks in when there's no signal.
//  - cross-origin CDN scripts (OpenCV.js, jsPDF): CACHE-FIRST. These are
//    large, pinned to a specific version in index.html, and don't change
//    under our feet, so serving the cached copy instantly (and only hitting
//    the network the first time) is the right tradeoff.
//
// Bump CACHE_VERSION on every release that touches app files. It's not
// strictly required for correctness anymore (network-first means updates
// show up regardless), but it guarantees old cached entries get swept on
// activate instead of accumulating forever.
const CACHE_VERSION = 'v45';
const CACHE = 'entrenatiro-' + CACHE_VERSION;
const SHELL = [
  './', './index.html', './manifest.json',
  './css/style.css',
  './js/utils.js', './js/constants.js', './js/storage.js', './js/target.js',
  './js/safety.js', './js/vision.js', './js/drill.js', './js/livefire.js', './js/app.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all([
      cache.addAll(SHELL).catch(() => {}),
      // Vendored OpenCV.js (~10MB, was loaded from the docs.opencv.org CDN)
      // is cached separately from SHELL on purpose: cache.addAll() is
      // all-or-nothing, so if this one large file failed to fetch on a slow
      // connection it would take the whole (otherwise tiny, fast) app shell
      // down with it. Caching it independently means a hiccup here only
      // costs this file — everything else still gets pre-cached for
      // offline use. It'll also get cached the normal way (network-first
      // fetch handler below) the first time the app actually loads it, so
      // this is a nice-to-have for cold-start offline availability, not the
      // only path to it being cached.
      cache.add('./vendor/opencv.js').catch(() => {}),
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  if (sameOrigin) {
    // network-first: always prefer the live version; cache is only the
    // offline fallback, and gets refreshed on every successful fetch.
    //
    // { cache: 'no-store' } here matters a lot more than it looks — without
    // it, `fetch(req)` inside a service worker still goes through the
    // BROWSER'S OWN HTTP cache, not just ours. GitHub Pages serves static
    // files with a Cache-Control that lets the browser reuse a script for a
    // while (commonly ~10 min) without even asking the network. So even
    // though this handler calls fetch() on every request ("network-first"
    // at the JS level), the browser could quietly hand back a stale
    // js/drill.js from ITS cache instead of actually hitting the network —
    // and this code would never know the difference, since fetch() just
    // resolves with whatever it got. That's a real, reported case: build
    // .16 fixed a crash in js/drill.js, index.html on the phone correctly
    // showed the new build number (documents aren't cached as long/at all
    // in most browsers), but the crash kept happening — consistent with
    // the HTML being fresh while drill.js itself was still being served
    // from the browser's HTTP cache. `no-store` forces every same-origin
    // fetch through this handler to actually ask the network, no matter
    // what Cache-Control said, so a push+redeploy shows up on the very
    // next load instead of after Cache-Control's max-age quietly expires.
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // cross-origin (CDN): cache-first, network as fallback/first-fill.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});
