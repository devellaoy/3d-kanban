// Making sure a pull request closes the issue it was made for. The agent is asked to write
// "Closes #12" itself (kanban.pr.closes); this checks afterwards and adds the line when it's
// missing, for a task's linked pull requests (checkClosing, on every board refresh) and, through
// ensureClosingRef, for a queue task's. Nothing here throws: a pull request that can't be edited
// is told to whoever looks, not retried forever.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sameRepo } from '../../../../shared/floors.js';
import { closingPr, closingRef, parseGhKey } from '../../../../shared/kanban/issuecard.js';
import { gh } from '../../../github.js';
import type { KanbanContext } from '../../registry.js';
import type { GhRunner } from '../issues/source.js';

export interface EnsureClosing {
  prUrl: string;
  /** The issue's key: gh:owner/repo#12 (none: the task has no GitHub issue now, only `drop` is done). */
  ref?: string;
  /** Issues the task had before whose closing line the office itself added to this PR: that exact line is taken out, nothing else. */
  drop?: string[];
  /** Issues the task had before whose line the office did not add: never edited, only said if the PR still closes them. */
  leave?: string[];
  cwd: string;
  /** gh as the account that opened the pull request (undefined: the office's own sign-in). */
  env?: Record<string, string>;
  run?: GhRunner;
  /** The pull request's repository's default branch, when known (else asked for before an edit). */
  defaultBranch?: string;
}

export interface Ensured {
  edited: boolean;
  /** The closing line put in. */
  added?: true;
  /** The closing lines taken out. */
  removed?: string[];
  /** Former issues (as keys) the pull request still closes, written by someone else: left as they are. */
  kept?: string[];
  warning?: string;
  /** gh couldn't show or edit the pull request: asking again later may work. */
  retry?: boolean;
}

/** The default branches asked for (by repository), so a check doesn't ask gh again for each pull request. */
const defaults = new Map<string, string>();

/**
 * How gh runs to edit a pull request for `as` (upstream's signins.ghAs): as their sign-in, as the
 * office's own gh when it is theirs (no account, shared password), and not at all, with the reason,
 * for an account user without a sign-in of their own: the office's gh is not theirs to write with.
 */
export function ghEditor(as: { env: Record<string, string> } | string | undefined): { env?: Record<string, string> } | { warning: string } {
  return typeof as === 'string' ? { warning: as } : { env: as?.env };
}

/** Whether a description already has a closing keyword for the issue (`prRepo` is where "#12" points). */
function closesIn(body: string, issue: { repo: string; number: number }, prRepo: string | undefined): boolean {
  const repo = issue.repo.replace(/[.\\^$*+?()[\]{}|]/g, '\\$&');
  const where = [`https?://github\\.com/${repo}/issues/`, `${repo}#`, ...(sameRepo(issue.repo, prRepo) ? ['#'] : [])].join('|');
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:${where})${issue.number}\\b`, 'i').test(body);
}

/** `body` without its lines that are exactly `line` (and the blank line left between paragraphs), and how many there were. */
function withoutLine(body: string, line: string): { body: string; n: number } {
  const lines = body.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; ) {
    if (lines[i].trimEnd() !== line) { i++; continue; }
    n++;
    const alone = i > 0 && lines[i - 1].trim() === '' && (i + 1 >= lines.length || lines[i + 1].trim() === '');
    lines.splice(alone ? i - 1 : i, alone ? 2 : 1);
    i = Math.max(0, i - 1);
  }
  return { body: lines.join('\n'), n };
}

async function defaultOf(repo: string, run: GhRunner, o: EnsureClosing): Promise<string> {
  const key = repo.toLowerCase();
  const known = defaults.get(key);
  if (known) return known;
  const got = (await run(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], o.cwd, 30_000, o.env).catch(() => '')).trim();
  if (got) defaults.set(key, got);
  return got;
}

/**
 * Puts the closing line for `ref` into the pull request's description unless it's there already,
 * and takes out the one the office wrote for each issue in `drop` (an exact line of its own: one
 * the author wrote in other words, or inside prose, stays, and is warned about).
 */
export async function ensureClosingRef(o: EnsureClosing): Promise<Ensured> {
  const run = o.run ?? gh;
  const issue = parseGhKey(o.ref);
  const prRepo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(o.prUrl)?.[1];
  if (!issue && !o.drop?.length && !o.leave?.length) return { edited: false };
  let tmp: string | undefined;
  try {
    let view: { body?: unknown; updatedAt?: unknown; baseRefName?: unknown; closingIssuesReferences?: unknown };
    try {
      view = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt,baseRefName,closingIssuesReferences'], o.cwd, 30_000, o.env)) as typeof view;
    } catch (err) {
      return { edited: false, retry: true, warning: `Couldn't read ${o.prUrl}: ${(err as Error).message}` };
    }
    const body = typeof view.body === 'string' ? view.body : '';
    const refs = Array.isArray(view.closingIssuesReferences) ? (view.closingIssuesReferences as Record<string, any>[]) : [];
    const isLinked = (i: { repo: string; number: number }) => refs.some((r) => {
      const repo = r?.repository?.owner?.login && r.repository.name ? `${r.repository.owner.login}/${r.repository.name}` : /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(String(r?.url ?? ''))?.[1];
      return Number(r?.number) === i.number && sameRepo(repo ?? prRepo, i.repo);
    });
    // The lines of issues the task had before.
    let next = body;
    const removed: string[] = [];
    const kept: string[] = [];
    for (const key of [...(o.drop ?? []), ...(o.leave ?? [])]) {
      const old = parseGhKey(key);
      const gone = closingRef(key, prRepo);
      if (!old || !gone || (issue && old.number === issue.number && sameRepo(old.repo, issue.repo))) continue;
      const cut = o.drop?.includes(key) ? withoutLine(next, gone) : { body: next, n: 0 };
      next = cut.body;
      if (cut.n) removed.push(gone);
      // GitHub still lists it, or the text names it: the author's own words, left alone.
      if (closesIn(next, old, prRepo) || (!cut.n && isLinked(old))) kept.push(key);
    }
    const add = !!issue && !(isLinked(issue) || closesIn(next, issue, prRepo));
    const line = add ? closingRef(o.ref, prRepo) : undefined;
    if (add && !line) return { edited: false };
    if (line || removed.length) {
      tmp = await mkdtemp(path.join(tmpdir(), 'office-closes-'));
      const file = path.join(tmp, 'body.md');
      const text = line ? (next.trim() ? `${next.trimEnd()}\n\n${line}\n` : `${line}\n`) : next.trim() ? `${next.trimEnd()}\n` : '';
      await writeFile(file, text);
      // Someone may have edited the description since it was read: theirs isn't overwritten, it's looked at again.
      const again = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env)) as { body?: unknown; updatedAt?: unknown };
      if (again.body !== view.body || again.updatedAt !== view.updatedAt) return { edited: false, retry: true, warning: `Couldn't ${line ? `add "${line}" to` : 'take the old closing line out of'} ${o.prUrl}: the description kept changing` };
      await run(['pr', 'edit', o.prUrl, '--body-file', file], o.cwd, 60_000, o.env);
    }
    const did: Ensured = { edited: !!(line || removed.length), ...(line ? { added: true as const } : {}), ...(removed.length ? { removed } : {}), ...(kept.length ? { kept } : {}) };
    // Closing it is for nothing when the PR doesn't go to the default branch, line added or not.
    const base = typeof view.baseRefName === 'string' ? view.baseRefName : undefined;
    const def = !issue ? '' : (o.defaultBranch ?? (prRepo ? await defaultOf(prRepo, run, o) : ''));
    const warnings = [
      base && def && base !== def ? `PR targets \`${base}\`, not the default branch: GitHub closes ${o.ref!.replace(/^gh:/, '')} only when it reaches the default branch` : '',
    ].filter(Boolean);
    return warnings.length ? { ...did, warning: warnings.join('. ') } : did;
  } catch (err) {
    return { edited: false, retry: true, warning: o.ref ? `Couldn't add "${closingRef(o.ref, prRepo)}" to ${o.prUrl}: ${(err as Error).message}` : `Couldn't take the old closing line out of ${o.prUrl}: ${(err as Error).message}` };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How many times a pull request gh couldn't show is tried before it is given up on. */
const READ_TRIES = 3;

/** What checkClosing knows of a pull request: the run and the issues it was checked for, tries so far, and that the task was told it can't be edited. */
export interface ClosingMark {
  runId?: number;
  /** The issue and the old ones checked for (a changed ticket is checked again within the run). */
  sig?: string;
  tries: number;
  told?: true;
}

/** What is to be done to one pull request for a task. */
interface ClosingJob {
  repo?: string;
  ref?: string;
  drop: string[];
  leave: string[];
}

const issueId = (key: string | undefined) => {
  const i = parseGhKey(key);
  return i ? `${i.repo.toLowerCase()}#${i.number}` : undefined;
};

/**
 * What each of the task's pull requests is to have done now: the line of the task's issue (not for a
 * done task), the lines the office added for its former issues (from the `edited` events, which carry
 * `ticketWas`, and the `closing` events, which record what the office added to which PR) taken out, and
 * the former issues whose line it did not add only looked at, unless that was said already.
 */
function closingJobs(ctx: KanbanContext, project: string, task: { id: number; branch?: string; ticket?: string; status: string }): Map<string, ClosingJob> {
  const jobs = new Map<string, ClosingJob>();
  const now = issueId(task.ticket);
  const events = ctx.repo.listEvents(task.id, 500);
  const former = new Map<string, string>();
  // The last thing the office recorded per pull request and issue: only a line it added and has not taken out since is its own.
  const did = new Map<string, unknown>();
  for (const e of events) {
    const d = (e.data ?? {}) as { ticketWas?: unknown; url?: unknown; ref?: unknown; did?: unknown };
    if (e.kind === 'edited' && typeof d.ticketWas === 'string') {
      const id = issueId(d.ticketWas);
      if (id && id !== now) former.set(id, d.ticketWas);
    } else if (e.kind === 'closing' && typeof d.url === 'string' && typeof d.ref === 'string') did.set(`${d.url}|${issueId(d.ref)}`, d.did);
  }
  const live = !!now && task.status !== 'done';
  if (!live && !former.size) return jobs;
  const repos = ctx.repos(project);
  const home = repos.find((r) => r.primary)?.remote;
  // Only the task's own branches' pull requests, in the project's repositories: not one linked by hand.
  const branches = new Set([task.branch, ...Object.values(ctx.repo.repoBranches(task.id))]);
  const mine = ctx.repo.prLinksOfProject(project)
    .filter((l) => (l.state === 'OPEN' || l.state === 'DRAFT') && l.taskId === task.id)
    .map((l) => ({ ...l, repo: l.repo ?? repos.find((r) => r.id === l.repoId)?.remote }))
    .filter((l) => !!l.branch && branches.has(l.branch) && repos.some((r) => sameRepo(r.remote, l.repo)));
  const job = (p: { url: string; repo?: string }) => jobs.get(p.url) ?? jobs.set(p.url, { repo: p.repo, drop: [], leave: [] }).get(p.url)!;
  const pick = live ? closingPr(task.ticket, mine, home) : undefined;
  if (pick) job(pick).ref = task.ticket;
  for (const [id, key] of former) {
    const p = closingPr(key, mine, home);
    if (!p) continue;
    const last = did.get(`${p.url}|${id}`);
    if (last === 'added') job(p).drop.push(key);
    else if (last !== 'left') job(p).leave.push(key);
  }
  return jobs;
}

const sigOf = (j: ClosingJob) => [j.ref ?? '', ...j.drop, '/', ...j.leave].join('|');

/** The work on each pull request, one after the other (an entry goes when its chain is idle). */
const chains = new Map<string, Promise<void>>();
export function inOrder(url: string, work: () => Promise<void>): void {
  const next = (chains.get(url) ?? Promise.resolve()).then(work).catch((err) => console.error('agent-office: checking that a pull request closes its issue failed:', err));
  chains.set(url, next);
  void next.then(() => { if (chains.get(url) === next) chains.delete(url); });
}

/**
 * For each active task with a GitHub issue as its ticket: the pull request that is to close it
 * (closingPr among its open ones off the task's own branches, in the project's repositories) gets
 * the closing line when it hasn't, once per pull request and task run (`checked`, by URL: the
 * task's latest run, the issues and the tries so far, READ_TRIES once done or given up; marks of pull requests
 * not seen in this pass are dropped). A task whose ticket was changed away from a GitHub issue has
 * the closing line the office added for the old issue taken out of that pull request (closingJobs), a
 * done task's too (its issue is not added to). Work on one pull request runs one job at a time, and a
 * job takes the task as it is when its turn comes, so the last thing done reflects its current issue.
 * Nothing is edited as an account user without a gh sign-in of their own: a comment on the task says
 * so, once. Fire and forget; what it did, or couldn't, goes on the task as a status comment.
 */
export function checkClosing(
  ctx: KanbanContext,
  project: string,
  checked: Map<string, ClosingMark>,
  io: { run: GhRunner; defaultBranch(repo: string): Promise<string | undefined> },
): void {
  const seen = new Set<string>();
  for (const task of ctx.repo.listTasks(project)) {
    for (const [url, job] of closingJobs(ctx, project, task)) {
      seen.add(url);
      const sig = sigOf(job);
      const was = checked.get(url);
      if (was?.told && was.sig === sig) continue;
      // Not while a run is going: the agent may still be writing its PR's description over ours.
      if (task.runState !== 'idle') continue;
      // Once per run: a later one (its PR phase, a fix) may write the description again without the line.
      const runId = ctx.repo.latestRunId(task.id);
      const tries = (was && was.runId === runId && was.sig === sig ? was.tries : 0) + 1;
      if (tries > READ_TRIES) continue;
      checked.set(url, { runId, sig, tries: READ_TRIES });
      inOrder(url, () => closeOne(ctx, project, task.id, url, sig, runId, tries, checked, io));
    }
  }
  for (const url of checked.keys()) if (!seen.has(url)) checked.delete(url);
}

/** One pull request's job, when its turn comes: from the task as it is then, unless a later job has taken its place. */
async function closeOne(
  ctx: KanbanContext, project: string, taskId: number, url: string, queued: string, runId: number | undefined, tries: number,
  checked: Map<string, ClosingMark>, io: { run: GhRunner; defaultBranch(repo: string): Promise<string | undefined> },
): Promise<void> {
  // A later pass queued another job (it runs after this one and works from the task as it is then).
  if (checked.get(url)?.sig !== queued) return;
  const task = ctx.repo.listTasks(project).find((t) => t.id === taskId);
  const job = task && closingJobs(ctx, project, task).get(url);
  if (!task || !job || task.runState !== 'idle') return void checked.delete(url);
  const sig = sigOf(job);
  checked.set(url, { runId, sig, tries: READ_TRIES });
  const { ref, repo, drop, leave } = job;
  const editor = ghEditor(ctx.ghAs?.(task.createdByAccount));
  // Told once per pull request, not once per run.
  if ('warning' in editor) checked.set(url, { runId, sig, tries: READ_TRIES, told: true });
  const r: Ensured = 'warning' in editor
    ? { edited: false, warning: ref ? `Not checking that ${url} closes ${ref.replace(/^gh:/, '')}: ${editor.warning}` : `Not taking the old closing line out of ${url}: ${editor.warning}` }
    : await ensureClosingRef({ prUrl: url, ref, drop, leave, cwd: ctx.dataDir, env: editor.env, run: io.run, defaultBranch: repo ? await io.defaultBranch(repo.toLowerCase()).catch(() => undefined) : undefined });
  if (r.retry) {
    checked.set(url, { runId, sig, tries });
    if (tries < READ_TRIES) return;
  }
  // What the office added is the only thing it may take out later; what it said it left is not said again.
  if (r.added && ref) ctx.repo.appendEvent(task.id, 'closing', { url, ref, did: 'added' });
  // A line it took out (or found gone) is no longer its own: one that comes back is the author's.
  if (!r.retry && !('warning' in editor)) for (const key of drop) ctx.repo.appendEvent(task.id, 'closing', { url, ref: key, did: 'removed' });
  for (const key of r.kept ?? []) ctx.repo.appendEvent(task.id, 'closing', { url, ref: key, did: 'left' });
  const said = [
    r.added ? `Added "${closingRef(ref, repo)}" to ${url}` : '',
    r.removed?.length ? `Took ${r.removed.map((l) => `"${l}"`).join(', ')} out of ${url}, since the task's issue changed` : '',
  ].filter(Boolean).join('; ');
  const left = r.kept?.length ? `${url} still closes ${r.kept.map((k) => k.replace(/^gh:/, '')).join(', ')}, which the task no longer has: left as it is` : '';
  const text = [said ? (r.warning || r.removed?.length || left ? said : `${said}, so merging it closes the issue`) : '', left, r.warning ?? ''].filter(Boolean).join('. ');
  if (!text) return;
  ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
  ctx.taskChanged(task.id);
}
