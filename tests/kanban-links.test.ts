// 3d-kanban: links to the office's own pages open in the same window (a new tab is a second character).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAppPage } from '../src/client/kanban/model.js';

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
});

// Static guard: no `_blank` near a literal link to an app page. URLs carried in variables aren't caught.
test('no client code opens an app page in a new tab', () => {
  const root = path.join(import.meta.dirname, '..', 'src', 'client');
  const literals = ['`/kanban', "'/kanban", '"/kanban', "'/lite", "'/?", "'/login", "'/join", "'/claim", "href: '/'"];
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
