import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIssueRows, type IssueListRow } from '../src/client/kanban/issuesgroup.js';
import type { NormalizedIssue } from '../src/shared/kanban/types.js';

const issue = (key: string, over: Partial<NormalizedIssue> = {}): NormalizedIssue => ({ source: 'jira', key, title: key, url: '', body: '', labels: [], updatedAt: '', ...over });
const sub = (key: string, parent: string, over: Partial<NormalizedIssue> = {}) => issue(key, { issueType: 'Sub-task', subtask: true, parent: { key: parent, title: `Title of ${parent}`, type: 'Story' }, ...over });
/** A row as text: `-` before a sub-task, `^` for a parent header. */
const show = (rows: IssueListRow[]) => rows.map((r) => (r.kind === 'parent' ? `^${r.parent.key}` : `${r.sub ? '-' : ''}${r.issue.key}`));

test('sub-tasks sit under their parent, in the order they came', () => {
  const rows = groupIssueRows([sub('A-2', 'A-1'), issue('A-1'), sub('A-3', 'A-1')]);
  assert.deepEqual(show(rows), ['A-1', '-A-2', '-A-3']);
  assert.equal((rows[0] as { issue: NormalizedIssue }).issue.key, 'A-1', 'the parent’s real row, not a header');
});

test('a family stands where its first member does', () => {
  const rows = groupIssueRows([issue('B-1'), sub('A-2', 'A-1'), issue('C-1'), issue('A-1'), sub('A-3', 'A-1')]);
  assert.deepEqual(show(rows), ['B-1', 'A-1', '-A-2', '-A-3', 'C-1']);
});

test('a parent that is not in the list is one header, with its sub-tasks under it', () => {
  const rows = groupIssueRows([issue('X-1'), sub('A-2', 'A-1'), sub('A-3', 'A-1'), sub('A-5', 'A-4')]);
  assert.deepEqual(show(rows), ['X-1', '^A-1', '-A-2', '-A-3', '^A-4', '-A-5']);
  assert.deepEqual((rows[1] as { parent: unknown }).parent, { key: 'A-1', title: 'Title of A-1', type: 'Story' });
});

test('a parent filtered out of the shown issues is a header too', () => {
  const all = [issue('A-1'), sub('A-2', 'A-1')];
  assert.deepEqual(show(groupIssueRows(all)), ['A-1', '-A-2']);
  assert.deepEqual(show(groupIssueRows(all.filter((i) => i.key !== 'A-1'))), ['^A-1', '-A-2']);
});

test('only Jira is grouped: another source stays a root, even with a parent and a sub-task flag', () => {
  const gh = issue('gh:o/r#2', { source: 'github-repo', issueType: 'Task', subtask: true, parent: { key: 'gh:o/r#1', title: 'Parent' } });
  assert.deepEqual(show(groupIssueRows([gh, issue('gh:o/r#1', { source: 'github-repo' })])), ['gh:o/r#2', 'gh:o/r#1']);
  assert.deepEqual(groupIssueRows([gh]), [{ kind: 'issue', issue: gh, sub: false }]);
});

test('broken data is a root: no parent, its own key as parent, a parent that is a sub-task itself', () => {
  assert.deepEqual(show(groupIssueRows([issue('A-2', { subtask: true })])), ['A-2']);
  assert.deepEqual(show(groupIssueRows([sub('A-2', 'A-2')])), ['A-2']);
  // A-3 under A-2, which is itself under A-1: one level only.
  assert.deepEqual(show(groupIssueRows([sub('A-3', 'A-2'), sub('A-2', 'A-1'), issue('A-1')])), ['A-3', 'A-1', '-A-2']);
  // A loop: neither is anyone's parent.
  assert.deepEqual(show(groupIssueRows([sub('A-1', 'A-2'), sub('A-2', 'A-1')])), ['A-1', 'A-2']);
});

test('stories and epics stay in a flat list: the epic is a hint on the row, not a group', () => {
  const rows = groupIssueRows([issue('A-2', { epic: 'A-1', issueType: 'Story' }), issue('A-1', { issueType: 'Epic' })]);
  assert.deepEqual(show(rows), ['A-2', 'A-1']);
});

const at = (site: string, key: string) => `https://${site}/browse/${key}`;

test('families are per Jira site: the same parent key on two sites makes two families', () => {
  const a = sub('A-2', 'A-1', { url: at('one.example', 'A-2') });
  const b = sub('B-9', 'A-1', { url: at('two.example', 'B-9'), parent: { key: 'A-1', title: 'Other site' } });
  const rows = groupIssueRows([a, issue('Z-1'), b]);
  assert.deepEqual(show(rows), ['^A-1', '-A-2', 'Z-1', '^A-1', '-B-9']);
  assert.equal((rows[3] as { parent: { title: string } }).parent.title, 'Other site');
  // A parent row on another site does not adopt them; the one on their own site does.
  const other = issue('A-1', { url: at('three.example', 'A-1') });
  assert.deepEqual(show(groupIssueRows([a, other])), ['^A-1', '-A-2', 'A-1']);
  const own = issue('A-1', { url: at('ONE.example', 'A-1') });
  assert.deepEqual(show(groupIssueRows([a, own, b])), ['A-1', '-A-2', '^A-1', '-B-9']);
});

test('one site read by several sources is one family: the parent and the siblings may come from different sources', () => {
  const site = 'one.example';
  const mine = sub('A-2', 'A-1', { sourceId: 'my-subtasks', url: at(site, 'A-2') });
  const story = issue('A-1', { sourceId: 'stories', issueType: 'Story', url: at(site, 'A-1') });
  const theirs = sub('A-3', 'A-1', { sourceId: 'labelled', url: at(site, 'A-3') });
  // The story's real row heads the family: no header stands in for it.
  assert.deepEqual(show(groupIssueRows([mine, issue('Z-1', { url: at(site, 'Z-1') }), story, theirs])), ['A-1', '-A-2', '-A-3', 'Z-1']);
  // Without the story, the siblings of two sources share one header.
  assert.deepEqual(show(groupIssueRows([mine, theirs])), ['^A-1', '-A-2', '-A-3']);
});
