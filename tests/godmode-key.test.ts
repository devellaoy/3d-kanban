import test from 'node:test';
import assert from 'node:assert/strict';
import { isGodModeKey } from '../src/client/features/godmode/key.js';

const press = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

test('Ctrl+N and Alt+N toggle god mode', () => {
  assert.equal(isGodModeKey(press('KeyN', { ctrl: true })), true);
  assert.equal(isGodModeKey(press('KeyN', { alt: true })), true);
});

test('plain N, AltGr+N, Shift and ⌘ combinations and other keys do not', () => {
  assert.equal(isGodModeKey(press('KeyN')), false);
  assert.equal(isGodModeKey(press('KeyN', { ctrl: true, alt: true })), false);
  assert.equal(isGodModeKey(press('KeyN', { ctrl: true, shift: true })), false);
  assert.equal(isGodModeKey(press('KeyN', { meta: true })), false);
  assert.equal(isGodModeKey(press('KeyM', { ctrl: true })), false);
});
