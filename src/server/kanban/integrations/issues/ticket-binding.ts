// Binds a task to its Jira ticket (db/ticketbindings.ts) wherever the SERVER ITSELF holds the issue from Jira through one of
// the project's sources: a list refresh, a person's read, a task made from it, an agent's read that passed the scope rule.
// Never from a typed `ticket` / `ticketUrl`, and never a Jira read made for this: it only piggybacks on reads that happen anyway.

import type { KanbanContext } from '../../registry.js';
import type { NormalizedIssue } from '../../../../shared/kanban/types.js';
import { sameJiraSite } from '../../../../shared/kanban/jira-connections.js';
import { getTicketBinding, setTicketBinding, ticketTasks } from '../../db/ticketbindings.js';
import { urlSite } from './agent-read-scope.js';

/** The project's tasks per ticket, for binding many issues at once (see bindTicket). */
export const taskTickets = (ctx: KanbanContext, project: string) => ticketTasks(ctx.repo.db, project);

/** Binds the project's tasks whose ticket is this Jira issue; writes only a missing or different row. Best effort: never throws. `tasks` is a taskTickets map (else asked for this key). */
export function bindTicket(ctx: KanbanContext, project: string, issue: NormalizedIssue, tasks?: Map<string, number[]>): void {
  if (issue.source !== 'jira') return;
  const site = urlSite(issue.url);
  if (!site) return;
  try {
    const key = issue.key.toUpperCase();
    for (const id of (tasks ?? ticketTasks(ctx.repo.db, project, issue.key)).get(key) ?? []) {
      const had = getTicketBinding(ctx.repo.db, id);
      if (had && had.ticket.toUpperCase() === key && sameJiraSite(had.site, site) && had.source === issue.sourceId) continue;
      setTicketBinding(ctx.repo.db, id, { ticket: issue.key, site, ...(issue.sourceId ? { source: issue.sourceId } : {}) });
    }
  } catch {
    // A binding that couldn't be written is only a convenience lost.
  }
}
