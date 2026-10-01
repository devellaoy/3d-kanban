import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOOR } from '../src/shared/layout.js';
import { MAX_PIECES, PIECES, check, colliderOf, footprint, parse, serialise, snap, storageKey, turn, type Piece } from '../src/client/features/build/model.js';

let n = 0;
const id = () => `t${++n}`;
const piece = (kind: Piece['kind'], x: number, z: number, r = 0): Piece => ({ id: id(), kind, x, z, r });

test('snap goes to the half meter and turn wraps round', () => {
  assert.equal(snap(1.24), 1);
  assert.equal(snap(1.26), 1.5);
  assert.equal(snap(-0.8), -1);
  assert.equal(turn(3), 0);
  assert.equal(turn(0, -1), 3);
});

test('a quarter turn swaps the footprint', () => {
  const a = footprint(piece('sofa', 0, 0, 0));
  const b = footprint(piece('sofa', 0, 0, 1));
  assert.equal(a.maxX - a.minX, 2);
  assert.equal(b.maxX - b.minX, 0.9);
  assert.equal(b.maxZ - b.minZ, 2);
});

test('colliders: solid pieces have a box as tall as they are, rugs none', () => {
  const c = colliderOf(piece('bookshelf', 1, 2))!;
  assert.equal(c.top, PIECES.bookshelf.h);
  assert.equal(c.minX, 0.4);
  assert.equal(colliderOf(piece('rug', 0, 0)), null);
});

test('check: the floor, the colliders, other pieces, you, and rugs under things', () => {
  const none = { colliders: [], pieces: [] };
  assert.equal(check(piece('chair', 0, 0), none).ok, true);
  assert.equal(check(piece('chair', FLOOR.maxX, 0), none).ok, false);
  assert.equal(check(piece('sofa', FLOOR.minX + 1.5, 0), none).ok, true);
  assert.equal(check(piece('sofa', FLOOR.minX + 1, 0), none).ok, false);
  const wall = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, top: 1 };
  assert.deepEqual(check(piece('chair', 0.5, 0), { ...none, colliders: [wall] }), { ok: false, why: 'blocked' });
  assert.equal(check(piece('chair', 1.5, 0), { ...none, colliders: [wall] }).ok, true);
  // the loft overhead and something flat on the ground are not in the way
  assert.equal(check(piece('chair', 0, 0), { ...none, colliders: [{ ...wall, bottom: 2.8, top: 3 }, { ...wall, top: 0.01 }] }).ok, true);
  const sofa = piece('sofa', 0, 0);
  assert.deepEqual(check(piece('table', 0.5, 0), { ...none, pieces: [sofa] }), { ok: false, why: 'piece' });
  assert.equal(check(piece('table', 0, 1.5), { ...none, pieces: [sofa] }).ok, true);
  assert.deepEqual(check(piece('chair', 5, 5), { ...none, you: { x: 5.5, z: 5 } }), { ok: false, why: 'you' });
  const rug = piece('rug', 0, 0);
  assert.equal(check(piece('table', 0, 0), { ...none, pieces: [rug] }).ok, true);
  assert.equal(check(piece('rug', 0.5, 0), { ...none, pieces: [rug] }).ok, false);
});

test('serialise and parse round-trip, and broken input is dropped', () => {
  const list = [piece('plant', 2, 3, 1), piece('rug', -4.5, 1, 2)];
  const back = parse(serialise(list), id);
  assert.deepEqual(back.map(({ kind, x, z, r }) => ({ kind, x, z, r })), list.map(({ kind, x, z, r }) => ({ kind, x, z, r })));
  assert.deepEqual(parse(null, id), []);
  assert.deepEqual(parse('not json', id), []);
  assert.deepEqual(parse('{"pieces":5}', id), []);
  const messy = JSON.stringify({ pieces: [{ k: 'ufo', x: 0, z: 0, r: 0 }, { k: 'chair', x: 'a', z: 0 }, { k: 'chair', x: 999, z: 0, r: 0 }, { k: 'chair', x: 1.1, z: 1, r: 5 }, null] });
  const out = parse(messy, id);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].x, out[0].z, out[0].r], [1, 1, 1]);
  const many = JSON.stringify({ pieces: Array.from({ length: MAX_PIECES + 20 }, () => ({ k: 'chair', x: 0, z: 0, r: 0 })) });
  assert.equal(parse(many, id).length, MAX_PIECES);
});

test('each floor has its own key', () => {
  assert.notEqual(storageKey('a'), storageKey('b'));
  assert.ok(storageKey('a').startsWith('office.game.'));
});
