import test from 'node:test';
import assert from 'node:assert/strict';
import { Angler, REEL_TIME } from '../src/client/features/fishing/angler.js';
import { CAST_MAX, CAST_MIN, CLEAN_STRIKE, SPECIES, STRIKE_WINDOW, castDistance, judgeStrike, lengthText, reachOf, rollSize, rollSpecies, speciesIn, weightKg, weightOf, weightText } from '../src/client/features/fishing/catch.js';
import { emptyJournal, logCast, logCatch, logMiss, parseJournal, totals } from '../src/client/features/fishing/journal.js';
import { SPOTS, clampHeading, isWater, landing, spotNear } from '../src/client/features/fishing/spots.js';

/** A repeatable stream of numbers in [0, 1). */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const fish = (id: string) => SPECIES.find((s) => s.id === id)!;

test('every species has a unique id, a sensible size range and a water to bite in', () => {
  assert.equal(new Set(SPECIES.map((s) => s.id)).size, SPECIES.length);
  for (const s of SPECIES) {
    assert.ok(s.waters.length > 0, s.id);
    if (s.kind === 'fish') assert.ok(s.minCm > 0 && s.maxCm > s.minCm, s.id);
    else assert.equal(s.maxCm, 0, s.id);
  }
  assert.ok(speciesIn('lake').some((s) => s.kind === 'fish') && speciesIn('sea').some((s) => s.kind === 'fish'));
  assert.ok(speciesIn('lake').some((s) => s.kind === 'junk') && speciesIn('sea').some((s) => s.kind === 'junk'));
});

test('a roll only gives species of the water it is cast on, junk included, and the commoner turn up more', () => {
  const rng = seeded();
  const counts = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    const s = rollSpecies(rng, 'lake', 0.3);
    assert.ok(s.waters.includes('lake'), s.id);
    counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  }
  assert.ok((counts.get('perch') ?? 0) > (counts.get('pike') ?? 0));
  assert.ok((counts.get('pike') ?? 0) > (counts.get('golden-carp') ?? 0));
  assert.ok((counts.get('boot') ?? 0) > 0, 'junk shows up');
  const junk = [...counts].filter(([id]) => SPECIES.find((s) => s.id === id)!.kind === 'junk').reduce((n, [, c]) => n + c, 0);
  assert.ok(junk > 400 && junk < 1000, `about a sixth is junk, got ${junk}`);
  for (let i = 0; i < 500; i++) assert.ok(rollSpecies(rng, 'sea', 1).waters.includes('sea'));
});

test('a longer cast finds rarer fish and fewer boots', () => {
  const shore = fish('swordfish');
  assert.ok(weightOf(shore, 1) > weightOf(shore, 0));
  assert.ok(weightOf(fish('perch'), 1) / weightOf(fish('perch'), 0) < weightOf(shore, 1) / weightOf(shore, 0));
  const boot = SPECIES.find((s) => s.id === 'boot')!;
  assert.ok(weightOf(boot, 1) < weightOf(boot, 0));
});

test('sizes stay in the species range, a clean strike is bigger on average, and a boot has none', () => {
  const rng = seeded(3);
  const cod = fish('cod');
  let sloppy = 0;
  let clean = 0;
  for (let i = 0; i < 2000; i++) {
    const a = rollSize(rng, cod, 0);
    const b = rollSize(rng, cod, 1);
    assert.ok(a.cm >= cod.minCm && a.cm <= cod.maxCm && b.cm >= cod.minCm && b.cm <= cod.maxCm);
    sloppy += a.cm;
    clean += b.cm;
  }
  assert.ok(clean > sloppy);
  const boot = rollSize(rng, SPECIES.find((s) => s.id === 'boot')!, 1);
  assert.deepEqual([boot.cm, boot.kg], [0, 0]);
});

test('weight goes with the cube of the length', () => {
  const pike = fish('pike');
  assert.ok(weightKg(pike, 100) > 7 && weightKg(pike, 100) < 8);
  assert.ok(weightKg(pike, 50) < weightKg(pike, 100) / 7);
  assert.equal(lengthText(23), '23 cm');
  assert.equal(lengthText(125), '1.25 m');
  assert.equal(weightText(0.18), '180 g');
  assert.equal(weightText(2.5), '2.50 kg');
});

test('striking: too early, clean, slower, and too late', () => {
  assert.equal(judgeStrike(-0.2).result, 'early');
  assert.deepEqual(judgeStrike(0.1), { result: 'hooked', quality: 1 });
  assert.deepEqual(judgeStrike(CLEAN_STRIKE), { result: 'hooked', quality: 1 });
  const slow = judgeStrike((CLEAN_STRIKE + STRIKE_WINDOW) / 2);
  assert.ok(slow.result === 'hooked' && slow.quality > 0.4 && slow.quality < 0.6);
  assert.equal(judgeStrike(STRIKE_WINDOW + 0.01).result, 'late');
});

test('cast distance goes from a flop to the far end of the meter', () => {
  assert.equal(castDistance(0), CAST_MIN);
  assert.equal(castDistance(1), CAST_MAX);
  assert.equal(castDistance(5), CAST_MAX);
  assert.equal(reachOf(CAST_MIN), 0);
  assert.equal(reachOf(CAST_MAX), 1);
});

test('the spots are at the end of the planks, with water in front and none behind', () => {
  assert.equal(SPOTS.length, 2);
  for (const s of SPOTS) {
    assert.ok(!isWater(s.water, s.x, s.z), `${s.id}: you stand on the planks`);
    const out = landing(s.water, s.x, s.z, s.heading, 10);
    assert.ok(out && Math.abs(out.distance - 10) < 0.01, `${s.id}: ten meters out is water`);
    assert.equal(landing(s.water, s.x, s.z, s.heading + Math.PI, 10), null, `${s.id}: the way back is the planks and the shore`);
    assert.equal(spotNear(s.x, s.z, 1)?.id, s.id);
  }
  assert.equal(spotNear(0, 0, 50), undefined);
});

test('a cast that would come down on land comes in short, or not at all', () => {
  const lake = SPOTS.find((s) => s.water === 'lake')!;
  // Further than the lake is wide there: it comes down at the far shore's edge, short of where it was thrown.
  const far = landing('lake', lake.x, lake.z, lake.heading, 40);
  assert.ok(far && far.distance < 40 && far.distance > 10, 'lands short');
  assert.ok(isWater('lake', far.x, far.z));
  assert.equal(landing('sea', SPOTS[1].x, SPOTS[1].z, Math.PI / 2, 15), null, 'back at the beach');
  assert.equal(clampHeading(0.1, 0, 1), 0.1);
  assert.equal(clampHeading(3, 0, 1), 1);
  assert.ok(Math.abs(clampHeading(-3, 0, 1) + 1) < 1e-9);
});

/** An angler cast out from `t0` that has landed, waiting for a bite at `t`. */
function cast(angler: Angler, t0 = 0, hold = 0.525): number {
  assert.ok(angler.windUp(t0));
  const d = angler.release(t0 + hold, 'lake', (dist) => ({ x: 0, z: dist, distance: dist }));
  assert.ok(d !== null && d > CAST_MIN);
  assert.equal(angler.stage, 'cast');
  return t0 + hold;
}

test('an angler casts, waits, gets nibbles and a bite, then a clean strike lands a fish after the reel', () => {
  const a = new Angler(seeded(11));
  let t = cast(a);
  const events: string[] = [];
  while (a.stage !== 'bite' && t < 30) events.push(...a.update((t += 0.05)));
  assert.equal(a.stage, 'bite');
  assert.equal(events[0], 'landed');
  assert.equal(events.at(-1), 'bite');
  assert.equal(a.strike(t + 0.1), 'hooked');
  assert.equal(a.stage, 'reel');
  assert.ok(a.caught && a.caught.species === a.plan);
  assert.equal(a.quality, 1);
  assert.deepEqual(a.update(t + 0.1 + REEL_TIME + 0.01), ['landedIn']);
  assert.equal(a.stage, 'ready');
});

test('striking before the bite spooks the fish; letting the bite go by loses it', () => {
  const early = new Angler(seeded(5));
  let t = cast(early);
  early.update((t += 0.8));
  assert.equal(early.stage, 'wait');
  assert.equal(early.strike(t), 'spooked');
  assert.equal(early.stage, 'ready');

  const late = new Angler(seeded(5));
  t = cast(late);
  while (late.stage !== 'bite') late.update((t += 0.05));
  const events = late.update(t + STRIKE_WINDOW + 0.2);
  assert.deepEqual(events, ['missed']);
  assert.equal(late.stage, 'ready');

  const slow = new Angler(seeded(5));
  t = cast(slow);
  while (slow.stage !== 'bite') slow.update((t += 0.05));
  assert.equal(slow.strike(t + STRIKE_WINDOW + 0.1), 'late');
});

test('no water where you aim: the wind-up is dropped and nothing is cast', () => {
  const a = new Angler(seeded(1));
  assert.ok(a.windUp(0));
  assert.equal(a.release(0.4, 'sea', () => null), null);
  assert.equal(a.stage, 'ready');
  assert.ok(a.windUp(1));
  a.cancelWind();
  assert.equal(a.stage, 'ready');
  assert.equal(a.strike(2), 'nothing');
});

test('the meter climbs while winding up and the harder cast flies further', () => {
  const a = new Angler(seeded(2));
  a.windUp(0);
  assert.ok(a.power(0.5) > a.power(0.1));
  const far = new Angler(seeded(2));
  far.windUp(0);
  const soft = new Angler(seeded(2));
  soft.windUp(0);
  const land = (d: number) => ({ x: 0, z: d, distance: d });
  assert.ok(far.release(1.05, 'lake', land)! > soft.release(0.1, 'lake', land)!);
});

test('the journal keeps counts and bests per species, flags a first and a record, and keeps the latest', () => {
  const rng = seeded(9);
  let j = emptyJournal();
  const perch = fish('perch');
  const a = { species: perch, cm: 20, kg: weightKg(perch, 20) };
  const b = { species: perch, cm: 31, kg: weightKg(perch, 31) };
  const c = { species: perch, cm: 18, kg: weightKg(perch, 18) };
  let r = logCatch(j, a, 'Lake dock', 100);
  assert.ok(r.first && !r.record);
  j = r.journal;
  r = logCatch(j, b, 'Lake dock', 200);
  assert.ok(!r.first && r.record);
  r = logCatch(r.journal, c, 'Lake dock', 300);
  assert.ok(!r.first && !r.record);
  j = r.journal;
  assert.deepEqual(j.species.perch, { n: 3, bestCm: 31, bestKg: weightKg(perch, 31), first: 100 });
  assert.deepEqual(j.recent.map((e) => e.cm), [18, 31, 20]);
  const boot = { species: SPECIES.find((s) => s.id === 'boot')!, cm: 0, kg: 0 };
  j = logCatch(j, boot, 'Beach pier', 400).journal;
  j = logMiss(logCast(logCast(j)));
  assert.deepEqual(totals(j), { fish: 3, junk: 1, kinds: 1 });
  assert.deepEqual([j.casts, j.missed], [2, 1]);
  for (let i = 0; i < 40; i++) j = logCatch(j, rollSize(rng, perch, 1), 'Lake dock', 500 + i).journal;
  assert.equal(j.recent.length, 24);
  assert.equal(emptyJournal().recent.length, 0, 'the empty one is left alone');
});

test('the journal survives what a browser might have stored: junk in, an empty journal out', () => {
  assert.deepEqual(parseJournal(null), emptyJournal());
  assert.deepEqual(parseJournal('not json'), emptyJournal());
  assert.deepEqual(parseJournal('42'), emptyJournal());
  const j = emptyJournal();
  const stored = logCatch(j, { species: fish('cod'), cm: 80, kg: 4.5 }, 'Beach pier', 1000).journal;
  assert.deepEqual(parseJournal(JSON.stringify(stored)), stored);
  const messy = parseJournal(JSON.stringify({ casts: -3, missed: 'x', species: { cod: { n: 2, bestCm: 'big' }, kraken: { n: 9, bestCm: 1 }, perch: { n: 0 } }, recent: [{ id: 'nope' }, { id: 'cod', cm: 5 }, 7] }));
  assert.equal(messy.casts, 0);
  assert.equal(messy.missed, 0);
  assert.deepEqual(Object.keys(messy.species), ['cod']);
  assert.equal(messy.species.cod.bestCm, 0);
  assert.equal(messy.recent.length, 1);
});
