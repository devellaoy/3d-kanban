// The ghost of your best lap: a car's pose sampled at a fixed rate through a lap (from the line to the
// line), kept compact for localStorage, and played back with interpolation. Pure: no DOM, no three.

/** Seconds between samples (10 a second). */
export const GHOST_DT = 0.1;
/** The most samples a lap keeps (ten minutes): a lap that long was never going to be a record. */
const MAX_POINTS = 6000;
const VERSION = 1;

export interface GhostPose {
  x: number;
  z: number;
  rotY: number;
}

/** A lap's path: `pts[i]` is where the car was `i * GHOST_DT` seconds after the line; `time` is the whole lap. */
export interface GhostPath {
  time: number;
  pts: GhostPose[];
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Samples the pose of a car each GHOST_DT through one lap. */
export class GhostRecorder {
  private pts: GhostPose[] = [];
  private t0: number | null = null;

  get recording(): boolean {
    return this.t0 !== null;
  }

  /** A lap starts at `now` (seconds): whatever was recorded before is dropped. */
  begin(now: number) {
    this.pts = [];
    this.t0 = now;
  }

  /** Forget the lap (the car's out of the running). */
  cancel() {
    this.pts = [];
    this.t0 = null;
  }

  /** The car is at `pose` at `now`: it takes the samples due by now (a slow frame repeats the pose across the gap). */
  sample(now: number, pose: GhostPose) {
    if (this.t0 === null) return;
    const upto = Math.min(MAX_POINTS - 1, Math.floor((now - this.t0) / GHOST_DT + 1e-9));
    while (this.pts.length <= upto) this.pts.push({ x: pose.x, z: pose.z, rotY: pose.rotY });
  }

  /** The lap is over at `now`: its path (null if nothing was being recorded), and it starts over from nothing. */
  finish(now: number, pose: GhostPose): GhostPath | null {
    if (this.t0 === null) return null;
    const time = now - this.t0;
    this.sample(now, pose);
    const path: GhostPath = { time, pts: this.pts };
    this.cancel();
    return path.pts.length >= 2 && time > 0 ? path : null;
  }
}

/** Where the ghost is `t` seconds into its lap (held at the start before it, and at the line once it's done). */
export function poseAt(path: GhostPath, t: number): GhostPose {
  const last = path.pts.length - 1;
  if (last < 1) return { ...path.pts[0] };
  const f = Math.min(last, Math.max(0, t / GHOST_DT));
  const i = Math.min(last - 1, Math.floor(f));
  const u = f - i;
  const a = path.pts[i];
  const b = path.pts[i + 1];
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, rotY: wrap(a.rotY + wrap(b.rotY - a.rotY) * u) };
}

/** Whether the ghost has finished its lap `t` seconds in. */
export const ghostDone = (path: GhostPath, t: number): boolean => t > path.time;

/**
 * A path as one short string: the version, the lap's time, and then every sample as integer deltas in
 * base 36 (a decimetre in x and z, a hundredth of a radian in the heading), about 8 bytes a sample.
 */
export function encodePath(path: GhostPath): string {
  let px = 0;
  let pz = 0;
  let pr = 0;
  const out: string[] = [];
  for (const p of path.pts) {
    const x = Math.round(p.x * 10);
    const z = Math.round(p.z * 10);
    const r = Math.round(wrap(p.rotY) * 100);
    out.push((x - px).toString(36), (z - pz).toString(36), (r - pr).toString(36));
    px = x;
    pz = z;
    pr = r;
  }
  return `${VERSION};${path.time.toFixed(3)};${out.join(',')}`;
}

/** The inverse of encodePath; null for anything that isn't one (a damaged or older value). */
export function decodePath(text: string | null | undefined): GhostPath | null {
  if (typeof text !== 'string') return null;
  const [version, time, data] = text.split(';');
  const t = Number(time);
  if (Number(version) !== VERSION || !(t > 0) || data === undefined || data === '') return null;
  const nums = data.split(',').map((s) => parseInt(s, 36));
  if (nums.length % 3 !== 0 || nums.length < 6 || nums.length / 3 > MAX_POINTS || nums.some((n) => !Number.isFinite(n))) return null;
  const pts: GhostPose[] = [];
  let x = 0;
  let z = 0;
  let r = 0;
  for (let i = 0; i < nums.length; i += 3) {
    x += nums[i];
    z += nums[i + 1];
    r += nums[i + 2];
    pts.push({ x: x / 10, z: z / 10, rotY: r / 100 });
  }
  return { time: t, pts };
}
