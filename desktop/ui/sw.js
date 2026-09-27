/* HSCPapers service worker (F6 PWA) — installable, offline-capable.
   Strategies:
   - app shell statics: cache-first (precached on install)
   - data/papers.json:  network-first, cache fallback → offline browse/search/filter
   - paper PDFs (direct CORS hosts + /proxy): cache-first with an LRU cap
     → recently read papers re-open offline
   - navigations: network-first → cached shell fallback
   Bump VERSION on any app-shell change so clients refresh. */
const VERSION = "v1";
const SHELL_CACHE = `hsc-shell-${VERSION}`;
const PAGES_CACHE = `hsc-pages-${VERSION}`;
const PDF_CACHE = `hsc-pdfs-${VERSION}`;
const PDF_CACHE_MAX = 60; // recently read papers stay offline (LRU by insertion)
const SHELL = [
  "/", "/index.html", "/css/styles.css", "/js/app.js", "/js/config.js",
  "/pdfjs/pdf.min.js", "/pdfjs/pdf.worker.min.js", "/vendor/jszip.min.js",
  "/manifest.webmanifest", "/og-card.png",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (![SHELL_CACHE, PAGES_CACHE, PDF_CACHE].includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    await cache.put(req, res.clone());
    if (cacheName === PDF_CACHE) await trimPdfs(cache);
  }
  return res;
}
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req) || await cache.match("/");
    if (hit) return hit;
    throw new Error("offline and uncached");
  }
}
async function trimPdfs(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - PDF_CACHE_MAX))) await cache.delete(key);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  const p = url.pathname;
  if (req.mode === "navigate") { e.respondWith(networkFirst(req, SHELL_CACHE)); return; }
  if (p === "/data/papers.json") { e.respondWith(networkFirst(req, PAGES_CACHE)); return; }
  if (p === "/proxy" || /\.pdf$/i.test(p)) { e.respondWith(cacheFirst(req, PDF_CACHE)); return; }
  if (
    SHELL.includes(p) || p.startsWith("/css/") || p.startsWith("/js/") ||
    p.startsWith("/pdfjs/") || p.startsWith("/vendor/") ||
    p === "/robots.txt" || p === "/sitemap.xml"
  ) {
    e.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});
