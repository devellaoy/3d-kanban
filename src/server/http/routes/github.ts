// The issue and pull request windows: a PR or issue in full, its diff, and the repo's labels.
import { send } from '../util.js';
import type { Route } from '../router.js';
import { ghRepoOf, notInProject } from '../../kanban/office.js';
import { floorParam } from './files.js';
import { hostCredentials } from '../../hosting/index.js';
import type { HostAs } from '../../hosting/provider.js';
import { isGhAssetId } from '../../../shared/ghassets.js';
import { orgOf, type OtherHost } from '../../../shared/hosting/remote.js';

/** For a repository elsewhere (Azure DevOps, Bitbucket), the asker's credentials there, when they have any. */
function hostedAs(board: { hosted?: { host: OtherHost; owner: string } }, account?: string): HostAs | undefined {
  const kind = board.hosted?.host;
  const as = kind ? hostCredentials()?.as(account, kind, orgOf(board.hosted)) : undefined;
  return typeof as === 'string' ? undefined : as;
}

export const githubRoutes = {
  github: {
    method: 'GET',
    prefix: '/api/gh/',
    auth: 'session',
    async handle(ctx, { res, url, path: p, session }) {
      const floor = floorParam(ctx, url);
      // What the issue and PR windows show beyond the board cards (see github.ts).
      const n = Number(url.searchParams.get('number'));
      // The repo's labels (for the label picker) are the one thing not about a single issue or PR.
      if (p !== '/api/gh/labels' && p !== '/api/gh/asset' && (!Number.isSafeInteger(n) || n <= 0)) return send(res, 400, { error: 'Bad number' });
      if (!floor) return send(res, 404, { error: 'No such floor' });
      // ?repo= for a PR in another of the project's repositories.
      const ghRepo = ghRepoOf(url.searchParams.get('repo'));
      // A picture is asked by the repository in its item's address, which a floor made of a plain folder doesn't
      // know itself by: its own board then answers (and only for a picture it showed, see below).
      const github = floor.githubFor(ghRepo) ?? (p === '/api/gh/asset' ? floor.githubFor() : undefined);
      if (!github) return send(res, 404, { error: notInProject(ghRepo) });
      try {
        if (p === '/api/gh/asset') {
          // A picture the office itself showed in this repository's texts (see ghassets.ts). Anyone who can comment can
          // write another repository's picture into those texts, so GitHub decides with the asker's own sign-in: the
          // office's gh is only for who acts as the office anyway (no accounts, or an admin's choice in signins.ts).
          if (session.visitor) return send(res, 403, { error: 'Forbidden' });
          const as = session.account ? ctx.signins.ghAs(session.account.id) : undefined;
          if (typeof as === 'string') return send(res, 403, { error: as });
          const id = (url.searchParams.get('id') ?? '').toLowerCase();
          if (!isGhAssetId(id)) return send(res, 400, { error: 'Bad id' });
          if (!github.assets?.has(id) || !github.asset) return send(res, 404, { error: 'No such picture' });
          const r = await github.asset(id, as);
          if ('error' in r) return send(res, r.status, { error: r.error });
          res.writeHead(200, {
            'content-type': r.type,
            'content-length': String(r.body.length),
            'cache-control': 'private, max-age=86400',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
          });
          res.end(r.body);
          return;
        }
        // "You" on comments is your own GitHub login once you've signed in to it.
        const me = session.account ? ctx.signins.githubLogin(session.account.id) : undefined;
        if (p === '/api/gh/pull') return send(res, 200, await github.pullDetail(n, me, hostedAs(github, session.account?.id)));
        if (p === '/api/gh/issue') return send(res, 200, await github.issueDetail(n, me));
        if (p === '/api/gh/labels') return send(res, 200, await github.repoLabels());
        if (p === '/api/gh/pull/diff') {
          const diff = await github.pullDiff(n);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(diff);
          return;
        }
      } catch (err) {
        return send(res, 502, { error: (err as Error).message });
      }
      return send(res, 404, { error: 'Not found' });
    },
  },
} satisfies Record<string, Route>;
