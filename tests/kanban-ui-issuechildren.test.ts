import test from 'node:test';
import assert from 'node:assert/strict';
import { childChipClass, childrenDone, childrenHeading, childrenMsg, childrenSummary } from '../src/client/kanban/issuechildrenmodel.js';

test('only a Jira issue is asked for its children, through the source it was opened by', () => {
  assert.deepEqual(childrenMsg('app', { key: 'UYT-12', source: 'jira' }), { t: 'kanban.issue.children', project: 'app', issueKey: 'UYT-12' });
  assert.deepEqual(childrenMsg('app', { key: 'UYT-12', source: 'jira', sourceId: 's1' }), { t: 'kanban.issue.children', project: 'app', issueKey: 'UYT-12', source: 's1' });
  assert.equal(childrenMsg('app', { key: 'gh:acme/api#5', source: 'github-repo' }), undefined);
  assert.equal(childrenMsg('app', { key: 'UYT-12' }), undefined, 'a card that names no source');
  assert.equal(childrenMsg('app', { key: '', source: 'jira' }), undefined);
});

test('the heading says sub-tasks only when every row is one', () => {
  assert.equal(childrenHeading([{ subtask: true }, { subtask: true }]), 'Subtasks');
  assert.equal(childrenHeading([{ subtask: true }, {}]), 'Child issues');
  assert.equal(childrenHeading([{ subtask: false }]), 'Child issues', 'an epic’s issues');
});

test('done is counted by the status category, and a cut list says it is one', () => {
  const rows = [{ statusCategory: 'done' as const }, { statusCategory: 'indeterminate' as const }, { statusCategory: 'done' as const }, {}];
  assert.equal(childrenDone(rows), 2);
  assert.equal(childrenSummary(rows), '2/4 done');
  assert.equal(childrenSummary(rows, true), '2 of the first 4 done');
  assert.equal(childrenSummary([{ statusCategory: 'new' }]), '0/1 done');
});

test('a row’s chip takes the category’s tone, and a plain one without a category', () => {
  assert.equal(childChipClass({ statusCategory: 'new' }), 'cat-new');
  assert.equal(childChipClass({ statusCategory: 'indeterminate' }), 'cat-indeterminate');
  assert.equal(childChipClass({ statusCategory: 'done' }), 'cat-done');
  assert.equal(childChipClass({}), 'cat-none');
});
