/**
 * Sitting on the chairs and sofas you put up (build mode, see index.ts): aim at one and press E, and you
 * sit on the place nearest where you aim, facing the way the piece does; E again, or walking off or
 * jumping, gets you up as at the office's own seats. The seating feature does the sitting down and getting
 * up (player.sit / stand) with a place from seats.ts. These seats are local to this browser: the office
 * knows no seat for them, so others see you standing there (and the sit message names no seat).
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import type { Interactable } from '../../world/types';
import type { Piece } from './model';
import { canSit, placeToSit } from './seats';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    buildseat: true;
  }
}

interface Seatable {
  piece: Piece;
  group: THREE.Group;
  it: Interactable;
}

export function makeBuildSeats(ctx: Ctx) {
  const seats = new Map<string, Seatable>();
  ctx.usables.add({ usable: () => [...seats.values()].map((s) => s.it) });

  const ray = new THREE.Raycaster();
  const middle = new THREE.Vector2(0, 0);

  const sittingOn = (id: string) => ctx.player.seat?.seatId === `build:${id}`;
  const byInteractable = (it: Interactable) => [...seats.values()].find((s) => s.it === it);

  /** On your feet, as by E at the office's own seat (the office hears nothing: it never knew this one). */
  function standUp() {
    if (!ctx.player.seat?.seatId.startsWith('build:')) return;
    ctx.player.stand();
    ctx.player.onStand?.();
  }

  function sitDown(s: Seatable) {
    // The place nearest where the crosshair lands on it, else nearest you.
    let x = ctx.player.pos.x;
    let z = ctx.player.pos.z;
    ray.setFromCamera(middle, ctx.camera);
    const hit = ray.intersectObject(s.group, true)[0];
    if (hit) ({ x, z } = hit.point);
    const place = placeToSit(s.piece, x, z);
    if (!place) return;
    // Up from an office seat first, and the office told (or it'd keep you in that seat for everyone else).
    if (ctx.player.seat) {
      ctx.player.stand();
      ctx.player.onStand?.();
    }
    ctx.player.sit(place);
    ctx.me.sit(place.hips);
  }

  ctx.interactions.define('buildseat', {
    reach: 3.5,
    hint: (it) => {
      const s = byInteractable(it);
      if (!s) return { k: '', parts: [] };
      const label = s.piece.kind === 'sofa' ? 'Sofa' : 'Chair';
      if (sittingOn(s.piece.id)) return { k: `${label}|sitting`, parts: [hintTitle(`🛠️ ${label}`), aside('sitting'), key('E', 'Get up')] };
      return { k: `${label}|free`, parts: [hintTitle(`🛠️ ${label}`), key('E', 'Sit')] };
    },
    use: onE((it) => {
      const s = byInteractable(it);
      if (!s) return;
      if (sittingOn(s.piece.id)) standUp();
      else sitDown(s);
    }),
  });

  return {
    /** A piece has been put up: a chair or a sofa is one you can sit on. */
    add(piece: Piece, group: THREE.Group) {
      if (!canSit(piece.kind)) return;
      const it: Interactable = { kind: 'buildseat', x: piece.x, z: piece.z, radius: 1.5, seatId: `build:${piece.id}` };
      group.userData.interact = it;
      seats.set(piece.id, { piece, group, it });
    },
    /** A piece is coming down: if you sit on it you get up first. */
    remove(id: string) {
      if (sittingOn(id)) standUp();
      seats.delete(id);
    },
    /** Off whatever of this you sit on (a floor left, build mode entered). */
    standUp,
  };
}
