import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodexLimits } from '../src/shared/codex-limits/protocol.js';

const NOW = 1_000_000_000_000;
const windows = [
  { label: '5-hour', pct: 42, resetsAt: NOW + 2 * 3_600_000 },
  { label: 'Weekly', pct: 91, resetsAt: NOW + 30 * 3_600_000 },
];
const state = (o: Partial<CodexLimits>): CodexLimits => ({ status: 'ready', windows, at: NOW, checkedAt: NOW, ...o });

test('the Codex chip: fresh numbers show the reset of the most used window', async () => {
  const { codexChipText } = await import('../src/client/kanban/codexlimits.js');
  const c = codexChipText(state({}), NOW);
  assert.match(c.text, /^5h 42% · week 91% · resets /);
  assert.equal(c.tone, 'over');
});

test('the Codex chip: stale numbers say when they were read and are dimmed', async () => {
  const { codexChipText } = await import('../src/client/kanban/codexlimits.js');
  const c = codexChipText(state({ at: NOW - 3_600_000 }), NOW);
  assert.match(c.text, /^5h 42% · week 91% · as of /);
  assert.ok(!c.text.includes('resets'));
  assert.ok(c.tone.split(' ').includes('old'));
  assert.match(c.title, /last read at/);
});

test('the Codex chip: a failed read keeps the last windows and says so', async () => {
  const { codexChipText } = await import('../src/client/kanban/codexlimits.js');
  const c = codexChipText(state({ status: 'error' }), NOW);
  assert.match(c.text, /as of .*\(couldn’t refresh\)$/);
  assert.ok(c.tone.split(' ').includes('old'));
  assert.match(c.title, /Couldn’t read the Codex limits just now/);
});

test('the Codex chip: without windows it says the state', async () => {
  const { codexChipText } = await import('../src/client/kanban/codexlimits.js');
  assert.equal(codexChipText(state({ status: 'error', windows: [], at: 0 }), NOW).text, 'Codex limits unavailable');
  assert.equal(codexChipText(state({ status: 'signedOut', windows: [] }), NOW).text, 'Codex not signed in');
  assert.equal(codexChipText(state({ status: 'signedOut' }), NOW).text, 'Codex not signed in');
  assert.equal(codexChipText(state({ status: 'checking', windows: [] }), NOW).text, 'checking…');
});
