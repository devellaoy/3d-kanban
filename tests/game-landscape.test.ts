import test from 'node:test';
import assert from 'node:assert/strict';
import { SEASONS, foliageLook, mixHex, seasonFromQuery, seasonOf, seasonOfMonth, snowCover } from '../src/shared/season.js';
import { wander } from '../src/server/sky.js';
import { Embers, Fire, flicker } from '../src/client/features/camp/fire.js';
import { PLANTERS, THIRSTY_MS, WATER_GAP_MS, canWater, choreAt, doChore, emptyPlanter, sanitizePlanter, stageOf, thirsty } from '../src/client/features/garden/model.js';
import { GARDEN_KEY, loadGarden, saveGarden } from '../src/client/features/garden/storage.js';

test('the seasons follow the calendar, and the southern hemisphere has the other half of the year', () => {
  const north = Array.from({ length: 12 }, (_, m) => seasonOfMonth(m));
  assert.deepEqual(north, ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter']);
  assert.equal(seasonOfMonth(0, true), 'summer');
  assert.equal(seasonOfMonth(6, true), 'winter');
  assert.equal(seasonOf(new Date(2026, 9, 1)), 'autumn');
  assert.equal(seasonOf(new Date(2026, 9, 1), true), 'spring');
});

test('the server draws its made-up weather from the same seasons: snow only in winter', () => {
  for (let i = 0; i < 300; i++) {
    for (const m of [2, 5, 8]) assert.notEqual(wander(null, m, false).weather, 'snow');
  }
  let snowed = false;
  for (let i = 0; i < 300 && !snowed; i++) snowed = wander(null, 0, false).weather === 'snow';
  assert.ok(snowed);
  // …and in the southern hemisphere it is July's turn.
  let southern = false;
  for (let i = 0; i < 300 && !southern; i++) southern = wander(null, 6, true).weather === 'snow';
  assert.ok(southern);
});

test('a season in the URL is read, and anything else is not', () => {
  assert.equal(seasonFromQuery('?season=autumn'), 'autumn');
  assert.equal(seasonFromQuery('?x=1&season=WINTER'), 'winter');
  assert.equal(seasonFromQuery('?season=monsoon'), null);
  assert.equal(seasonFromQuery(''), null);
});

test('leafy trees blossom, turn and go bare; pines stay green; snow lies only in winter', () => {
  const colors = SEASONS.map((s) => foliageLook('leaf', 0, s, '#5fb760'));
  assert.deepEqual(colors.map((c) => c.bare), [true, false, false, false]);
  assert.equal(foliageLook('leaf', 0, 'summer', '#5fb760').color, '#5fb760');
  assert.notEqual(foliageLook('leaf', 0, 'spring', '#5fb760').color, foliageLook('leaf', 0, 'autumn', '#5fb760').color);
  for (const s of SEASONS) {
    assert.equal(foliageLook('pine', 0, s, '#2d6a4f').bare, false);
    assert.match(foliageLook('grass', 0, s, '#a7d98b').color, /^#[0-9a-f]{6}$/);
  }
  assert.deepEqual(SEASONS.map(snowCover).map((c) => c > 0), [true, false, false, false]);
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

test('the campfire flickers around its normal brightness, flares when stoked and settles', () => {
  for (let t = 0; t < 30; t += 0.37) assert.ok(flicker(t) > 0.7 && flicker(t) < 1.3);
  const fire = new Fire();
  assert.equal(fire.height, 1);
  fire.stoke();
  assert.ok(fire.height > 1.6 && fire.glow(0) > flicker(0));
  fire.update(10);
  assert.equal(fire.flare, 0);
  assert.equal(fire.height, 1);
});

test('embers rise and start over at the fire', () => {
  let n = 0;
  const rand = () => ((n = (n * 9301 + 49297) % 233280) || 1) / 233280;
  const embers = new Embers(20, rand);
  const before = Array.from(embers.pos);
  embers.update(0.5);
  assert.notDeepEqual(Array.from(embers.pos), before);
  for (let i = 0; i < 200; i++) embers.update(0.1);
  for (let i = 0; i < embers.count; i++) {
    assert.ok(embers.pos[i * 3 + 1] < 6, 'an ember has not gone out and been reborn');
    assert.ok(embers.fade(i) >= 0 && embers.fade(i) <= 1);
  }
});

test('a planter is sown, watered no more than once in a while, grows by stages, and is picked', () => {
  let p = emptyPlanter();
  const t0 = 1_000_000;
  assert.equal(stageOf(p), 'empty');
  assert.equal(choreAt(p, t0), 'sow');
  p = doChore(p, t0);
  assert.equal(stageOf(p), 'seed');
  // Watering right away doesn't count.
  assert.equal(canWater(p, t0 + 1000), false);
  assert.equal(doChore(p, t0 + 1000), p);
  const stages = [];
  let now = t0;
  for (let i = 0; i < 8; i++) {
    now += WATER_GAP_MS;
    assert.equal(choreAt(p, now), 'water');
    p = doChore(p, now);
    stages.push(stageOf(p));
  }
  assert.deepEqual(stages, ['sprout', 'sprout', 'leafy', 'leafy', 'budding', 'budding', 'budding', 'bloom']);
  assert.equal(choreAt(p, now + WATER_GAP_MS), 'pick');
  p = doChore(p, now + WATER_GAP_MS);
  assert.deepEqual(p, { sown: null, watered: [], picked: 1 });
});

test('a plant droops when it has gone without water, and drinks again', () => {
  let p = doChore(emptyPlanter(), 0);
  assert.equal(thirsty(p, THIRSTY_MS - 1), false);
  assert.equal(thirsty(p, THIRSTY_MS + 1), true);
  p = doChore(p, THIRSTY_MS + 1);
  assert.equal(thirsty(p, THIRSTY_MS + 2), false);
});

test('the garden is saved in one place and survives blocked or garbled storage', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const planters = loadGarden(storage);
  assert.equal(planters.length, PLANTERS.length);
  planters[1] = doChore(planters[1], 5);
  saveGarden(planters, storage);
  assert.ok(GARDEN_KEY.startsWith('office.game.'));
  assert.equal(loadGarden(storage)[1].sown, 5);
  mem.set(GARDEN_KEY, '{nope');
  assert.deepEqual(loadGarden(storage), PLANTERS.map(() => emptyPlanter()));
  assert.deepEqual(loadGarden({ getItem: () => { throw new Error('blocked'); } }), PLANTERS.map(() => emptyPlanter()));
  assert.deepEqual(sanitizePlanter({ sown: 'x', watered: [1, 'a', NaN], picked: -3 }), emptyPlanter());
});
