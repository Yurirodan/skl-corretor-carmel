const CACHE_NAME = "skl-corretores-v6";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./online.js",
  "./manifest.webmanifest",
  "./data/lotes.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/leaflet.js",
  "./assets/logo-symbol.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET") return;

  // "cache: no-store" nas duas chamadas de fetch abaixo é essencial — sem
  // isso, mesmo pedindo a rede "primeiro", o navegador pode responder direto
  // do cache HTTP dele (o GitHub Pages manda Cache-Control: max-age=600 em
  // todo arquivo estático) sem nem chegar a sair pra rede de verdade. Foi
  // exatamente isso que fez o corretor continuar vendo uma versão antiga do
  // app mesmo depois de recarregar a página várias vezes.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request.url, { cache: "no-store" }).catch(() => caches.match("./index.html")),
    );
    return;
  }

  const isLocal = url.origin === self.location.origin;
  const isLeaflet = url.hostname === "unpkg.com";
  if (!isLocal && !isLeaflet) return;

  event.respondWith(
    fetch(request.url, { cache: "no-store" })
      .then((response) => {
        if (response.ok || response.type === "opaque") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
