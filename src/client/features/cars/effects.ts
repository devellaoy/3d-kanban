import * as THREE from 'three';
import { DRIVE, carPoint, roughAt } from '../../../shared/garage';
import { STREET_Y } from '../../../shared/layout';
import type { CarView } from './world';

// What driving looks like beyond the car itself: tyre smoke and skid marks when it slides or brakes
// hard, dust off the road, the nitro's flames, and the body leaning into corners and pitching on the
// brakes. All of it is worked out from how each car is seen to move (the same for yours and for
// everyone else's), so nothing here is sent anywhere.

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A material that's one flat color and fades by a per-instance `aFade` (0 to 1), for smoke, dust and skid marks. */
function fading(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, fog: false });
  m.onBeforeCompile = (shader, renderer) => {
    // The office puts its haze on every material this way (world/sky.ts): keep it.
    THREE.Material.prototype.onBeforeCompile.call(m, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;').replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFade;');
  };
  return m;
}

// Puff colors, parsed once.
const SMOKE = new THREE.Color('#f2f2f8');
const DUST = [new THREE.Color('#c8c08e'), new THREE.Color('#aab37c')] as const;
const FLAME = [new THREE.Color('#ffe066'), new THREE.Color('#ff7b00')] as const;

/** Puffs of smoke, dust and flame: little spheres that grow, drift and fade. */
export class Puffs {
  readonly mesh: THREE.InstancedMesh;
  private fade: Float32Array;
  private live: { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; s0: number; s1: number; a: number }[] = [];
  private next = 0;
  private active = 0;
  private dummy = new THREE.Object3D();

  constructor(private max: number) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    this.fade = new Float32Array(max);
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.fade, 1));
    this.mesh = new THREE.InstancedMesh(geo, fading('#ffffff'), max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
    for (let i = 0; i < max; i++) this.live.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 1, s0: 0, s1: 0, a: 0 });
  }

  /** One puff: from (x, y, z) moving (vx, vy, vz) for `life` seconds, growing from size s0 to s1, at most `a` solid, in `color`. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, a: number, color: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const p = this.live[i];
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.age = 0;
    p.life = life;
    p.s0 = s0;
    p.s1 = s1;
    p.a = a;
    this.mesh.setColorAt(i, color);
    this.mesh.instanceColor!.needsUpdate = true;
    this.active = this.max;
  }

  /** Moves everything on `dt` seconds; false once nothing's left to draw. */
  update(dt: number): boolean {
    if (this.active === 0) return false;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const p = this.live[i];
      if (p.age >= p.life) {
        this.fade[i] = 0;
        this.dummy.scale.setScalar(0);
      } else {
        alive++;
        p.age += dt;
        const u = clamp(p.age / p.life, 0, 1);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.scale.setScalar(p.s0 + (p.s1 - p.s0) * u);
        this.fade[i] = p.a * (1 - u) * Math.min(1, u * 8);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.count = this.max;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
    if (alive === 0) {
      this.active = 0;
      this.mesh.count = 0;
    }
    return alive > 0;
  }
}

/** Skid marks: dark strips on the ground, laid down behind a sliding tyre and fading away. */
export class Skids {
  readonly mesh: THREE.InstancedMesh;
  private fade: Float32Array;
  private born: Float32Array;
  private next = 0;
  private clock = 0;
  private any = false;
  private dummy = new THREE.Object3D();

  constructor(private max: number, private life = 14) {
    const geo = new THREE.PlaneGeometry(0.34, 1).rotateX(-Math.PI / 2);
    this.fade = new Float32Array(max);
    this.born = new Float32Array(max).fill(-1e9);
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.fade, 1));
    const mat = fading('#15151c');
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
  }

  /** A strip of mark `length` long, centered on (x, z), along heading `yaw`. */
  stamp(x: number, z: number, yaw: number, length: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.born[i] = this.clock;
    this.dummy.position.set(x, STREET_Y + 0.075, z);
    this.dummy.rotation.set(0, yaw, 0);
    this.dummy.scale.set(1, 1, length);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.any = true;
  }

  update(dt: number) {
    this.clock += dt;
    if (!this.any) return;
    let alive = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const age = this.clock - this.born[i];
      this.fade[i] = age >= this.life ? 0 : 0.62 * Math.min(1, (this.life - age) / (this.life * 0.5));
      if (this.fade[i] > 0) alive = true;
    }
    (this.mesh.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;
    if (!alive) {
      this.any = false;
      this.mesh.count = 0;
      this.next = 0;
    }
  }
}

/** What's been seen of one car's movement, to work out how it's going. */
interface Track {
  x: number;
  z: number;
  rotY: number;
  long: number;
  roll: number;
  pitch: number;
  longAcc: number;
  skid: ({ x: number; z: number } | null)[];
  smoke: number;
  dust: number;
  fire: number;
  /** Whether it looks to be on the nitro: over top speed and not slowing down (with some slack either way, so it doesn't flicker). */
  burn: boolean;
}

/** Roll and pitch of the body, as far as it leans (radians). */
const MAX_ROLL = 0.07;
const MAX_PITCH = 0.05;

/** Tyre smoke, skid marks, dust, nitro flames and the body's lean for a fleet's cars (see CarView). */
export class DriveEffects {
  readonly group = new THREE.Group();
  private puffs = new Puffs(260);
  private skids = new Skids(700);
  private tracks = new Map<number, Track>();

  constructor() {
    this.group.add(this.skids.mesh, this.puffs.mesh);
  }

  /** `dt` seconds on: every car in `cars` as it's drawn now. `mine`: the car you're driving, and whether you've the nitro on. */
  update(dt: number, cars: readonly CarView[], mine: { car: number; nitro: boolean } | null) {
    if (dt > 0 && dt < 0.5) for (const v of cars) this.car(v, dt, mine?.car === v.index ? mine.nitro : null);
    this.skids.update(dt);
    this.puffs.update(dt);
  }

  private car(v: CarView, dt: number, nitro: boolean | null) {
    const p = v.pose;
    let t = this.tracks.get(v.index);
    const sin = Math.sin(p.rotY);
    const cos = Math.cos(p.rotY);
    if (!t || Math.hypot(p.x - t.x, p.z - t.z) > 4 + 90 * dt) {
      t = { x: p.x, z: p.z, rotY: p.rotY, long: 0, roll: 0, pitch: 0, longAcc: 0, skid: [null, null], smoke: 0, dust: 0, fire: 0, burn: false };
      this.tracks.set(v.index, t);
    }
    // How it's moving, from where it's been seen: along its nose, across it, and how fast it's turning.
    const vx = (p.x - t.x) / dt;
    const vz = (p.z - t.z) / dt;
    const long = vx * sin + vz * cos;
    const lat = vx * cos - vz * sin;
    const speed = Math.hypot(vx, vz);
    const yawRate = wrap(p.rotY - t.rotY) / dt;
    const longAcc = t.longAcc + ((long - t.long) / dt - t.longAcc) * Math.min(1, dt * 10);
    t.x = p.x;
    t.z = p.z;
    t.rotY = p.rotY;
    t.long = long;
    t.longAcc = longAcc;

    // Leaning into the corner (outward) and pitching on the brakes and the gas.
    const k = Math.min(1, dt * 7);
    t.roll += (clamp(long * yawRate * 0.0021, -MAX_ROLL, MAX_ROLL) - t.roll) * k;
    t.pitch += (clamp(-longAcc * 0.0016, -MAX_PITCH, MAX_PITCH) - t.pitch) * k;
    v.tilt.rotation.set(t.pitch, 0, t.roll);

    const sliding = speed > 8 ? clamp((Math.abs(lat) - 3.2) / 7, 0, 1) : 0;
    const braking = speed > 14 && longAcc < -22 ? 0.7 : 0;
    const grip = Math.max(sliding, braking);
    // Under the rear tyres, a skid mark each half meter and smoke.
    for (let w = 0; w < 2; w++) {
      const at = carPoint(p, w ? 0.8 : -0.8, -1.35);
      const last = t.skid[w];
      if (grip > 0 && roughAt(at.x, at.z) < 1) {
        if (!last) t.skid[w] = at;
        else if (Math.hypot(at.x - last.x, at.z - last.z) > 0.5) {
          this.skids.stamp((at.x + last.x) / 2, (at.z + last.z) / 2, Math.atan2(at.x - last.x, at.z - last.z), Math.hypot(at.x - last.x, at.z - last.z) + 0.12);
          t.skid[w] = at;
        }
      } else t.skid[w] = null;
    }
    if (grip > 0) {
      t.smoke += dt * (30 + 70 * grip);
      while (t.smoke >= 1) {
        t.smoke--;
        const at = carPoint(p, (Math.random() < 0.5 ? -1 : 1) * 0.8 + (Math.random() - 0.5) * 0.4, -1.35 + (Math.random() - 0.5) * 0.4);
        this.puffs.spawn(at.x, STREET_Y + 0.25, at.z, vx * 0.25 + (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 0.7, vz * 0.25 + (Math.random() - 0.5) * 1.2, 0.7 + Math.random() * 0.5, 0.3, 1.1 + 0.6 * grip, 0.32 * grip + 0.08, SMOKE);
      }
    }
    // Dust off the pavement.
    if (speed > 6 && roughAt(p.x, p.z) > 0) {
      t.dust += dt * Math.min(90, speed * 1.8);
      while (t.dust >= 1) {
        t.dust--;
        const at = carPoint(p, (Math.random() - 0.5) * 1.8, -1.2 + (Math.random() - 0.5) * 1.2);
        this.puffs.spawn(at.x, STREET_Y + 0.2, at.z, vx * 0.2 + (Math.random() - 0.5) * 2, 0.7 + Math.random(), vz * 0.2 + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.5, 0.3, 1.5, 0.4, DUST[Math.random() < 0.5 ? 0 : 1]);
      }
    }
    // The nitro: yours when it's on; someone else's when they're over what a car does on the gas alone and
    // still not slowing (it lights at top + 1.5 m/s holding or gaining speed, and goes out once they ease
    // off or fall back to top speed), so a car still coasting down from the nitro stops showing flames.
    t.burn = t.burn ? p.speed > DRIVE.top + 0.5 && longAcc > -6 : p.speed > DRIVE.top + 1.5 && longAcc > -2;
    if (nitro ?? t.burn) {
      t.fire += dt * 120;
      while (t.fire >= 1) {
        t.fire--;
        const side = Math.random() < 0.5 ? -1 : 1;
        const at = carPoint(p, side * 0.45, -2.3);
        const back = 4 + Math.random() * 4;
        this.puffs.spawn(at.x, STREET_Y + 0.5 + Math.random() * 0.06, at.z, vx * 0.92 - sin * back, 0.2, vz * 0.92 - cos * back, 0.12 + Math.random() * 0.1, 0.34, 0.06, 0.95, FLAME[Math.random() < 0.45 ? 0 : 1]);
      }
    }
  }

  /** Whether car `i` looks to be on the nitro (yours: whatever you had last frame is passed to update). */
  burning(i: number): boolean {
    return this.tracks.get(i)?.burn ?? false;
  }

  /** The car isn't being watched any more (a different floor): forget how it was moving. */
  forget() {
    this.tracks.clear();
  }
}
