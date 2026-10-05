// Bitbucket Cloud, over its REST API 2.0 (api.bitbucket.org/2.0): pull requests, their build
// statuses and comments. The answers are put in the office's shapes by bitbucket-map.ts.

import type { GhCheck, GhPull } from '../../shared/protocol.js';
import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import { hostCall } from './http.js';
import { bbCheck, bbComments, bbIsFork, bbPrView, bbPull } from './bitbucket-map.js';
import type { Fetch, HostAs, HostingProvider } from './provider.js';

const API = 'https://api.bitbucket.org/2.0';
const OPEN_PAGES = 3;
const CONCURRENCY = 6;

const repoUrl = (repo: RepoRef) => `${API}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const prUrl = (repo: RepoRef, n: number) => `${repoUrl(repo)}/pullrequests/${encodeURIComponent(String(n))}`;

/** A BBQL string literal. */
const bbqlString = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** A page's values and the pages after it, up to `pages`; `next` is followed only on Bitbucket's own API. */
async function pagesOf(fetch: Fetch, as: HostAs, url: string, pages: number): Promise<any[]> {
  const out: any[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < pages; i++) {
    const page: any = await hostCall(fetch, as, 'GET', next);
    if (Array.isArray(page?.values)) out.push(...page.values);
    next = typeof page?.next === 'string' && page.next.startsWith(`${API}/`) ? page.next : undefined;
  }
  return out;
}

async function statusesOf(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<GhCheck[]> {
  return (await pagesOf(fetch, as, `${prUrl(repo, n)}/statuses?pagelen=100`, 1)).map(bbCheck);
}

/** Runs `fn` over `items`, `limit` at a time, in order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let at = 0;
  const run = async () => {
    while (at < items.length) {
      const i = at++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export const bitbucketProvider: HostingProvider = {
  kind: 'bitbucket',

  async whoAmI(as, fetch) {
    const me = await hostCall(fetch, as, 'GET', `${API}/user`);
    return String(me?.display_name || me?.nickname || me?.username || '');
  },

  async findOpenPr(repo, branch, as, fetch) {
    const q = encodeURIComponent(`source.branch.name=${bbqlString(branch)}`);
    const page = await hostCall(fetch, as, 'GET', `${repoUrl(repo)}/pullrequests?state=OPEN&q=${q}&pagelen=1`);
    const pr = Array.isArray(page?.values) ? page.values[0] : undefined;
    return pr ? { number: Number(pr.id), url: prWebUrl(repo, Number(pr.id)) } : undefined;
  },

  async createPr(repo, pr, as, fetch) {
    const body = {
      title: pr.title,
      description: pr.body,
      source: { branch: { name: pr.head } },
      ...(pr.base ? { destination: { branch: { name: pr.base } } } : {}),
      draft: pr.draft === true,
      close_source_branch: false,
    };
    const made = await hostCall(fetch, as, 'POST', `${repoUrl(repo)}/pullrequests`, body);
    const number = Number(made?.id);
    return { number, url: prWebUrl(repo, number) };
  },

  async updatePr(repo, n, change, as, fetch) {
    const body = { ...(change.title !== undefined ? { title: change.title } : {}), ...(change.body !== undefined ? { description: change.body } : {}) };
    if (!Object.keys(body).length) return;
    await hostCall(fetch, as, 'PUT', prUrl(repo, n), body);
  },

  async viewPr(repo, n, as, fetch) {
    return bbPrView(repo, await hostCall(fetch, as, 'GET', prUrl(repo, n)));
  },

  async listPulls(repo, as, fetch) {
    const list = `${repoUrl(repo)}/pullrequests`;
    const [open, merged, declined] = await Promise.all([
      pagesOf(fetch, as, `${list}?state=OPEN&pagelen=50`, OPEN_PAGES),
      pagesOf(fetch, as, `${list}?state=MERGED&pagelen=30`, 1),
      pagesOf(fetch, as, `${list}?state=DECLINED&pagelen=40`, 1),
    ]);
    // The list leaves out participants, and checks are their own call: both only for the open ones.
    const openPulls = await mapLimited(open, CONCURRENCY, async (pr): Promise<GhPull> => {
      const n = Number(pr.id);
      const [full, checks] = await Promise.all([hostCall(fetch, as, 'GET', prUrl(repo, n)).catch(() => undefined), statusesOf(repo, n, as, fetch).catch(() => [])]);
      return bbPull(repo, pr, { participants: full?.participants, checks });
    });
    return [...openPulls, ...[...merged, ...declined].map((pr) => bbPull(repo, pr))];
  },

  async checks(repo, n, as, fetch) {
    return statusesOf(repo, n, as, fetch);
  },

  async comments(repo, n, as, fetch) {
    return bbComments(await pagesOf(fetch, as, `${prUrl(repo, n)}/comments?pagelen=100`, 1));
  },

  async comment(repo, n, body, as, fetch) {
    const made = await hostCall(fetch, as, 'POST', `${prUrl(repo, n)}/comments`, { content: { raw: body } });
    return typeof made?.links?.html?.href === 'string' ? made.links.html.href : undefined;
  },

  async defaultBranch(repo, as, fetch) {
    const r = await hostCall(fetch, as, 'GET', repoUrl(repo));
    return typeof r?.mainbranch?.name === 'string' ? r.mainbranch.name : undefined;
  },

  async isFork(repo, n, as, fetch) {
    return bbIsFork(await hostCall(fetch, as, 'GET', prUrl(repo, n)));
  },
};
