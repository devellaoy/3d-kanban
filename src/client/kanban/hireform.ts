// Hiring in the 3D office (and the 2D view) as a kanban task: the "🗂️ Run as a kanban task" toggle and
// its fields in upstream's hire dialogs (ui/prompt.ts openPrompt, ui/ask.ts openAsk), and a task made
// from an issue card. Either way the office sends kanban.task.create with the desk, and the engine
// hires its worker there (docs/kanban-architecture.md): the kanban view is another window onto the
// same workers. What goes into the message is worked out in office.ts.

import type { AgentEffort, AgentProvider, GhIssue } from '../../shared/protocol';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanProjectInfo, KanbanSettings, KanbanTaskCard, PlanApproval, TaskType } from '../../shared/kanban/types.js';
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { officeChoice, type ProviderPicker } from '../ui/provider';
import { kanbanApi, type KanbanOk } from './api';
import { hireTaskMsg, issueDescription, issueTicket, kanbanTool, STATUS_TEXT, titleFrom, type HireTaskForm } from './office';

type Snapshot = Extract<KanbanServerMsg, { t: 'kanban.snapshot' }>;

/** What a hire dialog passes for its kanban toggle. */
export interface KanbanOption {
  net: Net;
  /** The floor's id: the task's project. */
  project: string;
  /** The desk the task is hired at (asked at send time: the herald picks the seat free then). */
  deskId(): string | undefined;
  deskLabel: string;
  /** The dialog's title while the toggle is on. */
  title?: string;
  /** Made from the 📋 queue board: no desk of its own, it starts at the next free one or waits its turn. */
  queued?: true;
  /** The toggle starts ticked (still off when the provider can't run the kanban). */
  checked?: boolean;
  /** Tags the task gets. */
  tags?: string[];
  /** The task was made (its id). */
  onCreated?: (taskId: number) => void;
}

export interface KanbanSection {
  element: HTMLElement;
  /** Whether the hire makes a kanban task. */
  on(): boolean;
  onChange(fn: (on: boolean) => void): void;
  /** Makes the task and starts it at the desk; `context` goes before the text in its description. */
  send(text: string, agent: { provider?: AgentProvider; model?: string; effort?: AgentEffort; attachmentIds?: string[] }, context?: string): void;
}

/** The project's board as it is now: its repositories, the settings and its tasks (one request). */
function snapshot(net: Net, project: string): Promise<Snapshot> {
  return kanbanApi(net).request<Snapshot>({ t: 'kanban.snapshot', project });
}

const row = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 0;font-weight:700';

/**
 * The toggle and, while it's on, the task's fields. `provider` is the dialog's agent picker: only
 * Claude Code and Codex run the kanban process, so any other provider turns the toggle off.
 */
export function kanbanSection(opt: KanbanOption, provider: ProviderPicker | null): KanbanSection {
  const listeners: ((on: boolean) => void)[] = [];
  // Off in every new dialog: a hire is upstream's plain one unless this one is asked to be a task.
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = !!opt.checked;
  const hint = h('small', { style: 'font-weight:600;color:var(--muted)' });
  const toggle = h(
    'label',
    { style: 'display:flex;gap:8px;align-items:center;margin:10px 0 0;font-weight:700;cursor:pointer', title: 'The task goes on the kanban and runs its process at this desk: the worker plans, implements, and a reviewer reviews it' },
    box,
    '🗂️ Run as a kanban task (plan → implement → review)',
    hint,
  );

  const type = h('select', { 'aria-label': 'Task type' }, h('option', { value: 'implement' }, 'Implement'), h('option', { value: 'investigate' }, 'Investigate (read-only report)')) as HTMLSelectElement;
  const plan = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const approval = h('select', { 'aria-label': 'Plan approval' }, h('option', { value: '' }, 'approval: the default'), h('option', { value: 'auto' }, 'implement straight away'), h('option', { value: 'manual' }, 'wait for my approval')) as HTMLSelectElement;
  const review = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const rounds = h('input', { type: 'number', min: 1, max: 10, step: 1, style: 'width:4.5em', 'aria-label': 'Review rounds' }) as HTMLInputElement;
  const repoRow = h('div.repo-picks', { role: 'group', 'aria-label': 'Repositories', style: 'margin:8px 0 0' });
  const note = h('p.setting-note', { style: 'margin:6px 0 0' });
  const planRow = h('div', { style: row }, h('label', { style: 'display:flex;gap:6px;align-items:center;margin:0;cursor:pointer' }, plan, '📝 Plan first'), approval);
  const reviewRow = h('div', { style: row }, h('label', { style: 'display:flex;gap:6px;align-items:center;margin:0;cursor:pointer' }, review, '🔍 Review rounds'), rounds);
  const fields = h('div.kanban-hire', { style: 'margin:4px 0 0 26px' }, h('div', { style: row }, h('span', { style: 'font-size:14px;font-weight:800' }, 'Type'), type), planRow, reviewRow, repoRow, note);
  const element = h('div', {}, toggle, fields);

  let project: KanbanProjectInfo | undefined;
  let settings: KanbanSettings | undefined;
  let loaded = false;
  const repoBoxes = new Map<string, HTMLInputElement>();

  const tool = () => kanbanTool(provider ? provider.value() : officeChoice(store.project).provider);
  const on = () => box.checked && !box.disabled;

  const paint = () => {
    const ok = !!tool();
    box.disabled = !ok;
    hint.textContent = ok ? '' : '· needs Claude Code or Codex as the worker';
    fields.classList.toggle('hidden', !on());
    const investigate = type.value === 'investigate';
    planRow.classList.toggle('hidden', investigate);
    reviewRow.classList.toggle('hidden', investigate);
    approval.disabled = !plan.checked;
    rounds.disabled = !review.checked;
    note.textContent = opt.queued
      ? "Its first line is the title and all of it the description. It goes on the kanban and starts at the next free desk now; when the project's tasks at once, the desks or the worker limit are full, it waits in In progress and starts by itself (the queue's “workers at once” doesn't count it)."
      : `Its first line is the title and all of it the description. It goes on the kanban and starts at ${opt.deskLabel} now.`;
  };

  const fill = () => {
    const d = settings?.defaults;
    plan.checked = d?.usePlan ?? true;
    review.checked = d?.useReview ?? true;
    rounds.value = String(project?.settings.reviewRounds ?? settings?.review.rounds ?? 2);
    const repos = project?.repos ?? [];
    repoBoxes.clear();
    // One repository: nothing to pick.
    if (repos.length < 2) return repoRow.replaceChildren();
    repoRow.replaceChildren(
      h('span', {}, '📦 Repositories'),
      ...[...repos].sort((a, b) => Number(b.primary) - Number(a.primary)).map((r) => {
        const b = h('input', { type: 'checkbox', checked: true, disabled: r.primary }) as HTMLInputElement;
        repoBoxes.set(r.id, b);
        return h('label.repo-pick', { title: r.primary ? 'The floor’s own repository is always in' : `A worktree of ${r.name} too, on the task’s branch` }, b, r.name);
      }),
    );
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    fill();
    snapshot(opt.net, opt.project)
      .then((s) => {
        settings = s.settings;
        project = s.projects.find((p) => p.id === opt.project);
        if (element.isConnected) fill();
        paint();
      })
      .catch(() => {
        // The fields keep the office's usual defaults; the office says why when the task is sent.
      });
  };

  const changed = () => {
    paint();
    if (on()) load();
    for (const fn of listeners) fn(on());
  };
  box.addEventListener('change', changed);
  for (const el of [type, plan, review]) el.addEventListener('change', paint);
  // The picker says nothing when it changes: look again after anything happens in it.
  provider?.element.addEventListener('change', () => setTimeout(changed, 0));
  provider?.element.addEventListener('click', () => setTimeout(changed, 0));
  paint();
  if (on()) load();

  return {
    element,
    on,
    onChange: (fn) => listeners.push(fn),
    send(text, agent, context) {
      const repos = project?.repos ?? [];
      const form: HireTaskForm = {
        project: opt.project,
        deskId: opt.deskId(),
        text: context ? `${context}\n\n${text}` : text,
        title: context ? titleFrom(text) : undefined,
        type: type.value as TaskType,
        usePlan: plan.checked,
        planApproval: (approval.value || undefined) as PlanApproval | undefined,
        useReview: review.checked,
        rounds: Number(rounds.value) || undefined,
        repoIds: [...repoBoxes].filter(([, b]) => b.checked).map(([id]) => id),
        allRepoIds: repos.map((r) => r.id),
        primaryId: repos.find((r) => r.primary)?.id,
        ...(opt.tags?.length ? { tags: opt.tags } : {}),
        ...agent,
      };
      createTask(opt.net, form, opt.deskLabel, opt.onCreated);
    },
  };
}

/** A toast with a button that opens the task in a window of its own (the shared task view). */
function taskToast(net: Net, text: string, taskId: number, level: 'info' | 'warn' = 'info') {
  const el = toast(text, level);
  // The toasts don't take the mouse; this button does.
  const open = h('button.btn.small', { type: 'button', style: 'pointer-events:auto;margin-left:8px' }, 'open');
  open.addEventListener('click', () => {
    el.remove();
    void import('./taskview').then((m) => m.openTaskWindow(net, taskId));
  });
  el.append(open);
}

/** Sends the task and says how it went. Without a desk, the engine seats it at a free one or queues it. */
export function createTask(net: Net, form: HireTaskForm, deskLabel: string, onCreated?: (taskId: number) => void) {
  const made = hireTaskMsg(form);
  if ('error' in made) return void toast(made.error, 'warn');
  kanbanApi(net)
    .request<KanbanOk>(made.msg)
    .then((ok) => {
      if (!ok.taskId) return;
      if (ok.startError) taskToast(net, `🗂️ Task #${ok.taskId} is in To do, but couldn't start: ${ok.startError}`, ok.taskId, 'warn');
      else if (!form.deskId) taskToast(net, `🗂️ Task #${ok.taskId} is on the kanban: it starts at ${deskLabel}, or waits its turn`, ok.taskId);
      else taskToast(net, `🗂️ Task #${ok.taskId} starts at ${deskLabel}`, ok.taskId);
      onCreated?.(ok.taskId);
    })
    .catch((err: Error) => toast(`🗂️ ${err.message}`, 'error'));
}

/**
 * An issue as a kanban task, started at `deskId` (P with its card at an empty desk, or 🗂️ Kanban task
 * in its window; without a desk, the engine seats it at a free one or queues it): ticket
 * `gh:owner/repo#12`, the issue's title, its body and link. kanban.task.create doesn't look for a task
 * with the same ticket, so this does first: one in To do starts at the desk, any other is only named.
 */
export function issueTask(net: Net, issue: Pick<GhIssue, 'number' | 'title' | 'url'> & { body?: string; repo?: string }, deskId: string | undefined, deskLabel: string) {
  const project = store.floor;
  if (!project) return void toast('Go to a project’s floor first', 'warn');
  const agent = officeChoice(store.project);
  if (!kanbanTool(agent.provider)) return void toast('The kanban process runs on Claude Code or Codex: pick one of them as the office’s worker in ⚙️ Settings', 'warn');
  const ticket = issueTicket(issue.repo ?? store.currentFloor()?.repo, issue.number);
  const api = kanbanApi(net);
  snapshot(net, project)
    .then((s) => {
      const same: KanbanTaskCard | undefined = ticket ? s.tasks.find((t) => t.ticket === ticket) : undefined;
      if (same?.status === 'todo') {
        return api.request<KanbanOk>({ t: 'kanban.task.start', id: same.id, ...(deskId ? { deskId } : {}) }).then(() => taskToast(net, `🗂️ #${issue.number} was already task #${same.id}: it starts at ${deskLabel}`, same.id));
      }
      if (same) return taskToast(net, `🗂️ #${issue.number} is already task #${same.id} (${STATUS_TEXT[same.status]})`, same.id, 'warn');
      const repos = s.projects.find((p) => p.id === project)?.repos ?? [];
      createTask(
        net,
        {
          project,
          deskId,
          text: issueDescription(issue),
          title: issue.title,
          type: 'implement',
          usePlan: s.settings.defaults.usePlan,
          useReview: s.settings.defaults.useReview,
          repoIds: [],
          allRepoIds: repos.map((r) => r.id),
          ticket,
          ticketUrl: issue.url,
          ...agent,
        },
        deskLabel,
      );
    })
    .catch((err: Error) => toast(`🗂️ ${err.message}`, 'error'));
}
