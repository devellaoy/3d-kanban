import test from 'node:test';
import assert from 'node:assert/strict';
import { GHOST_DT, GhostRecorder, decodePath, encodePath, ghostDone, poseAt, type GhostPath } from '../src/client/features/cars/ghost.js';
import { Race, HOLD, JUMP_PENALTY, LIGHTS, atLine } from '../src/client/features/cars/race.js';
import { addResult, bestTotal, bestsOf, parseBests, parseResults, KEEP, type Bests, type RaceResult } from '../src/client/features/cars/records.js';
import { LapTimer } from '../src/client/features/cars/laps.js';
import { ROAD } from '../src/shared/layout.js';

const Z = (ROAD.minZ + ROAD.maxZ) / 2;

test('the recorder samples at a fixed rate and fills slow frames', () => {
  const r = new GhostRecorder();
  r.begin(10);
  r.sample(10, { x: 0, z: 0, rotY: 0 });
  r.sample(10.35, { x: 3, z: 0, rotY: 0 });
  const path = r.finish(11, { x: 10, z: 0, rotY: 0 })!;
  assert.equal(path.time, 1);
  assert.equal(path.pts.length, Math.floor(1 / GHOST_DT) + 1);
  assert.equal(path.pts[3].x, 3);
  assert.equal(r.recording, false);
  assert.equal(r.finish(12, { x: 0, z: 0, rotY: 0 }), null);
});

test('poseAt interpolates, wraps angles the short way and holds at the ends', () => {
  const path: GhostPath = {
    time: GHOST_DT * 4,
    pts: [
      { x: 0, z: 0, rotY: 3.0 },
      { x: 10, z: 20, rotY: -3.0 },
      { x: 10, z: 20, rotY: -3.0 },
    ],
  };
  const mid = poseAt(path, GHOST_DT / 2);
  assert.equal(mid.x, 5);
  assert.equal(mid.z, 10);
  assert.ok(Math.abs(Math.abs(mid.rotY) - Math.PI) < 0.2, `short way round (${mid.rotY})`);
  assert.deepEqual(poseAt(path, -1), { x: 0, z: 0, rotY: 3.0 });
  assert.equal(poseAt(path, 99).x, 10);
  assert.ok(ghostDone(path, GHOST_DT * 6) && !ghostDone(path, GHOST_DT * 2));
});

test('a path survives encoding to a compact string', () => {
  const pts = Array.from({ length: 300 }, (_, i) => ({ x: -50 + i * 2.37, z: Z + Math.sin(i / 7) * 40, rotY: Math.atan2(Math.sin(i / 5), Math.cos(i / 5)) }));
  const path = { time: 29.9, pts };
  const text = encodePath(path);
  assert.ok(text.length < pts.length * 14, `compact (${text.length} chars)`);
  const back = decodePath(text)!;
  assert.equal(back.pts.length, 300);
  assert.equal(back.time, 29.9);
  pts.forEach((p, i) => {
    assert.ok(Math.abs(back.pts[i].x - p.x) <= 0.051 && Math.abs(back.pts[i].z - p.z) <= 0.051 && Math.abs(back.pts[i].rotY - p.rotY) <= 0.006);
  });
});

test('decodePath refuses anything damaged, or recorded before the cars were quick (version 1)', () => {
  for (const bad of [null, undefined, '', 'x', '1;3;1,2,3,4,5,6', '3;3;1,2,3,4,5,6', '2;0;1,2,3,4,5,6', '2;3;1,2,3', '2;3;1,2,3,4,5', '2;3;1,2,3,4,5,$$', '2;3;']) assert.equal(decodePath(bad), null, String(bad));
});

test('a race: five lights a second apart, a random hold, then go', () => {
  const race = new Race(2, () => 0.5);
  const car = { x: -3, z: Z, speed: 0 };
  assert.ok(race.start(0, car));
  assert.ok(!race.start(0, car));
  const seen: string[] = [];
  for (let t = 0.1; t < 12 && race.phase === 'countdown'; t += 0.1) for (const e of race.update(t, car)) seen.push(e.t === 'light' ? `l${e.n}` : e.t);
  assert.deepEqual(seen, ['l1', 'l2', 'l3', 'l4', 'l5', 'go']);
  assert.equal(race.phase, 'racing');
  assert.equal(LIGHTS, 5);
  assert.ok(HOLD.min < HOLD.max);
});

test('moving before the lights go out is one jump start, with a penalty in the total', () => {
  const race = new Race(1, () => 0);
  race.start(0, { x: 0, z: Z, speed: 0 });
  const e1 = race.update(2, { x: 0.2, z: Z, speed: 0 });
  assert.ok(!e1.some((e) => e.t === 'jump'));
  const e2 = race.update(2.1, { x: 0.2, z: Z, speed: 5 });
  assert.equal(e2.filter((e) => e.t === 'jump').length, 1);
  assert.equal(race.update(2.2, { x: 4, z: Z, speed: 5 }).filter((e) => e.t === 'jump').length, 0);
  for (let t = 2.3; race.phase === 'countdown'; t += 0.1) race.update(t, { x: 0, z: Z, speed: 0 });
  assert.equal(race.lapDone(40, true).length, 2);
  assert.equal(race.phase, 'done');
  assert.equal(race.result!.total, 40 + JUMP_PENALTY);
  assert.equal(race.result!.penalty, JUMP_PENALTY);
});

test('laps only count once racing, and the race ends after the last', () => {
  const race = new Race(3, () => 0);
  assert.deepEqual(race.lapDone(50, false), []);
  race.start(0, { x: 0, z: Z, speed: 0 });
  assert.deepEqual(race.lapDone(50, false), []);
  for (let t = 0.5; race.phase === 'countdown'; t += 0.5) race.update(t, { x: 0, z: Z, speed: 0 });
  assert.equal(race.lapDone(50, false).length, 1);
  assert.equal(race.lapDone(48, true).length, 1);
  const last = race.lapDone(47, true);
  assert.equal(last[1].t, 'finish');
  assert.equal(race.result!.total, 145);
  assert.deepEqual(race.abort(), []);
});

test('aborting a race stops it', () => {
  const race = new Race();
  race.start(0, { x: 0, z: Z, speed: 0 });
  assert.equal(race.abort().length, 1);
  assert.equal(race.phase, 'idle');
});

test('atLine is the street near the chequered line', () => {
  assert.ok(atLine(-5, Z, ROAD));
  assert.ok(!atLine(80, Z, ROAD));
  assert.ok(!atLine(0, Z + 40, ROAD));
});

test('records: newest first, capped, with records spotted', () => {
  const mk = (total: number, at = 0): RaceResult => ({ at, laps: [total / 3, total / 3, total / 3], penalty: 0, total });
  let list: RaceResult[] = [];
  let out = addResult(list, mk(300));
  assert.ok(out.record && out.bestLap);
  list = out.list;
  out = addResult(list, mk(310));
  assert.ok(!out.record && !out.bestLap);
  out = addResult(out.list, mk(290));
  assert.ok(out.record);
  assert.equal(bestTotal(out.list), 290);
  assert.equal(out.list[0].total, 290);
  for (let i = 0; i < 20; i++) out = addResult(out.list, mk(400 + i));
  assert.equal(out.list.length, KEEP);
});

test('the best race outlives the capped history: a slower race is not a record after ten slower ones', () => {
  const mk = (total: number): RaceResult => ({ at: 0, laps: [total / 3, total / 3, total / 3], penalty: 0, total });
  let list: RaceResult[] = [];
  let bests: Bests = { total: null, lap: null };
  let out = addResult(list, mk(250), bests);
  assert.ok(out.record);
  list = out.list;
  bests = out.next;
  for (let i = 0; i < KEEP + 5; i++) {
    out = addResult(list, mk(400 + i), bests);
    assert.ok(!out.record && !out.bestLap, 'slower than the best, even when the best has left the list');
    list = out.list;
    bests = out.next;
  }
  assert.ok(!list.some((r) => r.total === 250), 'the 250 race has left the history');
  assert.equal(bests.total, 250);
  assert.ok(Math.abs((bests.lap ?? 0) - 250 / 3) < 1e-9);
  assert.ok(addResult(list, mk(240), bests).record);
});

test('bests are worked out from saved results when none were kept, and rubbish is ignored', () => {
  const list: RaceResult[] = [
    { at: 1, laps: [90, 80], penalty: 0, total: 170 },
    { at: 2, laps: [70, 95], penalty: 0, total: 165 },
  ];
  assert.deepEqual(bestsOf(list, parseBests(null)), { total: 165, lap: 70 });
  assert.deepEqual(bestsOf(list, { total: 100, lap: 75 }), { total: 100, lap: 70 });
  assert.deepEqual(parseBests('{"total":123.5,"lap":40}'), { total: 123.5, lap: 40 });
  assert.deepEqual(parseBests('nope'), { total: null, lap: null });
  assert.deepEqual(parseBests('{"total":-1,"lap":"x"}'), { total: null, lap: null });
});

test('parseResults keeps only well-formed results', () => {
  const good = { at: 1, laps: [10, 11], penalty: 0, total: 21 };
  const text = JSON.stringify([good, { at: 1 }, null, { ...good, laps: [] }, { ...good, total: 'x' }]);
  assert.deepEqual(parseResults(text), [{ ...good, cls: 'supercar' }], 'saved before the 4x4s: a supercar race');
  assert.deepEqual(parseResults('not json'), []);
  assert.deepEqual(parseResults('{"a":1}'), []);
  assert.deepEqual(parseResults(null), []);
});

test('a race lap starts at the lights: the first crossing of the line does not restart the clock', () => {
  const laps = new LapTimer();
  laps.update(-3, Z, 0);
  laps.begin(1);
  laps.update(-1, Z, 2);
  assert.equal(laps.update(1, Z, 3), null);
  assert.equal(laps.crossed, 3);
  assert.equal(laps.crossings, 1);
  assert.equal(laps.running(4), null);
  // Without begin, a crossing restarts the lap from the line.
  const free = new LapTimer();
  free.update(-1, Z, 0);
  free.update(1, Z, 5);
  assert.equal(free.crossings, 1);
});
