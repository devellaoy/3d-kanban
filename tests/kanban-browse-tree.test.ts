import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEpic, groupProjectItems, isEpic, isEpicType, issueProgress, mergeIssues, progress } from '../src/shared/kanban/browsetree.js';
import type { BrowseIssue } from '../src/shared/kanban/browse.js';
import { jiraBrowseIssue } from '../src/server/kanban/integrations/issues/browse/jira.js';

const issue = (key: string, extra: Partial<BrowseIssue> = {}): BrowseIssue => ({ source: 'jira', key, title: `T ${key}`, url: `https://x/${key}`, body: '', labels: [], updatedAt: '', ...extra });
const EPIC_A = { key: 'UYT-1', title: 'Epic A', type: 'Epic', hierarchy: 1, status: 'In Progress', statusCategory: 'indeterminate' as const };
const EPIC_B = { key: 'UYT-2', title: 'Epic B', type: 'Epic', hierarchy: 1 };

/** A canned Jira search answer: a version's page, as the server maps it. */
const RAW = [
  { key: 'UYT-1', fields: { summary: 'Epic A', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Epic', hierarchyLevel: 1 }, labels: [], updated: 'u', fixVersions: [{ id: '7', name: '1.0' }] } },
  { key: 'UYT-10', fields: { summary: 'Story one', status: { name: 'Done', statusCategory: { key: 'done' } }, issuetype: { name: 'Story', hierarchyLevel: 0 }, parent: { key: 'UYT-1', fields: { summary: 'Epic A', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } }, subtasks: [{ key: 'UYT-11', fields: { status: { statusCategory: { key: 'done' } } } }, { key: 'UYT-12', fields: { status: { statusCategory: { key: 'new' } } } }] } },
  { key: 'UYT-20', fields: { summary: 'Story two', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Task', hierarchyLevel: 0 }, parent: { key: 'UYT-2', fields: { summary: 'Epic B', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } } } },
  { key: 'UYT-30', fields: { summary: 'Loose', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Bug' } } },
];
const page = RAW.map((r) => jiraBrowseIssue(r, 'team.atlassian.net', 's1')!);

test('a Jira page becomes epics: the epic as an item, as only a parent, and No epic last', () => {
  const tree = groupByEpic(page);
  assert.deepEqual(tree.map((n) => [n.id, n.kind, n.title, n.items.map((i) => i.key), n.done, n.total]), [
    ['epic:UYT-1', 'epic', 'Epic A', ['UYT-10'], 1, 1],
    ['epic:UYT-2', 'epic', 'Epic B', ['UYT-20'], 0, 1],
    ['epic:none', 'none', 'No epic', ['UYT-30'], 0, 1],
  ]);
  assert.equal(tree[0].issue?.key, 'UYT-1', 'the epic that is among the issues has its record');
  assert.equal(tree[0].statusCategory, 'indeterminate');
  assert.equal(tree[1].issue, undefined, 'an epic that is only a parent has none');
  assert.equal(tree[1].status, 'To Do', 'but its status comes with the parent');
  assert.ok(!tree[0].items.some((i) => i.key === 'UYT-1'), 'the epic is not its own child');
});

test('a story carries its sub-task count, and the progress is from the loaded ones when all are in', () => {
  const story = page[1];
  assert.deepEqual([story.childCount, story.childDone, story.fixVersions, page[0].fixVersions], [2, 1, undefined, [{ id: '7', name: '1.0' }]]);
  assert.deepEqual(issueProgress(story), { done: 1, total: 2 });
  assert.deepEqual(issueProgress(story, [issue('UYT-11', { statusCategory: 'done' }), issue('UYT-12', { statusCategory: 'done' })]), { done: 2, total: 2 });
  assert.deepEqual(issueProgress(story, [issue('UYT-11', { statusCategory: 'done' })]), { done: 1, total: 2 }, 'a partial load keeps the issue’s own numbers');
  assert.equal(issueProgress(page[3]), undefined);
  assert.deepEqual(progress([issue('a', { statusCategory: 'done' }), issue('b')]), { done: 1, total: 2 });
});

test('epic detection: hierarchy level 1 or a type called Epic', () => {
  assert.ok(isEpicType('Initiative', 1) && isEpicType('epic') && !isEpicType('Story', 0) && !isEpicType());
  assert.ok(isEpic(issue('E', { issueType: 'Epic' })) && !isEpic(issue('S', { issueType: 'Story' })));
});

test('Load more keeps the order: old epics grow in place, new ones come after, No epic stays last', () => {
  const first = [issue('S1', { parent: EPIC_A }), issue('S2')];
  const second = [issue('S3', { parent: EPIC_B }), issue('S4', { parent: EPIC_A }), issue('S5')];
  const merged = mergeIssues(first, second);
  assert.deepEqual(merged.map((i) => i.key), ['S1', 'S2', 'S3', 'S4', 'S5']);
  const tree = groupByEpic(merged);
  assert.deepEqual(tree.map((n) => [n.id, n.items.map((i) => i.key)]), [['epic:UYT-1', ['S1', 'S4']], ['epic:UYT-2', ['S3']], ['epic:none', ['S2', 'S5']]]);
  // A copy seen again replaces the old one in place (a status that changed), and the epic's own record arriving later fills the node.
  const again = mergeIssues(merged, [issue('S1', { parent: EPIC_A, status: 'Done', statusCategory: 'done' }), issue('UYT-1', { issueType: 'Epic', hierarchy: 1, status: 'Done', statusCategory: 'done' })]);
  assert.deepEqual(again.map((i) => i.key), ['S1', 'S2', 'S3', 'S4', 'S5', 'UYT-1']);
  const t2 = groupByEpic(again);
  assert.deepEqual(t2.map((n) => n.id), ['epic:UYT-1', 'epic:UYT-2', 'epic:none']);
  assert.deepEqual([t2[0].done, t2[0].total, t2[0].statusCategory], [1, 2, 'done']);
});

test('no issues, no nodes; the same issue twice is once', () => {
  assert.deepEqual(groupByEpic([]), []);
  assert.equal(groupByEpic([issue('A'), issue('A')])[0].items.length, 1);
});

// --- GitHub ---------------------------------------------------------------------------------------

const gh = (n: number, extra: Partial<BrowseIssue> = {}): BrowseIssue => issue(`gh:o/r#${n}`, { source: 'github-project', ...extra });
const parentOf = (n: number) => ({ key: `gh:o/r#${n}`, title: `P${n}` });

test('GitHub items nest under a parent that is loaded, else they are roots; order is kept', () => {
  const items = [gh(1, { childCount: 2, childDone: 1 }), gh(2, { parent: parentOf(1), statusCategory: 'done' }), gh(3, { parent: parentOf(99) }), gh(4, { parent: parentOf(1) }), gh(5, { parent: parentOf(4) })];
  const tree = groupProjectItems(items);
  assert.deepEqual(tree.map((n) => n.issue.key), ['gh:o/r#1', 'gh:o/r#3'], 'a parent that is not loaded leaves the item a root');
  assert.deepEqual(tree[0].children.map((n) => n.issue.key), ['gh:o/r#2', 'gh:o/r#4']);
  assert.deepEqual([tree[0].done, tree[0].total], [1, 2]);
  assert.deepEqual(tree[0].children[1].children.map((n) => n.issue.key), ['gh:o/r#5']);
});

test('a loop of parents (impossible, but data is data) leaves its members as roots', () => {
  const tree = groupProjectItems([gh(1, { parent: parentOf(2) }), gh(2, { parent: parentOf(1) }), gh(3, { parent: parentOf(3) })]);
  assert.equal(tree.length, 3);
  assert.deepEqual(groupProjectItems([]), []);
});
