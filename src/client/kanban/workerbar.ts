// The kanban page's bottom bar: a tab for each meeting room with workers at its table (it opens the
// meeting room window), then the floor's plain workers (hired outside the kanban, shells included)
// as tabs that open the worker's terminal (each with a close button that sends the worker home, asking
// first as X does in the 3D office), and the buttons that call a meeting or put a new worker or shell
// on the floor. Which rooms and workers, their order, a tab's name and tooltip and the bar's state are
// workerbarmodel.ts; this is the DOM.
//
// The office sends a worker update on every status and activity change, and a meeting's state every
// few seconds while one is on, so the tabs are kept by id and only what changed is written: a click
// between mousedown and mouseup is never lost to a redraw, and the strip keeps its scroll position
// and its focus.
import './workerbar.css';
import { shownStatus } from '../../shared/status';
import type { WorkerInfo } from '../../shared/protocol';
import { store } from '../state';
import { h, modalOpen, STATUS_LABEL } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { barRooms, barState, barWorkers, tabName, tabTitle, type BarRoom } from './workerbarmodel';

export interface WorkerBarDeps {
  root: HTMLElement;
  /** The worker's terminal window, as the 3D office opens it. */
  openWorker(id: string): void;
  /** The send-home dialog, as X opens it in the 3D office. */
  sendHome(id: string): void;
  /** The meeting room window on that room, as the 3D office opens it at the room's door. */
  openRoom(roomId: string): void;
  /** The call-a-meeting form in the first free room (the running meeting when every room has one). */
  newMeeting(): void;
  /** The plain hire dialog; the floor's name goes in its title. */
  hireNew(floorName?: string): void;
  /** Sends a shell to the next free desk; the desk's id, or undefined when nothing was sent. */
  openShell(): string | undefined;
  /** The project picked on the board; null is "All projects". */
  boardProject(): string | null;
  projectName(id: string): string | undefined;
  goToFloor(id: string): void;
}

/** How long New shell waits for its shell to show up before giving up on opening it. */
const SHELL_WAIT_MS = 10_000;

interface Tab {
  el: HTMLElement;
  open: HTMLButtonElement;
  close: HTMLButtonElement;
  dot: HTMLElement;
  name: HTMLElement;
  pill: HTMLElement;
}

/** A meeting room's tab: one button, with nothing to close (the room is cleared in its window). */
interface RoomTab {
  el: HTMLElement;
  open: HTMLButtonElement;
  name: HTMLElement;
  count: HTMLElement;
  pill: HTMLElement;
}

/** A room tab's pill: what it says and the status pill it borrows its colour from, as the meeting room window's own (here it never pulses). */
const ROOM_PILL: Record<BarRoom['status'], [label: string, cls: string]> = {
  running: ['in a meeting', 'working'],
  done: ['done', 'done'],
  stopped: ['stopped', 'needs_input'],
};

const setText = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text;
};
const setAttr = (el: HTMLElement, name: string, value: string) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const setClass = (el: HTMLElement, cls: string) => {
  if (el.className !== cls) el.className = cls;
};

export function installWorkerBar(deps: WorkerBarDeps): { refresh(): void } {
  const tabs = new Map<string, Tab>();
  const roomTabs = new Map<string, RoomTab>();
  // Buttons that each open a window, not a tablist: nothing here stays selected.
  const strip = h('div.kb-wtabs', { role: 'group', 'aria-label': 'Workers and meeting rooms on this floor' });
  const note = h('span.kb-wbar-note');
  const backName = h('span');
  const back = h('button.btn.secondary.md.kb-wbar-back', { type: 'button', onclick: () => {
    const p = deps.boardProject();
    if (p) deps.goToFloor(p);
  } }, icon('corner-up-left'), backName);
  const meetBtn = h('button.btn.secondary.md', { type: 'button', id: 'kb-wbar-meeting', 'aria-label': 'New meeting', onclick: () => deps.newMeeting() }, icon('users'), h('span.kb-lbl', {}, 'New meeting'));
  const newBtn = h('button.btn.secondary.md', { type: 'button', id: 'kb-wbar-new', title: 'Hire a worker on this floor, outside the kanban', 'aria-label': 'New worker', onclick: () => deps.hireNew(floorName()) }, icon('plus'), h('span.kb-lbl', {}, 'New worker'));
  const shellBtn = h('button.btn.secondary.md', { type: 'button', id: 'kb-wbar-shell', title: 'Open a shell at the next free desk', 'aria-label': 'New shell', onclick: newShell }, icon('square-terminal'), h('span.kb-lbl', {}, 'New shell'));
  const actions = h('div.kb-wbar-actions', {}, meetBtn, newBtn, shellBtn);
  deps.root.replaceChildren(strip, note, back, actions);

  /** A floor's name: the board's for it, or the building's before the board has loaded. */
  const nameOf = (id: string) => deps.projectName(id) ?? store.floors.find((f) => f.id === id)?.name;
  /** The name of the floor the page is on. */
  const floorName = () => (store.floor ? nameOf(store.floor) : undefined) ?? store.project?.name;

  function makeTab(id: string): Tab {
    const dot = h('span.dot');
    const name = h('span.kb-wtab-name');
    const pill = h('span.pill');
    const open = h('button.kb-wtab-open', { type: 'button', onclick: () => deps.openWorker(id) }, dot, name, pill) as HTMLButtonElement;
    // Its name and tooltip are set in paintTab ("Send <name> home").
    const close = iconButton('x', 'Send home', { class: 'xs kb-wtab-close', onclick: () => deps.sendHome(id) }, 14);
    // Two buttons side by side in one tab: a button can't hold another.
    const el = h('div.kb-wtab', { 'data-id': id }, open, close);
    return { el, open, close, dot, name, pill };
  }

  function paintTab(t: Tab, w: WorkerInfo) {
    // A lost worktree outranks the status: opening the tab is how it's fixed.
    const shown = w.lost ? 'lost' : shownStatus(w);
    const label = w.lost ? 'worktree deleted' : (STATUS_LABEL[shown] ?? shown);
    setClass(t.el, `kb-wtab ${shown}`);
    setAttr(t.open, 'title', tabTitle(w));
    setAttr(t.open, 'aria-label', `${tabTitle(w)}, ${label}: open its terminal`);
    setAttr(t.close, 'title', `Send ${w.name} home`);
    setAttr(t.close, 'aria-label', `Send ${w.name} home`);
    // A visitor in someone else's office may not send a worker home (shared/multiplayer/allow.ts).
    t.close.classList.toggle('hidden', !!store.me.visitor);
    setAttr(t.dot, 'style', `background:${w.color}`);
    setText(t.name, tabName(w));
    setClass(t.pill, `pill ${shown}`);
    setText(t.pill, label);
  }

  function makeRoomTab(id: string): RoomTab {
    const name = h('span.kb-wtab-name');
    const count = h('span.kb-wtab-count');
    const pill = h('span.pill');
    const open = h('button.kb-wtab-open', { type: 'button', onclick: () => deps.openRoom(id) }, name, icon('users', { size: 14, cls: 'kb-wtab-people' }), count, pill) as HTMLButtonElement;
    // data-room, not data-id: a room and a worker may share an id.
    const el = h('div.kb-wtab.kb-wtab-room', { 'data-room': id }, open);
    return { el, open, name, count, pill };
  }

  function paintRoomTab(t: RoomTab, r: BarRoom) {
    const n = r.workers.length;
    const [label, cls] = ROOM_PILL[r.status];
    const title = `${r.label} · ${r.title} · ${n} ${n === 1 ? 'worker' : 'workers'}${r.needsInput ? ' · needs you' : ''}`;
    // Tinted like a worker's tab while one at the table waits on you.
    setClass(t.el, `kb-wtab kb-wtab-room${r.needsInput ? ' needs_input' : ''}`);
    setAttr(t.open, 'title', `${title}: open the meeting room`);
    setAttr(t.open, 'aria-label', `${title}, ${label}: open the meeting room`);
    setText(t.name, r.label);
    setText(t.count, String(n));
    setClass(t.pill, `pill ${cls}`);
    setText(t.pill, label);
  }

  /**
   * One kind of tab in the strip from `at` on, in the list's order: the gone ones are taken out and an
   * element is moved (or added) only where the strip differs from the list. Returns where the next kind starts.
   */
  function place<T extends { el: HTMLElement }, I extends { id: string }>(kept: Map<string, T>, items: I[], make: (id: string) => T, paint: (t: T, item: I) => void, at: Element | null): Element | null {
    const ids = new Set(items.map((i) => i.id));
    for (const [id, t] of kept) {
      if (ids.has(id)) continue;
      if (t.el === at) at = at.nextElementSibling;
      t.el.remove();
      kept.delete(id);
    }
    for (const item of items) {
      let t = kept.get(item.id);
      if (!t) kept.set(item.id, (t = make(item.id)));
      paint(t, item);
      if (t.el === at) at = at.nextElementSibling;
      else strip.insertBefore(t.el, at);
    }
    return at;
  }

  /** The rooms first, then the workers: each kind keeps its own tabs, so a room's id never meets a worker's. */
  function paintTabs(rooms: BarRoom[], workers: WorkerInfo[]) {
    place(tabs, workers, makeTab, paintTab, place(roomTabs, rooms, makeRoomTab, paintRoomTab, strip.firstElementChild));
  }

  function refresh() {
    const boardProject = deps.boardProject();
    const state = barState(boardProject, store.floor, !!store.project);
    const rooms = state === 'tabs' ? barRooms(store.meeting, store.workers) : [];
    // A meeting's workers are behind their room's tab, not in the row one by one.
    const covered = new Set(rooms.flatMap((r) => r.workers));
    const workers = state === 'tabs' ? barWorkers(store.workers.values(), covered) : [];
    paintTabs(rooms, workers);
    const empty = !workers.length && !rooms.length;
    setAttr(deps.root, 'data-state', state);
    strip.classList.toggle('hidden', empty);
    // A closed project has no floor to go to (the board still lists it).
    const closed = state === 'elsewhere' && !store.floors.some((f) => f.id === boardProject);
    setText(note, state === 'none' ? 'No floor' : closed ? 'The picked project’s floor is closed' : state === 'tabs' && empty ? 'No workers on this floor' : '');
    note.classList.toggle('hidden', !note.textContent);
    if (state === 'elsewhere' && boardProject) setText(backName, `${nameOf(boardProject) ?? boardProject}’s floor`);
    back.classList.toggle('hidden', state !== 'elsewhere' || closed);
    newBtn.disabled = shellBtn.disabled = state !== 'tabs';
    // A floor without a meeting room has nowhere to hold one.
    meetBtn.disabled = state !== 'tabs' || !store.meeting.rooms.length;
    const floor = floorName();
    setAttr(meetBtn, 'title', floor ? `Call a meeting on ${floor}’s floor` : 'Call a meeting on this floor');
    // A visitor in someone else's office may not put a worker on its floor (shared/multiplayer/allow.ts).
    actions.classList.toggle('hidden', !!store.me.visitor);
  }

  /** A shell at the next free desk, and its terminal once the office has it there. */
  function newShell() {
    const floor = store.floor;
    const desk = deps.openShell();
    if (!desk) return;
    const stop = () => {
      off();
      clearTimeout(timer);
    };
    const timer = setTimeout(stop, SHELL_WAIT_MS);
    const off = store.on('workers', () => {
      if (store.floor !== floor) return stop(); // that desk is another floor's now
      const w = store.workerAtDesk(desk);
      if (!w || w.kind !== 'shell') return;
      stop();
      // Opening a terminal closes the window that's open: not over one the user opened meanwhile.
      if (!modalOpen()) deps.openWorker(w.id);
    });
  }

  store.on('workers', refresh);
  store.on('meeting', refresh);
  store.on('floor', refresh);
  store.on('floors', refresh);
  store.on('project', refresh);
  store.on('me', refresh);
  refresh();
  return { refresh };
}
