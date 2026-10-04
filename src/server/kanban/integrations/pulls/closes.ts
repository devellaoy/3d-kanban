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
  /** The issue's key: gh:owner/repo#12. */
  ref: string;
  cwd: string;
  /** gh as the account that opened the pull request (undefined: the office's own sign-in). */
  env?: Record<string, string>;
  run?: GhRunner;
  /** The pull request's repository's default branch, when known (else asked for before an edit). */
  defaultBranch?: string;
}

export interface Ensured {
  edited: boolean;
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

async function defaultOf(repo: string, run: GhRunner, o: EnsureClosing): Promise<string> {
  const key = repo.toLowerCase();
  const known = defaults.get(key);
  if (known) return known;
  const got = (await run(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], o.cwd, 30_000, o.env).catch(() => '')).trim();
  if (got) defaults.set(key, got);
  return got;
}

/** Puts the closing line for `ref` into the pull request's description unless it's there already. */
export async function ensureClosingRef(o: EnsureClosing): Promise<Ensured> {
  const run = o.run ?? gh;
  const issue = parseGhKey(o.ref);
  const prRepo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(o.prUrl)?.[1];
  if (!issue) return { edited: false };
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
    const linked = refs.some((r) => {
      const repo = r?.repository?.owner?.login && r.repository.name ? `${r.repository.owner.login}/${r.repository.name}` : /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(String(r?.url ?? ''))?.[1];
      return Number(r?.number) === issue.number && sameRepo(repo ?? prRepo, issue.repo);
    });
    const edited = !(linked || closesIn(body, issue, prRepo));
    if (edited) {
      const line = closingRef(o.ref, prRepo);
      if (!line) return { edited: false };
      tmp = await mkdtemp(path.join(tmpdir(), 'office-closes-'));
      const file = path.join(tmp, 'body.md');
      await writeFile(file, body.trim() ? `${body.trimEnd()}\n\n${line}\n` : `${line}\n`);
      // Someone may have edited the description since it was read: theirs isn't overwritten, it's looked at again.
      const again = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env)) as { body?: unknown; updatedAt?: unknown };
      if (again.body !== view.body || again.updatedAt !== view.updatedAt) return { edited: false, retry: true, warning: `Couldn't add "${line}" to ${o.prUrl}: the description kept changing` };
      await run(['pr', 'edit', o.prUrl, '--body-file', file], o.cwd, 60_000, o.env);
    }
    // Closing it is for nothing when the PR doesn't go to the default branch, line added or not.
    const base = typeof view.baseRefName === 'string' ? view.baseRefName : undefined;
    const def = o.defaultBranch ?? (prRepo ? await defaultOf(prRepo, run, o) : '');
    return base && def && base !== def ? { edited, warning: `PR targets \`${base}\`, not the default branch: GitHub closes ${o.ref.replace(/^gh:/, '')} only when it reaches the default branch` } : { edited };
  } catch (err) {
    return { edited: false, retry: true, warning: `Couldn't add "${closingRef(o.ref, prRepo)}" to ${o.prUrl}: ${(err as Error).message}` };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How many times a pull request gh couldn't show is tried before it is given up on. */
const READ_TRIES = 3;

/** What checkClosing knows of a pull request: the run it was checked for, tries so far, and that the task was told it can't be edited. */
export interface ClosingMark {
  runId?: number;
  tries: number;
  told?: true;
}

/**
 * For each active task with a GitHub issue as its ticket: the pull request that is to close it
 * (closingPr among its open ones off the task's own branches, in the project's repositories) gets
 * the closing line when it hasn't, once per pull request and task run (`checked`, by URL: the
 * task's latest run and the tries so far, READ_TRIES once done or given up; marks of pull requests
 * not seen in this pass are dropped). Nothing is edited as an account user without a gh sign-in of
 * their own: a comment on the task says so, once. Fire and forget; what it did, or couldn't, goes on the task as a status comment.
 */
export function checkClosing(
  ctx: KanbanContext,
  project: string,
  checked: Map<string, ClosingMark>,
  io: { run: GhRunner; defaultBranch(repo: string): Promise<string | undefined> },
): void {
  const repos = ctx.repos(project);
  const home = repos.find((r) => r.primary)?.remote;
  const links = ctx.repo.prLinksOfProject(project).filter((l) => l.state === 'OPEN' || l.state === 'DRAFT');
  const seen = new Set<string>();
  for (const task of ctx.repo.listTasks(project)) {
    if (!parseGhKey(task.ticket) || task.status === 'done') continue;
    // Only the task's own branches' pull requests, in the project's repositories: not one linked by hand.
    const branches = new Set([task.branch, ...Object.values(ctx.repo.repoBranches(task.id))]);
    const mine = links
      .filter((l) => l.taskId === task.id)
      .map((l) => ({ ...l, repo: l.repo ?? repos.find((r) => r.id === l.repoId)?.remote }))
      .filter((l) => !!l.branch && branches.has(l.branch) && repos.some((r) => sameRepo(r.remote, l.repo)));
    const pick = closingPr(task.ticket, mine, home);
    if (!pick) continue;
    seen.add(pick.url);
    if (checked.get(pick.url)?.told) continue;
    // Not while a run is going: the agent may still be writing its PR's description over ours.
    if (task.runState !== 'idle') continue;
    // Once per run: a later one (its PR phase, a fix) may write the description again without the line.
    const runId = ctx.repo.latestRunId(task.id);
    const was = checked.get(pick.url);
    const tries = (was && was.runId === runId ? was.tries : 0) + 1;
    if (tries > READ_TRIES) continue;
    checked.set(pick.url, { runId, tries: READ_TRIES });
    const editor = ghEditor(ctx.ghAs?.(task.createdByAccount));
    // Told once per pull request, not once per run.
    if ('warning' in editor) checked.set(pick.url, { runId, tries: READ_TRIES, told: true });
    void (async () => {
      const r: Ensured = 'warning' in editor
        ? { edited: false, warning: `Not checking that ${pick.url} closes ${task.ticket!.replace(/^gh:/, '')}: ${editor.warning}` }
        : await ensureClosingRef({ prUrl: pick.url, ref: task.ticket!, cwd: ctx.dataDir, env: editor.env, run: io.run, defaultBranch: pick.repo ? await io.defaultBranch(pick.repo.toLowerCase()).catch(() => undefined) : undefined });
      if (r.retry) {
        checked.set(pick.url, { runId, tries });
        if (tries < READ_TRIES) return;
      }
      const text = r.warning ?? (r.edited ? `Added "${closingRef(task.ticket, pick.repo)}" to ${pick.url}, so merging it closes the issue` : '');
      if (!text) return;
      ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: r.warning && r.edited ? `Added "${closingRef(task.ticket, pick.repo)}" to ${pick.url}. ${r.warning}` : text });
      ctx.taskChanged(task.id);
    })().catch((err) => console.error('agent-office: checking that a pull request closes its issue failed:', err));
  }
  for (const url of checked.keys()) if (!seen.has(url)) checked.delete(url);
}
