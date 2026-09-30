// 3d-kanban: the office's service worker, registered by pwa.ts (docs/configuration.md#pwa).
//
// It stays out of the way of everything that needs the session or the socket:
// - the pages (/, /lite, /kanban) are network-first and never cached (they're for the signed-in
//   only); when the office can't be reached, the offline page stands in and reloads when it's back;
// - the hashed build files under /assets/ are cache-first, in a cache named after the build;
// - nothing else is touched: /ws, /api/*, /login, /join, /claim, /logout, any POST, other origins.
//
// A new version waits until the page asks for it (the "update available" toast in pwa.ts): no
// skipWaiting on install, so a tab never runs with half old, half new files.

// The build's id, put in by vite.config.ts (pwaBuild) when it writes dist/public/sw.js.
const BUILD = '__PWA_BUILD__';
const PREFIX = 'office-';
const ASSETS = `${PREFIX}assets-${BUILD}`;
const SHELL = `${PREFIX}shell-${BUILD}`;
const OFFLINE = '/offline.html';
const PAGES = new Set(['/', '/index.html', '/lite', '/lite.html', '/kanban', '/kanban.html']);
const NEVER = [/^\/ws(\/|$)/, /^\/api(\/|$)/, /^\/(login|join|claim|logout)(\.html)?(\/|$)/];

/**
 * What the worker does with a request: 'cache-first' (a hashed build file), 'network-first' (a
 * page being opened) or null (left to the browser, as if there were no worker).
 * @param {string} url the request's absolute URL
 * @param {string} method
 * @param {string} [mode] the request's mode ('navigate' for a page being opened)
 * @param {boolean} [range] whether it asks for a byte range (audio/video)
 * @param {string} [origin] this worker's origin
 * @returns {'cache-first' | 'network-first' | null}
 */
function route(url, method, mode, range, origin) {
  if (method !== 'GET') return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== (origin ?? self.location.origin)) return null;
  const p = u.pathname;
  if (NEVER.some((re) => re.test(p))) return null;
  if (p.startsWith('/assets/')) return range ? null : 'cache-first';
  if (mode === 'navigate' && PAGES.has(p)) return 'network-first';
  return null;
}

/** Only a whole, same-origin 200 that doesn't say no-store/private goes into the cache. */
function cacheable(res) {
  if (!res || res.status !== 200 || res.type !== 'basic' || res.redirected) return false;
  return !/no-store|private/i.test(res.headers.get('cache-control') ?? '');
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) await cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function offline() {
  return (await caches.match(OFFLINE, { cacheName: SHELL })) ?? Response.error();
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // A proxy in front of an office that's restarting (Caddy, nginx): the same as no answer.
    if (res.status === 502 || res.status === 503 || res.status === 504) return offline();
    return res;
  } catch {
    return offline();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add(new Request(OFFLINE, { cache: 'reload' }))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([ASSETS, SHELL]);
      for (const name of await caches.keys()) if (name.startsWith(PREFIX) && !keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

// The page's "reload" button: this version takes over, the page reloads on controllerchange.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const how = route(req.url, req.method, req.mode, req.headers.has('range'));
  if (how === 'cache-first') event.respondWith(cacheFirst(req));
  else if (how === 'network-first') event.respondWith(networkFirst(req));
});
