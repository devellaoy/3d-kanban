// The shared task view: one task in full, as the kanban page's side panel and the 3D office's windows
// show it (docs/kanban-coupling.md, "The shared task view"). Tabs: Overview (what it waits for, the
// actions, description, reports and details), Conversation (write at the top, newest first), Plan
// (its versions), Runs (every phase it ran), Terminal (the kanban page only: the 3D worker window has
// its own), Changes (the task's Changes view, changesview.ts; not in the worker window, whose header
// has 🌿 Changes for it) and PRs.
//
// It fetches the task with kanban.task.get on the connection's kanban bus (api.ts) and follows the
// kanban.task / kanban.comment / kanban.run / kanban.plan deltas for it. On the kanban page those come
// from the page's own subscription; anywhere else it asks for its project's deltas with api.watch(),
// which subscribes the connection for as long as a view needs it and never fights a page's filter.
// Its panes are taskoverview.ts, taskconv.ts, taskplan.ts, taskruns.ts and taskprs.ts; the buttons they
// draw are taskactionbar.ts's, from the lists in taskactions.ts.
// Its styles (taskview.css) are scoped under .kb-tv and load with this module, so the 3D page gets
// them only when it uses the view.

import './taskview.css';
import { h, openModal, toast, type Modal } from '../ui/dom';
import { store } from '../state';
import type { Net } from '../net';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanProjectInfo, KanbanSettings, KanbanTask, KanbanTaskCard, TaskStatus } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { kanbanApi, type KanbanApi, type KanbanOk } from './api';
import { attachBox } from './attachbox';
import { tickCountdowns } from './card';
import { REVIEW_DEFAULTS } from './defaults';
import { needsAttention, phaseBadge, showIn3dLink, tabFor, visibleTabs, type TaskTab } from './model';
import { kstore } from './store';
import { onSendKey } from './sendkey';
import { mountChangesView, type ChangesViewHandle } from './changesview';
import { mountIssueTab } from './issuetab';
import { columnName, phaseName, waitingName } from './labels';
import { run, tabStrip, textArea } from './ui';
import { Conversation, COMMENTS_PAGE } from './taskconv';
import type { Detail, FileBox, TaskCtx, TaskViewOptions } from './taskctx';
import { overviewPane } from './taskoverview';
import { planPane } from './taskplan';
import { prsPane } from './taskprs';
import { Reports } from './taskreports';
import { runsPane, terminalPane } from './taskruns';

export type { TaskViewOptions } from './taskctx';

const TAB_NAMES: Record<TaskTab, string> = { overview: 'Overview', conversation: 'Conversation', plan: 'Plan', runs: 'Runs', terminal: 'Terminal', changes: 'Changes', prs: 'PRs', issue: 'Issue' };

export interface TaskViewHandle {
  destroy(): void;
}

/** What the kanban page drives on top of destroy(). */
export interface TaskView extends TaskViewHandle {
  readonly taskId: number;
  readonly tab: TaskTab;
  setTab(tab: TaskTab): void;
  render(): void;
}

/** What's typed in a task's answer and plan boxes, kept across redraws and across windows opened again. */
const drafts = new Map<number, Map<string, string>>();
let headSeq = 0;

/** Mounts a task's view into `container` (appended to it); destroy() takes it out and stops its subscriptions. */
export function mountTaskView(container: HTMLElement, opts: TaskViewOptions): TaskView {
  return new View(container, opts);
}

/**
 * A task in a window of its own (the 3D office, the 2D view, a #123 link in an embedded view): the
 * view in upstream's modal, with its ✕ top right; ✕ and Esc close it (and, in the 3D office, put you
 * straight back into mouse-look, as every upstream window does).
 */
export function openTaskWindow(net: Net, taskId: number): Modal {
  return openTaskModal(net, taskId, { embedded: true }).modal;
}

/**
 * A task window with the page's own options: the kanban page opens it not embedded (so it keeps 📍 Show
 * in 3D, 🧩 VSCode, the Terminal and Changes tabs) and with its hooks. `onClosed` hears every close.
 */
export function openTaskModal(net: Net, taskId: number, opts: Omit<TaskViewOptions, 'net' | 'taskId' | 'onClose'> & { onClosed?(): void } = {}): { modal: Modal; view: TaskView } {
  const { onClosed, ...viewOpts } = opts;
  const el = h('div.modal.kb-task-window', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Task' });
  let modal: Modal | null = null;
  // Mounted first, so the view's own ✕ is there before openModal looks for one.
  const view = mountTaskView(el, { ...viewOpts, net, taskId, onClose: () => modal?.close() });
  modal = openModal(el, {
    onClose: () => {
      view.destroy();
      onClosed?.();
    },
    backdropCloses: true,
    doing: `reading task #${taskId}`,
    reading: true,
  });
  setTimeout(() => el.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({ preventScroll: true }), 30);
  return { modal, view };
}

class View implements TaskView {
  readonly taskId: number;
  private api: KanbanApi;
  private embedded: boolean;
  private changesTab: boolean;
  private root: HTMLElement;
  private body = h('div.kb-detail-body', { role: 'tabpanel' });
  private headId = `kb-tv-h-${++headSeq}`;
  private d: Detail | null = null;
  private error = '';
  private current: TaskTab;
  /** The answer and change-request boxes, kept across redraws so their uploaded files stay. */
  private fileBoxes = new Map<string, FileBox>();
  private refetch: ReturnType<typeof setTimeout> | undefined;
  private strip: ReturnType<typeof tabStrip<TaskTab>> | null = null;
  private card: KanbanTaskCard | undefined;
  private projects: KanbanProjectInfo[];
  private settings: KanbanSettings | null;
  private offs: (() => void)[] = [];
  private unwatch: (() => void) | null = null;
  private destroyed = false;
  /** The Changes tab's view: mounted the first time the tab opens, taken down when another tab does. */
  private issue: ReturnType<typeof mountIssueTab> | null = null;
  private changes: { host: HTMLElement; view: ChangesViewHandle } | null = null;
  private reports: Reports;
  private conv: Conversation;
  /** What the panes see of this view. */
  private c: TaskCtx;

  constructor(
    container: HTMLElement,
    private o: TaskViewOptions,
  ) {
    this.taskId = o.taskId;
    this.embedded = !!o.embedded;
    this.changesTab = o.changesTab ?? true;
    this.api = kanbanApi(o.net);
    this.current = tabFor(o.tab, this.embedded, this.changesTab);
    this.root = h('div.kb-tv', { class: this.embedded ? 'embedded' : '' });
    this.card = kstore.tasks.get(o.taskId);
    this.projects = kstore.projects;
    this.settings = kstore.settings;
    container.append(this.root);
    const ui = { agentOpen: false };
    const view = this;
    this.c = {
      o,
      ui,
      api: this.api,
      taskId: this.taskId,
      embedded: this.embedded,
      get detail() {
        return view.d;
      },
      settings: () => this.settings,
      project: (id) => this.projectOf(id),
      review: (task) => this.reviewSettings(task),
      req: (msg, button, done) => this.req(msg, button, done),
      openTask: (id) => this.openTask(id),
      setTab: (tab) => this.setTab(tab),
      paint: (onlyOn) => {
        if (!this.destroyed && (!onlyOn || this.current === onlyOn)) this.paintBody();
      },
      drafts: () => this.drafts(),
      fileBox: (key, attrs) => this.fileBox(key, attrs),
      alive: () => !this.destroyed,
    };
    this.reports = new Reports(this.c);
    this.conv = new Conversation(this.c);
    this.offs.push(
      this.api.on((msg) => this.onMsg(msg)),
      // A worker's name and state (Terminal) come from the floor's workers.
      store.on('workers', () => this.workersChanged()),
    );
    if (this.embedded) {
      // The kanban page ticks every countdown itself; elsewhere the view ticks its own.
      const timer = setInterval(() => tickCountdowns(this.root), 1000);
      this.offs.push(() => clearInterval(timer));
    }
    this.render();
    void this.load();
  }

  get tab(): TaskTab {
    return this.current;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.refetch);
    for (const off of this.offs) off();
    this.unwatch?.();
    this.dropChanges();
    this.dropIssue();
    this.root.remove();
  }

  setTab(tab: TaskTab) {
    const to = tabFor(tab, this.embedded, this.changesTab);
    if (to === this.current) return;
    this.current = to;
    this.strip?.set(to);
    this.paintBody();
    this.o.onTab?.(to);
  }

  private get task(): KanbanTask | undefined {
    return this.d?.task;
  }

  private projectOf(id: string): KanbanProjectInfo | undefined {
    return this.projects.find((p) => p.id === id);
  }

  private openTask(id: number) {
    if (this.o.openTask) this.o.openTask(id);
    else openTaskWindow(this.o.net, id);
  }

  private async load(): Promise<boolean> {
    if (this.destroyed) return false;
    try {
      const d = await this.api.request<Detail>({ t: 'kanban.task.get', id: this.taskId, comments: COMMENTS_PAGE });
      if (this.destroyed) return false;
      // Older pages already loaded stay, under the fresh newest page.
      const prev = this.d;
      const older = prev ? prev.comments.filter((c) => c.id < (d.comments[0]?.id ?? Infinity)) : [];
      this.d = { ...d, comments: [...older, ...d.comments], commentsMore: older.length && prev ? prev.commentsMore : d.commentsMore };
      this.error = '';
      // Its project's deltas (a no-op where a page's own subscription already brings them).
      this.unwatch ??= this.api.watch(d.task.project);
      const key = `${d.task.status}:${d.task.phase ?? ''}:${d.task.runState}`;
      this.reports.follow(key);
    } catch (err) {
      if (this.destroyed) return false;
      this.error = (err as Error).message;
      this.render();
      return false;
    }
    this.render();
    return true;
  }

  /** A burst of changes is one fetch, a moment later. */
  private later() {
    clearTimeout(this.refetch);
    this.refetch = setTimeout(() => void this.load(), 250);
  }

  private onMsg(msg: KanbanServerMsg) {
    if (this.destroyed) return;
    const d = this.d;
    const replace = <T extends { id: number }>(list: T[], item: T) => {
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      else list.push(item);
    };
    switch (msg.t) {
      case 'kanban.snapshot': {
        this.projects = msg.projects;
        this.settings = msg.settings;
        this.card = msg.tasks.find((c) => c.id === this.taskId) ?? this.card;
        // A (re)subscription: whatever happened before it is in the task, fetched again.
        if (d && (msg.project === null || msg.project === d.task.project)) this.later();
        else this.render();
        return;
      }
      case 'kanban.projects':
        this.projects = msg.projects;
        return this.render();
      case 'kanban.settings':
        this.settings = msg.settings;
        return this.render();
      case 'kanban.task':
        if (msg.task.id !== this.taskId) return;
        this.card = msg.task;
        return this.later();
      case 'kanban.task.removed':
        if (msg.id !== this.taskId) return;
        // Also what a subscriber without the archive hears when the task is archived: gone only if the office says so.
        void this.load().then((ok) => {
          if (ok || this.destroyed) return;
          toast(`Task #${this.taskId} was deleted`, 'warn');
          this.o.onClose?.();
        });
        return;
      case 'kanban.comment':
        if (!d || msg.comment.taskId !== this.taskId) return;
        replace(d.comments, msg.comment);
        d.comments.sort((a, b) => a.id - b.id);
        break;
      case 'kanban.run':
        if (!d || msg.run.taskId !== this.taskId) return;
        replace(d.runs, msg.run);
        break;
      case 'kanban.plan':
        if (!d || msg.plan.taskId !== this.taskId) return;
        replace(d.plans, msg.plan);
        break;
      default:
        return;
    }
    this.render();
  }

  // --- Frame ------------------------------------------------------------------------------------
  render() {
    if (this.destroyed) return;
    const restore = this.focusMark();
    const id = this.taskId;
    const card = this.card;
    const task = this.task;
    const title = task?.title ?? card?.title ?? '';
    const status: TaskStatus | undefined = task?.status ?? card?.status;
    const running = task ? isRunning(task) : card ? isRunning(card) : false;
    const badge = card ? phaseBadge(card) : task ? phaseBadge({ ...task, reviewRounds: this.reviewSettings(task).rounds }) : null;
    const waitingReason = task?.waitingReason ?? card?.waitingReason;
    const links: HTMLElement[] = [];
    if (task && !this.embedded) {
      const w = task.workerId ? store.workers.get(task.workerId) : undefined;
      links.push(h('a.btn.small', { href: showIn3dLink(task.project, task.workerId, w?.deskId), title: 'The 3D office, at this task’s worker (or on its floor)' }, '📍 Show in 3D'));
      // The 3D worker window has its own 🧩 VSCode in its header (kanban/vscode), so only here.
      if (kstore.me.admin) {
        const code = h('button.btn.small', { type: 'button', title: 'Open this task’s folder in VS Code on the office’s computer: its worktree, or all its repositories’ worktrees in one window' }, '🧩 VSCode') as HTMLButtonElement;
        code.addEventListener('click', () => void this.req({ t: 'kanban.task.vscode', id: task.id }, code, 'Opening VS Code…'));
        links.push(code);
      }
    }
    if (task && this.embedded && !this.o.onKanban) {
      links.push(h('a.btn.small', { href: `/kanban?project=${encodeURIComponent(task.project)}&task=${id}${this.current !== 'overview' ? `&tab=${this.current}` : ''}` }, '🗂️ Open in the kanban'));
    }
    let close: HTMLElement | null = null;
    if (this.o.onClose) {
      close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
      close.addEventListener('click', () => this.o.onClose?.());
    }
    const head = h(
      'header.kb-detail-head',
      {},
      h('div.kb-detail-title', {}, h('span.kb-id', {}, `#${id}`), h('h2', { id: this.headId }, title || 'Loading…')),
      h(
        'div.kb-detail-sub',
        {},
        status ? h('span.kb-status', { class: status }, columnName(status)) : null,
        running ? h('span.kb-pulse', { title: 'Running' }) : null,
        badge ? h('span.kb-phase', { class: badge.phase }, `${phaseName(badge.phase)}${badge.round ? ` ${badge.round}` : ''}`) : null,
        waitingReason && status === 'waiting' ? h('span.kb-wait-pill', { class: needsAttention({ status, waitingReason }) ? 'attention' : '' }, waitingName(waitingReason)) : null,
        links.length ? h('span.kb-head-links', {}, ...links) : null,
      ),
      close,
    );
    const d = this.d;
    const counts: Partial<Record<TaskTab, number>> = d ? { conversation: card?.commentCount ?? d.comments.length, plan: d.plans.length, runs: d.runs.length, prs: d.task.prs.length } : {};
    this.strip = tabStrip(
      visibleTabs(this.embedded, this.changesTab).map((tab) => ({ id: tab, label: h('span', {}, TAB_NAMES[tab], counts[tab] ? h('span.kb-tab-n', {}, String(counts[tab])) : null) })),
      this.current,
      (tab) => {
        this.current = tab;
        this.paintBody();
        this.o.onTab?.(tab);
      },
      'Task',
    );
    this.root.setAttribute('aria-labelledby', this.headId);
    this.root.replaceChildren(head, this.strip.el, this.body);
    this.paintBody();
    restore();
  }

  /**
   * Notes which box has the focus (by its data-focus) and where its caret is, and returns how to put
   * them back after a redraw, so a delta arriving mid-sentence doesn't take the keyboard away.
   */
  private focusMark(): () => void {
    const el = document.activeElement as HTMLElement | null;
    const key = el && this.root.contains(el) ? el.dataset.focus : undefined;
    if (!key) return () => {};
    const sel = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd] : null;
    return () => {
      const again = this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
      if (!again || again === document.activeElement) return;
      again.focus({ preventScroll: true });
      if (sel && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)) again.setSelectionRange(sel[0], sel[1]);
    };
  }

  private drafts(): Map<string, string> {
    let m = drafts.get(this.taskId);
    if (!m) drafts.set(this.taskId, (m = new Map()));
    return m;
  }

  /** A text box whose text outlives the view's redraws. */
  private draftArea(key: string, attrs: Record<string, string | number>): HTMLTextAreaElement {
    const ta = textArea(this.drafts().get(key) ?? '', { ...attrs, 'data-focus': key });
    ta.addEventListener('input', () => this.drafts().set(key, ta.value));
    return ta;
  }

  /** A draft text box with a files box, built once (a redraw reuses it); `go` is whatever the latest draw sends with. */
  private fileBox(key: string, attrs: Record<string, string | number>) {
    let b = this.fileBoxes.get(key);
    if (!b) {
      const ta = this.draftArea(key, attrs);
      const wrap = h('div.kb-answerbox');
      const box = { ta, wrap, attach: attachBox({ target: ta, dropZone: wrap, insertLinks: true }), go: () => {} };
      onSendKey(ta, () => box.go());
      this.fileBoxes.set(key, (b = box));
    }
    b.ta.placeholder = String(attrs.placeholder ?? '');
    b.ta.setAttribute('aria-label', String(attrs['aria-label'] ?? ''));
    return b;
  }

  /** The floor's workers changed: only the tab that shows them is redrawn (the Changes view follows them itself). */
  private workersChanged() {
    if (this.destroyed || this.current !== 'terminal') return;
    const restore = this.focusMark();
    this.paintBody();
    restore();
  }

  private paintBody() {
    const scroll = this.body.scrollTop;
    const keep = this.body.dataset.tab === this.current;
    this.body.dataset.tab = this.current;
    this.body.setAttribute('aria-labelledby', `kbtab-${this.current}`);
    const d = this.d;
    if (!d) {
      this.body.replaceChildren(this.error ? h('div.kb-error', {}, `⚠️ ${this.error} `, h('button.btn.small', { type: 'button', onclick: () => void this.load() }, 'Try again')) : h('p.kb-muted', {}, 'Loading…'));
      return;
    }
    // The Changes view draws itself: a redraw only tells it who the worker is now.
    if (this.current === 'changes' && this.changes && this.body.childElementCount === 1 && this.body.firstElementChild === this.changes.host) {
      this.changes.view.setWorker(d.task.workerId);
      return;
    }
    if (this.current === 'issue' && this.issue && this.body.firstElementChild === this.issue.host && this.body.childElementCount === 1) {
      this.issue.setTask(d.task);
      return;
    }
    const content: Record<TaskTab, () => HTMLElement[]> = {
      overview: () => overviewPane(this.c, d, this.reports),
      conversation: () => this.conv.pane(d),
      plan: () => planPane(this.c, d),
      runs: () => runsPane(this.c, d),
      terminal: () => terminalPane(this.c, d.task),
      changes: () => [this.changesPane(d.task)],
      prs: () => prsPane(this.c, d.task),
      issue: () => [this.issuePane(d.task)],
    };
    if (this.current !== 'changes') this.dropChanges();
    if (this.current !== 'issue') this.dropIssue();
    this.body.replaceChildren(...content[this.current]());
    if (keep) this.body.scrollTop = scroll;
  }

  private req(msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: string) {
    return run(() => this.api.request<KanbanOk>(msg), button, done);
  }

  private reviewSettings(task: KanbanTask) {
    return { ...REVIEW_DEFAULTS, ...this.settings?.review, ...this.settings?.projects[task.project]?.review, ...task.overrides.review };
  }


  /** The task's Changes view, kept across redraws (and following a new worker), so its place and live watch stay. */
  private changesPane(task: KanbanTask): HTMLElement {
    if (!this.changes) {
      const host = h('div.kb-tv-changes');
      const view = mountChangesView(host, { net: this.o.net, taskId: this.taskId, workerId: task.workerId, prs: () => this.task?.prs });
      this.changes = { host, view };
    } else this.changes.view.setWorker(task.workerId);
    return this.changes.host;
  }

  /** Takes the Changes view down (another tab, or the view closing): its live watch ends with it. */
  private dropChanges() {
    this.changes?.view.destroy();
    this.changes = null;
  }

  /** The task's Issue tab, kept across redraws so a comment being written stays; down when another tab opens. */
  private issuePane(task: KanbanTask): HTMLElement {
    this.issue ??= mountIssueTab(this.api, (id) => this.openTask(id));
    this.issue.setTask(task);
    return this.issue.host;
  }

  private dropIssue() {
    this.issue?.destroy();
    this.issue = null;
  }
}
