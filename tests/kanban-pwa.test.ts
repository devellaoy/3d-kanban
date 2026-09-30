// 3d-kanban: the PWA: manifest, icons, the pages' tags, and the service worker's routing and caching
// (src/client/public/sw.js, run in a vm with a fake `self`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const client = path.resolve(import.meta.dirname, '../src/client');
const pub = path.join(client, 'public');
const ORIGIN = 'https://office.test';

interface Icon { src: string; sizes: string; type: string; purpose?: string }
interface Manifest {
  id?: string; name: string; short_name: string; description: string; start_url: string; scope: string; display: string;
  theme_color: string; background_color: string; icons: Icon[]; shortcuts: { name: string; url: string; icons?: Icon[] }[];
}

const manifest = (): Manifest => JSON.parse(readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8')) as Manifest;

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is a PNG`);
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('the manifest has what an install needs', () => {
  const m = manifest();
  assert.equal(m.name, '3D Kanban');
  assert.equal(m.short_name, '3D Kanban');
  assert.ok(m.description.length > 10);
  assert.equal(m.start_url, '/kanban');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const has = (sizes: string, purpose: string) => m.icons.some((i) => i.sizes === sizes && i.type === 'image/png' && (i.purpose ?? 'any').split(' ').includes(purpose));
  assert.ok(has('192x192', 'any'));
  assert.ok(has('512x512', 'any'));
  assert.ok(has('512x512', 'maskable'));
  assert.ok(m.icons.some((i) => i.type === 'image/svg+xml'));
  assert.deepEqual(m.shortcuts.map((s) => s.url).sort(), ['/', '/kanban', '/lite']);
});

test("every icon the manifest names exists, at the size it says", () => {
  const m = manifest();
  const all = [...m.icons, ...m.shortcuts.flatMap((s) => s.icons ?? [])];
  for (const icon of all) {
    const file = path.join(pub, icon.src);
    assert.ok(existsSync(file), `${icon.src} exists`);
    if (icon.type !== 'image/png') continue;
    const [w, hgt] = pngSize(file);
    assert.equal(`${w}x${hgt}`, icon.sizes, icon.src);
  }
  assert.deepEqual(pngSize(path.join(pub, 'icons/apple-touch-icon.png')), [180, 180]);
  assert.ok(existsSync(path.join(pub, 'offline.html')));
});

test('the office pages link the manifest and pwa.ts; the sign-in pages only get the colour', () => {
  for (const page of ['index.html', 'lite.html', 'kanban.html']) {
    const html = readFileSync(path.join(client, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/, page);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/, page);
    assert.equal(html.match(/name="theme-color"/g)?.length, 1, page);
    assert.match(html, /<script type="module" src="\.\/pwa\.ts"><\/script>/, page);
  }
  for (const page of ['login.html', 'join.html', 'claim.html']) {
    const html = readFileSync(path.join(client, page), 'utf8');
    assert.equal(html.match(/name="theme-color"/g)?.length, 1, page);
    assert.doesNotMatch(html, /manifest|pwa\.ts/, page);
  }
});

type Route = 'cache-first' | 'network-first' | null;
type Listener = (event: unknown) => void;

/** public/sw.js in a vm: its functions, listeners, and the fake caches and fetch it talks to. */
function loadWorker(opts: { fetch?: (req: unknown) => Promise<unknown>; keys?: string[] } = {}) {
  const listeners: Record<string, Listener> = {};
  const deleted: string[] = [];
  const put: string[] = [];
  const calls = { skipWaiting: 0, claim: 0 };
  const cache = {
    match: async () => undefined,
    put: async (req: { url: string }) => void put.push(req.url),
    add: async () => {},
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => void (listeners[type] = fn),
    skipWaiting: () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
  };
  const sandbox: Record<string, unknown> = {
    self,
    URL,
    Request: class { constructor(public url: string, public init?: unknown) {} },
    Response: { error: () => ({ error: true }) },
    caches: {
      open: async () => cache,
      match: async () => undefined,
      keys: async () => opts.keys ?? [],
      delete: async (name: string) => void deleted.push(name),
    },
    fetch: opts.fetch ?? (async () => { throw new Error('offline'); }),
  };
  vm.runInNewContext(readFileSync(path.join(pub, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });
  const route = sandbox.route as (url: string, method: string, mode?: string, range?: boolean) => Route;
  const cacheable = sandbox.cacheable as (res: unknown) => boolean;
  return { route, cacheable, listeners, deleted, put, calls, sandbox };
}

const res = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({
  status, type: 'basic', redirected: false, headers: new Headers(headers), clone() { return this; }, ...extra,
});

/** The fetch handler's answer to a request, or undefined when it leaves the request alone. */
async function handle(w: ReturnType<typeof loadWorker>, url: string, method = 'GET', mode = 'cors', headers: Record<string, string> = {}) {
  let answer: Promise<unknown> | undefined;
  w.listeners.fetch({ request: { url: ORIGIN + url, method, mode, headers: new Headers(headers) }, respondWith: (p: Promise<unknown>) => void (answer = p) });
  return answer ? { response: await answer } : undefined;
}

test('the service worker leaves the socket, the API, the sign-in pages and every POST alone', () => {
  const { route } = loadWorker();
  const u = (p: string) => ORIGIN + p;
  for (const p of ['/ws', '/ws?x=1', '/api/whoami', '/api/kanban/uploads/1', '/api', '/login', '/login.html', '/login?next=/kanban', '/join', '/claim', '/logout', '/api/logout']) {
    assert.equal(route(u(p), 'GET', 'navigate'), null, p);
    assert.equal(route(u(p), 'GET', 'cors'), null, p);
  }
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(route(u('/kanban'), m, 'navigate'), null, m);
    assert.equal(route(u('/assets/main-abc123.js'), m, 'cors'), null, m);
  }
  // Another origin (the service tunnels, a CDN), the manifest, icons, favicon: not the worker's.
  assert.equal(route('https://elsewhere.test/assets/x-abc.js', 'GET', 'cors'), null);
  for (const p of ['/manifest.webmanifest', '/icons/icon-192.png', '/favicon.svg', '/sw.js', '/offline.html', '/some/file']) assert.equal(route(u(p), 'GET', 'navigate'), null, p);
  assert.equal(route('not a url', 'GET', 'navigate'), null);
});

test('hashed build files are cache-first, the pages network-first', () => {
  const { route } = loadWorker();
  const u = (p: string) => ORIGIN + p;
  assert.equal(route(u('/assets/x-abc.js'), 'GET', 'cors'), 'cache-first');
  assert.equal(route(u('/assets/excalidraw-0.18.1/fonts/Virgil.woff2'), 'GET', 'cors'), 'cache-first');
  // A byte range (audio seeking) is the browser's own business.
  assert.equal(route(u('/assets/song-abc.mp3'), 'GET', 'no-cors', true), null);
  for (const p of ['/', '/index.html', '/lite', '/kanban', '/kanban.html', '/kanban?project=a', '/?floor=a&worker=b']) {
    assert.equal(route(u(p), 'GET', 'navigate'), 'network-first', p);
  }
  // A page fetched by script isn't a navigation.
  assert.equal(route(u('/kanban'), 'GET', 'cors'), null);
});

test('only a whole same-origin 200 goes into the cache', () => {
  const { cacheable } = loadWorker();
  assert.equal(cacheable(res(200)), true);
  assert.equal(cacheable(res(302)), false);
  assert.equal(cacheable(res(404)), false);
  assert.equal(cacheable(res(206)), false);
  assert.equal(cacheable(res(0, { type: 'opaque' })), false);
  assert.equal(cacheable(res(0, { type: 'opaqueredirect' })), false);
  assert.equal(cacheable(res(200, { redirected: true })), false);
  assert.equal(cacheable(res(200, {}, { 'cache-control': 'no-store' })), false);
  assert.equal(cacheable(res(200, {}, { 'cache-control': 'private, max-age=60' })), false);
  assert.equal(cacheable(undefined), false);
});

test('the fetch handler: assets cached on a 200 only, pages fall back to the offline page', async () => {
  let next = res(200);
  const w = loadWorker({ fetch: async () => next });
  assert.equal(await handle(w, '/api/whoami'), undefined);
  assert.equal(await handle(w, '/kanban', 'POST', 'navigate'), undefined);
  assert.equal(await handle(w, '/login', 'GET', 'navigate'), undefined);
  await handle(w, '/assets/a-1.js');
  next = res(404);
  await handle(w, '/assets/b-2.js');
  assert.deepEqual(w.put, [`${ORIGIN}/assets/a-1.js`]);
  // A sign-in redirect is passed through, never cached.
  next = res(0, { type: 'opaqueredirect' });
  const page = await handle(w, '/kanban', 'GET', 'navigate');
  assert.equal((page?.response as { type: string }).type, 'opaqueredirect');
  assert.deepEqual(w.put, [`${ORIGIN}/assets/a-1.js`]);
  // The office restarting behind a proxy, or no network: the offline page (Response.error() here, as the fake cache is empty).
  next = res(502);
  assert.deepEqual((await handle(w, '/', 'GET', 'navigate'))?.response, { error: true });
  const down = loadWorker();
  assert.deepEqual((await handle(down, '/lite', 'GET', 'navigate'))?.response, { error: true });
});

test('a new version waits for the page, and activating drops the old caches', async () => {
  const w = loadWorker({ keys: ['office-assets-old', 'office-shell-old', 'office-assets-__PWA_BUILD__', 'office-shell-__PWA_BUILD__', 'someone-else'] });
  for (const type of ['install', 'activate', 'fetch', 'message']) assert.ok(w.listeners[type], type);
  let installing: Promise<unknown> | undefined;
  w.listeners.install({ waitUntil: (p: Promise<unknown>) => void (installing = p) });
  await installing;
  assert.equal(w.calls.skipWaiting, 0);
  let activating: Promise<unknown> | undefined;
  w.listeners.activate({ waitUntil: (p: Promise<unknown>) => void (activating = p) });
  await activating;
  assert.deepEqual(w.deleted, ['office-assets-old', 'office-shell-old']);
  assert.equal(w.calls.claim, 1);
  w.listeners.message({ data: { type: 'something' } });
  assert.equal(w.calls.skipWaiting, 0);
  w.listeners.message({ data: { type: 'skip-waiting' } });
  assert.equal(w.calls.skipWaiting, 1);
});
