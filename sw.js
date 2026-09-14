const CACHE_NAME = "skl-corretores-v4";
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

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  const isLocal = url.origin === self.location.origin;
  const isLeaflet = url.hostname === "unpkg.com";
  if (!isLocal && !isLeaflet) return;

  // Rede primeiro, cache só como reserva pra quando estiver offline — o
  // padrão antigo (cache primeiro, atualiza em segundo plano) deixava o
  // corretor preso numa versão antiga do app.js/styles.css por tempo
  // indeterminado, mesmo depois de publicarmos uma correção e ele recarregar
  // a página, porque só o index.html ia pela rede primeiro.
  event.respondWith(
    fetch(request)
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
