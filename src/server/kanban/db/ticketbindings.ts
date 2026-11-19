// A task's server-verified binding to its Jira ticket: one row per task (the row goes with the task), replaced when a
// new ticket is verified. Kept apart from the task's event history, which is trimmed.

import type Database from 'better-sqlite3';

export interface TicketBindingRow { ticket: string; site: string; source?: string }

export function getTicketBinding(db: Database.Database, taskId: number): TicketBindingRow | undefined {
  const r = db.prepare('SELECT ticket, site, source FROM ticket_bindings WHERE task_id = ?').get(taskId) as { ticket: string; site: string; source: string | null } | undefined;
  return r && { ticket: r.ticket, site: r.site, ...(r.source ? { source: r.source } : {}) };
}

/** Stores the task's binding, replacing the one it had. */
export function setTicketBinding(db: Database.Database, taskId: number, b: TicketBindingRow, at = Date.now()): void {
  db.prepare('INSERT OR REPLACE INTO ticket_bindings (task_id, ticket, site, source, verified_at) VALUES (?, ?, ?, ?, ?)').run(taskId, b.ticket, b.site, b.source ?? null, at);
}

/** The project's tasks per ticket (upper-cased), every task of it. */
export function ticketTasks(db: Database.Database, project: string, ticket?: string): Map<string, number[]> {
  const rows = (ticket === undefined
    ? db.prepare("SELECT ticket, id FROM tasks WHERE project = ? AND ticket IS NOT NULL AND ticket <> '' ORDER BY id").all(project)
    : db.prepare('SELECT ticket, id FROM tasks WHERE project = ? AND upper(ticket) = upper(?) ORDER BY id').all(project, ticket)) as { ticket: string; id: number }[];
  const out = new Map<string, number[]>();
  for (const r of rows) out.set(r.ticket.toUpperCase(), [...(out.get(r.ticket.toUpperCase()) ?? []), r.id]);
  return out;
}
