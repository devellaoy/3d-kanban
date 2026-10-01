// 3d-kanban (#328): one send key in every prompt box.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMac, isSendKey, sendHint } from '../src/client/kanban/sendkey.js';

const key = (o: Record<string, unknown> = {}) => ({ key: 'Enter', isComposing: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o });

function globals(t: TestContext, values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test('plain Enter adds a line; Shift, ⌘ or Ctrl + Enter sends', () => {
  assert.equal(isSendKey(key()), false);
  assert.equal(isSendKey(key({ shiftKey: true })), true);
  assert.equal(isSendKey(key({ metaKey: true })), true);
  assert.equal(isSendKey(key({ ctrlKey: true })), true);
});

test('IME composition, Alt and other keys never send', () => {
  assert.equal(isSendKey(key({ shiftKey: true, isComposing: true })), false);
  assert.equal(isSendKey(key({ shiftKey: true, altKey: true })), false);
  assert.equal(isSendKey(key({ key: 'a', shiftKey: true })), false);
});

test('the hint names ⌘ on a Mac and Ctrl elsewhere', (t) => {
  globals(t, { navigator: { platform: 'MacIntel', userAgent: '' } });
  assert.equal(isMac(), true);
  assert.equal(sendHint(), '⇧/⌘ + Enter sends · Enter for a new line');
  globals(t, { navigator: { platform: 'Win32', userAgent: '' } });
  assert.equal(isMac(), false);
  assert.equal(sendHint(), 'Shift/Ctrl + Enter sends · Enter for a new line');
  globals(t, { navigator: { userAgentData: { platform: 'macOS' }, platform: 'Win32' } });
  assert.equal(isMac(), true);
});

test('without a navigator it is not a Mac', (t) => {
  globals(t, { navigator: undefined });
  assert.equal(isMac(), false);
  assert.match(sendHint(), /^Shift\/Ctrl/);
});

test('every prompt box uses the shared send key', () => {
  const files = ['ui/prompt.ts', 'ui/ask.ts', 'ui/queue.ts', 'ui/meeting.ts', 'ui/github/comment-box.ts', 'kanban/create.ts', 'kanban/taskview.ts'];
  for (const f of files) {
    const src = readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
    assert.match(src, /from '[./]*(?:kanban\/)?sendkey'/, `${f} imports sendkey`);
    assert.ok(!src.includes("e.key === 'Enter' && !e.shiftKey"), `${f}: plain Enter must not send`);
    assert.ok(!src.includes("e.key === 'Enter' && (e.metaKey || e.ctrlKey)"), `${f}: use isSendKey`);
  }
});
