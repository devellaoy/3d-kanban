import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFixPrs, openPrs, type PrSubject } from '../src/shared/kanban/prs.js';

const task = (extra: Partial<PrSubject> = {}): PrSubject => ({ type: 'implement', status: 'review', runState: 'idle', prs: [{ state: 'OPEN' }], ...extra });

test('canFixPrs: Waiting, Review and Done tasks at rest with an open or draft PR', () => {
  for (const status of ['waiting', 'review', 'done'] as const) assert.deepEqual(canFixPrs(task({ status })), { ok: true }, status);
  assert.deepEqual(canFixPrs(task({ prs: [{ state: 'MERGED' }, { state: 'DRAFT' }] })), { ok: true });
  assert.deepEqual(openPrs({ prs: [{ state: 'MERGED' }, { state: 'DRAFT' }, { state: 'CLOSED' }, { state: 'OPEN' }] }).map((p) => p.state), ['DRAFT', 'OPEN']);
});

test('canFixPrs says why not', () => {
  const why = (t: PrSubject) => {
    const r = canFixPrs(t);
    return r.ok ? '' : r.reason;
  };
  for (const status of ['todo', 'archived'] as const) assert.match(why(task({ status })), /from Waiting, Review or Done/, status);
  assert.match(why(task({ status: 'in_progress', runState: 'running' })), /it is running/);
  assert.match(why(task({ runState: 'queued' })), /it is running/, 'a queued or starting run counts');
  assert.match(why(task({ type: 'investigate' })), /investigation/);
  assert.match(why(task({ prs: [] })), /no open pull requests/);
  assert.match(why(task({ prs: [{ state: 'MERGED' }, { state: 'CLOSED' }] })), /no open pull requests/);
});
