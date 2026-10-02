import './floorgroups.css';
import { floorStep, groupFloors, groupStep, moveFloorAbove, moveGroupAbove } from '../../shared/floororder';
import type { FloorInfo } from '../../shared/protocol';
import { visiting } from '../multiplayer/visit';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';

// The building's floors as the elevator and the floor list in the corner show them: grouped by the
// GitHub owner of their repository (the folders with none under "Local"), top group first and the top
// floor of each first, the way the buttons stack. Admins move a floor within its group, or a whole
// group, by dragging it or with Alt+↑/↓; the office keeps the order (floor.move) and everyone sees it.

/** A move as floor.move sends it: `floor` or `group` to just above `above` (bottom-up), null for the bottom. */
export interface FloorMove {
  floor?: string;
  group?: string;
  above: string | null;
}

/** Whether you can reorder the building: an admin of this office (not a visitor) with two floors to order. */
export function canReorder(): boolean {
  return !!store.me.admin && !visiting() && store.floors.filter((f) => !f.cloning).length >= 2;
}

/**
 * The floors in their groups, top group first and each group's top floor first. `row` makes a floor's
 * row (`i` is its place in store.floors, so its number); it gets data-floor, and a floor still being
 * cloned data-fixed (it can't be moved, nor anything moved around it).
 */
export function floorGroups(floors: FloorInfo[], row: (f: FloorInfo, i: number) => HTMLElement, opts: { reorder: boolean }): HTMLElement[] {
  return groupFloors(floors)
    .reverse()
    .map((g) => {
      const movable = opts.reorder && g.floors.some((f) => !f.cloning);
      const head = h('div.floor-group-head', { 'data-group': g.key, tabindex: movable ? 0 : undefined, title: movable ? `Drag, or Alt+↑/↓, to move the ${g.label} floors` : undefined, 'aria-keyshortcuts': movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined }, g.label);
      const rows = [...g.floors].reverse().map((f) => {
        const el = row(f, floors.indexOf(f));
        el.dataset.floor = f.id;
        if (f.cloning) el.dataset.fixed = '';
        else if (opts.reorder) el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
        return el;
      });
      return h('div.floor-group', { role: 'group', 'aria-label': g.label, 'data-group': g.key, class: `${opts.reorder ? 'reorder' : ''} ${movable ? '' : 'fixed'}` }, head, ...rows);
    });
}

/** The floors after `move`, or undefined when it changes nothing (or can't be). Floors being cloned stay at the end. */
export function applyMove(floors: FloorInfo[], move: FloorMove): FloorInfo[] | undefined {
  const built = floors.filter((f) => !f.cloning);
  const next = move.floor !== undefined ? moveFloorAbove(built, move.floor, move.above) : move.group !== undefined ? moveGroupAbove(built, move.group, move.above) : undefined;
  if (!next || next.every((f, i) => f === built[i])) return undefined;
  return [...next, ...floors.filter((f) => f.cloning)];
}

/** Moves it here at once, then asks the office (whose `floors` comes back with the same order, or puts it right). */
export function sendMove(net: Net, move: FloorMove) {
  const next = applyMove(store.floors, move);
  if (!next) return;
  store.floors = next;
  store.emit('floors');
  net.send({ t: 'floor.move', ...move });
}

/** Renders `container` again and puts the keyboard focus back on the same floor or group, if it was in there. */
export function keepFocus(container: HTMLElement, render: () => void) {
  const active = document.activeElement;
  const was = active instanceof HTMLElement && container.contains(active) ? active : null;
  const at = was?.closest<HTMLElement>('[data-floor], .floor-group-head');
  const off = !!was?.closest('.floor-off');
  render();
  if (!at) return;
  const sel = at.dataset.floor !== undefined ? `[data-floor="${CSS.escape(at.dataset.floor)}"]` : `.floor-group-head[data-group="${CSS.escape(at.dataset.group ?? '')}"]`;
  const again = container.querySelector<HTMLElement>(sel);
  const target = again && (off ? again.querySelector<HTMLElement>('.floor-off') : again.matches('button, [tabindex]') ? again : again.querySelector<HTMLElement>('button'));
  target?.focus({ preventScroll: true });
}

let live: HTMLElement | null = null;
/** Says it to a screen reader. */
function announce(text: string) {
  if (!live) document.body.append((live = h('div.floor-live', { role: 'status', 'aria-live': 'polite' })));
  live.textContent = text;
}

/** How far the mouse goes before a press on a row becomes a drag (a click under it). */
const DRAG_PX = 6;
/** A finger picks a row up by holding still on it this long; moving sooner scrolls the list as always. */
const HOLD_MS = 350;
/** How far a finger may wander while it holds. */
const HOLD_PX = 8;

export interface SortableOptions {
  onMove(move: FloorMove): void;
  /** Whether you may reorder right now (see canReorder). */
  enabled(): boolean;
}

export interface Sortable {
  /** A row is pressed or being dragged. */
  dragging(): boolean;
  /** `paint` as the list's render: while a row is pressed or dragged it's held back, and done once after. */
  held(paint: () => void): () => void;
}

/**
 * Drag and Alt+↑/↓ for the groups floorGroups made in `container`: a floor stays in its group, a
 * group's heading carries the whole group. A mouse drags once it moves a few px; a finger holds a row
 * still for a moment first, so a swipe still scrolls the list. A drag never rides to the floor it
 * started on. The drop line is placed inside `container`, which is positioned (relative, or fixed
 * like the floor menu).
 *
 * The lists render again whenever the counts change. Their render goes through held(), which holds
 * it back from the press to the drop: a finger's touch events stay with the element it went down on,
 * and once that is gone nothing reaches the list to stop it scrolling. So the rows stay put while they
 * are dragged, and they're measured once, when the drag starts.
 */
export function makeSortable(container: HTMLElement, opts: SortableOptions): Sortable {
  container.classList.add('floor-sortable');
  let press: { x: number; y: number; id: number; key: string; group: boolean; touch: boolean; hold?: ReturnType<typeof setTimeout> } | null = null;
  /** `slots`: where it can land, top-first, as offsets in the list's content (so its scrolling doesn't matter); `at`: the one it's over. */
  let drag: { key: string; group: boolean; pointer: number; line: HTMLElement; slots: { key: string; top: number; bottom: number }[]; gap: number; at: number | undefined; move: FloorMove | null } | null = null;
  /** The render held back while a row was pressed or dragged. */
  let paint: (() => void) | null = null;
  let owed = false;
  /** Pressed and dragged no more: the render held back happens now. */
  const settle = () => {
    if (press || drag || !owed) return;
    owed = false;
    paint?.();
  };

  /** The row (or group) with that id (or key) as the list is now. */
  const find = (key: string, group: boolean) => container.querySelector<HTMLElement>(group ? `.floor-group[data-group="${CSS.escape(key)}"]` : `[data-floor="${CSS.escape(key)}"]`);
  /** The rows (or groups) it can land among, top-first, itself left out. */
  const slots = (el: HTMLElement, group: boolean): HTMLElement[] =>
    group
      ? [...container.querySelectorAll<HTMLElement>('.floor-group:not(.fixed)')].filter((g) => g !== el)
      : [...(el.closest('.floor-group')?.querySelectorAll<HTMLElement>('[data-floor]:not([data-fixed])') ?? [])].filter((r) => r !== el);
  const keyOf = (el: HTMLElement, group: boolean) => (group ? el.dataset.group! : el.dataset.floor!);

  /** A screen y as an offset in the list's content: the slots measured then stay right however it, or the page around it, scrolls. */
  const contentY = (y: number) => y - container.getBoundingClientRect().top - container.clientTop + container.scrollTop;

  const track = (y: number) => {
    if (!drag) return;
    const { slots: list, gap } = drag;
    // Top-first, it lands before the first one whose middle is under the pointer: just above that one, bottom-up.
    const c = contentY(y);
    const k = list.findIndex((s) => c < (s.top + s.bottom) / 2);
    if (k === drag.at) return;
    drag.at = k;
    const under = k < 0 ? null : list[k];
    const ref = under ?? list[list.length - 1];
    if (ref) drag.line.style.top = `${under ? ref.top - gap / 2 : ref.bottom + gap / 2}px`;
    drag.line.hidden = !ref;
    const above = under ? under.key : null;
    const move = drag.group ? { group: drag.key, above } : { floor: drag.key, above };
    drag.move = applyMove(store.floors, move) ? move : null;
    drag.line.classList.toggle('same', !drag.move);
  };

  /** The press becomes a drag (the mouse moved, or the finger held still long enough). */
  const begin = (pointerId: number, y: number) => {
    if (!press) return;
    const { key, group } = press;
    drop(false);
    const el = find(key, group);
    if (!el) return settle();
    // Measured once: the list doesn't render again until the drop.
    const box = container.getBoundingClientRect();
    const offset = container.scrollTop - box.top - container.clientTop;
    const measured = slots(el, group).map((s) => {
      const r = s.getBoundingClientRect();
      return { key: keyOf(s, group), top: r.top + offset, bottom: r.bottom + offset };
    });
    const gap = parseFloat(getComputedStyle(el.parentElement ?? container).rowGap) || 0;
    const line = h('div.drop-line', { 'aria-hidden': 'true' });
    container.append(line);
    drag = { key, group, pointer: pointerId, line, slots: measured, gap, at: undefined, move: null };
    el.classList.add('dragging');
    container.classList.add('sorting');
    try {
      container.setPointerCapture(pointerId);
    } catch {
      // The pointer's gone already (a finger lifted as the hold ran out): the drag ends with it.
    }
    track(y);
  };

  /** Lets go of a press that never became a drag; `later`: then renders what was held back, after the click it makes. */
  const drop = (later = true) => {
    if (!press) return;
    clearTimeout(press.hold);
    press = null;
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    if (later) setTimeout(settle, 0);
  };
  /** The button let go anywhere, even outside the list. */
  const release = () => {
    if (!drag) drop();
  };

  const end = (send: boolean) => {
    const was = drag;
    drag = null;
    if (!was) return drop();
    find(was.key, was.group)?.classList.remove('dragging');
    was.line.remove();
    container.classList.remove('sorting');
    // The click that ends a drag isn't a ride to the floor it was on.
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (send && was.move) {
      opts.onMove(was.move);
      announce(`Moved ${label(was.key, was.group)}`);
    }
    settle();
  };

  container.addEventListener('pointerdown', (e) => {
    drop(false);
    if (e.button !== 0 || !e.isPrimary || !opts.enabled()) return;
    const t = e.target as HTMLElement;
    if (t.closest('.floor-off')) return;
    const head = t.closest<HTMLElement>('.floor-group-head');
    const row = head ? null : t.closest<HTMLElement>('[data-floor]');
    const el = head ? head.closest<HTMLElement>('.floor-group:not(.fixed)') : row && !row.hasAttribute('data-fixed') ? row : null;
    if (!el || !container.contains(el)) return;
    const touch = e.pointerType !== 'mouse';
    const p = { x: e.clientX, y: e.clientY, id: e.pointerId, key: keyOf(el, !!head), group: !!head, touch } as NonNullable<typeof press>;
    if (touch) p.hold = setTimeout(() => press === p && begin(p.id, p.y), HOLD_MS);
    press = p;
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  });
  container.addEventListener('pointermove', (e) => {
    if (drag) return track(e.clientY);
    if (!press || e.pointerId !== press.id) return;
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    // A finger that moves before it has held is scrolling: leave it to the browser.
    if (press.touch) return void (far > HOLD_PX && drop());
    if (!(e.buttons & 1)) return drop();
    if (far >= DRAG_PX) begin(e.pointerId, e.clientY);
  });
  container.addEventListener('pointerup', (e) => drag?.pointer === e.pointerId && end(true));
  container.addEventListener('pointercancel', (e) => drag?.pointer === e.pointerId && end(false));
  // Only the list losing the drag's own pointer ends it: taking the capture over from the row the finger
  // went down on (its implicit capture) fires a lostpointercapture at that row, which bubbles up here.
  container.addEventListener('lostpointercapture', (e) => e.target === container && drag?.pointer === e.pointerId && end(false));
  // While a finger carries a row the list doesn't scroll under it, and a long press opens no menu.
  container.addEventListener('touchmove', (e) => drag && e.cancelable && e.preventDefault(), { passive: false });
  container.addEventListener('contextmenu', (e) => (press?.touch || drag) && e.preventDefault());

  container.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !opts.enabled()) return;
    const t = e.target as HTMLElement;
    const head = t.closest<HTMLElement>('.floor-group-head');
    const row = head ? null : t.closest<HTMLElement>('[data-floor]');
    if ((!head && !row) || row?.hasAttribute('data-fixed')) return;
    e.preventDefault();
    e.stopPropagation();
    // One step a press: holding the key down would send a move, and everyone a toast, per repeat.
    if (e.repeat) return;
    const dir = e.key === 'ArrowUp' ? 'up' : 'down';
    const built = store.floors.filter((f) => !f.cloning);
    const group = !!head;
    const key = group ? head!.dataset.group! : row!.dataset.floor!;
    const above = group ? groupStep(built, key, dir) : floorStep(built, key, dir);
    const what = group ? `the ${head!.textContent} floors` : (store.floors.find((f) => f.id === key)?.name ?? key);
    if (above === undefined) return announce(`${what} can't go further ${dir}`);
    opts.onMove(group ? { group: key, above } : { floor: key, above });
    announce(`Moved ${what} ${dir}`);
  });

  return {
    dragging: () => !!drag || !!press,
    held(fn) {
      paint = fn;
      return () => {
        if (press || drag) return void (owed = true);
        owed = false;
        fn();
      };
    },
  };
}

/** What a dragged row or group is called, for the announcement. */
function label(key: string, group: boolean): string {
  if (group) return `the ${groupFloors(store.floors).find((g) => g.key === key)?.label ?? key} floors`;
  return store.floors.find((f) => f.id === key)?.name ?? key;
}
