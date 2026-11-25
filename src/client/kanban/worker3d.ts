// The worker window's tabs (E at a task worker's desk, or its card on the 2D view): Terminal (upstream's
// terminal and its shell tabs, ui/termtabs.ts), Task #14 (the shared task view, embedded, with no ✕ of
// its own: its header, tabs, details rail and footer); its changes are the header's Changes
// button, which opens the task's Changes window (kanban/changesview, every repository and per commit), not
// a tab here. The task view is mounted the first time its tab opens and destroyed with the window; the tab
// chosen is remembered per worker for the session (the Task tab until another is picked). The task tab
// hides everything of the terminal side at window level (the kb-on-task class), so termtabs' own hidden
// state is untouched. A worker without a task gets no tabs: upstream's window.
//
// Keys: the terminal only reads the keys typed into its own textarea, and the office's keys are off
// while any window is open, so the task's composer is safe from both; its keydowns are stopped at the
// pane anyway (not Esc, which the window takes first, on the way down, to close).

import type { WorkerInfo } from '../../shared/protocol';
import type { Net } from '../net';
import { h, toast } from '../ui/dom';
import { store } from '../state';
import { providerLabel } from '../ui/provider';
import type { TermSibling } from '../ui/termtabs';
import { watchTaskSiblings } from './tasktabs';
import { icon } from '../ui/icons';
import { tabStrip } from '../ui/tabs';
import './worker3d.css';
import { TabMemory, TASK_PANE_CLASS, tabText, workerTabs, type WorkerTab } from './office';
import { mountVsCodeButton } from './vscode';
import type { TaskView, TaskViewOptions } from './taskview';
import type { TaskTab } from './model';

const memory = new TabMemory();

/** What the kanban page adds to the task tab's view: its hooks, and that it's on the page itself. */
export type WorkerTaskHooks = Pick<TaskViewOptions, 'tab' | 'onTab' | 'openTask' | 'edit' | 'moveMenu' | 'onKanban' | 'openTerminal'> & {
  /** The window's Terminal/Task strip switched (to 'task': the task view's tab, 'overview' if it isn't mounted yet). */
  onWorkerTab?(tab: TaskTab): void;
};

export interface WorkerTabsOptions {
  /** The kanban page's hooks for the task tab's view (absent in the 3D office and on the 2D view). */
  task?: WorkerTaskHooks;
  /** The tab to open on (the kanban's Show in 3D asks for the task). */
  tab?: WorkerTab;
  focusTerminal(): void;
  /** The window's tab row takes the task's workers, and how to get to one (ui/termtabs.ts setSiblings). */
  siblings?(list: TermSibling[], open: (workerId: string) => void): void;
  /** Another worker's window in place of this one, where the kanban page's hooks are absent (the 3D office, the 2D view). */
  openWorker?(workerId: string): void;
}

export interface WorkerTabs {
  destroy(): void;
}

/**
 * Puts the tabs into a worker's terminal window `el`: the strip under its header, the task pane right
 * after `anchor` (the terminal's own area); null for a worker without a task, whose window stays upstream's.
 */
export function mountWorkerTabs(net: Net, w: WorkerInfo, el: HTMLElement, anchor: HTMLElement, opts: WorkerTabsOptions): WorkerTabs | null {
  // Every worker's window, with tabs or without, gets VS Code in its header (admins only).
  mountVsCodeButton(net, w, el, opts.focusTerminal);
  const tabs = workerTabs(w);
  if (!tabs.length) return null;
  // The header's Changes opens the task's Changes window: loaded now, so it opens at once (no
  // moment without a window, when the office would take the mouse back).
  void import('./changeswindow');
  const taskId = w.kanban!.taskId;
  const pane = h(`div.${TASK_PANE_CLASS}.hidden`, { role: 'tabpanel', 'aria-label': `Task #${taskId}` });
  // The composer's keys stay in it (Esc still closes the window: it's caught on the way down).
  pane.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation());
  // The shared strip (ui/tabs.ts), with ids of its own: the task view inside has a strip too.
  const strip = tabStrip(tabs.map((tab) => ({ id: tab, label: [icon(tab === 'terminal' ? 'square-terminal' : 'square-kanban'), tabText(tab, w)] })), tabs[0], (tab) => show(tab), `${w.name}'s window`, 'wtab');
  strip.el.classList.add('worker-tabs');
  el.querySelector(':scope > header')!.after(strip.el);
  anchor.after(pane);

  // The page's hooks, less the two this window answers itself: the strip's switch is reported, and "Open its terminal" of this worker is the strip's.
  const { onWorkerTab, openTerminal: pageOpenTerminal, ...taskHooks } = opts.task ?? {};
  /**
   * The task's other worker (a reviewer, the implementer): its window on its Terminal tab. On the kanban
   * page the page opens it (the open task goes with it); in the office it opens as E at its desk does.
   */
  const openOther = (id: string) => {
    if (pageOpenTerminal) return pageOpenTerminal(id, store.floor ?? '');
    if (!opts.openWorker) return void toast('That is the task’s other worker: open its terminal at its desk', 'info');
    memory.chose(id, 'terminal');
    opts.openWorker(id);
  };
  // One tab per worker of the task in the terminal's tab row, kept up as reviewers come and go.
  const unwatch = opts.siblings
    ? watchTaskSiblings(
        w.id,
        {
          workers: () => [...store.workers.values()].map((o) => ({ id: o.id, name: o.name, kanban: o.kanban, tool: o.kind === 'agent' ? providerLabel(o.provider, store.project) : undefined })),
          onChange: (fn) => store.on('workers', fn),
        },
        (list) => opts.siblings!(list, openOther),
      )
    : undefined;
  let view: TaskView | null = null;
  let destroyed = false;
  let current: WorkerTab = 'terminal';
  const show = (tab: WorkerTab) => {
    current = tab;
    memory.chose(w.id, tab);
    strip.set(tab);
    el.classList.toggle('kb-on-task', tab === 'task');
    pane.classList.toggle('hidden', tab !== 'task');
    onWorkerTab?.(tab === 'terminal' ? 'terminal' : view?.tab ?? taskHooks.tab ?? 'overview');
    if (tab === 'terminal') return void setTimeout(opts.focusTerminal, 0);
    // Out of the terminal, so its keys stop going to the worker.
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!view) {
      void import('./taskview').then((m) => {
        if (destroyed || view) return;
        // "Open its terminal" (an agent asking there) is this window's other tab; another worker's (a
        // reviewer's) opens that worker's window.
        const openTerminal = (id: string, project: string) => (id === w.id ? show('terminal') : pageOpenTerminal ? pageOpenTerminal(id, project) : openOther(id));
        // No Changes tab: the window's header has Changes, which opens the task's Changes window.
        view = m.mountTaskView(pane, { ...taskHooks, net, taskId, embedded: true, changesTab: false, openTerminal });
        if (current === 'task') pane.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true });
      });
    }
  };
  show(memory.opening(w.id, tabs, opts.tab));
  return {
    destroy() {
      destroyed = true;
      unwatch?.();
      view?.destroy();
      view = null;
    },
  };
}
