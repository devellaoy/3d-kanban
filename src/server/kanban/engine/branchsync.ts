// Keeps a task's branch and workspace as its implementer's worker has them (split out of the orchestrator).

import path from 'node:path';
import type { WorkerInfo } from '../../../shared/protocol.js';
import type { KanbanTask } from '../../../shared/kanban/types.js';
import { BRANCH_PREFIX } from '../../worktrees.js';
import type { TaskUpdate } from '../db/repository.js';
import type { KanbanContext } from '../registry.js';
import { taskRepos } from './compose.js';
import { currentBranch } from './workspace.js';

/**
 * Keeps the task's branch and workspace as the implementer's worker has them now, asking git which
 * branch each folder is on (upstream follows only a single worktree's). The branch the office cut
 * for a fresh worktree never replaces a branch the task already has: that one is still to be
 * checked out there (see checkoutFor).
 */
export async function syncBranch(ctx: KanbanContext, task: KanbanTask, info: WorkerInfo | undefined, update: (id: number, patch: TaskUpdate) => unknown) {
  if (!info?.worktree || info.kanban?.role !== 'implementer') return;
  const floorDir = ctx.floor(task.project)?.dir;
  const pick = async (rel: string, given: string, made: string | undefined, known: string | undefined) => {
    const on = (floorDir && (await currentBranch(path.join(floorDir, rel)))) || given;
    const own = made ?? given;
    return known && known !== on && on === own && own.startsWith(BRANCH_PREFIX) ? known : on;
  };
  const branch = await pick(info.worktree.path, info.worktree.branch, info.worktree.made, task.branch);
  const ws = { worktree: info.worktree, ...(info.repos?.length ? { repos: info.repos } : {}) };
  if (JSON.stringify(ws) !== JSON.stringify(task.workspace) || task.branch !== branch) update(task.id, { workspace: ws, branch });
  ctx.repo.setRepoBranch(task.id, task.project, branch);
  const def = ctx.project(task.project);
  const known = ctx.repo.repoBranches(task.id);
  for (const r of info.repos ?? []) {
    const id = def && taskRepos(def, task).find((x) => path.resolve(x.dir) === path.resolve(r.dir))?.id;
    if (id) ctx.repo.setRepoBranch(task.id, id, await pick(r.path, r.branch, undefined, known[id]));
  }
}
