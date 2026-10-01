// 3d-kanban: links to the office's own pages open in the same window (a new tab is a second character).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_PAGES, isAppPage, kanbanTaskOf } from '../src/client/kanban/model.js';
import { pageRoutes } from '../src/server/http/routes/pages.js';
import { kanbanRoutes } from '../src/server/kanban/http/routes.js';

const base = 'http://office:3000/';

test('isAppPage: the office’s own pages, on its own origin', () => {
  for (const href of ['/kanban?task=3', 'http://office:3000/kanban?x', '/?3d=1', '/lite', '/join?x']) assert.equal(isAppPage(href, base), true, href);
  for (const href of ['/api/kanban/attachments/abc', 'https://github.com/a/b', 'http://office:5173/', 'javascript:alert(1)', 'mailto:x', 'http://[bad']) {
    assert.equal(isAppPage(href, base), false, href);
  }
  // This computer under another name, on the same port, is the same office.
  assert.equal(isAppPage('http://127.0.0.1:4600/kanban?task=5', 'http://localhost:4600/kanban'), true);
  assert.equal(isAppPage('http://localhost:4600/lite', 'http://[::1]:4600/'), true);
  assert.equal(isAppPage('http://127.0.0.1:4601/kanban', 'http://localhost:4600/'), false);
  assert.equal(isAppPage('http://127.0.0.1:4600/kanban', 'http://office.example.ts.net:4600/'), false);
  // An in-page #anchor or a relative link stays on the page it's on, in the same window.
  assert.equal(isAppPage('#notes', 'http://office:3000/kanban?task=2'), true);
  assert.equal(isAppPage('kanban?task=4', base), true);
});

test('kanbanTaskOf: the task a link to the kanban opens', () => {
  assert.equal(kanbanTaskOf('/kanban?project=p&task=12&tab=plan', base), 12);
  assert.equal(kanbanTaskOf('http://127.0.0.1:3000/kanban.html?task=7', 'http://localhost:3000/kanban'), 7);
  for (const href of ['/kanban', '/kanban?task=x', '/kanban?task=-1', '/lite?task=3', 'https://github.com/kanban?task=3', 'http://office:5173/kanban?task=3']) {
    assert.equal(kanbanTaskOf(href, base), null, href);
  }
});

test('APP_PAGES are the server’s page routes', () => {
  const paths = (r: { path?: string | readonly string[] }) => (r.path === undefined ? [] : typeof r.path === 'string' ? [r.path] : [...r.path]);
  const { login, claim, join, office, lite } = pageRoutes;
  const pages = [login, claim, join, office, lite, kanbanRoutes.page].flatMap(paths);
  assert.deepEqual([...APP_PAGES].sort(), pages.sort());
  // A new .html page on the server belongs in APP_PAGES too.
  const html = [...Object.values(pageRoutes), ...Object.values(kanbanRoutes)].flatMap(paths).filter((p) => p.endsWith('.html') && p !== '/offline.html');
  for (const p of html) assert.ok(APP_PAGES.has(p), p);
});

// Static guard: no `_blank` near a literal link to an app page, the literals made from APP_PAGES. A heuristic:
// URLs carried in variables or built by helpers (kanbanUrl, deepLink) aren't caught.
test('no client code opens an app page in a new tab', () => {
  const root = path.join(import.meta.dirname, '..', 'src', 'client');
  // A literal page path, ending where a URL's path does. Bare '/' only as an href, query or anchor ('/' alone is split('/')).
  const literals = [...APP_PAGES].flatMap((p) =>
    ["'", '"', '`'].flatMap((q) => (p === '/' ? [`${q}/?`, `${q}/#`, `href: ${q}/${q}`] : [`${q}${p}${q}`, `${q}${p}?`, `${q}${p}#`, `${q}${p}$`])),
  );
  const bad: string[] = [];
  for (const f of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!f.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (let i = text.indexOf('_blank'); i >= 0; i = text.indexOf('_blank', i + 1)) {
      const near = text.slice(Math.max(0, i - 300), i + 100);
      if (literals.some((l) => near.includes(l))) bad.push(`${f}:${text.slice(0, i).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, []);
});
