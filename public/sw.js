// Service worker: makes the app installable and lets the shell load offline.
// Network-first, so players always get the latest code when online; the cache is only a fallback.
// Live game traffic (/socket.io/ polling + websockets) is never cached.
const CACHE = "guess-who-v1";
const SHELL = [
  "/",
  "/style.css",
  "/client.js",
  "/avatar.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/socket.io/socket.io.js",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/socket.io/") && url.pathname !== "/socket.io/socket.io.js") return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req.mode === "navigate" ? "/" : req, res.clone());
      return res;
    } catch {
      const cached = await cache.match(req.mode === "navigate" ? "/" : req, { ignoreSearch: req.mode === "navigate" });
      return cached || Response.error();
    }
  })());
});
