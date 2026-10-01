// A task in full, in a panel down the right of the board (the whole screen on a phone), dragged wider
// or narrower by its left edge. What's in it is the shared task view (taskview.ts), the same one the
// 3D office shows; this panel is only its frame on the kanban page, and the page's hooks into it
// (another task, edit, move, upstream's terminal window, the ?tab= link).

import { h } from '../ui/dom';
import type { Net } from '../net';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { TaskTab } from './model';
import { mountTaskView, type TaskView } from './taskview';

export type DetailTab = TaskTab;
export { isTaskTab as isDetailTab } from './model';

const WIDTH_KEY = 'kanban.detailWidth';

export interface DetailOptions {
  net: Net;
  root: HTMLElement;
  /** Opens another task (a #123 link). */
  openTask(id: number): void;
  closed(): void;
  /** The open task's tab changed. */
  tabChanged(tab: DetailTab): void;
  edit(task: KanbanTask): void;
  moveMenu(id: number): void;
  openTerminal(workerId: string, project: string): void;
}

export class DetailPanel {
  private view: TaskView | null = null;

  constructor(private o: DetailOptions) {
    this.resizable();
  }

  get id(): number | null {
    return this.view?.taskId ?? null;
  }

  get tab(): DetailTab | null {
    return this.view?.tab ?? null;
  }

  open(id: number, tab?: DetailTab) {
    if (this.view?.taskId === id) {
      if (tab) this.view.setTab(tab);
    } else {
      this.view?.destroy();
      if (!this.o.root.querySelector('.kb-resize')) this.o.root.append(h('div.kb-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the panel (← →)', tabindex: 0 }));
      this.view = mountTaskView(this.o.root, {
        net: this.o.net,
        taskId: id,
        tab,
        onClose: () => this.close(),
        onTab: (tab) => this.o.tabChanged(tab),
        openTask: (other) => this.o.openTask(other),
        edit: (task) => this.o.edit(task),
        moveMenu: (task) => this.o.moveMenu(task),
        openTerminal: (w, p) => this.o.openTerminal(w, p),
      });
    }
    this.o.root.classList.remove('hidden');
    document.body.classList.add('kb-detail-open');
    setTimeout(() => this.o.root.querySelector<HTMLElement>('.kb-tab.on')?.focus({ preventScroll: true }), 30);
  }

  close() {
    if (!this.view) return;
    this.view.destroy();
    this.view = null;
    this.o.root.classList.add('hidden');
    document.body.classList.remove('kb-detail-open');
    this.o.root.replaceChildren();
    this.o.closed();
  }

  /** The panel's left edge drags it wider or narrower (arrow keys too); the width is remembered. */
  private resizable() {
    const root = this.o.root;
    // On the page's root, so the board makes room for the panel as well.
    const doc = document.documentElement;
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(WIDTH_KEY));
    } catch {
      // storage blocked
    }
    if (saved >= 320) doc.style.setProperty('--kb-detail-w', `${Math.min(saved, window.innerWidth - 120)}px`);
    const setWidth = (w: number) => {
      const px = Math.round(Math.max(320, Math.min(window.innerWidth - 120, w)));
      doc.style.setProperty('--kb-detail-w', `${px}px`);
      try {
        localStorage.setItem(WIDTH_KEY, String(px));
      } catch {
        // storage blocked
      }
    };
    root.addEventListener('pointerdown', (e) => {
      const handle = (e.target as HTMLElement).closest('.kb-resize');
      if (!handle) return;
      e.preventDefault();
      (handle as HTMLElement).setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => setWidth(window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move as EventListener);
        handle.removeEventListener('pointerup', up);
        root.classList.remove('resizing');
      };
      root.classList.add('resizing');
      handle.addEventListener('pointermove', move as EventListener);
      handle.addEventListener('pointerup', up);
    });
    root.addEventListener('keydown', (e) => {
      if (!(e.target as HTMLElement).classList?.contains('kb-resize')) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setWidth(root.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 40 : -40));
    });
  }
}
