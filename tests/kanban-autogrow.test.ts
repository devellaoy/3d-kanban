// 3d-kanban (#498): the comment box grows with its text, up to the room its pane has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoGrow, grownHeight } from '../src/client/kanban/autogrow.js';

test('a box is as tall as its text, from its minimum up to the cap', () => {
  assert.deepEqual(grownHeight(40, 78, 500), { height: 78, scroll: false }, 'less text than the minimum');
  assert.deepEqual(grownHeight(78, 78, 500), { height: 78, scroll: false });
  assert.deepEqual(grownHeight(215, 78, 500), { height: 215, scroll: false }, 'between the two it follows the text');
  assert.deepEqual(grownHeight(500, 78, 500), { height: 500, scroll: false }, 'text that just fits does not scroll');
});

test('text taller than the cap stops there and scrolls inside', () => {
  assert.deepEqual(grownHeight(1190, 78, 500), { height: 500, scroll: true });
  assert.deepEqual(grownHeight(501, 78, 500), { height: 500, scroll: true });
});

test('a cap under the minimum gives way to it', () => {
  assert.deepEqual(grownHeight(40, 78, 30), { height: 78, scroll: false });
  assert.deepEqual(grownHeight(78, 78, -200), { height: 78, scroll: false });
  assert.deepEqual(grownHeight(300, 78, 30), { height: 78, scroll: true });
});

test('without a DOM, a box off the page is left as it is', () => {
  const heard: string[] = [];
  const style: Record<string, string> = {};
  const ta = { isConnected: false, clientWidth: 0, style, addEventListener: (type: string) => heard.push(type) } as unknown as HTMLTextAreaElement;
  const fit = autoGrow(ta);
  assert.deepEqual(heard, ['input'], 'typing fits it');
  assert.doesNotThrow(fit);
  assert.deepEqual(style, {}, 'nothing measured, nothing set');
});
