import * as THREE from 'three';
import { CAR, CARS, SEATS, carHeight, carPoint, type Box, type CarDef, type CarKind, type CarPose, type CarSeat, type CarState } from '../../../shared/garage';
import { FLOOR, SLAB, STREET_Y, WALL_T, streetBelow } from '../../../shared/layout';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture, StreetSite } from '../../world/office/fixture';
import { offroad } from './offroad';
import { supercar } from './supercar';

export { supercar };

/** The fences keeping people out of the sea reach out past this far west (x): see world/scenic/water.ts. */
const SEA_FENCE = -1500;

/** A car's model, in parts that change while it's driven. */
export interface CarModel {
  root: THREE.Group;
  /** The body's lean (roll and pitch) is this group's rotation; the car's heading is root's. */
  tilt: THREE.Group;
  /** The painted roof and the glass round the cabin: off while anyone's in it, so their heads fit. */
  top: THREE.Object3D;
  /** With the roof off: the windshield, the two seats and the steering wheel. */
  open: THREE.Object3D;
  /** The front wheels, which turn to steer. */
  wheels: THREE.Object3D[];
  /** The other wheels, if they hang from the body on their own too (the 4x4's: they move against the body on the suspension, see ride.ts). */
  rear?: THREE.Object3D[];
}

/** A `kind` of car's model, in `color`. */
export function carModel(kind: CarKind, color: string): CarModel {
  return kind === 'offroad' ? offroad(color) : supercar(kind, color);
}

/** One of the floor's cars, as it's drawn here. */
export interface CarView extends CarModel {
  index: number;
  def: CarDef;
  /** Where it's drawn now: the page's own driving, or the office's word smoothed out. */
  pose: CarPose;
  /** Somebody's in it: the roof's off. */
  occupied: boolean;
  /** What you bump into and stand on: along its body (turned, it takes a few boxes), and its roof. */
  colliders: Collider[];
  interactable: Interactable;
  /** How it's riding on its springs (set by DriveEffects): the seats rise and tilt with the body. */
  ride?: { lift(lx: number, lz: number): number };
}

/** Whether the whole car is in under the building (the office's floor over it), rather than out on the lot or the street. */
function underneath(p: CarPose): boolean {
  return [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ].every(([sx, sz]) => {
    const c = carPoint(p, (sx * CAR.width) / 2, (sz * CAR.length) / 2);
    return c.x > FLOOR.minX - WALL_T && c.x < FLOOR.maxX + WALL_T && c.z > FLOOR.minZ - WALL_T && c.z < FLOOR.maxZ + WALL_T;
  });
}

/** Boxes along the car's body, for colliders: a car turned off square takes more than one. */
const SLICES = 3;

/**
 * The floor's cars (see CARS in shared/garage.ts), down on the street under the floor you're on: in
 * their spots, where somebody's driving them or where they were left.
 */
export class Fleet {
  readonly group = new THREE.Group();
  readonly cars: CarView[];
  /** How far below the floor you're on the street is (see streetBelow). */
  private street = STREET_Y;

  constructor(
    /** The office's: the cars' go in with them. */
    private all: Collider[],
    interactables: Interactable[],
  ) {
    this.cars = CARS.map((def, index) => {
      const model = carModel(def.kind, def.color);
      const interactable: Interactable = { kind: 'car', x: def.x, z: def.z, y: this.street, radius: 3.2, car: index };
      model.root.userData.interact = interactable;
      this.group.add(model.root);
      interactables.push(interactable);
      const colliders: Collider[] = [];
      for (let i = 0; i <= SLICES; i++) colliders.push({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, top: 0, bottom: 0 });
      all.push(...colliders);
      const view: CarView = { ...model, index, def, pose: { x: def.x, z: def.z, rotY: def.rotY, speed: 0, steer: 0 }, occupied: false, colliders, interactable };
      this.show(view);
      return view;
    });
  }

  /** The floor you're on is `street` above the street: the cars and everything about them are down there. */
  setStreet(street: number) {
    this.street = street;
    for (const v of this.cars) this.show(v);
  }

  /**
   * Each frame: every car where the office says it is (smoothed out, and carried on a little the
   * way it's going, since its driver said so), but for the one you're in (`mine`) if you're driving
   * it, which is where your own driving put it. The office doesn't tell you your own moves, so that
   * goes back into `cars` for when you get out.
   */
  update(dt: number, cars: CarState[], at: number[], now: number, mine: { car: number; driving: boolean } | null, eye: THREE.Vector3) {
    const k = 1 - Math.exp(-dt * 12);
    // From up in the office, the cars in under it can't be seen through its floor: not drawn at all.
    const indoors = eye.y > -SLAB && eye.x > FLOOR.minX && eye.x < FLOOR.maxX && eye.z > FLOOR.minZ && eye.z < FLOOR.maxZ;
    for (const v of this.cars) v.root.visible = !indoors || !underneath(v.pose);
    for (const v of this.cars) {
      const c = cars[v.index];
      if (!c) continue;
      const occupied = !!(c.driver || c.passenger) || v.index === mine?.car;
      if (occupied !== v.occupied) {
        v.occupied = occupied;
        v.top.visible = !occupied;
        v.open.visible = occupied;
        this.show(v);
      }
      if (v.index === mine?.car && mine.driving) {
        Object.assign(c, v.pose);
        at[v.index] = now;
        continue;
      }
      const p = v.pose;
      // Where it'd be by now, going on as it was: at most a quarter of a second on.
      const ahead = c.speed ? Math.min(0.25, Math.max(0, (now - (at[v.index] ?? now)) / 1000)) * c.speed : 0;
      const x = c.x + Math.sin(c.rotY) * ahead;
      const z = c.z + Math.cos(c.rotY) * ahead;
      // Flat out it covers a lot of ground between two messages: it carries on at its speed
      // meanwhile, and the office's word only corrects that, so it doesn't trail behind its target.
      const far = Math.hypot(x - p.x, z - p.z) > 8 + Math.abs(c.speed) * 0.4;
      const turn = Math.atan2(Math.sin(c.rotY - p.rotY), Math.cos(c.rotY - p.rotY));
      const run = far ? 0 : p.speed * dt;
      const fx = p.x + Math.sin(p.rotY) * run;
      const fz = p.z + Math.cos(p.rotY) * run;
      p.x = far ? x : fx + (x - fx) * k;
      p.z = far ? z : fz + (z - fz) * k;
      p.rotY = far ? c.rotY : p.rotY + turn * k;
      p.speed = c.speed;
      p.steer += (c.steer - p.steer) * k;
      this.show(v);
    }
  }

  /** Every car straight to where the office says it is, not smoothed: a floor's cars as you arrive on it. */
  snap(cars: CarState[]) {
    for (const v of this.cars) {
      const c = cars[v.index];
      if (!c) continue;
      Object.assign(v.pose, { x: c.x, z: c.z, rotY: c.rotY, speed: c.speed, steer: c.steer });
      this.show(v);
    }
  }

  /** Puts car `i` at `pose` (your own driving). */
  place(i: number, pose: CarPose) {
    const v = this.cars[i];
    if (!v) return;
    Object.assign(v.pose, pose);
    this.show(v);
  }

  /** Where someone sitting in `seat` of car `i` is: their feet (on the street; sitting lifts them) and the way they face. */
  seatAt(i: number, seat: CarSeat): { x: number; y: number; z: number; rotY: number } | undefined {
    const v = this.cars[i];
    if (!v) return undefined;
    const s = SEATS[seat];
    const at = carPoint(v.pose, s.x, s.z);
    return { x: at.x, y: this.street + (v.ride?.lift(s.x, s.z) ?? 0), z: at.z, rotY: v.pose.rotY };
  }

  /**
   * What a car bumps into on the street: whatever stands on it (the
   * garage's columns and walls, street lamps, trees, the elevator, the other cars), but not car
   * `except`'s own boxes. With `near`, only what's within `r` of (x, z): out on the scenic loop
   * there are trees by the thousand, nearly all of them nowhere near you.
   */
  solids(except: number, near?: { x: number; z: number; r: number }): Box[] {
    const own = this.cars[except]?.colliders;
    const out: Box[] = [];
    for (const c of this.all) {
      // Far from the car first (nearly every tree on the loop is), the cheapest test there is.
      if (near && (c.minX > near.x + near.r || c.maxX < near.x - near.r || c.minZ > near.z + near.r || c.maxZ < near.z - near.r)) continue;
      // Not the ground itself (the lawn, the lots), nor anything overhead.
      if (own?.includes(c) || (c.bottom ?? 0) > this.street + 1 || c.top < this.street + 0.3) continue;
      // Nor the invisible fence keeping people out of the open sea: a car wades into it (see shared/terrain.ts).
      if (c.fence && c.minX <= SEA_FENCE) continue;
      out.push(c);
    }
    return out;
  }

  /**
   * Out of the way of a car that's come at you where you stand (x, z) on the street: shoved out
   * of its side, or its nose or tail if that's nearer, and off to the side from there, so it
   * doesn't push you along in front of it. Returns how fast it was going, or 0.
   */
  shove(pos: { x: number; y: number; z: number }, except: number | null): number {
    if (Math.abs(pos.y - this.street) > 0.4) return 0;
    const r = 0.32;
    for (const v of this.cars) {
      if (v.index === except) continue;
      const p = v.pose;
      const s = Math.sin(p.rotY);
      const c = Math.cos(p.rotY);
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      // Where you are in the car's own frame: across it (+ left), and along it (+ ahead).
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const hx = CAR.width / 2 + r;
      const hz = CAR.length / 2 + r;
      if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) continue;
      const side = hx - Math.abs(lx);
      const end = hz - Math.abs(lz);
      const aside = Math.sign(lx || 1);
      const out = side < end ? { x: aside * (hx + 0.01), z: lz } : { x: lx + aside * Math.min(side, 0.08), z: Math.sign(lz || 1) * (hz + 0.01) };
      const at = carPoint(p, out.x, out.z);
      pos.x = at.x;
      pos.z = at.z;
      return Math.abs(p.speed);
    }
    return 0;
  }

  /** Draws car `v` where its pose says, and moves its boxes and its interactable along with it. */
  private show(v: CarView) {
    const p = v.pose;
    v.root.position.set(p.x, STREET_Y, p.z);
    v.root.rotation.y = p.rotY;
    for (const w of v.wheels) w.rotation.y = p.steer;
    const s = Math.abs(Math.sin(p.rotY));
    const c = Math.abs(Math.cos(p.rotY));
    const hx = CAR.width / 2 - 0.08;
    const height = carHeight(v.def.kind);
    const len = (CAR.length - 0.16) / SLICES;
    // Along the body a slice at a time, each slice's box round it as turned.
    for (let i = 0; i < SLICES; i++) {
      const mid = carPoint(p, 0, -CAR.length / 2 + 0.08 + len * (i + 0.5));
      const ex = c * hx + (s * len) / 2;
      const ez = s * hx + (c * len) / 2;
      Object.assign(v.colliders[i], { minX: mid.x - ex, maxX: mid.x + ex, minZ: mid.z - ez, maxZ: mid.z + ez, bottom: this.street, top: this.street + height.body });
    }
    // The roof, over the cabin; with it off, only the body's there to stand on.
    const roof = carPoint(p, 0, -0.6);
    const rx = c * 0.6 + s * 0.7;
    const rz = s * 0.6 + c * 0.7;
    Object.assign(v.colliders[SLICES], { minX: roof.x - rx, maxX: roof.x + rx, minZ: roof.z - rz, maxZ: roof.z + rz, bottom: this.street, top: this.street + (v.occupied ? height.body : height.roof) });
    Object.assign(v.interactable, { x: p.x, z: p.z, y: this.street });
  }
}

declare module '../../world/types' {
  interface OfficeHandles {
    /** The Lambos and Ferraris in the garage, which anyone can drive (see controller.ts). */
    cars: Fleet;
  }
}

/** The floor's cars, down in the garage under it. */
export const cars: Fixture<'cars', StreetSite> = (site) => {
  // The cars move, so their boxes go in with the floor's and follow them (and the street) themselves,
  // rather than going down with the street's.
  const fleet = new Fleet(site.colliders, site.interactables);
  site.ground.add(fleet.group);
  return { handle: { cars: fleet }, setLevel: (index) => fleet.setStreet(streetBelow(index)) };
};
