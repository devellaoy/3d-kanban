// Files people attach to tasks and comments (docs/kanban-architecture.md §5), kept in
// <filesDir>/uploads/<id>-<name>. The browser uploads one file per request as the raw body:
//
//   POST /api/kanban/upload?name=<file name>[&task=<task id>]
//   Content-Type: <the file's type>          (body: the file's bytes, at most UPLOAD_MAX_BYTES)
//   → 200 {attachment: KanbanAttachment} | 400 / 404 / 413 {error}
//
// Without `task` the upload waits unattached (the create dialog's files) until a task or a comment
// takes it (kanban.task.create / kanban.comment.add attachmentIds); ones never taken are swept after
// ORPHAN_MAX_AGE_MS. `GET /api/kanban/attachments/<id>` serves one back: pictures inline, anything
// else as a download, never sniffed and never able to run script on the office's origin.

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanCaller, KanbanContext, KanbanHttpHandler } from './registry.js';
import { publicAttachment, type AttachmentRow } from './db/repository.js';
import { ATTACHMENT_ID_RE } from '../../shared/kanban/protocol.js';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** Uploads nothing took are removed after a day. */
export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000;
const NAME_MAX = 200;

/** Pictures a browser may show in the page; SVG isn't one (it can carry script). */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.html': 'text/html',
};

export function uploadsDir(filesDir: string): string {
  return path.join(filesDir, 'uploads');
}

/** The name people see: the file's own, without folders or control characters. */
export function displayName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

/** The name on disk: ASCII letters, digits, dot, dash and underscore only, never starting with a dot. */
export function storedName(raw: string): string {
  const safe = displayName(raw)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 100);
  return safe || 'file';
}

/** A usable `type/subtype` from a Content-Type header, else what the name's extension says. */
export function mimeOf(header: string | undefined, name: string): string {
  const t = (header ?? '').split(';')[0].trim().toLowerCase();
  if (/^[a-z0-9][\w!#$&^.+-]{0,63}\/[a-z0-9][\w!#$&^.+-]{0,63}$/.test(t) && t !== 'application/x-www-form-urlencoded' && !t.startsWith('multipart/')) return t;
  return BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The absolute path of an attachment's file. */
export function attachmentPath(filesDir: string, a: Pick<AttachmentRow, 'stored'>): string {
  return path.join(uploadsDir(filesDir), path.basename(a.stored));
}

const tooBig = `That file is too big (${UPLOAD_MAX_BYTES / 1024 / 1024} MB at most)`;

export async function handleUpload(ctx: KanbanContext, req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanCaller): Promise<boolean> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'POST the file as the body' });
    return true;
  }
  const rawName = url.searchParams.get('name') ?? '';
  if (!rawName.trim()) {
    json(res, 400, { error: 'Say what the file is called: ?name=' });
    return true;
  }
  const taskParam = url.searchParams.get('task');
  let taskId: number | undefined;
  if (taskParam !== null && taskParam !== '') {
    taskId = Number(taskParam);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) {
      json(res, 400, { error: 'task must be a task number' });
      return true;
    }
    if (!ctx.repo.getTask(taskId)) {
      json(res, 404, { error: `There's no task #${taskId}` });
      return true;
    }
  }
  if (Number(req.headers['content-length']) > UPLOAD_MAX_BYTES) {
    json(res, 413, { error: tooBig });
    return true;
  }
  let body: Buffer;
  try {
    body = await readBytes(req, UPLOAD_MAX_BYTES);
  } catch (err) {
    json(res, (err as Error).message === 'too large' ? 413 : 400, { error: (err as Error).message === 'too large' ? tooBig : 'Bad request' });
    return true;
  }
  const name = displayName(rawName);
  const id = randomBytes(16).toString('hex');
  const stored = `${id}-${storedName(name)}`;
  const dir = uploadsDir(ctx.filesDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, stored), body, { mode: 0o600 });
  } catch (err) {
    console.error(`agent-office: couldn't keep an upload: ${(err as Error).message}`);
    json(res, 500, { error: 'The office could not keep that file' });
    return true;
  }
  let row = ctx.repo.addAttachment({ id, name, mime: mimeOf(req.headers['content-type'], name), size: body.length, stored, createdBy: who.name, createdAt: Date.now() });
  if (taskId !== undefined) row = ctx.repo.linkAttachments([id], taskId)[0] ?? row;
  json(res, 200, { attachment: publicAttachment(row) });
  return true;
}

export function handleAttachment(ctx: KanbanContext, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const id = url.pathname.slice('/api/kanban/attachments/'.length);
  const row = ATTACHMENT_ID_RE.test(id) ? ctx.repo.getAttachment(id) : undefined;
  const file = row && attachmentPath(ctx.filesDir, row);
  if (!row || !file || !existsSync(file)) {
    json(res, 404, { error: 'No such attachment' });
    return true;
  }
  const inline = INLINE.has(row.mime);
  const ascii = storedName(row.name);
  res.writeHead(200, {
    'content-type': row.mime,
    'content-length': String(statSync(file).size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // Opened on its own (an HTML file, say), it still can't run anything on the office's origin.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

/** Removes attachments' files (their task was deleted: the rows go with it). */
export function removeAttachmentFiles(filesDir: string, rows: Pick<AttachmentRow, 'stored'>[]) {
  for (const r of rows) rmSync(attachmentPath(filesDir, r), { force: true });
}

/** Uploads nothing took, older than `before`: their rows and files go. Returns how many. */
export function sweepOrphanUploads(ctx: KanbanContext, before: number): number {
  const rows = ctx.repo.orphanAttachments(before);
  for (const r of rows) {
    ctx.repo.deleteAttachment(r.id);
    removeAttachmentFiles(ctx.filesDir, [r]);
  }
  return rows.length;
}

/** The routes, for the core plugin's `http`. */
export function uploadRoutes(ctx: KanbanContext): Record<string, KanbanHttpHandler> {
  return {
    '/api/kanban/upload': (req, res, url, who) => (url.pathname === '/api/kanban/upload' ? handleUpload(ctx, req, res, url, who) : false),
    '/api/kanban/attachments/': (req, res, url) => handleAttachment(ctx, req, res, url),
  };
}
