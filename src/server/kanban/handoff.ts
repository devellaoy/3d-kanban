// What a meeting hand-off needs to know of a kanban task before the meeting's record says it was handed on to it.
import type { KanbanRepository } from './db/repository.js';

/** The floor a task belongs to and its tags; undefined when there is no such task. */
export function taskOf(repo: Pick<KanbanRepository, 'getTask'>, id: number): { project: string; tags: string[] } | undefined {
  const t = repo.getTask(id);
  return t && { project: t.project, tags: t.tags };
}
