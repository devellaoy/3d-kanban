// A task in full, in a panel down the right of the board (the whole screen on a phone), dragged wider
// or narrower by its left edge. Tabs: Overview (the description, what it is and what can be done with
// it now), Conversation (write at the top, newest first), Plan (its versions), Runs (every phase it
// ran), Terminal and Changes (upstream's windows, for the task's workers) and PRs.

import { h, toast } from '../ui/dom';
import { store } from '../state';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanAttachment, KanbanComment, KanbanEvent, KanbanPlan, KanbanRun, KanbanTask, TaskStatus } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import type { KanbanApi, KanbanOk } from './api';
import { attachmentUrl, formatSize, isImage } from './attach';
import { attachBox, type AttachBox } from './attachbox';
import { TOOL_ICON, ticketChip } from './card';
import { renderMarkdown } from './md';
import { REVIEW_DEFAULTS } from './defaults';
import { cardRepoNames, countdown, needsAttention, phaseBadge, prTone } from './model';
import { kstore } from './store';
import { columnName, countdownUnits, effortName, fmtAgo, fmtDuration, fmtTime, phaseName, t, toolName, waitingName, type Key } from './i18n';
import { confirmBox, run, tabStrip, textArea } from './ui';

export type DetailTab = 'overview' | 'conversation' | 'plan' | 'runs' | 'terminal' | 'changes' | 'prs';
const TABS: readonly DetailTab[] = ['overview', 'conversation', 'plan', 'runs', 'terminal', 'changes', 'prs'];
const COMMENTS_PAGE = 30;
const WIDTH_KEY = 'kanban.detailWidth';

type Detail = Extract<KanbanServerMsg, { t: 'kanban.task.detail' }>;

export interface DetailOptions {
  api: KanbanApi;
  root: HTMLElement;
  /** Opens another task (a #123 link). */
  openTask(id: number): void;
  closed(): void;
  edit(task: KanbanTask): void;
  moveMenu(id: number): void;
  openTerminal(workerId: string, project: string): void;
  openChanges(workerId: string, project: string, repo?: string): void;
}

export class DetailPanel {
  private taskId: number | null = null;
  private d: Detail | null = null;
  private error = '';
  private tab: DetailTab = 'overview';
  private composer: { el: HTMLElement; ta: HTMLTextAreaElement; attach: AttachBox } | null = null;
  private loadingOlder = false;
  private refetch: ReturnType<typeof setTimeout> | undefined;
  private body = h('div.kb-detail-body', { role: 'tabpanel' });
  /** What's typed in the answer and plan boxes, kept across redraws (a card's change redraws the panel). */
  private drafts = new Map<string, string>();
  private strip: ReturnType<typeof tabStrip<DetailTab>> | null = null;

  constructor(private o: DetailOptions) {
    this.resizable();
  }

  get id(): number | null {
    return this.taskId;
  }

  open(id: number, tab?: DetailTab) {
    if (this.taskId !== id) {
      this.taskId = id;
      this.d = null;
      this.error = '';
      this.composer = null;
      this.drafts.clear();
      this.tab = tab ?? 'overview';
    } else if (tab) this.tab = tab;
    this.o.root.classList.remove('hidden');
    document.body.classList.add('kb-detail-open');
    this.render();
    void this.load();
    setTimeout(() => this.o.root.querySelector<HTMLElement>('.kb-tab.on')?.focus({ preventScroll: true }), 30);
  }

  close() {
    if (this.taskId === null) return;
    this.taskId = null;
    this.d = null;
    this.composer = null;
    this.o.root.classList.add('hidden');
    document.body.classList.remove('kb-detail-open');
    this.o.root.replaceChildren();
    this.o.closed();
  }

  private async load() {
    const id = this.taskId;
    if (id === null) return;
    try {
      const d = await this.o.api.request<Detail>({ t: 'kanban.task.get', id, comments: COMMENTS_PAGE });
      if (this.taskId !== id) return;
      // Older pages already loaded stay, under the fresh newest page.
      const prev = this.d;
      const older = prev ? prev.comments.filter((c) => c.id < (d.comments[0]?.id ?? Infinity)) : [];
      this.d = { ...d, comments: [...older, ...d.comments], commentsMore: older.length && prev ? prev.commentsMore : d.commentsMore };
      this.error = '';
    } catch (err) {
      if (this.taskId !== id) return;
      this.error = (err as Error).message;
    }
    this.render();
  }

  /** A card changed: its detail is fetched again (a moment later, so a burst of changes is one fetch). */
  cardChanged(id: number) {
    if (id !== this.taskId) return;
    clearTimeout(this.refetch);
    this.refetch = setTimeout(() => void this.load(), 250);
  }

  removed(id: number) {
    if (id !== this.taskId) return;
    toast(t('taskRemoved', { id }), 'warn');
    this.close();
  }

  /** The detail's own deltas: comments, runs and plans of the open task. */
  apply(msg: KanbanServerMsg) {
    const d = this.d;
    if (!d) return;
    const replace = <T extends { id: number }>(list: T[], item: T) => {
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item;
      else list.push(item);
    };
    if (msg.t === 'kanban.comment' && msg.comment.taskId === d.task.id) {
      replace(d.comments, msg.comment);
      d.comments.sort((a, b) => a.id - b.id);
    } else if (msg.t === 'kanban.run' && msg.run.taskId === d.task.id) replace(d.runs, msg.run);
    else if (msg.t === 'kanban.plan' && msg.plan.taskId === d.task.id) replace(d.plans, msg.plan);
    else return;
    this.render();
  }

  // --- Frame ------------------------------------------------------------------------------------

  render() {
    const id = this.taskId;
    if (id === null) return;
    const restore = this.focusMark();
    const card = kstore.tasks.get(id);
    const task = this.d?.task;
    const title = task?.title ?? card?.title ?? '';
    const status: TaskStatus | undefined = task?.status ?? card?.status;
    const close = h('button.btn.close', { type: 'button', 'aria-label': t('close'), title: t('closeEsc') }, '✕');
    close.addEventListener('click', () => this.close());
    const running = task ? isRunning(task) : card ? isRunning(card) : false;
    const badge = card ? phaseBadge(card) : null;
    const head = h(
      'header.kb-detail-head',
      {},
      h(
        'div.kb-detail-title',
        {},
        h('span.kb-id', {}, `#${id}`),
        h('h2', { id: 'kb-detail-h' }, title || t('loading')),
      ),
      h(
        'div.kb-detail-sub',
        {},
        status ? h('span.kb-status', { class: status }, columnName(status)) : null,
        running ? h('span.kb-pulse', { title: t('running') }) : null,
        badge ? h('span.kb-phase', { class: badge.phase }, `${phaseName(badge.phase)}${badge.round ? ` ${badge.round}` : ''}`) : null,
        card?.waitingReason && card.status === 'waiting' ? h('span.kb-wait-pill', { class: needsAttention(card) ? 'attention' : '' }, waitingName(card.waitingReason)) : null,
      ),
      close,
    );
    const counts: Partial<Record<DetailTab, number>> = this.d
      ? { conversation: card?.commentCount ?? this.d.comments.length, plan: this.d.plans.length, runs: this.d.runs.length, prs: this.d.task.prs.length }
      : {};
    this.strip = tabStrip(
      TABS.map((tab) => ({ id: tab, label: h('span', {}, t(`tab.${tab}`), counts[tab] ? h('span.kb-tab-n', {}, String(counts[tab])) : null) })),
      this.tab,
      (tab) => {
        this.tab = tab;
        this.paintBody();
      },
      t('taskDetail'),
    );
    this.o.root.setAttribute('aria-labelledby', 'kb-detail-h');
    this.o.root.replaceChildren(h('div.kb-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('resizePanel'), tabindex: 0 }), head, this.strip.el, this.body);
    this.paintBody();
    restore();
  }

  /**
   * Notes which box has the focus (by its data-focus) and where its caret is, and returns how to put
   * them back after a redraw, so a delta arriving mid-sentence doesn't take the keyboard away.
   */
  private focusMark(): () => void {
    const el = document.activeElement as HTMLElement | null;
    const key = el && this.o.root.contains(el) ? el.dataset.focus : undefined;
    if (!key) return () => {};
    const sel = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd] : null;
    return () => {
      const again = this.o.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
      if (!again || again === document.activeElement) return;
      again.focus({ preventScroll: true });
      if (sel && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)) again.setSelectionRange(sel[0], sel[1]);
    };
  }

  /** A text box whose text outlives the panel's redraws. */
  private draftArea(key: string, attrs: Record<string, string | number>): HTMLTextAreaElement {
    const ta = textArea(this.drafts.get(key) ?? '', { ...attrs, 'data-focus': key });
    ta.addEventListener('input', () => this.drafts.set(key, ta.value));
    return ta;
  }

  /** The floor's workers changed: only the tabs that show them are redrawn. */
  workersChanged() {
    if (this.taskId === null || (this.tab !== 'terminal' && this.tab !== 'changes')) return;
    const restore = this.focusMark();
    this.paintBody();
    restore();
  }

  private paintBody() {
    const scroll = this.body.scrollTop;
    const keep = this.body.dataset.tab === this.tab;
    this.body.dataset.tab = this.tab;
    this.body.setAttribute('aria-labelledby', `kbtab-${this.tab}`);
    const d = this.d;
    if (!d) {
      this.body.replaceChildren(this.error ? h('div.kb-error', {}, `⚠️ ${this.error}`, h('button.btn.small', { type: 'button', onclick: () => void this.load() }, t('tryAgain'))) : h('p.kb-muted', {}, t('loading')));
      return;
    }
    const content: Record<DetailTab, () => HTMLElement[]> = {
      overview: () => this.overview(d),
      conversation: () => this.conversation(d),
      plan: () => this.plans(d),
      runs: () => this.runs(d),
      terminal: () => this.terminal(d.task),
      changes: () => this.changes(d.task),
      prs: () => this.prs(d.task),
    };
    this.body.replaceChildren(...content[this.tab]());
    if (keep) this.body.scrollTop = scroll;
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

  // --- Overview ---------------------------------------------------------------------------------

  private req(msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: Key) {
    return run(() => this.o.api.request<KanbanOk>(msg), button, done);
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
    if (task.status === 'todo') {
      add(`▶️ ${t('act.start')}`, '.primary', (b) => void this.req({ t: 'kanban.task.start', id }, b, 'started'));
      add(`✏️ ${t('act.edit')}`, '', () => this.o.edit(task));
    }
    if (running) add(`⏹️ ${t('act.stop')}`, '.danger', (b) => void this.req({ t: 'kanban.task.stop', id }, b, 'stopping'));
    if (task.status === 'waiting' && !running) {
      switch (task.waitingReason) {
        case 'plan_approval':
          add(`✅ ${t('act.approvePlan')}`, '.primary', (b) => void this.req({ t: 'kanban.plan.approve', id }, b, 'planApproved'));
          add(`✍️ ${t('act.requestChanges')}`, '', () => {
            this.tab = 'plan';
            this.strip?.set('plan');
            this.paintBody();
          });
          break;
        case 'usage_limit':
          add(`🔁 ${t('act.retryNow')}`, '.primary', (b) => void this.req({ t: 'kanban.task.retry', id }, b, 'retrying'));
          break;
        case 'failed':
        case 'interrupted':
          add(`🔁 ${t('act.retry')}`, '.primary', (b) => void this.req({ t: 'kanban.task.retry', id }, b, 'retrying'));
          add(`▶️ ${t('act.continue')}`, '', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'continuing'));
          break;
        case 'agent_asking':
          if (task.workerId) add(`⌨️ ${t('act.answerInTerminal')}`, '.primary', () => this.o.openTerminal(task.workerId!, task.project));
          add(`▶️ ${t('act.continue')}`, '', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'continuing'));
          break;
        case 'plan_questions':
          // Answered in the box above the actions.
          break;
        default:
          add(`▶️ ${t('act.continue')}`, '.primary', (b) => void this.req({ t: 'kanban.task.continue', id }, b, 'continuing'));
      }
    }
    if (task.status === 'review' && !running) {
      add(`🔍 ${t('act.reviewRound')}`, '', (b) => void this.req({ t: 'kanban.task.review', id }, b, 'reviewStarted'), t('act.reviewRoundHint'));
      if (task.type === 'implement') {
        if (task.prs.some((p) => p.state === 'OPEN' || p.state === 'DRAFT')) add(`🛠️ ${t('act.fixPr')}`, '', (b) => void this.req({ t: 'kanban.task.pr', id, mode: 'fix' }, b, 'prAsked'), t('act.fixPrHint'));
        add(`🔀 ${task.prs.length ? t('act.updatePr') : t('act.createPr')}`, '.primary', (b) => void this.req({ t: 'kanban.task.pr', id, mode: 'create' }, b, 'prAsked'), t('act.createPrHint'));
      }
    }
    if ((task.status === 'waiting' || task.status === 'review') && !running && task.sessionId) {
      add(`🗜️ ${t('act.compact')}`, '', (b) => void this.req({ t: 'kanban.task.compact', id }, b, 'compacting'), t('act.compactHint'));
    }
    if (hasWorker && !running) {
      add(`🏠 ${t('act.release')}`, '', (b) => confirmBox(t('act.release'), t('releaseConfirm', { id }), t('act.release'), () => void this.req({ t: 'kanban.task.release', id }, b, 'released'), false), t('act.releaseHint'));
    }
    if (task.status !== 'in_progress') add(`↔️ ${t('act.move')}`, '', () => this.o.moveMenu(id), t('moveHint'));
    if (!running) add(`🗑️ ${t('act.delete')}`, '.danger', (b) => confirmBox(t('deleteTitle', { id }), t('deleteConfirm'), t('act.delete'), () => void this.req({ t: 'kanban.task.delete', id }, b)));
    return bar;
  }

  /** What the task waits for, with a box to answer when it asked something. */
  private waitingBox(task: KanbanTask): HTMLElement | null {
    if (task.status !== 'waiting' || !task.waitingReason) return null;
    const box = h('section.kb-waiting', { class: task.waitingReason }, h('h4', {}, `🙋 ${waitingName(task.waitingReason)}`), task.waitingText ? renderMarkdown(task.waitingText, this.o.openTask, '') : null);
    if (task.retryAt) {
      box.append(
        h('p.kb-retry', { 'data-retry-at': String(task.retryAt) }, `🔁 ${t('retryIn', { time: countdown(task.retryAt, Date.now(), countdownUnits()) })}`),
        h('small.kb-muted', {}, t('retryAttempts', { n: task.retryAttempts })),
      );
    }
    if (task.waitingReason === 'plan_questions' || task.waitingReason === 'agent_asking') {
      const ta = this.draftArea('answer', { rows: 4, placeholder: t('answerPlaceholder'), 'aria-label': t('answer') });
      const send = h('button.btn.primary', { type: 'button' }, t('sendAnswer')) as HTMLButtonElement;
      const go = async () => {
        const answer = ta.value.trim();
        if (!answer) return ta.focus();
        const ok = await this.req({ t: 'kanban.task.continue', id: task.id, answer }, send, 'answerSent');
        if (ok) {
          ta.value = '';
          this.drafts.delete('answer');
        }
      };
      send.addEventListener('click', () => void go());
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void go();
        }
      });
      box.append(ta, h('div.kb-row', {}, h('small.kb-muted', {}, t('ctrlEnter')), send));
    }
    return box;
  }

  private overview(d: Detail): HTMLElement[] {
    const task = d.task;
    const project = kstore.projectOf(task.project);
    const repos = cardRepoNames(task, project);
    const review = { ...REVIEW_DEFAULTS, ...kstore.settings?.review, ...kstore.settings?.projects[task.project]?.review, ...task.overrides.review };
    const rows: [string, Node | string | null | undefined][] = [
      [t('project'), project?.name ?? task.project],
      [t('repositories'), repos.length ? h('span.kb-chips', {}, ...repos.map((r) => h('span.kb-chip.repo', {}, `📦 ${r}`))) : null],
      [t('ticket'), task.ticket ? ticketChip(task.ticket, task.ticketUrl) : null],
      [t('type'), t(`type.${task.type}`)],
      [t('agent'), `${TOOL_ICON[task.tool]} ${toolName(task.tool)}${task.model ? ` · ${task.model}` : ''}${task.effort ? ` · ${effortName(task.effort)}` : ''}`],
      [t('plan'), task.usePlan ? `${t('on')} · ${t(`approval.${task.planApproval}`)}` : t('off')],
      [
        t('review'),
        task.useReview
          ? `${t('on')} · ${review.tool ? toolName(review.tool) : ''}${review.model ? ` ${review.model}` : ''} · ${t('roundsN', { n: review.rounds })}${task.reviewRound ? ` · ${t('roundNow', { n: task.reviewRound })}` : ''}`
          : t('off'),
      ],
      [t('branch'), task.branch ? h('code', {}, task.branch) : null],
      [t('workspace'), task.workspace ? h('code', { title: task.workspace.worktree.path }, task.workspace.worktree.path) : null],
      [t('createdBy'), `${task.createdBy} · ${fmtTime(task.createdAt)}`],
      [t('started'), task.startedAt ? fmtTime(task.startedAt) : null],
      [t('finished'), task.finishedAt ? fmtTime(task.finishedAt) : null],
      [t('tags'), task.tags.length ? task.tags.map((x) => `#${x}`).join(' ') : null],
      [t('pendingMessages'), task.pendingMessages.length ? String(task.pendingMessages.length) : null],
      [t('migrated'), task.legacy ? `${task.legacy.source} #${task.legacy.id}` : null],
    ];
    const meta = h('dl.kb-meta', {}, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v as Node | string)]));
    const files = d.attachments.filter((a) => !a.commentId);
    return [
      this.actionButtons(task),
      this.waitingBox(task) ?? h('span.hidden'),
      task.summary ? h('section.kb-summary', {}, h('h4', {}, t('summary')), renderMarkdown(task.summary, this.o.openTask, '')) : h('span.hidden'),
      h('section.kb-desc', {}, h('h4', {}, t('description'), task.flags.descriptionLocked ? h('small.kb-muted', { title: t('descLockedHint') }, ` 🔒 ${t('locked')}`) : null), renderMarkdown(task.description, this.o.openTask)),
      task.goal ? h('section.kb-goal', {}, h('h4', {}, `🎯 ${t('goal')}`), renderMarkdown(task.goal, this.o.openTask, '')) : h('span.hidden'),
      files.length ? h('section', {}, h('h4', {}, `📎 ${t('attachments')}`), attachmentList(files)) : h('span.hidden'),
      h('section', {}, h('h4', {}, t('details')), meta),
    ];
  }

  // --- Conversation -----------------------------------------------------------------------------

  private makeComposer(task: KanbanTask) {
    const ta = textArea('', { rows: 3, placeholder: t('commentPlaceholder'), 'aria-label': t('comment'), 'data-focus': 'comment' });
    const send = h('button.btn.primary', { type: 'button' }, t('send')) as HTMLButtonElement;
    const hint = h('small.kb-muted', {}, `${t('ctrlEnter')} · ${task.status === 'todo' || task.status === 'done' ? t('commentNote') : t('commentResumes')}`);
    const wrap = h('div.kb-composer');
    const attach = attachBox({ target: ta, dropZone: wrap, taskId: () => this.taskId ?? undefined, insertLinks: false });
    const go = async () => {
      const text = ta.value.trim();
      const ids = attach.ids();
      if (!text && !ids.length) return ta.focus();
      if (attach.busy()) return toast(t('waitUploads'), 'warn');
      const ok = await this.req({ t: 'kanban.comment.add', id: task.id, text: text || '📎', ...(ids.length ? { attachmentIds: ids } : {}) }, send);
      if (ok) {
        ta.value = '';
        attach.clear();
      }
    };
    send.addEventListener('click', () => void go());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void go();
      }
    });
    wrap.append(ta, h('div.kb-row', {}, attach.el, h('span.grow'), send), hint);
    return { el: wrap, ta, attach };
  }

  private conversation(d: Detail): HTMLElement[] {
    this.composer ??= this.makeComposer(d.task);
    const byId = new Map(d.attachments.map((a) => [a.id, a]));
    const list = h('ol.kb-comments', { 'aria-label': t('tab.conversation') });
    for (const c of [...d.comments].reverse()) list.append(commentItem(c, byId, this.o.openTask));
    if (!d.comments.length) list.append(h('li.kb-muted', {}, t('noComments')));
    const more = d.commentsMore
      ? h('button.btn.kb-older', { type: 'button', disabled: this.loadingOlder, onclick: () => void this.older() }, this.loadingOlder ? t('loading') : t('olderComments'))
      : null;
    return [this.composer.el, list, ...(more ? [more] : [])];
  }

  private async older() {
    const d = this.d;
    if (!d || this.loadingOlder) return;
    this.loadingOlder = true;
    this.paintBody();
    try {
      const r = await this.o.api.request<Extract<KanbanServerMsg, { t: 'kanban.comments' }>>({ t: 'kanban.comments.page', id: d.task.id, before: d.comments[0]?.id, limit: COMMENTS_PAGE });
      if (this.d === d) {
        const have = new Set(d.comments.map((c) => c.id));
        d.comments = [...r.comments.filter((c) => !have.has(c.id)), ...d.comments].sort((a, b) => a.id - b.id);
        d.commentsMore = r.more;
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      this.loadingOlder = false;
      this.paintBody();
    }
  }

  // --- Plan -------------------------------------------------------------------------------------

  private plans(d: Detail): HTMLElement[] {
    const task = d.task;
    const plans = [...d.plans].sort((a, b) => b.version - a.version);
    if (!plans.length) return [h('p.kb-muted', {}, task.usePlan ? t('noPlanYet') : t('planOff'))];
    const latest = plans[0];
    const out: HTMLElement[] = [];
    if (latest.status === 'draft' && task.status === 'waiting' && !isRunning(task)) {
      const ta = this.draftArea('planChanges', { rows: 4, placeholder: t('changesPlaceholder'), 'aria-label': t('act.requestChanges') });
      const approve = h('button.btn.primary', { type: 'button' }, `✅ ${t('act.approvePlan')}`) as HTMLButtonElement;
      const changes = h('button.btn', { type: 'button' }, `✍️ ${t('act.requestChanges')}`) as HTMLButtonElement;
      approve.addEventListener('click', () => void this.req({ t: 'kanban.plan.approve', id: task.id, planId: latest.id }, approve, 'planApproved'));
      changes.addEventListener('click', async () => {
        const text = ta.value.trim();
        if (!text) return ta.focus();
        if (await this.req({ t: 'kanban.plan.requestChanges', id: task.id, text }, changes, 'changesAsked')) {
          ta.value = '';
          this.drafts.delete('planChanges');
        }
      });
      out.push(h('section.kb-plan-act', {}, h('h4', {}, t('planDecide', { v: latest.version })), ta, h('div.kb-row', {}, h('span.grow'), changes, approve)));
    }
    for (const p of plans) out.push(planItem(p, this.o.openTask));
    return out;
  }

  // --- Runs -------------------------------------------------------------------------------------

  private runs(d: Detail): HTMLElement[] {
    const runs = [...d.runs].sort((a, b) => b.startedAt - a.startedAt);
    const out: HTMLElement[] = [];
    out.push(runs.length ? h('ol.kb-runs', {}, ...runs.map((r) => runItem(r, this.o.openTask))) : h('p.kb-muted', {}, t('noRuns')));
    if (d.events.length) out.push(h('details.kb-events', {}, h('summary', {}, t('history', { n: d.events.length })), h('ul', {}, ...[...d.events].sort((a, b) => b.at - a.at).map(eventItem))));
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
  private workerLabel(id: string, role: 'implementer' | 'reviewer', project: string): HTMLElement {
    const w = store.workers.get(id);
    return h(
      'div.kb-worker',
      {},
      h('span.dot', { style: `background:${w?.color ?? '#ccc'}` }),
      h('b', {}, w?.name ?? t(`role.${role}`)),
      h('small.kb-muted', {}, w ? `${t(`role.${role}`)} · ${w.status}` : store.floor === project ? t('workerGone') : t('onItsFloor')),
    );
  }

  private terminal(task: KanbanTask): HTMLElement[] {
    const ws = this.workers(task);
    if (!ws.length) return [h('p.kb-muted', {}, t('noWorker'))];
    return [
      h('p.kb-muted', {}, t('terminalHint')),
      ...ws.map((w) =>
        h('div.kb-worker-row', {}, this.workerLabel(w.id, w.role, task.project), h('button.btn.primary', { type: 'button', onclick: () => this.o.openTerminal(w.id, task.project) }, `⌨️ ${t('openTerminal')}`)),
      ),
    ];
  }

  private changes(task: KanbanTask): HTMLElement[] {
    if (!task.workerId) return [h('p.kb-muted', {}, t('noWorkerChanges'))];
    const project = kstore.projectOf(task.project);
    const primary = project?.repos.find((r) => r.primary)?.name ?? project?.name ?? task.project;
    const repos: { label: string; repo?: string }[] = [{ label: primary }];
    // The project's other repositories in the workspace: upstream's Changes window has a tab for each.
    const others = store.workers.get(task.workerId)?.repos ?? task.workspace?.repos ?? [];
    for (const r of others) repos.push({ label: r.name, repo: r.floor });
    return [
      h('p.kb-muted', {}, t('changesHint')),
      h(
        'div.kb-repo-buttons',
        {},
        ...repos.map((r) => h('button.btn', { type: 'button', onclick: () => this.o.openChanges(task.workerId!, task.project, r.repo) }, `🌿 ${r.label}`)),
      ),
    ];
  }

  // --- Pull requests ----------------------------------------------------------------------------

  private prs(task: KanbanTask): HTMLElement[] {
    const project = kstore.projectOf(task.project);
    const out: HTMLElement[] = [];
    const running = isRunning(task);
    const bar = h('div.kb-actions');
    if (task.type === 'implement' && !running && (task.status === 'review' || task.status === 'waiting' || task.status === 'done')) {
      const create = h('button.btn.primary', { type: 'button', title: t('act.createPrHint') }, `🔀 ${task.prs.length ? t('act.updatePr') : t('act.createPr')}`) as HTMLButtonElement;
      create.addEventListener('click', () => void this.req({ t: 'kanban.task.pr', id: task.id, mode: 'create' }, create, 'prAsked'));
      bar.append(create);
      if (task.prs.length) {
        const fix = h('button.btn', { type: 'button', title: t('act.fixPrHint') }, `🛠️ ${t('act.fixPr')}`) as HTMLButtonElement;
        fix.addEventListener('click', () => void this.req({ t: 'kanban.task.pr', id: task.id, mode: 'fix' }, fix, 'prAsked'));
        bar.append(fix);
      }
    }
    const reviewable = task.prs.filter((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT'));
    if (reviewable.length) {
      const rev = h('button.btn', { type: 'button', title: t('reviewTogetherHint') }, `🔍 ${t('reviewTogether', { n: reviewable.length })}`) as HTMLButtonElement;
      rev.addEventListener('click', async () => {
        const ok = await this.req({ t: 'kanban.pr.review', project: task.project, taskId: task.id, prs: reviewable.map((p) => ({ repo: p.repo!, number: p.number })) }, rev, 'prReviewStarted');
        // The review runs as a task: another one than this, when the office made a new one.
        if (ok?.taskId && ok.taskId !== task.id) this.o.openTask(ok.taskId);
      });
      bar.append(rev);
    }
    if (bar.childElementCount) out.push(bar);
    if (!task.prs.length) out.push(h('p.kb-muted', {}, t('noPrs')));
    else
      out.push(
        h(
          'table.kb-table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, t('repository')), h('th', {}, 'PR'), h('th', {}, t('state')), h('th', {}, t('branch')), h('th', {}, t('updated')))),
          h(
            'tbody',
            {},
            ...task.prs.map((p) =>
              h(
                'tr',
                {},
                h('td', {}, project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId),
                h('td', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, `#${p.number} ↗`)),
                h('td', {}, h('span.kb-pr', { class: prTone(p.state) }, t(`pr.${prTone(p.state)}`))),
                h('td', {}, p.branch ? h('code', {}, p.branch) : ''),
                h('td', {}, fmtAgo(p.updatedAt)),
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
      c.kind !== 'message' ? h('span.kb-kind', { class: c.kind }, t(`kind.${c.kind}`)) : null,
      c.pending ? h('span.kb-kind.pending', { title: t('pendingHint') }, t('pending')) : null,
      h('time', { datetime: new Date(c.createdAt).toISOString(), title: fmtTime(c.createdAt) }, fmtAgo(c.createdAt)),
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
      h('b', {}, t('planVersion', { v: p.version })),
      h('span.kb-plan-status', { class: p.status }, t(`planStatus.${p.status}`)),
      h('small.kb-muted', {}, p.acceptedAt ? t('acceptedBy', { who: p.acceptedBy ?? '', when: fmtTime(p.acceptedAt) }) : fmtTime(p.createdAt)),
    ),
    p.feedback ? h('blockquote.kb-feedback', {}, h('b', {}, `${t('feedback')}: `), p.feedback) : null,
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
      h('span.kb-run-status', { class: r.status }, t(`runStatus.${r.status}`)),
      r.verdict ? h('span.kb-verdict', { class: r.verdict }, t(`verdict.${r.verdict}`)) : null,
      h('small.kb-muted', {}, `${fmtTime(r.startedAt)}${took ? ` · ${took}` : ''}`),
    ),
    r.error ? h('p.kb-error', {}, r.error) : null,
    r.summary ? h('details', {}, h('summary', {}, t('summary')), renderMarkdown(r.summary, openTask, '')) : null,
  );
}

function eventItem(e: KanbanEvent): HTMLElement {
  return h('li', {}, h('time', {}, fmtTime(e.at)), ' ', h('code', {}, e.kind), e.data !== undefined ? h('small.kb-muted', {}, ` ${JSON.stringify(e.data).slice(0, 200)}`) : null);
}

/** The detail tabs, for the deep link. */
export function isDetailTab(v: unknown): v is DetailTab {
  return typeof v === 'string' && (TABS as readonly string[]).includes(v);
}
