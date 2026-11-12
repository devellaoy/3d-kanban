// A task's UI images: the names and pairing (shared/kanban/uitesting.ts), the listing that skips what
// is not an image of the task, and the images plugin that lists, serves and removes them by the name the
// listing gives and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { UI_IMAGES_MAX, UI_IMAGE_MAX_BYTES, UI_IMAGE_RE, isUiImageName, pairImages, uiImageKind, uiImageSubject, uiImageType, type KanbanTaskImage } from '../src/shared/kanban/uitesting.js';
import { ensureUiImagesDir, imageListText, listUiImages, uiBlockId, uiImagesDir } from '../src/server/kanban/engine/uitesting.js';
import { createImagesPlugin, findUiImage } from '../src/server/kanban/integrations/images/index.js';
import { visitorPath } from '../src/server/multiplayer/paths.js';
import { makeCtx, WHO } from './kanban-integrations-ctx.js';

const img = (name: string): KanbanTaskImage => ({ name, kind: uiImageKind(name)!, subject: uiImageSubject(name)!, size: 1, mtime: 1 });

test('the name pattern: lower-case subject, before or after, a picture extension', () => {
  for (const ok of ['login-before.png', 'login-form-after.jpg', 'a-before.jpeg', 'board.narrow_1-after.webp', '1-before.png']) assert.ok(UI_IMAGE_RE.test(ok), ok);
  for (const bad of ['login.png', 'Login-before.png', '-before.png', '.x-before.png', 'login-before.gif', 'login-before.png.exe', 'a/b-before.png', '../x-before.png', 'login before-after.png', `${'a'.repeat(82)}-before.png`, 'login-before.svg', '']) assert.ok(!isUiImageName(bad), bad);
  assert.equal(uiImageKind('login-form-after.jpg'), 'after');
  assert.equal(uiImageSubject('login-form-after.jpg'), 'login-form');
  assert.equal(uiImageSubject('board.narrow_1-before.webp'), 'board.narrow_1');
  assert.equal(uiImageKind('nope.png'), undefined);
  assert.equal(uiImageSubject('nope.png'), undefined);
  assert.deepEqual(['a-before.png', 'a-before.jpg', 'a-before.webp'].map(uiImageType), ['image/png', 'image/jpeg', 'image/webp']);
});

test('pairImages pairs by subject, in alphabetical order, either side may be missing', () => {
  const pairs = pairImages(['b-after.png', 'a-before.png', 'b-before.png', 'c-after.png'].map(img));
  assert.deepEqual(pairs.map((p) => [p.subject, p.before?.name, p.after?.name]), [
    ['a', 'a-before.png', undefined],
    ['b', 'b-before.png', 'b-after.png'],
    ['c', undefined, 'c-after.png'],
  ]);
  assert.deepEqual(pairImages([]), []);
});

function setup() {
  const ctx = makeCtx();
  const task = ctx.repo.createTask({ project: 'p', title: 'x', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'T' });
  const dir = uiImagesDir(ctx.filesDir, task.id);
  ensureUiImagesDir(dir);
  return { ctx, task, dir, plugin: createImagesPlugin(ctx) };
}

test('the folder is task-<id>/ui in the grant folder, private', () => {
  const { ctx, task, dir } = setup();
  assert.equal(dir, path.join(ctx.filesDir, 'grants', `task-${task.id}`, 'ui'));
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('the listing skips links, wrong names, folders and oversize files, and keeps at most 40', () => {
  const { ctx, dir } = setup();
  writeFileSync(path.join(dir, 'login-before.png'), 'b');
  writeFileSync(path.join(dir, 'login-after.png'), 'aa');
  writeFileSync(path.join(dir, 'notes.txt'), 'x');
  writeFileSync(path.join(dir, 'Bad-after.png'), 'x');
  writeFileSync(path.join(dir, '.pr-body-1.md'), 'x');
  mkdirSync(path.join(dir, 'dir-before.png'));
  writeFileSync(path.join(ctx.filesDir, 'secret.png'), 'outside');
  symlinkSync(path.join(ctx.filesDir, 'secret.png'), path.join(dir, 'link-before.png'));
  writeFileSync(path.join(dir, 'huge-after.png'), '');
  truncateSync(path.join(dir, 'huge-after.png'), UI_IMAGE_MAX_BYTES + 1);
  assert.deepEqual(listUiImages(dir).map((i) => [i.name, i.kind, i.subject, i.size]), [
    ['login-before.png', 'before', 'login', 1],
    ['login-after.png', 'after', 'login', 2],
  ]);
  assert.deepEqual(listUiImages(path.join(dir, 'nowhere')), []);
  for (let i = 0; i < UI_IMAGES_MAX + 5; i++) writeFileSync(path.join(dir, `s${String(i).padStart(2, '0')}-after.png`), 'x');
  assert.equal(listUiImages(dir).length, UI_IMAGES_MAX);
});

test('the review prompt lists the images by subject with their paths', () => {
  assert.equal(imageListText('/d', []), 'none yet');
  assert.equal(imageListText('/d', ['a-before.png', 'b-after.png'].map(img)), `- a: before ${path.join('/d', 'a-before.png')}\n- b: after ${path.join('/d', 'b-after.png')}`);
});

test('which block a run gets', () => {
  assert.equal(uiBlockId('implement', true, false), 'kanban.uiTesting');
  assert.equal(uiBlockId('implement', false, true), 'kanban.uiTesting.onRequest');
  assert.equal(uiBlockId('review', false, false), undefined);
  assert.equal(uiBlockId('review', true, false), 'kanban.uiTesting.review');
  assert.equal(uiBlockId('review', false, true), 'kanban.uiTesting.review');
  assert.equal(uiBlockId('fix', false, false), undefined);
  assert.equal(uiBlockId('fix', true, false), 'kanban.uiTesting.fix');
  assert.equal(uiBlockId('comment', false, false), 'kanban.uiTesting.onRequest');
  assert.equal(uiBlockId('comment', false, true), 'kanban.uiTesting.fix');
});

async function call(plugin: ReturnType<typeof createImagesPlugin>, url: string, method = 'GET') {
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      headers = h ?? {};
      return res;
    },
    write(b: Buffer | string) {
      chunks.push(Buffer.from(b));
      return true;
    },
    end(b?: string | Buffer) {
      if (b) chunks.push(Buffer.from(b));
      done();
    },
    on() { return res; },
    once() { return res; },
    emit() { return true; },
  } as unknown as ServerResponse;
  const handled = await plugin.http!['/api/kanban/tasks/']({ method } as IncomingMessage, res, new URL(url, 'http://x'), WHO);
  if (handled && status !== 200) done();
  if (handled && status === 200 && method === 'HEAD') done();
  if (handled) await Promise.race([finished, new Promise((r) => setTimeout(r, 500))]);
  return { status, headers, body: Buffer.concat(chunks).toString(), handled };
}

test('lists the images, and says nothing about other routes', async () => {
  const { task, dir, plugin } = setup();
  writeFileSync(path.join(dir, 'a-before.png'), 'png');
  const r = await call(plugin, `/api/kanban/tasks/${task.id}/images`);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body) as { taskId: number; images: KanbanTaskImage[] };
  assert.equal(body.taskId, task.id);
  assert.deepEqual(body.images.map((i) => [i.name, i.kind, i.subject, i.size]), [['a-before.png', 'before', 'a', 3]]);
  assert.equal(Object.keys(body.images[0]).sort().join(), 'kind,mtime,name,size,subject');
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/reports`)).handled, false);
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images`, 'POST')).status, 405);
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images`, 'DELETE')).status, 405);
  assert.equal((await call(plugin, '/api/kanban/tasks/999/images')).status, 404);
});

test('serves a listed image by its extension, uncached, with nosniff and a sandbox', async () => {
  const { task, dir, plugin } = setup();
  writeFileSync(path.join(dir, 'a-after.webp'), 'webp-bytes');
  const r = await call(plugin, `/api/kanban/tasks/${task.id}/images/a-after.webp`);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'webp-bytes');
  assert.equal(r.headers['content-type'], 'image/webp');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /sandbox/);
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images/b-after.png`)).status, 404);
});

test('refuses traversal, links and anything not in the listing', async () => {
  const { ctx, task, dir, plugin } = setup();
  writeFileSync(path.join(ctx.filesDir, 'secret.png'), 'outside');
  symlinkSync(path.join(ctx.filesDir, 'secret.png'), path.join(dir, 'link-before.png'));
  writeFileSync(path.join(dir, 'notes.txt'), 'text');
  for (const name of ['../secret.png', '..%2Fsecret.png', '%2E%2E%2Fsecret.png', 'link-before.png', 'notes.txt', encodeURIComponent(path.join(ctx.filesDir, 'secret.png')), '%E0%A4%A']) {
    for (const method of ['GET', 'DELETE']) {
      const r = await call(plugin, `/api/kanban/tasks/${task.id}/images/${name}`, method);
      assert.ok(!r.handled || r.status === 404 || r.status === 400, `${method} ${name}: ${r.status}`);
      assert.doesNotMatch(r.body, /outside/);
    }
  }
  assert.equal(findUiImage(dir, '../secret.png'), undefined);
  assert.equal(findUiImage(dir, 'link-before.png'), undefined);
  assert.ok(existsSync(path.join(ctx.filesDir, 'secret.png')) && existsSync(path.join(dir, 'link-before.png')) && existsSync(path.join(dir, 'notes.txt')));
});

test('removes one image and answers the list that is left', async () => {
  const { task, dir, plugin } = setup();
  writeFileSync(path.join(dir, 'a-before.png'), 'x');
  writeFileSync(path.join(dir, 'a-after.png'), 'y');
  const r = await call(plugin, `/api/kanban/tasks/${task.id}/images/a-before.png`, 'DELETE');
  assert.equal(r.status, 200);
  assert.deepEqual((JSON.parse(r.body) as { images: KanbanTaskImage[] }).images.map((i) => i.name), ['a-after.png']);
  assert.ok(!existsSync(path.join(dir, 'a-before.png')) && existsSync(path.join(dir, 'a-after.png')));
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images/a-before.png`, 'DELETE')).status, 404);
});

test('a visitor may read the list and the images, never remove one', () => {
  assert.ok(visitorPath('GET', '/api/kanban/tasks/12/images'));
  assert.ok(visitorPath('GET', '/api/kanban/tasks/12/images/login-before.png'));
  assert.ok(!visitorPath('DELETE', '/api/kanban/tasks/12/images/login-before.png'));
  assert.ok(!visitorPath('GET', '/api/kanban/tasks/12/images/a/b.png'));
});

test('a ui folder that is itself a link is refused: nothing listed, served or removed', async () => {
  const { ctx, task, dir, plugin } = setup();
  const real = path.join(ctx.filesDir, 'elsewhere');
  mkdirSync(real);
  writeFileSync(path.join(real, 'a-before.png'), 'secret');
  rmSync(dir, { recursive: true });
  symlinkSync(real, dir);
  assert.deepEqual(listUiImages(dir), []);
  assert.equal(findUiImage(dir, 'a-before.png'), undefined);
  assert.deepEqual(JSON.parse((await call(plugin, `/api/kanban/tasks/${task.id}/images`)).body).images, []);
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images/a-before.png`)).status, 404);
  assert.equal((await call(plugin, `/api/kanban/tasks/${task.id}/images/a-before.png`, 'DELETE')).status, 404);
  assert.ok(existsSync(path.join(real, 'a-before.png')));
});
