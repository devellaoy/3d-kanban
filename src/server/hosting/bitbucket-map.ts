// Bitbucket Cloud's REST API 2.0 answers in the office's shapes: pull requests as GhPull and
// HostPrView, build statuses as GhCheck, comments as HostComment. Pure, so the tests can feed it.

import type { GhCheck, GhPull } from '../../shared/protocol.js';
import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import type { CommentTrust, HostComment, HostPrView } from './provider.js';

const BODY_MAX = 4000;

/** Bitbucket's PR state as GitHub's: OPEN, MERGED, or CLOSED for a declined or superseded one. */
export function bbState(state: unknown): string {
  if (state === 'MERGED') return 'MERGED';
  if (state === 'DECLINED' || state === 'SUPERSEDED') return 'CLOSED';
  return 'OPEN';
}

/** GitHub's reviewDecision from a PR's participants: any change request wins, then any approval. */
export function bbReviewDecision(participants: unknown): string {
  const ps = Array.isArray(participants) ? participants : [];
  if (ps.some((p) => p?.state === 'changes_requested')) return 'CHANGES_REQUESTED';
  if (ps.some((p) => p?.state === 'approved' || p?.approved === true)) return 'APPROVED';
  return '';
}

/** Whether a PR's source branch is in another repository than its destination (a fork's). */
export function bbIsFork(pr: any): boolean {
  const src = pr?.source?.repository?.full_name;
  const dst = pr?.destination?.repository?.full_name;
  return typeof src === 'string' && typeof dst === 'string' && src.toLowerCase() !== dst.toLowerCase();
}

const authorOf = (u: any): string => String(u?.display_name ?? u?.nickname ?? u?.username ?? '');

/** A build status as a check. */
export function bbCheck(s: any): GhCheck {
  const state: GhCheck['state'] = s?.state === 'SUCCESSFUL' ? 'pass' : s?.state === 'FAILED' || s?.state === 'STOPPED' ? 'fail' : 'pending';
  return { name: String(s?.name || s?.key || 'build'), state, ...(typeof s?.url === 'string' && s.url ? { url: s.url } : {}) };
}

/** Checks folded into the board's one word, as GitHub's are: any failure, else anything running, else pass. */
export function bbChecksOf(checks: GhCheck[]): GhPull['checks'] {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'pass';
}

/** A PR's page: the one Bitbucket gives, else the one it has by its number. */
const webOf = (repo: RepoRef, pr: any): string => (typeof pr?.links?.html?.href === 'string' ? pr.links.html.href : prWebUrl(repo, Number(pr?.id)));

/** A pull request (from the list, or with participants and checks for an open one) for the PR board. */
export function bbPull(repo: RepoRef, pr: any, extra: { participants?: unknown; checks?: GhCheck[] } = {}): GhPull {
  return {
    number: Number(pr.id),
    title: String(pr.title ?? ''),
    state: bbState(pr.state),
    isDraft: pr.draft === true,
    url: webOf(repo, pr),
    author: authorOf(pr.author),
    labels: [],
    reviewDecision: bbReviewDecision(extra.participants ?? pr.participants),
    headRefName: String(pr.source?.branch?.name ?? ''),
    ...(pr.source?.commit?.hash ? { headRefOid: String(pr.source.commit.hash) } : {}),
    isCrossRepository: bbIsFork(pr),
    baseRefName: String(pr.destination?.branch?.name ?? ''),
    createdAt: String(pr.created_on ?? ''),
    updatedAt: String(pr.updated_on ?? ''),
    additions: 0,
    deletions: 0,
    checks: bbChecksOf(extra.checks ?? []),
    body: String(pr.description ?? '').slice(0, BODY_MAX),
    closes: [],
    repo: repo.id,
  };
}

/** One pull request as office-pr's `view` shows it. */
export function bbPrView(repo: RepoRef, pr: any): HostPrView {
  return {
    number: Number(pr.id),
    url: webOf(repo, pr),
    title: String(pr.title ?? ''),
    body: String(pr.description ?? ''),
    state: bbState(pr.state),
    isDraft: pr.draft === true,
    headRefName: String(pr.source?.branch?.name ?? ''),
    baseRefName: String(pr.destination?.branch?.name ?? ''),
    author: authorOf(pr.author),
    reviewDecision: bbReviewDecision(pr.participants),
    isCrossRepository: bbIsFork(pr),
  };
}

/** A PR's comments, without the deleted ones. */
/** A Bitbucket user's ids (uuid and account id), to tell who wrote a comment. */
export function bbUserIds(u: any): string[] {
  return [u?.uuid, u?.account_id].filter((x): x is string => typeof x === 'string' && !!x);
}

export function bbComments(values: unknown, trust?: CommentTrust): HostComment[] {
  const vs = Array.isArray(values) ? values : [];
  return vs
    .filter((c) => c && !c.deleted)
    .map((c) => {
      const line = c.inline?.to ?? c.inline?.from;
      return {
        id: String(c.id),
        author: authorOf(c.user),
        body: String(c.content?.raw ?? ''),
        createdAt: String(c.created_on ?? ''),
        ...(typeof c.links?.html?.href === 'string' ? { url: c.links.html.href } : {}),
        ...(typeof c.inline?.path === 'string' ? { path: c.inline.path } : {}),
        ...(typeof line === 'number' ? { line } : {}),
        ...(trust ? { trusted: trust.everyone || bbUserIds(c.user).some((id) => trust.ids.has(id)) } : {}),
      };
    });
}
