// The kanban page's bottom bar: the floor's plain workers (hired outside the kanban, shells included)
// as tabs that open the worker's terminal (each with a close button that sends the worker home, asking
// first as X does in the 3D office), and the two buttons that put a new one on the floor. Which workers, their
// order, a tab's name and tooltip and the bar's state are workerbarmodel.ts; this is the DOM.
//
// The office sends a worker update on every status and activity change, so the tabs are kept by id
// and only what changed is written: a click between mousedown and mouseup is never lost to a redraw,
// and the strip keeps its scroll position and its focus.
import './workerbar.css';
import { shownStatus } from '../../shared/status';
import type { WorkerInfo } from '../../shared/protocol';
import { store } from '../state';
import { h, modalOpen, STATUS_LABEL } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { barState, barWorkers, tabName, tabTitle } from './workerbarmodel';

export interface WorkerBarDeps {
  root: HTMLElement;
  /** The worker's terminal window, as the 3D office opens it. */
  openWorker(id: string): void;
  /** The send-home dialog, as X opens it in the 3D office. */
  sendHome(id: string): void;
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
  // Buttons that each open a window, not a tablist: nothing here stays selected.
  const strip = h('div.kb-wtabs', { role: 'group', 'aria-label': 'Workers on this floor' });
  const note = h('span.kb-wbar-note');
  const backName = h('span');
  const back = h('button.btn.secondary.md.kb-wbar-back', { type: 'button', onclick: () => {
    const p = deps.boardProject();
    if (p) deps.goToFloor(p);
  } }, icon('corner-up-left'), backName);
  const newBtn = h('button.btn.secondary.md', { type: 'button', id: 'kb-wbar-new', title: 'Hire a worker on this floor, outside the kanban', 'aria-label': 'New worker', onclick: () => deps.hireNew(floorName()) }, icon('plus'), h('span.kb-lbl', {}, 'New worker'));
  const shellBtn = h('button.btn.secondary.md', { type: 'button', id: 'kb-wbar-shell', title: 'Open a shell at the next free desk', 'aria-label': 'New shell', onclick: newShell }, icon('square-terminal'), h('span.kb-lbl', {}, 'New shell'));
  const actions = h('div.kb-wbar-actions', {}, newBtn, shellBtn);
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

  function paintTabs(workers: WorkerInfo[]) {
    const ids = new Set(workers.map((w) => w.id));
    for (const [id, t] of tabs) {
      if (ids.has(id)) continue;
      t.el.remove();
      tabs.delete(id);
    }
    // In order, moving (or adding) an element only where the strip differs from the list.
    let at = strip.firstElementChild;
    for (const w of workers) {
      let t = tabs.get(w.id);
      if (!t) tabs.set(w.id, (t = makeTab(w.id)));
      paintTab(t, w);
      if (t.el === at) at = at.nextElementSibling;
      else strip.insertBefore(t.el, at);
    }
  }

  function refresh() {
    const boardProject = deps.boardProject();
    const state = barState(boardProject, store.floor, !!store.project);
    const workers = state === 'tabs' ? barWorkers(store.workers.values()) : [];
    paintTabs(workers);
    setAttr(deps.root, 'data-state', state);
    strip.classList.toggle('hidden', !workers.length);
    // A closed project has no floor to go to (the board still lists it).
    const closed = state === 'elsewhere' && !store.floors.some((f) => f.id === boardProject);
    setText(note, state === 'none' ? 'No floor' : closed ? 'The picked project’s floor is closed' : state === 'tabs' && !workers.length ? 'No workers on this floor' : '');
    note.classList.toggle('hidden', !note.textContent);
    if (state === 'elsewhere' && boardProject) setText(backName, `${nameOf(boardProject) ?? boardProject}’s floor`);
    back.classList.toggle('hidden', state !== 'elsewhere' || closed);
    newBtn.disabled = shellBtn.disabled = state !== 'tabs';
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
  store.on('floor', refresh);
  store.on('floors', refresh);
  store.on('project', refresh);
  store.on('me', refresh);
  refresh();
  return { refresh };
}
