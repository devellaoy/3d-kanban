// Chat speech bubbles: how long they stay (docs/features.md), and how they pop in and fade out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleFrame, bubbleSeconds } from '../src/client/world/character/speech.js';

test('a speech bubble stays 4 to 10 seconds, longer for longer lines', () => {
  assert.equal(bubbleSeconds(''), 4);
  assert.equal(bubbleSeconds('hi'), 4.12);
  assert.ok(bubbleSeconds('x'.repeat(50)) > bubbleSeconds('x'.repeat(10)));
  assert.equal(bubbleSeconds('x'.repeat(500)), 10);
});

test('a speech bubble pops in past full size, settles, fades at the end and then goes', () => {
  assert.deepEqual(bubbleFrame(0, 5), { scale: 0, opacity: 1, alive: true });
  assert.ok(Math.abs(bubbleFrame(0.12, 5).scale - 1.1) < 1e-9, 'a little past full size two-thirds into the pop');
  assert.equal(bubbleFrame(0.18, 5).scale, 1);
  assert.equal(bubbleFrame(3, 5).scale, 1);
  assert.equal(bubbleFrame(3, 5).opacity, 1);
  assert.ok(Math.abs(bubbleFrame(4.7, 5).opacity - 0.5) < 1e-9, 'half faded 0.3 s before the end');
  assert.equal(bubbleFrame(5, 5).alive, false);
  assert.equal(bubbleFrame(5, 5).opacity, 0);
});
