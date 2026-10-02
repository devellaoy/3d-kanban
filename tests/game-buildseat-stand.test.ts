import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeBuildSeats } from '../src/client/features/build/sit.js';
import type { Piece } from '../src/client/features/build/model.js';

test('sitting on build furniture straight from an office seat tells the office you stood up', () => {
  const log: string[] = [];
  let use: ((it: unknown, key: string) => void) | undefined;
  const player = {
    pos: new THREE.Vector3(1, 0, 1),
    seat: { seatId: 'sofa-1' } as { seatId: string } | null,
    onStand: () => log.push('gotUp'),
    stand() {
      log.push('stand');
      this.seat = null;
    },
    sit(place: { seatId?: string }) {
      log.push('sit');
      this.seat = { seatId: place.seatId ?? 'build:p1' };
    },
  };
  const ctx = {
    player,
    camera: new THREE.PerspectiveCamera(),
    me: { sit: () => log.push('me.sit') },
    usables: { add: () => {} },
    interactions: { define: (_k: string, def: { use: typeof use }) => (use = def.use) },
  };
  const seats = makeBuildSeats(ctx as never);
  const piece: Piece = { id: 'p1', kind: 'chair', x: 1, z: 1, r: 0 };
  const group = new THREE.Group();
  seats.add(piece, group);
  use!(group.userData.interact, 'E');
  assert.deepEqual(log.slice(0, 2), ['stand', 'gotUp'], 'the old seat is given up and the office told, before the new one');
  assert.ok(log.includes('sit'));
});
