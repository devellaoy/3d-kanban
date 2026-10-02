import test from 'node:test';
import assert from 'node:assert/strict';
import { refocusIndex } from '../src/client/phone/refocus.js';

test('phone refocus: the focused worker keeps the focus when the list reorders', () => {
  // B was second and focused; it starts waiting and byUrgency puts it first.
  assert.equal(refocusIndex('worker:B', 1, ['worker:B', 'worker:A']), 0);
  // and A, focused at the top, follows itself down.
  assert.equal(refocusIndex('worker:A', 0, ['worker:B', 'worker:A']), 1);
});

test('phone refocus: a worker that went home leaves the focus at its old place', () => {
  assert.equal(refocusIndex('worker:B', 1, ['worker:A', 'worker:C']), 1);
  assert.equal(refocusIndex('worker:C', 2, ['worker:A']), 0);
});

test('phone refocus: nothing to focus', () => {
  assert.equal(refocusIndex(undefined, -1, ['worker:A']), -1);
  assert.equal(refocusIndex('worker:A', 0, []), -1);
});

test('phone refocus: floor rows are known by their floor', () => {
  assert.equal(refocusIndex('floor:f2', 0, ['floor:f3', 'floor:f2', 'floor:f1']), 1);
});
