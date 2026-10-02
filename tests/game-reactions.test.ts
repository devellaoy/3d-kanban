import test from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_LIFE_MS, badgeText, MAX_BADGES, REACTIONS, ReactionStack, STACK_WINDOW_MS } from '../src/client/features/reactions/stack.js';

test('the same reaction within the window stacks into one badge', () => {
  const s = new ReactionStack();
  const a = s.add('👏', 0);
  assert.ok(a.fresh);
  const b = s.add('👏', 500);
  assert.ok(!b.fresh);
  assert.equal(b.badge.id, a.badge.id);
  assert.equal(b.badge.count, 2);
  assert.equal(s.active(600).length, 1);
});

test('the window counts from the latest reaction, so a steady clapper keeps one badge', () => {
  const s = new ReactionStack();
  for (let t = 0; t <= 5000; t += 1000) s.add('👏', t);
  assert.equal(s.active(5000).length, 1);
  assert.equal(s.active(5000)[0].count, 6);
});

test('after the window a new press starts a new badge', () => {
  const s = new ReactionStack();
  s.add('🎉', 0);
  const b = s.add('🎉', STACK_WINDOW_MS + 1);
  assert.ok(b.fresh);
  assert.equal(b.badge.count, 1);
  assert.equal(s.active(STACK_WINDOW_MS + 1).length, 2);
});

test('different reactions keep their own badges', () => {
  const s = new ReactionStack();
  s.add('👏', 0);
  s.add('😂', 100);
  s.add('👏', 200);
  const counts = Object.fromEntries(s.active(200).map((b) => [b.emoji, b.count]));
  assert.deepEqual(counts, { '👏': 2, '😂': 1 });
});

test('badges float away after their life, and never pile past the cap', () => {
  const s = new ReactionStack();
  s.add('❤️', 0);
  assert.equal(s.active(BADGE_LIFE_MS - 1).length, 1);
  assert.equal(s.active(BADGE_LIFE_MS).length, 0);
  const t = new ReactionStack();
  for (let i = 0; i < MAX_BADGES + 3; i++) t.add(`e${i}`, i);
  assert.equal(t.active(10).length, MAX_BADGES);
});

test('the badge says the count once there is more than one; progress runs 0 to 1', () => {
  assert.equal(badgeText({ emoji: '👏', count: 1 }), '👏');
  assert.equal(badgeText({ emoji: '👏', count: 5 }), '👏 ×5');
  const s = new ReactionStack();
  const { badge } = s.add('👏', 1000);
  assert.equal(ReactionStack.progress(badge, 1000), 0);
  assert.equal(ReactionStack.progress(badge, 1000 + BADGE_LIFE_MS * 2), 1);
});

test('the four reactions sit on the keys after the emotes (7, 8, 9, 0)', () => {
  assert.deepEqual(
    REACTIONS.map((r) => r.code),
    ['Digit7', 'Digit8', 'Digit9', 'Digit0'],
  );
});

test('Shift+7 (a "/" on a Finnish or German keyboard) still reaches the search; 7 itself reacts', async () => {
  const { Keys } = await import('../src/client/core/registry.js');
  const { readFileSync } = await import('node:fs');
  // The feature binds each reaction by the character (key), never by the code, which would own the key outright.
  const src = readFileSync(new URL('../src/client/features/reactions/index.ts', import.meta.url), 'utf8');
  assert.ok(/key: r\.key/.test(src) && !/code: r\.code/.test(src));
  const keys = new Keys();
  const got: string[] = [];
  for (const r of REACTIONS) keys.bind({ key: r.key, repeat: false, run: () => void got.push(r.emoji) });
  keys.bind({ key: '/', run: () => void got.push('search') });
  const press = (code: string, key: string) => keys.handle({ code, key, repeat: false, preventDefault() {} });
  press('Digit7', '/');
  press('Digit7', '7');
  press('Digit0', '0');
  assert.deepEqual(got, ['search', '👏', '😂']);
});
