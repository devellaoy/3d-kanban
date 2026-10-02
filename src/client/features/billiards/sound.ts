import type { AudioCore } from '../../sound/core';
import { pick } from '../../sound/dsp';
import type { Pos } from '../../sound/places';

// ---- Billiards -------------------------------------------------------------------------------------

export type BilliardsSound = 'clack' | 'cushion' | 'pocket' | 'cue';

/**
 * The table: a ball against a ball (`clack`, a hard little tick), against a cushion (a duller thud), the
 * cue tapping the cue ball, and a ball dropping into a pocket and rolling away down it. `speed` is how
 * hard (m/s) and `at` where.
 */
export function billiards(a: AudioCore, kind: BilliardsSound, at: Pos, speed = 2) {
  const ctx = a.ctx;
  if (!ctx) return;
  a.count(`billiards-${kind}`);
  const loud = Math.min(1, speed / 4);
  const out = a.panner(at, 2, 1.2);
  out.connect(a.ambience);
  const t0 = ctx.currentTime + 0.005;
  if (kind === 'clack' || kind === 'cue') {
    const g = kind === 'cue' ? 0.3 + 0.3 * loud : 0.1 + 0.35 * loud;
    a.blip(out, t0, 2600 + 500 * loud, 0.6, 0.05, g, 'triangle');
    a.blip(out, t0, 1300, 0.7, 0.09, g * 0.6);
  } else if (kind === 'cushion') {
    a.blip(out, t0, 190, 0.7, 0.1, 0.1 + 0.3 * loud);
    a.play(pick(a.buf.steps), { gain: 0.1 + 0.25 * loud, rate: 1.4, dest: out });
  } else {
    // A drop, a rattle down the leather, and the low knock of the ball settling at the bottom.
    a.blip(out, t0, 320, 0.5, 0.12, 0.25);
    for (let i = 0; i < 4; i++) a.blip(out, t0 + 0.12 + i * 0.07, 520 - i * 60, 0.8, 0.05, 0.08, 'triangle');
    a.blip(out, t0 + 0.45, 150, 0.8, 0.12, 0.2);
  }
}
