/* Service worker: caches the app shell so the scanner opens through a Wi-Fi
 * drop. API calls always go to the network; the app keeps its own retry
 * queue for confirmations. A new build takes over on the next launch. */
const VERSION = "wms-scanner-v1";
const SHELL = ["/scan/", "/scan/index.html", "/scan/manifest.webmanifest", "/scan/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/v1/")) return;
  if (!url.pathname.startsWith("/scan/")) return;
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        if (res.ok && (url.pathname.startsWith("/scan/assets/") || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => (event.request.mode === "navigate" ? caches.match("/scan/index.html") : undefined));
    }),
  );
});
