import test from 'node:test';
import assert from 'node:assert/strict';
import { childChipClass, childrenDone, childrenHeading, childrenMsg, childrenSummary, isNewListRead } from '../src/client/kanban/issuechildrenmodel.js';

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

test('opening the window and then pressing Refresh asks the sub-tasks again, once for that read', () => {
  // The view as it opens: no read of the list seen yet.
  let last: number | undefined;
  let reloads = 0;
  const tell = (msg: { loading: boolean; fetchedAt: number }) => {
    if (!isNewListRead(last, msg)) return;
    last = msg.fetchedAt;
    reloads++;
  };
  // Refresh: the list says it is loading (still the old read's time), then the finished read, told twice (the answer and the broadcast).
  tell({ loading: true, fetchedAt: 100 });
  assert.equal(reloads, 0);
  tell({ loading: false, fetchedAt: 200 });
  assert.equal(reloads, 1, 'the first finished read after opening counts');
  tell({ loading: false, fetchedAt: 200 });
  assert.equal(reloads, 1, 'the same read is not asked after twice');
  // The next Refresh.
  tell({ loading: true, fetchedAt: 200 });
  tell({ loading: false, fetchedAt: 300 });
  assert.equal(reloads, 2);
});
