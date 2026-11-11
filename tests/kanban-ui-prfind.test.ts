import test from 'node:test';
import assert from 'node:assert/strict';
import { PR_LINK_MAX, canPickMore, foundToasts, goneToast, linkedText, pickedText, taskLabel } from '../src/client/kanban/prfindmodel.js';

const pr = (n: number) => ({ repo: 'acme/api', number: n });
const none = { linked: [], candidates: [], skipped: [], notes: [] };

test('Find PRs says what it linked, or that it found nothing', () => {
  assert.deepEqual(foundToasts({ ...none, linked: [pr(1), pr(2)] }), [{ text: 'Linked acme/api#1, acme/api#2' }]);
  assert.deepEqual(foundToasts(none), [{ text: 'No pull requests found for this task' }]);
  assert.deepEqual(foundToasts({ ...none, candidates: [{}] }), [], 'the confirmation window speaks for the candidates');
});

test('skipped pull requests and unsearchable repositories are one warning each', () => {
  const t = foundToasts({ ...none, linked: [pr(1)], skipped: [{ ...pr(3), reason: 'belongs to task #4' }], notes: ['acme/web: no access'] });
  assert.equal(t.length, 3);
  assert.deepEqual(t.slice(1).map((x) => x.kind), ['warn', 'warn']);
  assert.match(t[1].text, /acme\/api#3 \(belongs to task #4\)/);
});

test('a long list of links is cut short', () => {
  assert.equal(linkedText([1, 2, 3, 4, 5, 6].map(pr)), 'Linked acme/api#1, acme/api#2, acme/api#3, acme/api#4 and 2 more');
});

test('one go links at most 20 pull requests: a further tick is refused and the window counts', () => {
  assert.equal(PR_LINK_MAX, 20);
  assert.deepEqual([19, 20, 21].map(canPickMore), [true, false, false]);
  assert.equal(pickedText(3, 20), '', 'nothing to say while every candidate fits');
  assert.equal(pickedText(3, 21), '3 of at most 20 selected');
});

test('a search whose task is no longer shown names the task in every toast and in the one that replaces the window', () => {
  const t = foundToasts({ ...none, linked: [pr(1)], notes: ['acme/api: the newest pull requests couldn\'t be listed (boom), so ones that only mention the ticket may be missing'] }, 12);
  assert.ok(t.every((x) => x.text.startsWith('Task #12: ')));
  assert.equal(foundToasts(none, 12)[0].text, 'Task #12: No pull requests found');
  assert.equal(goneToast(12, 3), 'Task #12: 3 pull requests may be its. Open its PRs tab and use 🔎 Find PRs again.');
  assert.match(goneToast(12, 1), /1 pull request may/);
  assert.equal(taskLabel({ id: 12, title: 'Fix login' }), '#12 Fix login');
});

test('each note is a warning of its own, at most three', () => {
  const t = foundToasts({ ...none, notes: ['a: x', 'b: y', 'c: z', 'd: w'] });
  assert.deepEqual(t.map((x) => x.text), ['No pull requests found for this task', 'a: x', 'b: y', 'c: z', 'and 1 more']);
});
