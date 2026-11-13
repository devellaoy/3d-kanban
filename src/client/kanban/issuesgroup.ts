// The Issues window's rows: a Jira sub-task sits under its parent (one level), whether or not the
// parent is in the list. Pure and DOM-free, so the node tests can import it.

import type { IssueParent, NormalizedIssue } from '../../shared/kanban/types.js';

export type IssueListRow = { kind: 'issue'; issue: NormalizedIssue; sub: boolean } | { kind: 'parent'; parent: IssueParent };

/** Whether the issue is a Jira sub-task that names a parent other than itself. */
const isSub = (i: NormalizedIssue): i is NormalizedIssue & { parent: IssueParent } => i.source === 'jira' && i.subtask === true && !!i.parent && i.parent.key !== i.key;

/** The Jira site an issue is on, read from its address (the record names the source, and several sources can read one site). */
const siteOf = (i: NormalizedIssue): string => /^https?:\/\/([^/]+)/i.exec(i.url)?.[1].toLowerCase() ?? '';

/**
 * The rows of the shown issues: families (a parent and its sub-tasks) stand where their first
 * member does, the parent first, then the sub-tasks in the order they came. A parent that is not
 * shown is one `parent` row, built from its sub-tasks' `parent`. Other sources are never grouped.
 */
export function groupIssueRows(shown: NormalizedIssue[]): IssueListRow[] {
  // A family is a parent key within one Jira site, whichever of the project's sources its members came
  // from: the same key on another site is another issue.
  const fam = (site: string, key: string) => `${site}\u0000${key}`;
  const real = new Map<string, NormalizedIssue>();
  for (const i of shown) if (i.source === 'jira' && !real.has(fam(siteOf(i), i.key))) real.set(fam(siteOf(i), i.key), i);
  // A parent that is itself a sub-task (broken data) is no parent: its children stay roots.
  const grouped = (i: NormalizedIssue & { parent: IssueParent }) => !isSub(real.get(fam(siteOf(i), i.parent.key)) ?? ({} as NormalizedIssue));
  const children = new Map<string, NormalizedIssue[]>();
  for (const i of shown) if (isSub(i) && grouped(i)) children.set(fam(siteOf(i), i.parent.key), [...(children.get(fam(siteOf(i), i.parent.key)) ?? []), i]);
  const rows: IssueListRow[] = [];
  const done = new Set<string>();
  for (const i of shown) {
    const family = isSub(i) && grouped(i) ? fam(siteOf(i), i.parent.key) : i.source === 'jira' && children.has(fam(siteOf(i), i.key)) ? fam(siteOf(i), i.key) : undefined;
    if (family === undefined) {
      rows.push({ kind: 'issue', issue: i, sub: false });
      continue;
    }
    const head = real.get(family);
    if (done.has(family)) {
      // The same key twice on one site: the second copy is not the family's parent, and stays a root.
      if (!isSub(i) && head !== i) rows.push({ kind: 'issue', issue: i, sub: false });
      continue;
    }
    done.add(family);
    const kids = children.get(family)!;
    rows.push(head ? { kind: 'issue', issue: head, sub: false } : { kind: 'parent', parent: (kids[0] as NormalizedIssue & { parent: IssueParent }).parent });
    for (const c of kids) rows.push({ kind: 'issue', issue: c, sub: true });
  }
  return rows;
}
