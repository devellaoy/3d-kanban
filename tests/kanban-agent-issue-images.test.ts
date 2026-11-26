// GET /office/tasks/issue brings the ticket's picture attachments (agent-read-images.ts): downloaded with the office's own
// Jira connection into the asking task's grant folder, named in the text where a media node can be joined to one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssues } from '../src/server/kanban/integrations/issues/index.js';
import { ISSUE_READ_LIMITS } from '../src/server/kanban/integrations/issues/agent-read.js';
import { imageStep, removeIssueImages, sweepIssueImages } from '../src/server/kanban/integrations/issues/agent-read-images.js';
import { adfToText } from '../src/server/kanban/integrations/issues/jira.js';
import { archiveOldTasks, createCorePlugin } from '../src/server/kanban/ws.js';
import { grantDir } from '../src/server/kanban/uploads.js';
import type { KanbanClient, KanbanHookCaller } from '../src/server/kanban/registry.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

type Json = Record<string, any>;
const SITE = 'team.atlassian.net';
const AUTH = `Basic ${Buffer.from('me@x.fi:tok-secret-1').toString('base64')}`;
const src: IssueSourceConfig = { id: 's1', kind: 'jira', site: SITE, projectKeys: ['UYT'], filters: {} };
const adf = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const single = (attrs: Json) => ({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', collection: '', ...attrs } }] });
const PNG = (n = 20) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 1)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const att = (id: string, filename: string, over: Json = {}) => ({ id, filename, mimeType: 'image/png', size: 28, created: '2026-09-01T10:00:00.000+0000', content: `https://${SITE}/secure/attachment/${id}/${filename}`, ...over });
const UUID = '0a1b2c3d-1111-4222-8333-444455556666';

type Call = { url: string; method: string; auth: string; redirect?: string };
interface Opts {
  attachments?: unknown[];
  description?: unknown;
  comments?: unknown[];
  /** Bytes per attachment id (for `redirect=false`), or a status. */
  files?: Record<string, Buffer | number | 'hang'>;
  /** The Location the plain content URL answers with, per id. */
  location?: Record<string, string>;
  issue?: Json;
  /** Milliseconds every picture download takes. */
  delay?: number;
  /** Ticket attachments by key (the one `attachments` for the rest). */
  byKey?: Record<string, unknown[]>;
}

function setup(o: Opts = {}) {
  const ctx = makeCtx([def('app', '/tmp/app', { repo: 'o/app' })]);
  after(() => rmSync(ctx.tmp, { recursive: true, force: true }));
  ctx.settings.setProject('app', { issueSources: [src] });
  (ctx as unknown as { secrets: unknown }).secrets = { jiraConnections: () => [{ id: 'c1', name: 'Team', site: SITE, email: 'me@x.fi', token: 'tok-secret-1' }] };
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: String(init.method), auth: String(headers.authorization), redirect: init.redirect });
    const m = /\/attachment\/content\/(\d+)(\?redirect=false)?$/.exec(url);
    if (m) {
      const f = o.files?.[m[1]];
      if (m[2]) {
        if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
        if (f === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
        if (typeof f === 'number') return new Response('secret jira text', { status: f });
        return new Response(f ? new Uint8Array(f) : 'not found', { status: f ? 200 : 404 });
      }
      const loc = o.location?.[m[1]];
      return loc ? new Response(null, { status: 303, headers: { location: loc } }) : new Response('{}', { status: 404 });
    }
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/comment?')) return json({ comments: (o.comments ?? []).slice().reverse() });
    if (url.includes('/search/jql')) return json({ issues: [] });
    const key = decodeURIComponent(url.split('/issue/')[1].split(/[?/]/)[0]);
    return json(o.issue ?? { key, fields: { summary: 'T', description: o.description ?? adf(para('The description')), labels: [], issuetype: { name: 'Story' }, project: { key: key.split('-')[0] }, updated: '2026-09-02T10:00:00.000+0000', attachment: o.byKey?.[key] ?? o.attachments } });
  }) as unknown as typeof globalThis.fetch;
  const handler = createIssues(ctx, { fetch }).plugin.hook!['/office/tasks/issue']!;
  const task = (over: Json = {}) => ctx.repo.createTask({ project: 'app', title: 'T', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 'x', ticket: 'UYT-7', ticketUrl: `https://${SITE}/browse/UYT-7`, ...over });
  const call = async (who: Partial<KanbanHookCaller>, ref?: string) => {
    let status = 0;
    let text = '';
    const res = { writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) } as unknown as ServerResponse;
    await handler({ method: 'GET', headers: {} } as unknown as IncomingMessage, res, new URL(`/office/tasks/issue${ref ? `?ref=${ref}` : ''}`, 'http://127.0.0.1'), { workerId: 'w1', floorId: 'app', name: 'Ada', kind: 'agent', ...who });
    assert.ok(!text.includes('tok-secret-1') && !/token=/i.test(text), 'no secret or media token in the answer');
    return { status, body: JSON.parse(text) as Json, text };
  };
  const downloads = () => calls.filter((c) => c.url.endsWith('?redirect=false'));
  const folder = (taskId: number, key = 'UYT-7') => path.join(grantDir(ctx.filesDir, taskId), 'jira-images', key);
  return { ctx, calls, call, task, downloads, folder };
}

test('adfToText without a resolver is what it was, with one the media nodes name their files', () => {
  const doc = adf(para('a'), { type: 'mediaGroup', content: [{ type: 'media', attrs: { type: 'file', id: 'x', alt: 'one.png' } }, { type: 'media', attrs: { type: 'file', id: 'y' } }] }, { type: 'paragraph', content: [{ type: 'mediaInline', attrs: { id: 'z' } }] }, single({ id: 'w', alt: 'two.png' }));
  assert.equal(adfToText(doc), 'a\n\n[attachment]\n\n[attachment]');
  const named = adfToText(doc, (at) => (at.alt === 'one.png' ? '1-one.png' : at.id === 'w' ? '2-two.png' : undefined));
  assert.equal(named, 'a\n\n[image: 1-one.png]\n[attachment]\n\n[attachment]\n\n[image: 2-two.png]');
  assert.equal(adfToText(adf(single({ id: 'w' }))), '[attachment]');
});

test('pictures come back with paths in the task’s grant folder, the text names them by alt, the ones the description cites first', async () => {
  const s = setup({
    attachments: [att('101', 'old.png', { created: '2026-08-01T10:00:00.000+0000' }), att('102', 'shot.png', { created: '2026-07-01T10:00:00.000+0000' }), att('103', 'new.jpg', { mimeType: 'image/jpeg', size: JPG.length }), att('104', 'spec.pdf', { mimeType: 'application/pdf' })],
    description: adf(para('See:'), single({ id: UUID, alt: 'shot.png' }), single({ id: 'other-uuid', alt: 'nothing.png' })),
    comments: [{ id: '1', author: { displayName: 'Bo' }, body: adf(single({ id: 'c-uuid', alt: 'new.jpg' })), created: '2026-09-01T10:01:00.000+0000' }],
    files: { '101': PNG(), '102': PNG(), '103': JPG },
  });
  const t = s.task();
  const r = await s.call({ taskId: t.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.images.map((i: Json) => i.name), ['shot.png', 'new.jpg', 'old.png']);
  const dir = s.folder(t.id);
  assert.deepEqual(r.body.images.map((i: Json) => i.file), ['102-shot.png', '103-new.jpg', '101-old.png']);
  for (const i of r.body.images) {
    assert.equal(i.path, path.join(dir, i.file));
    assert.equal(statSync(i.path).size, i.bytes);
    assert.equal(statSync(i.path).mode & 0o777, 0o600);
  }
  assert.deepEqual(r.body.images.map((i: Json) => i.type), ['image/png', 'image/jpeg', 'image/png']);
  assert.deepEqual(readFileSync(r.body.images[1].path), JPG);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'spec.pdf', reason: 'not an image' }]);
  assert.equal(r.body.issue.body, 'See:\n\n[image: 102-shot.png]\n\n[attachment]');
  assert.equal(r.body.comments[0].body, '[image: 103-new.jpg]');
  // The office built the addresses, with its own sign-in, and followed no redirect. Three calls, three downloads, and a probe per picture for the nodes that name no file (answered 404: the placeholder stays).
  assert.equal(s.calls.length, 9);
  for (const c of s.downloads()) assert.deepEqual([c.auth, c.redirect, c.url.startsWith(`https://${SITE}/rest/api/3/attachment/content/`)], [AUTH, 'error', true]);
});

test('a media node without a matching alt is joined by the uuid in the Location of Jira’s redirect; the Location is never followed or shown', async () => {
  const s = setup({
    attachments: [att('201', 'a.png'), att('202', 'b.png')],
    description: adf(single({ id: UUID })),
    comments: [{ id: '1', author: { displayName: 'Bo' }, body: adf(single({ id: 'ffffffff-1111-4222-8333-444455556666' })), created: '2026-09-01T10:01:00.000+0000' }],
    files: { '201': PNG(), '202': PNG() },
    location: { '201': `https://api.media.atlassian.com/file/${UUID}/binary?token=SECRETTOKEN&client=x`, '202': 'https://api.media.atlassian.com/other/path' },
  });
  const t = s.task();
  const r = await s.call({ taskId: t.id });
  assert.equal(r.body.issue.body, '[image: 201-a.png]');
  assert.equal(r.body.comments[0].body, '[attachment]');
  assert.ok(!r.text.includes('SECRETTOKEN') && !r.text.includes('api.media'));
  const probes = s.calls.filter((c) => /content\/\d+$/.test(c.url));
  assert.equal(probes.length, 2);
  assert.ok(probes.every((c) => c.redirect === 'manual' && c.auth === AUTH));
  assert.ok(s.calls.every((c) => c.url.startsWith(`https://${SITE}/`)));
  // Asked again: the files are reused and the uuids are remembered.
  s.calls.length = 0;
  const again = await s.call({ taskId: t.id });
  assert.equal(again.body.issue.body, '[image: 201-a.png]');
  // Only the picture whose probe gave no uuid is asked again.
  assert.equal(s.calls.length, 4);
});

test('a failed probe is silent: the placeholder stays', async () => {
  const s = setup({ attachments: [att('211', 'a.png')], description: adf(single({ id: UUID })), files: { '211': PNG() } });
  const t = s.task();
  const r = await s.call({ taskId: t.id });
  assert.equal(r.body.issue.body, '[attachment]');
  assert.equal(r.body.images.length, 1);
  assert.equal(r.body.partial, undefined);
});

test('limits: ten pictures, 5 MB each (declared and streamed), 20 MB in all, the task’s folder, and twenty skipped entries', async () => {
  const MB = 1024 * 1024;
  const many = Array.from({ length: 12 }, (_, i) => att(String(300 + i), `p${i}.png`, { created: `2026-09-01T10:${String(i).padStart(2, '0')}:00.000+0000` }));
  const a = setup({ attachments: many, files: Object.fromEntries(many.map((m) => [m.id, PNG()])) });
  let r = await a.call({ taskId: a.task().id });
  assert.equal(r.body.images.length, 10);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'p1.png', reason: 'over the limit of 10 images' }, { name: 'p0.png', reason: 'over the limit of 10 images' }]);
  assert.equal(ISSUE_READ_LIMITS.images, 10);

  const big = setup({ attachments: [att('320', 'big.png', { size: 6 * MB }), att('321', 'lying.png', { size: 10 })], files: { '320': PNG(), '321': Buffer.concat([PNG(), Buffer.alloc(5 * MB)]) } });
  r = await big.call({ taskId: big.task().id });
  assert.deepEqual(r.body.images, []);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'big.png', reason: 'too big' }, { name: 'lying.png', reason: 'too big' }]);
  assert.equal(big.downloads().length, 1);
  assert.equal(r.body.partial, undefined);

  const four = Array.from({ length: 5 }, (_, i) => att(String(330 + i), `t${i}.png`, { size: 4.5 * MB, created: `2026-09-01T10:0${i}:00.000+0000` }));
  const tot = setup({ attachments: four, files: Object.fromEntries(four.map((m) => [m.id, PNG()])) });
  r = await tot.call({ taskId: tot.task().id });
  assert.equal(r.body.images.length, 4);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 't0.png', reason: 'over 20 MB in all' }]);

  const full = setup({ attachments: [att('340', 'x.png', { size: 2 * MB })], files: { '340': PNG() } });
  const t = full.task();
  mkdirSync(full.folder(t.id, 'OLD-1'), { recursive: true });
  const filler = path.join(full.folder(t.id, 'OLD-1'), 'filler.png');
  writeFileSync(filler, '');
  truncateSync(filler, 149 * MB);
  r = await full.call({ taskId: t.id });
  assert.deepEqual(r.body.images, []);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'x.png', reason: "the task's image folder is full" }]);
  assert.equal(full.downloads().length, 0);

  const odd = setup({ attachments: Array.from({ length: 25 }, (_, i) => att(String(400 + i), `f${i}.pdf`, { mimeType: 'application/pdf' })) });
  r = await odd.call({ taskId: odd.task().id });
  assert.equal(r.body.imagesSkipped.length, 20);
  assert.equal(r.body.imagesMore, true);
  assert.equal(odd.calls.length, 3);
});

test('a failed download is partial with the office’s own words; the rest of the answer stays', async () => {
  const s = setup({
    attachments: [att('501', 'a.png'), att('502', 'b.png', { created: '2026-08-01T10:00:00.000+0000' })],
    comments: [{ id: '1', author: { displayName: 'Bo' }, body: adf(para('hello')), created: '2026-09-01T10:01:00.000+0000' }],
    files: { '501': 500, '502': PNG() },
  });
  const r = await s.call({ taskId: s.task().id });
  assert.equal(r.status, 200);
  assert.equal(r.body.partial, true);
  assert.deepEqual(r.body.failed, ['images']);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'a.png', reason: 'download failed: Jira said 500' }]);
  assert.equal(r.body.images.length, 1);
  assert.equal(r.body.issue.body, 'The description');
  assert.equal(r.body.comments[0].body, 'hello');
  assert.equal(r.body.notes.length, 1);
  assert.match(r.body.notes[0], /^1 of the ticket's pictures couldn't be downloaded: Jira said 500$/);
  assert.ok(!r.text.includes('secret jira text'));
  const gone = await setup({ attachments: [att('503', 'c.png')], files: { '503': 403 } }).call({ taskId: undefined });
  assert.equal(gone.body.partial, undefined);
});

test('names on disk are safe: a path and control characters stay inside the folder', async () => {
  const s = setup({ attachments: [att('601', '../../etc/passwd.png'), att('602', 'a\u0000b\nc\u001b.png', { created: '2026-08-01T10:00:00.000+0000' })], files: { '601': PNG(), '602': PNG() } });
  const t = s.task();
  const r = await s.call({ taskId: t.id });
  const dir = s.folder(t.id);
  assert.deepEqual(readdirSync(dir).sort(), ['601-passwd.png', '602-abc.png']);
  for (const i of r.body.images) assert.equal(path.dirname(i.path), dir);
  assert.deepEqual(r.body.images.map((i: Json) => i.name), ['passwd.png', 'abc.png']);
  assert.ok(!existsSync(path.join(path.dirname(dir), 'etc')));
});

test('only the office’s own address is asked: a non-numeric id gets no request, Jira’s content link on another host none, and the sign-in goes to the site only', async () => {
  const s = setup({ attachments: [att('../../x', 'evil.png'), att('701', 'ok.png', { content: 'https://evil.example/steal.png', thumbnail: 'https://evil.example/t.png' })], files: { '701': PNG() } });
  const r = await s.call({ taskId: s.task().id });
  assert.equal(r.body.images.length, 1);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'evil.png', reason: 'not an image' }]);
  assert.equal(s.downloads().length, 1);
  for (const c of s.calls) assert.equal(new URL(c.url).host, SITE);
});

test('the type comes from the bytes: wrong magic is skipped, nothing is kept', async () => {
  const s = setup({ attachments: [att('801', 'fake.png')], files: { '801': Buffer.from('<svg onload=alert(1)></svg>') } });
  const t = s.task();
  const r = await s.call({ taskId: t.id });
  assert.deepEqual(r.body.images, []);
  assert.deepEqual(r.body.imagesSkipped, [{ name: 'fake.png', reason: 'not an image' }]);
  assert.deepEqual(existsSync(s.folder(t.id)) ? readdirSync(s.folder(t.id)) : [], []);
});

test('a refusal or a moved key asks Jira for no picture; a ticket with no pictures costs exactly three calls', async () => {
  const s = setup({ attachments: [att('901', 'a.png')], files: { '901': PNG() } });
  const t = s.task();
  const no = await s.call({ taskId: t.id }, 'ELSE-1');
  assert.equal(no.status, 403);
  assert.equal(s.calls.length, 0);
  const moved = setup({ issue: { key: 'ELSE-5', fields: { summary: 'x', attachment: [att('902', 'a.png')] } }, files: { '902': PNG() } });
  const m = await moved.call({ taskId: moved.task().id }, 'UYT-5');
  assert.equal(m.status, 403);
  assert.equal(moved.calls.length, 1);
  const none = setup();
  const r = await none.call({ taskId: none.task().id });
  assert.deepEqual([r.status, r.body.images, none.calls.length], [200, [], 3]);
  assert.equal(r.body.imagesSkipped, undefined);
});

test('a slow picture step is cut by the deadline: the answer still comes, the rest is timed out', async () => {
  const before = imageStep.deadlineMs;
  imageStep.deadlineMs = 150;
  try {
    const s = setup({ attachments: [att('1001', 'a.png'), att('1002', 'b.png', { created: '2026-08-01T10:00:00.000+0000' })], files: { '1001': 'hang', '1002': PNG() } });
    const r = await s.call({ taskId: s.task().id });
    assert.equal(r.status, 200);
    assert.equal(r.body.issue.body, 'The description');
    assert.equal(r.body.partial, true);
    assert.deepEqual(r.body.failed, ['images']);
    assert.ok(r.body.imagesSkipped.some((x: Json) => x.name === 'a.png' && x.reason === 'download failed: timed out'));
  } finally {
    imageStep.deadlineMs = before;
  }
});

test('a second read reuses the file when the id and the byte count match: no second download', async () => {
  const s = setup({ attachments: [att('1101', 'a.png', { size: PNG().length })], files: { '1101': PNG() } });
  const t = s.task();
  const first = await s.call({ taskId: t.id });
  assert.equal(s.downloads().length, 1);
  const again = await s.call({ taskId: t.id });
  assert.equal(s.downloads().length, 1);
  assert.deepEqual(again.body.images, first.body.images);
  // Another size under the same id is a new file.
  const changed = setup({ attachments: [att('1101', 'a.png', { size: 5 })], files: { '1101': PNG() } });
  assert.equal((await changed.call({ taskId: changed.task().id })).body.images.length, 1);
});

test('a read of another task’s ticket by task ref stores under the asker’s own task', async () => {
  const s = setup({ attachments: [att('1201', 'a.png')], files: { '1201': PNG() } });
  const mine = s.task({ ticket: 'UYT-8', ticketUrl: undefined });
  const other = s.task({ title: 'Other', ticket: 'UYT-9' });
  const r = await s.call({ taskId: mine.id }, `%23${other.id}`);
  assert.equal(r.body.issue.key, 'UYT-9');
  assert.ok(r.body.images[0].path.startsWith(grantDir(s.ctx.filesDir, mine.id)));
});

test('a worker with no task gets a note and no download', async () => {
  const s = setup({ attachments: [att('1301', 'a.png')], files: { '1301': PNG() } });
  const r = await s.call({}, 'UYT-3');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.images, []);
  assert.equal(s.downloads().length, 0);
  assert.match(r.body.notes[0], /no task/);
  assert.equal(r.body.partial, undefined);
});

test('a task moved to done or archived, and an old done one archived, lose their ticket pictures', async () => {
  const s = setup();
  const make = () => {
    const t = s.task();
    mkdirSync(s.folder(t.id), { recursive: true });
    writeFileSync(path.join(s.folder(t.id), '1-a.png'), PNG());
    const keep = path.join(grantDir(s.ctx.filesDir, t.id), 'mine.txt');
    writeFileSync(keep, 'x');
    return { t, keep, pics: path.join(grantDir(s.ctx.filesDir, t.id), 'jira-images') };
  };
  const plugin = createCorePlugin(s.ctx, { subscribe() {}, unsubscribe() {} });
  const client: KanbanClient = { clientId: 'c1', name: 'Ada', admin: true, send: () => {} };
  const move = (id: number, to: string) => (plugin.ws as any)['kanban.task.move'](client, { t: 'kanban.task.move', id, to }) as Promise<void>;
  for (const to of ['done', 'archived']) {
    const x = make();
    s.ctx.repo.updateTask(x.t.id, { status: 'review' });
    await move(x.t.id, to);
    assert.equal(s.ctx.repo.getTask(x.t.id)!.status, to);
    assert.ok(!existsSync(x.pics));
    assert.ok(existsSync(x.keep));
  }
  const old = make();
  s.ctx.repo.updateTask(old.t.id, { status: 'done', doneAt: Date.now() - 400 * 86_400_000 });
  assert.deepEqual(archiveOldTasks(s.ctx), [old.t.id]);
  assert.ok(!existsSync(old.pics));
  const direct = make();
  removeIssueImages(s.ctx.filesDir, direct.t.id);
  assert.ok(!existsSync(direct.pics) && existsSync(direct.keep));
});

test('reads of one task run at once: ten keys in parallel with a slow stub all get their pictures inside a short deadline', async () => {
  const before = imageStep.deadlineMs;
  imageStep.deadlineMs = 1500;
  try {
    const keys = Array.from({ length: 10 }, (_, i) => `UYT-${20 + i}`);
    const byKey = Object.fromEntries(keys.map((k, i) => [k, [att(String(2000 + i), `p${i}.png`)]]));
    const s = setup({ byKey, files: Object.fromEntries(keys.map((_, i) => [String(2000 + i), PNG()])), delay: 400 });
    const t = s.task();
    const rs = await Promise.all(keys.map((k) => s.call({ taskId: t.id }, k)));
    for (const r of rs) {
      assert.equal(r.body.partial, undefined, JSON.stringify(r.body.notes));
      assert.equal(r.body.images.length, 1);
    }
  } finally {
    imageStep.deadlineMs = before;
  }
});

test('two reads of the same key at once leave whole files and no temporary ones', async () => {
  const s = setup({ attachments: [att('2100', 'a.png')], files: { '2100': PNG() }, delay: 50 });
  const t = s.task();
  const rs = await Promise.all([s.call({ taskId: t.id }), s.call({ taskId: t.id }), s.call({ taskId: t.id })]);
  for (const r of rs) assert.deepEqual(r.body.images.map((i: Json) => i.file), ['2100-a.png']);
  assert.deepEqual(readdirSync(s.folder(t.id)), ['2100-a.png']);
  assert.deepEqual(readFileSync(path.join(s.folder(t.id), '2100-a.png')), PNG());
});

test('the task cap holds across reads in flight: parallel reads of other keys can’t all use the same free space', async () => {
  const MB = 1024 * 1024;
  const keys = ['UYT-30', 'UYT-31', 'UYT-32'];
  const byKey = Object.fromEntries(keys.map((k, i) => [k, [att(String(2200 + i), `p${i}.png`, { size: 2 * MB })]]));
  const s = setup({ byKey, files: Object.fromEntries(keys.map((_, i) => [String(2200 + i), PNG(2 * MB)])), delay: 100 });
  const t = s.task();
  mkdirSync(s.folder(t.id, 'OLD-1'), { recursive: true });
  const filler = path.join(s.folder(t.id, 'OLD-1'), 'filler.png');
  writeFileSync(filler, '');
  truncateSync(filler, 145 * MB);
  const rs = await Promise.all(keys.map((k) => s.call({ taskId: t.id }, k)));
  assert.equal(rs.filter((r) => r.body.images.length === 1).length, 2);
  assert.equal(rs.filter((r) => r.body.imagesSkipped?.[0]?.reason === "the task's image folder is full").length, 1);
});

test('a jira-images or key folder that is a link out of the grant folder is refused: nothing is written or chmod-ed outside', async () => {
  for (const which of ['root', 'key']) {
    const s = setup({ attachments: [att('2300', 'a.png')], files: { '2300': PNG() } });
    const t = s.task();
    const outside = path.join(s.ctx.tmp, `outside-${which}`);
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    const grant = grantDir(s.ctx.filesDir, t.id);
    mkdirSync(grant, { recursive: true });
    if (which === 'root') symlinkSync(outside, path.join(grant, 'jira-images'));
    else {
      mkdirSync(path.join(grant, 'jira-images'));
      symlinkSync(outside, path.join(grant, 'jira-images', 'UYT-7'));
    }
    const r = await s.call({ taskId: t.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.partial, true);
    assert.deepEqual(r.body.failed, ['images']);
    assert.deepEqual(r.body.images, []);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(statSync(outside).mode & 0o777, 0o755);
    assert.equal(s.downloads().length, 0);
    assert.equal(r.body.issue.body, 'The description');
    // Cleanup removes the link itself, not what it points at.
    writeFileSync(path.join(outside, 'keep.txt'), 'x');
    removeIssueImages(s.ctx.filesDir, t.id);
    assert.ok(existsSync(path.join(outside, 'keep.txt')));
    assert.ok(!existsSync(path.join(grant, 'jira-images')));
  }
});

test('a link at a file’s name is not reused as a kept picture', async () => {
  const s = setup({ attachments: [att('2400', 'a.png', { size: PNG().length })], files: { '2400': PNG() } });
  const t = s.task();
  const secret = path.join(s.ctx.tmp, 'secret.png');
  writeFileSync(secret, PNG());
  mkdirSync(s.folder(t.id), { recursive: true });
  symlinkSync(secret, path.join(s.folder(t.id), '2400-a.png'));
  const r = await s.call({ taskId: t.id });
  assert.equal(s.downloads().length, 1);
  assert.equal(r.body.images.length, 1);
  assert.ok(lstatSync(path.join(s.folder(t.id), '2400-a.png')).isFile());
  assert.deepEqual(readFileSync(secret), PNG());
});

test('a worker of a done or archived task downloads nothing and gets a note, not a failure', async () => {
  for (const status of ['done', 'archived'] as const) {
    const s = setup({ attachments: [att('2500', 'a.png')], files: { '2500': PNG() } });
    const t = s.task();
    s.ctx.repo.updateTask(t.id, { status });
    const r = await s.call({ taskId: t.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.images, []);
    assert.equal(s.downloads().length, 0);
    assert.match(r.body.notes[0], /done or archived/);
    assert.equal(r.body.partial, undefined);
    assert.ok(!existsSync(s.folder(t.id)));
  }
});

test('the periodic sweep removes the pictures of done and archived tasks only, whatever way they got there', () => {
  const s = setup();
  const make = (status: string) => {
    const t = s.task();
    s.ctx.repo.updateTask(t.id, { status: status as any });
    mkdirSync(s.folder(t.id), { recursive: true });
    writeFileSync(path.join(s.folder(t.id), '1-a.png'), PNG());
    return t.id;
  };
  const done = make('done');
  const archived = make('archived');
  const running = make('in_progress');
  const review = make('review');
  mkdirSync(path.join(grantDir(s.ctx.filesDir, 9999), 'x'), { recursive: true });
  const swept = sweepIssueImages(s.ctx.filesDir, (id) => s.ctx.repo.getTask(id)?.status);
  assert.deepEqual(swept.sort(), [done, archived].sort());
  for (const id of [done, archived]) assert.ok(!existsSync(path.join(grantDir(s.ctx.filesDir, id), 'jira-images')));
  for (const id of [running, review]) assert.ok(existsSync(s.folder(id)));
});

test('a disk error on write is the office’s own words, not Jira’s blame; names lose C1 controls and line separators', async () => {
  const s = setup({ attachments: [att('2600', 'a.png'), att('2601', 'x\u0085y\u2028z\u009fw.pdf', { mimeType: 'application/pdf' })], files: { '2600': PNG() } });
  const t = s.task();
  mkdirSync(s.folder(t.id), { recursive: true });
  // A directory at the file's name makes the rename fail like a full or unwritable disk would.
  mkdirSync(path.join(s.folder(t.id), '2600-a.png'));
  const r = await s.call({ taskId: t.id });
  assert.equal(r.body.partial, true);
  assert.match(r.body.notes[0], /couldn't be saved/);
  assert.ok(!/Jira/.test(r.body.notes[0].replace("the ticket's", '')), r.body.notes[0]);
  assert.ok(r.body.imagesSkipped.some((x: Json) => x.name === 'x y z w.pdf'));
});

test('a folder swapped for a link while the picture downloads: nothing is written outside, the rest of the answer stays', async () => {
  for (const which of ['root', 'key']) {
    const s = setup({ attachments: [att('2700', 'a.png')], files: { '2700': PNG() }, delay: 150 });
    const t = s.task();
    const outside = path.join(s.ctx.tmp, `swap-${which}`);
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    const grant = grantDir(s.ctx.filesDir, t.id);
    mkdirSync(s.folder(t.id), { recursive: true });
    const swap = which === 'root' ? path.join(grant, 'jira-images') : s.folder(t.id);
    // The worker's swap, during the download: the real folder moves aside and a link to an outside folder takes its place.
    setTimeout(() => {
      renameSync(swap, `${swap}.aside`);
      symlinkSync(outside, swap);
    }, 50);
    const r = await s.call({ taskId: t.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.partial, true);
    assert.deepEqual(r.body.failed, ['images']);
    assert.deepEqual(r.body.images, []);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(statSync(outside).mode & 0o777, 0o755);
    assert.equal(s.downloads().length, 1);
    assert.equal(r.body.issue.body, 'The description');
  }
});

test('links planted in other folders of jira-images are not followed or counted by the task cap', async () => {
  const MB = 1024 * 1024;
  const s = setup({ attachments: [att('2800', 'a.png', { size: 2 * MB })], files: { '2800': PNG() } });
  const t = s.task();
  const outside = path.join(s.ctx.tmp, 'outside-big');
  mkdirSync(outside);
  const big = path.join(outside, 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, 400 * MB);
  mkdirSync(s.folder(t.id, 'OLD-1'), { recursive: true });
  symlinkSync(outside, path.join(grantDir(s.ctx.filesDir, t.id), 'jira-images', 'LINK-1'));
  symlinkSync(outside, path.join(s.folder(t.id, 'OLD-1'), 'sub'));
  symlinkSync(big, path.join(s.folder(t.id, 'OLD-1'), 'big.png'));
  const r = await s.call({ taskId: t.id });
  assert.equal(r.body.partial, undefined);
  assert.equal(r.body.images.length, 1);
  assert.equal(s.downloads().length, 1);
});
