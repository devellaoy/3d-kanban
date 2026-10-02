import test from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from '../src/client/ui/dom.js';
import { columnName, effortName, fmtDuration, phaseName, toolName, waitingName } from '../src/client/kanban/labels.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, RUN_PHASES, TASK_STATUSES, WAITING_REASONS } from '../src/shared/kanban/types.js';

test('every column, phase, agent, effort and waiting reason has a name', () => {
  for (const s of TASK_STATUSES) assert.ok(columnName(s)?.trim(), s);
  for (const p of RUN_PHASES) assert.ok(phaseName(p)?.trim(), p);
  for (const x of KANBAN_TOOLS) assert.ok(toolName(x)?.trim(), x);
  for (const e of KANBAN_EFFORTS) assert.ok(effortName(e)?.trim(), e);
  for (const w of WAITING_REASONS) assert.ok(waitingName(w)?.trim(), w);
  assert.equal(columnName('todo'), 'To do');
  assert.equal(phaseName('pr-fix'), 'PR fix');
  assert.equal(phaseName('something-new'), 'something-new', 'an unknown phase shows as it is');
});

test('durations and times ago read in English', () => {
  assert.equal(fmtDuration(45_000), '45 s');
  assert.equal(fmtDuration(12 * 60_000), '12 min');
  assert.equal(fmtDuration(65 * 60_000), '1 h 05 min');
  const now = Date.UTC(2026, 8, 30, 12);
  assert.equal(timeAgo(now - 5 * 60_000, now), '5m ago');
});

test('On hold is a column between Review and Done', async () => {
  const { BOARD_COLUMNS } = await import('../src/shared/kanban/types.js');
  assert.equal(columnName('on_hold'), 'On hold');
  assert.deepEqual(BOARD_COLUMNS.slice(2, 5), ['waiting', 'review', 'on_hold']);
  assert.equal(BOARD_COLUMNS[5], 'done');
});
