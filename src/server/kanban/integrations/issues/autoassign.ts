// A task started from an issue takes the issue, as taking a card does: an open GitHub issue nobody
// has is assigned to the person, under their own gh sign-in only (never the office's shared gh), and
// the issue moves to "In progress" on the project's GitHub Projects boards (take.ts). The Status isn't
// personal, but it is a write too: it goes under the person's own gh, or the office's gh where that is
// theirs (the shared password); an account without a gh sign-in moves nothing and is told why.
// Never throws: the task is made already, and a failure is a warning to the person.

import type { KanbanCaller, KanbanContext } from '../../registry.js';
import { announce, ghIoFor, type ActionDeps } from './actions.js';
import type { IssueSourceIo } from './source.js';
import { takeIssue } from './take.js';

export interface ClaimDeps {
  patch: ActionDeps['patch'];
  io(project: string): IssueSourceIo;
  /** The cached issue, to tell a pull request (never assigned) and a board's own Status. */
  find?(project: string, key: string): { url: string; source?: string } | undefined;
}

/** `opts.status`: also move the issue to In progress on the project's boards (a task made without starting only assigns). */
export async function takeIssueForTask(ctx: KanbanContext, deps: ClaimDeps, project: string, ticketKey: string, caller: KanbanCaller & { warn?(text: string): void }, opts: { status: boolean }): Promise<void> {
  const warn = (text: string) => (caller.warn ? caller.warn(text) : ctx.toast(project, text, 'warn'));
  try {
    const base = deps.io(project);
    const own = ghIoFor(ctx, base, caller);
    if (typeof own === 'string') {
      if (/^ghp?:/.test(ticketKey)) warn(`👤 Couldn’t take ${ticketKey}: ${own}`);
      return;
    }
    const assignIo = own.shared ? undefined : own;
    const cached = deps.find?.(project, ticketKey);
    const took = await takeIssue({ ...(assignIo ? { assignIo } : {}), statusIo: own, key: ticketKey, sources: ctx.settings.project(project).issueSources, isPr: !!cached && /\/pull\/\d+/.test(cached.url), status: opts.status });
    if (took.assigned) announce(ctx, deps.patch, project, ticketKey, '👤', `${caller.name} took ${ticketKey}: assigned to ${took.assigned}`, { assignee: took.assigned });
    for (const m of took.moved) announce(ctx, deps.patch, project, ticketKey, '📋', `${ticketKey} moved to ${m.to} on ${m.board}`, cached?.source === 'github-project' ? { status: m.to } : undefined);
    for (const w of took.warnings) warn(w);
  } catch (err) {
    warn(`👤 Couldn’t assign ${ticketKey}: ${(err as Error)?.message ?? String(err)}`);
  }
}
