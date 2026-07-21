// Service worker for the Bookmark Launcher PWA.
//
// This file is served from the app root so the default registration scope
// (./sw.js) covers the entire /App-Creation-/ deployment. Every cached URL is
// relative for the same reason — the app is hosted on a project subpath, not a
// domain root.
//
// DEPLOY CHECKLIST: ANY change to a precached shell asset REQUIRES bumping
// VERSION below. The shell cache key is derived from VERSION, so bumping it is
// the single knob that invalidates stale shells on the next activate.

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const FAVICON_CACHE = "favicons";
const FAVICON_MAX = 500;

const PRECACHE = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/parser.js",
  "./js/storage.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

// Update flow (IC-1): the page decides when a waiting worker takes over by
// posting {type:"SKIP_WAITING"}. Install never calls skipWaiting itself.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Install: precache the shell atomically. addAll rejects (and the install
// fails) if any single asset can't be fetched — no per-asset catch. No
// skipWaiting here; the new worker waits until the page opts in.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)));
});

// Activate: drop stale shell caches (any "shell-*" that isn't the current one),
// leaving the persistent "favicons" cache untouched, then claim open clients.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("shell-") && n !== SHELL_CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Trim the favicon cache to FAVICON_MAX by insertion order (Cache Storage keys
// preserve insertion order), deleting the oldest overflow entries. Only invoked
// from the uncached-growth branch, so it runs at most once per new favicon.
async function trimFavicons(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - FAVICON_MAX;
  if (overflow <= 0) return;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // (a) Only GET, and never partial/Range requests (media seeking) — let the
  // network handle those directly.
  if (req.method !== "GET") return;
  if (req.headers.has("range")) return;

  const url = new URL(req.url);

  // (b) Navigations: serve the cached app shell first, falling back to the
  // network, and finally back to the cached shell if the network fails.
  if (req.mode === "navigate") {
    event.respondWith(
      caches
        .match("./index.html")
        .then((cached) => cached ?? fetch(req).catch(() => caches.match("./index.html")))
    );
    return;
  }

  // (c) Same-origin GET: cache-first. On a miss, fetch and opportunistically
  // cache same-origin ("basic") OK responses into the shell cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((resp) => {
            if (resp.ok && resp.type === "basic") {
              const clone = resp.clone();
              event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(req, clone)));
            }
            return resp;
          })
          .catch(() => cached || Response.error());
      })
    );
    return;
  }

  // (d) Favicon providers: stale-while-revalidate into the persistent favicons
  // cache. Opaque cross-origin responses are cached as-is.
  const isFavicon =
    url.hostname === "icons.duckduckgo.com" ||
    (url.hostname === "www.google.com" && url.pathname.startsWith("/s2/favicons"));
  if (isFavicon) {
    event.respondWith(
      caches.open(FAVICON_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) {
            event.waitUntil(
              fetch(req)
                .then((resp) => cache.put(req, resp.clone()))
                .catch(() => {})
            );
            return cached;
          }
          return fetch(req)
            .then(async (resp) => {
              await cache.put(req, resp.clone());
              event.waitUntil(trimFavicons(cache));
              return resp;
            })
            .catch(() => Response.error());
        })
      )
    );
    return;
  }

  // (e) Any other cross-origin GET: don't intercept — no respondWith.
});
