// The kanban's tasks on hold in the 3D office (shared/kanban/lounge.ts): each one a view-only figure in
// the TV lounge, made like a worker with its implementer's name and colour, sitting on the beanbags and
// the couch's outer places or standing behind the couch, facing the TV, a ⏸️ over its head. More than
// fit: a sign over the couch says how many more. Aimed at, the hint says what it waits for; E opens the
// task. Only on the office's own map (a map of its own has no couch). A seat someone sits on is never a
// figure's: the figures are placed around the people's seats, the same way the server does, and move
// when someone sits down or gets up there (only the ones whose place changed). The seats they sit on
// are kept from players meanwhile (features/seating's reserveSeatPlaces; the server refuses them too).
// Nothing is left behind when the list empties, the floor changes or the map does.

import * as THREE from 'three';
import { SEATING_BY_ID, seatPlace } from '../../shared/layout';
import { loungeReservedPlaces, type LoungeFigure, type LoungePlace } from '../../shared/kanban/lounge';
import type { Ctx } from '../core/context';
import { aside, hintTitle, key, onE } from '../core/hint';
import { noOutline } from '../core/outline';
import { reserveSeatPlaces, seatsTaken } from '../features/seating';
import { store } from '../state';
import { Worker } from '../world/character';
import { disposeSprite, textSprite } from '../world/toon';
import type { Interactable } from '../world/types';
import { diffLounge, layoutLounge, loungeHint, overflowText, type PlacedFigure } from './loungemodel';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../world/types' {
  interface InteractKinds {
    hold: true;
  }
}

/** Sitting, as a worker sits at its desk (its seat anchor's size); its hips are this far above its root. */
const SEATED_SCALE = 0.82;
const HIPS = 0.1;
/** Standing, as a reviewer stands behind a chair (watch3d.ts). */
const STANDING_SCALE = 1.1;
const FEET = -0.07;
/** Where the overflow sign floats: over the couch. */
const SIGN = new THREE.Vector3(10.5, 2.35, 0);

interface Shown {
  look: string;
  spot: string;
  figure: LoungeFigure;
  anchor: THREE.Object3D;
  model: Worker;
  it: Interactable;
}

/** Where a figure's root goes on the office floor, the way it faces, and how big it is. */
function spotOf(place: LoungePlace): { x: number; y: number; z: number; rotY: number; scale: number } | null {
  if (place.kind === 'stand') return { x: place.x, y: FEET * STANDING_SCALE, z: place.z, rotY: place.rotY, scale: STANDING_SCALE };
  const seat = SEATING_BY_ID.get(place.seatId);
  if (!seat) return null;
  const p = seatPlace(seat, place.place);
  return { x: p.x, y: p.y + p.hips - HIPS, z: p.z, rotY: p.rotY, scale: SEATED_SCALE };
}

/** Registers the figures (store 'kanbanLounge', 'map'), their tick, their hint and E, and the seats they keep. */
export function installLounge3d(ctx: Ctx, deps: { openTask(taskId: number): void }) {
  const group = new THREE.Group();
  group.name = 'kanban-lounge';
  const shown = new Map<number, Shown>();
  const byIt = new Map<Interactable, Shown>();
  let sign: { sprite: THREE.Sprite; text: string } | null = null;
  /** The seat places people on your floor sit on, you included, as the figures were last placed around them. */
  let sat = '';

  /** Who sits where on your floor, you included (the figures go round everyone). */
  function occupied(): Set<string> {
    const taken = seatsTaken();
    const mine = ctx.upTop() ? undefined : ctx.player.seat?.key;
    if (mine) taken.add(mine);
    return taken;
  }

  /** Puts `anchor` (and what aiming at it lands on) at `place`. */
  function put(anchor: THREE.Object3D, it: Interactable, place: LoungePlace): boolean {
    const at = spotOf(place);
    if (!at) return false;
    anchor.position.set(at.x, at.y, at.z);
    anchor.rotation.y = at.rotY;
    anchor.scale.setScalar(at.scale);
    it.x = at.x;
    it.z = at.z;
    return true;
  }

  function drop(id: number) {
    const s = shown.get(id);
    if (!s) return;
    s.anchor.removeFromParent();
    s.model.dispose();
    s.model.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    byIt.delete(s.it);
    shown.delete(id);
  }

  function make({ figure, place, look, spot }: PlacedFigure) {
    const anchor = new THREE.Object3D();
    const it: Interactable = { kind: 'hold', x: 0, z: 0, radius: 0.6 };
    if (!put(anchor, it, place)) return;
    const model = new Worker(`${figure.name} · #${figure.taskId}`, figure.color);
    model.setCostume(store.theme.active);
    // At rest with its light out and no laptop, a ⏸️ over its head where a sleeping worker's 💤 would be.
    model.setStatus('offline', false);
    model.say('⏸️');
    anchor.add(model.root);
    noOutline(model.root);
    anchor.userData.interact = it;
    group.add(anchor);
    const s = { look, spot, figure, anchor, model, it };
    shown.set(figure.taskId, s);
    byIt.set(it, s);
  }

  function setSign(overflow: number) {
    const text = overflow > 0 ? overflowText(overflow) : '';
    if (sign?.text === text) return;
    if (sign) {
      sign.sprite.removeFromParent();
      disposeSprite(sign.sprite);
      sign = null;
    }
    if (!text) return;
    const sprite = textSprite(text, { bg: '#e9ecef', size: 30 });
    sprite.position.copy(SIGN);
    group.add(sprite);
    sign = { sprite, text };
  }

  /** Brings what's shown in line with the store and the seats taken: only what changed is taken away, made or moved. */
  function sync() {
    const office = ctx.inOffice();
    const taken = occupied();
    sat = [...taken].sort().join(',');
    const { placed, overflow } = layoutLounge(office ? store.kanbanLounge : [], taken);
    const { drop: gone, make: fresh, move } = diffLounge(new Map([...shown].map(([id, s]) => [id, s])), placed);
    for (const id of gone) drop(id);
    for (const p of fresh) make(p);
    for (const p of move) {
      const s = shown.get(p.figure.taskId)!;
      if (put(s.anchor, s.it, p.place)) s.spot = p.spot;
    }
    setSign(office ? overflow : 0);
    if (office && group.parent !== ctx.office.group) ctx.office.group.add(group);
    ctx.hint.invalidate();
  }
  store.on('kanbanLounge', sync);
  // Another map: the office's figures go with it (and come back with it).
  store.on('map', sync);
  store.on('theme', () => {
    for (const s of shown.values()) s.model.setCostume(store.theme.active);
  });

  ctx.ticks.add('others', ({ dt, t }) => {
    if (!store.kanbanLounge.length || !ctx.inOffice()) return;
    // Someone sat down or got up (you too): the figures go round them.
    if ([...occupied()].sort().join(',') !== sat) sync();
    if (!shown.size || ctx.upTop()) return;
    for (const s of shown.values()) s.model.update(dt, t);
    if (sign) sign.sprite.position.y = SIGN.y + Math.sin(t * 1.5) * 0.03;
  });

  // The seats the figures sit on aren't free for players: placed around everyone else, as the server
  // places them when it checks a sit (you're getting up from wherever you are).
  reserveSeatPlaces(() => (ctx.inOffice() ? loungeReservedPlaces(store.kanbanLounge.length, seatsTaken()) : []));
  ctx.usables.add({ usable: () => [...byIt.keys()] });

  ctx.interactions.define('hold', {
    reach: 4,
    hint: (it) => {
      const s = byIt.get(it);
      if (!s) return { k: '', parts: [] };
      const f = s.figure;
      return { k: `held|${s.figure.taskId}|${s.look}`, parts: [hintTitle(`${f.name} · on hold`), aside(loungeHint(f, Date.now())), key('E', 'Open the task')] };
    },
    use: onE((it) => {
      const s = byIt.get(it);
      if (s) deps.openTask(s.figure.taskId);
    }),
  });
}
