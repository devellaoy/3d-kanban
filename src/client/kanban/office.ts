// The kanban as the 3D office (and the 2D view) shows it, worked out without the DOM: what the card
// over a task worker's head says, whether it waits on someone, what sending it home does to its task
// by default, where J goes, the office's deep link (`/?floor=…&worker=…`), and the kanban.task.create
// a hire or an issue card makes. The server keeps WorkerInfo.kanban current with the task's summary
// (docs/kanban-architecture.md), so none of this needs a kanban subscription. Kept pure so
// tests/kanban-ui-office*.test.ts can run it.

import type { AgentEffort, AgentProvider, WorkerInfo, WorkerTask } from '../../shared/protocol';
import type { KanbanClientMsg, KanbanTaskInput } from '../../shared/kanban/protocol.js';
import { KANBAN_LIMITS, PROJECT_ID_RE } from '../../shared/kanban/protocol.js';
import type { KanbanEffort, KanbanTaskCard, KanbanTool, KanbanWorkerSummary, PlanApproval, RunPhase, TaskStatus, TaskType, WaitingReason } from '../../shared/kanban/types.js';

/** What a task worker says about its task (WorkerInfo.kanban): the server keeps the summary current. */
export type WorkerKanban = KanbanWorkerSummary;

export function kanbanOf(w: Pick<WorkerInfo, 'kanban'>): WorkerKanban | undefined {
  return w.kanban;
}

export const STATUS_TEXT: Record<TaskStatus, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  waiting: 'waiting',
  review: 'in review',
  on_hold: 'on hold',
  done: 'done',
  archived: 'archived',
};

export const PHASE_TEXT: Record<RunPhase, string> = {
  plan: 'planning',
  implement: 'implementing',
  review: 'review',
  fix: 'fixing',
  resume: 'working',
  pr: 'opening PRs',
  'pr-fix': 'fixing PRs',
  compact: 'compacting',
  'pr-review': 'reviewing PRs',
};

/** Why it waits, said so you know what to do about it. */
export const WAITING_TEXT: Record<WaitingReason, string> = {
  plan_questions: '🙋 the plan has questions for you',
  plan_approval: '✅ the plan waits for your approval',
  agent_asking: '🙋 asking in its terminal',
  stopped: '⏹️ stopped',
  failed: '⚠️ a phase failed: Retry in the kanban',
  usage_limit: '⏳ usage limit',
  interrupted: '⚠️ interrupted: Retry in the kanban',
};

/** The waits that need a person (a usage limit retries by itself). The kanban page's ATTENTION_REASONS. */
const ATTENTION: readonly WaitingReason[] = ['plan_questions', 'plan_approval', 'agent_asking', 'stopped', 'failed', 'interrupted'];

/** "4 min 05 s": how long until `at`. */
export function countdown(at: number, now: number): string {
  const left = Math.ceil((at - now) / 1000);
  if (left <= 0) return 'any moment';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

export function clipText(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * "review 2/3", "planning", "in review 3/3": the phase while a run is under way (or queued), else the
 * task's column; with the review round when the task is in one.
 */
export function phaseText(k: WorkerKanban): string {
  const live = !!k.phase && !!k.runState && k.runState !== 'idle';
  const text = k.runState === 'queued' ? '⏳ queued for a desk' : live ? (PHASE_TEXT[k.phase!] ?? k.phase!) : k.status ? STATUS_TEXT[k.status] : '';
  const inRound = live ? k.phase === 'review' || k.phase === 'fix' : k.status === 'review';
  const round = inRound && k.round ? ` ${k.round}/${Math.max(k.rounds ?? k.round, k.round)}` : '';
  return `${text}${round}`;
}

/** What it waits on, with the retry countdown; '' when it doesn't wait. */
export function waitText(k: WorkerKanban, now: number): string {
  if (k.retryAt && k.retryAt > 0) return `⏳ retries in ${countdown(k.retryAt, now)}`;
  if (k.status === 'waiting' && k.waitingReason) return WAITING_TEXT[k.waitingReason] ?? k.waitingReason;
  if (k.status === 'review') return '👀 ready for your review';
  if (k.status === 'on_hold') return '⏸️ on hold';
  return '';
}

/**
 * The card over a task worker's head: "🗂️ #14 · Fix the login" over "review 2/3 · 🙋 …". A reviewer is
 * "🔍 reviewing #14". Undefined for any other worker (upstream's card then).
 */
export function kanbanCard(w: Pick<WorkerInfo, 'kanban'>, now: number): WorkerTask | undefined {
  const k = kanbanOf(w);
  if (!k) return undefined;
  const title = k.title ? ` · ${clipText(k.title, 40)}` : '';
  const name = k.role === 'reviewer' ? `🔍 reviewing #${k.taskId}${title}` : `🗂️ #${k.taskId}${title}`;
  const summary = [phaseText(k), waitText(k, now)].filter(Boolean).join(' · ') || 'kanban task';
  return { name, summary };
}

/** The one-line chip for lists (the Workers panel, the 2D view, the queue board). */
export function kanbanChip(w: Pick<WorkerInfo, 'kanban'>, now: number): string {
  const card = kanbanCard(w, now);
  return card ? `${card.name} · ${card.summary}` : '';
}

/** The name over its head: "Ada · #14". */
export function workerLabel(w: Pick<WorkerInfo, 'name' | 'kanban'>): string {
  const k = kanbanOf(w);
  return k ? `${w.name} · #${k.taskId}` : w.name;
}

/**
 * Whether a task worker waits on someone, for N, the arrows and the count; undefined for any other
 * worker, and whenever the task says nothing (upstream's rule then). A task waiting on you (the plan's
 * questions or approval, a failed phase) keeps waiting until it's handled, not just until you looked;
 * one the engine is carrying on with (in progress, or retrying after a usage limit) doesn't, even
 * though its worker just finished a turn. It only ever narrows upstream's statuses, so a waiting
 * worker is still needs_input or done.
 */
export function taskWaiting(w: Pick<WorkerInfo, 'kanban' | 'status' | 'acked'>): boolean | undefined {
  const k = kanbanOf(w);
  if (!k?.status || (w.status !== 'done' && w.status !== 'needs_input')) return undefined;
  if (w.status === 'needs_input') return true;
  if (k.status === 'waiting') return !!k.waitingReason && ATTENTION.includes(k.waitingReason);
  if (k.status === 'review') return !w.acked;
  if (k.status === 'in_progress') return false;
  return undefined;
}

/**
 * Whether "Move task #14 to Done" starts ticked when its worker goes home: in review (the automation
 * is finished), yes; still going (to do, in progress, waiting, on hold), no. null: there's nothing to move
 * (done or archived already, or the office doesn't say).
 */
export function doneDefault(status: TaskStatus | undefined): boolean | null {
  if (status === 'review') return true;
  if (status === 'todo' || status === 'in_progress' || status === 'waiting' || status === 'on_hold') return false;
  return null;
}

/** Hired for a kanban task: the engine's createdBy is "<who started it> (kanban #14)". */
const KANBAN_BY = /^(.*) \(kanban #\d+\)$/;

/** Who started the task a worker was hired for, from its createdBy; undefined for any other hire. */
export function kanbanStarter(createdBy: string): string | undefined {
  return KANBAN_BY.exec(createdBy)?.[1];
}

// --- Where things go ------------------------------------------------------------------------------

/** J: the task of the worker you face in the kanban, on its conversation; else the board of the floor you're on. */
export function kanbanUrl(floor: string | null, w?: Pick<WorkerInfo, 'kanban'>): string {
  const q = new URLSearchParams();
  if (floor) q.set('project', floor);
  const k = w && kanbanOf(w);
  if (k) {
    q.set('task', String(k.taskId));
    q.set('tab', 'conversation');
  }
  const s = q.toString();
  return `/kanban${s ? `?${s}` : ''}`;
}

/**
 * The queue board's kanban tasks waiting their turn that no worker at a desk shows already (`seated`:
 * the task ids of the floor's task workers): a start queued for a slot, a desk or the worker limit, and
 * any later run queued the same way (a resume or fix whose task keeps its column, Waiting say).
 */
export function queuedKanbanTasks(cards: readonly KanbanTaskCard[], seated: ReadonlySet<number>): KanbanTaskCard[] {
  return cards.filter((c) => c.runState === 'queued' && !seated.has(c.id)).sort((a, b) => a.id - b.id);
}

/** The office's own deep link: onto a floor, at a worker's desk (the kanban's 📍 Show in 3D). */
export interface OfficeLink {
  floor: string;
  worker?: string;
  desk?: string;
}

const ID_RE = /^[\w-]{1,64}$/;

/** `?floor=api&worker=w-1&desk=d3`; null without a usable floor. */
export function parseOfficeLink(search: string): OfficeLink | null {
  const q = new URLSearchParams(search);
  const floor = q.get('floor') ?? '';
  if (!PROJECT_ID_RE.test(floor)) return null;
  const worker = q.get('worker') ?? '';
  const desk = q.get('desk') ?? '';
  return { floor, ...(ID_RE.test(worker) ? { worker } : {}), ...(ID_RE.test(desk) ? { desk } : {}) };
}

/** The page's query without the deep link (whatever else was there, like `3d`, stays). */
export function withoutOfficeLink(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of ['floor', 'worker', 'desk']) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The link to a worker's desk in the 3D office. */
export function officeLink(link: OfficeLink): string {
  const q = new URLSearchParams({ floor: link.floor });
  if (link.worker) q.set('worker', link.worker);
  if (link.desk) q.set('desk', link.desk);
  return `/?${q}`;
}

// --- Hiring as a kanban task ----------------------------------------------------------------------

/** Only Claude Code and Codex run the kanban process; other providers stay ordinary workers. */
export function kanbanTool(provider: AgentProvider | undefined): KanbanTool | undefined {
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

/** A task's title: the first non-empty line, at most 120 characters. */
export function titleFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** What the hire form's kanban fields hold. */
export interface HireTaskForm {
  project: string;
  deskId?: string;
  text: string;
  type: TaskType;
  usePlan: boolean;
  /** undefined: the project's / office's default. */
  planApproval?: PlanApproval;
  useReview: boolean;
  rounds?: number;
  /** The project's repositories ticked (the primary one is always in). */
  repoIds: string[];
  /** Every repository of the project, primary first. */
  allRepoIds: string[];
  primaryId?: string;
  provider?: AgentProvider;
  model?: string;
  effort?: AgentEffort;
  ticket?: string;
  ticketUrl?: string;
  /** Files already uploaded (kanban/attachbox.ts) to attach to the task. */
  attachmentIds?: string[];
  /** The title, when it isn't the text's first line (an issue's). */
  title?: string;
}

export type TaskCreateMsg = Extract<KanbanClientMsg, { t: 'kanban.task.create' }>;

/**
 * The kanban.task.create a hire sends, started at its desk; or why it can't be (the text is empty,
 * or the provider can't run the kanban process).
 */
export function hireTaskMsg(f: HireTaskForm): { msg: Omit<TaskCreateMsg, 'rid'> } | { error: string } {
  const text = f.text.replace(/\r\n?/g, '\n').trim();
  const title = (f.title?.trim() ? clipText(f.title, 120) : titleFrom(text)).slice(0, KANBAN_LIMITS.title);
  if (!title) return { error: 'Say what the task is: its first line is the title' };
  const tool = kanbanTool(f.provider);
  if (f.provider && !tool) return { error: 'The kanban process runs on Claude Code or Codex only' };
  // The primary repository always, whatever was ticked; every one ticked is the same as all (null).
  const picked = new Set(f.repoIds);
  if (f.primaryId) picked.add(f.primaryId);
  const ids = f.allRepoIds.length ? f.allRepoIds.filter((id) => picked.has(id)) : [...picked];
  const all = !f.allRepoIds.length || ids.length === f.allRepoIds.length;
  const investigate = f.type === 'investigate';
  const task: KanbanTaskInput = {
    project: f.project,
    title,
    description: text.slice(0, KANBAN_LIMITS.description),
    type: f.type,
    ...(all ? {} : { repoIds: ids }),
    ...(tool ? { tool } : {}),
    ...(tool && f.model ? { model: f.model } : {}),
    ...(tool && f.effort ? { effort: f.effort as KanbanEffort } : {}),
    // An investigation has no plan, review or PRs.
    ...(investigate ? {} : { usePlan: f.usePlan, useReview: f.useReview }),
    ...(!investigate && f.usePlan && f.planApproval ? { planApproval: f.planApproval } : {}),
    ...(!investigate && f.useReview && f.rounds ? { review: { rounds: Math.min(10, Math.max(1, Math.round(f.rounds))) } } : {}),
    ...(f.ticket ? { ticket: f.ticket.slice(0, KANBAN_LIMITS.ticket) } : {}),
    ...(f.ticketUrl ? { ticketUrl: f.ticketUrl.slice(0, KANBAN_LIMITS.url) } : {}),
    ...(f.attachmentIds?.length ? { attachmentIds: f.attachmentIds } : {}),
  };
  return { msg: { t: 'kanban.task.create', task, start: true, ...(f.deskId ? { deskId: f.deskId } : {}) } };
}

/** An issue's ticket key, as the kanban's issue sources make it: `gh:owner/repo#12`. */
export function issueTicket(repo: string | undefined, number: number): string | undefined {
  return repo ? `gh:${repo}#${number}` : undefined;
}

/** A task's description from an issue: its body, then where it's from. */
export function issueDescription(issue: { title: string; body?: string; url?: string }): string {
  return [issue.body?.trim() || issue.title, issue.url ? `Source: ${issue.url}` : ''].filter(Boolean).join('\n\n');
}

// --- The worker window's tabs (E) -----------------------------------------------------------------

/** The worker window's tabs: its terminal and its kanban task (a task worker only). */
export type WorkerTab = 'terminal' | 'task';

/** The class of the worker window's 🗂️ Task pane (worker3d.ts). */
export const TASK_PANE_CLASS = 'worker-task';

/**
 * Whether a drop landed in the worker window's task pane: the terminal's window-wide drop zone leaves
 * those alone, so files meant for the task (its composer's attachments) never reach the terminal.
 */
export function inTaskPane(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (sel: string) => unknown } | null)?.closest;
  return typeof closest === 'function' && !!closest.call(target, `.${TASK_PANE_CLASS}`);
}

/**
 * The tabs a worker's window has: none (upstream's window as it is) for a worker without a task.
 * Its changes are the 🌿 Changes button in the window's header, which opens the task's Changes window.
 */
export function workerTabs(w: Pick<WorkerInfo, 'kanban'>): WorkerTab[] {
  return kanbanOf(w) ? ['terminal', 'task'] : [];
}

/** What a tab's button says. */
export function tabLabel(tab: WorkerTab, w: Pick<WorkerInfo, 'kanban'>): string {
  if (tab === 'terminal') return '🖥️ Terminal';
  return `🗂️ Task #${kanbanOf(w)?.taskId ?? ''}`;
}

/** The tab each worker's window was last on, for this page's session. */
export class TabMemory {
  private tabs = new Map<string, WorkerTab>();

  /** The tab to open on: the one asked for when it has it, else the last one, else the task's (else the terminal). */
  opening(workerId: string, tabs: readonly WorkerTab[], asked?: WorkerTab): WorkerTab {
    if (asked && tabs.includes(asked)) return asked;
    const last = this.tabs.get(workerId);
    if (last && tabs.includes(last)) return last;
    return tabs.includes('task') ? 'task' : 'terminal';
  }

  chose(workerId: string, tab: WorkerTab) {
    this.tabs.set(workerId, tab);
  }
}

// --- P, a card, or Ask onto a task worker ---------------------------------------------------------

/** The columns the engine carries a task on in: a message to its worker goes on the task only then. */
const MESSAGE_STATUSES: readonly string[] = ['in_progress', 'waiting', 'review'];

/**
 * What a prompt to a worker does: `message` a task implementer whose task is in progress, waiting or
 * in review (sent `asComment`: it becomes a task comment and the engine carries the process on; the
 * server refuses one for any other column), `terminal` a task reviewer (only its terminal takes
 * anything), `plain` anyone else, a task worker whose task is in To do, done or archived included
 * (upstream's prompt, typed straight in).
 */
export function promptKind(w: Pick<WorkerInfo, 'kanban'>): 'message' | 'terminal' | 'plain' {
  const k = kanbanOf(w);
  if (!k) return 'plain';
  if (k.role === 'reviewer') return 'terminal';
  return takesMessage(k.status) ? 'message' : 'plain';
}

/** Whether a task in `status` takes a message to its worker as a task comment (the card drop checks the task it fetched). */
export function takesMessage(status: string | undefined): boolean {
  return MESSAGE_STATUSES.includes(status ?? '');
}

/** Why a task waits when R puts it back to work: the engine's Retry reasons (machine.ts), less a usage limit it retries by itself. */
const RETRYABLE: readonly WaitingReason[] = ['stopped', 'failed', 'interrupted', 'agent_asking'];

/** Whether R retries the worker's task: an implementer whose task waits after a run went wrong (not on a plan: that's approved or answered). */
export function canRetry(w: Pick<WorkerInfo, 'kanban'>): boolean {
  const k = kanbanOf(w);
  return !!k && k.role === 'implementer' && k.status === 'waiting' && (k.runState ?? 'idle') === 'idle' && !!k.waitingReason && RETRYABLE.includes(k.waitingReason);
}

/** Whether an issue card is the task's own: its ticket is the issue's key (`cardKey`, a card from the project's issue sources). */
export function cardIsTasks(ticket: string | undefined, repo: string | undefined, issue: number, cardKey?: string): boolean {
  if (cardKey) return !!ticket && ticket === cardKey;
  const key = issueTicket(repo, issue);
  return !!ticket && !!key && ticket === key;
}
