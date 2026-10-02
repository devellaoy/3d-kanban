// The kanban's tasks on hold in the 3D office (shared/kanban/lounge.ts): each one a view-only figure in
// the TV lounge, made like a worker with its implementer's name and colour, sitting on the beanbags and
// the couch's outer places or standing behind the couch, facing the TV, a ⏸️ over its head. More than
// fit: a sign over the couch says how many more. Aimed at, the hint says what it waits for; E opens the
// task. Only on the office's own map (a map of its own has no couch); the seats they sit on are kept
// from players meanwhile (features/seating's reserveSeatPlaces). Nothing is left behind when the list
// empties, the floor changes or the map does.

import * as THREE from 'three';
import { SEATING_BY_ID, seatPlace } from '../../shared/layout';
import { loungeReservedPlaces, type LoungeFigure, type LoungePlace } from '../../shared/kanban/lounge';
import type { Ctx } from '../core/context';
import { aside, hintTitle, key, onE } from '../core/hint';
import { noOutline } from '../core/outline';
import { reserveSeatPlaces } from '../features/seating';
import { store } from '../state';
import { Worker } from '../world/character';
import { disposeSprite, textSprite } from '../world/toon';
import type { Interactable } from '../world/types';
import { diffLounge, layoutLounge, loungeHint, overflowText } from './loungemodel';

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
  key: string;
  figure: LoungeFigure;
  anchor: THREE.Object3D;
  model: Worker;
  it: Interactable;
}

/** Where a figure's root goes on the office floor, the way it faces, and how big it is. */
function spot(place: LoungePlace): { x: number; y: number; z: number; rotY: number; scale: number } | null {
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
  let seated = 0;

  function drop(id: number) {
    const s = shown.get(id);
    if (!s) return;
    s.anchor.removeFromParent();
    s.model.dispose();
    s.model.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    byIt.delete(s.it);
    shown.delete(id);
  }

  function make(figure: LoungeFigure, place: LoungePlace, key: string) {
    const at = spot(place);
    if (!at) return;
    const anchor = new THREE.Object3D();
    anchor.position.set(at.x, at.y, at.z);
    anchor.rotation.y = at.rotY;
    anchor.scale.setScalar(at.scale);
    const model = new Worker(`${figure.name} · #${figure.taskId}`, figure.color);
    model.setCostume(store.theme.active);
    // At rest with its light out and no laptop, a ⏸️ over its head where a sleeping worker's 💤 would be.
    model.setStatus('offline', false);
    model.say('⏸️');
    anchor.add(model.root);
    noOutline(model.root);
    const it: Interactable = { kind: 'hold', x: at.x, z: at.z, radius: 0.6 };
    anchor.userData.interact = it;
    group.add(anchor);
    const s = { key, figure, anchor, model, it };
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

  /** Brings what's shown in line with the store: only what changed is taken away or made. */
  function sync() {
    const office = ctx.inOffice();
    const { placed, overflow } = layoutLounge(office ? store.kanbanLounge : []);
    const { drop: gone, make: fresh } = diffLounge(new Map([...shown].map(([id, s]) => [id, s.key])), placed);
    for (const id of gone) drop(id);
    for (const p of fresh) make(p.figure, p.place, p.key);
    setSign(office ? overflow : 0);
    seated = office ? placed.length : 0;
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
    if (!shown.size || !ctx.inOffice() || ctx.upTop()) return;
    for (const s of shown.values()) s.model.update(dt, t);
    if (sign) sign.sprite.position.y = SIGN.y + Math.sin(t * 1.5) * 0.03;
  });

  // The seats the figures sit on aren't free for players.
  reserveSeatPlaces(() => (ctx.inOffice() ? loungeReservedPlaces(seated) : []));
  ctx.usables.add({ usable: () => [...byIt.keys()] });

  ctx.interactions.define('hold', {
    reach: 4,
    hint: (it) => {
      const s = byIt.get(it);
      if (!s) return { k: '', parts: [] };
      const f = s.figure;
      return { k: `held|${s.key}`, parts: [hintTitle(`${f.name} · on hold`), aside(loungeHint(f, Date.now())), key('E', 'Open the task')] };
    },
    use: onE((it) => {
      const s = byIt.get(it);
      if (s) deps.openTask(s.figure.taskId);
    }),
  });
}
