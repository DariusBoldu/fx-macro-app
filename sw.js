/* FX Macro — service worker.
 *   - precaches the app shell for offline launch
 *   - network-first for data.json (fresh report wins, cache is the fallback)
 *   - cache-first (stale-while-revalidate) for static assets
 *   - Web Push: shows a notification when the push sender fires
 * Bump CACHE when shell assets change to force an update. */
var CACHE = 'fx-macro-v9';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './price-adapter.js',
  './manifest.webmanifest',
  './data.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL).catch(function () {/* tolerate a missing optional asset */});
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Never cache cross-origin price API calls — let them hit the network.
  if (url.origin !== self.location.origin) return;

  // data.json + config.js: network-first so a new report (and any config edit —
  // keys, passcode, provider) applies immediately; cache is the offline fallback.
  if (/\/(data\.json|config\.js)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // Static shell: cache-first, refresh in the background.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});

/* ---- Web Push ---- */
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data && e.data.text() }; }
  var title = data.title || 'FX Macro';
  var opts = {
    body: data.body || 'New macro update available.',
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    tag: data.tag || 'fx-macro',
    data: { url: data.url || './index.html' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
