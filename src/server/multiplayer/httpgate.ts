// The owner's side of a visitor's HTTP: the windows of a shared floor fetch a PR, a diff, a task's
// changes, an attachment or a picture, and the visitor's office relays each GET here as
// `visit.http`. Only the read-only paths of paths.ts, and only for what the visitor's scope covers,
// are answered, by asking this office's own HTTP server over loopback with the process secret
// (auth.ts turns that into a `visitor` session the router restricts again).
import http from 'node:http';
import https from 'node:https';
import { MP_BODY_MAX, MP_LIMITS, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { VisitorScope } from '../../shared/multiplayer/allow.js';
import { MP_HEADER } from '../auth.js';
import type { Ctx } from '../office/context.js';
import { workerFloors } from './gate.js';
import { visitorPath } from './paths.js';
import type { Multiplayer } from './index.js';

const TIMEOUT_MS = 30_000;

/** The status to refuse with when the request names something outside `scope`, else undefined. */
export function forbidden(ctx: Ctx, scope: VisitorScope, u: URL): number | undefined {
  const p = u.pathname;
  const q = u.searchParams;
  const projectOk = (id: string | undefined) => !!id && scope.projects.has(id);
  // The Changes window's pictures: the worker must be one the visitor may see at all (its home floor and
  // every repository floor it also works in), and the route itself restricts the file to that worker's.
  if (p === '/api/changes/file') {
    const floors = workerFloors(ctx, q.get('worker') ?? '');
    return scope.floors.has(q.get('floor') ?? '') && !!floors && floors.every((id) => scope.floors.has(id)) ? undefined : 403;
  }
  // The bookshelf names its floor every time (the route would otherwise not know which project is meant).
  if (p === '/api/docs' || p === '/api/docs/file' || p === '/api/docs/picture') return scope.floors.has(q.get('floor') ?? '') ? undefined : 403;
  if (p.startsWith('/api/gh/') || p === '/api/whiteboard/file') return scope.floors.has(q.get('floor') ?? '') ? undefined : 403;
  const task = /^\/api\/kanban\/tasks\/(\d+)\//.exec(p);
  if (task) return projectOk(ctx.kanban?.ctx.repo.getTask(Number(task[1]))?.project) ? undefined : 403;
  const att = /^\/api\/kanban\/attachments\/([^/]+)$/.exec(p);
  if (att) {
    const taskId = ctx.kanban?.ctx.repo.getAttachment(att[1])?.taskId;
    return taskId !== undefined && projectOk(ctx.kanban?.ctx.repo.getTask(taskId)?.project) ? undefined : 403;
  }
  // The office fetches any address for a wall picture, so only the pictures hung on a floor in scope.
  if (p === '/api/image') {
    const url = q.get('url');
    return url && [...scope.floors].some((id) => ctx.floors.get(id)?.decor.list().some((d) => d.url === url)) ? undefined : 403;
  }
  return 403;
}

interface Answer {
  status: number;
  type: string;
  body: Buffer;
}

const text = (status: number, message: string): Answer => ({ status, type: 'application/json', body: Buffer.from(JSON.stringify({ error: message })) });

function loopback(ctx: Ctx, sid: string, pathAndQuery: string, signal: AbortSignal): Promise<Answer> {
  const { cfg } = ctx;
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  return new Promise((resolve) => {
    const req = (cfg.tls ? https : http).request(
      { host, port: cfg.port, path: pathAndQuery, method: 'GET', headers: { [MP_HEADER]: ctx.auth.visitorSecret, 'x-agent-office-mp-sid': sid }, timeout: TIMEOUT_MS, signal, rejectUnauthorized: false } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MP_BODY_MAX) {
            resolve(text(502, 'That is too big to send to a visitor'));
            req.destroy();
          } else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 502, type: String(res.headers['content-type'] ?? 'application/octet-stream').slice(0, MP_LIMITS.type), body: Buffer.concat(chunks) }));
        res.on('error', () => resolve(text(502, 'The answer was cut off')));
      },
    );
    req.on('timeout', () => {
      resolve(text(504, 'The office took too long to answer'));
      req.destroy();
    });
    req.on('error', () => resolve(text(502, 'The office could not answer')));
    req.end();
  });
}

/** Answers one visit.http: refuses, or asks our own server and sends back what it said. */
export async function answerHttp(mp: Multiplayer, msg: Extract<RelayToOffice, { t: 'visit.http' }>) {
  const { sid, rid } = msg;
  const respond = (a: Answer) => void mp.link.send({ t: 'visit.httpres', sid, rid, status: a.status, type: a.type, body: a.body.toString('base64') });
  const hosted = mp.host.sessions.get(sid);
  if (!hosted) return respond(text(403, 'No such visit'));
  let u: URL;
  let decoded: string;
  try {
    u = new URL(msg.path, 'http://visit');
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return respond(text(400, 'Bad request'));
  }
  if (u.origin !== 'http://visit' || !visitorPath('GET', decoded)) return respond(text(403, 'Forbidden'));
  const refused = forbidden(mp.ctx, hosted.scope, u);
  if (refused) return respond(text(refused, 'Forbidden'));
  // The visit ending (or the owner unsharing) must not leave a request running for someone who is gone.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  hosted.sock.once('close', onClose);
  let answer: Answer;
  try {
    // What was checked is what is asked: the normalized path, not the text the visitor sent.
    answer = await loopback(mp.ctx, sid, u.pathname + u.search, abort.signal);
  } finally {
    hosted.sock.off('close', onClose);
  }
  // The share may have been taken back while the owner's server was answering (scopes are changed in
  // place), so the same checks run again against what the visitor may see now, before any byte goes out.
  if (mp.host.sessions.get(sid) !== hosted) return;
  const now = forbidden(mp.ctx, hosted.scope, u);
  respond(now ? text(now, 'Forbidden') : answer);
}
