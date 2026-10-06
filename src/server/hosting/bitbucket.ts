// Bitbucket Cloud, over its REST API 2.0 (api.bitbucket.org/2.0): pull requests, their build
// statuses and comments. The answers are put in the office's shapes by bitbucket-map.ts.

import type { GhCheck, GhPull } from '../../shared/protocol.js';
import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import { hostCall, hostText } from './http.js';
import { bbCheck, bbChecksOf, bbComments, bbIsFork, bbPrView, bbPull, bbUserIds } from './bitbucket-map.js';
import type { Fetch, HostAs, HostingProvider } from './provider.js';
import { DetailCache, pooled } from './pool.js';

export { DETAIL_MS, PENDING_MS } from './pool.js';

const API = 'https://api.bitbucket.org/2.0';
const OPEN_PAGES = 3;
const CONCURRENCY = 6;

/**
 * Bitbucket Cloud allows about 1000 requests an hour, and the board is asked every 90 seconds while
 * someone is on its floor: an open pull request's participants and statuses (two requests each,
 * which the list leaves out) are kept between looks, and asked again only when the pull request
 * changed (updated, or a new head commit), or after DETAIL_MS (PENDING_MS while its checks run).
 */
interface Detail {
  participants: unknown;
  checks: GhCheck[];
}
export const bitbucketCache = new DetailCache<Detail>((d) => bbChecksOf(d.checks) === 'pending');

/** An open pull request's participants and statuses: kept ones while they're fresh, else asked for. */
async function detailOf(repo: RepoRef, pr: any, as: HostAs, fetch: Fetch): Promise<Detail> {
  const n = Number(pr.id);
  const key = `${repo.id}#${n}`;
  const stamp = `${pr.updated_on ?? ''}|${pr.source?.commit?.hash ?? ''}`;
  const { fresh, last } = bitbucketCache.get(key, stamp);
  if (fresh) return fresh;
  const [full, checks] = await Promise.all([hostCall(fetch, as, 'GET', prUrl(repo, n)).catch(() => undefined), statusesOf(repo, n, as, fetch).catch(() => undefined)]);
  const got = { participants: full?.participants ?? last?.participants, checks: checks ?? last?.checks ?? [] };
  // Kept only when both came back: a failed one is asked again on the next look.
  if (full && checks) bitbucketCache.set(key, stamp, got);
  return got;
}

const repoUrl = (repo: RepoRef) => `${API}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const prUrl = (repo: RepoRef, n: number) => `${repoUrl(repo)}/pullrequests/${encodeURIComponent(String(n))}`;

/** A BBQL string literal. */
const bbqlString = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * A page's values and the pages after it, up to `pages`; `next` is followed only on Bitbucket's own
 * API. `more`: there were pages after the last one read.
 */
async function pagesWithMore(fetch: Fetch, as: HostAs, url: string, pages: number): Promise<{ values: any[]; more: boolean }> {
  const values: any[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < pages; i++) {
    const page: any = await hostCall(fetch, as, 'GET', next);
    if (Array.isArray(page?.values)) values.push(...page.values);
    next = typeof page?.next === 'string' && page.next.startsWith(`${API}/`) ? page.next : undefined;
  }
  return { values, more: !!next };
}

async function pagesOf(fetch: Fetch, as: HostAs, url: string, pages: number): Promise<any[]> {
  return (await pagesWithMore(fetch, as, url, pages)).values;
}

/** How many pages of comments (100 each) are read, the newest first. */
export const COMMENT_PAGES = 10;

async function statusesOf(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<GhCheck[]> {
  return (await pagesOf(fetch, as, `${prUrl(repo, n)}/statuses?pagelen=100`, 1)).map(bbCheck);
}

/** The most commenters a conversation's trust is asked for (each one a request). */
const MEMBER_CHECKS = 30;

/**
 * Which of these users are members of the repository's workspace (GET /workspaces/{ws}/members/{user}:
 * an answer is a yes, a 404 or any failure a no). On a public repository, that is who GitHub would
 * call a MEMBER; a pull request's author or reviewers are anybody's to pick from a fork.
 */
async function workspaceMembers(repo: RepoRef, users: any[], as: HostAs, fetch: Fetch): Promise<Set<string>> {
  const uuids = [...new Set(users.map((u) => u?.uuid).filter((x): x is string => typeof x === 'string' && !!x))].slice(0, MEMBER_CHECKS);
  const out = new Set<string>();
  await pooled(uuids, CONCURRENCY, async (uuid) => {
    const m = await hostCall(fetch, as, 'GET', `${API}/workspaces/${encodeURIComponent(repo.owner)}/members/${encodeURIComponent(uuid)}`).catch(() => undefined);
    if (m && (m.user?.uuid ?? uuid) === uuid) out.add(uuid);
  });
  return out;
}

export const bitbucketProvider: HostingProvider = {
  kind: 'bitbucket',

  async whoAmI(as, fetch) {
    const me = await hostCall(fetch, as, 'GET', `${API}/user`);
    return String(me?.display_name || me?.nickname || me?.username || '');
  },

  async diff(repo, n, as, fetch) {
    // Bitbucket redirects to the diff of the two commits, on its own API.
    return hostText(fetch, as, `${prUrl(repo, n)}/diff`);
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
    if (!Number.isInteger(number) || number <= 0) throw new Error("Bitbucket didn't say which pull request it opened");
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
    // The list leaves out participants, and checks are their own call: both only for the open ones, and kept (detailOf).
    const openPulls = await pooled(open, CONCURRENCY, async (pr): Promise<GhPull> => bbPull(repo, pr, await detailOf(repo, pr, as, fetch)));
    return [...openPulls, ...[...merged, ...declined].map((pr) => bbPull(repo, pr))];
  },

  async checks(repo, n, as, fetch) {
    return statusesOf(repo, n, as, fetch);
  },

  async comments(repo, n, as, fetch) {
    // The newest first (Bitbucket lists the oldest first), so a long conversation keeps its latest requests.
    const [{ values, more }, r] = await Promise.all([
      pagesWithMore(fetch, as, `${prUrl(repo, n)}/comments?pagelen=100&sort=-created_on`, COMMENT_PAGES),
      // A repository that can't be read counts as public.
      hostCall(fetch, as, 'GET', repoUrl(repo)).catch(() => undefined),
    ]);
    const everyone = r?.is_private === true;
    const members = everyone ? new Set<string>() : await workspaceMembers(repo, values.map((c: any) => c?.user), as, fetch);
    const comments = bbComments([...values].reverse(), { members, everyone });
    // Said where the conversation starts, so whoever reads it knows the oldest are missing.
    if (more) comments.unshift({ id: 'older', author: 'Agent Office', body: `Only the latest ${COMMENT_PAGES * 100} comments are shown here: see the older ones on the pull request's page on Bitbucket.`, createdAt: '' });
    return comments;
  },

  async detail(repo, n, as, fetch) {
    const [view, checks, comments] = await Promise.all([this.viewPr(repo, n, as, fetch), statusesOf(repo, n, as, fetch).catch(() => []), this.comments(repo, n, as, fetch).catch(() => [])]);
    return { view, checks, comments };
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
