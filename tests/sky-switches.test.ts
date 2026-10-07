import test from 'node:test';
import assert from 'node:assert/strict';
import { letIn, mayStrike } from '../src/client/world/skyswitches.js';

// A storm in full swing in the browser's sky, as it is just before someone flips a switch in ⚙️.
const storming = { rain: 1, storm: 1 };

test('with both switches on, a storm rains and strikes as it eases', () => {
  const on = { rain: true as const, lightning: true as const };
  assert.deepEqual(letIn(on, storming), storming);
  assert.equal(mayStrike(on, letIn(on, storming).storm), true);
  assert.equal(mayStrike(on, 0.4), false, 'not before the storm is well under way');
});

test('Lightning off mid-storm stops the strikes at once and leaves the rain', () => {
  const rainOnly = { rain: true as const };
  const now = letIn(rainOnly, storming);
  assert.deepEqual(now, { rain: 1, storm: 0 });
  assert.equal(mayStrike(rainOnly, now.storm), false);
  // Even a storm the browser still has in hand doesn't strike.
  assert.equal(mayStrike(rainOnly, 1), false);
});

test('Rain off mid-storm stops the rain and the strikes at once', () => {
  const now = letIn({}, storming);
  assert.deepEqual(now, { rain: 0, storm: 0 });
  assert.equal(mayStrike({}, now.storm), false);
});
