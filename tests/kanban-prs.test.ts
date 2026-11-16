import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFixPrs, openPrs, prMarkWords, prMarks, prStatusOk, reviewOf, type PrSubject } from '../src/shared/kanban/prs.js';

const task = (extra: Partial<PrSubject> = {}): PrSubject => ({ status: 'review', runState: 'idle', prs: [{ state: 'OPEN' }], ...extra });

test('canFixPrs: Waiting, Review and Done tasks at rest with an open or draft PR', () => {
  for (const status of ['waiting', 'review', 'done'] as const) assert.deepEqual(canFixPrs(task({ status })), { ok: true }, status);
  assert.deepEqual(canFixPrs(task({ prs: [{ state: 'MERGED' }, { state: 'DRAFT' }] })), { ok: true });
  assert.deepEqual(openPrs({ prs: [{ state: 'MERGED' }, { state: 'DRAFT' }, { state: 'CLOSED' }, { state: 'OPEN' }] }).map((p) => p.state), ['DRAFT', 'OPEN']);
});

test('canFixPrs: any task type, an investigation too', () => {
  assert.deepEqual(canFixPrs(task({ status: 'waiting', waitingReason: 'plan_questions' })), { ok: true });
});

test('canFixPrs says why not', () => {
  const why = (t: PrSubject) => {
    const r = canFixPrs(t);
    return r.ok ? '' : r.reason;
  };
  for (const status of ['todo', 'archived'] as const) assert.match(why(task({ status })), /from Waiting, Review or Done/, status);
  assert.match(why(task({ status: 'in_progress', runState: 'running' })), /it is running/);
  assert.match(why(task({ runState: 'queued' })), /it is running/, 'a queued or starting run counts');
  assert.match(why(task({ status: 'waiting', waitingReason: 'agent_asking' })), /asking in its terminal/, 'a live run in its terminal');
  assert.match(why(task({ prs: [] })), /no open pull requests/);
  assert.match(why(task({ prs: [{ state: 'MERGED' }, { state: 'CLOSED' }] })), /no open pull requests/);
});

test('canFixPrs: a task whose open PRs are all forks is refused; one own PR is enough; an unknown one counts as not a fork', () => {
  const prs = [{ state: 'OPEN' as const, n: 1 }, { state: 'DRAFT' as const, n: 2 }];
  const fork = (forks: Record<number, boolean | undefined>) => (p: { n: number }) => forks[p.n];
  const got = (forks: Record<number, boolean | undefined>) => canFixPrs({ status: 'review', runState: 'idle', prs }, fork(forks));
  assert.deepEqual(got({ 1: true, 2: true }), { ok: false, reason: 'A pull request from a fork: handle it by hand' });
  assert.deepEqual(got({ 1: true, 2: false }), { ok: true });
  assert.deepEqual(got({ 1: true }), { ok: true }, 'the board has not listed #2 (yet)');
  assert.deepEqual(canFixPrs({ status: 'review', runState: 'idle', prs: [{ state: 'MERGED' as const, n: 3 }, ...prs.slice(1)] }, fork({ 2: true })), { ok: false, reason: 'A pull request from a fork: handle it by hand' }, 'only open ones count');
});

test('prStatusOk: the columns pull requests are opened and fixed from', () => {
  assert.deepEqual((['todo', 'in_progress', 'waiting', 'review', 'done', 'archived'] as const).filter(prStatusOk), ['waiting', 'review', 'done']);
});

test('reviewOf: the decision wins, else the latest opinions (a change request beats an approval)', () => {
  assert.equal(reviewOf('REVIEW_REQUIRED', ['APPROVED']), 'REVIEW_REQUIRED');
  assert.equal(reviewOf('', ['APPROVED']), 'APPROVED');
  assert.equal(reviewOf(null, ['APPROVED', 'CHANGES_REQUESTED']), 'CHANGES_REQUESTED');
  assert.equal(reviewOf(undefined, ['COMMENTED']), undefined);
  assert.equal(reviewOf('', []), undefined);
});

test('prMarks and prMarkWords: only open and draft PRs, unresolved only when there are some', () => {
  assert.deepEqual(prMarks({ state: 'MERGED', review: 'APPROVED', unresolved: 2 }), {});
  assert.deepEqual(prMarks({ state: 'CLOSED', unresolved: 2 }), {});
  assert.deepEqual(prMarks({ state: 'OPEN', review: 'APPROVED', unresolved: 0 }), { review: 'APPROVED' });
  assert.deepEqual(prMarks({ state: 'DRAFT', unresolved: 3 }), { unresolved: 3 });
  assert.deepEqual(prMarkWords({ state: 'OPEN', review: 'CHANGES_REQUESTED', unresolved: 1 }), ['changes requested', '1 unresolved comment']);
  assert.deepEqual(prMarkWords({ state: 'OPEN', review: 'REVIEW_REQUIRED', unresolved: 3 }), ['review required', '3 unresolved comments']);
  assert.deepEqual(prMarkWords({ state: 'OPEN', review: 'APPROVED' }), ['approved']);
  assert.deepEqual(prMarkWords({ state: 'MERGED', review: 'APPROVED' }), []);
});
