// The browse window's tree, built from pages of issues (browse.ts). Pure, for the browser and the tests.
//
// Jira: fix version → epic → story / task → sub-tasks. A version's page holds top-level issues; they
// are grouped under their epic (groupByEpic). The epic is found from the issue's `parent` when the
// parent's type is an epic, or is the issue itself when it is one. Issues of no epic go under a last
// "No epic" node. A story's sub-tasks are fetched when it is expanded (`childCount` says there are some).
//
// GitHub Projects: iteration (or Status) → items → sub-issues. A page holds board items; an item whose
// `parent` is also loaded nests under it (groupProjectItems), any other is a root.
//
// Loading more: add the new page to the old list with mergeIssues and group again. First-seen order
// is kept, so nodes grow in place and new epics come after the old ones (the "No epic" node stays last).

import type { BrowseIssue } from './browse.js';

/** Whether a type is an epic: Jira's hierarchy level 1, or a type called Epic. */
export function isEpicType(type?: string, hierarchy?: number): boolean {
  return hierarchy === 1 || /^epic$/i.test(type ?? '');
}

/** Whether the issue itself is an epic. */
export const isEpic = (i: BrowseIssue): boolean => isEpicType(i.issueType, i.hierarchy);

/** Whether the issue is done (Jira's status category, GitHub: closed). */
export const isDone = (i: Pick<BrowseIssue, 'statusCategory'>): boolean => i.statusCategory === 'done';

/** How far along some issues are. */
export interface Progress {
  done: number;
  total: number;
}

/** `done` of `total` among the issues. */
export function progress(items: Pick<BrowseIssue, 'statusCategory'>[]): Progress {
  return { done: items.filter(isDone).length, total: items.length };
}

/**
 * One epic of a version's page and the issues of it that are loaded. `key` is undefined on the
 * "No epic" node (`id` is `epic:none`).
 */
export interface EpicNode extends Progress {
  /** `epic:<key>`, or `epic:none`. */
  id: string;
  kind: 'epic' | 'none';
  key?: string;
  title: string;
  /** The epic's own record when it is among the loaded issues (it carries the epic's status). */
  issue?: BrowseIssue;
  /** What the epic's status is known to be: from its own record, else from what its issues' `parent` said. */
  status?: string;
  statusCategory?: BrowseIssue['statusCategory'];
  /** The loaded issues of the epic (never the epic itself), in the order they came. */
  items: BrowseIssue[];
}

/** An issue and the loaded issues nested under it (GitHub sub-issues, Jira sub-tasks once fetched). `done` / `total` are of the direct children. */
export interface ItemNode extends Progress {
  issue: BrowseIssue;
  children: ItemNode[];
}

export type TreeNode = EpicNode | ItemNode;

/** The loaded issues plus a newer page: an issue seen before is replaced where it was, a new one goes last. */
export function mergeIssues(prev: BrowseIssue[], more: BrowseIssue[]): BrowseIssue[] {
  const out = [...prev];
  const at = new Map(out.map((i, n) => [i.key, n]));
  for (const i of more) {
    const n = at.get(i.key);
    if (n === undefined) {
      at.set(i.key, out.length);
      out.push(i);
    } else out[n] = i;
  }
  return out;
}

/**
 * The issues of one version (or any list) as epics, first seen first, then "No epic" when some issue
 * has none. The same issue twice is kept once (the later copy).
 */
export function groupByEpic(items: BrowseIssue[]): EpicNode[] {
  const nodes = new Map<string, EpicNode>();
  const node = (key: string, title: string): EpicNode => {
    let n = nodes.get(key);
    if (!n) {
      n = { id: `epic:${key}`, kind: 'epic', key, title, items: [], done: 0, total: 0 };
      nodes.set(key, n);
    }
    return n;
  };
  const none: BrowseIssue[] = [];
  for (const i of mergeIssues([], items)) {
    if (isEpic(i)) {
      const n = node(i.key, i.title);
      n.issue = i;
      n.title = i.title;
      if (i.status) n.status = i.status;
      if (i.statusCategory) n.statusCategory = i.statusCategory;
    } else if (i.parent && isEpicType(i.parent.type, i.parent.hierarchy)) {
      const n = node(i.parent.key, i.parent.title);
      n.items.push(i);
      // The epic's own record, when it comes, has the final say.
      if (!n.issue) {
        if (i.parent.status) n.status = i.parent.status;
        if (i.parent.statusCategory) n.statusCategory = i.parent.statusCategory;
      }
    } else none.push(i);
  }
  const out = [...nodes.values()];
  if (none.length) out.push({ id: 'epic:none', kind: 'none', title: 'No epic', items: none, done: 0, total: 0 });
  for (const n of out) Object.assign(n, progress(n.items));
  return out;
}

/**
 * Board items as a forest: an item whose `parent` is among the items nests under it, any other is a
 * root. Roots and children keep the order they came in; a loop of parents (it can't happen, but
 * data is data) leaves its members as roots.
 */
export function groupProjectItems(items: BrowseIssue[]): ItemNode[] {
  const all = mergeIssues([], items);
  const byKey = new Map(all.map((i) => [i.key, i]));
  const nodes = new Map<string, ItemNode>(all.map((i) => [i.key, { issue: i, children: [], done: 0, total: 0 }]));
  const loops = (i: BrowseIssue): boolean => {
    for (let at = i, n = 0; at.parent; n++) {
      const up = byKey.get(at.parent.key);
      if (!up) return false;
      if (up.key === i.key || n > all.length) return true;
      at = up;
    }
    return false;
  };
  const roots: ItemNode[] = [];
  for (const i of all) {
    const me = nodes.get(i.key)!;
    const up = i.parent ? nodes.get(i.parent.key) : undefined;
    if (up && !loops(i)) up.children.push(me);
    else roots.push(me);
  }
  for (const n of nodes.values()) Object.assign(n, progress(n.children.map((c) => c.issue)));
  return roots;
}

/**
 * How far an issue's sub-tasks / sub-issues are: from the ones loaded when they all are (or the
 * issue doesn't say how many there are), else from the issue's own `childDone` / `childCount`.
 */
export function issueProgress(issue: BrowseIssue, loaded?: BrowseIssue[]): Progress | undefined {
  const count = issue.childCount;
  if (loaded && (count === undefined || loaded.length >= count)) return progress(loaded);
  if (count) return { done: issue.childDone ?? 0, total: count };
  return undefined;
}
