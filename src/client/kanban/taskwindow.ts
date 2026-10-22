// A task on the kanban page, in a window rather than a panel: the same modal the 3D office shows for a
// task worker (its terminal window with the 🖥️ Terminal and 🗂️ Task tabs, kanban/worker3d), opened here
// by clicking a card, a #123 link or a ?task= link. The worker is the active one (the reviewer during a
// review, else the implementer). A task without a worker, or whose worker can't be reached, opens as a
// task window of its own instead (taskview.ts), not embedded: 📍 Show in 3D, 🧩 VSCode, the Terminal
// and Changes tabs stay. Only one task is open at a time, and it owns every window it passes through:
// the worker's window, its 🌿 Changes window (changesview.ts) and the plain one. The page learns of a
// close the user made (✕, Esc, the backdrop) through `closed`, never of one a transition caused (the
// Changes button closing the terminal, another task opening): each window carries a generation
// (CloseGuard in model.ts) and only the latest one's close is the user's.
//
// Riding to the worker's floor and opening its terminal are the page's (main.ts: onFloor, openTerminal),
// passed in as callbacks.

import type { Net } from '../net';
import type { Modal } from '../ui/dom';
import type { TerminalOptions } from '../ui/terminal';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { CloseGuard, planAfterWorkerGone, planTaskWindow, type TaskTab } from './model';
import { kstore } from './store';
import { openTaskChanges } from './changesview';
import { openTaskModal, type TaskView } from './taskview';

export interface TaskWindowsOptions {
  net: Net;
  /** Opens another task (a #123 link). */
  openTask(id: number): void;
  /** The user closed the open task's window. */
  closed(): void;
  /** The open task's tab changed. */
  tabChanged(tab: TaskTab): void;
  edit(task: KanbanTask): void;
  moveMenu(id: number): void;
  /**
   * Gets the page to `project`'s floor with the worker in sight, then runs `then`; `failed` runs
   * instead when it can't (the page has told the user why).
   */
  onFloor(project: string, workerId: string, then: () => void, failed: () => void): void;
  /** Opens the worker's terminal window with these options; `onChanges` is its 🌿 Changes button. */
  openWorker(workerId: string, opts: TerminalOptions, onChanges: () => void): Modal | void;
}

/** The task open: its windows come and go (`modal` is the one showing), it ends when another takes its place. */
interface Entry {
  id: number;
  guard: CloseGuard;
  tab: TaskTab | null;
  /** The worker the task's windows are about (the plain window has none until it hands over). */
  worker?: { workerId: string; project: string };
  /** Which window is showing. */
  showing?: 'worker' | 'changes' | 'plain';
  view?: TaskView;
  modal?: Modal | void;
}

export class TaskWindows {
  private cur: Entry | null = null;

  constructor(private o: TaskWindowsOptions) {}

  get id(): number | null {
    return this.cur?.id ?? null;
  }

  get tab(): TaskTab | null {
    return this.cur?.view?.tab ?? this.cur?.tab ?? null;
  }

  open(id: number, tab?: TaskTab) {
    const cur = this.cur;
    if (cur?.id === id) {
      if (cur.worker && tab === 'changes') this.showChanges(cur, cur.worker.workerId, cur.worker.project);
      else if (cur.worker && tab === 'terminal') this.showWorker(cur, cur.worker.workerId, cur.worker.project, 'terminal', undefined, false);
      else if (tab) cur.view?.setTab(tab);
      return;
    }
    if (cur) {
      cur.guard.end();
      cur.modal?.close();
    }
    const card = kstore.tasks.get(id);
    const plan = planTaskWindow(card, tab);
    const entry: Entry = { id, guard: new CloseGuard(), tab: tab ?? null };
    this.cur = entry;
    if (plan.kind === 'plain') return this.showPlain(entry, tab);
    entry.worker = { workerId: plan.workerId, project: plan.project };
    entry.tab = plan.tab === 'task' ? tab ?? null : plan.tab;
    if (plan.tab === 'changes') this.showChanges(entry, plan.workerId, plan.project);
    else this.showWorker(entry, plan.workerId, plan.project, plan.tab, tab, true);
  }

  /** A window of the entry closed: the user closed the task if it was the latest one. */
  private windowClosed(entry: Entry, gen: number) {
    if (!entry.guard.latest(gen) || this.cur !== entry) return;
    entry.guard.end();
    this.cur = null;
    this.o.closed();
  }

  /** A transition begins: the windows so far stop speaking for the task. Returns the next window's generation. */
  private begin(entry: Entry): number {
    const gen = entry.guard.bump();
    entry.view = undefined;
    return gen;
  }

  /**
   * The worker of the window showing left the office (a reviewer going home after its review): not the
   * user closing the task, which stays open in its other worker's window, else in a task window.
   */
  private workerGone(entry: Entry, gen: number, workerId: string) {
    if (!entry.guard.latest(gen) || this.cur !== entry) return;
    const tab = entry.tab === 'terminal' || entry.tab === 'changes' ? undefined : entry.tab ?? undefined;
    const plan = planAfterWorkerGone(kstore.tasks.get(entry.id), workerId, tab);
    entry.worker = undefined;
    if (plan.kind === 'plain') this.showPlain(entry, tab);
    else this.showWorker(entry, plan.workerId, plan.project, 'task', tab, true);
  }

  private showPlain(entry: Entry, tab: TaskTab | undefined) {
    const gen = this.begin(entry);
    entry.showing = 'plain';
    const { modal, view } = openTaskModal(this.o.net, entry.id, {
      tab,
      onClosed: () => this.windowClosed(entry, gen),
      onTab: (t) => this.tabChanged(entry, gen, t),
      openTask: (other) => this.o.openTask(other),
      edit: (task) => this.o.edit(task),
      moveMenu: (task) => this.o.moveMenu(task),
      // The task's worker has the terminal: its window, on the Terminal tab, in place of this one.
      openTerminal: (workerId, project) => this.showWorker(entry, workerId, project, 'terminal', undefined, false),
    });
    entry.modal = modal;
    entry.view = view;
  }

  /**
   * The worker's window in place of the entry's window now showing. `asked` is the task tab the link
   * asked for; `fallback`: a worker that can't be reached opens the plain window, else the task closes.
   */
  private showWorker(entry: Entry, workerId: string, project: string, tab: 'terminal' | 'task', asked: TaskTab | undefined, fallback: boolean) {
    const gen = this.begin(entry);
    const old = entry.modal;
    entry.modal = undefined;
    entry.showing = 'worker';
    entry.worker = { workerId, project };
    if (tab === 'terminal') this.tabChanged(entry, gen, 'terminal');
    old?.close();
    this.o.onFloor(
      project,
      workerId,
      () => {
        if (!entry.guard.latest(gen)) return;
        entry.modal = this.o.openWorker(
          workerId,
          {
            tab,
            onClosed: (why) => (why === 'gone' ? this.workerGone(entry, gen, workerId) : this.windowClosed(entry, gen)),
            task: {
              tab: tab === 'task' && asked !== 'terminal' && asked !== 'changes' ? asked : undefined,
              onTab: (t) => this.tabChanged(entry, gen, t),
              onWorkerTab: (t) => this.tabChanged(entry, gen, t),
              openTask: (other) => this.o.openTask(other),
              edit: (task) => this.o.edit(task),
              moveMenu: (task) => this.o.moveMenu(task),
              // The task's other worker (the reviewer): its window, on the Terminal tab.
              openTerminal: (id, proj) => this.showWorker(entry, id, proj, 'terminal', undefined, false),
              onKanban: true,
            },
          },
          () => this.showChanges(entry, workerId, project),
        );
      },
      () => {
        if (!entry.guard.latest(gen)) return;
        if (fallback) this.showPlain(entry, asked);
        else this.windowClosed(entry, gen);
      },
    );
  }

  /** The task's Changes window, opened before the window it replaces closes (never a moment without one). */
  private showChanges(entry: Entry, workerId: string, project: string) {
    // Already showing that worker's Changes window: it stays, no transition.
    if (entry.showing === 'changes' && entry.modal && entry.worker?.workerId === workerId) return;
    const gen = this.begin(entry);
    const old = entry.modal;
    entry.showing = 'changes';
    entry.worker = { workerId, project };
    entry.modal = openTaskChanges(this.o.net, {
      taskId: entry.id,
      workerId,
      onClosed: () => this.windowClosed(entry, gen),
      onTerminal: () => this.showWorker(entry, workerId, project, 'terminal', undefined, false),
    });
    this.tabChanged(entry, gen, 'changes');
    old?.close();
  }

  private tabChanged(entry: Entry, gen: number, tab: TaskTab) {
    if (!entry.guard.latest(gen)) return;
    entry.tab = tab;
    if (this.cur === entry) this.o.tabChanged(tab);
  }
}
