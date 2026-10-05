// A task's Azure Boards work item and its pull requests on Azure DevOps: GitHub closes an issue by
// "Closes #12" by itself; Azure DevOps links a work item to a pull request and completes it on merge
// only when asked to (the PR's "complete linked work items" option, which office-pr sets when it
// opens one). So on every board refresh, for each task whose ticket is a work item (`ab:org/project#12`):
// an open linked pull request gets linked to the work item if it isn't (one opened another way), and
// once one has merged the work item is moved to its type's Completed state, if Azure didn't already.
// Each is done once (an event on the task remembers the completion across restarts); what it did,
// or couldn't, goes on the task as a status comment.

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

/** What was done already in this run of the office, by `<taskId>:<what>`. */
export type WorkItemMarks = Set<string>;

/** Whose credentials act for the task: its creator's, else the office's (or any account's). */
function actor(deps: WorkItemDeps, account: string | undefined): HostAs | string {
  const creds = deps.creds();
  if (!creds) return 'The office keeps no Azure DevOps credentials';
  const as = creds.as(account, 'azure');
  return typeof as === 'string' ? (creds.anyAs('azure') ?? as) : as;
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
    if (merged) {
      const key = `${task.id}:complete`;
      if (marks.has(key)) continue;
      marks.add(key);
      if (ctx.repo.listEvents(task.id).some((e) => e.kind === COMPLETED_EVENT)) continue;
      jobs.push(complete(ctx, task.id, task.createdByAccount ?? undefined, item, deps));
      continue;
    }
    for (const x of prs) {
      const state = x.pull?.state ?? x.link.state;
      if (state !== 'OPEN' && state !== 'DRAFT') continue;
      const key = `${task.id}:link:${x.link.url}`;
      if (marks.has(key)) continue;
      marks.add(key);
      jobs.push(link(ctx, task.id, task.createdByAccount ?? undefined, item, x.hosted, x.link.number, deps));
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

function say(ctx: KanbanContext, taskId: number, text: string) {
  ctx.repo.addComment({ taskId, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
  ctx.taskChanged(taskId);
}

async function link(ctx: KanbanContext, taskId: number, account: string | undefined, item: WorkItemRef, repo: HostedRepo, n: number, deps: WorkItemDeps) {
  const as = actor(deps, account);
  if (typeof as === 'string') return;
  try {
    const linked = await (deps.link ?? linkWorkItemToPr)(repo, n, item.id, as, deps.fetch());
    if (linked) say(ctx, taskId, `Linked work item #${item.id} to pull request #${n} on Azure DevOps (${workItemUrl(item)})`);
  } catch (err) {
    say(ctx, taskId, `Couldn't link work item #${item.id} to pull request #${n}: ${(err as Error).message}`);
  }
}

async function complete(ctx: KanbanContext, taskId: number, account: string | undefined, item: WorkItemRef, deps: WorkItemDeps) {
  const as = actor(deps, account);
  if (typeof as === 'string') return say(ctx, taskId, `Its pull request merged, but work item #${item.id} wasn't completed: ${as}`);
  try {
    const state = await (deps.complete ?? completeWorkItem)(item.org, item.project, item.id, as, deps.fetch());
    ctx.repo.appendEvent(taskId, COMPLETED_EVENT, { id: item.id, state });
    if (state !== 'already') say(ctx, taskId, `Its pull request merged: moved work item #${item.id} to ${state} (${workItemUrl(item)})`);
  } catch (err) {
    say(ctx, taskId, `Its pull request merged, but work item #${item.id} couldn't be completed: ${(err as Error).message}`);
  }
}
