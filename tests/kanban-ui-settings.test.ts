// The kanban's categories in ⚙️ Settings, without the DOM (settingsflow.ts): when the panes redraw as
// the office's settings come in, and that a pane's listeners go when it's drawn again or the window shuts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Cleanups, Listeners, settingsRedraw } from '../src/client/kanban/settingsflow.js';

test('a page without a board redraws every pane from the first settings after opening, even with a copy kept from before', () => {
  // The 3D office opened Settings before: kstore still holds what was saved then (say archive after 30 days).
  const redraw = settingsRedraw(true, true);
  // The snapshot of this opening (someone set 7 meanwhile) must redraw the forms, not only the secrets.
  assert.equal(redraw(), 'all');
  // Later changes keep what you typed and only say what's configured.
  assert.equal(redraw(), 'secrets');
  assert.equal(redraw(), 'secrets');
});

test('without a copy yet, the first settings draw everything, on any page', () => {
  for (const own of [true, false]) {
    const redraw = settingsRedraw(own, false);
    assert.equal(redraw(), 'all');
    assert.equal(redraw(), 'secrets');
  }
});

test('the kanban page, whose board keeps its copy current, redraws only the secrets', () => {
  const redraw = settingsRedraw(false, true);
  assert.equal(redraw(), 'secrets');
});

test('removing a listener removes that one, and cleanups take them all down once', () => {
  const painters = new Listeners();
  const calls: string[] = [];
  const cleanups = new Cleanups();
  const paint = () => calls.push('a');
  cleanups.add(painters.add(paint));
  cleanups.add(painters.add(() => calls.push('b')));
  // The same function added again (a pane drawn twice) is a listener of its own.
  const again = painters.add(paint);
  assert.equal(painters.size, 3);
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'a']);
  again();
  assert.equal(painters.size, 2);
  cleanups.run();
  assert.equal(painters.size, 0);
  assert.equal(cleanups.size, 0);
  // Running again does nothing more.
  cleanups.run();
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'a']);
});

test('a listener removed while the others are being called is not called', () => {
  const painters = new Listeners();
  const calls: string[] = [];
  let stopB = () => {};
  painters.add(() => {
    calls.push('a');
    stopB();
  });
  stopB = painters.add(() => calls.push('b'));
  painters.call();
  // Called from a snapshot of the set: b was still in it.
  assert.deepEqual(calls, ['a', 'b']);
  painters.call();
  assert.deepEqual(calls, ['a', 'b', 'a']);
});
