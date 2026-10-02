import test from 'node:test';
import assert from 'node:assert/strict';
import { canSit, nearestPlace, placeToSit, placesOf, seatOf } from '../src/client/features/build/seats.js';
import { PIECE_FLOOR, PIECE_KINDS, type Piece } from '../src/client/features/build/model.js';

const piece = (kind: Piece['kind'], x: number, z: number, r = 0): Piece => ({ id: 'p1', kind, x, z, r });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('only chairs and sofas can be sat on', () => {
  assert.deepEqual(PIECE_KINDS.filter(canSit), ['chair', 'sofa']);
  assert.equal(seatOf(piece('table', 0, 0)), null);
  assert.deepEqual(placesOf(piece('plant', 0, 0)), []);
  assert.equal(nearestPlace(piece('rug', 0, 0), 0, 0), null);
});

test('a chair has one place, a sofa two, and they face the way the piece does', () => {
  assert.equal(placesOf(piece('chair', 1, 1)).length, 1);
  assert.equal(placesOf(piece('sofa', 1, 1)).length, 2);
  for (let r = 0; r < 4; r++) {
    const [spot] = placesOf(piece('chair', 2, 3, r));
    near(spot.rotY, (r * Math.PI) / 2);
    near(Math.sin(spot.rotY), [0, 1, 0, -1][r]);
    near(Math.cos(spot.rotY), [1, 0, -1, 0][r]);
  }
});

test('the sofa places lie along the sofa, whichever way it is turned', () => {
  // Front toward +z (r = 0): the sofa runs along x.
  const [l0, r0] = placesOf(piece('sofa', 0, 0, 0));
  assert.ok(l0.x < 0 && r0.x > 0);
  near(l0.z, r0.z);
  // A quarter turn (front toward +x): it runs along z, and you sit a little toward the front (+x).
  const [l1, r1] = placesOf(piece('sofa', 0, 0, 1));
  near(l1.x, r1.x);
  assert.ok(l1.x > 0);
  assert.ok(Math.abs(l1.z - r1.z) > 0.5);
  // A half turn (front toward -z): mirrored.
  const [l2, r2] = placesOf(piece('sofa', 0, 0, 2));
  assert.ok(l2.x > 0 && r2.x < 0);
  assert.ok(l2.z < 0);
});

test('the places are on the piece and at seat height', () => {
  const p = piece('sofa', 4, -2, 3);
  for (const spot of placesOf(p, 0)) {
    assert.ok(Math.abs(spot.x - 4) < 1.1 && Math.abs(spot.z + 2) < 1.1);
    assert.equal(spot.y, 0);
    assert.ok(spot.hips > 0.5 && spot.hips < 0.8);
    assert.equal(spot.seatId, 'build:p1');
  }
  assert.deepEqual(placesOf(p).map((s) => s.key), ['build:p1:0', 'build:p1:1']);
});

test('pressing E to sit seats you on the piece, at the floor it stands on (never at your feet height)', () => {
  const p = piece('chair', 3, 3);
  const place = placeToSit(p, 3, 3)!;
  assert.equal(place.y, PIECE_FLOOR);
  assert.equal(place.y, placesOf(p, PIECE_FLOOR)[0].y);
  assert.equal(PIECE_FLOOR, 0);
});

test('the nearest place is the one closest to where you aim', () => {
  const p = piece('sofa', 0, 0, 0);
  const [l, r] = placesOf(p);
  assert.equal(nearestPlace(p, -0.9, 0.2)?.key, l.key);
  assert.equal(nearestPlace(p, 0.9, 0.2)?.key, r.key);
  const q = piece('sofa', 5, 5, 1);
  const [ql, qr] = placesOf(q);
  assert.equal(nearestPlace(q, 5, ql.z - 0.2)?.key, ql.key);
  assert.equal(nearestPlace(q, 5, qr.z + 0.2)?.key, qr.key);
});
