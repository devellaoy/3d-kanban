// A task made (or started) from an issue takes the issue, as taking a card does: an open GitHub
// issue nobody has is assigned to the person, under their own gh sign-in only (never the office's
// shared gh). Never throws: the task is made already, and a failure is a warning to the person.

import type { NormalizedIssue } from '../../../../shared/kanban/types.js';
import type { KanbanClient, KanbanContext } from '../../registry.js';
import { announce, ghIoFor, route, type ActionDeps } from './actions.js';
import { ghClaimIfUnassigned } from './github-ops.js';
import type { IssueSourceIo } from './source.js';

export interface ClaimDeps {
  patch: ActionDeps['patch'];
  io(project: string): IssueSourceIo;
}

/** Only under the person's own sign-in (the office's shared gh would put its account on the issue); a failure is a warning to them alone. */
export async function claimIssueForTask(ctx: KanbanContext, deps: ClaimDeps, project: string, issue: NormalizedIssue, caller: KanbanClient): Promise<void> {
  if (issue.assignee) return;
  const target = route(ctx.settings.project(project).issueSources, issue);
  // Jira, a draft, a pull request and a closed issue are left as they are.
  if (typeof target === 'string' || target.kind !== 'gh' || target.isPr || target.closed) return;
  try {
    // Inside the try: the task has been answered for already, so even getting the sign-in ready may only fail as a warning.
    const io = ghIoFor(ctx, deps.io(project), caller);
    if (typeof io === 'string' || io.shared) return;
    const login = await ghClaimIfUnassigned(io, target.repo, target.number);
    if (login) announce(ctx, deps.patch, project, issue.key, '👤', `${caller.name} took ${issue.key}: assigned to ${login}`, { assignee: login });
  } catch (err) {
    caller.warn?.(`👤 Couldn’t assign ${issue.key}: ${(err as Error)?.message ?? String(err)}`);
  }
}
