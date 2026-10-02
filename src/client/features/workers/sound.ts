import type { AudioCore } from '../../sound/core';
import { biquad, envelope, pick, rand } from '../../sound/dsp';

// The castle's dungeon: its cell doors, and whoever's thrown down on the straw.

/** A hinge creaking: a rough, wavering squeak. From where it is, so you hear it from across the room. */
function hinge(a: AudioCore, at: { x: number; y: number; z: number }) {
  const ctx = a.ctx;
  if (!ctx) return;
  a.count('hingeCreak');
  const out = a.panner(at, 2, 1.1);
  out.connect(a.mix.effects);
  const t0 = ctx.currentTime + 0.01;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(420, t0);
  o.frequency.linearRampToValueAtTime(640, t0 + 0.18);
  o.frequency.linearRampToValueAtTime(380, t0 + 0.36);
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 23;
  const depth = ctx.createGain();
  depth.gain.value = 40;
  wobble.connect(depth).connect(o.frequency);
  const g = ctx.createGain();
  envelope(g.gain, t0, [
    [0.04, 0.05],
    [0.3, 0.04],
    [0.4, 0],
  ]);
  o.connect(biquad(ctx, 'bandpass', 1400, 2.5)).connect(g).connect(out);
  for (const n of [o, wobble]) {
    n.start(t0);
    n.stop(t0 + 0.45);
  }
}

/**
 * A cell door in the dungeon: its hinges groaning open, or slamming shut on someone with a clang of
 * iron that rings on round the vault.
 */
export function cellDoor(a: AudioCore, at: { x: number; y: number; z: number }, open: boolean) {
  const ctx = a.ctx;
  if (!ctx) return;
  if (open) return hinge(a, at);
  a.count('cellDoor');
  const out = a.panner(at, 3, 1);
  out.connect(a.mix.effects);
  const t0 = ctx.currentTime + 0.005;
  a.play(pick(a.buf.steps), { gain: 0.9, rate: 0.45, dest: out });
  a.blip(out, t0, 95, 0.6, 0.25, 0.22);
  // The bars ringing: a few out-of-tune partials, dying away slowly.
  for (const [f, amp, len] of [
    [310, 0.07, 1.4],
    [742, 0.05, 1.1],
    [1270, 0.035, 0.8],
    [2115, 0.02, 0.5],
  ]) {
    a.blip(out, t0, f * rand(0.97, 1.03), 0.995, len, amp, 'triangle');
  }
  a.clink(out, t0 + 0.02, rand(1600, 1900), 0.06);
}

/** Someone thrown down on the straw. */
export function thud(a: AudioCore, at: { x: number; y: number; z: number }) {
  const ctx = a.ctx;
  if (!ctx) return;
  a.count('thud');
  const out = a.panner(at, 2, 1.1);
  out.connect(a.mix.thumps);
  a.play(pick(a.buf.steps), { gain: 0.7, rate: 0.5, dest: out });
  a.blip(out, ctx.currentTime + 0.005, 120, 0.5, 0.16, 0.14);
}
