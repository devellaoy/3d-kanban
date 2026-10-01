import * as THREE from 'three';
import { FLOOR, SLAB, STREET_Y, WALL_T, WING, inWing, wingMinZ, type SeatPlace } from '../shared/layout';
import type { ViewMode } from './state';
import type { Collider } from './world/office';

const RADIUS = 0.32;
/** Top of your head above your feet, for walking under the loft. */
const HEIGHT = 1.7;
/** The tallest ledge you walk up (or down) without jumping, like a stair. */
const STEP = 0.3;
const WALK = 4.6;
const RUN = 7.5;
const JUMP_V = 6.4;
const GRAVITY = 18;
/** Camera height above your feet in first person (the Person's eyes). */
export const EYE_HEIGHT = 1.4;
/** The Person's hips above their feet, standing. Sitting puts them on the seat, and your eyes move with them. */
export const HIPS = 0.42;
/** Keys that get you up off a seat: walking away, or jumping up. */
const GET_UP = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
const LOOK_SPEED = 0.0022; // radians per pixel of mouse movement while the pointer is locked
const DRAG_LOOK_SPEED = 0.005;
/**
 * Taking the mouse back from a click (see lock's `settle`): how long it must rest once it's taken
 * before it looks around, in ms, and how long at most the view is held still for. Just the flick of
 * the hand that clicked: any longer and looking around straight away feels like the mouse is gone.
 */
const SETTLE_REST = 100;
const SETTLE_MAX = 150;
const CENTER = new THREE.Vector2(0, 0);
// 3d-kanban: third person looks around like first person (see docs/controls.md): the mouse turns
// the camera, which sits behind you and over your right shoulder, so the crosshair isn't on you.
/** How far right of your head the third-person camera looks past, in meters. */
export const SHOULDER = 0.75;
/** How far the third-person camera tips: a little from below you, up to looking well down on you. */
export const THIRD_PITCH_MIN = -0.3;
export const THIRD_PITCH_MAX = 1.3;
/** Height of the point the third-person camera looks at, above your feet. */
const THIRD_TARGET = 1.3;

/** 3d-kanban: where the third-person camera sits from the point it looks at, for its heading, tilt and distance. */
export function orbitOffset(yaw: number, pitch: number, dist: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
}

/** 3d-kanban: `side` meters to the right of a camera with heading `yaw` (it looks along -sin, -cos). */
export function shoulderOffset(yaw: number, side = SHOULDER, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.cos(yaw) * side, 0, -Math.sin(yaw) * side);
}

/**
 * 3d-kanban: how far along a ray (unit `dir` from `origin`) `at` is: from the third-person camera,
 * what the crosshair's ray meets before it gets to you is behind you (or you), and doesn't count.
 */
export function alongRay(origin: THREE.Vector3, dir: THREE.Vector3, at: THREE.Vector3): number {
  return Math.max(0, (at.x - origin.x) * dir.x + (at.y - origin.y) * dir.y + (at.z - origin.z) * dir.z);
}

/** 3d-kanban: whether something the crosshair's ray hit at `point` is within `reach` of your eyes (not the camera). */
export function withinReach(point: THREE.Vector3, eye: THREE.Vector3, reach: number): boolean {
  return point.distanceTo(eye) <= reach;
}

/**
 * 3d-kanban: whether your eyes see `point`, not just the camera over your shoulder: nothing among
 * `objects` that `blocks` (a wall, say, not the thing itself) is on the way to it from `eye`.
 * `camera` is the one the scene is drawn with: a sprite (a name tag, a sign) faces it, and
 * three.js throws on a ray without one that meets a sprite, which stopped every frame after it.
 */
export function eyeSees(eye: THREE.Vector3, point: THREE.Vector3, objects: THREE.Object3D[], blocks: (hit: THREE.Intersection) => boolean, camera: THREE.Camera, rc = new THREE.Raycaster()): boolean {
  const dist = eye.distanceTo(point);
  // Short of the point itself, so the surface that was hit doesn't count as in the way of itself.
  if (dist < 0.03) return true;
  rc.set(eye, point.clone().sub(eye).divideScalar(dist));
  rc.camera = camera;
  rc.near = 0;
  rc.far = dist - 0.02;
  return !rc.intersectObjects(objects, true).some(blocks);
}

/** 3d-kanban: a tap or click at (clientX, clientY) on `rect`, in normalized device coordinates. */
export function tapNdc(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, out = new THREE.Vector2()): THREE.Vector2 {
  return out.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
}

export class PlayerController {
  pos = new THREE.Vector3();
  vy = 0;
  facing = Math.PI;
  moving = false;
  grounded = true;
  /** Heading of the camera. You look along (-sin, -cos) of it on the XZ plane. */
  camYaw = Math.PI * 0.15;
  camPitch = 0.42;
  camDist = 7.5;
  // 3d-kanban: the third-person camera follows camYaw/camPitch/camDist rigidly (the mouse, a turning car), except that a
  // jump in one (a seat, golf) or any zoom is left as a gap that eases out. last* are the values at the previous frame.
  private yawGap = 0;
  private pitchGap = 0;
  private distGap = 0;
  private lastYaw = Math.PI * 0.15;
  private lastPitch = 0.42;
  private lastDist = 7.5;
  /** Where updateCamera last put the camera: if it's elsewhere, golf or throwing moved it and it eases back. */
  private lastShown = new THREE.Vector3();
  /** 3d-kanban: how far the walls moved the camera off its ideal spot, as last shown and as last measured. */
  private shownCorr = new THREE.Vector3();
  private rawCorr = new THREE.Vector3();
  private lastIdeal = new THREE.Vector3();
  private corrEasing = false;
  private corrKnown = false;
  /** First-person look up (+) / down (-). */
  lookPitch = -0.08;
  view: ViewMode = 'first';
  /** Walk cycle phase, shared by the camera bob and the first-person hands. */
  walkPhase = 0;
  private bob = 0;
  /** Eased out after a step up or down, so the camera glides up stairs instead of popping. */
  stepOffset = 0;
  /** Walking and running speed, as a multiple of normal (a coffee's buzz). */
  speedBoost = 1;
  /** Jump speed, as a multiple of normal. */
  jumpBoost = 1;
  /** 0 (steady) to 1: how hard the view trembles after one coffee too many. */
  jitter = 0;
  /** How far below the floor you're on the street is: further down the higher your floor (see streetBelow). */
  street = STREET_Y;
  /**
   * The room the camera stays in while you're in it, and how thick its outside walls are: the
   * office's, unless the building's on a map of its own. `enclosed`: walled and roofed all round,
   * with no street or garage under it to see from.
   */
  room: { minX: number; maxX: number; minZ: number; maxZ: number; wall: number; enclosed: boolean; vault?: { minX: number; maxX: number; minZ: number; maxZ: number; top: number } } = { ...FLOOR, wall: WALL_T, enclosed: false };
  /** How many rows the floor's back office is built out (see WING): the camera keeps inside it too. */
  wing = 0;
  private jitterT = 0;
  /** How drunk you are (see booze.ts): the view rolls and sways, and you stagger as you walk. */
  drunk = 0;
  /** Where you're sitting, or null on your feet. You stay put there until you walk off or jump up. */
  seat: SeatPlace | null = null;
  /** You got up by walking off or jumping (not by stand()). */
  onStand: (() => void) | null = null;
  /** Corners still to walk through on your own (see walkPath), or null while you're steering. */
  private path: { x: number; z: number }[] | null = null;
  /** How long a walk along `path` has been getting nowhere. */
  private stuckFor = 0;
  /** A walk along a path ended: at its end, by a key of yours, or up against something. */
  onPathEnd: ((why: 'arrived' | 'cancelled' | 'stuck') => void) | null = null;
  /**
   * Something that has hold of you instead of your legs (the ladder, a fire pole): it moves you each
   * frame, with no walking, falling or bumping into things, and the camera follows.
   */
  rig: ((dt: number) => void) | null = null;
  /** The rig is a car (see driving.ts): out on the street or in the garage, not up a shaft indoors. */
  riding = false;
  /**
   * A click (not a drag) on the scene, in normalized device coordinates.
   * It is the crosshair, (0, 0), in third person too, but for a tap or click with the mouse free
   * there, which is where it landed (3d-kanban).
   */
  onClick: ((ndc: THREE.Vector2) => void) | null = null;
  private keys = new Set<string>();
  private drag: { x: number; y: number; moved: number } | null = null;
  /** Set when this browser won't lock the pointer; first person falls back to drag-to-look. */
  private lockFailed = false;
  private lockPending = false;
  private everLocked = false;
  /** Whether a click or key was behind the lock last asked for. Without one, a refusal is just the browser's rule. */
  private lockOnGesture = false;
  /** The page is letting go of the mouse itself, which isn't you pressing Esc or another tab taking it. */
  private letting = false;
  /**
   * Whether the page was the one to let go of the mouse last. Only then does the browser hand it
   * back without a click or key behind the asking, and the Esc that closes a window isn't one.
   */
  private letGo = false;
  /** Asked for while the page was still letting go of it: taken back as soon as it's free. */
  private lockAfter = false;
  /** When Esc last went down and hasn't come up yet (0 once it has). */
  private escDownAt = 0;
  /** Asked for while Esc was down: taken once it comes up (see lock). */
  private lockOnEscUp = false;
  /** The lock asked for is to settle (see lock), and until when (ms) a lock that landed so still is. */
  private settleNext = false;
  private settleUntil = 0;
  /** When the mouse last moved, or a lock that settles landed. */
  private movedAt = 0;
  enabled = true;
  /** False while the mouse picks something else (an emote on the wheel), so it doesn't turn the camera. */
  mouseLook = true;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    /** What you bump into and stand on: the office's, or the roof's up there. */
    public colliders: Collider[],
  ) {
    camera.rotation.order = 'YXZ';
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.escDownAt = 0;
      this.lockOnEscUp = false;
    });
    // Captured, since the window an Esc closes stops it going any further.
    window.addEventListener('keydown', (e) => e.key === 'Escape' && (this.escDownAt = performance.now()), true);
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key !== 'Escape') return;
        this.escDownAt = 0;
        const again = this.lockOnEscUp && this.enabled && this.canLock;
        this.lockOnEscUp = false;
        if (!again) return;
        // Taken here, the browser doesn't also treat this Esc as its own shortcut once the page is done
        // with it, which would let go of the mouse just taken.
        e.preventDefault();
        this.lock();
      },
      true,
    );

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'mouse' && !this.lockFailed) { // 3d-kanban: third person too
        if (this.locked) {
          if (e.button === 0) this.onClick?.(CENTER);
          return;
        }
        this.lock();
      }
      // Drag to look around without pointer lock (3d-kanban: in third person too, no more orbiting).
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    window.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      // A click that captured the mouse is not also a click on the world.
      if (!d || d.moved > 5 || !this.enabled || this.locked || this.lockPending || e.target !== dom) return;
      // 3d-kanban: in third person, with the mouse free (a touch screen), where you tapped, as upstream.
      this.onClick?.(this.view === 'first' ? CENTER : tapNdc(e.clientX, e.clientY, dom.getBoundingClientRect()));
    });
    window.addEventListener('pointermove', (e) => {
      const now = performance.now();
      const rested = now - this.movedAt;
      this.movedAt = now;
      if (!this.mouseLook) return;
      if (this.locked) {
        // Held for a moment under a window (see yieldMouse), the mouse doesn't turn your head.
        if (!this.enabled) return;
        // Taken back from a click, the hand that clicked may be moving on still: that isn't looking around.
        if (this.settleUntil) {
          if (rested < SETTLE_REST && now < this.settleUntil) return;
          this.settleUntil = 0;
        }
        // Some platforms report a bogus huge jump right after locking.
        const clamp = (v: number) => THREE.MathUtils.clamp(v, -250, 250);
        this.look(clamp(e.movementX) * LOOK_SPEED, clamp(e.movementY) * LOOK_SPEED);
        return;
      }
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.look(dx * DRAG_LOOK_SPEED, dy * DRAG_LOOK_SPEED); // 3d-kanban: no orbit, third person looks around too
    });
    document.addEventListener('pointerlockchange', () => {
      this.lockPending = false;
      if (!this.locked) {
        this.letGo = this.letting;
        this.letting = false;
        const again = this.lockAfter && this.enabled && this.canLock;
        this.lockAfter = false;
        if (again) this.lock();
        return;
      }
      this.everLocked = true;
      this.drag = null;
      // The pause to click doesn't count as the hand coming to rest: only once it's taken.
      if (this.settleNext) this.movedAt = performance.now();
      this.settleUntil = this.settleNext ? this.movedAt + SETTLE_MAX : 0;
      this.settleNext = false;
      // A lock that lands with a window open (the one yieldMouse takes, or a relock racing the next window) is let go.
      if (!this.enabled) this.unlock();
    });
    document.addEventListener('pointerlockerror', () => this.refused());
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.view === 'third') this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.01, 2.5, 16);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  get locked(): boolean {
    return document.pointerLockElement === this.dom;
  }

  /** Whether the mouse is captured and staying so: not while it's being let go of for a window. */
  get hasMouse(): boolean {
    return this.locked && !this.letting;
  }

  /** Whether clicking the scene will capture the mouse for looking around. */
  get canLock(): boolean {
    return !this.lockFailed && typeof this.dom.requestPointerLock === 'function'; // 3d-kanban: third person too
  }

  setView(view: ViewMode) {
    if (view === this.view) return;
    if (view === 'first') {
      this.lookPitch = -0.08;
      this.facing = this.camYaw + Math.PI;
    } else {
      // Start the orbit camera behind where you were looking.
      this.camYaw = this.facing - Math.PI;
      // 3d-kanban: the mouse stays captured, looking around in third person too.
    }
    this.view = view;
    this.updateCamera(true);
  }

  unlock() {
    this.lockAfter = false;
    this.lockOnEscUp = false;
    if (!this.locked) return;
    this.letting = true;
    document.exitPointerLock();
  }

  /**
   * Frees the mouse for a window over the game, so that `lock` gets it back when the window closes.
   * The browser only hands the mouse back without a click or key to a page that let go of it itself.
   * So when the mouse is free already (you pressed Esc to click something on screen), the click or
   * key that opens the window takes it for a moment, and it's let go as soon as it lands.
   */
  yieldMouse() {
    if (this.locked) return this.unlock();
    if (this.letGo || !this.canLock || !navigator.userActivation?.isActive) return;
    this.lock();
  }

  clearKeys() {
    this.keys.clear();
  }

  /** Whether any of these keys is held down (and you have the controls). */
  holding(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.keys.has(c));
  }

  /**
   * Captures the mouse for looking around, as the first click on the scene does. With `settle` (a
   * click just closed a window), the view holds still until the mouse comes to rest, so the rest of
   * the hand's move doesn't swing it somewhere else.
   */
  lock(settle = false) {
    this.settleNext = settle;
    // Still being let go of, for a window that closed again at once: taken back once it's free.
    if (this.locked && this.letting) this.lockAfter = true;
    if (this.locked || this.lockPending) return;
    // The browser lets go of the mouse on Esc coming up as well as going down, so a lock taken
    // between the two (the Esc that closed a window) is gone again at once, and with it the leave
    // to take it back without a click. Asked for once Esc is up instead, from its keyup (see there).
    // A second on, Esc being held would have repeated, so its keyup went missing.
    if (this.escDownAt && performance.now() - this.escDownAt < 1000) {
      this.lockOnEscUp = true;
      return;
    }
    this.lockOnEscUp = false;
    if (typeof this.dom.requestPointerLock !== 'function') {
      this.lockFailed = true;
      return;
    }
    this.lockPending = true;
    this.lockOnGesture = navigator.userActivation?.isActive ?? true;
    // Asking uses up the browser's leave to hand the mouse back, whatever it answers.
    this.letGo = false;
    try {
      // Newer browsers return a promise; older ones report through pointerlockerror.
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.refused());
    } catch {
      this.lockPending = false;
      this.lockFailed = true;
    }
  }

  private refused() {
    this.lockPending = false;
    // Locking right after Esc is refused for a moment, and so is asking with no click or key behind
    // it; only give up if it never worked when a click or key asked.
    if (!this.everLocked && this.lockOnGesture) this.lockFailed = true;
  }

  private look(dx: number, dy: number) {
    this.camYaw -= dx;
    this.lastYaw -= dx; // 3d-kanban: the mouse is never a jump, so it shows at once
    // 3d-kanban: in third person the camera tips over you instead (down the mouse, up the camera goes).
    if (this.view === 'third') {
      const before = this.camPitch;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy, THIRD_PITCH_MIN, THIRD_PITCH_MAX);
      this.lastPitch += this.camPitch - before;
      // What's shown stays within the limits too, while an outside jump is still easing out.
      this.pitchGap = this.camPitch - THREE.MathUtils.clamp(this.camPitch - this.pitchGap, THIRD_PITCH_MIN, THIRD_PITCH_MAX);
    }
    else this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy, -1.45, 1.45);
  }

  /** Sits you down in `place`, facing the way it does. In first person you look out from it; in third the camera stays put. */
  sit(place: SeatPlace) {
    this.seat = place;
    this.pos.set(place.x, place.y, place.z);
    this.vy = 0;
    this.grounded = true;
    this.moving = false;
    this.stepOffset = 0;
    this.bob = 0;
    this.facing = place.rotY;
    if (this.view === 'first') {
      this.camYaw = place.rotY - Math.PI;
      this.lookPitch = -0.08;
    }
  }

  /** Gets you up off your seat onto the floor beside it: out in front (or behind), else wherever there's room. */
  stand() {
    const at = this.standingSpot();
    this.seat = null;
    if (at) this.pos.set(at.x, at.y, at.z);
  }

  /** Where getting up would put you (see stand), or where you're standing if you aren't sitting. Null if there's no room. */
  standingSpot(): { x: number; y: number; z: number } | null {
    const s = this.seat;
    if (!s) return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    const ahead = s.rotY + (s.out < 0 ? Math.PI : 0);
    const d = Math.abs(s.out);
    for (const turn of [0, 0.6, -0.6, 1.2, -1.2, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const x = s.x + Math.sin(ahead + turn) * d;
      const z = s.z + Math.cos(ahead + turn) * d;
      if (!this.blocker(x, z, s.y)) return { x, y: s.y, z };
    }
    return null;
  }

  /** Whether there's room to stand at (x, z) with your feet at `y`. */
  fits(x: number, z: number, y: number): boolean {
    return !this.blocker(x, z, y);
  }

  /** Walks you through these corners by yourself until you get there, or take a step or a jump of your own. */
  walkPath(points: { x: number; z: number }[]) {
    this.path = points.length ? points.map((p) => ({ ...p })) : null;
    this.stuckFor = 0;
  }

  stopWalking() {
    this.path = null;
  }

  /** How far sitting moves your hips (and eyes) from where they are standing. */
  private get lift(): number {
    return this.seat ? this.seat.hips - HIPS : 0;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    if (this.rig) {
      this.rig(dt);
      this.vy = 0;
      this.grounded = false;
      this.stepOffset *= Math.exp(-dt * 16);
      this.bob = 0;
      this.jitterT += dt;
      this.updateCamera(false, dt);
      return;
    }
    if (this.seat) {
      if (!this.enabled || !GET_UP.some((c) => k.has(c))) {
        this.moving = false;
        this.facing = this.seat.rotY;
        this.jitterT += dt;
        this.updateCamera(false, dt);
        return;
      }
      this.stand();
      this.onStand?.();
    }
    let ix = 0;
    let iz = 0;
    if (this.enabled) {
      if (k.has('KeyW') || k.has('ArrowUp')) iz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) iz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) ix -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) ix += 1;
    }
    const steering = ix !== 0 || iz !== 0;
    this.moving = steering;
    if (this.path && (steering || (this.enabled && k.has('Space')))) {
      this.path = null;
      this.onPathEnd?.('cancelled');
    }
    if (this.path && this.enabled) this.followPath(dt);
    if (this.view === 'first') this.facing = Math.atan2(Math.sin(this.camYaw + Math.PI), Math.cos(this.camYaw + Math.PI));
    // 3d-kanban: third person faces where the camera looks too, standing or walking (not on a walk of its own, which turns you along it).
    else if (!this.path) this.facing += Math.atan2(Math.sin(this.camYaw + Math.PI - this.facing), Math.cos(this.camYaw + Math.PI - this.facing)) * (1 - Math.exp(-dt * 25));
    if (steering) {
      const len = Math.hypot(ix, iz);
      ix /= len;
      iz /= len;
      // Camera-relative: "forward" is where the camera looks.
      // Drunk, your feet wander off to one side and then the other.
      const t = this.jitterT;
      const stagger = this.drunk * (0.4 * Math.sin(t * 1.6) + 0.22 * Math.sin(t * 3.7 + 1));
      const sin = Math.sin(this.camYaw + stagger);
      const cos = Math.cos(this.camYaw + stagger);
      const dx = ix * cos + iz * sin;
      const dz = -ix * sin + iz * cos;
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK) * this.speedBoost;
      this.tryMove(this.pos.x + dx * speed * dt, this.pos.z);
      this.tryMove(this.pos.x, this.pos.z + dz * speed * dt);
      // 3d-kanban: third person turns to the camera above, walking or not (was: to the way you walk).
    }

    // Never below the street: past the edge of the grass there's nothing else to stand on.
    const ground = Math.max(groundAt(this.colliders, this.pos.x, this.pos.z, this.pos.y), this.street);
    const jump = this.enabled && k.has('Space') && this.grounded;
    if (jump) {
      this.vy = JUMP_V * this.jumpBoost;
      this.grounded = false;
    } else if (this.grounded && this.pos.y > ground && this.pos.y - ground <= STEP + 0.02) {
      // Walking down a stair: stay on your feet rather than falling a step.
      this.stepOffset += this.pos.y - ground;
      this.pos.y = ground;
    }
    this.vy -= GRAVITY * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else if (this.pos.y > ground + 0.02) {
      this.grounded = false;
    }
    const ceiling = ceilingAt(this.colliders, this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y + HEIGHT > ceiling) {
      this.pos.y = Math.max(ground, ceiling - HEIGHT);
      this.vy = Math.min(this.vy, 0);
    }
    this.stepOffset *= Math.exp(-dt * 16);
    const walking = this.moving && this.grounded;
    this.walkPhase += dt * (walking ? (k.has('ShiftLeft') || k.has('ShiftRight') ? 14 : 11) * this.speedBoost : 0);
    const bob = walking ? Math.abs(Math.sin(this.walkPhase)) * 0.035 : 0;
    this.bob += (bob - this.bob) * Math.min(1, dt * 18);
    this.jitterT += dt;
    this.updateCamera(false, dt);
  }

  /** A step along `path`: toward its next corner, turning (and in first person, looking) the way you go. */
  private followPath(dt: number) {
    const path = this.path!;
    const next = path[0];
    const dx = next.x - this.pos.x;
    const dz = next.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.25) {
      path.shift();
      if (!path.length) {
        this.path = null;
        this.onPathEnd?.('arrived');
      }
      return;
    }
    // Run the long way round, walk the last few meters.
    let left = dist;
    for (let i = 1; i < path.length; i++) left += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    const step = Math.min(dist, (left > 6 ? RUN : WALK) * this.speedBoost * dt);
    const x0 = this.pos.x;
    const z0 = this.pos.z;
    this.tryMove(this.pos.x + (dx / dist) * step, this.pos.z);
    this.tryMove(this.pos.x, this.pos.z + (dz / dist) * step);
    this.moving = true;
    const want = Math.atan2(dx, dz);
    const ease = Math.min(1, dt * 8);
    if (this.view === 'first') this.camYaw += Math.atan2(Math.sin(want + Math.PI - this.camYaw), Math.cos(want + Math.PI - this.camYaw)) * ease;
    else this.facing += Math.atan2(Math.sin(want - this.facing), Math.cos(want - this.facing)) * ease;
    // Up against something the map didn't know about: give up rather than walk on the spot.
    this.stuckFor = Math.hypot(this.pos.x - x0, this.pos.z - z0) < step * 0.2 ? this.stuckFor + dt : 0;
    if (this.stuckFor > 1) {
      this.path = null;
      this.onPathEnd?.('stuck');
    }
  }

  updateCamera(snap = false, dt = 0) {
    if (this.view === 'first') {
      // 3d-kanban: keep the third-person values in step, so switching views starts from where you look.
      this.yawGap = this.pitchGap = this.distGap = 0;
      this.lastYaw = this.camYaw;
      this.lastPitch = this.camPitch;
      this.lastDist = this.camDist;
      this.corrKnown = false;
      this.camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT + this.bob + this.stepOffset + this.lift, this.pos.z);
      this.camera.rotation.set(this.lookPitch, this.camYaw, 0);
      this.shake();
      return;
    }
    // 3d-kanban: a jump in yaw, pitch or distance becomes a gap that eases out (same at any frame rate); smaller,
    // continuous changes (the mouse, a car turning, a rig) are followed as they are.
    const dYaw = Math.atan2(Math.sin(this.camYaw - this.lastYaw), Math.cos(this.camYaw - this.lastYaw));
    if (snap) this.yawGap = this.pitchGap = this.distGap = 0;
    else {
      if (Math.abs(dYaw) > 0.15) this.yawGap += dYaw;
      if (Math.abs(this.camPitch - this.lastPitch) > 0.15) this.pitchGap += this.camPitch - this.lastPitch;
      this.distGap += this.camDist - this.lastDist; // zoom always glides, however small the step
      const k = Math.exp(-dt * 12);
      this.yawGap *= k;
      this.pitchGap *= k;
      this.distGap *= k;
    }
    this.lastYaw = this.camYaw;
    this.lastPitch = this.camPitch;
    this.lastDist = this.camDist;
    const yaw = this.camYaw - this.yawGap;
    const moved = !snap && this.corrKnown && this.camera.position.distanceTo(this.lastShown) > 0.01;
    const target = new THREE.Vector3(this.pos.x, this.pos.y + this.stepOffset + this.lift + THIRD_TARGET, this.pos.z);
    target.add(shoulderOffset(yaw)); // 3d-kanban: over your shoulder
    const off = orbitOffset(yaw, this.camPitch - this.pitchGap, this.camDist - this.distGap); // 3d-kanban
    const ideal = target.clone().add(off);
    const cam = ideal.clone();
    // Keep the camera on your side of the outside walls, so they never block the view: inside the
    // room while you're in the office, out of the building while you're outside or on the balcony.
    // And under the loft, its roof or the garage ceiling.
    const m = 0.4;
    const R = this.room;
    // On the ladder or a pole you can be down in a shaft under the floor, but you're still indoors.
    const rigged = !!this.rig && !this.riding;
    const under = this.pos.x > R.minX && this.pos.x < R.maxX && this.pos.z > R.minZ && this.pos.z < R.maxZ;
    // In the office's back office, between its walls, and out through where the north wall was into the room.
    const back = !R.enclosed && this.pos.y > -SLAB - 0.5 && inWing(this.pos.x, this.pos.z, this.wing);
    const indoors = ((rigged || this.pos.y > -SLAB - 0.5) && under) || back;
    // Down in a room under the floor (the castle's dungeon): the camera keeps inside that.
    const V = R.vault;
    if (V && this.pos.y < V.top - 0.5 && this.pos.x > V.minX && this.pos.x < V.maxX && this.pos.z > V.minZ && this.pos.z < V.maxZ) {
      cam.x = THREE.MathUtils.clamp(cam.x, V.minX + m, V.maxX - m);
      cam.z = THREE.MathUtils.clamp(cam.z, V.minZ + m, V.maxZ - m);
    } else if (back) {
      cam.x = THREE.MathUtils.clamp(cam.x, WING.minX + m, WING.maxX - m);
      cam.z = THREE.MathUtils.clamp(cam.z, wingMinZ(this.wing) + m, FLOOR.maxZ - m);
    } else if (indoors) {
      cam.x = THREE.MathUtils.clamp(cam.x, R.minX + m, R.maxX - m);
      cam.z = THREE.MathUtils.clamp(cam.z, R.minZ + m, R.maxZ - m);
    }
    const floorY = rigged ? 0 : Math.max(groundAt(this.colliders, this.pos.x, this.pos.z, this.pos.y), this.street);
    const roof = ceilingAt(this.colliders, cam.x, cam.z, floorY) - 0.3;
    cam.y = THREE.MathUtils.clamp(cam.y, floorY + 0.6, Math.max(floorY + 0.6, Math.min(floorY + 3.5, roof)));
    // Down on the street, stay under the garage ceiling so its edge never cuts across the view; in the
    // garage, on this side of its back and west walls too (the elevator comes down in the back one).
    const garage = this.street - STREET_Y - SLAB;
    if (!R.enclosed && this.pos.y < garage - 1 && !rigged) {
      cam.y = Math.min(cam.y, Math.max(floorY + 0.6, garage - 0.3));
      if (under) {
        cam.x = Math.max(cam.x, R.minX + m);
        cam.z = Math.max(cam.z, R.minZ + m);
      }
    }
    // How far you are out past each outside wall (west, east, north, south), and how far inside them the camera is.
    const e = R.wall + m;
    const out = [R.minX - R.wall - this.pos.x, this.pos.x - R.maxX - R.wall, R.minZ - R.wall - this.pos.z, this.pos.z - R.maxZ - R.wall];
    const side = out.indexOf(Math.max(...out));
    const camIn = Math.min(cam.x - (R.minX - e), R.maxX + e - cam.x, cam.z - (R.minZ - e), R.maxZ + e - cam.z) > 0;
    // Outside, back the camera out through the wall you're standing beyond: above the garage always,
    // and down in it where it's walled in (the west and north sides).
    if (!indoors && out[side] > 0 && camIn && (R.enclosed || cam.y > garage || side === 0 || side === 2)) {
      if (side === 0) cam.x = R.minX - e;
      else if (side === 1) cam.x = R.maxX + e;
      else if (side === 2) cam.z = R.minZ - e;
      else cam.z = R.maxZ + e;
    }
    // 3d-kanban: the camera sits exactly on the orbit, moved by the walls. Sliding along a wall follows it rigidly; a jump
    // in the move (inside to outside, the vault, the garage, the roof) is eased in instead of cutting.
    const corr = cam.sub(ideal);
    if (snap || !this.corrKnown) {
      this.shownCorr.copy(corr);
      this.corrEasing = false;
    } else if (moved) {
      // Someone else (golf, throwing) put the camera there: ease from it back to the orbit.
      this.shownCorr.copy(this.camera.position).sub(ideal);
      this.corrEasing = true;
    }
    if (!snap && this.corrKnown) {
      // The walls' move changes at most twice as much as the orbit spot moved (turning fast past a wall): more is a jump.
      if (corr.distanceTo(this.rawCorr) > 0.5 + 2 * ideal.distanceTo(this.lastIdeal)) this.corrEasing = true;
      if (this.corrEasing) {
        this.shownCorr.lerp(corr, 1 - Math.exp(-dt * 20));
        if (this.shownCorr.distanceTo(corr) < 0.01) this.corrEasing = false;
      }
      if (!this.corrEasing) this.shownCorr.copy(corr);
    }
    this.rawCorr.copy(corr);
    this.lastIdeal.copy(ideal);
    this.corrKnown = true;
    this.camera.position.copy(ideal).add(this.shownCorr);
    this.lastShown.copy(this.camera.position);
    this.camera.lookAt(target);
    this.shake();
  }

  /** The jitters: the view trembles a little, on top of wherever you're looking. Drunk, it rolls and sways. */
  private shake() {
    const t = this.jitterT;
    if (this.drunk > 0) {
      const d = this.drunk;
      this.camera.rotation.z += d * (0.07 * Math.sin(t * 0.9) + 0.025 * Math.sin(t * 2.3 + 1));
      this.camera.rotation.x += d * 0.03 * Math.sin(t * 0.7 + 2);
      this.camera.rotation.y += d * 0.04 * Math.sin(t * 0.55 + 4);
    }
    if (this.jitter <= 0) return;
    const a = this.jitter * 0.01;
    this.camera.rotation.x += a * (Math.sin(t * 71) + 0.6 * Math.sin(t * 131 + 1));
    this.camera.rotation.y += a * (Math.sin(t * 89 + 2) + 0.6 * Math.sin(t * 157));
    this.camera.rotation.z += a * Math.sin(t * 113 + 3);
  }

  /** Unit vector the character is facing, on the XZ plane. */
  forward(): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(this.facing), Math.cos(this.facing));
  }

  /** What stands in your way at (x, z) with your feet at `y`, or null. */
  private blocker(x: number, z: number, y: number, allowEscape = false): Collider | null {
    let hit: Collider | null = null;
    for (const c of this.colliders) {
      // Stood on top of it, or passing beneath it.
      if (y >= c.top - 0.05 || y + HEIGHT <= (c.bottom ?? 0)) continue;
      // A spawn or height change can leave the body overlapping a solid. Only
      // allow escape toward its near side, never through it to the far side.
      if (allowEscape && touches(c, this.pos.x, this.pos.z, RADIUS)) {
        if (escapes(c, this.pos.x, this.pos.z, x, z)) continue;
      } else if (!touches(c, x, z, RADIUS)) continue;
      if (!hit || c.top > hit.top) hit = c;
    }
    return hit;
  }

  private tryMove(x: number, z: number) {
    const hit = this.blocker(x, z, this.pos.y, true);
    if (!hit) {
      this.pos.x = x;
      this.pos.z = z;
      return;
    }
    // A stair: step up onto it if there's room there.
    const up = hit.top - this.pos.y;
    if (this.grounded && up <= STEP && !this.blocker(x, z, hit.top) && this.pos.y + HEIGHT + up <= ceilingAt(this.colliders, x, z, this.pos.y)) {
      this.pos.set(x, hit.top, z);
      this.stepOffset -= up;
      return;
    }
    // Use the free part of this axis's step instead of throwing it all away.
    // The other axis can then slide along the surface, even on slower frames.
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    let free = 0;
    let blocked = 1;
    for (let i = 0; i < 12; i++) {
      const fraction = (free + blocked) / 2;
      if (this.blocker(this.pos.x + dx * fraction, this.pos.z + dz * fraction, this.pos.y, true)) blocked = fraction;
      else free = fraction;
    }
    this.pos.x += dx * free;
    this.pos.z += dz * free;
  }
}

/** Whether the whole axis step moves out of an existing overlap. */
function escapes(c: Collider, fromX: number, fromZ: number, x: number, z: number): boolean {
  if (penetration(c, x, z) >= penetration(c, fromX, fromZ) - 1e-8) return false;
  const nx = fromX - THREE.MathUtils.clamp(fromX, c.minX, c.maxX);
  const nz = fromZ - THREE.MathUtils.clamp(fromZ, c.minZ, c.maxZ);
  if (nx || nz) return nx * (x - fromX) + nz * (z - fromZ) >= 0;
  // Inside the footprint, head toward a nearest face. An endpoint with less
  // overlap alone is insufficient: a long step could cross a thin wall first.
  const nearest = Math.min(fromX - c.minX, c.maxX - fromX, fromZ - c.minZ, c.maxZ - fromZ);
  return (nearest === fromX - c.minX && x < fromX) || (nearest === c.maxX - fromX && x > fromX)
    || (nearest === fromZ - c.minZ && z < fromZ) || (nearest === c.maxZ - fromZ && z > fromZ);
}

/** Signed overlap depth, including when the center is inside the footprint. */
function penetration(c: Collider, x: number, z: number): number {
  const dx = Math.max(c.minX - x, 0, x - c.maxX);
  const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
  if (dx || dz) return RADIUS - Math.hypot(dx, dz);
  return RADIUS + Math.min(x - c.minX, c.maxX - x, z - c.minZ, c.maxZ - z);
}

/** Whether a body of radius `r` at (x, z) overlaps the collider's footprint. */
function touches(c: Collider, x: number, z: number, r: number): boolean {
  const nx = THREE.MathUtils.clamp(x, c.minX, c.maxX);
  const nz = THREE.MathUtils.clamp(z, c.minZ, c.maxZ);
  return (x - nx) ** 2 + (z - nz) ** 2 < r * r;
}

/**
 * The floor under someone standing at (x, z) with their feet at `y`: the highest top they're on or
 * above (out of doors, the street's). Without `fences`, what's there only to keep people out doesn't count.
 */
export function groundAt(colliders: Collider[], x: number, z: number, y: number, fences = true): number {
  let g = -Infinity;
  for (const c of colliders) {
    if (c.top > 50 || y < c.top - 0.1 || c.top <= g || (c.fence && !fences)) continue;
    if (touches(c, x, z, RADIUS)) g = c.top;
  }
  return g;
}

/** The underside of whatever is overhead at (x, z) for feet at `y` (the loft, its roof), or Infinity. */
function ceilingAt(colliders: Collider[], x: number, z: number, y: number): number {
  let top = Infinity;
  for (const c of colliders) {
    const b = c.bottom ?? 0;
    if (b <= y + 0.1 || b >= top) continue;
    if (touches(c, x, z, RADIUS)) top = b;
  }
  return top;
}

export function isTyping(e?: Event): boolean {
  const el = (e?.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm');
}
