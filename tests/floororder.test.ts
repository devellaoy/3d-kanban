import test from 'node:test';
import assert from 'node:assert/strict';
import { floorGroupKey, floorStep, groupFloors, groupStep, insertFloor, LOCAL_GROUP, moveFloorAbove, moveGroupAbove, normalizeOrder, type Orderable } from '../src/shared/floororder.js';

const f = (id: string, repo?: string): Orderable => ({ id, repo });
const ids = (list: Orderable[] | undefined) => list?.map((x) => x.id);

// Bottom-up: acme has a, b; Beta has c, d; no repository: e.
const building = [f('a', 'acme/a'), f('b', 'Acme/b'), f('c', 'Beta/c'), f('d', 'beta/d'), f('e')];

test('floors group by owner, case-insensitively, and the Local group has no owner', () => {
  assert.equal(floorGroupKey(f('x', 'Acme/x')), 'acme');
  assert.equal(floorGroupKey(f('x')), '');
  const groups = groupFloors(building);
  assert.deepEqual(groups.map((g) => [g.key, g.label, ids(g.floors)]), [
    ['acme', 'acme', ['a', 'b']],
    ['beta', 'Beta', ['c', 'd']],
    ['', LOCAL_GROUP, ['e']],
  ]);
});

test('normalizing makes each group one run and keeps the rest of the order', () => {
  const mixed = [f('a', 'x/a'), f('b', 'y/b'), f('c', 'X/c'), f('d'), f('e', 'y/e'), f('g')];
  assert.deepEqual(ids(normalizeOrder(mixed)), ['a', 'c', 'b', 'e', 'd', 'g']);
  assert.deepEqual(ids(normalizeOrder(building)), ids(building));
});

test('a new floor goes to the top of its owner group, or the bottom of it with that group at the bottom of the building', () => {
  assert.deepEqual(ids(insertFloor(building, f('n', 'acme/n'), 'groupTop')), ['a', 'b', 'n', 'c', 'd', 'e']);
  assert.deepEqual(ids(insertFloor(building, f('n', 'acme/n'), 'bottom')), ['n', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids(insertFloor(building, f('n', 'beta/n'), 'bottom')), ['n', 'c', 'd', 'a', 'b', 'e']);
  assert.deepEqual(ids(insertFloor(building, f('n', 'new/n'), 'groupTop')), ['a', 'b', 'c', 'd', 'e', 'n']);
  assert.deepEqual(ids(insertFloor(building, f('n', 'new/n'), 'bottom')), ['n', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids(insertFloor(building, f('n'), 'bottom')), ['n', 'e', 'a', 'b', 'c', 'd']);
  assert.equal(groupFloors(insertFloor(building, f('n', 'new/n'), 'bottom'))[0].label, 'new');
});

test('a floor moves within its group, to just above a neighbour or to the bottom', () => {
  assert.deepEqual(ids(moveFloorAbove(building, 'a', 'b')), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(ids(moveFloorAbove(building, 'b', null)), ['b', 'a', 'c', 'd', 'e']);
  assert.deepEqual(ids(moveFloorAbove(building, 'd', null)), ['a', 'b', 'd', 'c', 'e']);
  assert.deepEqual(ids(moveFloorAbove(building, 'b', 'a')), ids(building));
  assert.deepEqual(ids(moveFloorAbove(building, 'e', null)), ids(building));
});

test('a floor cannot move to another group or to unknown places', () => {
  assert.equal(moveFloorAbove(building, 'a', 'c'), undefined);
  assert.equal(moveFloorAbove(building, 'a', 'a'), undefined);
  assert.equal(moveFloorAbove(building, 'a', 'nope'), undefined);
  assert.equal(moveFloorAbove(building, 'nope', null), undefined);
});

test('moves normalize an out-of-order list first', () => {
  const mixed = [f('a', 'x/a'), f('b', 'y/b'), f('c', 'x/c')];
  assert.deepEqual(ids(moveFloorAbove(mixed, 'a', 'c')), ['c', 'a', 'b']);
});

test('a group moves above another group or to the bottom of the building', () => {
  assert.deepEqual(ids(moveGroupAbove(building, 'acme', 'beta')), ['c', 'd', 'a', 'b', 'e']);
  assert.deepEqual(ids(moveGroupAbove(building, '', 'acme')), ['a', 'b', 'e', 'c', 'd']);
  assert.deepEqual(ids(moveGroupAbove(building, 'beta', null)), ['c', 'd', 'a', 'b', 'e']);
  assert.equal(moveGroupAbove(building, 'acme', 'acme'), undefined);
  assert.equal(moveGroupAbove(building, 'acme', 'nope'), undefined);
  assert.equal(moveGroupAbove(building, 'nope', null), undefined);
});

test('steps give the neighbour to move above, and nothing at the edge', () => {
  assert.equal(floorStep(building, 'a', 'up'), 'b');
  assert.equal(floorStep(building, 'b', 'up'), undefined);
  assert.equal(floorStep(building, 'b', 'down'), null);
  assert.equal(floorStep(building, 'a', 'down'), undefined);
  assert.equal(floorStep(building, 'nope', 'up'), undefined);
  const three = [f('a', 'x/a'), f('b', 'x/b'), f('c', 'x/c')];
  assert.equal(floorStep(three, 'c', 'down'), 'a');
  assert.deepEqual(ids(moveFloorAbove(three, 'c', 'a')), ['a', 'c', 'b']);
  assert.equal(groupStep(building, 'acme', 'up'), 'beta');
  assert.equal(groupStep(building, 'beta', 'up'), '');
  assert.equal(groupStep(building, '', 'up'), undefined);
  assert.equal(groupStep(building, 'beta', 'down'), null);
  assert.equal(groupStep(building, 'acme', 'down'), undefined);
  assert.equal(groupStep(building, 'nope', 'down'), undefined);
});
