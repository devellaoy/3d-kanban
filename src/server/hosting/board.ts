// The floor's boards for a repository on a host other than GitHub (server/github.ts hands over to
// these): its pull requests from the provider, a PR window's detail, and comments, as whoever asks.
// What only GitHub has (labels, closing an issue, merging from the office) says so instead.

import { hostLabel, orgOf, repoRefOf, type OtherHost, type RepoRef } from '../../shared/hosting/remote.js';
import type { GhPull, GhPullDetail } from '../../shared/protocol.js';
import { hostCredentials, hostFetch, providerOf } from './index.js';
import type { HostAs, HostingProvider, HostPrView } from './provider.js';

export type HostedRepo = RepoRef & { host: OtherHost };

const SIGN_INS = '☰ → 🔐 Your sign-ins';

function provider(repo: HostedRepo): HostingProvider {
  const p = providerOf(repo.host);
  if (typeof p === 'string') throw new Error(p);
  return p;
}

/** Whose credentials read a board nobody in particular asked for: the office's, else an account's (see HostCredentials.anyAs). */
function reader(repo: HostedRepo): HostAs {
  const as = hostCredentials()?.anyAs(repo.host, orgOf(repo));
  const label = hostLabel(repo.host);
  if (!as) throw new Error(`The office has no ${label} token to read this repository with: set yours (or the office's) in ${SIGN_INS}`);
  return as;
}

/** The repository's pull requests for the PR board. */
export function hostedPulls(repo: HostedRepo): Promise<GhPull[]> {
  return provider(repo).listPulls(repo, reader(repo), hostFetch());
}

/** What the PR window shows, as far as the host has it in GitHub's terms. */
export async function hostedPullDetail(repo: HostedRepo, n: number, as?: HostAs): Promise<GhPullDetail> {
  const p = provider(repo);
  const by = as ?? reader(repo);
  const f = hostFetch();
  const [view, checks, comments] = await Promise.all([p.viewPr(repo, n, by, f), p.checks(repo, n, by, f).catch(() => []), p.comments(repo, n, by, f).catch(() => [])]);
  return {
    number: view.number,
    body: view.body,
    state: view.state,
    isDraft: view.isDraft,
    reviewDecision: view.reviewDecision,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    commits: 0,
    // Comments on lines of code show with their file and line in front, as conversation.
    comments: comments.map(({ path, line, ...c }) => (path ? { ...c, body: `\`${path}${line ? `:${line}` : ''}\`\n\n${c.body}` } : c)),
    reviews: [],
    reviewComments: [],
    checks,
    repo: { nameWithOwner: repo.id, methods: [] },
    viewer: by.who ?? '',
  };
}

/** A pull request's unified diff, for the PR window's Files tab. */
export function hostedDiff(repo: HostedRepo, n: number): Promise<string> {
  return provider(repo).diff(repo, n, reader(repo), hostFetch());
}

/** Comments on a pull request's conversation as `as`; resolves to the comment's URL. */
export function hostedComment(repo: HostedRepo, n: number, body: string, as: HostAs): Promise<string | undefined> {
  return provider(repo).comment(repo, n, body, as, hostFetch());
}

/** Why something only GitHub has can't be done here. */
export function notOnHost(what: string, kind: OtherHost): string {
  const label = hostLabel(kind);
  return `${what} isn't available from the office for ${label} repositories: do it on ${label}`;
}

/** The repository named by the office's name for it (see shared/hosting/remote.ts) when it's on a host other than GitHub. */
export function hostedRepoOf(id: string | undefined): HostedRepo | undefined {
  const r = repoRefOf(id);
  return r && r.host !== 'github' ? (r as HostedRepo) : undefined;
}

/** One pull request, read with the board's credentials (one a list left out: a capped or failed list). */
export function hostedView(repo: HostedRepo, n: number): Promise<HostPrView> {
  return provider(repo).viewPr(repo, n, reader(repo), hostFetch());
}

/** Whether a pull request's head is a fork's, read with the board's credentials. */
export function hostedIsFork(repo: HostedRepo, n: number): Promise<boolean> {
  return provider(repo).isFork(repo, n, reader(repo), hostFetch());
}

/** The repository's default branch, read with the board's credentials. */
export function hostedDefaultBranch(repo: HostedRepo): Promise<string | undefined> {
  return provider(repo).defaultBranch(repo, reader(repo), hostFetch());
}
