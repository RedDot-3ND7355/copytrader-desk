const V = "ct-v3";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;           // cross-origin (raw data, Kraken) goes straight to network
  if (u.pathname.endsWith(".json")) {                                                // data: network first, cache fallback (offline = last data)
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(u.pathname, c)); return r; }).catch(() => caches.match(u.pathname)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(h => {          // shell: instant from cache, refreshed in the background
    const net = fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; }).catch(() => h);
    return h || net;
  }));
});
