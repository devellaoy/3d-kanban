// Azure DevOps (Azure Repos): pull requests over its REST API 7.1. The answers are put in the
// office's shapes by azure-map.ts; Azure Boards' work items are in azure-workitems.ts.

import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import type { GhPull } from '../../shared/protocol.js';
import { azureDescription, branchOf, checksOfStatuses, checksSummary, commentsOfThreads, pullOf, refOf, viewOf } from './azure-map.js';
import { hostCall } from './http.js';
import type { Fetch, HostAs, HostingProvider } from './provider.js';

const API = 'api-version=7.1';
/** How many PRs' statuses are asked for at once. */
const STATUS_CALLS = 6;

/** The repository's REST address, with `rest` (a path and query) after it. */
export function azureRepoApi(repo: RepoRef, rest = ''): string {
  const base = `https://dev.azure.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.project ?? repo.name)}/_apis/git/repositories/${encodeURIComponent(repo.name)}`;
  const q = rest.includes('?') ? '&' : '?';
  return `${base}${rest}${q}${API}`;
}

const pr = (repo: RepoRef, n: number, rest = '') => azureRepoApi(repo, `/pullrequests/${n}${rest}`);

async function defaultBranch(repo: RepoRef, as: HostAs, fetch: Fetch): Promise<string | undefined> {
  const r = await hostCall(fetch, as, 'GET', azureRepoApi(repo));
  return r?.defaultBranch ? branchOf(r.defaultBranch) : undefined;
}

/** Runs `fn` over `items`, `limit` at a time, keeping their order. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const azureProvider: HostingProvider = {
  kind: 'azure',

  async whoAmI(as, fetch) {
    const me = await hostCall(fetch, as, 'GET', `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?${API}`);
    const who = String(me?.displayName || me?.emailAddress || '');
    if (!who) throw new Error("Azure DevOps didn't say whose the token is");
    return who;
  },

  async findOpenPr(repo, branch, as, fetch) {
    const q = `?searchCriteria.sourceRefName=${encodeURIComponent(refOf(branch))}&searchCriteria.status=active&$top=1`;
    const r = await hostCall(fetch, as, 'GET', azureRepoApi(repo, `/pullrequests${q}`));
    const p = r?.value?.[0];
    return p ? { number: Number(p.pullRequestId), url: prWebUrl(repo, Number(p.pullRequestId)) } : undefined;
  },

  async createPr(repo, input, as, fetch) {
    const base = input.base ?? (await defaultBranch(repo, as, fetch));
    if (!base) throw new Error(`Azure DevOps didn't say what ${repo.name}'s default branch is: give the branch to merge into`);
    const items = (input.workItems ?? []).filter((n) => Number.isInteger(n) && n > 0);
    const made = await hostCall(fetch, as, 'POST', azureRepoApi(repo, '/pullrequests'), {
      sourceRefName: refOf(input.head),
      targetRefName: refOf(base),
      title: input.title,
      description: azureDescription(input.body),
      isDraft: !!input.draft,
      ...(items.length ? { workItemRefs: items.map((n) => ({ id: String(n) })) } : {}),
    });
    const number = Number(made?.pullRequestId);
    if (!number) throw new Error("Azure DevOps didn't say which pull request it opened");
    if (items.length) {
      // Completes the linked work items when it merges; the PR is open either way.
      await hostCall(fetch, as, 'PATCH', pr(repo, number), { completionOptions: { transitionWorkItems: true } }).catch(() => undefined);
    }
    return { number, url: prWebUrl(repo, number) };
  },

  async updatePr(repo, n, change, as, fetch) {
    const body: Record<string, string> = {};
    if (change.title !== undefined) body.title = change.title;
    if (change.body !== undefined) body.description = azureDescription(change.body);
    if (!Object.keys(body).length) return;
    await hostCall(fetch, as, 'PATCH', pr(repo, n), body);
  },

  async viewPr(repo, n, as, fetch) {
    return viewOf(repo, await hostCall(fetch, as, 'GET', pr(repo, n)));
  },

  async listPulls(repo, as, fetch) {
    const list = (status: string, top: number) => hostCall(fetch, as, 'GET', azureRepoApi(repo, `/pullrequests?searchCriteria.status=${status}&$top=${top}`)).then((r) => (r?.value ?? []) as any[]);
    const [active, completed, abandoned] = await Promise.all([list('active', 150), list('completed', 30), list('abandoned', 40)]);
    const open = await pooled(active, STATUS_CALLS, async (p): Promise<GhPull> => {
      const checks = await hostCall(fetch, as, 'GET', pr(repo, Number(p.pullRequestId), '/statuses')).then((r) => checksSummary(r?.value), () => 'none' as const);
      return pullOf(repo, p, checks);
    });
    return [...open, ...completed.map((p) => pullOf(repo, p)), ...abandoned.map((p) => pullOf(repo, p))];
  },

  async checks(repo, n, as, fetch) {
    return checksOfStatuses((await hostCall(fetch, as, 'GET', pr(repo, n, '/statuses')))?.value);
  },

  async comments(repo, n, as, fetch) {
    return commentsOfThreads(repo, n, (await hostCall(fetch, as, 'GET', pr(repo, n, '/threads')))?.value);
  },

  async comment(repo, n, body, as, fetch) {
    const t = await hostCall(fetch, as, 'POST', pr(repo, n, '/threads'), { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 });
    return t?.id ? `${prWebUrl(repo, n)}?discussionId=${t.id}` : undefined;
  },

  defaultBranch,

  async isFork(repo, n, as, fetch) {
    return !!(await hostCall(fetch, as, 'GET', pr(repo, n)))?.forkSource;
  },
};
