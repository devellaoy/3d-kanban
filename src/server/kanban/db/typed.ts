// The comments typed into a running implementer (Live.officePrompts), kept on its run until the run is over, so an office restart
// can go on tracking them (or give them back to the queue): docs/kanban-architecture.md §4, "Comments".

import type Database from 'better-sqlite3';
import type { PendingMessage } from '../../../shared/kanban/types.js';

/** A comment typed into the run: when, the start of its text, whether the agent's prompt hook heard it, and the queued form it goes back to. */
export interface TypedPrompt {
  at: number;
  head: string;
  heard?: boolean;
  msg?: PendingMessage;
}

export function setRunTyped(db: Database.Database, runId: number, typed: TypedPrompt[] | undefined) {
  db.prepare('UPDATE runs SET typed = ? WHERE id = ?').run(typed?.length ? JSON.stringify(typed) : null, runId);
}

/** What was typed into the run and is kept (empty when nothing, or a record that can't be read). */
export function runTyped(db: Database.Database, runId: number): TypedPrompt[] {
  const row = db.prepare('SELECT typed FROM runs WHERE id = ?').get(runId) as { typed: string | null } | undefined;
  try {
    const list = row?.typed ? (JSON.parse(row.typed) as unknown) : [];
    return Array.isArray(list) ? (list as TypedPrompt[]).filter((p) => p && typeof p.at === 'number' && typeof p.head === 'string') : [];
  } catch {
    return [];
  }
}
