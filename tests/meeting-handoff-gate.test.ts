import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoffGate } from '../src/client/ui/handoffgate.js';

test('a second hand-off is refused while one is under way, and allowed once it ends', () => {
  const gate = handoffGate();
  const first = gate.begin(() => true);
  assert.ok(first);
  assert.equal(gate.begin(() => true), undefined); // a double press opens no second dialog
  first.end();
  const next = gate.begin(() => true);
  assert.ok(next);
  next.end();
});

test('a hand-off whose window was closed (or whose floor changed) meanwhile may not go on', () => {
  const gate = handoffGate();
  let open = true;
  const run = gate.begin(() => open)!;
  assert.equal(run.ok(), true);
  open = false; // Esc on the meeting window while the archive answers
  assert.equal(run.ok(), false);
  run.end();
  assert.ok(gate.begin(() => true), 'a dropped hand-off frees the gate');
});

test('an ended hand-off is never ok again, and ending twice frees the gate once', () => {
  const gate = handoffGate();
  const run = gate.begin(() => true)!;
  run.end();
  assert.equal(run.ok(), false);
  const other = gate.begin(() => true)!;
  run.end(); // the old run's second end must not free the gate under the new one
  assert.equal(gate.begin(() => true), undefined);
  other.end();
});
