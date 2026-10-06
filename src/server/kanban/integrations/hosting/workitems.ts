// A task's Azure Boards work item and its pull requests on Azure DevOps: GitHub closes an issue by
// "Closes #12" by itself; Azure DevOps links a work item to a pull request and completes it on merge
// only when asked to (the PR's "complete linked work items" option, which office-pr sets when it
// opens one). So on every board refresh, for each task whose ticket is a work item (`ab:org/project#12`):
// an open linked pull request gets linked to the work item if it isn't (one opened another way), and
// once one has merged the work item is moved to its type's Completed state, if Azure didn't already.
// Each is written with the task creator's own Azure DevOps token, else the office's (never another
// account's), and done once: an event on the task remembers the completion across restarts, and one
// that failed is tried again on the next refreshes, WORK_ITEM_TRIES times in all. What it did, or
// couldn't, goes on the task as a status comment.

import type { KanbanContext } from '../../registry.js';
import type { GhPull } from '../../../../shared/protocol.js';
import { sameRepo } from '../../../../shared/floors.js';
import { parseAbKey, workItemUrl, type WorkItemRef } from '../../../../shared/hosting/workitems.js';
import { hostedRepoOf, type HostedRepo } from '../../../hosting/board.js';
import { completeWorkItem, linkWorkItemToPr } from '../../../hosting/azure-workitems.js';
import type { HostCredentials } from '../../../hosting/credentials.js';
import type { Fetch, HostAs } from '../../../hosting/provider.js';

export const COMPLETED_EVENT = 'workitem.completed';

export interface WorkItemDeps {
  creds: () => HostCredentials | undefined;
  fetch: () => Fetch;
  link?: typeof linkWorkItemToPr;
  complete?: typeof completeWorkItem;
}

/** How many times a link or a completion that failed is tried, on the board's next refreshes, before it is given up on. */
export const WORK_ITEM_TRIES = 3;

/**
 * What this run of the office did, by `<taskId>:<what>`: `done` holds the ones done, given up on,
 * or in flight (so a refresh while one runs doesn't start it again); `failed` how often each failed;
 * `told` the ones whose task heard they wait for a token.
 */
export interface WorkItemMarks {
  done: Set<string>;
  failed: Map<string, number>;
  told: Set<string>;
}

export function workItemMarks(): WorkItemMarks {
  return { done: new Set(), failed: new Map(), told: new Set() };
}

/** What a link or a completion came to: done (undefined), an error to try again, or waiting for a token to be set. */
type Outcome = undefined | { error: string } | { wait: string };

/**
 * Whose credentials change the work item: the task's creator's own, else the office's own. Never
 * another account's: the work item is written to, and that is theirs to do (HostCredentials.as).
 */
function actor(deps: WorkItemDeps, account: string | undefined, org: string): HostAs | string {
  const creds = deps.creds();
  if (!creds) return 'The office keeps no Azure DevOps credentials';
  return creds.as(account, 'azure', org);
}

/**
 * Runs `job` for `key` unless it was done, given up on, or is running. A failure leaves it to be
 * tried again on a later refresh, up to WORK_ITEM_TRIES times (`gaveUp` hears the last error). One
 * waiting for a token is tried again on every refresh, without counting, until someone sets one;
 * `waiting` hears why, once.
 */
function once(marks: WorkItemMarks, key: string, job: () => Promise<Outcome>, gaveUp: (error: string) => void, waiting: (why: string) => void): Promise<void> | undefined {
  if (marks.done.has(key)) return undefined;
  marks.done.add(key);
  return job().then((out) => {
    if (!out) {
      marks.failed.delete(key);
      marks.told.delete(key);
      return;
    }
    marks.done.delete(key);
    if ('wait' in out) {
      if (!marks.told.has(key)) waiting(out.wait);
      marks.told.add(key);
      return;
    }
    const tries = (marks.failed.get(key) ?? 0) + 1;
    marks.failed.set(key, tries);
    if (tries >= WORK_ITEM_TRIES) {
      marks.done.add(key);
      gaveUp(out.error);
    }
  });
}

/** The tasks of `project` with a work item for a ticket, against the pull requests the board lists now. */
export function checkWorkItems(ctx: KanbanContext, project: string, pulls: Pick<GhPull, 'number' | 'url' | 'state' | 'repo'>[], marks: WorkItemMarks, deps: WorkItemDeps): Promise<void> {
  const repos = ctx.repos(project);
  const home = repos.find((r) => r.primary)?.remote;
  const jobs: Promise<void>[] = [];
  for (const task of ctx.repo.listTasks(project)) {
    const item = parseAbKey(task.ticket ?? undefined);
    if (!item) continue;
    const prs = task.prs
      .map((l) => ({ ...l, repo: l.repo ?? repos.find((r) => r.id === l.repoId)?.remote }))
      .map((l) => ({ link: l, hosted: hostedRepoOf(l.repo), pull: pulls.find((p) => (p.number === l.number && sameRepo(p.repo ?? home, l.repo)) || (!!l.url && p.url === l.url)) }))
      .filter((x): x is typeof x & { hosted: HostedRepo } => x.hosted?.host === 'azure' && x.hosted.owner.toLowerCase() === item.org.toLowerCase());
    if (!prs.length) continue;
    const merged = prs.some((x) => (x.pull?.state ?? x.link.state) === 'MERGED');
    const account = task.createdByAccount ?? undefined;
    if (merged) {
      const key = `${task.id}:complete`;
      if (marks.done.has(key)) continue;
      if (ctx.repo.listEvents(task.id).some((e) => e.kind === COMPLETED_EVENT)) {
        marks.done.add(key);
        continue;
      }
      const job = once(
        marks,
        key,
        () => complete(ctx, task.id, account, item, deps),
        (error) => say(ctx, task.id, `Its pull request merged, but work item #${item.id} couldn't be completed: ${error}`),
        (why) => say(ctx, task.id, `Its pull request merged; work item #${item.id} is completed once there's a token to do it with: ${why}`),
      );
      if (job) jobs.push(job);
      continue;
    }
    for (const x of prs) {
      const state = x.pull?.state ?? x.link.state;
      if (state !== 'OPEN' && state !== 'DRAFT') continue;
      const job = once(
        marks,
        `${task.id}:link:${x.link.url}`,
        () => link(ctx, task.id, account, item, x.hosted, x.link.number, deps),
        (error) => say(ctx, task.id, `Couldn't link work item #${item.id} to pull request #${x.link.number}: ${error}`),
        // Quietly: office-pr links what it opens itself, so a missing token here is no news.
        () => undefined,
      );
      if (job) jobs.push(job);
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

function say(ctx: KanbanContext, taskId: number, text: string) {
  ctx.repo.addComment({ taskId, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
  ctx.taskChanged(taskId);
}

/** Links the work item to the pull request. */
async function link(ctx: KanbanContext, taskId: number, account: string | undefined, item: WorkItemRef, repo: HostedRepo, n: number, deps: WorkItemDeps): Promise<Outcome> {
  const as = actor(deps, account, item.org);
  if (typeof as === 'string') return { wait: as };
  try {
    const linked = await (deps.link ?? linkWorkItemToPr)(repo, n, item.id, as, deps.fetch());
    if (linked) say(ctx, taskId, `Linked work item #${item.id} to pull request #${n} on Azure DevOps (${workItemUrl(item)})`);
    return undefined;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Completes the work item. */
async function complete(ctx: KanbanContext, taskId: number, account: string | undefined, item: WorkItemRef, deps: WorkItemDeps): Promise<Outcome> {
  const as = actor(deps, account, item.org);
  if (typeof as === 'string') return { wait: as };
  try {
    const state = await (deps.complete ?? completeWorkItem)(item.org, item.project, item.id, as, deps.fetch());
    ctx.repo.appendEvent(taskId, COMPLETED_EVENT, { id: item.id, state });
    if (state !== 'already') say(ctx, taskId, `Its pull request merged: moved work item #${item.id} to ${state} (${workItemUrl(item)})`);
    return undefined;
  } catch (err) {
    return { error: (err as Error).message };
  }
}
