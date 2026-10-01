/**
 * Build mode (U): furnish the floor you're on. The catalogue (B) hands you a piece, a ghost follows where
 * you aim on the floor (snapped to a half meter, green where it can go and red where it can't), a click
 * puts it down, R turns it, and aiming at one that's down, E picks it up to move and X takes it away.
 * Each piece puts a collider in the office's own list for as long as it stands, so you bump into it; the
 * walking grid workers follow (shared/nav) doesn't know about them. A floor's pieces are kept in this
 * browser under the floor's id, and put up again when you arrive on it (see store.ts).
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import { store } from '../../state';
import { modalOpen, toast } from '../../ui/dom';
import { PIECES, check, colliderOf, footprint, snap, turn, type Piece, type PieceKind, type Surroundings, type Verdict } from './model';
import { buildGhost, buildPiece, heightOf, tintGhost } from './pieces';
import { makeBuildSeats } from './sit';
import { loadPieces, newId, savePieces } from './store';
import { openCatalogue } from './ui';
import type { Collider } from '../../world/types';

/** A piece standing on the floor: what it is, how it's drawn, and the collider it has in the office. */
interface Live {
  piece: Piece;
  group: THREE.Group;
  collider: Collider | null;
}

const WHY: Record<Exclude<Verdict, { ok: true }>['why'], string> = {
  outside: 'That is off the floor',
  blocked: 'Something is in the way there',
  piece: 'Another piece is there',
  you: 'You are standing there',
};

/** How far you can reach to pick a piece, and to place one, in meters. */
const REACH = 9;

export function installBuild(ctx: Ctx) {
  const root = new THREE.Group();
  root.name = 'build-pieces';
  ctx.office.group.add(root);
  const live = new Map<string, Live>();
  /** Sitting on the chairs and sofas (see sit.ts). */
  const sit = makeBuildSeats(ctx);
  /** The floor whose pieces are up. */
  let floor: string | null = null;

  let active = false;
  let selected: PieceKind | null = null;
  let rot = 0;
  /** The piece lifted to move it: put back where it was if you cancel. */
  let holding: Piece | null = null;
  let ghost: { kind: PieceKind; group: THREE.Group } | null = null;
  let spot: { piece: Piece; verdict: Verdict } | null = null;
  let aimed: Live | null = null;
  let catalogueClosedAt = 0;

  const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ffd23f'));
  outline.visible = false;
  ctx.scene.add(outline);

  const buildable = () => !!store.floor && !store.floor.startsWith('@') && ctx.inOffice() && !ctx.upTop();
  const pieces = () => [...live.values()].map((l) => l.piece);
  const save = () => floor && savePieces(floor, pieces());

  // ---- The pieces on the floor -----------------------------------------------------------------

  function place(piece: Piece) {
    const group = buildPiece(piece.kind);
    group.position.set(piece.x, 0, piece.z);
    group.rotation.y = (piece.r * Math.PI) / 2;
    group.userData.buildId = piece.id;
    root.add(group);
    const collider = colliderOf(piece);
    if (collider) ctx.office.colliders.push(collider);
    live.set(piece.id, { piece, group, collider });
    sit.add(piece, group);
  }

  function take(id: string) {
    const l = live.get(id);
    if (!l) return;
    sit.remove(id);
    live.delete(id);
    root.remove(l.group);
    l.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    if (l.collider) {
      const i = ctx.office.colliders.indexOf(l.collider);
      if (i >= 0) ctx.office.colliders.splice(i, 1);
    }
  }

  /** The floor you're on: its pieces up, the last floor's down (the office is one room that every floor reuses). */
  function sync() {
    const want = buildable() ? store.floor : null;
    if (want === floor) return;
    if (active) exit();
    sit.standUp();
    for (const id of [...live.keys()]) take(id);
    floor = want;
    if (want) for (const p of loadPieces(want)) place(p);
  }
  store.on('floor', sync);

  // ---- The mode ---------------------------------------------------------------------------------

  function enter() {
    if (active) return;
    if (!buildable()) return toast('Build mode is for the office floors: take the elevator to one first', 'warn');
    sync();
    // Moving and removing is for the standing: up off the sofa first.
    sit.standUp();
    ctx.activities.stopAll('start', ['build']);
    active = true;
    ctx.hint.invalidate();
    ctx.hud.refresh();
    showCatalogue();
  }

  /** Back to the game: the ghost gone, and a piece you were moving back where it stood. */
  function exit() {
    if (!active) return;
    drop();
    active = false;
    aimed = null;
    outline.visible = false;
    ctx.hint.invalidate();
    ctx.hud.refresh();
  }

  /** Lets go of the piece in hand: a moved one goes back where it was. */
  function drop() {
    if (holding && floor) {
      place(holding);
      save();
    }
    holding = null;
    selected = null;
    if (ghost) ghost.group.visible = false;
    spot = null;
    ctx.hint.invalidate();
  }

  function showCatalogue() {
    openCatalogue({
      current: selected,
      onPick: (kind) => {
        catalogueClosedAt = performance.now();
        drop();
        selected = kind;
        ctx.hint.invalidate();
      },
      onClose: () => (catalogueClosedAt = performance.now()),
    });
  }

  /** Esc: lets go of what you hold, and then leaves build mode. */
  function back() {
    if (selected) drop();
    else exit();
  }

  // ---- Aiming -----------------------------------------------------------------------------------

  const ray = new THREE.Raycaster();
  const middle = new THREE.Vector2(0, 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();

  function aim() {
    ray.setFromCamera(middle, ctx.camera);
    ray.far = REACH * 2;
    // A piece you're pointing at, when you hold none.
    aimed = null;
    if (!selected) {
      const hit = ray.intersectObjects([...live.values()].map((l) => l.group), true)[0];
      if (hit && hit.distance <= REACH) {
        for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
          const id = o.userData.buildId as string | undefined;
          if (id) aimed = live.get(id) ?? null;
        }
      }
    }
    if (aimed) {
      const f = footprint(aimed.piece);
      (outline.box as THREE.Box3).min.set(f.minX, 0, f.minZ);
      (outline.box as THREE.Box3).max.set(f.maxX, heightOf(aimed.piece.kind), f.maxZ);
      outline.visible = true;
    } else outline.visible = false;
    // Where a held piece would stand: the floor under the crosshair.
    spot = null;
    if (selected && ray.ray.intersectPlane(plane, hitPoint) && hitPoint.distanceTo(ray.ray.origin) <= REACH) {
      const piece: Piece = { id: holding?.id ?? 'ghost', kind: selected, x: snap(hitPoint.x), z: snap(hitPoint.z), r: rot };
      const around: Surroundings = { colliders: ctx.office.colliders.filter((c) => ![...live.values()].some((l) => l.collider === c)), pieces: pieces(), you: ctx.player.pos };
      spot = { piece, verdict: check(piece, around) };
    }
    if (!selected || !spot) {
      if (ghost) ghost.group.visible = false;
      return;
    }
    if (ghost?.kind !== selected) {
      if (ghost) ctx.scene.remove(ghost.group);
      ghost = { kind: selected, group: buildGhost(selected) };
      ctx.scene.add(ghost.group);
    }
    ghost.group.visible = true;
    ghost.group.position.set(spot.piece.x, 0.01, spot.piece.z);
    ghost.group.rotation.y = (rot * Math.PI) / 2;
    tintGhost(ghost.group, spot.verdict.ok);
  }
  ctx.ticks.add('aim', () => {
    if (!active) return;
    // Down the stairs to the street or the garage, you've left the floor you were furnishing (a jump never goes that low).
    if (ctx.player.pos.y < -1.5) return exit();
    if (modalOpen()) {
      outline.visible = false;
      if (ghost) ghost.group.visible = false;
      return;
    }
    aim();
    ctx.hint.invalidate();
  });

  // ---- Using it ---------------------------------------------------------------------------------

  /** Puts the piece in hand down where the ghost is. */
  function putDown() {
    if (!selected || !spot) return;
    if (!spot.verdict.ok) return toast(WHY[spot.verdict.why], 'warn');
    if (live.size >= 80) return toast('That is plenty of furniture for one floor', 'warn');
    place({ ...spot.piece, id: newId() });
    save();
    holding = null;
    // A moved piece is done; a new one is yours to place again.
    if (spot.piece.id !== 'ghost') selected = null;
  }

  function removeAimed() {
    if (!aimed) return false;
    take(aimed.piece.id);
    aimed = null;
    save();
    return true;
  }

  function moveAimed() {
    if (!aimed) return false;
    const p = aimed.piece;
    take(p.id);
    aimed = null;
    holding = p;
    selected = p.kind;
    rot = p.r;
    return true;
  }

  ctx.activities.add({
    id: 'build',
    active: () => active,
    // Walking over to someone is no reason to stop furnishing.
    stop: (why) => {
      if (why !== 'walk') exit();
    },
    key: (e) => {
      switch (e.code) {
        case 'Escape':
          back();
          return true;
        case 'KeyU':
          exit();
          return true;
        case 'KeyB':
          showCatalogue();
          return true;
        case 'KeyR':
          if (selected) rot = turn(rot);
          return true;
        // Holding a piece, E and X do nothing rather than reach the desk or door behind it.
        case 'KeyE':
          return selected ? true : moveAimed();
        case 'KeyX':
        case 'Delete':
        case 'Backspace':
          return selected ? true : removeAimed();
      }
      return false;
    },
    hint: (el) => {
      const verdict = spot?.verdict;
      ctx.hint.draw(el, `build|${selected ?? '-'}|${holding ? 'h' : ''}|${aimed ? aimed.piece.kind : '-'}|${verdict ? (verdict.ok ? 'ok' : verdict.why) : '-'}|${rot}`, () => {
        if (selected) {
          const def = PIECES[selected];
          const title = !spot ? `🛠️ Aim at the floor (${def.label})` : !spot.verdict.ok ? `🚫 ${WHY[spot.verdict.why]}` : `🛠️ ${holding ? 'Moving' : 'Placing'} ${def.label.toLowerCase()}`;
          return [hintTitle(title), key('Click', 'Place'), key('R', 'Turn'), key('B', 'Catalogue'), key('Esc', holding ? 'Put back' : 'Let go')];
        }
        return [hintTitle(aimed ? `🛠️ ${PIECES[aimed.piece.kind].label}` : '🛠️ Build mode'), aimed ? key('E', 'Move') : aside('aim at a piece to change it'), aimed ? key('X', 'Remove') : '', key('B', 'Catalogue'), key('U', 'Done')];
      });
    },
  });

  // A click places (a first click only takes the mouse, as everywhere else).
  ctx.canvas.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0 || modalOpen() || !selected) return;
    if (ctx.player.locked || !ctx.player.canLock) putDown();
  });
  // Esc frees the mouse before the page sees the key; that steps back too. A window opening or closing frees it as well, which isn't.
  document.addEventListener('pointerlockchange', () => {
    if (!active || ctx.player.locked || modalOpen() || performance.now() - catalogueClosedAt < 600) return;
    back();
  });

  // Not while you're in the middle of something else: U in a car is the race records, for one (build mode itself is an activity, whose key() answers U first).
  ctx.keys.bind({ code: 'KeyU', when: () => active || !ctx.activities.busy(), run: () => void (active ? exit() : enter()) });

  return { enter, exit, active: () => active, pieces };
}
