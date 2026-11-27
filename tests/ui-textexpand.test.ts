// The large editor's pure half (ui/textexpandmodel.ts): which fields get the button, the editor's title,
// where the button sits, what the big box adopts and the key that opens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adopt, buttonPlace, editorState, expandable, fieldName, isExpandKey, keptOnClose, mayWrite, replacement, BTN_INSET, BTN_SIZE, MIN_FIELD_H, MIN_FIELD_W, type FieldInfo, type SyncFacts,
} from '../src/client/ui/textexpandmodel.js';
import { commentFocus } from '../src/client/kanban/issueactionsmodel.js';
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

test('the project changed under the open editor: another project\'s look-alike field (no key, no view) is not taken', () => {
  assert.equal(replacement({ key: null, home: null }, [{ key: null, home: null }, { key: null, home: null }]), -1);
  assert.equal(replacement({ key: null, home: null }, [{ key: 'prompt', home: {} }]), -1);
});

test('another task\'s comment box (same key, another view) is not taken', () => {
  assert.equal(replacement({ key: 'comment', home: {} }, [{ key: 'comment', home: {} }]), -1);
});

test('the same key in the same view is the replacement', () => {
  const home = {};
  assert.equal(replacement({ key: 'comment', home }, [{ key: 'other', home }, { key: 'comment', home }]), 1);
});

test('two boxes with the key in the view give no replacement', () => {
  const home = {};
  assert.equal(replacement({ key: 'comment', home }, [{ key: 'comment', home }, { key: 'comment', home }]), -1);
});

test('a field with a key but no view is never replaced', () => {
  assert.equal(replacement({ key: 'comment', home: null }, [{ key: 'comment', home: null }, { key: 'comment', home: {} }]), -1);
});

test('candidates with other keys are ignored', () => {
  const home = {};
  assert.equal(replacement({ key: 'a', home }, [{ key: 'b', home }, { key: null, home }]), -1);
  assert.equal(replacement({ key: 'a', home }, [{ key: 'b', home }, { key: 'a', home }, { key: 'c', home }]), 1);
});

const facts = (o: Partial<SyncFacts> = {}): SyncFacts => ({ connected: true, ownerThere: true, locked: false, held: false, fieldChanged: false, ...o });

test('the task was linked to another issue under the open editor: the other issue\'s comment box is not taken', () => {
  const home = {};
  const A = { key: 'UYT-1' };
  const B = { key: 'UYT-2' };
  assert.equal(replacement({ key: commentFocus(A), home }, [{ key: commentFocus(B), home }]), -1);
  assert.equal(replacement({ key: commentFocus(A), home }, [{ key: commentFocus(A), home }]), 0);
});

test('editorState: a field that is gone while its window is there is orphaned', () => {
  assert.equal(editorState(facts({ connected: false })), 'orphaned');
  assert.equal(editorState(facts({ connected: false, locked: true })), 'orphaned');
});

test('editorState: a field that is gone with its window is not orphaned', () => {
  assert.equal(editorState(facts({ connected: false, ownerThere: false })), 'normal');
});

test('editorState: a locked field is locked, also with held text and a changed field', () => {
  assert.equal(editorState(facts({ locked: true })), 'locked');
  assert.equal(editorState(facts({ locked: true, held: true, fieldChanged: true })), 'locked');
});

test('held text and a field that changed while it was locked: the editor stays read-only with its warning', () => {
  assert.equal(editorState(facts({ held: true, fieldChanged: true })), 'conflict');
});

test('editorState: held text with an unchanged field, or a changed field with nothing held, is normal', () => {
  assert.equal(editorState(facts({ held: true })), 'normal');
  assert.equal(editorState(facts({ fieldChanged: true })), 'normal');
});

test('typing on in that state does not write over the field\'s new text', () => {
  assert.equal(mayWrite(facts({ held: true, fieldChanged: true })), false);
  assert.equal(mayWrite(facts({ held: true })), true);
  assert.equal(mayWrite(facts()), true);
  assert.equal(mayWrite(facts({ locked: true })), false);
  assert.equal(mayWrite(facts({ connected: false })), false);
});

test('closing in that state keeps the text in its own window', () => {
  assert.equal(keptOnClose(facts({ held: true, fieldChanged: true }), 'mine', 'old'), 'conflict');
});

test('closing keeps text of a gone field that was edited, or that was held', () => {
  assert.equal(keptOnClose(facts({ connected: false }), 'edited', 'old'), 'orphaned');
  assert.equal(keptOnClose(facts({ connected: false, held: true }), 'old', 'old'), 'orphaned');
});

test('closing keeps nothing of a gone field whose text is as it was opened', () => {
  assert.equal(keptOnClose(facts({ connected: false }), 'old', 'old'), null);
});

test('closing keeps the text held for a locked field', () => {
  assert.equal(keptOnClose(facts({ locked: true, held: true }), 'mine', 'old'), 'locked');
});

test('closing keeps nothing when the field has the text, its window is gone or the text is blank', () => {
  assert.equal(keptOnClose(facts(), 'mine', 'old'), null);
  assert.equal(keptOnClose(facts({ locked: true }), 'mine', 'old'), null);
  assert.equal(keptOnClose(facts({ connected: false, ownerThere: false }), 'mine', 'old'), null);
  assert.equal(keptOnClose(facts({ held: true, locked: true }), '  \n', 'old'), null);
});

// The wiring of the rules above, read from the source: the editor's DOM half has no test page to run in.
const source = (f: string) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');

test('the issue comment box is named after its issue, not by a name every issue shares', () => {
  const src = source('kanban/issueactions.ts');
  assert.match(src, /'data-focus': commentFocus\(issue\)/);
  assert.doesNotMatch(src, /'data-focus': 'issue-comment'/);
});

test('the editor writes into the field in one place, and only where the model lets it', () => {
  const src = source('ui/textexpand.ts');
  assert.equal(src.match(/dispatchEvent\(new Event\('input'/g)?.length, 1, 'one place dispatches input on the field');
  // Every caller of write() has asked the model first.
  // Every caller of write() has asked the model first: on its own line, or (push) in the guard just above it.
  const lines = src.split('\n');
  const callers = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\bwrite\(\);/.test(l));
  assert.ok(callers.length >= 3);
  for (const { l, i } of callers) assert.match(/^\s*write\(\);$/.test(l) ? lines.slice(i - 5, i).join('\n') : l, /takesHeld\(\)|mayWrite\(facts\(\)\)/, `line ${i + 1}`);
  assert.match(src, /if \(!mayWrite\(facts\(\)\)\) return false;/, 'files are not handed to a field that may not be written');
  assert.match(src, /big\.readOnly = next !== 'normal'/, 'the editor is read-only in every state but the normal one');
});

test('closing asks the model whether the text must be kept before it touches the field', () => {
  const src = source('ui/textexpand.ts');
  const close = src.slice(src.indexOf('onClose: () => {'));
  assert.ok(close.indexOf('keptOnClose(facts(), big.value, opened)') > 0);
  assert.ok(close.indexOf('keptOnClose(') < close.indexOf('field.focus('), 'the kept text is decided before the focus goes back');
  // Nothing is copied but by the Copy text button's own press.
  assert.equal(src.split('clipboard.writeText(').length - 1, 1);
  const copy = src.slice(src.indexOf('function copyButton('), src.indexOf('function keepText('));
  assert.ok(copy.indexOf("addEventListener('click'") > 0 && copy.indexOf("addEventListener('click'") < copy.indexOf('clipboard.writeText('));
});
