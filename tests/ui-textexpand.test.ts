// The large editor's pure half (ui/textexpandmodel.ts): which fields get the button, the editor's title,
// where the button sits, what the big box adopts and the key that opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adopt, buttonPlace, expandable, fieldName, isExpandKey, BTN_INSET, BTN_SIZE, MIN_FIELD_H, MIN_FIELD_W, type FieldInfo,
} from '../src/client/ui/textexpandmodel.js';
import { isSendKey } from '../src/client/kanban/sendkey.js';

const field = (o: Partial<FieldInfo> = {}): FieldInfo => ({
  inEditor: false, foreign: false, disabled: false, readOnly: false, optedOut: false, width: 300, height: 100, ...o,
});

test('an ordinary text box gets the button', () => {
  assert.equal(expandable(field()), true);
});

test('a box inside a foreign editor gets none', () => {
  assert.equal(expandable(field({ foreign: true })), false);
});

test('a disabled box gets none', () => {
  assert.equal(expandable(field({ disabled: true })), false);
});

test('a read-only box gets none', () => {
  assert.equal(expandable(field({ readOnly: true })), false);
});

test('a box marked data-no-expand gets none', () => {
  assert.equal(expandable(field({ optedOut: true })), false);
});

test('the large editor\'s own box gets none', () => {
  assert.equal(expandable(field({ inEditor: true })), false);
});

test('a box too narrow or too low gets none', () => {
  assert.equal(expandable(field({ width: MIN_FIELD_W - 1 })), false);
  assert.equal(expandable(field({ height: MIN_FIELD_H - 1 })), false);
});

test('a box exactly at the minimums gets the button', () => {
  assert.equal(expandable(field({ width: MIN_FIELD_W, height: MIN_FIELD_H })), true);
});

test('the title is the aria-label first', () => {
  assert.equal(fieldName({ ariaLabel: 'Comment', label: 'Other', placeholder: 'Write' }), 'Comment');
});

test('the title is the label text when there is no aria-label', () => {
  assert.equal(fieldName({ ariaLabel: '  ', label: 'Description', placeholder: 'Write' }), 'Description');
  assert.equal(fieldName({ ariaLabel: null, label: 'Notes' }), 'Notes');
});

test('the title is the start of the placeholder when there is no label', () => {
  assert.equal(fieldName({ placeholder: 'What should it do? Markdown works.' }), 'What should it do');
  assert.equal(fieldName({ placeholder: 'Describe it. More words' }), 'Describe it');
  assert.equal(fieldName({ placeholder: 'Reply to the agent\nsecond line' }), 'Reply to the agent');
  assert.equal(fieldName({ placeholder: 'Note: something' }), 'Note');
});

test('the title is Text when nothing names the box', () => {
  assert.equal(fieldName({}), 'Text');
  assert.equal(fieldName({ ariaLabel: '', label: ' ', placeholder: '. only a stop' }), 'Text');
});

test('whitespace in the title is collapsed', () => {
  assert.equal(fieldName({ label: '  Task \n  description\t here ' }), 'Task description here');
});

test('a title longer than 60 characters is cut with an ellipsis', () => {
  const long = fieldName({ ariaLabel: 'a'.repeat(80) });
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal(fieldName({ ariaLabel: 'a'.repeat(60) }), 'a'.repeat(60));
});

test('the button sits in the top right corner, inset', () => {
  assert.deepEqual(buttonPlace({ top: 100, right: 500 }, 0), { left: 500 - BTN_INSET - BTN_SIZE, top: 100 + BTN_INSET });
});

test('the button moves left of a scrollbar', () => {
  assert.deepEqual(buttonPlace({ top: 100, right: 500 }, 15), { left: 500 - 15 - BTN_INSET - BTN_SIZE, top: 100 + BTN_INSET });
});

test('a negative scrollbar counts as none, and the place is whole pixels', () => {
  assert.deepEqual(buttonPlace({ top: 10.4, right: 200.6 }, -5), { left: Math.round(200.6 - BTN_INSET - BTN_SIZE), top: Math.round(10.4 + BTN_INSET) });
});

test('the big box keeps the field\'s selection', () => {
  assert.deepEqual(adopt('hello world', [2, 7]), { value: 'hello world', start: 2, end: 7 });
});

test('a selection past the text is clamped to it', () => {
  assert.deepEqual(adopt('abc', [1, 99]), { value: 'abc', start: 1, end: 3 });
  assert.deepEqual(adopt('abc', [50, 99]), { value: 'abc', start: 3, end: 3 });
  assert.deepEqual(adopt('abc', [-4, 2]), { value: 'abc', start: 0, end: 2 });
});

test('a missing selection is the end of the text', () => {
  assert.deepEqual(adopt('abc', [null, null]), { value: 'abc', start: 3, end: 3 });
  assert.deepEqual(adopt('abc', [1, null]), { value: 'abc', start: 1, end: 3 });
});

test('a selection start after its end is pulled back to the end', () => {
  assert.deepEqual(adopt('abcdef', [5, 2]), { value: 'abcdef', start: 2, end: 2 });
});

const key = (o: Partial<Parameters<typeof isExpandKey>[0]> = {}) => ({
  key: 'Enter', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...o,
});

test('Alt+Enter opens the editor', () => {
  assert.equal(isExpandKey(key()), true);
});

test('other keys and chords do not', () => {
  assert.equal(isExpandKey(key({ altKey: false, ctrlKey: true })), false);
  assert.equal(isExpandKey(key({ shiftKey: true })), false);
  assert.equal(isExpandKey(key({ ctrlKey: true })), false);
  assert.equal(isExpandKey(key({ metaKey: true })), false);
  assert.equal(isExpandKey(key({ isComposing: true })), false);
  assert.equal(isExpandKey(key({ key: 'a' })), false);
  assert.equal(isExpandKey(key({ altKey: false })), false);
});

test('the send key is never Alt+Enter, so the two keys do not collide', () => {
  assert.equal(isSendKey({ key: 'Enter', isComposing: false, metaKey: false, ctrlKey: false, altKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', isComposing: false, metaKey: false, ctrlKey: true, altKey: true }), false);
});
