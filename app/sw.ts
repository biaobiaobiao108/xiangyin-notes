const CACHE_NAME = "xiangying-notes-shell-v1";
const PRECACHE_URLS = ["/", "/app", "/manifest.webmanifest"];

type Extendable = { waitUntil(promise: Promise<unknown>): void };
type FetchEventLike = Extendable & { request: Request; respondWith(response: Promise<Response> | Response): void };
type WorkerLike = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const worker = globalThis as unknown as WorkerLike;

worker.addEventListener("install", (event) => {
  (event as Extendable).waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

worker.addEventListener("activate", (event) => {
  (event as Extendable).waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("xiangying-notes-") && key !== CACHE_NAME).map((key) => caches.delete(key)))),
    worker.clients.claim(),
  ]));
});

worker.addEventListener("message", (event) => {
  const message = (event as MessageEvent).data;
  if (message?.type === "SKIP_WAITING") void worker.skipWaiting();
});

worker.addEventListener("fetch", (event) => {
  const fetchEvent = event as unknown as FetchEventLike;
  const request = fetchEvent.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") return;

  if (request.mode === "navigate") {
    fetchEvent.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
      }
      return response;
    }).catch(async () => await caches.match(request) ?? await caches.match("/index.html") ?? await caches.match("/") ?? new Response("离线时暂时无法打开应用", { status: 503 })));
    return;
  }

  const cacheable = ["script", "style", "image", "font"].includes(request.destination) || /\.(?:css|js|png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname);
  if (!cacheable) return;
  fetchEvent.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
