// The phone in your hand (Y, or ☰ → 📲 Phone): every floor of the building with how many work there and
// how many wait on someone, then a floor's processes (its workers, the waiting ones first, as on the 2D
// view), and a tap on one opens its window over the phone, which is still there when that closes. Another
// floor's workers come over phone.watch (phone/watch.ts), so nobody has to walk there.
//
// One tab, Floors, for now; the tab bar at the bottom is where the next one goes (TABS).
import './phone.css';
import { floorPalette } from '../../shared/floors';
import type { FloorInfo, ProjectInfo, WorkerInfo } from '../../shared/protocol';
import { ROOF } from '../../shared/rooftop';
import { byUrgency, waitingInOrder, waitingLabel } from '../nextup';
import { store } from '../state';
import { h, openModal, toast, type Modal } from '../ui/dom';
import { workerCard } from '../shared/workercard';
import { refocusIndex } from './refocus';
import type { PhoneWatch } from './watch';

export interface PhoneDeps {
  watch: PhoneWatch;
  /** The worker's window (its terminal), on whichever floor it is. */
  openWorker(id: string): void;
  /** ✍️ on a worker's card. */
  promptWorker(id: string): void;
}

/** The phone's apps, along its bottom edge. A new one (music…) is a row here and a view of its own. */
const TABS = [{ id: 'floors', icon: '🏢', label: 'Floors' }] as const;

type View = { kind: 'floors' } | { kind: 'processes'; floor: string };

export interface OpenPhone {
  modal: Modal;
  /** Moves the keyboard focus up or down the phone's list. */
  step(dir: 1 | -1): void;
  /** ‹ Back, if there is somewhere to go back to. Says whether it went. */
  back(): boolean;
}

/** The floors you can see on the phone: built ones, not the roof. */
function phoneFloors(): FloorInfo[] {
  return store.floors.filter((f) => !f.cloning && f.id !== ROOF);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "14:05", the phone's clock. */
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function openPhone(deps: PhoneDeps, onClosed: () => void): OpenPhone {
  let view: View = { kind: 'floors' };

  const time = h('span.phone-time', {}, clock());
  const status = h('div.phone-status', { 'aria-hidden': 'true' }, time, h('span.phone-notch'), h('span.phone-signal', {}, '📶 🔋'));
  const backBtn = h('button.btn.phone-back', { type: 'button', title: 'Back to the floors (←)', 'aria-label': 'Back to the floors', onclick: () => go({ kind: 'floors' }) }, '‹');
  const title = h('h2', {}, 'Floors');
  const header = h('header', {}, backBtn, title);
  const sub = h('div.phone-sub');
  const body = h('div.phone-body');
  const tabs = h(
    'nav.phone-tabs',
    { 'aria-label': 'Phone apps' },
    ...TABS.map((t) => h('button.phone-tab', { type: 'button', class: 'on', 'aria-current': 'page', onclick: () => go({ kind: 'floors' }) }, h('span.phone-tab-icon', {}, t.icon), h('span', {}, t.label))),
  );
  const el = h('div.modal.phone', { role: 'dialog', 'aria-label': 'Phone' }, status, header, sub, body, tabs);

  // ---- The floors ---------------------------------------------------------------------------------
  function floorRow(f: FloorInfo, no: number): HTMLElement {
    const here = f.id === store.floor;
    const p = floorPalette(f.palette);
    const btn = h(
      'button.phone-floor',
      { type: 'button', class: here ? 'here' : '', 'data-key': `floor:${f.id}`, 'aria-label': `${f.name}: ${plural(f.workers, 'worker')}, ${f.waiting} waiting${here ? ", you're here" : ''}`, onclick: () => go({ kind: 'processes', floor: f.id }) },
      h('span.phone-floor-no', { style: `background:${p.trim}` }, String(no)),
      h(
        'span.phone-floor-text',
        {},
        h('span.phone-floor-name', {}, f.name),
        h('span.phone-floor-sub', {}, here ? "📍 You're here" : (f.repo ?? f.dir)),
        h('span.phone-floor-stats', {}, h('span', { title: 'Workers' }, `👥 ${f.workers}`), h('span.phone-wait', { class: f.waiting ? 'on' : '', title: 'Waiting on someone' }, `🙋 ${f.waiting}`)),
      ),
      h('span.phone-chevron', { 'aria-hidden': 'true' }, '›'),
    );
    return h('li', {}, btn);
  }

  function renderFloors() {
    const floors = phoneFloors();
    title.textContent = 'Floors';
    backBtn.hidden = true;
    const waiting = floors.reduce((n, f) => n + f.waiting, 0);
    sub.textContent = `${plural(floors.length, 'floor')} · ${waiting ? `🙋 ${waiting} waiting` : 'nobody waiting'}`;
    // Top floor first, the way a building's directory reads.
    const rows = floors.map((f, i) => floorRow(f, i + 1)).reverse();
    body.replaceChildren(rows.length ? h('ul.phone-list', {}, ...rows) : h('p.phone-empty', {}, 'No floors yet. 🛗 The elevator adds a project.'));
  }

  // ---- A floor's processes --------------------------------------------------------------------------
  /** The workers on `floor`, with its project, or null while another floor's are still on the way. */
  function workersOf(floor: string): { workers: Iterable<WorkerInfo>; project: ProjectInfo | null } | null {
    if (floor === store.floor) return { workers: store.workers.values(), project: store.project };
    const pf = store.phoneFloor;
    return pf?.floor === floor ? { workers: pf.workers.values(), project: pf.project } : null;
  }

  /** A worker's card, its button known by the worker (see refocus.ts). */
  function card(w: WorkerInfo, project: ProjectInfo | null): HTMLElement {
    const li = workerCard(w, { onOpen: deps.openWorker, onPrompt: deps.promptWorker, project });
    const btn = li.querySelector<HTMLElement>('.lite-card');
    if (btn) btn.dataset.key = `worker:${w.id}`;
    return li;
  }

  function renderProcesses(floor: string) {
    const f = phoneFloors().find((x) => x.id === floor);
    title.textContent = f?.name ?? 'Floor';
    backBtn.hidden = false;
    const got = workersOf(floor);
    if (!got) {
      sub.textContent = floor === store.floor ? '' : `📞 Calling ${f?.name ?? 'the floor'}…`;
      body.replaceChildren(h('div.phone-loading', {}, h('span.spinner'), h('span', {}, 'Getting its workers…')));
      return;
    }
    const list = byUrgency(got.workers);
    const label = waitingLabel(waitingInOrder(list));
    sub.textContent = [floor === store.floor ? "📍 You're here" : '', plural(list.length, 'worker'), label].filter(Boolean).join(' · ');
    body.replaceChildren(
      list.length
        ? h('ul.phone-list.phone-workers', {}, ...list.map((w) => card(w, got.project)))
        : h('p.phone-empty', {}, 'Nobody is working on this floor. ✨'),
    );
  }

  // ---- What's on the screen -----------------------------------------------------------------------
  function render() {
    // Re-rendering keeps your place in the list and which row has the focus.
    const scroll = body.scrollTop;
    const active = body.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const at = active ? [...focusables()].indexOf(active) : -1;
    if (view.kind === 'floors') renderFloors();
    else renderProcesses(view.floor);
    body.scrollTop = scroll;
    if (!active) return;
    const rows = [...focusables()];
    rows[refocusIndex(active.dataset.key, at, rows.map((r) => r.dataset.key ?? ''))]?.focus({ preventScroll: true });
  }

  // Events come in bursts (and a busy floor's every few seconds), and a rebuild under a finger loses the tap:
  // one render per frame, and not while a pointer is down in the list (it waits for the pointer to lift).
  let frame = 0;
  let pressed = false;
  let stale = false;
  const schedule = () => {
    if (pressed) stale = true;
    else if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }
  };
  const press = () => (pressed = true);
  const lift = () => {
    if (!pressed) return;
    pressed = false;
    if (stale) {
      stale = false;
      schedule();
    }
  };
  body.addEventListener('pointerdown', press);
  document.addEventListener('pointerup', lift);
  document.addEventListener('pointercancel', lift);

  /** The list shown is of this floor's workers: `workers` when it's your own, else what phone.watch brings. */
  const shows = (own: boolean) => view.kind === 'processes' && (view.floor === store.floor) === own;

  function go(next: View) {
    view = next;
    deps.watch.list(view.kind === 'processes' ? view.floor : null);
    body.scrollTop = 0;
    render();
  }

  const focusables = () => body.querySelectorAll<HTMLElement>('.phone-floor, .lite-card');

  const offs = [
    store.on('floors', () => {
      // The floor you were looking at is gone (removed, or its checkout went).
      if (view.kind === 'processes' && !phoneFloors().some((f) => f.id === (view as { floor: string }).floor)) {
        toast('📲 That floor is gone', 'warn');
        return go({ kind: 'floors' });
      }
      schedule();
    }),
    store.on('floor', schedule),
    store.on('workers', () => shows(true) && schedule()),
    store.on('project', () => view.kind === 'processes' && schedule()),
    store.on('phoneWorkers', () => shows(false) && schedule()),
  ];
  // The clock, and "3m ago" on the cards, move on by themselves.
  const ticker = setInterval(() => {
    time.textContent = clock();
    if (view.kind === 'processes') schedule();
  }, 30_000);

  const modal = openModal(el, {
    doing: '📲 on the phone',
    onClose: () => {
      offs.forEach((off) => off());
      clearInterval(ticker);
      cancelAnimationFrame(frame);
      body.removeEventListener('pointerdown', press);
      document.removeEventListener('pointerup', lift);
      document.removeEventListener('pointercancel', lift);
      deps.watch.list(null);
      onClosed();
    },
  });
  go({ kind: 'floors' });

  return {
    modal,
    step(dir) {
      const all = [...focusables()];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = all[i < 0 ? (dir > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, i + dir))];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    },
    back() {
      if (view.kind === 'floors') return false;
      go({ kind: 'floors' });
      return true;
    },
  };
}
