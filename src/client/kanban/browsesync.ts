// The DOM-free part of keeping the browse tree (browsetree.ts) in step as pages come in. Each issue
// has one row view, kept by key, which is moved (never made again) when a regroup puts the issue
// somewhere else, so its open state, its loaded sub-tasks and its counts go with it and no issue is
// ever shown twice. Written against a tiny list interface so the tests can drive it without a DOM.

import type { BrowseIssue } from '../../shared/kanban/browse.js';
import type { ItemNode } from '../../shared/kanban/browsetree.js';

/** What syncChildren needs of a list (a DOM element is one). */
export interface ChildList<N> {
  readonly children: ArrayLike<N>;
  insertBefore(node: N, ref: N | null): unknown;
  removeChild(node: N): unknown;
}

/**
 * Makes `list`'s children exactly `want`, in order, with the fewest moves: whatever isn't wanted is
 * taken out first, a node already in place stays put (so focus in it survives), and a node that is
 * elsewhere (another list) is moved in, not copied. A node wanted twice is placed once.
 */
export function syncChildren<N>(list: ChildList<N>, want: readonly N[]): void {
  const wanted = [...new Set(want)];
  const keep = new Set(wanted);
  for (let i = list.children.length - 1; i >= 0; i--) {
    const c = list.children[i];
    if (!keep.has(c)) list.removeChild(c);
  }
  for (let i = 0; i < wanted.length; i++) {
    const at = i < list.children.length ? list.children[i] : null;
    if (at !== wanted[i]) list.insertBefore(wanted[i], at);
  }
}

/**
 * The views of `nodes`, in order, from `views` (key → view): an issue seen before gets its old view,
 * updated; a new one gets a new view, remembered. Each key comes once, the first time it is listed.
 */
export function viewsFor<V>(views: Map<string, V>, nodes: readonly ItemNode[], make: (n: ItemNode) => V, update: (v: V, n: ItemNode) => void): V[] {
  const out: V[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const key = n.issue.key;
    if (seen.has(key)) continue;
    seen.add(key);
    let v = views.get(key);
    if (!v) views.set(key, (v = make(n)));
    else update(v, n);
    out.push(v);
  }
  return out;
}

/** Whether the issue was sent only as the parent of a match (it doesn't match the filters itself). */
export const isContext = (i: BrowseIssue): boolean => i.context === true;

/** The task made from the issue's parent, when the page said (BrowseIssue.parent.taskId). */
export const parentTaskId = (i: BrowseIssue): number | undefined => i.parent?.taskId;

/**
 * Whether an issue whose loaded sub-tasks are `nested` should fetch more of them when opened: only
 * when it says it has more than are nested already.
 */
export const hasMoreKids = (i: BrowseIssue, nested: number): boolean => !!i.childCount && nested < i.childCount;
