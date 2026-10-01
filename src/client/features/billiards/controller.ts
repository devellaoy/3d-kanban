import * as THREE from 'three';
import { isTyping, type PlayerController } from '../../player';
import { modalOpen } from '../../ui/dom';
import { TABLE_AT } from '../gameroom/layout';
import { Billiards, type Mode } from './game';
import { R, aimLine, type SimEvent } from './sim';
import { BilliardsPanel } from './ui';
import { ballMesh, cueStick, toRoom, type TableView } from './world';

// At the table (E at the billiards table): the camera goes down behind the cue ball, looking down the
// cue. The mouse (or A and D) aims, Shift slows it for fine aim, and holding Space (or the left mouse
// button) draws the cue back as the power builds: let go to shoot. Then the camera rises to watch the
// balls run. After a scratch the cue ball is in hand: W A S D slide it behind the head string, Space puts
// it down. R racks again, P switches between practice and two players taking turns, E or Esc leaves.

/** Holding the shot builds the power to full in this long (s). */
const CHARGE = 1.5;
/** A shot under this power is a practice swing: the cue goes back down. */
const MIN_POWER = 0.04;
/** A and D (and the arrow keys) turn the aim this fast (rad/s), and Shift slows the mouse and keys by this much. */
const TURN = 0.6;
const FINE = 0.2;
/** The cue ball in hand slides this fast (m/s). */
const SLIDE = 0.7;
/** How far behind the cue ball the camera is, and how high over the cloth. */
const BACK = 0.85;
const UP = 0.42;
/** Up over the table to watch the balls: back from its middle, and over the cloth. */
const WATCH_BACK = 1.9;
const WATCH_UP = 1.55;
/** The cue's tip rests this far from the ball; it's drawn back by up to PULL when the power's full. */
const GAP = 0.02;
const PULL = 0.28;
/** A ball falls into its pocket for this long (s). */
const SINK = 0.3;

export type Stage = 'aim' | 'charge' | 'watch' | 'inhand';

export interface BilliardsHooks {
  /** A sound at a point on the table plane (x, y), `speed` m/s. */
  sound(kind: 'clack' | 'cushion' | 'pocket' | 'cue', at: { x: number; y: number; z: number }, speed: number): void;
  /** Something to tell you (a scratch, a cleared table). */
  say(text: string): void;
  /** The table has been cleared in this many shots: the page keeps the best. */
  cleared(shots: number): void;
  /** The mode changed. */
  mode(mode: Mode): void;
  /** You left the table (so the hint bar draws again). */
  done(): void;
  /** The fewest shots a cleared rack took so far, or null. */
  best(): number | null;
  /** How far below the floor you're on the street is (see streetBelow). */
  street(): number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const lookAt = new THREE.Matrix4();
const want = new THREE.Vector3();
const target = new THREE.Vector3();
const turn = new THREE.Quaternion();
const UPV = new THREE.Vector3(0, 1, 0);
const spin = new THREE.Quaternion();
const axis = new THREE.Vector3();

export class BilliardsPlay {
  readonly game = new Billiards();
  private active = false;
  /** The aim: the cue ball's heading on the table plane (0 is toward the rack), which is also the world heading. */
  aim = 0;
  private lastYaw = 0;
  private chargeAt = 0;
  private charging = false;
  private power = 0;
  /** When the cue was released (s since): it flies forward for a moment, then goes away while the balls run. */
  private strikeT = -1;
  /** How far the cue is drawn back (m), kept for the stroke to come forward from. */
  private pulled = 0;
  /** The last shot's result that was reported (see react). */
  private lastOutcome: unknown = null;
  private readonly panel: BilliardsPanel;
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly falling = new Map<number, number>();
  private readonly cue = cueStick();
  private readonly guide: THREE.Mesh;
  private readonly ghost: THREE.Mesh;
  private view: TableView | null = null;
  private readonly camPos = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();

  constructor(
    private readonly player: PlayerController,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly hooks: BilliardsHooks,
  ) {
    this.panel = new BilliardsPanel(() => this.leave(true));
    this.cue.rotation.order = 'YXZ';
    this.guide = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.002, 1).translate(0, 0, 0.5), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75 }));
    this.ghost = new THREE.Mesh(new THREE.RingGeometry(R * 0.85, R, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }));
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('mousedown', (e) => e.button === 0 && this.player.locked && this.hold(true));
    window.addEventListener('mouseup', (e) => e.button === 0 && this.hold(false));
    window.addEventListener('blur', () => this.hold(false, true));
  }

  get running(): boolean {
    return this.active;
  }

  get stage(): Stage {
    return this.game.phase === 'rolling' ? 'watch' : this.game.phase === 'inhand' ? 'inhand' : this.charging ? 'charge' : 'aim';
  }

  /** Steps up to the table `view` (where the balls go), with the mode you last played. */
  start(view: TableView, mode: Mode): void {
    if (this.active) return;
    this.active = true;
    this.view = view;
    if (this.cue.parent !== view.balls) {
      view.balls.add(this.cue, this.guide, this.ghost);
      for (const m of this.meshes.values()) view.balls.add(m);
    }
    this.game.setMode(mode);
    this.aim = 0;
    const p = this.player;
    p.rig = () => this.stand();
    p.camYaw = this.aim + Math.PI;
    this.lastYaw = p.camYaw;
    this.camPos.copy(this.camera.position);
    this.camQuat.copy(this.camera.quaternion);
    this.panel.show(true);
    this.charging = false;
    this.strikeT = -1;
    this.sync(0);
    this.stand();
  }

  /** Leaves the table. The balls finish rolling where they are, so it's as you left it next time. */
  leave(relook = false): void {
    if (!this.active) return;
    this.active = false;
    this.charging = false;
    // Whatever was still running comes to rest (the camera is gone, so nobody would see it).
    for (let i = 0; i < 600 && this.game.phase === 'rolling'; i++) this.game.update(0.1);
    this.cue.visible = false;
    this.guide.visible = false;
    this.ghost.visible = false;
    this.sync(0);
    const p = this.player;
    p.rig = null;
    p.lookPitch = -0.08;
    if (p.view === 'third') p.camYaw = p.facing + Math.PI;
    this.panel.show(false);
    this.hooks.done();
    // The ✕ or Esc that leaves puts you straight back into mouse-look.
    if (relook) p.lock();
  }

  /** Re-racks. */
  rerack(): void {
    this.game.reset();
    this.charging = false;
    this.hooks.say('🎱 New rack');
  }

  switchMode(): void {
    const mode: Mode = this.game.mode === 'practice' ? 'hotseat' : 'practice';
    this.game.setMode(mode);
    this.hooks.mode(mode);
    this.hooks.say(mode === 'hotseat' ? '🎱 Two players: you keep the table while you pot, then it passes' : '🎱 Practice');
  }

  /** Where the cue ball is as a point in the scene. */
  private cueAt(): THREE.Vector3 {
    const c = this.game.cue;
    const at = toRoom(c.x, c.y);
    return new THREE.Vector3(at.x, this.hooks.street() + TABLE_AT.cloth + R, at.z);
  }

  /** The two of you stand behind the cue ball, off to the side so the camera isn't inside you. */
  private stand(): void {
    const c = this.cueAt();
    const sin = Math.sin(this.aim);
    const cos = Math.cos(this.aim);
    const p = this.player;
    // Back along the line, and half a meter to the right of it.
    p.pos.x = c.x - sin * 1.15 - cos * 0.5;
    p.pos.z = c.z - cos * 1.15 + sin * 0.5;
    p.facing = this.aim;
    p.moving = false;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.active || e.code !== 'Space') return;
    if (down && (e.repeat || isTyping(e) || modalOpen() || e.metaKey || e.ctrlKey || e.altKey)) return;
    this.hold(down);
  }

  /** The shot button (Space or the mouse) goes down or up. */
  private hold(down: boolean, abort = false): void {
    if (!this.active) return;
    if (down) {
      if (this.game.phase === 'inhand') {
        if (this.game.placeCue()) this.hooks.sound('clack', this.at(this.game.cue.x, this.game.cue.y), 0.5);
      } else if (this.game.phase === 'aim' && !this.charging) {
        this.charging = true;
        this.chargeAt = performance.now();
      }
      return;
    }
    if (!this.charging) return;
    this.charging = false;
    const power = this.power;
    if (abort || power < MIN_POWER) return;
    // Nobody hits it exactly the same twice: a hair off line.
    const angle = this.aim + (Math.random() - 0.5) * 0.002;
    if (this.game.shoot(angle, power)) {
      this.strikeT = 0;
      this.hooks.sound('cue', this.at(this.game.cue.x, this.game.cue.y), 1 + 3 * power);
    }
  }

  private at(x: number, y: number) {
    const r = toRoom(x, y);
    return { x: r.x, y: this.hooks.street() + TABLE_AT.cloth, z: r.z };
  }

  /** Every frame once the player has moved: aiming, the shot, the balls, and the camera. */
  update(dt: number): void {
    if (!this.active || !this.view) return;
    const p = this.player;
    const g = this.game;
    const fine = p.holding('ShiftLeft', 'ShiftRight') ? FINE : 1;
    // The mouse turns your view as it always does (camYaw); that's the aim, slowed with Shift, along with the keys.
    let aim = this.aim + wrap(p.camYaw - this.lastYaw) * fine;
    if (g.phase === 'aim') {
      if (p.holding('KeyA', 'ArrowLeft')) aim += TURN * fine * dt;
      if (p.holding('KeyD', 'ArrowRight')) aim -= TURN * fine * dt;
    } else if (g.phase === 'inhand') {
      // Slide the cue ball: forward and across, as the view has it.
      const f = (p.holding('KeyW', 'ArrowUp') ? 1 : 0) - (p.holding('KeyS', 'ArrowDown') ? 1 : 0);
      const s = (p.holding('KeyD', 'ArrowRight') ? 1 : 0) - (p.holding('KeyA', 'ArrowLeft') ? 1 : 0);
      if (f || s) {
        const d = SLIDE * dt * fine * 1.6;
        g.nudgeCue(Math.cos(aim) * f * d + Math.sin(aim) * s * d, Math.sin(aim) * f * d - Math.cos(aim) * s * d);
      }
    }
    this.aim = wrap(aim);
    p.camYaw = this.aim + Math.PI;
    this.lastYaw = p.camYaw;

    this.power = this.charging ? Math.min(1, (performance.now() - this.chargeAt) / 1000 / CHARGE) : 0;
    if (this.strikeT >= 0) this.strikeT += dt;
    const events = g.update(dt);
    this.react(events);
    this.sync(dt);
    this.stand();
    this.place(dt);
    this.panel.render(g, this.power, this.hooks.best());
  }

  /** What the balls just did: the sounds, the ones that fell, and what the shot added up to. */
  private react(events: SimEvent[]): void {
    let clack = 0;
    let cushion = 0;
    for (const e of events) {
      if (e.kind === 'ball') clack = Math.max(clack, e.speed);
      else if (e.kind === 'cushion') cushion = Math.max(cushion, e.speed);
      else {
        this.falling.set(e.id, SINK);
        this.hooks.sound('pocket', this.at(e.x, e.y), 2);
      }
    }
    if (clack > 0.08) this.hooks.sound('clack', this.at(this.game.cue.x, this.game.cue.y), clack);
    if (cushion > 0.15) this.hooks.sound('cushion', this.at(this.game.cue.x, this.game.cue.y), cushion);
    const out = this.game.last;
    if (out && this.game.phase !== 'rolling' && this.lastOutcome !== out) {
      this.lastOutcome = out;
      if (out.scratch) this.hooks.say('🎱 Scratch! The cue ball is in hand: W A S D to place it, Space to put it down');
      else if (out.potted.length) this.hooks.say(`🎱 Potted ${out.potted.join(', ')}`);
      if (out.cleared) this.hooks.cleared(this.game.clearedIn ?? this.game.shots);
    }
  }

  /** The balls where the game says, and the cue and the aim guide. */
  private sync(dt: number): void {
    const view = this.view;
    if (!view) return;
    const y = this.hooks.street() + TABLE_AT.cloth + R;
    const rolling = this.game.phase === 'rolling';
    for (const b of this.game.balls) {
      let m = this.meshes.get(b.id);
      if (!m) {
        m = ballMesh(b.id);
        this.meshes.set(b.id, m);
        view.balls.add(m);
      }
      const at = toRoom(b.x, b.y);
      const sinking = this.falling.get(b.id);
      m.visible = !b.potted || sinking !== undefined;
      if (b.potted) {
        if (sinking !== undefined) {
          const left = sinking - dt;
          if (left <= 0) this.falling.delete(b.id);
          else this.falling.set(b.id, left);
          m.position.set(at.x, y - (1 - left / SINK) * 0.25, at.z);
        }
        continue;
      }
      m.position.set(at.x, y, at.z);
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 0 && dt > 0) {
        // Rolling: it turns about the horizontal axis across its way (table x is world z and table y world x,
        // so it goes (vy, 0, vx) and the axis is up × that), a radian for each radius it rolls.
        axis.set(b.vx, 0, -b.vy).normalize();
        spin.setFromAxisAngle(axis, (speed * dt) / R);
        m.quaternion.premultiply(spin);
      }
    }
    const aiming = this.active && !rolling && this.game.phase === 'aim';
    this.guide.visible = this.ghost.visible = aiming;
    this.cue.visible = this.active && (aiming || (this.strikeT >= 0 && this.strikeT < 0.12));
    if (!this.active) return;
    const c = this.cueAt();
    const sin = Math.sin(this.aim);
    const cos = Math.cos(this.aim);
    if (aiming) {
      const end = aimLine(this.game.balls, this.aim);
      const to = toRoom(end.x, end.y);
      const len = Math.hypot(to.x - c.x, to.z - c.z);
      this.guide.position.set(c.x, y, c.z).addScaledVector(new THREE.Vector3(sin, 0, cos), R);
      this.guide.rotation.y = this.aim;
      this.guide.scale.z = Math.max(0.001, len - R);
      this.ghost.position.set(to.x, y, to.z);
    }
    if (this.cue.visible) {
      const pull = this.strikeT >= 0 ? Math.max(0, 1 - this.strikeT / 0.12) * this.pulled : (this.pulled = this.power * PULL);
      const back = R + GAP + pull;
      this.cue.position.set(c.x - sin * back, y + 0.004, c.z - cos * back);
      this.cue.rotation.set(-0.08, this.aim + Math.PI, 0);
    }
  }

  /** The camera: down behind the cue ball looking down the cue, or up over the table to watch the balls run. */
  private place(dt: number): void {
    const street = this.hooks.street();
    const c = this.cueAt();
    const sin = Math.sin(this.aim);
    const cos = Math.cos(this.aim);
    const cloth = street + TABLE_AT.cloth;
    const near = this.game.phase === 'aim';
    if (near) {
      // Low behind the ball, looking a little down the line past it, with the ball in the lower half of the view.
      want.set(c.x - sin * BACK, cloth + UP, c.z - cos * BACK);
      target.set(c.x + sin * 0.7, cloth + 0.03, c.z + cos * 0.7);
    } else {
      want.set(TABLE_AT.x - sin * WATCH_BACK, cloth + WATCH_UP, TABLE_AT.z - cos * WATCH_BACK);
      target.set(TABLE_AT.x, cloth, TABLE_AT.z);
    }
    const k = 1 - Math.exp(-dt * (near ? 7 : 4));
    this.camPos.lerp(want, k);
    lookAt.lookAt(this.camPos, target, UPV);
    turn.setFromRotationMatrix(lookAt);
    this.camQuat.slerp(turn, k);
    this.camera.position.copy(this.camPos);
    this.camera.quaternion.copy(this.camQuat);
  }
}

