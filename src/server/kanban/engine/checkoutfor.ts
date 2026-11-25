// What a run's prompt says to check out first (split out of the orchestrator).

import type { FloorDef } from '../../building.js';
import type { KanbanRole, KanbanTask, RunPhase } from '../../../shared/kanban/types.js';
import { onPrBranches } from '../../../shared/kanban/prs.js';
import type { KanbanContext } from '../registry.js';
import { fixTargetsOf } from '../integrations/pulls/prfix.js';
import { isFolderProject, taskRepos } from './compose.js';
import { checkoutLines } from './workspace.js';

/**
 * The task's branch in each repository, one line each, when the worktree the run goes into isn't on
 * it: a fresh one (`freshTree`) for a task that already has a branch, or one still on the branch
 * the office cut for it. Undefined when there's nothing to check out (a plan, an
 * investigation, a folder project, no branch yet, or already on it).
 */
export async function checkoutFor(ctx: KanbanContext, task: KanbanTask, def: FloorDef, floorDir: string, role: KanbanRole, phase: RunPhase, freshTree: boolean): Promise<string | undefined> {
  if (role !== 'implementer' || phase === 'plan' || (task.type === 'investigate' && !onPrBranches(phase)) || isFolderProject(def)) return undefined;
  // A Fix PRs or Resolve conflicts run works on each open PR's own branch, whatever branch the task (an investigation's, say) has.
  const prs = onPrBranches(phase) ? fixTargetsOf(task, def, ctx.floor(task.project)).filter((p) => p.branch) : [];
  if (!task.branch && !prs.length) return undefined;
  const saved = { ...ctx.repo.repoBranches(task.id), ...Object.fromEntries(prs.map((p) => [p.repoId, p.branch])) };
  return checkoutLines(floorDir, task, taskRepos(def, task), saved, onPrBranches(phase), prs.length > 0, freshTree);
}
