import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MOVABLES, arrangedPlan, cleanFurniture, furnitureKey, movableObstacles, removedPlaces, removedSeats } from '../src/shared/arrange.js';
import { boxedIn, checkPlace } from '../src/shared/arrange-check.js';
import { cleanPlan } from '../src/shared/floorplan.js';
import { BEANBAGS, DESKS, SEATING, beanbagsOut, nextFreeSeat, vacantSeats } from '../src/shared/layout.js';
import { OFFICE_PLAN, planOf } from '../src/shared/maps/index.js';
import { officeNav, route } from '../src/shared/nav.js';
import { FloorPlanStore } from '../src/server/floorplan.js';

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-arrange-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const why = (v: unknown) => (v as { why: string }).why;

test('every piece of furniture, where the office comes, is allowed to be there, and nothing is walled in', () => {
  for (const m of MOVABLES) assert.deepEqual(checkPlace({}, m.id, { x: m.home.x, z: m.home.z, r: 0 }, { walking: false }), { ok: true }, m.id);
  assert.deepEqual(boxedIn({}), []);
  // Every desk, bean bag, the couch, the two poufs, the whiteboard and the five rugs.
  assert.equal(MOVABLES.length, DESKS.length + BEANBAGS.length + 4 + 5);
});

test('a floor with nothing moved has the office plan itself, and the castle never has any', () => {
  assert.equal(arrangedPlan(OFFICE_PLAN, {}), OFFICE_PLAN);
  assert.equal(arrangedPlan(OFFICE_PLAN, undefined), OFFICE_PLAN);
  const castle = planOf('castle');
  assert.equal(arrangedPlan(castle, { 'desk-1': { removed: true } }), castle);
  assert.equal(castle.removed, undefined);
});

test('the arranged plan has moved desks and their watch spots, the couch and poufs, and no removed seats', () => {
  const f = cleanFurniture({ 'desk-1': { x: -11.6, z: 0.2, r: 1 }, couch: { x: 10.5, z: 0, r: 2 }, 'lounge-beanbag-1': { removed: true }, 'beanbag-2': { removed: true } });
  const plan = arrangedPlan(OFFICE_PLAN, f);
  assert.notEqual(plan, OFFICE_PLAN);
  assert.equal(arrangedPlan(OFFICE_PLAN, f), plan);
  const d = plan.byId.get('desk-1')!;
  assert.deepEqual([d.x, d.z], [-11.6, 0.2]);
  assert.ok(Math.abs(d.rotY - (DESKS[0].rotY + Math.PI / 2)) < 1e-9);
  const w = plan.byId.get('watch-desk-1')!;
  assert.deepEqual([w.x, w.z, w.rotY], [d.x, d.z, d.rotY]);
  assert.equal(plan.seatingById.has('lounge-beanbag-1'), false);
  assert.equal(plan.seatingById.has('lounge-beanbag-2'), true);
  // Turned the other way round it no longer faces the TV, so sitting on it doesn't share the screen.
  assert.equal(plan.seatingById.get('couch')!.tv, false);
  assert.equal(OFFICE_PLAN.seatingById.get('couch')!.tv, true);
  assert.deepEqual([...plan.removed!], ['beanbag-2']);
  // The original plan is untouched.
  assert.equal(OFFICE_PLAN.byId.get('desk-1')!.x, DESKS[0].x);
});

test('what is read back is only what is valid, and what stands where it comes is not kept', () => {
  const home = DESKS[2];
  const f = cleanFurniture({
    'desk-1': { x: -3, z: 2.123, r: 5 },
    'desk-3': { x: home.x, z: home.z, r: 0 },
    nope: { x: 1, z: 1, r: 0 },
    'beanbag-1': { removed: 1 },
    'lounge-beanbag-2': { x: 14, z: -3, r: 3 },
    whiteboard: { x: NaN, z: 0, r: 0 },
  });
  assert.deepEqual(f, { 'desk-1': { x: -3, z: 2.12, r: 1 }, 'lounge-beanbag-2': { x: 14, z: -3, r: 0 } });
  assert.deepEqual(cleanPlan({ furniture: f }).furniture, f);
  assert.deepEqual(cleanPlan(undefined).furniture, {});
  assert.equal(furnitureKey({ b: { removed: true }, a: { x: 1, z: 2, r: 3 } }), furnitureKey({ a: { x: 1, z: 2, r: 3 }, b: { removed: true } }));
});

test('a move is refused off the floor, onto other furniture, into the fixed things, and where it would shut something off', () => {
  assert.equal(why(checkPlace({}, 'desk-1', { x: -17.9, z: -3.45, r: 0 })), 'outside');
  assert.deepEqual(checkPlace({}, 'desk-1', { x: DESKS[1].x, z: DESKS[1].z, r: 0 }), { ok: false, why: 'furniture', with: 'Desk 2' });
  assert.equal(why(checkPlace({}, 'whiteboard', { x: 8.5, z: -9, r: 0 })), 'blocked'); // the elevator's doors
  assert.equal(why(checkPlace({}, 'desk-1', { x: 0, z: 0, r: 7 })), 'turn');
  assert.equal(why(checkPlace({}, 'lounge-beanbag-1', { x: 12.5, z: 3.5, r: 1 })), 'turn'); // a pouf turns to the TV by itself
  assert.equal(why(checkPlace({}, 'nope', { x: 0, z: 0, r: 0 })), 'unknown');
  assert.deepEqual(checkPlace({}, 'desk-1', { x: -16, z: -10, r: 3 }), { ok: false, why: 'boxed', with: 'Issues board' });
  // Free floor is fine, and so is a spot another piece has left.
  assert.deepEqual(checkPlace({}, 'whiteboard', { x: 5.4, z: -3, r: 1 }), { ok: true });
  assert.deepEqual(checkPlace({ 'desk-2': { x: -9.4, z: 0, r: 0 } }, 'desk-1', { x: DESKS[1].x, z: DESKS[1].z, r: 0 }), { ok: true });
});

test('the walking grid follows the furniture, and keeps one grid for one arrangement', () => {
  const base = officeNav(0, 0);
  const layout = { wing: 0, rooms: 0, furniture: { whiteboard: { x: 5.4, z: -3, r: 1 } } };
  const moved = officeNav(layout);
  assert.notEqual(base, moved);
  assert.equal(base.walkable(3.5, -5.4), false);
  assert.equal(moved.walkable(3.5, -5.4), true);
  assert.equal(moved.walkable(5.4, -3), false);
  assert.equal(officeNav({ ...layout, furniture: { whiteboard: { x: 5.4, z: -3, r: 1 } } }), moved);
  assert.equal(officeNav(1, 2), officeNav({ wing: 1, rooms: 2 }));
  // A removed desk leaves its floor free; routes go through it.
  const gone = { 'desk-1': { removed: true as const } };
  assert.ok(movableObstacles(gone).rects.length < movableObstacles({}).rects.length);
  assert.ok(route([-11.6, -4.55], [-11.6, -8], { wing: 0, rooms: 0, furniture: gone }).length >= 2);
});

test('furniture is never allowed where the back office or the meeting wing are built out', () => {
  for (const m of MOVABLES) {
    for (let x = -17.5; x <= 17.5; x += 0.5) {
      // Along the north wall's opening into the back office, and the west wall's doorways.
      assert.equal(checkPlace({}, m.id, { x, z: -12.4, r: 0 }, { walking: false }).ok && x > 13.4, false, `${m.id} at ${x}`);
    }
  }
});

test('removed desks and bean bags are not seats to hire at', () => {
  const gone = new Set(['desk-1', 'desk-2', 'beanbag-1']);
  assert.equal(nextFreeSeat(() => false, 0, gone)!.id, 'desk-3');
  const taken = (id: string) => DESKS.some((d) => d.id === id);
  assert.equal(nextFreeSeat(taken, 0, gone)!.id, BEANBAGS[1].id);
  assert.deepEqual([...beanbagsOut(taken, 0, gone)], ['beanbag-2']);
  const vacant = vacantSeats([], undefined, gone);
  assert.equal(vacant.has('desk-1') || vacant.has('watch-desk-1') || vacant.has('beanbag-1'), false);
  assert.equal(vacant.has('desk-3'), true);
  assert.deepEqual([...removedSeats({ 'desk-1': { removed: true }, couch: { removed: true }, 'desk-2': { x: 1, z: 1, r: 0 } })], ['desk-1']);
});

test('the furniture is kept with the floor plan, and what a move asks is checked on the server', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.equal(typeof plan.arrange('desk-1', { x: DESKS[1].x, z: DESKS[1].z, r: 0 }), 'string');
    assert.equal(typeof plan.arrange('nope', { x: 0, z: 0 }), 'string');
    const moved = plan.arrange('desk-1', { x: -11.6, z: 0.51234, r: 0 });
    assert.deepEqual(moved, { id: 'desk-1', label: 'Desk 1', back: false });
    assert.deepEqual(plan.state().furniture, { 'desk-1': { x: -11.6, z: 0.51, r: 0 } });
    assert.deepEqual(new FloorPlanStore(dir).state().furniture, plan.state().furniture);
    // The state it gave out isn't changed by what comes after.
    const before = plan.state().furniture;
    assert.deepEqual(plan.remove('desk-1', () => false), { id: 'desk-1', label: 'Desk 1' });
    assert.deepEqual(before, { 'desk-1': { x: -11.6, z: 0.51, r: 0 } });
    assert.deepEqual([...plan.removed], ['desk-1']);
    assert.equal(typeof plan.remove('desk-1', () => false), 'string');
    // Putting it back is a move.
    assert.deepEqual(plan.arrange('desk-1', { x: DESKS[0].x, z: DESKS[0].z, r: 0 }), { id: 'desk-1', label: 'Desk 1', back: true });
    assert.deepEqual(plan.state().furniture, {});
  });
});

test('a seat somebody is at is not taken out, nor is the last desk; a restored worker brings its seat back', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.match(plan.remove('desk-4', (id) => id === 'desk-4') as string, /send them home first/);
    assert.match(plan.remove('desk-4', (id) => id === 'watch-desk-4') as string, /send them home first/);
    assert.deepEqual(plan.state().furniture, {});
    for (const d of DESKS.slice(1)) assert.equal(typeof plan.remove(d.id, () => false), 'object');
    assert.equal(plan.remove(DESKS[0].id, () => false), 'The floor needs at least one desk');
    // The couch and the whiteboard can both go.
    assert.equal(typeof plan.remove('whiteboard', () => false), 'object');
    assert.equal(typeof plan.remove('couch', () => false), 'object');
    writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([{ id: 'w1', deskId: 'watch-desk-5' }]));
    const again = new FloorPlanStore(dir);
    assert.equal(again.removed.has('desk-5'), false);
    assert.equal(again.removed.has('desk-6'), true);
  });
});

test('putting furniture back: one piece where it is allowed, or all of it at once', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.equal(typeof plan.reset(), 'string');
    plan.arrange('desk-1', { x: -11.6, z: 0.5, r: 0 });
    plan.arrange('whiteboard', { x: 5.4, z: -3, r: 1 });
    // desk-2 takes desk-1's old spot: putting desk-1 back there is refused.
    plan.arrange('desk-2', { x: DESKS[0].x, z: DESKS[0].z, r: 0 });
    assert.equal(plan.reset('desk-1'), 'Desk 2 is already there');
    assert.deepEqual(plan.reset('whiteboard'), { labels: ['the whiteboard'] });
    assert.deepEqual(plan.reset(), { labels: ['Desk 1', 'Desk 2'] });
    assert.deepEqual(plan.state().furniture, {});
  });
});

test('the places of a couch or pouf that is taken out are not there to sit on', () => {
  assert.deepEqual(removedPlaces({ couch: { removed: true }, 'lounge-beanbag-2': { removed: true }, 'desk-1': { removed: true } }), ['couch:0', 'couch:1', 'couch:2', 'lounge-beanbag-2:0']);
  assert.deepEqual(removedPlaces({ couch: { x: 9.5, z: -5, r: 0 } }), []);
  assert.deepEqual(removedPlaces(undefined), []);
});

test('the seating is the office list when nothing is moved', () => {
  assert.equal(OFFICE_PLAN.seating.length, SEATING.length);
});

test('walling the back office up is refused when it would leave no desk standing', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.equal(typeof plan.expand(), 'object');
    // With the back office's desks standing, every desk of the room can go.
    for (const d of DESKS) assert.equal(typeof plan.remove(d.id, () => false), 'object', d.id);
    assert.equal(plan.shrink(() => false), 'The floor needs at least one desk: put one back first');
    assert.equal(plan.state().wing, 1);
    plan.arrange('desk-1', { x: DESKS[0].x, z: DESKS[0].z, r: 0 });
    assert.equal(typeof plan.shrink(() => false), 'object');
  });
});

test('a rug lies flat: it may be under a desk and on other rugs, but keeps the doors, elevator and stairs bare', () => {
  assert.deepEqual(checkPlace({}, 'rug-1', { x: -6, z: 0, r: 1 }), { ok: true });
  assert.deepEqual(checkPlace({}, 'rug-2', { x: -10.5, z: -4, r: 0 }), { ok: true }); // on rug 1 and its desks
  assert.equal(why(checkPlace({}, 'rug-1', { x: 8.5, z: -9, r: 0 })), 'blocked'); // the elevator
  assert.equal(why(checkPlace({}, 'rug-1', { x: 7.5, z: 10.5, r: 0 })), 'blocked'); // the stairs
  assert.equal(why(checkPlace({}, 'rug-3', { x: -17, z: 0, r: 0 })), 'outside');
  // Not in anyone's way: no obstacle, and a desk may be put on one.
  assert.equal(movableObstacles({ 'desk-1': { removed: true } }).rects.length, movableObstacles({}).rects.length - 1);
  assert.deepEqual(checkPlace({ 'rug-1': { x: -6, z: 0, r: 0 } }, 'desk-1', { x: -6, z: 0, r: 0 }), { ok: true });
  // They can be taken out, and are put back like the rest.
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.deepEqual(plan.remove('rug-lounge', () => false), { id: 'rug-lounge', label: 'Lounge rug' });
    assert.deepEqual([...plan.removed], []);
    assert.deepEqual(plan.reset(), { labels: ['Lounge rug'] });
  });
});
