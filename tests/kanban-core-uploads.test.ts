import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FloorDef } from '../src/server/building.js';
import { installKanban } from '../src/server/kanban/index.js';
import type { KanbanEngine } from '../src/server/kanban/engine/index.js';
import { UPLOAD_MAX_BYTES, displayName, grantDir, grantFiles, handleUpload, mimeOf, removeGrant, storedName, sweepOrphanUploads } from '../src/server/kanban/uploads.js';
import type { KanbanAttachment } from '../src/shared/kanban/types.js';

type Ctx = { after(fn: () => void): void };

const idleEngine = (): KanbanEngine => {
  const no = async () => undefined;
  return { start: no, stop: no, continue: no, retry: no, review: no, approvePlan: no, requestPlanChanges: no, pr: no, sendWorkersHome: no, prForWorker: no, commented: async () => {}, begin() {}, dispose() {} };
};

async function office(t: Ctx) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-core-uploads-'));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const defs: FloorDef[] = [{ id: 'web', name: 'web', dir: root, palette: 0, addedBy: 'Sam', addedAt: 1 }];
  const kanban = installKanban({
    dataDir,
    floors: () => defs,
    floor: () => undefined,
    saveRepos: () => 'no',
    officePrompts: () => ({}),
    hookUrl: 'http://127.0.0.1:9',
    toast: () => {},
    createEngine: idleEngine,
    plugins: [],
  });
  // The same routing server.ts does for /api/kanban/*.
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!(await kanban.handleHttp(req, res, url, { name: 'Ada', admin: false }))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    kanban.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return { kanban, base, uploads: path.join(dataDir, 'kanban', 'uploads') };
}

test('file names are cleaned for people and for the disk, and types come from the header or the name', () => {
  assert.equal(displayName('../../etc/passwd'), 'passwd');
  assert.equal(displayName('C:\\Users\\ada\\kuva ä.png'), 'kuva ä.png');
  assert.equal(displayName('bad\u0000name\n.txt'), 'badname.txt');
  assert.equal(displayName('..'), 'file');
  assert.equal(displayName(''), 'file');
  assert.equal(displayName('x'.repeat(300)).length, 200);
  assert.equal(storedName('kuva ä.png'), 'kuva_a_.png');
  assert.equal(storedName('.htaccess'), 'htaccess');
  assert.equal(storedName('日本.txt'), 'txt');
  assert.match(storedName('a b/c;d$e.md'), /^[\w.-]+$/);
  assert.equal(mimeOf('image/PNG; charset=binary', 'x'), 'image/png');
  assert.equal(mimeOf('', 'shot.JPG'), 'image/jpeg');
  assert.equal(mimeOf('application/x-www-form-urlencoded', 'notes.md'), 'text/markdown');
  assert.equal(mimeOf('multipart/form-data; boundary=x', 'a.bin'), 'application/octet-stream');
  assert.equal(mimeOf('not a type', 'a.pdf'), 'application/pdf');
});

test('an upload is kept privately, attached to its task when it says one, and served back safely', async (t) => {
  const { kanban, base, uploads } = await office(t);
  kanban.ctx.repo.createTask({ project: 'web', title: 'x', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const r = await fetch(`${base}/api/kanban/upload?name=${encodeURIComponent('kuva ä.png')}&task=1`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(r.status, 200);
  const { attachment } = (await r.json()) as { attachment: KanbanAttachment };
  assert.match(attachment.id, /^[a-f0-9]{32}$/);
  assert.equal(attachment.name, 'kuva ä.png');
  assert.equal(attachment.mime, 'image/png');
  assert.equal(attachment.size, png.length);
  assert.equal(attachment.taskId, 1);
  assert.equal(attachment.createdBy, 'Ada');
  assert.ok(!('stored' in attachment));
  const [file] = readdirSync(uploads);
  assert.equal(file, `${attachment.id}-kuva_a_.png`);
  assert.equal(statSync(path.join(uploads, file)).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(path.join(uploads, file)), png);
  assert.equal(kanban.ctx.attachmentFile(attachment.id), path.join(uploads, file));

  const got = await fetch(`${base}/api/kanban/attachments/${attachment.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-disposition') ?? '', /^inline; filename="kuva_a_.png"; filename\*=UTF-8''kuva%20%C3%A4\.png$/);
  assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

  // Anything that isn't a plain picture is a download, even an SVG.
  for (const [name, type] of [['page.html', 'text/html'], ['logo.svg', 'image/svg+xml']]) {
    const up = (await (await fetch(`${base}/api/kanban/upload?name=${name}`, { method: 'POST', headers: { 'content-type': type }, body: '<script>alert(1)</script>' })).json()) as { attachment: KanbanAttachment };
    assert.equal(up.attachment.taskId, undefined, 'without ?task= it waits unattached');
    const down = await fetch(`${base}/api/kanban/attachments/${up.attachment.id}`);
    assert.equal(down.headers.get('content-type'), type);
    assert.match(down.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(down.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('bad uploads and unknown attachments are refused', async (t) => {
  const { kanban, base, uploads } = await office(t);
  assert.equal((await fetch(`${base}/api/kanban/upload?name=a.txt`)).status, 405);
  assert.equal((await fetch(`${base}/api/kanban/upload`, { method: 'POST', body: 'x' })).status, 400);
  assert.equal((await fetch(`${base}/api/kanban/upload?name=a.txt&task=abc`, { method: 'POST', body: 'x' })).status, 400);
  assert.equal((await fetch(`${base}/api/kanban/upload?name=a.txt&task=5`, { method: 'POST', body: 'x' })).status, 404);
  assert.equal((await fetch(`${base}/api/kanban/uploadx?name=a.txt`, { method: 'POST', body: 'x' })).status, 404);
  assert.equal((await fetch(`${base}/api/kanban/attachments/${'e'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/kanban/attachments/..%2F..%2Fkanban.sqlite`)).status, 404);
  assert.equal((await fetch(`${base}/api/kanban/attachments/${'e'.repeat(32)}`, { method: 'DELETE' })).status, 405);
  // A row whose file went missing.
  kanban.ctx.repo.addAttachment({ id: 'f'.repeat(32), name: 'gone.txt', mime: 'text/plain', size: 1, stored: `${'f'.repeat(32)}-gone.txt`, createdBy: 'Ada', createdAt: 1 });
  assert.equal((await fetch(`${base}/api/kanban/attachments/${'f'.repeat(32)}`)).status, 404);
  assert.equal(existsSync(uploads), false, 'nothing was kept');
});

/** A request and a response to call handleUpload with directly, for bodies too big to send in a test. */
function fakeHttp(headers: Record<string, string>, chunks: Buffer[]) {
  const req = Object.assign(Readable.from(chunks), { method: 'POST', headers }) as unknown as IncomingMessage;
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(body?: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { req, res, out };
}

test('files over 20 MB are refused, by their Content-Length or once too much has come', async (t) => {
  const { kanban, uploads } = await office(t);
  const url = new URL('http://x/api/kanban/upload?name=big.bin');
  const who = { name: 'Ada', admin: false };
  const byHeader = fakeHttp({ 'content-length': String(UPLOAD_MAX_BYTES + 1) }, []);
  await handleUpload(kanban.ctx, byHeader.req, byHeader.res, url, who);
  assert.equal(byHeader.out.status, 413);
  assert.match(byHeader.out.body ?? '', /too big \(20 MB at most\)/);
  const mb = Buffer.alloc(1024 * 1024);
  const streamed = fakeHttp({}, [...Array(20).fill(mb), Buffer.alloc(1)]);
  await handleUpload(kanban.ctx, streamed.req, streamed.res, url, who);
  assert.equal(streamed.out.status, 413);
  const exactly = fakeHttp({}, Array(20).fill(mb));
  await handleUpload(kanban.ctx, exactly.req, exactly.res, url, who);
  assert.equal(exactly.out.status, 200);
  assert.equal(readdirSync(uploads).length, 1);
});

test('uploads nothing took are swept away with their files', async (t) => {
  const { kanban, uploads } = await office(t);
  mkdirSync(uploads, { recursive: true });
  kanban.ctx.repo.createTask({ project: 'web', title: 'x', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 'Ada' });
  for (const [id, taskId] of [['1'.repeat(32), undefined], ['2'.repeat(32), 1]] as const) {
    writeFileSync(path.join(uploads, `${id}-f.txt`), 'x');
    kanban.ctx.repo.addAttachment({ id, ...(taskId ? { taskId } : {}), name: 'f.txt', mime: 'text/plain', size: 1, stored: `${id}-f.txt`, createdBy: 'Ada', createdAt: 100 });
  }
  assert.equal(sweepOrphanUploads(kanban.ctx, 50), 0, 'not old enough yet');
  assert.equal(sweepOrphanUploads(kanban.ctx, 200), 1);
  assert.deepEqual(readdirSync(uploads), [`${'2'.repeat(32)}-f.txt`]);
  assert.equal(kanban.ctx.repo.getAttachment('1'.repeat(32)), undefined);
});

test('grant folders: copies of a task\'s files, private, a missing source skipped, removed with the task', async (t) => {
  const { kanban, uploads } = await office(t);
  const dir = kanban.ctx.filesDir;
  mkdirSync(uploads, { recursive: true });
  writeFileSync(path.join(uploads, `${'1'.repeat(32)}-a.txt`), 'one');
  writeFileSync(path.join(uploads, `${'2'.repeat(32)}-b.txt`), 'two');
  const rows = [{ stored: `${'2'.repeat(32)}-b.txt` }, { stored: `${'9'.repeat(32)}-gone.txt` }, { stored: `${'1'.repeat(32)}-a.txt` }];
  const got = grantFiles(dir, 5, rows);
  assert.deepEqual(got, [`${'2'.repeat(32)}-b.txt`, `${'1'.repeat(32)}-a.txt`].map((f) => path.join(grantDir(dir, 5), f)), 'in order, the gone one skipped');
  assert.equal(path.dirname(got[0]), path.join(dir, 'grants', 'task-5'));
  assert.equal(readFileSync(got[1], 'utf8'), 'one');
  assert.equal(statSync(grantDir(dir, 5)).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dir, 'grants')).mode & 0o777, 0o700);
  assert.deepEqual(grantFiles(dir, 5, rows), got, 'again is the same');
  assert.deepEqual(grantFiles(dir, 6, []), [], 'an empty folder is still made');
  assert.ok(existsSync(grantDir(dir, 6)));
  removeGrant(dir, 5);
  assert.ok(!existsSync(grantDir(dir, 5)));
  assert.ok(existsSync(path.join(uploads, `${'1'.repeat(32)}-a.txt`)), 'the upload itself stays');
});
