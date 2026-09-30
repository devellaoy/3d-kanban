// integrations/reports: an investigation's report files are listed and served by the name the
// listing gives them, and nothing else under (or outside) the task's folder can be reached.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReportsPlugin, findReport, reportType } from '../src/server/kanban/integrations/reports/index.js';
import { reportDir } from '../src/server/kanban/integrations/refs/resolve.js';
import { makeCtx, WHO } from './kanban-integrations-ctx.js';

async function get(plugin: ReturnType<typeof createReportsPlugin>, url: string) {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      headers = h ?? {};
      return res;
    },
    end(b?: string | Buffer) {
      body = b ? b.toString() : '';
    },
  } as unknown as ServerResponse;
  const handled = await plugin.http!['/api/kanban/tasks/']({ method: 'GET' } as IncomingMessage, res, new URL(url, 'http://x'), WHO);
  return { status, headers, body, handled };
}

function setup() {
  const ctx = makeCtx();
  const task = ctx.repo.createTask({ project: 'p', title: 'x', type: 'investigate', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T' });
  const dir = reportDir(ctx.filesDir, task.id);
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'report.md'), '# Findings\n');
  writeFileSync(path.join(dir, 'sub', 'notes.txt'), 'plain');
  writeFileSync(path.join(dir, '.hidden'), 'no');
  writeFileSync(path.join(ctx.filesDir, 'secret.txt'), 'outside');
  symlinkSync(path.join(ctx.filesDir, 'secret.txt'), path.join(dir, 'link.md'));
  return { ctx, task, dir, plugin: createReportsPlugin(ctx) };
}

test('lists regular report files, never dot files or links', async () => {
  const { task, plugin } = setup();
  const r = await get(plugin, `/api/kanban/tasks/${task.id}/reports`);
  assert.equal(r.status, 200);
  const names = (JSON.parse(r.body) as { reports: { name: string; size: number; mtime: number }[] }).reports.map((x) => x.name).sort();
  assert.deepEqual(names, ['report.md', 'sub/notes.txt']);
});

test('serves a listed report as markdown or text, with nosniff', async () => {
  const { task, plugin } = setup();
  const md = await get(plugin, `/api/kanban/tasks/${task.id}/reports/report.md`);
  assert.equal(md.status, 200);
  assert.equal(md.body, '# Findings\n');
  assert.match(md.headers['content-type'], /^text\/markdown/);
  assert.equal(md.headers['x-content-type-options'], 'nosniff');
  const txt = await get(plugin, `/api/kanban/tasks/${task.id}/reports/${encodeURIComponent('sub/notes.txt')}?download=1`);
  assert.equal(txt.status, 200);
  assert.match(txt.headers['content-type'], /^text\/plain/);
  assert.match(txt.headers['content-disposition'], /^attachment/);
  assert.equal(reportType('x.html'), 'text/plain; charset=utf-8');
});

test('refuses traversal, links and anything not in the listing', async () => {
  const { ctx, task, dir, plugin } = setup();
  for (const name of ['../secret.txt', '..%2Fsecret.txt', '%2E%2E%2Fsecret.txt', 'link.md', '.hidden', encodeURIComponent(path.join(ctx.filesDir, 'secret.txt')), 'sub/../../secret.txt', '%E0%A4%A']) {
    const r = await get(plugin, `/api/kanban/tasks/${task.id}/reports/${name}`);
    // A literal ../ is already gone from the URL's path (it's no report route then); the rest are refused.
    assert.ok(!r.handled || r.status === 404 || r.status === 400, `${name}: ${r.status}`);
    assert.doesNotMatch(r.body, /outside/);
  }
  assert.equal(findReport(dir, '../secret.txt'), undefined);
  assert.equal((await get(plugin, '/api/kanban/tasks/999/reports')).status, 404);
  assert.equal((await get(plugin, `/api/kanban/tasks/${task.id}/changes`)).handled, false);
});
