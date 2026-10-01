// A task made (or started) from an issue takes the issue, as taking a card does: an open GitHub
// issue nobody has is assigned to the person, under their gh sign-in (the office's gh when the admin
// chose it). Never throws: the task is made already, and a failure is a toast.

import type { NormalizedIssue } from '../../../../shared/kanban/types.js';
import type { KanbanCaller, KanbanContext } from '../../registry.js';
import { route, type IssuePatch } from './actions.js';
import { ghClaimIfUnassigned } from './github-ops.js';
import type { IssueActIo, IssueSourceIo } from './source.js';

export interface ClaimDeps {
  patch(project: string, key: string, fields: IssuePatch): void;
  io(project: string): IssueSourceIo;
}

export async function claimIssueForTask(ctx: KanbanContext, deps: ClaimDeps, project: string, issue: NormalizedIssue, caller: KanbanCaller): Promise<void> {
  if (issue.assignee) return;
  const target = route(ctx.settings.project(project).issueSources, issue);
  // Jira, a draft, a pull request and a closed issue are left as they are.
  if (typeof target === 'string' || target.kind !== 'gh' || target.isPr || target.closed) return;
  try {
    // Inside the try: the task has been answered for already, so even getting the sign-in ready may only fail as a toast.
    const as = ctx.ghAs?.(caller.accountId);
    if (typeof as === 'string') return;
    const env = as?.env;
    const io: IssueActIo = { ...deps.io(project), ...(env ? { env } : {}), who: caller.name, shared: !env };
    const login = await ghClaimIfUnassigned(io, target.repo, target.number);
    if (!login) return;
    const line = `${caller.name} took ${issue.key}: assigned to ${login}`;
    deps.patch(project, issue.key, { assignee: login });
    ctx.toast(project, `👤 ${line}`, 'info');
    const task = ctx.repo.findTaskByTicket(project, issue.key);
    if (task) {
      ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: line });
      ctx.taskChanged(task.id);
    }
  } catch (err) {
    ctx.toast(project, `👤 Couldn’t assign ${issue.key}: ${(err as Error)?.message ?? String(err)}`, 'warn');
  }
}
