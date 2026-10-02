// What someone says, as a speech bubble over their head: it pops in, stays a while and fades out.
import type * as THREE from 'three';
import { cardSprite, disposeSprite } from '../toon';

/** The longest line a bubble lays out: the office caps chat at this too, but a visited office's server might not. */
const MAX_TEXT = 500;
/** Seconds the bubble takes to pop in, and to fade out at the end. */
const POP = 0.18;
const FADE = 0.6;

/** How long a bubble stays: a few seconds, more for longer lines. */
export function bubbleSeconds(text: string): number {
  return Math.min(10, 4 + 0.06 * text.length);
}

/** How the bubble looks `age` seconds into a life of `life`: its size (1 is full), opacity, and whether it's still up. */
export function bubbleFrame(age: number, life: number): { scale: number; opacity: number; alive: boolean } {
  const u = Math.min(1, Math.max(0, age / POP));
  // Rises to 1.1 over the first 2/3 of the pop, then settles back to 1.
  const scale = u >= 1 ? 1 : u < 2 / 3 ? 1.1 * (u / (2 / 3)) : 1.1 - 0.1 * ((u - 2 / 3) * 3);
  return { scale, opacity: Math.min(1, Math.max(0, (life - age) / FADE)), alive: age < life };
}

export class SpeechBubble {
  readonly sprite: THREE.Sprite;
  private readonly w: number;
  private readonly h: number;
  private readonly life: number;
  /** When it came up (performance.now(), ms): it goes once its time is up on the clock too, so a tab back from the background doesn't still show it. */
  private readonly born = performance.now();
  private age = 0;
  private popped = false;

  constructor(text: string, opts: { border?: string; seconds?: number } = {}) {
    text = text.slice(0, MAX_TEXT);
    this.sprite = cardSprite({ title: text, bg: '#ffffff', border: opts.border, maxWidth: 320, titleLines: 3 });
    this.w = this.sprite.scale.x;
    this.h = this.sprite.scale.y;
    this.life = opts.seconds ?? bubbleSeconds(text);
    this.sprite.scale.set(0, 0, 1);
  }

  /** How tall it stands, in world units. */
  get height(): number {
    return this.h;
  }

  /** Pops in (a little past full size, then settles), fades over the last moments; false once it's time to go. */
  tick(dt: number, now = performance.now()): boolean {
    this.age += dt;
    const f = bubbleFrame(this.age, this.life);
    if (!this.popped) {
      this.sprite.scale.set(this.w * f.scale, this.h * f.scale, 1);
      this.popped = f.scale === 1;
    }
    this.sprite.material.opacity = f.opacity;
    return f.alive && (now - this.born) / 1000 < this.life;
  }

  /** Takes it off whatever it hangs on and frees it. */
  dispose() {
    this.sprite.removeFromParent();
    disposeSprite(this.sprite);
  }
}
