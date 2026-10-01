// The browse tree's reconciliation (client/kanban/browsesync.ts), driven without a DOM: a fake list
// that, like the DOM, moves a node out of its old list when it is inserted into another one. The
// views are wired the way browsetree.ts wires them: one key → view map per list, roots synced into
// the list, an issue's nested children synced into its own list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMoreKids, isContext, parentTaskId, syncChildren, viewsFor, type ChildList } from '../src/client/kanban/browsesync.js';
import { groupByEpic, groupProjectItems, mergeIssues, type ItemNode } from '../src/shared/kanban/browsetree.js';
import type { BrowseIssue } from '../src/shared/kanban/browse.js';

class FakeNode {
  parent: FakeList | null = null;
  constructor(readonly name: string) {}
}
class FakeList implements ChildList<FakeNode> {
  kids: FakeNode[] = [];
  moves = 0;
  get children() {
    return this.kids;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    node.parent?.removeChild(node);
    const at = ref ? this.kids.indexOf(ref) : this.kids.length;
    this.kids.splice(at < 0 ? this.kids.length : at, 0, node);
    node.parent = this;
    this.moves++;
  }
  removeChild(node: FakeNode) {
    this.kids = this.kids.filter((k) => k !== node);
    node.parent = null;
  }
}

interface View {
  li: FakeNode;
  list: FakeList;
  expanded: boolean;
  made: number;
  update(issue: BrowseIssue, nested: ItemNode[]): void;
}

let made = 0;
/** One list of issues as browsetree.ts builds it: the pages merged, regrouped, reconciled. */
function tree() {
  const root = new FakeList();
  const views = new Map<string, View>();
  const view = (issue: BrowseIssue, nested: ItemNode[]): View => {
    const v: View = {
      li: new FakeNode(issue.key),
      list: new FakeList(),
      expanded: false,
      made: ++made,
      update(_i, kids) {
        if (kids.length) v.expanded = true;
        if (!v.expanded) return;
        syncChildren(
          v.list,
          viewsFor(views, kids, (k) => view(k.issue, k.children), (w, k) => w.update(k.issue, k.children)).map((w) => w.li),
        );
      },
    };
    v.update(issue, nested);
    return v;
  };
  let items: BrowseIssue[] = [];
  return {
    root,
    views,
    page(more: BrowseIssue[]) {
      items = mergeIssues(items, more);
      const roots = groupProjectItems(items);
      syncChildren(root, viewsFor(views, roots, (r) => view(r.issue, r.children), (v, r) => v.update(r.issue, r.children)).map((v) => v.li));
    },
  };
}

const gh = (n: number, extra: Partial<BrowseIssue> = {}): BrowseIssue => ({ source: 'github', key: `gh:acme/api#${n}`, title: `#${n}`, url: '', body: '', labels: [], updatedAt: '', ...extra });
const parentOf = (n: number) => ({ parent: { key: `gh:acme/api#${n}`, title: `#${n}` } });
/** Every node under a list, all the way down. */
function everywhere(t: ReturnType<typeof tree>): string[] {
  const out: string[] = [];
  const walk = (l: FakeList) => {
    for (const k of l.kids) {
      out.push(k.name);
      walk(t.views.get(k.name)!.list);
    }
  };
  walk(t.root);
  return out;
}

test('a GitHub child on page one moves under its parent when the parent comes on page two, and shows once', () => {
  const t = tree();
  t.page([gh(2, parentOf(1)), gh(3)]);
  assert.deepEqual(
    t.root.kids.map((k) => k.name),
    ['gh:acme/api#2', 'gh:acme/api#3'],
  );
  const child = t.views.get('gh:acme/api#2')!;
  t.page([gh(1, { childCount: 1 })]);
  assert.deepEqual(
    t.root.kids.map((k) => k.name),
    ['gh:acme/api#3', 'gh:acme/api#1'],
    'the child is no root any more',
  );
  const parent = t.views.get('gh:acme/api#1')!;
  assert.deepEqual(
    parent.list.kids.map((k) => k.name),
    ['gh:acme/api#2'],
  );
  assert.equal(t.views.get('gh:acme/api#2'), child, 'the same view, moved, not made again');
  const all = everywhere(t);
  assert.equal(all.filter((k) => k === 'gh:acme/api#2').length, 1, 'never twice');
  assert.equal(all.length, new Set(all).size);
});

test('a row’s open state and its loaded children survive being reparented', () => {
  const t = tree();
  t.page([gh(2, parentOf(1)), gh(4, parentOf(2))]);
  const mid = t.views.get('gh:acme/api#2')!;
  assert.equal(mid.expanded, true, 'opened to show what was nested');
  assert.equal(mid.li.parent, t.root);
  const grandchild = t.views.get('gh:acme/api#4')!;
  t.page([gh(1)]);
  assert.equal(t.views.get('gh:acme/api#2'), mid);
  assert.equal(mid.li.parent, t.views.get('gh:acme/api#1')!.list, 'now under its parent');
  assert.equal(mid.expanded, true, 'still open');
  assert.equal(grandchild.li.parent, mid.list, 'its child came with it');
  assert.deepEqual(everywhere(t), ['gh:acme/api#1', 'gh:acme/api#2', 'gh:acme/api#4']);
});

test('syncChildren takes out the unwanted first, so the rows that stay are not moved', () => {
  const l = new FakeList();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => new FakeNode(n));
  syncChildren(l, [a, b, c]);
  l.moves = 0;
  syncChildren(l, [b, c]);
  assert.deepEqual(
    l.kids.map((k) => k.name),
    ['b', 'c'],
  );
  assert.equal(l.moves, 0);
  syncChildren(l, [c, b, c]);
  assert.deepEqual(
    l.kids.map((k) => k.name),
    ['c', 'b'],
    'a node wanted twice is placed once',
  );
});

test('a Jira "No epic" node goes when its sub-task finds its story (the version list reconciles epic nodes)', () => {
  const j = (key: string, extra: Partial<BrowseIssue> = {}): BrowseIssue => ({ source: 'jira', key, title: key, url: '', body: '', labels: [], updatedAt: '', ...extra });
  const epic = { key: 'UYT-1', title: 'E', type: 'Epic', hierarchy: 1, taskId: 7 };
  const page1 = [j('UYT-11', { subtask: true, hierarchy: -1, parent: { key: 'UYT-10', title: 'S' } })];
  assert.deepEqual(
    groupByEpic(page1).map((e) => e.id),
    ['epic:none'],
  );
  const both = mergeIssues(page1, [j('UYT-10', { parent: epic, context: true, childCount: 2 })]);
  const nodes = groupByEpic(both);
  assert.deepEqual(
    nodes.map((e) => e.id),
    ['epic:UYT-1'],
  );
  const list = new FakeList();
  const views = new Map(['epic:none', 'epic:UYT-1'].map((id) => [id, new FakeNode(id)]));
  syncChildren(list, [views.get('epic:none')!]);
  syncChildren(
    list,
    nodes.map((e) => views.get(e.id)!),
  );
  assert.deepEqual(
    list.kids.map((k) => k.name),
    ['epic:UYT-1'],
  );
  assert.equal(nodes[0].items.map(parentTaskId).find(Boolean), 7, 'the epic header links to its task');
  assert.ok(isContext(nodes[0].items[0]));
  assert.ok(hasMoreKids(nodes[0].items[0], 1), 'one of two sub-tasks nested: the rest are fetched on open');
  assert.ok(!hasMoreKids(nodes[0].items[0], 2));
});
