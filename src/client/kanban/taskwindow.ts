// A task on the kanban page, in a window rather than a panel: the same modal the 3D office shows for a
// task worker (its terminal window with the 🖥️ Terminal and 🗂️ Task tabs, kanban/worker3d), opened here
// by clicking a card, a #123 link or a ?task= link. A task without a worker, or whose worker can't be
// reached (another floor that doesn't answer, a worker gone), opens as a task window of its own instead
// (taskview.ts), not embedded: 📍 Show in 3D, 🧩 VSCode, the Terminal and Changes tabs stay. Only one is
// open at a time; the page learns of a close the user made (✕, Esc, the backdrop) through `closed`, never
// of one it caused itself by opening another task.
//
// Riding to the worker's floor and opening its terminal are the page's (main.ts: onFloor, openTerminal),
// passed in as callbacks.

import type { Net } from '../net';
import type { Modal } from '../ui/dom';
import type { TerminalOptions } from '../ui/terminal';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { planTaskWindow, type TaskTab } from './model';
import { kstore } from './store';
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
  /** Opens the worker's terminal window with these options. */
  openWorker(workerId: string, opts: TerminalOptions): Modal | void;
}

/** The window open for a task; `stale` once another has taken its place or the page closed it. */
interface Entry {
  id: number;
  stale: boolean;
  tab: TaskTab | null;
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
      if (tab) cur.view?.setTab(tab);
      return;
    }
    const plan = planTaskWindow(kstore.tasks.get(id), tab);
    this.show(id, tab, plan.kind === 'worker' ? plan : null, true);
  }

  /** Puts the window of task `id` in place of the one open; `worker` is its worker's window to try first. */
  private show(id: number, tab: TaskTab | undefined, worker: { workerId: string; project: string; tab: 'terminal' | 'task' } | null, fallback: boolean) {
    const old = this.cur;
    if (old) {
      old.stale = true;
      old.modal?.close();
    }
    const entry: Entry = { id, stale: false, tab: tab ?? null };
    this.cur = entry;
    const closed = () => {
      if (entry.stale || this.cur !== entry) return;
      this.cur = null;
      this.o.closed();
    };
    const plain = () => {
      if (entry.stale) return;
      const { modal, view } = openTaskModal(this.o.net, id, {
        tab,
        onClosed: closed,
        onTab: (t) => this.tabChanged(entry, t),
        openTask: (other) => this.o.openTask(other),
        edit: (task) => this.o.edit(task),
        moveMenu: (task) => this.o.moveMenu(task),
        // The task's worker has the terminal: its window, on the Terminal tab, in place of this one.
        openTerminal: (workerId, project) => this.show(id, tab, { workerId, project, tab: 'terminal' }, false),
      });
      entry.modal = modal;
      entry.view = view;
    };
    if (!worker) return plain();
    this.o.onFloor(
      worker.project,
      worker.workerId,
      () => {
        if (entry.stale) return;
        entry.modal = this.o.openWorker(worker.workerId, {
          tab: worker.tab,
          onClosed: closed,
          task: {
            tab: worker.tab === 'task' && tab !== 'terminal' ? tab : undefined,
            onTab: (t) => this.tabChanged(entry, t),
            openTask: (other) => this.o.openTask(other),
            edit: (task) => this.o.edit(task),
            moveMenu: (task) => this.o.moveMenu(task),
            onKanban: true,
          },
        });
      },
      () => {
        if (entry.stale) return;
        if (fallback) plain();
        else closed();
      },
    );
  }

  private tabChanged(entry: Entry, tab: TaskTab) {
    entry.tab = tab;
    if (!entry.stale && this.cur === entry) this.o.tabChanged(tab);
  }
}
