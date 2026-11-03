const V = "ct-v10";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const ks = await caches.keys(), legacy = ks.some(k => /^ct-v\d$/.test(k) && k !== V);          // upgrading from the old stale-while-revalidate versions (v1-v9)
    await Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)));
    await self.clients.claim();
    if (legacy) for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});   // NOT awaited: the navigation waits for this activation to finish   // one-time: those old pages have no update code, so reload them onto the new shell
  })());
});
const put = (req, r) => { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); };
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;           // cross-origin (raw data, Kraken) goes straight to network
  if (u.pathname.endsWith(".json")) {                                                // data: network first, cache fallback (offline = last data)
    e.respondWith(fetch(e.request).then(r => { put(u.pathname, r); return r; }).catch(() => caches.match(u.pathname)));
    return;
  }
  // app shell (index.html, app.js, styles.css, ...): NETWORK FIRST (revalidated, bypasses the HTTP cache), cache only as offline / slow-network fallback
  const net = fetch(e.request.mode === "navigate" ? e.request.url : e.request, { cache: "no-cache" }).then(r => { if (r.ok) put(e.request, r); return r; });
  const slow = new Promise(res => setTimeout(() => res(null), 6000));
  e.respondWith(Promise.race([net, slow]).then(r => r || caches.match(e.request, { ignoreSearch: true }).then(h => h || net))
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(h => h || Response.error())));
});
