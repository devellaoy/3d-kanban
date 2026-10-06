// Azure DevOps' pull requests, statuses and threads in the office's shapes (GitHub's): pure, so
// the tests can feed them canned answers. The calls themselves are in azure.ts.

import type { GhCheck, GhLabel, GhPull } from '../../shared/protocol.js';
import { prWebUrl, type RepoRef } from '../../shared/hosting/remote.js';
import { openedByOf, openedFromOfficeBy } from '../../shared/officepr.js';
import type { CommentTrust, HostComment, HostPrView } from './provider.js';

/** Azure DevOps keeps a pull request's description to this many characters. */
export const AZURE_DESCRIPTION_MAX = 4000;

const CUT_NOTE = '\n\n… (cut short: Azure DevOps keeps 4000 characters of a description)';

/**
 * A description Azure DevOps takes: cut short with a note when it's too long. The office's "Opened
 * from Agent Office by" line, when the cut would take it, is kept after the note, for the PR board's 👤 Mine.
 */
export function azureDescription(body: string): string {
  if (body.length <= AZURE_DESCRIPTION_MAX) return body;
  const line = /^_Opened from Agent Office by .+$/m.exec(body);
  const footer = line && line[0].length < 500 && openedFromOfficeBy(line[0]) ? `\n\n${line[0]}` : '';
  const keep = AZURE_DESCRIPTION_MAX - CUT_NOTE.length - footer.length;
  if (!footer || line!.index + line![0].length <= keep) return body.slice(0, AZURE_DESCRIPTION_MAX - CUT_NOTE.length) + CUT_NOTE;
  return body.slice(0, keep) + CUT_NOTE + footer;
}

/** A branch name without refs/heads/. */
export function branchOf(ref: unknown): string {
  return String(ref ?? '').replace(/^refs\/heads\//, '');
}

/** refs/heads/<branch>, unless it already is a ref. */
export function refOf(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** active / completed / abandoned as OPEN / MERGED / CLOSED. */
export function stateOf(status: unknown): string {
  return status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : 'OPEN';
}

/**
 * GitHub's reviewDecision from the reviewers' votes (10 approved, 5 with suggestions, -5 waiting for
 * the author, -10 rejected): a rejection or a wait is changes asked for; a required reviewer who
 * hasn't approved keeps it waiting for review, whoever else approved.
 */
export function reviewDecisionOf(reviewers: any[] | undefined): string {
  const r = reviewers ?? [];
  if (r.some((x) => x?.vote === -10 || x?.vote === -5)) return 'CHANGES_REQUESTED';
  if (r.some((x) => x?.isRequired && !(Number(x.vote) > 0))) return 'REVIEW_REQUIRED';
  if (r.some((x) => x?.vote === 10 || x?.vote === 5)) return 'APPROVED';
  return '';
}

/** When it last changed, as far as the list tells: the newest of its creation, its close and its latest push. */
export function updatedAtOf(p: any): string {
  const dates = [p.creationDate, p.closedDate, p.lastMergeSourceCommit?.committer?.date, p.lastMergeSourceCommit?.author?.date].filter((d) => typeof d === 'string' && !Number.isNaN(Date.parse(d)));
  return dates.reduce<string>((m, d) => (!m || Date.parse(d) > Date.parse(m) ? d : m), '');
}

/** A status' context: genre/name, or the name alone. */
function contextOf(s: any): string {
  const c = s?.context ?? {};
  return c.genre ? `${c.genre}/${c.name ?? ''}` : String(c.name ?? '');
}

/** Of the statuses posted on a pull request, the newest per context (latest iteration, then latest posted). */
export function latestStatuses(statuses: any[] | undefined): any[] {
  const newest = new Map<string, any>();
  const rank = (s: any) => [Number(s?.iterationId ?? 0), Date.parse(s?.creationDate ?? '') || 0, Number(s?.id ?? 0)];
  for (const s of statuses ?? []) {
    const key = contextOf(s);
    const had = newest.get(key);
    if (!had) {
      newest.set(key, s);
      continue;
    }
    const [a, b] = [rank(s), rank(had)];
    const i = a.findIndex((v, k) => v !== b[k]);
    if (i >= 0 && a[i] > b[i]) newest.set(key, s);
  }
  return [...newest.values()];
}

function checkState(state: unknown): GhCheck['state'] {
  if (state === 'failed' || state === 'error') return 'fail';
  if (state === 'succeeded' || state === 'partiallySucceeded') return 'pass';
  if (state === 'notApplicable') return 'skip';
  return 'pending';
}

/** A pull request's statuses as the PR window's checks (the newest per context). */
export function checksOfStatuses(statuses: any[] | undefined): GhCheck[] {
  return latestStatuses(statuses).map((s) => ({ name: contextOf(s) || 'status', state: checkState(s.state), ...(s.targetUrl ? { url: String(s.targetUrl) } : {}) }));
}

/** The branch policies that are checks: build validation (Azure Pipelines) and required statuses. Reviewer policies are reviews, not checks. */
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';
const STATUS_POLICY = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';

function policyState(status: unknown): GhCheck['state'] {
  if (status === 'approved') return 'pass';
  if (status === 'rejected' || status === 'broken') return 'fail';
  if (status === 'notApplicable') return 'skip';
  return 'pending'; // queued, running
}

/**
 * A pull request's branch policy evaluations as checks: each enabled build validation (its build's
 * page when there is one) and required status (named like the status it waits for).
 */
export function checksOfEvaluations(repo: RepoRef, evaluations: any[] | undefined): (GhCheck & { status?: string })[] {
  const out: (GhCheck & { status?: string })[] = [];
  for (const e of evaluations ?? []) {
    const c = e?.configuration;
    if (!c || c.isEnabled === false || c.isDeleted) continue;
    const type = String(c.type?.id ?? '').toLowerCase();
    const typeName = String(c.type?.displayName ?? '');
    const s = c.settings ?? {};
    if (type === BUILD_POLICY || (!type && typeName === 'Build')) {
      const buildId = Number(e.context?.buildId);
      const name = String(s.displayName || `Build ${s.buildDefinitionId ?? ''}`.trim());
      const url = buildId > 0 ? `https://dev.azure.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.project ?? repo.name)}/_build/results?buildId=${buildId}` : undefined;
      out.push({ name, state: policyState(e.status), ...(url ? { url } : {}) });
    } else if (type === STATUS_POLICY || (!type && typeName === 'Status')) {
      // `status`: the context it requires, as a posted status names it (contextOf).
      const status = s.statusGenre ? `${s.statusGenre}/${s.statusName ?? ''}` : String(s.statusName ?? '');
      out.push({ name: String(s.defaultDisplayName || status || 'status'), state: policyState(e.status), ...(status ? { status } : {}) });
    }
  }
  return out;
}

const SEVERITY: GhCheck['state'][] = ['skip', 'pass', 'pending', 'fail'];
const worse = (a: GhCheck['state'], b: GhCheck['state']) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

/**
 * The statuses and the policy evaluations together. A required-status policy whose status was
 * posted shows once, as that status (it links to its run), with the worse of the two states, so a
 * policy that blocks the merge still shows failing or pending whatever the status says. Build
 * validations are checks of their own, never merged into a status that happens to share a name.
 */
export function checksOfPr(repo: RepoRef, statuses: any[] | undefined, evaluations: any[] | undefined): GhCheck[] {
  const posted = checksOfStatuses(statuses);
  const out: GhCheck[] = [...posted];
  for (const { status, ...c } of checksOfEvaluations(repo, evaluations)) {
    const i = status ? posted.findIndex((p) => p.name.toLowerCase() === status.toLowerCase()) : -1;
    if (i < 0) out.push(c);
    else out[i] = { ...out[i], state: worse(out[i].state, c.state) };
  }
  return out;
}

/** Checks folded into the board card's one word. */
export function summaryOf(checks: GhCheck[]): GhPull['checks'] {
  const states = checks.map((c) => c.state);
  if (states.includes('fail')) return 'fail';
  if (states.includes('pending')) return 'pending';
  return states.includes('pass') ? 'pass' : 'none';
}

/** The statuses folded into the board card's one word. */
export function checksSummary(statuses: any[] | undefined): GhPull['checks'] {
  return summaryOf(checksOfStatuses(statuses));
}

function labelsOf(raw: any[] | undefined): GhLabel[] {
  return (raw ?? []).filter((l) => l?.name && l.active !== false).map((l) => ({ name: String(l.name), color: '#888888' }));
}

/** One of Azure DevOps' pull requests as a PR board card; `checks` is worked out separately (statuses are a call of their own). */
export function pullOf(repo: RepoRef, p: any, checks: GhPull['checks'] = 'none'): GhPull {
  const number = Number(p.pullRequestId);
  return {
    number,
    title: String(p.title ?? ''),
    state: stateOf(p.status),
    isDraft: !!p.isDraft,
    url: prWebUrl(repo, number),
    author: String(p.createdBy?.displayName ?? ''),
    labels: labelsOf(p.labels),
    reviewDecision: reviewDecisionOf(p.reviewers),
    headRefName: branchOf(p.sourceRefName),
    ...(p.lastMergeSourceCommit?.commitId ? { headRefOid: String(p.lastMergeSourceCommit.commitId) } : {}),
    isCrossRepository: !!p.forkSource,
    baseRefName: branchOf(p.targetRefName),
    createdAt: String(p.creationDate ?? ''),
    updatedAt: updatedAtOf(p),
    additions: 0,
    deletions: 0,
    checks,
    body: String(p.description ?? '').slice(0, AZURE_DESCRIPTION_MAX),
    ...openedByOf(String(p.description ?? '')),
    closes: [],
    repo: repo.id,
  };
}

/** One pull request as office-pr's `view` shows it. */
export function viewOf(repo: RepoRef, p: any): HostPrView {
  const number = Number(p.pullRequestId);
  return {
    number,
    url: prWebUrl(repo, number),
    title: String(p.title ?? ''),
    body: String(p.description ?? ''),
    state: stateOf(p.status),
    isDraft: !!p.isDraft,
    headRefName: branchOf(p.sourceRefName),
    baseRefName: branchOf(p.targetRefName),
    author: String(p.createdBy?.displayName ?? ''),
    reviewDecision: reviewDecisionOf(p.reviewers),
    isCrossRepository: !!p.forkSource,
  };
}

/** The people's comments in a pull request's threads (not the system's "updated the source branch" notes), oldest first. */
export function commentsOfThreads(repo: RepoRef, n: number, threads: any[] | undefined, trust?: CommentTrust): HostComment[] {
  const out: HostComment[] = [];
  for (const t of threads ?? []) {
    if (t?.isDeleted) continue;
    const ctx = t.threadContext;
    const line = Number(ctx?.rightFileStart?.line);
    for (const c of t.comments ?? []) {
      if (c?.commentType !== 'text' || c.isDeleted) continue;
      out.push({
        id: `${t.id}.${c.id}`,
        author: String(c.author?.displayName ?? ''),
        body: String(c.content ?? ''),
        createdAt: String(c.publishedDate ?? ''),
        url: `${prWebUrl(repo, n)}?discussionId=${t.id}`,
        ...(ctx?.filePath ? { path: String(ctx.filePath).replace(/^\//, '') } : {}),
        ...(Number.isInteger(line) && line > 0 ? { line } : {}),
        ...(trust ? { trusted: trust.everyone || trust.members.has(String(c.author?.id ?? '')) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
