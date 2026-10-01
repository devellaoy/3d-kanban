/**
 * Fishing off the end of the lake's dock and the beach pier: E at the sign, hold E to cast (the meter
 * says how far), wait for the bobber to go under, E to strike. What you catch goes in a journal (I),
 * kept in this browser.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { $, h, toast } from '../../ui/dom';
import { disposeSprite, textSprite } from '../../world/toon';
import { Angler, REEL_TIME, type AnglerEvent } from './angler';
import { STRIKE_WINDOW, catchText, lengthText, RARITY_NAMES, type Catch } from './catch';
import { logCast, logCatch, logMiss, totals } from './journal';
import { loadJournal, saveJournal } from './save';
import { clampHeading, landing, spotNear, type Spot } from './spots';
import { openJournal } from './ui';
import { FishingWorld } from './world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    fishing: true;
  }
}

/** How far you may wander from where you started before the line comes in (m). */
const WANDER = 2.4;
/** How far either side of the water's direction you may cast (radians). */
const AIM_LIMIT = 1.25;

export function installFishing(ctx: Ctx) {
  const world = new FishingWorld();
  ctx.office.group.add(world.group);
  ctx.usables.add({ usable: () => world.interactables });
  let journal = loadJournal();
  const save = () => saveJournal(journal);

  let angler = new Angler();
  let fishing: Spot | null = null;
  const stand = new THREE.Vector3();
  /** The way the rod points (a heading), and when the last nibble was (seconds). */
  let aim = 0;
  let nibbledAt = -10;

  // The meter over the hint: the cast's power, and the strike's time running out.
  const fill = h('span.throw-fill');
  const title = h('div.throw-title');
  const meter = h('div.throw.panel.fishing-meter.hidden', { 'aria-label': 'Fishing' }, title, h('div.throw-meter', {}, fill));
  $('hud').append(meter);
  let meterKey = '';
  function renderMeter(now: number) {
    const s = fishing ? angler.stage : 'ready';
    const frac = s === 'wind' ? angler.power(now) : s === 'bite' ? Math.max(0, 1 - angler.sinceBite(now) / STRIKE_WINDOW) : 0;
    const k = `${s}|${frac.toFixed(2)}`;
    if (k === meterKey) return;
    meterKey = k;
    const on = s === 'wind' || s === 'bite';
    meter.classList.toggle('hidden', !on);
    fill.classList.toggle('strike', s === 'bite');
    fill.style.width = `${Math.round(frac * 100)}%`;
    title.textContent = s === 'bite' ? '🐟 Strike! Press E now' : '🎣 Let go to cast';
  }

  const now = () => performance.now() / 1000;
  const street = () => ctx.player.street;
  /** Where in the world the bobber is, for sounds. */
  const bobberAt = new THREE.Vector3();
  const soundAt = () => ({ x: bobberAt.x, y: bobberAt.y + street(), z: bobberAt.z });

  function start(spot: Spot) {
    if (fishing || ctx.trip() || ctx.upTop()) return;
    if (ctx.player.seat) return toast('🎣 Stand up first', 'warn');
    const carrying = ctx.carrying();
    if (carrying) return toast('✋ Your hands are full: put the card down first (Q)', 'warn');
    ctx.activities.stopAll('start');
    angler = new Angler();
    fishing = spot;
    stand.copy(ctx.player.pos);
    aim = spot.heading;
    world.showRig(true);
    ctx.hint.invalidate();
  }

  function stop(message?: string) {
    if (!fishing) return;
    fishing = null;
    angler.cancelWind();
    world.showRig(false);
    meter.classList.add('hidden');
    meterKey = '';
    if (message) toast(message);
    ctx.hint.invalidate();
  }

  ctx.interactions.define('fishing', {
    reach: 3.6,
    hint: (it) => {
      const spot = world.spotOf.get(it);
      const t = totals(journal);
      return { k: `${spot?.id}|${t.fish}`, parts: [hintTitle(`🎣 ${spot?.name ?? 'Fishing spot'}`), aside(t.fish ? `${t.fish} fish caught` : 'walk to the end and cast'), key('E', 'Fish here'), key('I', 'Journal')] };
    },
    use: onE((it) => {
      const spot = world.spotOf.get(it);
      if (spot) start(spot);
    }),
  });

  function showJournal() {
    angler.reelIn(now());
    openJournal(journal, () => ctx.hint.invalidate());
  }
  ctx.windowOpened.add(() => angler.cancelWind());
  // I opens the journal at the signs, and wherever you fish.
  ctx.keys.bind({
    code: 'KeyI',
    when: () => !!spotNear(ctx.player.pos.x, ctx.player.pos.z, 5) && ctx.inOffice() && !ctx.upTop(),
    run: () => showJournal(),
  });

  ctx.activities.add({
    id: 'fisher',
    active: () => fishing !== null,
    stop: () => stop(),
    key: (e) => {
      if (e.code === 'KeyQ') {
        stop('🎣 Reeled in');
        return true;
      }
      if (e.code === 'KeyI') {
        if (!e.repeat) showJournal();
        return true;
      }
      if (e.code !== 'KeyE') return false;
      if (e.repeat) return true;
      if (angler.windUp(now())) ctx.sound.fishing('wind', soundAt());
      else strike();
      return true;
    },
    hint: (el) => {
      const s = angler.stage;
      ctx.hint.draw(el, `fish|${s}`, () => {
        const title = hintTitle('🎣 Fishing');
        if (s === 'ready') return [title, key('E', 'Hold to cast'), key('I', 'Journal'), key('Q', 'Pack up')];
        if (s === 'wind') return [title, aside('let go to cast — the fuller, the further')];
        if (s === 'cast') return [title, aside('…')];
        if (s === 'wait') return [title, aside('wait for the bobber to go under'), key('E', 'Strike'), key('Q', 'Reel in')];
        if (s === 'bite') return [title, aside('it bit!'), key('E', 'Strike!')];
        return [title, aside('got one…')];
      });
    },
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyE' && fishing && angler.stage === 'wind') cast();
  });
  window.addEventListener('blur', () => angler.cancelWind());

  /** The way you're pointing: where you look, kept within reach of the water. */
  function aimNow(): number {
    const p = ctx.player;
    return clampHeading(p.camYaw + Math.PI, fishing!.heading, AIM_LIMIT);
  }

  function cast() {
    const spot = fishing!;
    aim = aimNow();
    const p = ctx.player.pos;
    const d = angler.release(now(), spot.water, (dist) => landing(spot.water, p.x, p.z, aim, dist));
    if (d === null) {
      toast('🎣 No open water that way', 'warn');
      return;
    }
    ctx.sound.fishing('cast', soundAt());
    journal = logCast(journal);
    save();
  }

  function strike() {
    const result = angler.strike(now());
    if (result === 'hooked') ctx.sound.fishing('reel', soundAt());
    else if (result === 'spooked' || result === 'late') {
      journal = logMiss(journal);
      save();
      ctx.sound.fishing('away', soundAt());
      toast(result === 'spooked' ? '🎣 Too early — you scared it off' : '🎣 Too slow — it got away', 'warn');
    }
    ctx.hint.invalidate();
  }

  // ---- What's caught ---------------------------------------------------------------------------

  let popup: { sprite: THREE.Sprite; t: number } | null = null;
  function showCatch(c: Catch) {
    if (popup) {
      world.group.remove(popup.sprite);
      disposeSprite(popup.sprite);
    }
    const sprite = textSprite(c.species.kind === 'junk' ? `${c.species.icon} ${c.species.name}` : `${c.species.icon} ${lengthText(c.cm)}`, { bg: '#ffffff', size: 56, border: '#2b2d42' });
    world.group.add(sprite);
    popup = { sprite, t: 0 };
  }

  function landed() {
    const c = angler.caught;
    const spot = fishing;
    if (!c || !spot) return;
    const logged = logCatch(journal, c, spot.name, Date.now());
    journal = logged.journal;
    save();
    showCatch(c);
    const rare = c.species.rarity >= 3 && c.species.kind === 'fish';
    ctx.sound.fishing(c.species.kind === 'junk' ? 'junk' : rare ? 'rare' : 'catch', soundAt());
    const extra = logged.first ? ` — new in your journal! (${RARITY_NAMES[c.species.rarity]})` : logged.record ? ' — a new personal best!' : '';
    toast(`🎣 ${catchText(c)}${extra}`);
    if (rare || logged.record) ctx.confetti.burst(ctx.player.pos.x, ctx.player.pos.y + 1.6, ctx.player.pos.z, rare ? 160 : 90, 0.6);
  }

  function handle(events: AnglerEvent[]) {
    for (const ev of events) {
      if (ev === 'landed') {
        ctx.sound.fishing('splash', soundAt());
        world.ring(bobberAt.x, bobberAt.y, bobberAt.z, now());
      } else if (ev === 'nibble') {
        nibbledAt = now();
        ctx.sound.fishing('nibble', soundAt());
        world.ring(bobberAt.x, bobberAt.y, bobberAt.z, now());
      } else if (ev === 'bite') {
        nibbledAt = now();
        ctx.sound.fishing('bite', soundAt());
        world.ring(bobberAt.x, bobberAt.y, bobberAt.z, now());
        ctx.hint.invalidate();
      } else if (ev === 'missed') {
        journal = logMiss(journal);
        save();
        ctx.sound.fishing('away', soundAt());
        toast('🎣 It got away — be quicker next time', 'warn');
        ctx.hint.invalidate();
      } else if (ev === 'landedIn') {
        landed();
        ctx.hint.invalidate();
      }
    }
  }

  // ---- Every frame -----------------------------------------------------------------------------

  const base = new THREE.Vector3();
  const at = new THREE.Vector3();
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

  ctx.ticks.add('play', ({ dt }) => {
    // Hide the signs and everything while you're nowhere near them (they're far from the office).
    const p = ctx.player.pos;
    const inReach = ctx.inOffice() && !ctx.upTop();
    world.group.visible = inReach && !!spotNear(p.x, p.z, 120);
    world.setStreet(street());
    for (const it of world.interactables) it.y = street() + (world.spotOf.get(it)?.deck ?? 0);
    if (popup) {
      popup.t += dt;
      popup.sprite.position.set(p.x, p.y - street() + 2.3 + popup.t * 0.25, p.z);
      popup.sprite.material.opacity = Math.min(1, (3 - popup.t) / 0.6);
      if (popup.t >= 3) {
        world.group.remove(popup.sprite);
        disposeSprite(popup.sprite);
        popup = null;
      }
    }
    if (!fishing) return;
    const t = now();
    if (!inReach || ctx.trip() || ctx.player.seat || Math.hypot(p.x - stand.x, p.z - stand.z) > WANDER || Math.abs(p.y - stand.y) > 1.2) {
      stop('🎣 You reeled in and walked off');
      return;
    }
    const spot = fishing;
    const hd = angler.stage === 'ready' || angler.stage === 'wind' ? aimNow() : aim;
    const fwd = { x: Math.sin(hd), z: Math.cos(hd) };
    const right = { x: -Math.cos(hd), z: Math.sin(hd) };
    const lift = angler.stage === 'wind' ? 0.95 + 0.45 * angler.power(t) : angler.stage === 'bite' ? 0.45 : 0.8;
    base.set(p.x + fwd.x * 0.5 + right.x * 0.3, p.y - street() + 1.05, p.z + fwd.z * 0.5 + right.z * 0.3);
    world.drawRod(base, hd, lift);
    const tip = world.tipAt;
    const land = angler.landed;
    const water = spot.surface;
    let slack = 0.15;
    let tilt = 0;
    switch (angler.stage) {
      case 'ready':
      case 'wind':
        at.set(tip.x, tip.y - 0.9, tip.z);
        slack = 0.6;
        break;
      case 'cast': {
        const u = angler.flown(t);
        const arc = Math.sin(u * Math.PI) * (1.4 + (land?.distance ?? 6) * 0.07);
        at.set(lerp(tip.x, land!.x, u), lerp(tip.y, water + 0.03, u) + arc, lerp(tip.z, land!.z, u));
        slack = 0;
        break;
      }
      case 'wait':
      case 'bite': {
        const since = t - nibbledAt;
        const dip = since < 0.4 ? -0.07 * Math.sin((since / 0.4) * Math.PI) : 0;
        const under = angler.stage === 'bite' ? -0.14 * Math.min(1, angler.sinceBite(t) / 0.12) : 0;
        at.set(land!.x, water + 0.03 + Math.sin(t * 2.3) * 0.01 + dip + under, land!.z);
        tilt = Math.sin(t * 3.1) * 0.12;
        break;
      }
      case 'reel': {
        const u = Math.min(1, (t - angler.since) / REEL_TIME);
        at.set(lerp(land!.x, tip.x, u), lerp(water, tip.y - 0.2, u) + Math.sin(u * Math.PI) * 0.8, lerp(land!.z, tip.z, u));
        slack = 0.1;
        break;
      }
    }
    bobberAt.copy(at);
    world.drawBobber(at, slack, tilt, angler.stage === 'bite');
    handle(angler.update(t));
    world.update(t);
    renderMeter(t);
  });

  return { journal: () => journal, showJournal, fishing: () => fishing !== null };
}
