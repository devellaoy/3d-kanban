// What someone says, as a speech bubble over their head: it pops in, stays a while and fades out.
import type * as THREE from 'three';
import { cardSprite, disposeSprite } from '../toon';

/** How long a bubble stays: a few seconds, more for longer lines. */
export function bubbleSeconds(text: string): number {
  return Math.min(10, Math.max(4, 4 + 0.06 * text.length));
}

const POP = 0.18;
const FADE = 0.6;

export class SpeechBubble {
  readonly sprite: THREE.Sprite;
  private readonly w: number;
  private readonly h: number;
  private age = 0;
  private readonly life: number;

  constructor(text: string, opts: { border?: string; seconds?: number } = {}) {
    this.sprite = cardSprite({ title: text, bg: '#ffffff', border: opts.border, maxWidth: 320, titleLines: 3 });
    this.w = this.sprite.scale.x;
    this.h = this.sprite.scale.y;
    this.life = opts.seconds ?? bubbleSeconds(text);
    this.sprite.material.transparent = true;
    this.sprite.scale.set(0, 0, 1);
  }

  /** How tall it stands, in world units. */
  get height(): number {
    return this.h;
  }

  /** Pops in (a little past full size, then settles), fades over the last moments; false once it's time to go. */
  tick(dt: number): boolean {
    this.age += dt;
    const u = Math.min(1, this.age / POP);
    // Rises to 1.1 over the first 2/3 of the pop, then settles back to 1.
    const s = u < 2 / 3 ? 1.1 * (u / (2 / 3)) : 1.1 - 0.1 * ((u - 2 / 3) * 3);
    this.sprite.scale.set(this.w * s, this.h * s, 1);
    this.sprite.material.opacity = Math.min(1, Math.max(0, (this.life - this.age) / FADE));
    return this.age < this.life;
  }

  /** Takes it off whatever it hangs on and frees it. */
  dispose() {
    this.sprite.removeFromParent();
    disposeSprite(this.sprite);
  }
}
