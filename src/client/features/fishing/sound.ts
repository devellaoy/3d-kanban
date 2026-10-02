import type { AudioCore } from '../../sound/core';
import { biquad, envelope, rand } from '../../sound/dsp';
import type { Pos } from '../../sound/places';

// ---- Fishing ------------------------------------------------------------------------------------------

export type FishingSound = 'wind' | 'cast' | 'splash' | 'nibble' | 'bite' | 'reel' | 'catch' | 'rare' | 'junk' | 'away';

/** A burst of noise through a filter that sweeps from `f0` to `f1` over `len` seconds. */
function sweep(a: AudioCore, out: AudioNode, t0: number, type: BiquadFilterType, f0: number, f1: number, len: number, peak: number, q = 1.1) {
  const ctx = a.ctx!;
  const n = a.noise(a.buf.white);
  const tone = biquad(ctx, type, f0, q);
  tone.frequency.setValueAtTime(f0, t0);
  tone.frequency.linearRampToValueAtTime(f1, t0 + len);
  const g = ctx.createGain();
  envelope(g.gain, t0, [
    [len * 0.25, peak],
    [len, 0],
  ]);
  n.connect(tone).connect(g).connect(out);
  n.start(t0);
  n.stop(t0 + len + 0.05);
}

/**
 * What fishing sounds like, from `at` (where the bobber is; the rod's sounds come from you): the line
 * whipping out, the plop of the bobber and its splash, the tiny tugs, the bite, the reel's clicks, and
 * the little tune for a fish (a longer one for something rare), a sad one for junk, and the fish
 * getting away.
 */
export function fishing(a: AudioCore, kind: FishingSound, at: Pos) {
  const ctx = a.ctx;
  if (!ctx) return;
  a.count(`fishing-${kind}`);
  const out = a.panner(at, 2, 1.0);
  out.connect(a.mix.effects);
  const t0 = ctx.currentTime + 0.005;
  if (kind === 'wind') {
    // The rod creaking back.
    a.blip(out, t0, rand(180, 210), 1.25, 0.12, 0.05, 'triangle');
  } else if (kind === 'cast') {
    // The line whipping through the air.
    sweep(a, out, t0, 'bandpass', 900, 3600, 0.32, 0.2, 1.4);
    a.blip(out, t0, 240, 0.6, 0.18, 0.05, 'triangle');
  } else if (kind === 'splash') {
    // A plop, then the water settling.
    a.blip(out, t0, rand(420, 520), 0.45, 0.14, 0.2);
    sweep(a, out, t0, 'lowpass', 2600, 500, 0.45, 0.17, 0.7);
    a.blip(out, t0 + 0.09, rand(700, 820), 0.6, 0.08, 0.06);
  } else if (kind === 'nibble') {
    // A tiny tick on the water.
    a.blip(out, t0, rand(620, 760), 0.7, 0.05, 0.1);
  } else if (kind === 'bite') {
    // The bobber yanked under: a deep gulp and a bright ping, to say strike.
    a.blip(out, t0, 320, 0.4, 0.18, 0.26);
    sweep(a, out, t0, 'lowpass', 1800, 400, 0.3, 0.12, 0.7);
    a.blip(out, t0 + 0.02, 1320, 1.0, 0.22, 0.09, 'triangle');
    a.blip(out, t0 + 0.02, 1980, 1.0, 0.18, 0.05, 'triangle');
  } else if (kind === 'reel') {
    // The reel's clicks, getting quicker, and the line hissing in.
    for (let i = 0; i < 9; i++) a.blip(out, t0 + i * (0.115 - i * 0.004), 1500 + i * 60, 0.5, 0.025, 0.07, 'square');
    sweep(a, out, t0, 'highpass', 3000, 5200, 0.9, 0.06, 0.7);
  } else if (kind === 'catch' || kind === 'rare') {
    // A fish out of the water: a splash and a rising arpeggio, longer and brighter for a rare one.
    sweep(a, out, t0, 'lowpass', 3000, 700, 0.35, 0.16, 0.7);
    const notes = kind === 'rare' ? [523, 659, 784, 1047, 1319, 1568] : [523, 659, 784];
    notes.forEach((f, i) => {
      a.blip(out, t0 + 0.12 + i * 0.1, f, 1.0, 0.3, 0.1, 'triangle');
      a.blip(out, t0 + 0.12 + i * 0.1, f * 2, 1.0, 0.2, 0.03);
    });
  } else if (kind === 'junk') {
    // A wet thunk and a sagging trombone.
    sweep(a, out, t0, 'lowpass', 1400, 300, 0.25, 0.2, 0.8);
    for (const [i, f] of [196, 185, 175, 147].entries()) a.blip(out, t0 + 0.18 + i * 0.16, f, 0.97, i === 3 ? 0.5 : 0.2, 0.08, 'sawtooth');
  } else {
    // It got away: a flick of the tail, and the line going slack.
    sweep(a, out, t0, 'bandpass', 2400, 900, 0.22, 0.16, 1.0);
    a.blip(out, t0 + 0.05, 500, 0.5, 0.2, 0.08);
  }
}
