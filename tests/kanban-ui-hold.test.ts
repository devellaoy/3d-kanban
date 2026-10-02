import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInputValue, dayStartMs, holdPassed } from '../src/client/kanban/holdtime.js';

test('dayStartMs: the start of the local day a date input names', () => {
  const ms = dayStartMs('2026-11-15');
  assert.ok(ms !== undefined);
  const d = new Date(ms);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 15, 0, 0]);
});

test('dayStartMs: empty, malformed and impossible dates are nothing', () => {
  for (const v of ['', 'tomorrow', '2026-1-5', '2026-02-31', '2026-13-01']) assert.equal(dayStartMs(v), undefined, v);
});

test('dateInputValue and dayStartMs round-trip', () => {
  assert.equal(dateInputValue(dayStartMs('2027-03-09')!), '2027-03-09');
  assert.equal(dateInputValue(new Date(2026, 0, 5, 18, 30).getTime()), '2026-01-05');
});

test('holdPassed: only once the day has begun to be behind us', () => {
  const day = dayStartMs('2026-11-15')!;
  assert.equal(holdPassed(undefined, day), false);
  assert.equal(holdPassed(day, day), false);
  assert.equal(holdPassed(day, day + 1), true);
});
