// The browse tree's reconciliation (client/kanban/browsesync.ts), driven without a DOM: a fake list
// that, like the DOM, moves a node out of its old list when it is inserted into another one. The
// views are wired the way browseview.ts wires them: one key → view map per list, roots synced into
// the list, an issue's nested children synced into its own list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterPage, hasMoreKids, isContext, issueSignature, parentTaskId, syncChildren, viewsFor, type ChildList } from '../src/client/kanban/browsesync.js';
import { groupByEpic, groupProjectItems, mergeIssues, type ItemNode } from '../src/shared/kanban/browsetree.js';
import type { BrowseIssue, BrowseScope } from '../src/shared/kanban/browse.js';
import { DEFAULTS, catOf, catsFor, dropUnresolvedMe, type Saved } from '../src/client/kanban/browsefilters.js';

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
/** One list of issues as browseview.ts builds it: the pages merged, regrouped, reconciled. */
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

test('issueSignature: equal for an unchanged row, different for anything it shows, and for nested changes', () => {
  const a = gh(1, { status: 'Open', assignee: 'x', labels: ['a', 'b'], childCount: 2, childDone: 1 });
  const nested = (i: BrowseIssue): ItemNode[] => [{ issue: i, children: [], done: 0, total: 0 } as unknown as ItemNode];
  assert.equal(issueSignature(a), issueSignature({ ...a }));
  for (const change of [{ title: 'new' }, { status: 'Closed' }, { statusCategory: 'done' as const }, { assignee: 'y' }, { taskId: 3 }, { childCount: 3 }, { childDone: 2 }, { context: true as const }, { labels: ['a'] }])
    assert.notEqual(issueSignature(a), issueSignature({ ...a, ...change }), JSON.stringify(change));
  assert.equal(issueSignature(a, nested(gh(2))), issueSignature({ ...a }, nested(gh(2))));
  assert.notEqual(issueSignature(a, nested(gh(2))), issueSignature(a, nested(gh(2, { status: 'Done' }))), 'a nested child changing repaints');
  assert.notEqual(issueSignature(a), issueSignature(a, nested(gh(2))));
});

test('afterPage: "no matches" only when nothing shows and nothing more is to load', () => {
  assert.equal(afterPage(0, true), 'wait');
  assert.equal(afterPage(0, false), 'none');
  assert.equal(afterPage(2, true), 'rows');
  assert.equal(afterPage(2, false), 'rows');
});

const gscope = { id: 'g', kind: 'github-project', label: 'G' } as BrowseScope;
const jscope = { id: 'j', kind: 'jira', label: 'J', site: 's' } as BrowseScope;

test('a GitHub board offers only Not done, Done and Any; a remembered To do falls back to Not done', () => {
  assert.deepEqual(
    catsFor(gscope).map(([v]) => v),
    ['open', 'done', 'all'],
  );
  assert.equal(catsFor(jscope).length, 5);
  assert.equal(catOf('new', gscope), 'open');
  assert.equal(catOf('indeterminate', gscope), 'open');
  assert.equal(catOf('done', gscope), 'done');
  assert.equal(catOf('new', jscope), 'new');
});

test('"Me" that can not be resolved goes back to Anyone with a notice', () => {
  const s: Saved = { ...DEFAULTS, who: 'me' };
  const notice = dropUnresolvedMe(s, gscope, undefined);
  assert.equal(s.who, '');
  assert.match(notice ?? '', /Me/);
  const ok: Saved = { ...DEFAULTS, who: 'me' };
  assert.equal(dropUnresolvedMe(ok, gscope, { id: 'u', name: 'u' }), undefined);
  assert.equal(ok.who, 'me');
});
