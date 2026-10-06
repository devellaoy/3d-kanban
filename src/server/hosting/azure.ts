// Azure DevOps (Azure Repos): pull requests over its REST API 7.1. The answers are put in the
// office's shapes by azure-map.ts; Azure Boards' work items are in azure-workitems.ts.

import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import type { GhCheck, GhPull } from '../../shared/protocol.js';
import { openedFromOfficeBy } from '../../shared/officepr.js';
import { azureDescription, branchOf, checksOfPr, commentsOfThreads, pullOf, refOf, summaryOf, viewOf } from './azure-map.js';
import { hostCall } from './http.js';
import { azureDiff } from './azure-diff.js';
import type { Fetch, HostAs, HostingProvider } from './provider.js';
import { DetailCache, pooled } from './pool.js';

const API = 'api-version=7.1';
/** How many PRs' statuses are asked for at once. */
const STATUS_CALLS = 6;

/**
 * An active pull request's checks (its statuses and policy evaluations, two requests each) are kept
 * between the board's looks, and asked again only when the pull request changed (a new source or
 * target commit, its merge status, its votes) or after DETAIL_MS (PENDING_MS while they run): Azure
 * DevOps throttles a token that asks too much, and the board, O and office-pr share it.
 */
export const azureCache = new DetailCache<GhPull['checks']>((c) => c === 'pending');

const stampOf = (p: any) =>
  [p.lastMergeSourceCommit?.commitId, p.lastMergeTargetCommit?.commitId, p.mergeStatus, p.isDraft, ...(p.reviewers ?? []).map((r: any) => `${r?.id}:${r?.vote}`)].join('|');

/**
 * The list cuts descriptions to 400 characters, and the office's "Opened from Agent Office by" line
 * is a long one's last: such a pull request is read whole for its description, again only when it
 * changed (or after DETAIL_MS), so the PR board's 👤 Mine finds it.
 */
const LISTED_DESCRIPTION = 400;
export const azureDescriptions = new DetailCache<string>(() => false);

async function wholeDescription(repo: RepoRef, p: any, as: HostAs, fetch: Fetch): Promise<string> {
  const listed = String(p.description ?? '');
  if (listed.length < LISTED_DESCRIPTION || openedFromOfficeBy(listed)) return listed;
  const key = `${repo.id}#${p.pullRequestId}`;
  const stamp = `${p.status}|${p.lastMergeSourceCommit?.commitId ?? ''}|${p.closedDate ?? ''}`;
  const { fresh, last } = azureDescriptions.get(key, stamp);
  if (fresh !== undefined) return fresh;
  const got = await hostCall(fetch, as, 'GET', pr(repo, Number(p.pullRequestId))).then((r) => (typeof r?.description === 'string' ? (r.description as string) : undefined), () => undefined);
  if (got !== undefined) azureDescriptions.set(key, stamp, got);
  return got ?? last ?? listed;
}

/** An active pull request's checks in one word: kept while fresh, else asked for. */
async function checksWord(repo: RepoRef, p: any, as: HostAs, fetch: Fetch): Promise<GhPull['checks']> {
  const key = `${repo.id}#${p.pullRequestId}`;
  const stamp = stampOf(p);
  const { fresh, last } = azureCache.get(key, stamp);
  if (fresh) return fresh;
  const got = await prChecks(repo, p, as, fetch).then(summaryOf, () => undefined);
  if (got) azureCache.set(key, stamp, got);
  return got ?? last ?? 'none';
}

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

/**
 * A pull request's checks (`p` as the API gives it): the statuses posted on it and its branch
 * policies' evaluations (build validation, required statuses). Evaluations the token can't read
 * leave just the statuses.
 */
async function prChecks(repo: RepoRef, p: any, as: HostAs, fetch: Fetch): Promise<GhCheck[]> {
  const n = Number(p.pullRequestId);
  const projectId = p.repository?.project?.id;
  const artifact = projectId ? `vstfs:///CodeReview/CodeReviewId/${projectId}/${n}` : undefined;
  const evaluationsUrl = artifact
    ? `https://dev.azure.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.project ?? repo.name)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=7.1-preview.1`
    : undefined;
  const [statuses, evaluations] = await Promise.all([
    hostCall(fetch, as, 'GET', pr(repo, n, '/statuses')).then((r) => r?.value as any[] | undefined),
    evaluationsUrl ? hostCall(fetch, as, 'GET', evaluationsUrl).then((r) => r?.value as any[] | undefined, () => undefined) : Promise.resolve(undefined),
  ]);
  return checksOfPr(repo, statuses, evaluations);
}

/**
 * A pull request's comments, every one trusted: on Azure DevOps only the project's members comment
 * at all (a public project lets everyone else read, not write), which is the membership GitHub's
 * OWNER/MEMBER/COLLABORATOR stands for.
 */
async function azureComments(repo: RepoRef, n: number, as: HostAs, fetch: Fetch) {
  return commentsOfThreads(repo, n, (await hostCall(fetch, as, 'GET', pr(repo, n, '/threads')))?.value, { members: new Set(), everyone: true });
}

/**
 * Whose the credentials are, as `org` sees them. The organization's connectionData takes a PAT
 * (the Profiles API takes only Microsoft Entra tokens), and a PAT is scoped to its organizations.
 */
export async function azureMe(org: string, as: HostAs, fetch: Fetch): Promise<{ id: string; name: string; email: string }> {
  const r = await hostCall(fetch, as, 'GET', `https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData`);
  const u = r?.authenticatedUser;
  const email = String(u?.properties?.Account?.$value ?? '');
  const name = String(u?.providerDisplayName || email);
  if (!u?.id || !name || /UnauthenticatedIdentity/i.test(String(u.descriptor ?? ''))) throw new Error(`Azure DevOps didn't take the token for ${org}: check that it is for this organization`);
  return { id: String(u.id), name, email };
}

export const azureProvider: HostingProvider = {
  kind: 'azure',

  async whoAmI(as, fetch, opts) {
    if (!opts?.org) throw new Error('Azure DevOps needs the organization the token is for');
    return (await azureMe(opts.org, as, fetch)).name;
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
    const whole = async (p: any) => ({ ...p, description: await wholeDescription(repo, p, as, fetch) });
    const open = await pooled(active, STATUS_CALLS, async (p): Promise<GhPull> => pullOf(repo, await whole(p), await checksWord(repo, p, as, fetch)));
    const closed = await pooled([...completed, ...abandoned], STATUS_CALLS, async (p): Promise<GhPull> => pullOf(repo, await whole(p)));
    return [...open, ...closed];
  },

  async checks(repo, n, as, fetch) {
    return prChecks(repo, await hostCall(fetch, as, 'GET', pr(repo, n)), as, fetch);
  },

  diff: (repo, n, as, fetch) => azureDiff(repo, n, as, fetch),

  async comments(repo, n, as, fetch) {
    return azureComments(repo, n, as, fetch);
  },

  async detail(repo, n, as, fetch) {
    const p = await hostCall(fetch, as, 'GET', pr(repo, n));
    const [checks, comments] = await Promise.all([prChecks(repo, p, as, fetch).catch(() => []), azureComments(repo, n, as, fetch).catch(() => [])]);
    return { view: viewOf(repo, p), checks, comments };
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
