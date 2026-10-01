import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePace, IDLE_AFTER_MS, type PaceState } from '../src/client/framepace.js';

// How often the 3D office is drawn (framepace.ts): every screen refresh while you play, 30 a second
// when idle or in the background, 15 behind a window.

const calm: PaceState = { moving: false, busy: false, modal: false, focused: true };

test('input, a hold, moving and being busy keep it at full rate; it falls to idle after 2.5 s', () => {
  const p = new FramePace();
  p.poke(1000);
  assert.equal(p.mode(1000 + IDLE_AFTER_MS - 1, calm), 'active');
  assert.equal(p.mode(1000 + IDLE_AFTER_MS, calm), 'idle');
  p.hold(5000, 1000);
  p.hold(5000, 200);
  assert.equal(p.mode(5900, calm), 'active');
  assert.equal(p.mode(6000, calm), 'idle');
  assert.equal(p.mode(60_000, { ...calm, moving: true }), 'active');
  assert.equal(p.mode(60_000, { ...calm, busy: true }), 'active');
});

test('a window open with no input is covered, an unfocused page is background, and active wins', () => {
  const p = new FramePace();
  assert.equal(p.mode(60_000, { ...calm, modal: true }), 'covered');
  assert.equal(p.mode(60_000, { ...calm, focused: false }), 'background');
  assert.equal(p.mode(60_000, { ...calm, focused: false, modal: true }), 'covered');
  assert.equal(p.mode(60_000, { ...calm, focused: false, moving: true }), 'active');
});

/** Callbacks at `hz` for `secs`, each in `mode`; the times of the drawn ones. */
function drawn(p: FramePace, from: number, secs: number, hz: number, mode: 'idle' | 'covered' | 'active'): number[] {
  const out: number[] = [];
  const step = 1000 / hz;
  for (let ts = from; ts < from + secs * 1000 - 1e-6; ts += step) {
    p.vsync(ts);
    if (p.due(ts, mode)) out.push(ts);
  }
  return out;
}

test('idle draws 30 frames a second and covered 15, evenly spaced, at 60 and 120 Hz', () => {
  for (const hz of [60, 120]) {
    for (const [mode, fps] of [['idle', 30], ['covered', 15]] as const) {
      const p = new FramePace();
      // Warm up the refresh-rate estimate first.
      drawn(p, 0, 1, hz, 'active');
      const times = drawn(p, 1000, 4, hz, mode);
      assert.ok(Math.abs(times.length - fps * 4) <= 1, `${hz} Hz ${mode}: ${times.length}`);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1e-6, `${hz} Hz ${mode} is evenly spaced`);
    }
  }
});

test('going back to active draws on the very next callback', () => {
  const p = new FramePace();
  drawn(p, 0, 1, 60, 'active');
  drawn(p, 1000, 1, 60, 'covered');
  const ts = 2000 + 1000 / 60;
  p.vsync(ts);
  assert.equal(p.due(ts, 'active'), true);
});

test('stalls are not taken for the refresh rate', () => {
  const p = new FramePace();
  drawn(p, 0, 1, 60, 'active');
  p.vsync(5000);
  p.vsync(5000 + 1000 / 60);
  const times = drawn(p, 5100, 2, 60, 'idle');
  assert.ok(Math.abs(times.length - 60) <= 1);
});
