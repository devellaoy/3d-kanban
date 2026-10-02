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

/** How far the pointer goes before a press on a row becomes a drag (a click under it). */
const DRAG_PX = 6;

export interface SortableOptions {
  onMove(move: FloorMove): void;
  /** Whether you may reorder right now (see canReorder). */
  enabled(): boolean;
  /** A drag ended, moved or not (a render held back for it can happen now). */
  onDragEnd?(): void;
}

/**
 * Drag and Alt+↑/↓ for the groups floorGroups made in `container`: a floor stays in its group, a
 * group's heading carries the whole group. A drag never rides to the floor it started on. The drop
 * line is placed inside `container`, which is positioned (relative, or fixed like the floor menu).
 */
export function makeSortable(container: HTMLElement, opts: SortableOptions): { dragging(): boolean } {
  container.classList.add('floor-sortable');
  let press: { x: number; y: number; id: number; el: HTMLElement; group: boolean } | null = null;
  let drag: { el: HTMLElement; group: boolean; line: HTMLElement; move: FloorMove | null } | null = null;

  /** The rows (or groups) it can land among, top-first, itself left out. */
  const slots = (el: HTMLElement, group: boolean): HTMLElement[] =>
    group
      ? [...container.querySelectorAll<HTMLElement>('.floor-group:not(.fixed)')].filter((g) => g !== el)
      : [...(el.closest('.floor-group')?.querySelectorAll<HTMLElement>('[data-floor]:not([data-fixed])') ?? [])].filter((r) => r !== el);
  const keyOf = (el: HTMLElement, group: boolean) => (group ? el.dataset.group! : el.dataset.floor!);

  const track = (y: number) => {
    if (!drag) return;
    const list = slots(drag.el, drag.group);
    // Top-first, it lands before the first one whose middle is under the pointer: just above that one, bottom-up.
    const k = list.findIndex((s) => {
      const r = s.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    const under = k < 0 ? null : list[k];
    const ref = under ?? list[list.length - 1];
    const box = container.getBoundingClientRect();
    if (ref) {
      const r = ref.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(ref.parentElement ?? container).rowGap) || 0;
      const edge = under ? r.top - gap / 2 : r.bottom + gap / 2;
      drag.line.style.top = `${edge - box.top - container.clientTop + container.scrollTop}px`;
    }
    drag.line.hidden = !ref;
    const above = under ? keyOf(under, drag.group) : null;
    const move = drag.group ? { group: keyOf(drag.el, true), above } : { floor: keyOf(drag.el, false), above };
    drag.move = applyMove(store.floors, move) ? move : null;
    drag.line.classList.toggle('same', !drag.move);
  };

  const end = (send: boolean) => {
    const was = drag;
    drag = null;
    press = null;
    if (!was) return;
    was.el.classList.remove('dragging');
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
      announce(`Moved ${label(was.el, was.group)}`);
    }
    opts.onDragEnd?.();
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || !opts.enabled()) return;
    const t = e.target as HTMLElement;
    if (t.closest('.floor-off')) return;
    const head = t.closest<HTMLElement>('.floor-group-head');
    const row = head ? null : t.closest<HTMLElement>('[data-floor]');
    const el = head ? head.closest<HTMLElement>('.floor-group:not(.fixed)') : row && !row.hasAttribute('data-fixed') ? row : null;
    if (!el || !container.contains(el)) return;
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, el, group: !!head };
  });
  container.addEventListener('pointermove', (e) => {
    if (drag) return track(e.clientY);
    if (!press || e.pointerId !== press.id || !(e.buttons & 1) || Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
    const line = h('div.drop-line', { 'aria-hidden': 'true' });
    container.append(line);
    drag = { el: press.el, group: press.group, line, move: null };
    press.el.classList.add('dragging');
    container.classList.add('sorting');
    container.setPointerCapture(e.pointerId);
    track(e.clientY);
  });
  container.addEventListener('pointerup', () => (drag ? end(true) : (press = null)));
  container.addEventListener('pointercancel', () => end(false));
  container.addEventListener('lostpointercapture', () => end(false));

  container.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !opts.enabled()) return;
    const t = e.target as HTMLElement;
    const head = t.closest<HTMLElement>('.floor-group-head');
    const row = head ? null : t.closest<HTMLElement>('[data-floor]');
    if ((!head && !row) || row?.hasAttribute('data-fixed')) return;
    e.preventDefault();
    e.stopPropagation();
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

  return { dragging: () => !!drag };
}

/** What a dragged row or group is called, for the announcement. */
function label(el: HTMLElement, group: boolean): string {
  if (group) return `the ${el.querySelector('.floor-group-head')?.textContent ?? ''} floors`;
  return store.floors.find((f) => f.id === el.dataset.floor)?.name ?? '';
}
