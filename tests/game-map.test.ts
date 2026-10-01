import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMP, FARM, LAKE, LIGHTHOUSE, LOOP, MOUNTAINS, PIER, VIEWPOINT, shoreX } from '../src/shared/scenic';
import { ELEVATOR_NOTES, WORLD, markers, minimapAngle, onMap, pierLine, project, rotateForHeading, shoreLine, visibleMountains, walkingHeading } from '../src/client/features/map/geometry';
import { SPOTS } from '../src/client/features/fishing/spots';

test('the projection fits the area, north is up and east is right', () => {
  const p = project(WORLD, 1000, 826);
  assert.ok(p.x(WORLD.minX) >= 0 && p.x(WORLD.maxX) <= 1000.0001);
  assert.ok(p.y(WORLD.minZ) >= 0 && p.y(WORLD.maxZ) <= 826.0001);
  assert.ok(p.y(-10) < p.y(10), 'north (-z) is up the picture');
  assert.ok(p.x(10) > p.x(-10), 'east (+x) is right');
  // Both axes use the one scale.
  assert.ok(Math.abs((p.x(1) - p.x(0)) - (p.y(1) - p.y(0))) < 1e-9);
});

test('every marker is inside the map, and the places come from the shared constants', () => {
  const list = markers();
  for (const m of list) assert.ok(onMap(m.x, m.z), `${m.id} is off the map`);
  const by = (id: string) => list.find((m) => m.id === id)!;
  assert.deepEqual([by('camp').x, by('camp').z], [CAMP.x, CAMP.z]);
  assert.deepEqual([by('viewpoint').x, by('viewpoint').z], [VIEWPOINT.x, VIEWPOINT.z]);
  assert.deepEqual([by('lighthouse').x, by('lighthouse').z], [LIGHTHOUSE.x, LIGHTHOUSE.z]);
  assert.deepEqual([by('farm').x, by('farm').z], [FARM.barn.x, FARM.barn.z]);
  assert.equal(by('start').x, 0);
  assert.equal(new Set(list.map((m) => m.id)).size, list.length, 'no marker twice');
  for (const m of list) assert.ok(m.icon && m.label, `${m.id} has an emoji and a name`);
});

test('both fishing spots are on the map, where the fishing feature puts them', () => {
  const fish = markers().filter((m) => m.kind === 'fish');
  assert.equal(fish.length, SPOTS.length);
  for (const s of SPOTS) assert.ok(fish.some((m) => m.x === s.x && m.z === s.z && m.label === s.name));
  // The beach pier's end is out over the sea, the dock's on the lake's north shore.
  const sea = SPOTS.find((s) => s.id === 'sea')!;
  assert.ok(sea.x < shoreX(sea.z));
  const lake = SPOTS.find((s) => s.id === 'lake')!;
  assert.ok(Math.abs(lake.x - LAKE.x) < LAKE.rx && lake.z < LAKE.z + LAKE.rz);
});

test('the area covers the whole loop, the shore and the pier', () => {
  for (const q of LOOP) assert.ok(onMap(q.x, q.z), `loop point ${q.x},${q.z}`);
  for (const [x, z] of shoreLine()) assert.ok(z >= WORLD.minZ && z <= WORLD.maxZ && x <= WORLD.maxX && x >= WORLD.minX);
  const pier = pierLine();
  assert.equal(pier.z, PIER.z);
  assert.ok(pier.x1 < pier.x0);
  assert.ok(onMap(pier.x1, pier.z));
  assert.ok(visibleMountains().length > 0 && visibleMountains().length <= MOUNTAINS.length);
});

test('the places up the elevator are noted rather than placed', () => {
  assert.ok(ELEVATOR_NOTES.some((n) => n.label.includes('Rooftop')));
  assert.ok(ELEVATOR_NOTES.some((n) => n.label.includes('garden')));
});

test('the little map turns your heading to the top of the screen', () => {
  // Walking forward looks along -(sin yaw, cos yaw): the heading is the direction of travel (sin, cos).
  for (const yaw of [0, 1, -2.4, Math.PI]) {
    const h = walkingHeading(yaw);
    assert.ok(Math.abs(Math.sin(h) + Math.sin(yaw)) < 1e-9 && Math.abs(Math.cos(h) + Math.cos(yaw)) < 1e-9);
  }
  for (const h of [0, 0.7, 2, -1.3, Math.PI, 3 * Math.PI / 2]) {
    // One meter ahead (sin h east, cos h south, in screen terms) lands straight up, 1 px from the middle.
    const ahead = rotateForHeading(Math.sin(h), Math.cos(h), h);
    assert.ok(Math.abs(ahead.x) < 1e-9 && Math.abs(ahead.y + 1) < 1e-9, `heading ${h}: ${ahead.x},${ahead.y}`);
    assert.equal(minimapAngle(h), h - Math.PI);
  }
  // Heading south (+z) on the map needs it turned right way up: not at all.
  const south = rotateForHeading(0, 1, 0);
  assert.ok(Math.abs(south.y + 1) < 1e-9);
});
