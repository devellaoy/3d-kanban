// What the child issues panel (issuechildren.ts) says about a Jira issue's children, apart from the
// page: which issues have the panel, what it asks the office, its heading and how many are done.

import type { IssueChild } from '../../shared/kanban/issueops.js';

/** An issue as far as its children go: only a Jira issue has them listed. */
export interface ChildrenIssue {
  key: string;
  url?: string;
  source?: string;
  /** The issue source it was listed or opened through (as for the issue's actions). */
  sourceId?: string;
}

/** What asks the office for the issue's children; nothing for an issue that isn't Jira's. */
export function childrenMsg(project: string, issue: ChildrenIssue): { t: 'kanban.issue.children'; project: string; issueKey: string; source?: string } | undefined {
  if (issue.source !== 'jira' || !issue.key) return undefined;
  return { t: 'kanban.issue.children', project, issueKey: issue.key, ...(issue.sourceId ? { source: issue.sourceId } : {}) };
}

/** "Subtasks" when every row is a sub-task; an epic's issues (or a mix) are "Child issues". */
export function childrenHeading(items: readonly Pick<IssueChild, 'subtask'>[]): string {
  return items.every((i) => i.subtask) ? 'Subtasks' : 'Child issues';
}

/** How many of the rows are done, by Jira's status category. */
export function childrenDone(items: readonly Pick<IssueChild, 'statusCategory'>[]): number {
  return items.filter((i) => i.statusCategory === 'done').length;
}

/** "2/5 done", of the rows listed; with `more` the list is only the first of them, which it says. */
export function childrenSummary(items: readonly Pick<IssueChild, 'statusCategory'>[], more?: boolean): string {
  const done = childrenDone(items);
  return more ? `${done} of the first ${items.length} done` : `${done}/${items.length} done`;
}

/** The class of a row's status chip: Jira's category, or none for a status without one. */
export function childChipClass(child: Pick<IssueChild, 'statusCategory'>): string {
  return `cat-${child.statusCategory ?? 'none'}`;
}
