// The pull requests a PR turn reported, kept on the task (split out of the orchestrator).

import type { KanbanTask } from '../../../shared/kanban/types.js';
import { sameRepo } from '../../../shared/floors.js';
import { prOwners } from '../integrations/pulls/bundle.js';
import type { KanbanContext } from '../registry.js';
import { taskRepos } from './compose.js';
import { prLines } from './markers.js';

/**
 * The pull requests a PR turn reported with a `PR:` line, kept on the task by repository: only a
 * GitHub PR of one of the task's repositories that no other task (of any project) has. A PR the
 * answer names otherwise is left to the board sync, which links it by the task's branch.
 */
export function recordPrs(ctx: KanbanContext, task: KanbanTask, text: string, push: (task: KanbanTask | undefined) => void) {
  const def = ctx.project(task.project);
  const repos = def ? taskRepos(def, task) : [];
  const branches = ctx.repo.repoBranches(task.id);
  const remoteOf = (project: string, repoId: string) => ctx.repos(project).find((r) => r.id === repoId)?.remote;
  let changed = false;
  for (const pr of prLines(text)) {
    if (pr.number === undefined || !pr.repo) continue;
    const repo = repos.find((r) => r.remote && sameRepo(r.remote, pr.repo!));
    if (!repo || prOwners(ctx.repo.prLinksMatching(pr.number, pr.url), remoteOf, { repo: pr.repo, number: pr.number, url: pr.url }).some((id) => id !== task.id)) continue;
    // A link already knows its PR's head branch (Fix PRs checks it out): an answer doesn't move it to the task's.
    const branch = task.prs.find((p) => p.repoId === repo.id && p.number === pr.number)?.branch ?? branches[repo.id] ?? task.branch;
    ctx.repo.upsertPrLink(task.id, { repoId: repo.id, repo: pr.repo, number: pr.number, url: pr.url, state: 'OPEN', ...(branch ? { branch } : {}) });
    changed = true;
  }
  if (changed) push(ctx.repo.getTask(task.id));
}

/** After a PR turn the floor's PR board lists the new PR at once (its sync then links it by branch, whatever the answer said). */
export function refreshPrBoards(ctx: KanbanContext, task: KanbanTask) {
  try {
    const def = ctx.project(task.project);
    const floor = ctx.floor(task.project);
    if (!def || !floor) return;
    for (const r of taskRepos(def, task)) if (r.kind === 'git' && r.remote) void floor.githubFor(r.remote)?.refresh().catch(() => {});
  } catch {
    /* a missing floor or board is no reason to fail the turn */
  }
}
