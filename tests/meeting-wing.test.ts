import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FloorPlanStore } from '../src/server/floorplan.js';
import { cleanPlan, roomsToGrow } from '../src/shared/floorplan.js';
import { MEETING_ROOMS, ROOMS_WING, WING, annexOf, openWindows, roomsLevel, roomsOfAnnex, wingOfAnnex, WINDOWS } from '../src/shared/layout.js';
import { MAX_PANES, MAX_ROOM_LAMPS, panes } from '../src/client/world/roomlight.js';

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-meetingwing-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the meeting wing is built out a room at a time, up to three, and stays across restarts', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.equal(plan.rooms, 0);
    assert.deepEqual(plan.expandRooms(), { id: 'review' });
    assert.deepEqual(plan.expandRooms(), { id: 'room-3' });
    assert.deepEqual(plan.expandRooms(), { id: 'room-4' });
    assert.match(plan.expandRooms() as string, /can't go out any further/);
    assert.equal(plan.state().rooms, ROOMS_WING.rooms);
    assert.equal(new FloorPlanStore(dir).rooms, 3);
    // The back office is its own, and nothing the wing does touches it.
    assert.equal(plan.state().wing, 0);
  });
});

test('walling the wing up goes room by room from the last, and is refused while a meeting is in it', () => {
  withDir((dir) => {
    const plan = new FloorPlanStore(dir);
    assert.match(plan.shrinkRooms(() => undefined) as string, /no meeting room/);
    plan.expandRooms();
    plan.expandRooms();
    assert.equal(plan.shrinkRooms((id) => (id === 'room-3' ? 'A meeting is on in room 3' : undefined)), 'A meeting is on in room 3');
    assert.equal(plan.rooms, 2);
    assert.deepEqual(plan.shrinkRooms(() => undefined), { id: 'room-3', label: '🤝 Meeting room 3' });
    assert.equal(plan.rooms, 1);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'floorplan.json'), 'utf8')).rooms, 1);
  });
});

test('a plan saved before there was a meeting wing has none, and a wild number is kept in range', () => {
  assert.equal(cleanPlan({ wing: 1, labels: {} }).rooms, 0);
  assert.equal(cleanPlan({ rooms: 99 }).rooms, ROOMS_WING.rooms);
  assert.equal(cleanPlan({ rooms: -4 }).rooms, 0);
  assert.equal(cleanPlan({ rooms: 'two' }).rooms, 0);
  assert.equal(roomsLevel(1.9), 1);
  assert.equal(roomsToGrow({ wing: 0, rooms: 1, labels: {} }), 2);
});

test('a meeting still running in the wing’s first room, or workers at its chairs, bring the wing back as far as that room; a finished meeting does not', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, 'meetings.json'), JSON.stringify({ rooms: { review: { id: 'm1', status: 'running' }, 'room-3': { id: 'm2', status: 'done' } } }));
    assert.equal(new FloorPlanStore(dir).rooms, 1);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'floorplan.json'), 'utf8')).rooms, 1, 'saved, since it was raised');
  });
  withDir((dir) => {
    writeFileSync(path.join(dir, 'workers.json'), JSON.stringify([{ id: 'w', deskId: 'room-3-2' }]));
    assert.equal(new FloorPlanStore(dir).rooms, 2);
  });
  withDir((dir) => {
    writeFileSync(path.join(dir, 'meetings.json'), JSON.stringify({ rooms: { review: { id: 'm1', status: 'done' } } }));
    assert.equal(new FloorPlanStore(dir).rooms, 0);
    assert.throws(() => readFileSync(path.join(dir, 'floorplan.json')), 'no floorplan.json is written unasked');
  });
});

test('a built room takes its window with it, and the building-out of two parts travels as one number', () => {
  assert.equal(openWindows(0).length, WINDOWS.length);
  assert.equal(openWindows(2).length, WINDOWS.length - 2);
  assert.ok(openWindows(3).every((o) => o.room === undefined));
  for (const wing of [0, 1, 2]) for (const rooms of [0, 1, 2, 3]) {
    const a = annexOf(wing, rooms);
    assert.deepEqual([wingOfAnnex(a), roomsOfAnnex(a)], [wing, rooms]);
  }
  assert.deepEqual(MEETING_ROOMS.map((r) => r.level), [0, 1, 2, 3]);
});

test('the room shader takes every lamp and pane the office has with both wings built out: nothing is silently left out', () => {
  // Lamps: the pods' four pendants and the lounge's, the boss office's, two over each meeting room's table, and one in each row of the back office.
  const lamps = 4 + 1 + 1 + 2 * MEETING_ROOMS.length + WING.rows;
  assert.ok(lamps <= MAX_ROOM_LAMPS, `${lamps} lamps, room for ${MAX_ROOM_LAMPS}`);
  // Panes: the windows still in the wall (a built room's goes with its wall), the balcony doors, and the back office's.
  for (const rooms of [0, 1, 2, 3]) assert.equal(panes(WING.rows, rooms).length, openWindows(rooms).length + 1 + WING.rows, `${rooms} rooms: no pane is cut off`);
  assert.ok(openWindows(0).length + 1 + WING.rows <= MAX_PANES);
});

test('the sky counts the built rooms as the office, over their stretch of the west wall only: not the exit landing, nor the lawn', async () => {
  const { annexOutside, annexSheltered, setSkyRooms } = await import('../src/client/world/skyannex.js');
  const { WING_ROOMS, FLOOR, EXIT_STAIRS } = await import('../src/shared/layout.js');
  const inRoom = { x: FLOOR.minX - 1.5, y: 1.5, z: WING_ROOMS[0].c };
  const landing = { x: FLOOR.minX - 0.8, y: 1.5, z: EXIT_STAIRS.landingZ0 + 0.5 };
  const lawn = { x: FLOOR.minX - 1.5, y: 1.5, z: WING_ROOMS[2].z1 + 2 };
  setSkyRooms(0, 0.02);
  assert.equal(annexOutside(inRoom, 6.8, -0.06), Infinity);
  setSkyRooms(1, 0.02);
  assert.equal(annexOutside(inRoom, 6.8, -0.06), 0);
  assert.ok(annexOutside({ ...inRoom, z: WING_ROOMS[1].c }, 6.8, -0.06) > 1, 'the second room isn’t built');
  assert.equal(annexSheltered(inRoom.x, inRoom.z), true);
  setSkyRooms(3, 0.02);
  assert.equal(annexOutside({ ...inRoom, z: WING_ROOMS[2].c }, 6.8, -0.06), 0);
  assert.ok(annexOutside(landing, 6.8, -0.06) > 0.5, 'the landing isn’t in the office');
  assert.ok(annexOutside(lawn, 6.8, -0.06) > 0.5, 'nor is the open strip south of the rooms');
  assert.equal(annexSheltered(landing.x, landing.z), false);
  assert.equal(annexSheltered(lawn.x, lawn.z), false);
  setSkyRooms(0, 0.02);
});

test('standing where a meeting room was, with it walled up, puts you back inside the office by its door', async () => {
  const { pastTheRooms } = await import('../src/client/core/floors.js');
  const { WING_ROOMS, FLOOR } = await import('../src/shared/layout.js');
  const c = WING_ROOMS[1].c;
  assert.equal(pastTheRooms({ x: FLOOR.minX - 1.5, y: 0, z: c }, 1), c, 'room 2 is not built');
  assert.equal(pastTheRooms({ x: FLOOR.minX - 1.5, y: 0, z: c }, 2), undefined, 'room 2 is built');
  assert.equal(pastTheRooms({ x: FLOOR.minX + 2, y: 0, z: c }, 0), undefined, 'in the office');
  assert.equal(pastTheRooms({ x: FLOOR.minX - 1.5, y: -3.6, z: c }, 0), undefined, 'down on the street');
  assert.equal(pastTheRooms({ x: FLOOR.minX - 1, y: 0, z: 6.5 }, 0), undefined, 'on the exit landing');
});
