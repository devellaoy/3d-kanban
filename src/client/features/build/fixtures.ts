/**
 * Build mode for the office's own furniture: the desks, bean bags, couch, coffee table, poufs, whiteboard and rugs (see
 * shared/arrange.ts). Unlike the pieces you place from the catalogue, which are yours and live in this
 * browser, these are the floor's: whoever moves one moves it for everyone on the floor, and the office
 * keeps it. Aim at one and E picks it up (the real thing follows where you aim, green where it can
 * stand and red where it can't, R turns it a quarter), a click puts it down, Esc puts it back, X takes
 * it out and H puts it back where the office comes with it. One taken out comes back from the
 * catalogue (B), and so does a bean bag: none is on the floor until somebody puts one down there. The check is shared/arrange-check.ts, the one the office makes before it keeps a move.
 */
import * as THREE from 'three';
import { MOVABLE_BY_ID, furnitureKey, keepOf, nameOf as furnitureName, poseAt, sentence, type Movable, type Spot } from '../../../shared/arrange';
import { checkPlace, whyNot } from '../../../shared/arrange-check';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import { store } from '../../state';
import { toast } from '../../ui/dom';
import { toon } from '../../world/toon';

/** How far you can reach, and the grid a piece snaps to. */
const REACH = 9;
const SNAP = 0.1;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

type Verdict = { ok: true } | { ok: false; why: string };

/** What a piece is called in a hint. */
const nameOf = (m: Movable) => furnitureName(m);

export function makeFixtureBuild(ctx: Ctx) {
  const arrange = () => ctx.office.arrange;
  const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ffd23f'));
  outline.visible = false;
  ctx.scene.add(outline);
  const good = toon('#59d37a', { opacity: 0.55 });
  const bad = toon('#e5484d', { opacity: 0.55 });

  /** The piece you aim at (when you hold none). */
  let aimed: string | null = null;
  /** The piece in your hands: its turn so far, and where it would stand. */
  let held: { id: string; r: number; spot: Spot | null } | null = null;
  let verdict: Verdict = { ok: true };
  let verdictKey = '';
  /** A move sent and not heard back: put it back if nothing came of it. */
  let pending: { id: string; furniture: unknown; timer: ReturnType<typeof setTimeout> } | null = null;
  const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  const furniture = () => store.floorPlan.furniture;
  const movable = (id: string) => MOVABLE_BY_ID.get(id)!;

  // ---- Drawing the piece you carry --------------------------------------------------------------

  /** Paints what's carried green or red, remembering how it looked. */
  function tint(id: string, ok: boolean) {
    const skip = arrange().untinted(id);
    const root = arrange().groups().find((g) => arrange().idOf(g) === id);
    if (!root) return;
    const walk = (o: THREE.Object3D) => {
      if (skip.includes(o)) return;
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        if (!saved.has(m)) saved.set(m, m.material);
        m.material = ok ? good : bad;
      }
      o.children.forEach(walk);
    };
    walk(root);
  }

  function untint() {
    for (const [m, material] of saved) m.material = material;
    saved.clear();
  }

  // ---- Aiming ------------------------------------------------------------------------------------

  /** Whether `o` and everything it hangs from is shown. */
  const shown = (o: THREE.Object3D | null) => {
    for (; o; o = o.parent) if (!o.visible) return false;
    return true;
  };

  /** The piece of furniture the ray lands on, if one is within reach. */
  function hit(ray: THREE.Raycaster): string | null {
    for (const h of ray.intersectObjects(arrange().groups(), true)) {
      if (h.distance > REACH) break;
      if (shown(h.object)) return arrange().idOf(h.object) ?? null;
    }
    return null;
  }

  /** Aimed at something that's the floor's: outlined, and E, X and H are for it. */
  function aim(ray: THREE.Raycaster, enabled = true) {
    aimed = held || !enabled ? null : hit(ray);
    if (aimed) {
      const group = arrange().groups().find((g) => arrange().idOf(g) === aimed)!;
      (outline.box as THREE.Box3).setFromObject(group);
      outline.visible = true;
    } else outline.visible = false;
  }

  /** Why a spot is no good, in words, or ok. The quick checks every time it moves; the one that walks the floor only when the spot or the floor changes. */
  function judge(id: string, spot: Spot): Verdict {
    const k = `${id}|${spot.x}|${spot.z}|${spot.r}|${furnitureKey(furniture())}|${Math.round(ctx.player.pos.x * 10)}|${Math.round(ctx.player.pos.z * 10)}`;
    if (k === verdictKey) return verdict;
    verdictKey = k;
    const m = movable(id);
    const quick = checkPlace(furniture(), id, spot, { walking: false });
    if (!quick.ok) return (verdict = { ok: false, why: whyNot(quick, nameOf(m)) });
    // A rug lies flat under everything: nothing else to mind.
    if (m.kind === 'rug') return (verdict = { ok: true });
    const pose = poseAt(m, spot);
    const rects = keepOf(m, pose);
    const mine = arrange().colliders();
    for (const c of ctx.office.colliders) {
      if (mine.has(c) || c.top <= 0.03 || (c.bottom ?? 0) >= 1.2) continue;
      if (rects.some((r) => r[0] < c.maxX - 1e-6 && r[1] > c.minX + 1e-6 && r[2] < c.maxZ - 1e-6 && r[3] > c.minZ + 1e-6)) return (verdict = { ok: false, why: 'Something is in the way there' });
    }
    const you = ctx.player.pos;
    if (rects.some((r) => you.x > r[0] - 0.4 && you.x < r[1] + 0.4 && you.z > r[2] - 0.4 && you.z < r[3] + 0.4)) return (verdict = { ok: false, why: 'You are standing there' });
    const full = checkPlace(furniture(), id, spot);
    return (verdict = full.ok ? { ok: true } : { ok: false, why: whyNot(full, nameOf(m)) });
  }

  /** What you carry follows the crosshair on the floor. */
  function carry(point: THREE.Vector3 | null) {
    if (!held) return;
    const m = movable(held.id);
    if (!point) return;
    held.spot = { x: snap(point.x), z: snap(point.z), r: m.turns ? held.r : 0 };
    verdict = judge(held.id, held.spot);
    arrange().carry(held.id, poseAt(m, held.spot));
    tint(held.id, verdict.ok);
  }

  // ---- Using it ----------------------------------------------------------------------------------

  /** E: lifts the piece you aim at. */
  function pick(): boolean {
    if (!aimed || held) return false;
    const f = furniture()[aimed];
    held = { id: aimed, r: f && !('removed' in f) ? f.r : 0, spot: null };
    aimed = null;
    outline.visible = false;
    ctx.hint.invalidate();
    return true;
  }

  /** From the catalogue: a piece that was taken out, or a bean bag, to put down. */
  function bringBack(id: string) {
    cancel();
    held = { id, r: 0, spot: null };
    ctx.hint.invalidate();
  }

  /** Esc, or something else took over: what's in your hands goes back where the floor has it. */
  function cancel() {
    if (!held) return;
    const id = held.id;
    held = null;
    untint();
    arrange().release(id);
    ctx.hint.invalidate();
  }

  /** A click: puts it down there (the office keeps it, and everyone on the floor sees it). */
  function putDown(): boolean {
    if (!held) return false;
    if (!held.spot) return true;
    if (!verdict.ok) {
      toast(verdict.why, 'warn');
      return true;
    }
    const { id, spot } = held;
    held = null;
    untint();
    arrange().settle(id, poseAt(movable(id), spot));
    ctx.net.send({ t: 'furniture.move', id, x: spot.x, z: spot.z, r: spot.r });
    // Not heard back (the office said no): put it where the floor has it.
    if (pending) clearTimeout(pending.timer);
    pending = { id, furniture: furniture(), timer: setTimeout(() => (pending?.furniture === furniture() && arrange().release(id), (pending = null)), 2000) };
    ctx.hint.invalidate();
    return true;
  }

  // Whatever the office answered, the piece is where the floor has it now (a refused move leaves it as it was).
  store.on('floorPlan', () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    arrange().release(pending.id);
    pending = null;
  });

  function remove(): boolean {
    if (!aimed) return false;
    ctx.net.send({ t: 'furniture.remove', id: aimed });
    aimed = null;
    outline.visible = false;
    return true;
  }

  function putBack(): boolean {
    if (!aimed) return false;
    if (movable(aimed).added) toast('A bean bag has nowhere it comes: X takes it out', 'info');
    else if (!furniture()[aimed]) toast(`${sentence(nameOf(movable(aimed)))} is where it comes already`, 'info');
    else ctx.net.send({ t: 'furniture.reset', id: aimed });
    return true;
  }

  /** Keys while you build: R turns what you carry, E lifts and X takes out what you aim at, H puts it back where it comes. */
  function onKey(code: string, pieceBusy: boolean): boolean {
    if (held) {
      if (code === 'KeyR') {
        if (movable(held.id).turns) held.r = (held.r + 1) % 4;
        return true;
      }
      // Holding it, E and X do nothing rather than reach the desk or door behind it.
      return code === 'KeyE' || code === 'KeyX' || code === 'Delete' || code === 'Backspace' || code === 'KeyH';
    }
    if (pieceBusy || !aimed) return false;
    if (code === 'KeyE') return pick();
    if (code === 'KeyX' || code === 'Delete' || code === 'Backspace') return remove();
    if (code === 'KeyH') return putBack();
    return false;
  }

  /** What the hint bar shows, or null when it's not about the floor's furniture. */
  function hint(): { title: string; parts: HTMLElement[]; key: string } | null {
    if (held) {
      const m = movable(held.id);
      const title = !held.spot ? `🛠️ Aim at the floor (${nameOf(m)})` : !verdict.ok ? `🚫 ${verdict.why}` : `🛠️ Moving ${nameOf(m)}`;
      return { key: `fx|h|${held.id}|${held.r}|${verdict.ok ? 'ok' : verdict.why}`, title, parts: [hintTitle(title), key('Click', 'Place'), ...(m.turns ? [key('R', 'Turn')] : []), key('Esc', 'Put back')] };
    }
    if (!aimed) return null;
    const m = movable(aimed);
    // A bean bag has nowhere it comes to put it back to: X takes it out.
    const moved = !!furniture()[aimed] && !m.added;
    const title = `🏢 ${sentence(nameOf(m))}`;
    return { key: `fx|a|${aimed}|${moved}`, title, parts: [hintTitle(title), aside('shared with everyone on the floor'), key('E', 'Move'), key('X', 'Remove'), ...(moved ? [key('H', 'Put back')] : [])] };
  }

  return {
    holding: () => !!held,
    aimed: () => aimed,
    aim,
    carry,
    onKey,
    putDown,
    cancel,
    bringBack,
    hint,
    /** Build mode ended: whatever was in your hands goes back. */
    exit() {
      cancel();
      aimed = null;
      outline.visible = false;
    },
    /** Hides the outline (a window is open). */
    hide() {
      outline.visible = false;
    },
  };
}
