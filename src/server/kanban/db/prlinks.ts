// A task's linked pull requests: the row mapper and the review marks the PR board keeps up to date.

import type Database from 'better-sqlite3';
import type { PrReview } from '../../../shared/kanban/prs.js';
import type { KanbanPrLink } from '../../../shared/kanban/types.js';
import { clean, opt } from './columns.js';

type Row = Record<string, unknown>;

export function prLink(r: Row): KanbanPrLink {
  return clean({
    repoId: r.repo_id as string,
    repo: opt<string>(r.repo),
    number: r.number as number,
    url: r.url as string,
    state: r.state as KanbanPrLink['state'],
    review: opt<PrReview>(r.review),
    unresolved: opt<number>(r.unresolved),
    branch: opt<string>(r.branch),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  });
}

/** Sets a link's review marks (undefined: NULL, unknown) when they differ; true when a row changed. updated_at is not touched. */
export function setPrLinkMarks(db: Database.Database, taskId: number, repoId: string, number: number, marks: { review?: PrReview; unresolved?: number }): boolean {
  const review = marks.review ?? null;
  const unresolved = marks.unresolved ?? null;
  return db.prepare('UPDATE pr_links SET review = ?, unresolved = ? WHERE task_id = ? AND repo_id = ? AND number = ? AND (review IS NOT ? OR unresolved IS NOT ?)').run(review, unresolved, taskId, repoId, number, review, unresolved).changes > 0;
}
