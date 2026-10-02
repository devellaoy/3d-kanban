// Chat speech bubbles stay 4 to 10 seconds, longer for longer lines (docs/features.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleSeconds } from '../src/client/world/character/speech.js';

test('a speech bubble stays 4 to 10 seconds, longer for longer lines', () => {
  assert.equal(bubbleSeconds(''), 4);
  assert.equal(bubbleSeconds('hi'), 4.12);
  assert.ok(bubbleSeconds('x'.repeat(50)) > bubbleSeconds('x'.repeat(10)));
  assert.equal(bubbleSeconds('x'.repeat(500)), 10);
});
