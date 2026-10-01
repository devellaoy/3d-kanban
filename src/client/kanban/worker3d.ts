// The worker window's tabs (E at a task worker's desk, or its card on the 2D view): 🖥️ Terminal (upstream's
// terminal and its web page tabs, upstream #212, as they are), 🗂️ Task #14 (the shared task view, embedded: conversation with its composer and
// history, plan, runs, changes, PRs); the worker's changes stay upstream's own 🌿 Changes button. The
// task view is mounted the first time its tab opens and destroyed with the window; the tab chosen is
// remembered per worker for the session. The task tab hides everything of the terminal side at window
// level (the kb-on-task class), so termtabs' own hidden state is untouched. A worker without a task gets
// no tabs: upstream's window.
//
// Keys: the terminal only reads the keys typed into its own textarea, and the office's keys are off
// while any window is open, so the task's composer is safe from both; its keydowns are stopped at the
// pane anyway (not Esc, which the window takes first, on the way down, to close).

import type { WorkerInfo } from '../../shared/protocol';
import type { Net } from '../net';
import { h, toast } from '../ui/dom';
import { TabMemory, TASK_PANE_CLASS, tabLabel, workerTabs, type WorkerTab } from './office';

const memory = new TabMemory();

const CSS = `
.modal.term .worker-tabs { display: flex; gap: 6px; padding: 6px 10px 0; background: var(--paper); border-bottom: 3px solid var(--ink); }
.modal.term .worker-tabs button { padding: 6px 12px; font: 800 13px var(--font); color: var(--ink); background: #f3f1ee; border: 3px solid var(--ink); border-bottom: 0; border-radius: 10px 10px 0 0; cursor: pointer; }
.modal.term .worker-tabs button.on { background: #fff; }
/* The task tab hides the whole terminal side (the terminal, its web page tabs, the keypad) at window level. */
.modal.term.kb-on-task > :not(header, .worker-tabs, .worker-task) { display: none !important; }
.modal.term .worker-task { flex: 1; min-height: 0; overflow: auto; background: #fff; color: var(--ink); }
`;

function css() {
  if (document.getElementById('kb-worker-tabs-css')) return;
  const el = document.createElement('style');
  el.id = 'kb-worker-tabs-css';
  el.textContent = CSS;
  document.head.append(el);
}

export interface WorkerTabsOptions {
  /** The tab to open on (the kanban's 📍 Show in 3D asks for the task). */
  tab?: WorkerTab;
  focusTerminal(): void;
}

export interface WorkerTabs {
  destroy(): void;
}

/**
 * Puts the tabs into a worker's terminal window `el`: the strip under its header, the task pane right
 * after `anchor` (the terminal's own area); null for a worker without a task, whose window stays upstream's.
 */
export function mountWorkerTabs(net: Net, w: WorkerInfo, el: HTMLElement, anchor: HTMLElement, opts: WorkerTabsOptions): WorkerTabs | null {
  const tabs = workerTabs(w);
  if (!tabs.length) return null;
  css();
  const taskId = w.kanban!.taskId;
  const pane = h(`div.${TASK_PANE_CLASS}.hidden`, { role: 'tabpanel', 'aria-label': `Task #${taskId}` });
  // The composer's keys stay in it (Esc still closes the window: it's caught on the way down).
  pane.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation());
  const buttons = new Map<WorkerTab, HTMLButtonElement>();
  const strip = h('nav.worker-tabs', { role: 'tablist', 'aria-label': `${w.name}'s window` });
  for (const tab of tabs) {
    const b = h('button', { type: 'button', role: 'tab' }, tabLabel(tab, w)) as HTMLButtonElement;
    b.addEventListener('click', () => show(tab));
    buttons.set(tab, b);
    strip.append(b);
  }
  el.querySelector(':scope > header')!.after(strip);
  anchor.after(pane);

  let view: { destroy(): void } | null = null;
  let destroyed = false;
  let current: WorkerTab = 'terminal';
  const show = (tab: WorkerTab) => {
    current = tab;
    memory.chose(w.id, tab);
    for (const [t, b] of buttons) {
      b.classList.toggle('on', t === tab);
      b.setAttribute('aria-selected', String(t === tab));
    }
    el.classList.toggle('kb-on-task', tab === 'task');
    pane.classList.toggle('hidden', tab !== 'task');
    if (tab === 'terminal') return void setTimeout(opts.focusTerminal, 0);
    // Out of the terminal, so its keys stop going to the worker.
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!view) {
      void import('./taskview').then((m) => {
        if (destroyed || view) return;
        // "Open its terminal" (an agent asking there) is this window's other tab.
        const openTerminal = (id: string) => (id === w.id ? show('terminal') : toast('That is the task’s other worker: open its terminal at its desk', 'info'));
        view = m.mountTaskView(pane, { net, taskId, embedded: true, openTerminal });
        if (current === 'task') pane.querySelector<HTMLElement>('.kb-tab.on')?.focus({ preventScroll: true });
      });
    }
  };
  show(memory.opening(w.id, tabs, opts.tab));
  return {
    destroy() {
      destroyed = true;
      view?.destroy();
      view = null;
    },
  };
}
