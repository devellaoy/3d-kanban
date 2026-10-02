import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardKey, keyAt, naturalKey, type TermKey } from '../src/client/ui/termkeys.js';

const key = (k: string, mods: Partial<Omit<TermKey, 'key'>> = {}): TermKey => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('Shift+Enter types a new line (Ctrl+J) instead of sending the prompt', () => {
  for (const mac of [true, false]) {
    assert.equal(naturalKey(key('Enter', { shiftKey: true }), mac), '\n');
    assert.equal(naturalKey(key('Enter'), mac), undefined, 'plain Enter still sends');
    assert.equal(naturalKey(key('Enter', { altKey: true }), mac), undefined, 'Option+Enter keeps its Esc Enter');
    assert.equal(naturalKey(key('Enter', { shiftKey: true, ctrlKey: true }), mac), undefined);
  }
});

test('Ctrl+Backspace deletes a word everywhere; ⌘⌫ deletes the line on a Mac', () => {
  assert.equal(naturalKey(key('Backspace', { ctrlKey: true }), true), '\x17');
  assert.equal(naturalKey(key('Backspace', { ctrlKey: true }), false), '\x17');
  assert.equal(naturalKey(key('Backspace', { metaKey: true }), true), '\x15');
  assert.equal(naturalKey(key('Backspace', { metaKey: true }), false), undefined, 'the Windows key is not ⌘');
  assert.equal(naturalKey(key('Backspace'), true), undefined);
  assert.equal(naturalKey(key('Backspace', { altKey: true }), true), undefined, '⌥⌫ already deletes a word as Esc ⌫');
});

test('⌘⌦ and ⌘← / ⌘→ edit and move by line on a Mac only', () => {
  assert.equal(naturalKey(key('Delete', { metaKey: true }), true), '\x0b');
  assert.equal(naturalKey(key('ArrowLeft', { metaKey: true }), true), '\x01');
  assert.equal(naturalKey(key('ArrowRight', { metaKey: true }), true), '\x05');
  for (const k of ['Delete', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(naturalKey(key(k, { metaKey: true }), false), undefined);
    assert.equal(naturalKey(key(k, { metaKey: true, shiftKey: true }), true), undefined);
    assert.equal(naturalKey(key(k), true), undefined);
  }
});

test('ordinary keys are left to xterm', () => {
  for (const k of ['a', 'Tab', 'Escape', 'ArrowUp', 'Home']) {
    assert.equal(naturalKey(key(k), true), undefined);
    assert.equal(naturalKey(key(k, { metaKey: true }), true), undefined);
    assert.equal(naturalKey(key(k, { ctrlKey: true }), false), undefined);
  }
});

const ck = (k: string, mods: Partial<Omit<TermKey, 'key'>> = {}, code = `Key${k.toUpperCase()}`) => ({ ...key(k, mods), code });

test('Ctrl+C copies a selection and otherwise interrupts, off a Mac', () => {
  assert.equal(clipboardKey(ck('c', { ctrlKey: true }), true, false), 'copy');
  assert.equal(clipboardKey(ck('c', { ctrlKey: true }), false, false), undefined, 'no selection: ^C still interrupts');
  assert.equal(clipboardKey(ck('C', { ctrlKey: true, shiftKey: true }), true, false), 'copy');
  assert.equal(clipboardKey(ck('C', { ctrlKey: true, shiftKey: true }), false, false), undefined, 'Ctrl+Shift+C with no selection interrupts too');
  assert.equal(clipboardKey(ck('c', { ctrlKey: true, metaKey: true }), true, false), undefined, 'Ctrl+Win+C is not a copy');
  assert.equal(clipboardKey(ck('c'), true, false), undefined, 'a plain c types');
  assert.equal(clipboardKey(ck('c', { ctrlKey: true, altKey: true }), true, false), undefined, 'AltGr is Ctrl+Alt');
});

test('Ctrl+V and Ctrl+Shift+V paste off a Mac, also on a layout with other letters', () => {
  assert.equal(clipboardKey(ck('v', { ctrlKey: true }), false, false), 'paste');
  assert.equal(clipboardKey(ck('V', { ctrlKey: true, shiftKey: true }), false, false), 'paste');
  assert.equal(clipboardKey(ck('м', { ctrlKey: true }, 'KeyV'), false, false), 'paste', 'Russian layout');
  assert.equal(clipboardKey(ck('с', { ctrlKey: true }, 'KeyC'), true, false), 'copy');
  assert.equal(clipboardKey(ck('v', { ctrlKey: true }, 'KeyB'), false, false), 'paste', 'by the letter on Dvorak-like layouts');
  assert.equal(clipboardKey(ck('и', { ctrlKey: true }, 'KeyB'), true, false), undefined, 'neither the letter nor the place');
  assert.equal(clipboardKey(ck('k', { ctrlKey: true }, 'KeyV'), false, false), undefined, "V's place typing another ASCII letter is that letter");
});

test('nothing changes on a Mac: ⌘C / ⌘V are the browser\'s, Ctrl+C interrupts', () => {
  assert.equal(clipboardKey(ck('c', { ctrlKey: true }), true, true), undefined);
  assert.equal(clipboardKey(ck('v', { ctrlKey: true }), false, true), undefined);
  assert.equal(clipboardKey(ck('c', { metaKey: true }), true, true), undefined);
});

test('keyAt matches a key by what it types, or by its place when that types no ASCII', () => {
  assert.equal(keyAt({ key: '[', code: 'Digit8' }, '[', 'BracketLeft'), true, 'AltGr+8 on a Finnish keyboard');
  assert.equal(keyAt({ key: 'ü', code: 'BracketLeft' }, '[', 'BracketLeft'), true, "German ü in ['s place");
  assert.equal(keyAt({ key: '+', code: 'BracketRight' }, ']', 'BracketRight'), false, 'German + zooms in');
  assert.equal(keyAt({ key: 'C', code: 'KeyC' }, 'c', 'KeyC'), true, 'with Shift');
});
