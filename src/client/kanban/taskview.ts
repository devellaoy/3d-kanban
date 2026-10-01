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
// Its styles (taskview.css) are scoped under .kb-tv and load with this module, so the 3D page gets
// them only when it uses the view.

import './taskview.css';
import { h, openModal, timeAgo, toast, type Modal } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import { store } from '../state';
import type { Net } from '../net';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { KANBAN_TOOLS, type CommentKind, type KanbanAttachment, type KanbanComment, type KanbanEffort, type KanbanEvent, type KanbanPlan, type KanbanProjectInfo, type KanbanReportFile, type KanbanRole, type KanbanRun, type KanbanSettings, type KanbanTask, type KanbanTaskCard, type KanbanTool, type PlanStatus, type ReviewVerdict, type RunStatus, type TaskStatus, type TaskType } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { canFixPrs, openPrs, prStatusOk } from '../../shared/kanban/prs.js';
import { getJson, kanbanApi, type KanbanApi, type KanbanOk } from './api';
import { attachmentUrl, formatSize, isImage } from './attach';
import { attachBox, type AttachBox } from './attachbox';
import { TOOL_ICON, ticketChip, tickCountdowns } from './card';
import { effortSelect, modelInput } from './create';
import { renderMarkdown } from './md';
import { REVIEW_DEFAULTS } from './defaults';
import { cardRepoNames, countdown, needsAttention, phaseBadge, prTone, showIn3dLink, tabFor, visibleTabs, type TaskTab } from './model';
import { kstore } from './store';
import { onSendKey, sendHint } from './sendkey';
import { mountChangesView, type ChangesViewHandle } from './changesview';
import { APPROVAL_NAMES, columnName, COUNTDOWN_UNITS, effortName, fmtDuration, fmtTime, phaseName, PR_STATE_NAMES, toolName, waitingName } from './labels';
import { run, select, tabStrip, textArea } from './ui';

const COMMENTS_PAGE = 30;
const TAB_NAMES: Record<TaskTab, string> = { overview: 'Overview', conversation: 'Conversation', plan: 'Plan', runs: 'Runs', terminal: 'Terminal', changes: 'Changes', prs: 'PRs' };
const TYPE_NAMES: Record<TaskType, string> = { implement: 'Implement', investigate: 'Investigate' };
const ROLE_NAMES: Record<KanbanRole, string> = { implementer: 'Implementer', reviewer: 'Reviewer' };
const COMMENT_KIND_NAMES: Record<CommentKind, string> = { message: 'message', result: 'result', plan: 'plan', questions: 'questions', review: 'review', status: 'status' };
const PLAN_STATUS_NAMES: Record<PlanStatus, string> = { draft: 'draft', accepted: 'accepted', superseded: 'superseded' };
const RUN_STATUS_NAMES: Record<RunStatus, string> = { running: 'running', succeeded: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
const VERDICT_NAMES: Record<ReviewVerdict, string> = { approved: '✅ approved', changes_requested: '🛠 changes requested' };

type Detail = Extract<KanbanServerMsg, { t: 'kanban.task.detail' }>;

export interface TaskViewOptions {
  net: Net;
  taskId: number;
  /**
   * In another window (the 3D worker window's task tab, openTaskWindow): no Terminal tab (that window
   * has the worker's terminal) and nothing that only the board page can do (edit, move).
   */
  embedded?: boolean;
  /** The Changes tab (default true); the 3D worker window has none, its header's 🌿 Changes opens the same view. */
  changesTab?: boolean;
  /** Called by the view's own ✕ (shown only when this is given), and when the task is deleted. */
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
  const el = h('div.modal.kb-task-window', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Task' });
  let modal: Modal | null = null;
  // Mounted first, so the view's own ✕ is there before openModal looks for one.
  const view = mountTaskView(el, { net, taskId, embedded: true, onClose: () => modal?.close() });
  modal = openModal(el, { onClose: () => view.destroy(), doing: `reading task #${taskId}`, reading: true });
  setTimeout(() => el.querySelector<HTMLElement>('.kb-tab.on')?.focus({ preventScroll: true }), 30);
  return modal;
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
  private composer: { el: HTMLElement; ta: HTMLTextAreaElement; attach: AttachBox } | null = null;
  /** The answer and change-request boxes, kept across redraws so their uploaded files stay. */
  private fileBoxes = new Map<string, { ta: HTMLTextAreaElement; attach: AttachBox; wrap: HTMLElement; go: () => void }>();
  private loadingOlder = false;
  private refetch: ReturnType<typeof setTimeout> | undefined;
  private strip: ReturnType<typeof tabStrip<TaskTab>> | null = null;
  private card: KanbanTaskCard | undefined;
  private projects: KanbanProjectInfo[];
  private settings: KanbanSettings | null;
  private offs: (() => void)[] = [];
  private unwatch: (() => void) | null = null;
  private destroyed = false;
  /** The Changes tab's view: mounted the first time the tab opens, taken down when another tab does. */
  private changes: { host: HTMLElement; view: ChangesViewHandle } | null = null;
  private reports: { list: KanbanReportFile[]; shown: Map<string, HTMLElement> } | null = null;
  private reportsFor = '';
  private agentOpen = false;

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
      if (this.reportsFor !== key) {
        this.reportsFor = key;
        void this.loadReports();
      }
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
    if (task && this.embedded) {
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
      const box = { ta, wrap, attach: attachBox({ target: ta, dropZone: wrap, taskId: () => this.taskId, insertLinks: false }), go: () => {} };
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
    const content: Record<TaskTab, () => HTMLElement[]> = {
      overview: () => this.overview(d),
      conversation: () => this.conversation(d),
      plan: () => this.plans(d),
      runs: () => this.runs(d),
      terminal: () => this.terminal(d.task),
      changes: () => [this.changesPane(d.task)],
      prs: () => this.prs(d.task),
    };
    if (this.current !== 'changes') this.dropChanges();
    this.body.replaceChildren(...content[this.current]());
    if (keep) this.body.scrollTop = scroll;
  }

  // --- Overview ---------------------------------------------------------------------------------

  private req(msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: string) {
    return run(() => this.api.request<KanbanOk>(msg), button, done);
  }

  private reviewSettings(task: KanbanTask) {
    return { ...REVIEW_DEFAULTS, ...this.settings?.review, ...this.settings?.projects[task.project]?.review, ...task.overrides.review };
  }

  private actionButtons(task: KanbanTask): HTMLElement {
    const bar = h('div.kb-actions');
    const add = (label: string, cls: string, fn: (b: HTMLButtonElement) => void, title?: string) => {
      const b = h(`button.btn${cls}`, { type: 'button', title, 'data-focus': `act-${label}` }, label) as HTMLButtonElement;
      b.addEventListener('click', () => fn(b));
      bar.append(b);
      return b;
    };
    const id = task.id;
    const running = isRunning(task);
    const hasWorker = !!(task.workerId || task.reviewerWorkerId);
    const reviewRound = () => add('🔍 Run a review round', '', (b) => void this.req({ t: 'kanban.task.review', id }, b, 'A review round starts'), 'A reviewer looks at the work once more; changes it asks for are fixed');
    if (task.status === 'todo') {
      add('▶️ Start', '.primary', (b) => void this.req({ t: 'kanban.task.start', id }, b, 'Started'));
      if (this.o.edit) add('✏️ Edit', '', () => this.o.edit?.(task));
    }
    if (running) add('⏹️ Stop', '.danger', (b) => void this.req({ t: 'kanban.task.stop', id }, b, 'Stopping…'));
    if (task.status === 'waiting' && !running) {
      switch (task.waitingReason) {
        case 'plan_approval':
          add('✅ Approve the plan', '.primary', (b) => void this.req({ t: 'kanban.plan.approve', id }, b, 'Plan approved'));
          add('✍️ Request changes', '', () => this.setTab('plan'));
          break;
        case 'usage_limit':
          add('🔁 Retry now', '.primary', (b) => void this.req({ t: 'kanban.task.retry', id }, b, 'Trying again'));
          break;
        case 'failed':
        case 'interrupted':
          add('🔁 Retry', '.primary', (b) => void this.req({ t: 'kanban.task.retry', id }, b, 'Trying again'));
          add('▶️ Continue', '', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'Continuing'));
          break;
        case 'agent_asking':
          // Answered in the box above the actions (typed into its terminal), or in the terminal itself:
          // there's nothing to carry on without an answer, its run is still going.
          break;
        case 'plan_questions':
          // Answered in the box above the actions; or carried on without an answer (the planner assumes).
          add('▶️ Continue without answering', '', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'Continuing'), 'The agent goes on with assumptions of its own, and names them');
          break;
        default:
          add('▶️ Continue', '.primary', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'Continuing'));
      }
      // The engine reviews a waiting task by hand too, when it has work to review (not a plan waiting).
      if (task.type === 'implement' && task.workspace && task.waitingReason !== 'plan_questions' && task.waitingReason !== 'plan_approval') reviewRound();
    }
    if (task.status === 'review' && !running) {
      if (task.type === 'implement') reviewRound();
      if (task.type === 'implement') {
        add(`🔀 ${task.prs.length ? 'Push & update PRs' : 'Create PRs'}`, '.primary', (b) => void this.req({ t: 'kanban.task.pr', id, mode: 'create' }, b, 'An agent is on the pull requests'), 'The agent pushes and opens (or updates) a pull request in every repository with commits');
      }
    }
    this.fixPrs(task, bar);
    if (task.status !== 'in_progress' && this.o.moveMenu) add('↔️ Move…', '', () => this.o.moveMenu?.(id), 'Move to another column (M)');
    if (!running) add('🗑️ Delete', '.danger', (b) => confirmDialog(`Delete #${id}?`, `The task, its conversation, plans and runs are deleted for good. ${hasWorker ? 'Its workers go home. ' : ''}${task.workspace ? `Its worktree (${task.workspace.worktree.path}), its branches` : 'Its branches'}${task.branch ? ` (${task.branch})` : ''} and pull requests stay.`, 'Delete', () => void this.req({ t: 'kanban.task.delete', id }, b)));
    return bar;
  }

  /** What the task waits for, with a box to answer when it asked something. */
  private waitingBox(task: KanbanTask): HTMLElement | null {
    if (task.status !== 'waiting' || !task.waitingReason) return null;
    const open = (id: number) => this.openTask(id);
    const box = h('section.kb-waiting', { class: task.waitingReason }, h('h4', {}, `🙋 ${waitingName(task.waitingReason)}`), task.waitingText ? renderMarkdown(task.waitingText, open, '') : null);
    if (task.retryAt) {
      box.append(
        h('p.kb-retry', { 'data-retry-at': String(task.retryAt) }, `🔁 retries in ${countdown(task.retryAt, Date.now(), COUNTDOWN_UNITS)}`),
        h('small.kb-muted', {}, `Tried ${task.retryAttempts} times so far`),
      );
    }
    // An agent asking in its terminal gets an answer from here only for a question (askingKind): a
    // permission prompt, or one the office can't tell, is answered in its terminal.
    if (task.waitingReason === 'agent_asking' && task.askingKind !== 'question') {
      const workerId = task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
      const open = workerId && this.o.openTerminal ? h('button.btn.small', { type: 'button', onclick: () => this.o.openTerminal?.(workerId, task.project) }, '⌨️ Open its terminal') : null;
      const what = task.askingKind === 'permission' ? 'The agent asks for a permission — answer it in its terminal' : 'The agent waits on something in its terminal — answer it there';
      box.append(h('div.kb-row', {}, h('b', {}, what), open), h('small.kb-muted', {}, 'A comment waits until that turn is over.'));
      return box;
    }
    if (task.waitingReason === 'plan_questions' || task.waitingReason === 'agent_asking') {
      const asking = task.waitingReason === 'agent_asking';
      const fb = this.fileBox('answer', { rows: 4, placeholder: asking ? 'Your answer…' : 'Your answers… (paste or drop files)', 'aria-label': asking ? 'Answer the agent' : 'Answer' });
      const { ta, attach, wrap } = fb;
      const send = h('button.btn.primary', { type: 'button' }, 'Send the answer') as HTMLButtonElement;
      const go = async () => {
        const answer = ta.value.trim();
        const ids = attach.ids();
        if (!answer && !ids.length) return ta.focus();
        if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
        const ok = await this.req({ t: 'kanban.task.continue', id: task.id, answer, ...(ids.length ? { attachmentIds: ids } : {}) }, send, 'Answer sent');
        if (ok) {
          ta.value = '';
          attach.clear();
          this.drafts().delete('answer');
        }
      };
      send.addEventListener('click', () => void go());
      fb.go = () => void go();
      if (asking) {
        // The asking worker is the reviewer during a review round, else the implementer.
        const workerId = task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
        const open = workerId && this.o.openTerminal ? h('button.btn.small', { type: 'button', onclick: () => this.o.openTerminal?.(workerId, task.project) }, '⌨️ Open its terminal') : null;
        box.append(h('div.kb-row', {}, h('b', {}, 'Answer the agent'), h('small.kb-muted', {}, 'It is typed into its terminal, as if you typed it there.'), open));
      }
      wrap.replaceChildren(ta, h('div.kb-row', {}, attach.el, h('span.grow'), send), h('small.kb-muted', {}, sendHint()));
      box.append(wrap);
    }
    return box;
  }

  /** Tool, model and effort, changeable whenever no run is live (the office says no when it won't). */
  private agentEditor(task: KanbanTask): HTMLElement | null {
    if (isRunning(task) || task.status === 'archived') return null;
    const tool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, `${TOOL_ICON[x]} ${toolName(x)}`] as const), task.tool, { 'aria-label': 'Agent' });
    const model = modelInput(task.model ?? '', () => tool.value as KanbanTool);
    const effort = effortSelect(task.effort, 'Default');
    tool.addEventListener('change', () => {
      model.refresh();
      // Another tool's model name means nothing to this one.
      if (tool.value !== task.tool) model.input.value = '';
    });
    const save = h('button.btn.small.primary', { type: 'button' }, 'Save') as HTMLButtonElement;
    save.addEventListener('click', () => {
      const m = model.input.value.trim();
      void this.req({ t: 'kanban.task.update', id: task.id, patch: { tool: tool.value as KanbanTool, model: m || null, effort: (effort.value as KanbanEffort) || null } }, save, 'Agent changed');
    });
    const box = h('details.kb-agent-edit', { open: this.agentOpen }, h('summary', {}, '✏️ Change the agent'), h('small.kb-muted', {}, 'Who carries on from the next phase. Not while it runs.'), h('div.kb-row', {}, tool, model.el, effort, save)) as HTMLDetailsElement;
    box.addEventListener('toggle', () => (this.agentOpen = box.open));
    return box;
  }

  private async loadReports() {
    try {
      const r = await getJson<{ reports: KanbanReportFile[] }>(`/api/kanban/tasks/${this.taskId}/reports`);
      if (this.destroyed) return;
      const shown = this.reports?.shown ?? new Map<string, HTMLElement>();
      this.reports = { list: r.reports, shown };
    } catch {
      // Nothing to list (or an office without the plugin): the section stays away.
      if (!this.destroyed) this.reports = null;
    }
    if (this.current === 'overview' && !this.destroyed) this.paintBody();
  }

  /** An investigation's report files: shown in place (Markdown as the page renders it), or downloaded. */
  private reportsSection(): HTMLElement | null {
    const r = this.reports;
    if (!r?.list.length) return null;
    const url = (name: string) => `/api/kanban/tasks/${this.taskId}/reports/${encodeURIComponent(name)}`;
    const items = r.list.map((f) => {
      const shownEl = r.shown.get(f.name);
      const toggle = h('button.btn.small', { type: 'button', 'aria-expanded': String(!!shownEl) }, shownEl ? 'Hide' : 'Show') as HTMLButtonElement;
      toggle.addEventListener('click', async () => {
        if (r.shown.has(f.name)) {
          r.shown.delete(f.name);
          return this.paintBody();
        }
        toggle.disabled = true;
        try {
          const res = await fetch(url(f.name), { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
          const text = await res.text();
          r.shown.set(f.name, /\.(md|markdown)$/i.test(f.name) ? renderMarkdown(text, (id) => this.openTask(id), '') : h('pre', {}, text));
        } catch (err) {
          toast((err as Error).message, 'error');
        }
        this.paintBody();
      });
      return h(
        'li.kb-report',
        {},
        h('div.kb-row', {}, h('b', {}, `📄 ${f.name}`), h('small.kb-muted', { title: fmtTime(f.mtime) }, `${formatSize(f.size)} · ${timeAgo(f.mtime)}`), toggle, h('a.btn.small', { href: `${url(f.name)}?download=1`, download: f.name.split('/').pop() ?? f.name }, '⬇️ Download')),
        shownEl ?? null,
      );
    });
    return h('section', {}, h('h4', {}, '📑 Reports'), h('ul.kb-reports', {}, ...items));
  }

  private overview(d: Detail): HTMLElement[] {
    const task = d.task;
    const project = this.projectOf(task.project);
    const repos = cardRepoNames(task, project);
    const review = this.reviewSettings(task);
    const open = (id: number) => this.openTask(id);
    const rows: [string, Node | string | null | undefined][] = [
      ['Project', project?.name ?? task.project],
      ['Repositories', repos.length ? h('span.kb-chips', {}, ...repos.map((r) => h('span.kb-chip.repo', {}, `📦 ${r}`))) : null],
      ['Ticket', task.ticket ? ticketChip(task.ticket, task.ticketUrl) : null],
      ['Type', TYPE_NAMES[task.type]],
      ['Agent', `${TOOL_ICON[task.tool]} ${toolName(task.tool)}${task.model ? ` · ${task.model}` : ''}${task.effort ? ` · ${effortName(task.effort)}` : ''}`],
      ['Plan', task.usePlan ? `on · ${APPROVAL_NAMES[task.planApproval]}` : 'off'],
      [
        'Review',
        task.useReview
          ? `on · ${review.tool ? toolName(review.tool) : ''}${review.model ? ` ${review.model}` : ''} · ${review.rounds} rounds${task.reviewRound ? ` · round ${task.reviewRound}` : ''}`
          : 'off',
      ],
      ['Branch', task.branch ? h('code', {}, task.branch) : null],
      ['Workspace', task.workspace ? h('code', { title: task.workspace.worktree.path }, task.workspace.worktree.path) : null],
      ['Created', `${task.createdBy} · ${fmtTime(task.createdAt)}`],
      ['Started', task.startedAt ? fmtTime(task.startedAt) : null],
      ['Finished', task.finishedAt ? fmtTime(task.finishedAt) : null],
      ['Tags', task.tags.length ? task.tags.map((x) => `#${x}`).join(' ') : null],
      ['Comments waiting for the agent', task.pendingMessages.length ? String(task.pendingMessages.length) : null],
      ['From ai-kanban', task.legacy ? `${task.legacy.source} #${task.legacy.id}` : null],
    ];
    const meta = h('dl.kb-meta', {}, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v as Node | string)]));
    const files = d.attachments.filter((a) => !a.commentId);
    const none = () => h('span.hidden');
    return [
      this.actionButtons(task),
      this.waitingBox(task) ?? none(),
      task.summary ? h('section.kb-summary', {}, h('h4', {}, 'Summary'), renderMarkdown(task.summary, open, '')) : none(),
      h('section.kb-desc', {}, h('h4', {}, 'Description', task.flags.descriptionLocked ? h('small.kb-muted', { title: 'The task has started: add to it with a comment instead' }, ' 🔒 locked') : null), renderMarkdown(task.description, open)),
      task.goal ? h('section.kb-goal', {}, h('h4', {}, '🎯 Acceptance criteria'), renderMarkdown(task.goal, open, '')) : none(),
      this.reportsSection() ?? none(),
      files.length ? h('section', {}, h('h4', {}, '📎 Attachments'), attachmentList(files)) : none(),
      h('section', {}, h('h4', {}, 'Details'), meta, this.agentEditor(task)),
    ];
  }

  // --- Conversation -----------------------------------------------------------------------------

  private makeComposer(task: KanbanTask) {
    const ta = textArea('', { rows: 3, placeholder: 'Write a comment, answer, or tell the agent what to do next… (paste or drop files)', 'aria-label': 'Comment', 'data-focus': 'comment' });
    const send = h('button.btn.primary', { type: 'button' }, 'Send') as HTMLButtonElement;
    const hint = h('small.kb-muted', {}, `${sendHint()} · ${task.status === 'todo' || task.status === 'done' ? 'a comment is kept with the task' : 'a comment puts the agent back to work'}`);
    const wrap = h('div.kb-composer');
    const attach = attachBox({ target: ta, dropZone: wrap, taskId: () => this.taskId, insertLinks: false });
    const go = async () => {
      const text = ta.value.trim();
      const ids = attach.ids();
      if (!text && !ids.length) return ta.focus();
      if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
      const ok = await this.req({ t: 'kanban.comment.add', id: task.id, text: text || '📎', ...(ids.length ? { attachmentIds: ids } : {}) }, send);
      if (ok) {
        ta.value = '';
        attach.clear();
      }
    };
    send.addEventListener('click', () => void go());
    onSendKey(ta, () => void go());
    wrap.append(ta, h('div.kb-row', {}, attach.el, h('span.grow'), send), hint);
    return { el: wrap, ta, attach };
  }

  private conversation(d: Detail): HTMLElement[] {
    this.composer ??= this.makeComposer(d.task);
    const byId = new Map(d.attachments.map((a) => [a.id, a]));
    const list = h('ol.kb-comments', { 'aria-label': 'Conversation' });
    for (const c of [...d.comments].reverse()) list.append(commentItem(c, byId, (id) => this.openTask(id)));
    if (!d.comments.length) list.append(h('li.kb-muted', {}, 'No comments yet.'));
    const more = d.commentsMore
      ? h('button.btn.kb-older', { type: 'button', disabled: this.loadingOlder, onclick: () => void this.older() }, this.loadingOlder ? 'Loading…' : 'Older comments')
      : null;
    return [this.composer.el, list, ...(more ? [more] : [])];
  }

  private async older() {
    const d = this.d;
    if (!d || this.loadingOlder) return;
    this.loadingOlder = true;
    this.paintBody();
    try {
      const r = await this.api.request<Extract<KanbanServerMsg, { t: 'kanban.comments' }>>({ t: 'kanban.comments.page', id: d.task.id, before: d.comments[0]?.id, limit: COMMENTS_PAGE });
      if (this.d === d) {
        const have = new Set(d.comments.map((c) => c.id));
        d.comments = [...r.comments.filter((c) => !have.has(c.id)), ...d.comments].sort((a, b) => a.id - b.id);
        d.commentsMore = r.more;
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      this.loadingOlder = false;
      if (!this.destroyed) this.paintBody();
    }
  }

  // --- Plan -------------------------------------------------------------------------------------

  private plans(d: Detail): HTMLElement[] {
    const task = d.task;
    const plans = [...d.plans].sort((a, b) => b.version - a.version);
    if (!plans.length) return [h('p.kb-muted', {}, task.usePlan ? 'No plan yet: it’s written when the task starts.' : 'This task runs without a plan.')];
    const latest = plans[0];
    const out: HTMLElement[] = [];
    if (latest.status === 'draft' && task.status === 'waiting' && !isRunning(task)) {
      const fb = this.fileBox('planChanges', { rows: 4, placeholder: 'What should change in the plan? (paste or drop files)', 'aria-label': 'Request changes' });
      const { ta, attach, wrap } = fb;
      const approve = h('button.btn.primary', { type: 'button' }, '✅ Approve the plan') as HTMLButtonElement;
      const changes = h('button.btn', { type: 'button' }, '✍️ Request changes') as HTMLButtonElement;
      approve.addEventListener('click', () => void this.req({ t: 'kanban.plan.approve', id: task.id, planId: latest.id }, approve, 'Plan approved'));
      const go = async () => {
        const text = ta.value.trim();
        const ids = attach.ids();
        if (!text && !ids.length) return ta.focus();
        if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
        if (await this.req({ t: 'kanban.plan.requestChanges', id: task.id, text, ...(ids.length ? { attachmentIds: ids } : {}) }, changes, 'Sent to the planner')) {
          ta.value = '';
          attach.clear();
          this.drafts().delete('planChanges');
        }
      };
      changes.addEventListener('click', () => void go());
      fb.go = () => void go();
      wrap.replaceChildren(ta, h('div.kb-row', {}, attach.el, h('span.grow'), changes, approve));
      out.push(h('section.kb-plan-act', {}, h('h4', {}, `Plan v${latest.version} waits for you`), wrap));
    }
    for (const p of plans) out.push(planItem(p, (id) => this.openTask(id)));
    return out;
  }

  // --- Runs -------------------------------------------------------------------------------------

  private runs(d: Detail): HTMLElement[] {
    const runs = [...d.runs].sort((a, b) => b.startedAt - a.startedAt);
    const out: HTMLElement[] = [];
    out.push(runs.length ? h('ol.kb-runs', {}, ...runs.map((r) => runItem(r, (id) => this.openTask(id)))) : h('p.kb-muted', {}, 'Nothing has run yet.'));
    if (d.events.length) out.push(h('details.kb-events', {}, h('summary', {}, `History (${d.events.length})`), h('ul', {}, ...[...d.events].sort((a, b) => b.at - a.at).map(eventItem))));
    return out;
  }

  // --- Terminal & changes -----------------------------------------------------------------------

  private workers(task: KanbanTask): { id: string; role: 'implementer' | 'reviewer' }[] {
    return [
      ...(task.workerId ? [{ id: task.workerId, role: 'implementer' as const }] : []),
      ...(task.reviewerWorkerId ? [{ id: task.reviewerWorkerId, role: 'reviewer' as const }] : []),
    ];
  }

  /** A worker's line: its name and state when the page knows it (it's on the floor the page is on). */
  private workerLabel(id: string, role: KanbanRole, project: string): HTMLElement {
    const w = store.workers.get(id);
    return h(
      'div.kb-worker',
      {},
      h('span.dot', { style: `background:${w?.color ?? '#ccc'}` }),
      h('b', {}, w?.name ?? ROLE_NAMES[role]),
      h('small.kb-muted', {}, w ? `${ROLE_NAMES[role]} · ${w.status}` : store.floor === project ? 'That worker isn’t here any more' : 'on the project’s floor'),
    );
  }

  private terminal(task: KanbanTask): HTMLElement[] {
    const ws = this.workers(task);
    if (!ws.length) return [h('p.kb-muted', {}, 'No worker is on this task now. Starting it, a comment or an action hires one.')];
    return [
      h('p.kb-muted', {}, 'The worker’s live terminal, as at its desk: you can type in it too.'),
      ...ws.map((w) =>
        h(
          'div.kb-worker-row',
          {},
          this.workerLabel(w.id, w.role, task.project),
          this.o.openTerminal ? h('button.btn.primary', { type: 'button', onclick: () => this.o.openTerminal?.(w.id, task.project) }, '⌨️ Open the terminal') : null,
        ),
      ),
    ];
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

  // --- Pull requests ----------------------------------------------------------------------------

  /** 🛠️ Fix PRs, in the action bar and the PRs tab: only where there are open PRs to fix, greyed out (with why) while the task is busy. */
  private fixPrs(task: KanbanTask, bar: HTMLElement) {
    if (!openPrs(task).length || !prStatusOk(task.status)) return;
    const can = canFixPrs(task);
    const b = h('button.btn', { type: 'button', disabled: !can.ok, title: can.ok ? 'The agent addresses the review comments and failing checks on the task’s open PRs; it doesn’t merge' : can.reason, 'data-focus': 'act-fix-prs' }, '🛠️ Fix PRs') as HTMLButtonElement;
    b.addEventListener('click', () => void this.req({ t: 'kanban.task.pr', id: task.id, mode: 'fix' }, b, 'An agent is on the pull requests'));
    bar.append(b);
  }

  private prs(task: KanbanTask): HTMLElement[] {
    const project = this.projectOf(task.project);
    const out: HTMLElement[] = [];
    const running = isRunning(task);
    const bar = h('div.kb-actions');
    if (task.type === 'implement' && !running && (task.status === 'review' || task.status === 'waiting' || task.status === 'done')) {
      const create = h('button.btn.primary', { type: 'button', title: 'The agent pushes and opens (or updates) a pull request in every repository with commits' }, `🔀 ${task.prs.length ? 'Push & update PRs' : 'Create PRs'}`) as HTMLButtonElement;
      create.addEventListener('click', () => void this.req({ t: 'kanban.task.pr', id: task.id, mode: 'create' }, create, 'An agent is on the pull requests'));
      bar.append(create);
    }
    this.fixPrs(task, bar);
    const reviewable = task.prs.filter((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT'));
    if (reviewable.length) {
      const rev = h('button.btn', { type: 'button', title: 'One reviewer takes every pull request of the task at once' }, `🔍 Review these ${reviewable.length} PRs together`) as HTMLButtonElement;
      rev.addEventListener('click', async () => {
        const ok = await this.req({ t: 'kanban.pr.review', project: task.project, taskId: task.id, prs: reviewable.map((p) => ({ repo: p.repo!, number: p.number })) }, rev, 'A reviewer takes the PRs together');
        // The review runs as a task: another one than this, when the office made a new one.
        if (ok?.taskId && ok.taskId !== task.id) this.openTask(ok.taskId);
      });
      bar.append(rev);
    }
    if (bar.childElementCount) out.push(bar);
    if (!task.prs.length) out.push(h('p.kb-muted', {}, 'No pull requests yet.'));
    else
      out.push(
        h(
          'table.kb-table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', {}, 'PR'), h('th', {}, 'State'), h('th', {}, 'Branch'), h('th', {}, 'Updated'))),
          h(
            'tbody',
            {},
            ...task.prs.map((p) =>
              h(
                'tr',
                {},
                h('td', {}, project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId),
                h('td', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, `#${p.number} ↗`)),
                h('td', {}, h('span.kb-pr', { class: prTone(p.state) }, PR_STATE_NAMES[prTone(p.state)])),
                h('td', {}, p.branch ? h('code', {}, p.branch) : ''),
                h('td', {}, timeAgo(p.updatedAt)),
              ),
            ),
          ),
        ),
      );
    return out;
  }
}

// --- Pieces ---------------------------------------------------------------------------------------

function attachmentList(files: KanbanAttachment[]): HTMLElement {
  return h(
    'ul.kb-files',
    {},
    ...files.map((a) =>
      h(
        'li',
        {},
        isImage(a.mime) ? h('a.kb-thumb', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: attachmentUrl(a.id), alt: a.name, loading: 'lazy' })) : null,
        h('a', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer' }, `📄 ${a.name}`),
        h('small.kb-muted', {}, formatSize(a.size)),
      ),
    ),
  );
}

function commentItem(c: KanbanComment, files: Map<string, KanbanAttachment>, openTask: (id: number) => void): HTMLElement {
  const who = c.authorKind === 'agent' ? `${c.tool ? `${TOOL_ICON[c.tool]} ` : '🤖 '}${c.authorName}` : c.authorKind === 'system' ? `⚙️ ${c.authorName}` : `👤 ${c.authorName}`;
  const attached = c.attachmentIds.map((id) => files.get(id)).filter((a): a is KanbanAttachment => !!a);
  return h(
    'li.kb-comment',
    { class: `${c.authorKind} ${c.kind}${c.pending ? ' pending' : ''}` },
    h(
      'header',
      {},
      h('b', {}, who),
      c.kind !== 'message' ? h('span.kb-kind', { class: c.kind }, COMMENT_KIND_NAMES[c.kind]) : null,
      c.pending ? h('span.kb-kind.pending', { title: 'Written while the agent was busy: it gets it at its next pause' }, 'waiting') : null,
      h('time', { datetime: new Date(c.createdAt).toISOString(), title: fmtTime(c.createdAt) }, timeAgo(c.createdAt)),
    ),
    // System lines are short and many: plain text keeps them quiet.
    c.authorKind === 'system' && c.kind === 'status' ? h('p', {}, c.text) : renderMarkdown(c.text, openTask, ''),
    attached.length ? attachmentList(attached) : null,
  );
}

function planItem(p: KanbanPlan, openTask: (id: number) => void): HTMLElement {
  return h(
    'details.kb-plan',
    { class: p.status, open: p.status !== 'superseded' },
    h(
      'summary',
      {},
      h('b', {}, `Version ${p.version}`),
      h('span.kb-plan-status', { class: p.status }, PLAN_STATUS_NAMES[p.status]),
      h('small.kb-muted', {}, p.acceptedAt ? `accepted by ${p.acceptedBy ?? ''}, ${fmtTime(p.acceptedAt)}` : fmtTime(p.createdAt)),
    ),
    p.feedback ? h('blockquote.kb-feedback', {}, h('b', {}, 'Asked to change: '), p.feedback) : null,
    renderMarkdown(p.text, openTask),
  );
}

function runItem(r: KanbanRun, openTask: (id: number) => void): HTMLElement {
  const took = r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : '';
  return h(
    'li.kb-run',
    { class: `${r.status}${r.verdict ? ` ${r.verdict}` : ''}` },
    h(
      'header',
      {},
      h('span.kb-phase', { class: r.phase }, `${phaseName(r.phase)}${r.round ? ` ${r.round}` : ''}`),
      h('span', {}, `${TOOL_ICON[r.tool]} ${toolName(r.tool)}${r.model ? ` · ${r.model}` : ''}${r.effort ? ` · ${effortName(r.effort)}` : ''}`),
      h('span.kb-run-status', { class: r.status }, RUN_STATUS_NAMES[r.status]),
      r.verdict ? h('span.kb-verdict', { class: r.verdict }, VERDICT_NAMES[r.verdict]) : null,
      h('small.kb-muted', {}, `${fmtTime(r.startedAt)}${took ? ` · ${took}` : ''}`),
    ),
    r.error ? h('p.kb-error', {}, r.error) : null,
    r.summary ? h('details', {}, h('summary', {}, 'Summary'), renderMarkdown(r.summary, openTask, '')) : null,
  );
}

function eventItem(e: KanbanEvent): HTMLElement {
  return h('li', {}, h('time', {}, fmtTime(e.at)), ' ', h('code', {}, e.kind), e.data !== undefined ? h('small.kb-muted', {}, ` ${JSON.stringify(e.data).slice(0, 200)}`) : null);
}
