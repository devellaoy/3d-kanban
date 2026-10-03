import test from 'node:test';
import assert from 'node:assert/strict';
import { Billiards, endsCharge } from '../src/client/features/billiards/game';
import { parseRecord } from '../src/client/features/billiards/storage';
import { HALF_L, HALF_W, HEAD_SPOT, POCKETS, R, STEP, aimLine, newBall, rack, settled, step, strike, type Ball, type SimEvent } from '../src/client/features/billiards/sim';

/** Runs the simulation until everything stops (or `max` seconds), collecting events. */
function run(balls: Ball[], max = 30): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < max && !settled(balls); t += STEP) step(balls, out);
  return out;
}

const energy = (balls: Ball[]) => balls.reduce((s, b) => s + (b.potted ? 0 : b.vx * b.vx + b.vy * b.vy), 0);

test('the rack has sixteen balls, none overlapping, all on the cloth', () => {
  const balls = rack();
  assert.equal(balls.length, 16);
  assert.deepEqual([...balls.map((b) => b.id)].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  for (const a of balls) {
    assert.ok(Math.abs(a.x) < HALF_L && Math.abs(a.y) < HALF_W);
    for (const b of balls) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * R);
  }
  assert.equal(balls.find((b) => b.id === 8)!.y, 0);
});

test('a lone ball slows down and stops by friction', () => {
  const balls = [newBall(0, 0, 0)];
  strike(balls, 0.3, 0.2);
  const e0 = energy(balls);
  step(balls);
  assert.ok(energy(balls) < e0);
  run(balls);
  assert.ok(settled(balls));
  assert.equal(balls[0].vx, 0);
});

test('a head-on hit passes almost all the speed on and the cue ball nearly stops', () => {
  const balls = [newBall(0, -0.5, 0), newBall(1, 0, 0)];
  strike(balls, 0, 0.5);
  const v0 = balls[0].vx;
  const events: SimEvent[] = [];
  for (let i = 0; i < 400 && !events.some((e) => e.kind === 'ball'); i++) step(balls, events);
  assert.ok(events.some((e) => e.kind === 'ball'));
  assert.ok(Math.abs(balls[0].vx) < 0.05 * v0, `cue ball left with ${balls[0].vx}`);
  assert.ok(balls[1].vx > 0.9 * v0 * 0.9);
  assert.ok(Math.abs(balls[1].vy) < 1e-9);
});

test('a ball off a cushion reflects with less speed', () => {
  const balls = [newBall(0, 0.5, 0)];
  strike(balls, Math.PI / 2, 0.6);
  let hit: SimEvent | undefined;
  const events: SimEvent[] = [];
  for (let i = 0; i < 2000 && !hit; i++) {
    step(balls, events);
    hit = events.find((e) => e.kind === 'cushion');
  }
  assert.ok(hit);
  assert.ok(balls[0].vy < 0);
  assert.ok(Math.abs(balls[0].vy) < 0.72 * 5.5 * 0.6);
});

test('a ball driven at a corner pocket drops in', () => {
  const p = POCKETS[3];
  const balls = [newBall(0, 0, 0)];
  strike(balls, Math.atan2(p.y, p.x), 0.8);
  const events = run(balls);
  assert.ok(events.some((e) => e.kind === 'pocket' && e.pocket === 3));
  assert.ok(balls[0].potted);
});

test('a ball driven at a side pocket drops in', () => {
  const balls = [newBall(0, 0, -0.3)];
  strike(balls, Math.PI / 2, 0.8);
  const events = run(balls);
  assert.ok(events.some((e) => e.kind === 'pocket' && e.pocket === 5));
});

test('nothing ever leaves the table without being potted', () => {
  for (let i = 0; i < 40; i++) {
    const balls = rack();
    strike(balls, ((i * 37) % 360) * (Math.PI / 180), 0.6 + (i % 5) * 0.1);
    run(balls, 40);
    for (const b of balls) if (!b.potted) assert.ok(Math.abs(b.x) <= HALF_L && Math.abs(b.y) <= HALF_W);
  }
});

test('the simulation is deterministic', () => {
  const play = () => {
    const balls = rack();
    strike(balls, 0.01, 1);
    run(balls);
    return JSON.stringify(balls);
  };
  assert.equal(play(), play());
});

test('the aim guide stops at the first ball in the way', () => {
  const balls = [newBall(0, -1, 0), newBall(1, 0, 0.01), newBall(2, 0.5, 0)];
  const end = aimLine(balls, 0);
  assert.equal(end.ball, 1);
  assert.ok(Math.abs(end.x - (0 - 2 * R)) < 0.01);
  assert.equal(aimLine(balls, Math.PI).ball, -1);
});

test('a shot takes a turn: practice keeps the same player, two players swap on a miss and keep the table on a pot', () => {
  const g = new Billiards();
  assert.equal(g.player, 'Practice');
  assert.ok(g.shoot(0.5, 0.05));
  assert.equal(g.shoot(0.5, 0.5), false, 'no second shot while the balls roll');
  for (let i = 0; i < 5000 && g.phase === 'rolling'; i++) g.update(STEP);
  assert.equal(g.phase, 'aim');
  assert.equal(g.shots, 1);
  assert.equal(g.turn, 0);

  const h = new Billiards();
  h.setMode('hotseat');
  h.balls = [newBall(0, -0.5, 0.5), newBall(1, 1.0, -0.5)];
  h.shoot(Math.PI / 2, 0.05);
  for (let i = 0; i < 5000 && h.phase === 'rolling'; i++) h.update(STEP);
  assert.equal(h.turn, 1, 'a miss hands the table over');
  // A third ball far off, so the pot doesn't clear the table (which racks a new one).
  h.balls = [newBall(0, 1.0, 0.3), newBall(1, 1.3, 0.55), newBall(2, -1.0, -0.5)];
  h.shoot(Math.atan2(0.25, 0.3), 0.5);
  for (let i = 0; i < 20000 && h.phase === 'rolling'; i++) h.update(STEP);
  assert.deepEqual(h.potted, [1]);
  assert.equal(h.turn, 1, 'a pot keeps the table');
  assert.equal(h.score[1], 1);
});

test('a scratch puts the cue ball in hand behind the head string', () => {
  const g = new Billiards();
  g.balls = [newBall(0, 1.0, 0.6), newBall(1, -1, -0.5)];
  const p = POCKETS[3];
  g.shoot(Math.atan2(p.y - 0.6, p.x - 1.0), 0.4);
  for (let i = 0; i < 20000 && g.phase === 'rolling'; i++) g.update(STEP);
  assert.equal(g.phase, 'inhand');
  assert.equal(g.cue.potted, false);
  assert.equal(g.cue.x, HEAD_SPOT.x);
  assert.equal(g.shoot(0, 1), false, 'not until it is put down');
  assert.ok(g.nudgeCue(0, 0.1));
  assert.equal(g.nudgeCue(2, 0) && g.cue.x > HEAD_SPOT.x + 1e-9, false, 'it stays behind the head string');
  assert.ok(g.placeCue());
  assert.equal(g.phase, 'aim');
});

test('a cleared table starts the next rack from nothing: shots and score reset, the count kept in clearedIn', () => {
  const g = new Billiards();
  g.balls = [newBall(0, 1.0, 0.3), newBall(1, 1.3, 0.55)];
  g.shots = 6;
  g.shoot(Math.atan2(0.25, 0.3), 0.5);
  for (let i = 0; i < 20000 && g.phase === 'rolling'; i++) g.update(STEP);
  assert.ok(g.last?.cleared, 'the shot clears the table');
  assert.equal(g.clearedIn, 7);
  assert.equal(g.balls.length, 16);
  assert.equal(g.shots, 0);
  assert.deepEqual(g.score, [0, 0]);
});

test('a charge ends only by the input that began it', () => {
  assert.equal(endsCharge('space', 'space', false), true);
  assert.equal(endsCharge('mouse', 'space', false), false);
  assert.equal(endsCharge('space', 'mouse', false), false);
  assert.equal(endsCharge('mouse', 'mouse', false), true);
  assert.equal(endsCharge('space', 'mouse', true), true, 'losing focus always ends it');
});

test('reset racks everything again', () => {
  const g = new Billiards();
  g.shoot(0, 1);
  for (let i = 0; i < 20000 && g.phase === 'rolling'; i++) g.update(STEP);
  g.reset();
  assert.equal(g.shots, 0);
  assert.equal(g.balls.length, 16);
  assert.ok(g.balls.every((b) => !b.potted && b.vx === 0));
});

test('a saved record is read back, and rubbish is ignored', () => {
  assert.deepEqual(parseRecord(JSON.stringify({ mode: 'hotseat', best: 31 })), { mode: 'hotseat', best: 31 });
  assert.deepEqual(parseRecord('nope'), { mode: 'practice', best: null });
  assert.deepEqual(parseRecord(JSON.stringify({ mode: 'x', best: -2 })), { mode: 'practice', best: null });
  assert.deepEqual(parseRecord(null), { mode: 'practice', best: null });
});
