import { FLOOR, ROAD, WALL_T } from './layout.js';
import { STREET_END, onLoop } from './scenic.js';
import { terrainOk } from './terrain.js';

// The Lambos and Ferraris in the garage, which anyone can drive: where they're parked, where you can
// take them (anywhere on the ground: the pavement is quickest, the grass slower; see drivable), and
// the arcade physics a driver's own page runs. Everyone else on the floor sees the car where its
// driver says it is.

export type CarKind = 'lambo' | 'ferrari';

/** A car's footprint (nose to tail along its length), and how high its body and its roof come up. */
export const CAR = { length: 4.6, width: 2, body: 0.82, roof: 1.12 } as const;

/** The building's footprint, walls included: the garage is under it. */
const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;

/** Somewhere flat on the ground, x and z. */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The paved lot in front of the garage, out to the sidewalk, and the one down its east side. */
export const LOT: Box = { minX: -30, maxX: 30, minZ: B.maxZ, maxZ: 21 };
export const SIDE_LOT: Box = { minX: B.maxX, maxX: B.maxX + 12, minZ: B.minZ - 2, maxZ: B.maxZ + 4 };

/**
 * The pavement besides the scenic loop's (see shared/scenic.ts), which takes over from either end of
 * the street: the garage (inside its back and west walls, open to the south and east), the lots round
 * it, across the sidewalk and along the street. Off it a car drives on the grass, slower.
 */
export const PAVEMENT: Box[] = [
  { minX: FLOOR.minX, maxX: B.maxX, minZ: FLOOR.minZ, maxZ: B.maxZ },
  { ...LOT, maxZ: ROAD.minZ },
  SIDE_LOT,
  { minX: -STREET_END, maxX: STREET_END, minZ: ROAD.minZ, maxZ: ROAD.maxZ },
];

export interface CarDef {
  kind: CarKind;
  color: string;
  /** What the hint calls it: "Orange Lambo". */
  name: string;
  /** Its spot: where it's parked when the office starts, and which way its nose points (0 is +z). */
  x: number;
  z: number;
  rotY: number;
}

// Lambos nose-in along the back wall, Ferraris backed in facing the street, and one out front.
const BACK = B.minZ + WALL_T + 0.4 + CAR.length / 2;
const FRONT = B.maxZ - 0.5 - CAR.length / 2;
export const CARS: readonly CarDef[] = [
  { kind: 'lambo', color: '#8ac926', name: 'Lime Lambo', x: -14.4, z: BACK, rotY: Math.PI },
  { kind: 'lambo', color: '#ff7b00', name: 'Orange Lambo', x: -8, z: BACK, rotY: Math.PI },
  { kind: 'lambo', color: '#ffd000', name: 'Yellow Lambo', x: 1.6, z: BACK, rotY: Math.PI },
  { kind: 'lambo', color: '#7b2cbf', name: 'Purple Lambo', x: 11.2, z: BACK, rotY: Math.PI },
  { kind: 'ferrari', color: '#d90429', name: 'Red Ferrari', x: -14.4, z: FRONT, rotY: 0 },
  { kind: 'ferrari', color: '#d90429', name: 'Rosso Ferrari', x: -4.8, z: FRONT, rotY: 0 },
  { kind: 'ferrari', color: '#ffc300', name: 'Giallo Ferrari', x: 4.8, z: FRONT, rotY: 0 },
  { kind: 'ferrari', color: '#e5383b', name: 'Scarlet Ferrari', x: 14.4, z: FRONT, rotY: 0 },
  // Left out front, for everyone upstairs to look at.
  { kind: 'lambo', color: '#00b4d8', name: 'Blue Lambo', x: 9, z: 18.2, rotY: Math.PI / 2 },
];

export type CarSeat = 'driver' | 'passenger';

/**
 * Where the two of you sit, in the car's own frame (x across, +x on the driver's left side; z toward
 * the nose), and how high your hips are off the ground. Your head's up out of the top: with anyone
 * in it, the roof comes off.
 */
export const SEATS: Record<CarSeat, { x: number; z: number }> = { driver: { x: 0.42, z: -0.5 }, passenger: { x: -0.42, z: -0.5 } };
export const SEAT_HIPS = 0.45;

/**
 * A car where it is and how it's going: `speed` in m/s along its nose (negative in reverse), `steer` the front wheels' angle (+ is left).
 * Its driver's own page also keeps `slip` (m/s it's sliding sideways, + to the left) and `nitro` (the boost meter, 0 to 1); neither
 * is sent on: the office and everyone else see where the car is and which way it points.
 */
export interface CarPose {
  x: number;
  z: number;
  rotY: number;
  speed: number;
  steer: number;
  slip?: number;
  nitro?: number;
}

/** A car as the office has it: where it is, and who's in it (PeerInfo ids). */
export interface CarState extends CarPose {
  driver?: string;
  passenger?: string;
}

/** Every car in its spot, as the office starts. */
export function parked(): CarState[] {
  return CARS.map((c) => ({ x: c.x, z: c.z, rotY: c.rotY, speed: 0, steer: 0 }));
}

/**
 * The pedals and the wheel: `gas` 1 forward, -1 back (and braking first, hard, if you're going the
 * other way), `turn` +1 hard left, `brake` the handbrake (it lets the tail go: a drift), `boost` the nitro.
 */
export interface Pedals {
  gas: number;
  turn: number;
  brake: boolean;
  boost?: boolean;
}

export const DRIVE = {
  /** Flat out, forward and in reverse (m/s); and flat out on nitro. */
  top: 48,
  boostTop: 64,
  reverse: 12,
  /** Speeding up from a standstill, forward and back, and the extra push of the nitro (m/s²): less the nearer top speed it gets. */
  accel: 17,
  boostAccel: 14,
  reverseAccel: 8,
  /** Slowing down on the foot brake (S), on the handbrake, and rolling with no gas (m/s²); the air's drag on top of that, per m/s squared. */
  brake: 34,
  handbrake: 14,
  coast: 2.5,
  drag: 0.0028,
  /** Slowing down more on grass (m/s²). */
  rough: 8,
  /** Between the axles (m): how tight it turns. */
  wheelbase: 2.8,
  /** How far the front wheels turn at a crawl (radians): less the faster you go, so it doesn't spin out. */
  steer: 0.6,
  /** How fast they turn (radians a second). */
  steerRate: 3.6,
  /** The most sideways push the tyres hold (m/s²); past it the car slides. On the handbrake, and on grass, they hold less. */
  grip: 36,
  /** The nitro meter: how fast it empties while it's on, and fills while it's off (per second). */
  nitroUse: 0.33,
  nitroFill: 0.14,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How far the front wheels can turn at `speed`. */
export function steerLimit(speed: number): number {
  return DRIVE.steer / (1 + (Math.abs(speed) / 12) ** 1.6);
}

/** The gearbox, for the engine's note and the dash: six gears, each good for this many m/s; the nitro takes it past the sixth. */
export const GEAR_SPAN = 9;
export const GEARS = 6;

/** The gear (1 to 6) a car's in at `speed` m/s. */
export function gearOf(speed: number): number {
  return Math.min(GEARS, 1 + Math.floor(Math.abs(speed) / GEAR_SPAN));
}

/** Whether the pedals have the nitro on, given the meter. */
export function boosting(p: Pick<CarPose, 'speed' | 'nitro'>, pedals: Pedals): boolean {
  return !!pedals.boost && pedals.gas > 0 && p.speed > -0.5 && (p.nitro ?? 1) > 0;
}

/**
 * The car `dt` seconds on, with these pedals, over ground that's `rough` (0 pavement, 1 grass): a
 * bicycle model with a grip limit. Its velocity is the nose's speed and the sideways slip; the tyres
 * take the slip out as fast as they hold (DRIVE.grip), so a hard turn at speed, or the handbrake, has
 * the car slide.
 */
export function drive(p: CarPose, pedals: Pedals, dt: number, rough = 0): CarPose {
  const hand = pedals.brake;
  const gas = clamp(pedals.gas, -1, 1);
  const on = boosting(p, pedals);
  const nitro = clamp((p.nitro ?? 1) + (on ? -DRIVE.nitroUse : pedals.boost ? 0 : DRIVE.nitroFill) * dt, 0, 1);
  const cap = on ? DRIVE.boostTop : DRIVE.top;
  const want = clamp(pedals.turn, -1, 1) * steerLimit(Math.hypot(p.speed, p.slip ?? 0));
  const steer = p.steer + clamp(want - p.steer, -DRIVE.steerRate * dt, DRIVE.steerRate * dt);

  let v = p.speed;
  const toward = (target: number, rate: number) => (v += clamp(target - v, -rate * dt, rate * dt));
  const drag = DRIVE.drag * v * v;
  if (gas > 0) {
    if (v < 0) toward(0, DRIVE.brake);
    else if (v > DRIVE.top && !on) v = Math.max(DRIVE.top, v - (4 + drag) * dt);
    else {
      const push = (on ? DRIVE.accel + DRIVE.boostAccel : DRIVE.accel) * (1 - 0.85 * (v / cap) ** 2) * (1 - 0.2 * rough);
      v = Math.max(0, Math.min(cap, v + (push - rough * DRIVE.rough) * gas * dt));
    }
  } else if (gas < 0) {
    if (v > 0) toward(0, DRIVE.brake);
    else v = Math.max(-DRIVE.reverse, v + (DRIVE.reverseAccel * gas + rough * DRIVE.rough * 0.3) * dt);
  } else toward(0, DRIVE.coast + drag + rough * DRIVE.rough);
  if (hand) toward(0, DRIVE.handbrake);

  // The bicycle model turns the car; the rear lets go on the handbrake, so it swings round more.
  const swing = hand ? 1 + 0.3 * clamp((Math.abs(v) - 5) / 10, 0, 1) : 1;
  const yaw = ((v * Math.tan(steer)) / DRIVE.wheelbase) * swing;
  const d = yaw * dt;
  // The way it's going stays put in the world while the car turns under it: that's the slip.
  const slip = p.slip ?? 0;
  const long = v * Math.cos(d) + slip * Math.sin(d);
  let lat = -v * Math.sin(d) + slip * Math.cos(d);
  // The tyres take it out, as fast as they can hold.
  const held = DRIVE.grip * (hand ? 0.25 : 1) * (1 - 0.35 * rough);
  lat -= clamp(lat * (1 - Math.exp(-(hand ? 1.2 : 6) * dt)), -held * dt, held * dt);
  const mid = p.rotY + d / 2;
  return {
    x: p.x + (Math.sin(mid) * long + Math.cos(mid) * lat) * dt,
    z: p.z + (Math.cos(mid) * long - Math.sin(mid) * lat) * dt,
    rotY: Math.atan2(Math.sin(p.rotY + d), Math.cos(p.rotY + d)),
    speed: long,
    steer,
    slip: lat,
    nitro,
  };
}

/** A point in the car's own frame (x across, +x left; z toward the nose), out in the world. */
export function carPoint(p: { x: number; z: number; rotY: number }, lx: number, lz: number): { x: number; z: number } {
  const s = Math.sin(p.rotY);
  const c = Math.cos(p.rotY);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** Whether (x, z) is pavement: the garage, the lots, the street or the loop. Anywhere else is grass, which a car drives on too, slower. */
export function paved(x: number, z: number): boolean {
  return PAVEMENT.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) || onLoop(x, z);
}

/** The garage's back and west walls: the building's footprint but for the garage itself (open to the south and east). */
function inWall(x: number, z: number): boolean {
  if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) return false;
  const g = PAVEMENT[0];
  return !(x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ);
}

/**
 * Whether a car can be at (x, z): anywhere on the ground inside the edge of the world, but for the
 * garage's walls and well out into the sea or the lake (see shared/terrain.ts). What stands in the
 * way (trees, fences, buildings, the other cars) is the driver's page to bump into.
 */
export function drivable(x: number, z: number): boolean {
  return !inWall(x, z) && terrainOk(x, z);
}

/** How rough the ground is under (x, z): 0 on the pavement, 1 on grass. */
export function roughAt(x: number, z: number): number {
  return paved(x, z) ? 0 : 1;
}

/** The car's corners, and halfway along each side, in its own frame. */
const OUTLINE: readonly (readonly [number, number])[] = [
  [CAR.width / 2, CAR.length / 2],
  [-CAR.width / 2, CAR.length / 2],
  [CAR.width / 2, -CAR.length / 2],
  [-CAR.width / 2, -CAR.length / 2],
  [CAR.width / 2, 0],
  [-CAR.width / 2, 0],
  [0, CAR.length / 2],
  [0, -CAR.length / 2],
];

/** Whether the whole car is somewhere it can be (see drivable). */
export function inBounds(p: { x: number; z: number; rotY: number }): boolean {
  return OUTLINE.every(([lx, lz]) => {
    const at = carPoint(p, lx, lz);
    return drivable(at.x, at.z);
  });
}

/** Whether the whole car is on the pavement. */
export function onPavement(p: { x: number; z: number; rotY: number }): boolean {
  return OUTLINE.every(([lx, lz]) => {
    const at = carPoint(p, lx, lz);
    return paved(at.x, at.z);
  });
}

/** Whether the car's footprint (a rectangle turned by rotY) overlaps box `b` (separating axes). */
export function overlaps(p: { x: number; z: number; rotY: number }, b: Box): boolean {
  const hx = CAR.width / 2;
  const hz = CAR.length / 2;
  const ex = (b.maxX - b.minX) / 2;
  const ez = (b.maxZ - b.minZ) / 2;
  const dx = (b.minX + b.maxX) / 2 - p.x;
  const dz = (b.minZ + b.maxZ) / 2 - p.z;
  const s = Math.abs(Math.sin(p.rotY));
  const c = Math.abs(Math.cos(p.rotY));
  if (Math.abs(dx) >= c * hx + s * hz + ex) return false;
  if (Math.abs(dz) >= s * hx + c * hz + ez) return false;
  const sn = Math.sin(p.rotY);
  const cs = Math.cos(p.rotY);
  // Across the car, and along it.
  if (Math.abs(dx * cs - dz * sn) >= hx + ex * c + ez * s) return false;
  if (Math.abs(dx * sn + dz * cs) >= hz + ex * s + ez * c) return false;
  return true;
}

/** Whether the car can be at `p`: somewhere it can drive (see drivable), clear of all of `solids`. */
export function carFits(p: { x: number; z: number; rotY: number }, solids: Iterable<Box>): boolean {
  if (!inBounds(p)) return false;
  for (const b of solids) if (overlaps(p, b)) return false;
  return true;
}
