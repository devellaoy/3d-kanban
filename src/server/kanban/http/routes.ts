// The kanban's HTTP routes, added to the route table in http/routes/index.ts:
// the PWA's files and the kanban page, before the sign-in check, and the kanban's API, after it.
import type http from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { MIME, publicFile, serveFile } from '../../http/static.js';
import { sameOrigin, send } from '../../http/util.js';
import type { Route } from '../../http/router.js';
import type { KanbanCaller } from '../registry.js';

/** Like serveFile, but always revalidated (`no-cache`), with the manifest's and service worker's own types. */
function servePwa(publicDir: string, res: http.ServerResponse, p: string) {
  const file = publicFile(publicDir, p);
  if (!file) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  const type = p === '/manifest.webmanifest' ? 'application/manifest+json' : p === '/sw.js' ? 'application/javascript; charset=utf-8' : (MIME[path.extname(file)] ?? 'application/octet-stream');
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    ...(p === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  createReadStream(file).pipe(res);
}

export const kanbanRoutes = {
  /** The PWA's manifest, service worker and offline page: the browser fetches them without the session (docs/configuration.md#pwa). */
  pwa: {
    path: ['/manifest.webmanifest', '/sw.js', '/offline.html'],
    auth: 'public',
    handle: (ctx, { res, path: p }) => servePwa(ctx.publicDir, res, p),
  },
  pwaIcons: {
    prefix: '/icons/',
    auth: 'public',
    handle: (ctx, { res, path: p }) => (p.includes('..') ? void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found') : servePwa(ctx.publicDir, res, p)),
  },
  /** The kanban board (src/client/kanban.html), when the client bundle has it; signed out, back to it after signing in. */
  page: {
    path: ['/kanban', '/kanban.html'],
    auth: 'public',
    handle(ctx, { req, res, path: p }) {
      if (!ctx.auth.fromRequest(req)) return void res.writeHead(302, { location: '/login?next=/kanban' }).end();
      const file = publicFile(ctx.publicDir, '/kanban.html') ?? publicFile(ctx.publicDir, p);
      if (file) return serveFile(res, file, false);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    },
  },
  /** The kanban's routes (uploads, attachments, its plugins'), for anyone signed in. */
  api: {
    prefix: '/api/kanban/',
    auth: 'session',
    async handle(ctx, { req, res, url, session }) {
      if (!ctx.kanban) return send(res, 503, { error: 'The kanban is starting' });
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const who: KanbanCaller = { accountId: session.account?.id, name: session.account?.name ?? 'Guest', admin: ctx.meOf(session.account?.id).admin };
      if (await ctx.kanban.handleHttp(req, res, url, who)) return;
      return send(res, 404, { error: 'Not found' });
    },
  },
} satisfies Record<string, Route>;
