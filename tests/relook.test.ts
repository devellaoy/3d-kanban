import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relookOnArrival } from '../src/client/core/relook.js';

test('off a trip, the mouse is taken back at once and nothing is held', () => {
  const r = relookOnArrival();
  let locks = 0;
  r.takeBack(false, () => locks++);
  assert.equal(locks, 1);
  assert.equal(r.held, false);
});

test('on a trip, the mouse waits for the arrival', () => {
  const r = relookOnArrival();
  let locks = 0;
  r.takeBack(true, () => locks++);
  assert.equal(locks, 0);
  assert.equal(r.held, true);
});

test('arriving with the controls yours takes the mouse back once', () => {
  const r = relookOnArrival();
  let backs = 0;
  r.takeBack(true, () => {});
  r.arrived(true, () => backs++);
  assert.equal(backs, 1);
  assert.equal(r.held, false);
  r.arrived(true, () => backs++);
  assert.equal(backs, 1);
});

test('arriving with a window open does not take it, and lets it go', () => {
  const r = relookOnArrival();
  let backs = 0;
  r.takeBack(true, () => {});
  r.arrived(false, () => backs++);
  assert.equal(backs, 0);
  assert.equal(r.held, false);
  r.arrived(true, () => backs++);
  assert.equal(backs, 0);
});

test('dropping lets it go', () => {
  const r = relookOnArrival();
  let backs = 0;
  r.takeBack(true, () => {});
  r.drop();
  assert.equal(r.held, false);
  r.arrived(true, () => backs++);
  assert.equal(backs, 0);
});

test('arriving with nothing held takes nothing', () => {
  const r = relookOnArrival();
  let backs = 0;
  r.arrived(true, () => backs++);
  assert.equal(backs, 0);
});
