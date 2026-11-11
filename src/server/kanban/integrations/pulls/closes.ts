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
  /** Issues the task had before: the closing line the office wrote for each is taken out (an exact line of its own, nothing else). */
  drop?: string[];
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
  if (!issue && !o.drop?.length) return { edited: false };
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
    for (const key of o.drop ?? []) {
      const old = parseGhKey(key);
      const gone = closingRef(key, prRepo);
      if (!old || !gone || (issue && old.number === issue.number && sameRepo(old.repo, issue.repo))) continue;
      const cut = withoutLine(next, gone);
      next = cut.body;
      if (cut.n) removed.push(gone);
      // GitHub still lists it, or the text names it: the author's own words, left alone.
      if (closesIn(next, old, prRepo) || (!cut.n && isLinked(old))) kept.push(`${old.repo}#${old.number}`);
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
    const did: Ensured = { edited: !!(line || removed.length), ...(line ? { added: true as const } : {}), ...(removed.length ? { removed } : {}) };
    // Closing it is for nothing when the PR doesn't go to the default branch, line added or not.
    const base = typeof view.baseRefName === 'string' ? view.baseRefName : undefined;
    const def = !issue ? '' : (o.defaultBranch ?? (prRepo ? await defaultOf(prRepo, run, o) : ''));
    const warnings = [
      kept.length ? `${o.prUrl} still closes ${kept.join(', ')}, which the task no longer has: the author's own words, left as they are` : '',
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

/** The GitHub issues a task had before, from its `edited` events (they carry `ticketWas`), without the one it has now. */
function formerIssues(ctx: KanbanContext, task: { id: number; ticket?: string }): string[] {
  const now = parseGhKey(task.ticket);
  const out = new Map<string, string>();
  for (const e of ctx.repo.listEvents(task.id, 500)) {
    const was = e.kind === 'edited' ? (e.data as { ticketWas?: unknown } | undefined)?.ticketWas : undefined;
    const key = typeof was === 'string' ? parseGhKey(was) : undefined;
    if (key && !(now && key.number === now.number && sameRepo(key.repo, now.repo))) out.set(`${key.repo.toLowerCase()}#${key.number}`, was as string);
  }
  return [...out.values()];
}

/**
 * For each active task with a GitHub issue as its ticket: the pull request that is to close it
 * (closingPr among its open ones off the task's own branches, in the project's repositories) gets
 * the closing line when it hasn't, once per pull request and task run (`checked`, by URL: the
 * task's latest run, the issues and the tries so far, READ_TRIES once done or given up; marks of pull requests
 * not seen in this pass are dropped). A task whose ticket was changed away from a GitHub issue (see
 * formerIssues) has the closing line the office wrote for the old issue taken out of the pull request that
 * closed it, a done task's too (its issue is not added to). Nothing is edited as an account user without a gh sign-in of
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
    const live = !!parseGhKey(task.ticket) && task.status !== 'done';
    const old = formerIssues(ctx, task);
    if (!live && !old.length) continue;
    // Only the task's own branches' pull requests, in the project's repositories: not one linked by hand.
    const branches = new Set([task.branch, ...Object.values(ctx.repo.repoBranches(task.id))]);
    const mine = links
      .filter((l) => l.taskId === task.id)
      .map((l) => ({ ...l, repo: l.repo ?? repos.find((r) => r.id === l.repoId)?.remote }))
      .filter((l) => !!l.branch && branches.has(l.branch) && repos.some((r) => sameRepo(r.remote, l.repo)));
    // What each pull request is to have done: the new issue's line, and the old ones' taken out.
    const jobs = new Map<string, { repo?: string; ref?: string; drop: string[] }>();
    const job = (p: { url: string; repo?: string }) => jobs.get(p.url) ?? jobs.set(p.url, { repo: p.repo, drop: [] }).get(p.url)!;
    const pick = live ? closingPr(task.ticket, mine, home) : undefined;
    if (pick) job(pick).ref = task.ticket;
    for (const key of old) {
      const p = closingPr(key, mine, home);
      if (p) job(p).drop.push(key);
    }
    for (const [url, { repo, ref, drop }] of jobs) {
      seen.add(url);
      const sig = [ref ?? '', ...drop].join('|');
      const was = checked.get(url);
      if (was?.told && was.sig === sig) continue;
      // Not while a run is going: the agent may still be writing its PR's description over ours.
      if (task.runState !== 'idle') continue;
      // Once per run: a later one (its PR phase, a fix) may write the description again without the line.
      const runId = ctx.repo.latestRunId(task.id);
      const tries = (was && was.runId === runId && was.sig === sig ? was.tries : 0) + 1;
      if (tries > READ_TRIES) continue;
      checked.set(url, { runId, sig, tries: READ_TRIES });
      const editor = ghEditor(ctx.ghAs?.(task.createdByAccount));
      // Told once per pull request, not once per run.
      if ('warning' in editor) checked.set(url, { runId, sig, tries: READ_TRIES, told: true });
      void (async () => {
        const r: Ensured = 'warning' in editor
          ? { edited: false, warning: ref ? `Not checking that ${url} closes ${ref.replace(/^gh:/, '')}: ${editor.warning}` : `Not taking the old closing line out of ${url}: ${editor.warning}` }
          : await ensureClosingRef({ prUrl: url, ref, drop, cwd: ctx.dataDir, env: editor.env, run: io.run, defaultBranch: repo ? await io.defaultBranch(repo.toLowerCase()).catch(() => undefined) : undefined });
        if (r.retry) {
          checked.set(url, { runId, sig, tries });
          if (tries < READ_TRIES) return;
        }
        const did = [
          r.added ? `Added "${closingRef(ref, repo)}" to ${url}` : '',
          r.removed?.length ? `Took ${r.removed.map((l) => `"${l}"`).join(', ')} out of ${url}, since the task's issue changed` : '',
        ].filter(Boolean).join('; ');
        const text = did ? (r.warning ? `${did}. ${r.warning}` : r.removed?.length ? did : `${did}, so merging it closes the issue`) : (r.warning ?? '');
        if (!text) return;
        ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
        ctx.taskChanged(task.id);
      })().catch((err) => console.error('agent-office: checking that a pull request closes its issue failed:', err));
    }
  }
  for (const url of checked.keys()) if (!seen.has(url)) checked.delete(url);
}
