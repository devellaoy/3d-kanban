import type * as THREE from 'three';
import { MOVABLE_BY_ID, furnitureKey, poseOf, type Furniture, type Pose } from '../../../shared/arrange';
import type { Collider } from '../types';
import type { Fixture, Site } from './fixture';

// The loose furniture of the office floor (the desks, bean bags, couch, coffee table, poufs, whiteboard and rugs, see
// shared/arrange.ts) put where a floor has arranged it. The fixtures that build each register it with
// `site.movables`; this one, last on the plan, hands the office what moves them all: the floor's
// arrangement as it comes from the server, and what build mode carries about.

declare module '../types' {
  interface OfficeHandles {
    /** Moves the loose furniture about (see shared/arrange.ts). */
    arrange: Arranger;
  }
}

export interface Arranger {
  /** Puts every piece where `furniture` says, the floor you're on (what's not in it stands where it comes). */
  apply(furniture: Furniture): void;
  /** The piece's id that `obj` (something aimed at) is part of. */
  idOf(obj: THREE.Object3D): string | undefined;
  /** What moves for piece `id`, to aim at. */
  groups(): THREE.Object3D[];
  /** Draws piece `id` at `pose` while it's carried: nobody bumps into it or uses it meanwhile. */
  carry(id: string, pose: Pose): void;
  /** Puts a carried piece back where the floor has it. */
  release(id: string): void;
  /** Puts piece `id` down at `pose` (what the floor is about to have), standing there for real. */
  settle(id: string, pose: Pose): void;
  /** The parts of piece `id` that aren't its own (a seated worker), which keep their looks while it's tinted. */
  untinted(id: string): THREE.Object3D[];
  /** Every collider the furniture puts in the office, so a check of where something could go can leave them out. */
  colliders(): Set<Collider>;
}

/** A rug of the room (see ROOM_RUGS): `group` lies at its home, and build mode moves it, turns it or takes it out. It's flat: no collider, nothing to use. */
export function movableRug(site: Site, id: string, group: THREE.Group) {
  site.movables.set(id, {
    group,
    colliders: [],
    place(pose) {
      group.visible = !!pose;
      if (!pose) return;
      group.position.set(pose.x, 0, pose.z);
      group.rotation.y = pose.rotY;
    },
  });
}

/** Puts `colliders` in the floor's list (or takes them out), whichever isn't so yet. */
export function standIn(list: Collider[], colliders: readonly Collider[], on: boolean) {
  for (const c of colliders) {
    const i = list.indexOf(c);
    if (on && i < 0) list.push(c);
    else if (!on && i >= 0) list.splice(i, 1);
  }
}

/** Fits collider `c` to `rect` ([minX, maxX, minZ, maxZ]), in place: the player's collision keeps the same objects. */
export function fitTo(c: Collider, rect: readonly [number, number, number, number]) {
  [c.minX, c.maxX, c.minZ, c.maxZ] = rect;
}

/** The loose furniture, last on the plan: the fixtures before it built it. */
export const arrange: Fixture<'arrange'> = (site) => {
  let last = '';
  let current: Furniture = {};
  const place = (id: string, pose: Pose | null, held = false) => {
    const piece = site.movables.get(id);
    if (!piece) return;
    piece.place(pose, held);
  };
  for (const [id, piece] of site.movables) piece.group.userData.furnitureId = id;
  const arranger: Arranger = {
    apply(furniture) {
      current = furniture;
      const key = furnitureKey(furniture);
      if (key === last) return;
      last = key;
      for (const id of site.movables.keys()) place(id, poseOf(MOVABLE_BY_ID.get(id)!, furniture));
    },
    idOf(obj) {
      for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (typeof o.userData.furnitureId === 'string') return o.userData.furnitureId as string;
      return undefined;
    },
    groups: () => [...site.movables.values()].map((p) => p.group),
    carry: (id, pose) => place(id, pose, true),
    release: (id) => place(id, poseOf(MOVABLE_BY_ID.get(id)!, current)),
    settle: (id, pose) => place(id, pose),
    untinted: (id) => site.movables.get(id)?.untinted ?? [],
    colliders: () => new Set([...site.movables.values()].flatMap((p) => p.colliders)),
  };
  return { handle: { arrange: arranger } };
};
