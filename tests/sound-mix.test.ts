// Each kind of office sound's own volume (gh:devellaoy/3d-kanban#80): what's saved is read back safely
// (sound/mix.ts), each sound goes out through its own kind's gain (sound/core.ts and the recipes), on a
// few-line stand-in for Web Audio, and the volume row in ⚙️ Settings (ui/settings-mix.ts), on a stand-in
// for the DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- Stand-ins -----------------------------------------------------------------------------------

/** An AudioParam as far as the sounds go: its value, which an eased change lands on at once. */
class FakeParam {
  value = 0;
  setValueAtTime() {
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
}

/** Any audio node: where it's connected to, and every param a sound sets. */
class FakeNode {
  outs: FakeNode[] = [];
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  detune = new FakeParam();
  playbackRate = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
  constructor(readonly kind: string) {}
  connect<T>(to: T): T {
    this.outs.push(to as FakeNode);
    return to;
  }
  disconnect() {}
  start() {}
  stop() {}
  getFloatTimeDomainData() {}
}

class FakeAudioContext {
  state = 'running';
  currentTime = 1;
  sampleRate = 800;
  destination = new FakeNode('destination');
  listener = new FakeNode('listener');
  readonly made: FakeNode[] = [];
  private node(kind: string) {
    const n = new FakeNode(kind);
    this.made.push(n);
    return n;
  }
  createGain = () => this.node('gain');
  createDynamicsCompressor = () => this.node('compressor');
  createAnalyser = () => this.node('analyser');
  createBiquadFilter = () => this.node('filter');
  createPanner = () => this.node('panner');
  createOscillator = () => this.node('oscillator');
  createBufferSource = () => this.node('source');
  createBuffer = (_ch: number, length: number) => ({ length, getChannelData: () => new Float32Array(length) });
  resume = async () => {};
}

/** An element as far as a volume row goes: attributes, children, classes and listeners that can be fired. */
class FakeEl {
  className = '';
  value = '';
  children: (FakeEl | string)[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, (() => void)[]>();
  classList = { toggle: () => {} };
  style = { setProperty: () => {} };
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  set textContent(t: string) {
    this.children = [t];
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
}

const g = globalThis as Record<string, unknown>;
g.AudioContext = FakeAudioContext;
g.window = { addEventListener: () => {} };
g.Node = FakeEl;
g.document = { hidden: false, addEventListener: () => {}, createElement: (tag: string) => new FakeEl(tag) };

const { MIXES, cleanMix, mixDefaults, mixGain } = await import('../src/client/sound/mix.js');
const { AudioCore } = await import('../src/client/sound/core.js');
const { step, stepAt, paper } = await import('../src/client/sound/steps.js');
const { Rain, thunder } = await import('../src/client/sound/weather.js');
const { ding } = await import('../src/client/sound/alerts.js');
const { gong } = await import('../src/client/features/gong/sound.js');
const { volumeRow } = await import('../src/client/ui/settings-mix.js');

/** Whether sound from `from` reaches `to`. */
function feeds(from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.outs.some((n) => feeds(n, to, seen));
}

/** A started core, and the kinds that what `play` makes reaches (by the nodes it adds). */
function core(levels = mixDefaults()) {
  const a = new AudioCore({ start: () => {}, touched: () => {} });
  a.setMix(levels);
  a.unlock();
  const ctx = a.ctx as unknown as FakeAudioContext;
  const mix = a.mix as unknown as Record<string, FakeNode>;
  const reaches = (play: () => void) => {
    const before = ctx.made.length;
    play();
    const added = ctx.made.slice(before);
    assert.ok(added.length, 'the sound made nodes');
    return MIXES.filter((k) => added.some((n) => feeds(n, mix[k])));
  };
  return { a, ctx, mix, reaches };
}

// ---- What's saved --------------------------------------------------------------------------------

test('saved levels come back clamped, and anything missing or broken at its default', () => {
  const full = { volume: 1, muted: false };
  assert.deepEqual(mixDefaults(), Object.fromEntries(MIXES.map((k) => [k, full])));
  for (const junk of [null, undefined, 'loud', 7, []]) assert.deepEqual(cleanMix(junk), mixDefaults(), `from ${JSON.stringify(junk)}`);
  const back = cleanMix({ rain: { volume: 0.4, muted: true }, steps: { volume: 3 }, thumps: { volume: -1, muted: 'yes' }, typing: { volume: Number.NaN }, nonsense: { volume: 0 } });
  assert.deepEqual(back.rain, { volume: 0.4, muted: true });
  assert.deepEqual(back.steps, full);
  assert.deepEqual(back.thumps, { volume: 0, muted: false });
  assert.deepEqual(back.typing, full);
  assert.equal('nonsense' in back, false);
});

test("a level's gain is squared like the master's, and nothing while muted", () => {
  assert.equal(mixGain({ volume: 0.5, muted: false }), 0.25);
  assert.equal(mixGain({ volume: 1, muted: false }), 1);
  assert.equal(mixGain({ volume: 0.8, muted: true }), 0);
});

// ---- Where each sound goes -----------------------------------------------------------------------

test('each sound goes out through its own kind', () => {
  const { a, reaches } = core();
  assert.deepEqual(reaches(() => step(a, 'land')), ['thumps']);
  assert.deepEqual(reaches(() => step(a, 'walk')), ['steps']);
  assert.deepEqual(reaches(() => stepAt(a, 2, 0)), ['steps']);
  assert.deepEqual(reaches(() => paper(a)), ['typing']);
  assert.deepEqual(reaches(() => thunder(a, 0.5, 1)), ['rain']);
  a.weather.rain = 1;
  const rain = new Rain(a);
  assert.deepEqual(reaches(() => rain.tickRain(1)), ['rain']);
  // With no kind of its own, a sound is an effect.
  assert.deepEqual(reaches(() => a.play(a.buf.drop, {})), ['effects']);
  assert.deepEqual(reaches(() => gong(a, 'hit')), ['effects']);
  assert.deepEqual(reaches(() => gong(a, 'merged')), ['alerts']);
  assert.deepEqual(reaches(() => ding(a, 'done')), ['alerts']);
});

test("the alerts skip the room, so they're heard from another tab; every other kind goes through it", () => {
  const { mix } = core();
  const room = mix.effects.outs[0];
  for (const k of MIXES) if (k !== 'alerts') assert.deepEqual(mix[k].outs, [room], k);
  assert.deepEqual(mix.alerts.outs, room.outs, 'the alerts go straight to the master');
});

test('the saved levels hold from the very start, and muting the effects leaves the alerts on', () => {
  const levels = { ...mixDefaults(), rain: { volume: 0.5, muted: false }, effects: { volume: 1, muted: true } };
  const { a, mix } = core(levels);
  // Set outright when the graph is made, not eased in from full.
  assert.equal(mix.rain.gain.value, 0.25);
  assert.equal(mix.effects.gain.value, 0);
  assert.equal(mix.alerts.gain.value, 1);
  a.setMix({ ...levels, alerts: { volume: 0.4, muted: true } });
  assert.equal(mix.alerts.gain.value, 0);
  assert.equal(mix.rain.gain.value, 0.25);
});

// ---- The volume row in ⚙️ Settings ----------------------------------------------------------------

test('dragging the slider sets the level and unmutes; the mute keeps the level', () => {
  let level = { volume: 0.7, muted: true };
  const row = volumeRow('Rain', () => level, (l) => (level = l)) as unknown as FakeEl;
  const [mute, slider, pct] = row.children as FakeEl[];
  assert.equal(slider.attrs.get('aria-label'), 'Rain volume');
  assert.equal(mute.attrs.get('aria-label'), 'Mute rain');
  assert.equal(mute.attrs.get('aria-pressed'), 'true');
  assert.equal(pct.textContent, 'Muted');
  slider.value = '40';
  slider.fire('input');
  assert.deepEqual(level, { volume: 0.4, muted: false });
  assert.equal(pct.textContent, '40%');
  mute.fire('click');
  assert.deepEqual(level, { volume: 0.4, muted: true });
  assert.equal(mute.attrs.get('aria-pressed'), 'true');
  mute.fire('click');
  assert.deepEqual(level, { volume: 0.4, muted: false });
  assert.equal(pct.textContent, '40%');
});
