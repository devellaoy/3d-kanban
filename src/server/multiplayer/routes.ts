// HTTP for the visitor's own office: while visiting, the page's GETs for a PR, a diff or a picture
// go to /api/mp/visit/<login>/<the usual path> and are answered by the owner's office, through the
// relay (guest.ts, httpgate.ts). The page never talks to the owner's office or the relay itself.
import { LOGIN_RE, MP_LIMITS } from '../../shared/multiplayer/wire.js';
import { send } from '../http/util.js';
import type { Route } from '../http/router.js';
import { mpOf } from './registry.js';

const PREFIX = '/api/mp/visit/';
/** What a tunneled answer may be, and where: it is the other office's content, so it never runs on this origin. */
const TYPE_RE = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w-]+=(?:"[^"\r\n]*"|[\w.+-]+))*$/;

export const mpRoutes = {
  visit: {
    method: 'GET',
    prefix: PREFIX,
    auth: 'session',
    async handle(ctx, { res, url, path: p, session }) {
      if (!ctx.meOf({ accountId: session.account?.id, visitor: session.visitor }).admin) return send(res, 403, { error: 'Forbidden' });
      const rest = p.slice(PREFIX.length);
      const slash = rest.indexOf('/');
      const login = slash < 0 ? rest : rest.slice(0, slash);
      if (!LOGIN_RE.test(login) || slash < 0) return send(res, 400, { error: 'Bad request' });
      const path = rest.slice(slash) + url.search;
      if (path.length > MP_LIMITS.path) return send(res, 414, { error: 'Too long' });
      const answer = mpOf(ctx)?.guest.request(login, path);
      if (!answer) return send(res, 404, { error: 'You are not visiting them' });
      const a = await answer;
      res.writeHead(a.status, {
        'content-type': TYPE_RE.test(a.type) ? a.type : 'application/octet-stream',
        'content-length': String(a.body.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(a.body);
    },
  },
} satisfies Record<string, Route>;
