/**
 * The map: ` (the key left of 1, § on a Finnish keyboard) or ☰ → Map shows a top-down map of the whole
 * scenic loop over the view, with where everything is (fishing, the campfire, the race start line…)
 * and you on it; press it again or Esc (or ✕) to hide it. You can keep walking and driving with it up.
 * Driving with it hidden shows a small map in the corner that turns with the car. The terrain is
 * drawn once to an offscreen canvas; each frame only the arrow on top of it. Its numbers are
 * geometry.ts's, which reads them from the same constants the scenery is built from.
 */
import './map.css';
import type { Ctx } from '../../core/context';
import { $, h, toast } from '../../ui/dom';
import { neighbourBoxes } from '../../world/outside';
import { ELEVATOR_NOTE, ELEVATOR_NOTES, WORLD, clampToMap, markers, minimapAngle, offTheMap, onMap, project, rotateForHeading, walkingHeading, type Marker } from './geometry';
import { paintMarker, paintTerrain, paintYou } from './paint';

/** The picture's size (pixels): the map shows 660 x 505 m (WORLD in geometry.ts); the terrain reaches further, and past the edge the arrow sits at the rim. */
const W = 1000;
const H = 826;
/** The little map: its size on screen (css pixels), how many pixels it draws per css pixel, and how many meters its radius shows. */
const MINI = 190;
const MINI_DPR = 2;
const MINI_RADIUS_M = 110;

export function installMap(ctx: Ctx) {
  const p = project(WORLD, W, H);
  const places = markers();
  let shown = false;
  let terrain: HTMLCanvasElement | null = null;
  let labelled: HTMLCanvasElement | null = null;

  function offscreen(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  }
  /** Built the first time anyone looks: the ground alone (for the little map) and with every marker named (the big one). */
  function layers() {
    if (terrain && labelled) return { terrain, labelled };
    terrain = offscreen();
    paintTerrain(terrain.getContext('2d')!, p, W, H, neighbourBoxes());
    labelled = offscreen();
    const g = labelled.getContext('2d')!;
    g.drawImage(terrain, 0, 0);
    for (const m of places) paintMarker(g, p, m, true);
    return { terrain, labelled };
  }

  // ---- The big map --------------------------------------------------------------------------------
  const ground = h('canvas.map-ground', { width: W, height: H });
  const you = h('canvas.map-you', { width: W, height: H });
  const status = h('div.map-status');
  const legendOf = (list: Marker[]) => list.map((m) => h('li', {}, h('span.map-ico', {}, m.icon), m.label));
  const legend = h('ul.map-legend', {}, ...legendOf(places), ...ELEVATOR_NOTES.map((n) => h('li.map-lift', { title: ELEVATOR_NOTE }, h('span.map-ico', {}, n.icon), `${n.label} 🛗`)));
  const close = h('button.map-x', { type: 'button', 'aria-label': 'Hide the map', title: 'Hide the map (` or Esc)', onclick: () => setShown(false) }, '✕');
  const panel = h(
    'div.map-panel.panel.hidden',
    { role: 'region', 'aria-label': 'Map' },
    h('div.map-head', {}, h('b', {}, '🗺️ Map'), h('span.map-sub', {}, 'north is up · ` or Esc hides it'), close),
    h('div.map-stage', {}, ground, you),
    status,
    legend,
  );

  // ---- The little map, while you drive --------------------------------------------------------------
  const mini = h('canvas.map-mini.hidden', { width: MINI * MINI_DPR, height: MINI * MINI_DPR, 'aria-label': 'Map' });
  $('hud').append(panel, mini);

  /**
   * Where you are on the map and which way you face, or null (up on the roof). Past the map's edge (the
   * world reaches further than it is drawn) `off` says which way, and the big map's arrow sits at the edge.
   */
  function pose(): { x: number; z: number; heading: number; off: string } | null {
    if (!ctx.inOffice() || ctx.upTop()) return null;
    const pl = ctx.player;
    const off = onMap(pl.pos.x, pl.pos.z) ? '' : offTheMap(pl.pos.x, pl.pos.z);
    // In a car the car's nose is the way you face; on foot, the way the camera looks.
    return { x: pl.pos.x, z: pl.pos.z, heading: ctx.activities.running('driver') ? pl.facing : walkingHeading(pl.camYaw), off };
  }

  let youKey = '';
  function drawYou(at: ReturnType<typeof pose>, force = false) {
    const edge = at && clampToMap(at.x, at.z);
    const k = at && edge ? `${Math.round(p.x(edge.x))},${Math.round(p.y(edge.z))},${at.heading.toFixed(2)},${at.off}` : 'none';
    if (k === youKey && !force) return;
    youKey = k;
    const g = you.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    if (at && edge) paintYou(g, p.x(edge.x), p.y(edge.z), at.heading, 13);
    const text = !ctx.inOffice() ? 'No map here' : ctx.upTop() ? '🍸 You are up on the roof: the elevator is how you get back down' : at?.off ? `You are off the map, ${at.off}: the arrow is at its edge` : '';
    if (status.textContent !== text) status.textContent = text;
    status.classList.toggle('hidden', !text);
  }

  /** Each place's round chip, painted once (emoji text is the slow part) and then only copied. */
  const CHIP = 36;
  let chips: HTMLCanvasElement[] | null = null;
  function chipsOf(): HTMLCanvasElement[] {
    return (chips ??= places.map((m) => {
      const c = document.createElement('canvas');
      c.width = c.height = CHIP;
      paintMarker(c.getContext('2d')!, { scale: 1, x: () => CHIP / 2, y: () => CHIP / 2 }, { ...m, x: 0, z: 0 }, false, 22);
      return c;
    }));
  }

  let miniKey = '';
  function drawMini(at: NonNullable<ReturnType<typeof pose>>) {
    // Nothing moved by more than a pixel or so since the last drawing: it would look the same.
    const key = `${Math.round(at.x * 4)},${Math.round(at.z * 4)},${at.heading.toFixed(2)}`;
    if (key === miniKey) return;
    miniKey = key;
    const g = mini.getContext('2d')!;
    const size = MINI * MINI_DPR;
    // Meters to pixels here, against the terrain picture's own.
    const zoom = (size / 2 / MINI_RADIUS_M) / p.scale;
    g.clearRect(0, 0, size, size);
    g.save();
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#6ecbe9';
    g.fillRect(0, 0, size, size);
    g.translate(size / 2, size / 2);
    g.rotate(minimapAngle(at.heading));
    g.scale(zoom, zoom);
    g.drawImage(layers().terrain, -p.x(at.x), -p.y(at.z));
    g.restore();
    // The places, upright, where the turned map puts them.
    const sprites = chipsOf();
    places.forEach((m, i) => {
      const d = rotateForHeading((p.x(m.x) - p.x(at.x)) * zoom, (p.y(m.z) - p.y(at.z)) * zoom, at.heading);
      if (Math.hypot(d.x, d.y) > size / 2 - 14) return;
      g.drawImage(sprites[i], size / 2 + d.x - CHIP / 2, size / 2 + d.y - CHIP / 2);
    });
    // You, always in the middle, nose up.
    paintYou(g, size / 2, size / 2, Math.PI, 15);
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    g.lineWidth = 4;
    g.strokeStyle = '#2a2a3c';
    g.stroke();
  }

  function setShown(on: boolean) {
    if (on && !ctx.inOffice()) return void toast('🗺️ No map here: it is of the office and its scenic loop', 'warn');
    const was = shown;
    shown = on;
    // Hidden by ✕ or Esc with the cursor free: straight back into mouse-look, as when a window closes.
    if (was && !on && ctx.inOffice() && !ctx.player.locked && ctx.player.canLock) ctx.player.lock(true);
    if (on) {
      ground.getContext('2d')!.drawImage(layers().labelled, 0, 0);
      drawYou(pose(), true);
    }
    panel.classList.toggle('hidden', !on);
    if (on) mini.classList.add('hidden');
    ctx.hint.invalidate();
  }

  ctx.keys.bind({ code: 'Backquote', preventDefault: true, repeat: false, run: () => setShown(!shown) });
  // Esc hides it (the key doesn't reach us while the mouse is captured: the browser takes that one). With the cursor free, hiding it goes back to mouse-look (see setShown).
  ctx.keys.add('guard', (e) => {
    if (!shown || e.code !== 'Escape') return false;
    setShown(false);
    // Esc closed the map: that's all it does this time.
    return true;
  });

  ctx.ticks.add('hud', () => {
    const driving = ctx.activities.running('driver');
    const at = pose();
    if (shown) {
      if (!ctx.inOffice()) setShown(false);
      else drawYou(at);
      return;
    }
    const wantMini = driving && !!at;
    if (mini.classList.contains('hidden') === wantMini) mini.classList.toggle('hidden', !wantMini);
    if (wantMini && at) drawMini(at);
    else miniKey = '';
  });

  return { toggle: () => setShown(!shown), visible: () => shown };
}
