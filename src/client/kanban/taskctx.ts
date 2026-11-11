// What the task view's panes (taskoverview.ts, taskplan.ts, ...) get from the view that draws them:
// its options, the task's detail, and the few things a pane needs to do (send a request, open another
// task, redraw). Types only, so the panes don't import the view.

import type { Net } from '../net';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanProjectInfo, KanbanSettings, KanbanTask, ReviewSettings } from '../../shared/kanban/types.js';
import type { AttachBox } from './attachbox';
import type { KanbanApi, KanbanOk } from './api';
import type { TaskTab } from './model';

export type Detail = Extract<KanbanServerMsg, { t: 'kanban.task.detail' }>;

export interface TaskViewOptions {
  net: Net;
  taskId: number;
  /**
   * In another window (the 3D worker window's task tab, openTaskWindow): no Terminal tab (that window
   * has the worker's terminal) and nothing that only the board page can do (edit, move).
   */
  embedded?: boolean;
  /** The Changes tab (default true); the 3D worker window has none, its header's Changes button opens the same view. */
  changesTab?: boolean;
  /** The view is on the kanban page itself (in its task window, or the worker window's tab): no link back to it. */
  onKanban?: boolean;
  /** Called by the header's ✕ (shown only when this is given: a window of the task's own), and when the task is deleted. */
  onClose?: () => void;
  // The kanban page's hooks; without them the view does without what they open.
  /** The tab it opens on (a tab it doesn't show falls back to Overview). */
  tab?: TaskTab;
  /** The tab changed (for the page's ?tab= link). */
  onTab?(tab: TaskTab): void;
  /** Another task (a #123 link, or a review's new task). Default: a task window of its own. */
  openTask?(id: number): void;
  edit?(task: KanbanTask): void;
  moveMenu?(id: number): void;
  openTerminal?(workerId: string, project: string): void;
}

/** A draft text box with a files box, built once (a redraw reuses it); `go` is whatever the latest draw sends with. */
export interface FileBox {
  ta: HTMLTextAreaElement;
  attach: AttachBox;
  wrap: HTMLElement;
  go: () => void;
}

export interface TaskCtx {
  readonly o: TaskViewOptions;
  readonly api: KanbanApi;
  readonly taskId: number;
  readonly embedded: boolean;
  /** Pane state that outlives a redraw. */
  readonly ui: { agentOpen: boolean };
  readonly detail: Detail | null;
  settings(): KanbanSettings | null;
  project(id: string): KanbanProjectInfo | undefined;
  review(task: KanbanTask): ReviewSettings;
  req(msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: string): Promise<KanbanOk | undefined>;
  openTask(id: number): void;
  setTab(tab: TaskTab): void;
  /** Redraws the open tab's panel (only when it is `onlyOn`, if given). */
  paint(onlyOn?: TaskTab): void;
  /** Puts the keyboard in the box whose `data-focus` is `key`, once the open tab is drawn. */
  focusBox(key: string): void;
  drafts(): Map<string, string>;
  fileBox(key: string, attrs: Record<string, string | number>): FileBox;
  alive(): boolean;
}
