// What the 3D office and the 2D view do with a task worker (docs/kanban-coupling.md, "3D actions → task
// events"): P or ✍️ onto it, an issue card handed to it, R when its task waits, the hire dialogs' kanban
// option, and the queue board's kanban toggle and section. The pure parts are in office.ts.

import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTaskCard } from '../../shared/kanban/types.js';
import type { CarriedIssue, WorkerInfo } from '../../shared/protocol';
import { cardLabel } from '../../shared/kanban/issuecard.js';
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { openPrompt } from '../ui/prompt';
import { kanbanApi } from './api';
import type { KanbanOption } from './hireform';
import { canRetry, cardIsTasks, kanbanChip, kanbanOf, kanbanUrl, promptKind, queuedKanbanTasks, STATUS_TEXT, takesMessage } from './office';
import { officeCss } from './officecss';

type Detail = Extract<KanbanServerMsg, { t: 'kanban.task.detail' }>;
type Snapshot = Extract<KanbanServerMsg, { t: 'kanban.snapshot' }>;

/**
 * `worker.prompt`; `asComment` makes it a comment on a task worker's task (docs/kanban-coupling.md,
 * Messages). Without it the server types it straight in, as upstream does.
 */
export function promptWorker(net: Net, workerId: string, prompt: string, asComment?: boolean, issue?: number, issueKey?: string) {
  net.send({ t: 'worker.prompt', workerId, prompt, ...(issue ? { issue } : {}), ...(issueKey ? { issueKey } : {}), ...(asComment ? { asComment: true as const } : {}) });
}

/** Ask → an existing worker: a message on its task for a task implementer the engine carries on (promptKind), else upstream's prompt. */
export function askWorker(net: Net, workerId: string, prompt: string) {
  const w = store.workers.get(workerId);
  promptWorker(net, workerId, prompt, !!w && promptKind(w) === 'message');
}

/**
 * P (or ✍️ on the 2D view) at a task worker: a message on its task for an implementer whose task is in
 * progress, waiting or in review, which the engine follows (or typed straight into the terminal); a
 * reviewer takes nothing but its terminal. False for any other worker, a task worker whose task is in
 * To do, done or archived included: the caller does upstream's prompt.
 */
export function promptTaskWorker(net: Net, w: WorkerInfo, openTerminal: () => void): boolean {
  const kind = promptKind(w);
  if (kind === 'plain') return false;
  const k = kanbanOf(w)!;
  if (kind === 'terminal') {
    toast(`🔍 ${w.name} is reviewing task #${k.taskId}: anything for it goes into its terminal`);
    openTerminal();
    return true;
  }
  officeCss();
  openPrompt({
    title: `💬 Message task #${k.taskId} (continues the kanban process)`,
    subtitle: `It goes on the task’s conversation, and ${w.name} carries on with it${w.status === 'working' ? ' once its turn is done' : ''}.`,
    placeholder: 'A change, an answer, what to do next…',
    submitLabel: 'Send to the task',
    rawLabel: 'Type straight into the terminal instead',
    onSubmit: (text, o) => promptWorker(net, w.id, text, !o.raw),
  });
  return true;
}

/**
 * An issue card handed to a task worker: only the task's own issue goes to it (as a message on the
 * task); any other is refused, so a task isn't taken off course. `done` puts the card down.
 */
export function cardToTaskWorker(net: Net, w: WorkerInfo, card: CarriedIssue, prompt: string, done: () => void): boolean {
  const k = kanbanOf(w);
  if (!k) return false;
  const name = cardLabel({ number: card.issue, key: card.key }, store.currentFloor()?.repo);
  if (k.role === 'reviewer') {
    toast(`🔍 ${w.name} is reviewing task #${k.taskId}: hand ${name} to someone else`, 'warn');
    return true;
  }
  kanbanApi(net)
    .request<Detail>({ t: 'kanban.task.get', id: k.taskId, comments: 0 })
    .then((d) => {
      if (!cardIsTasks(d.task.ticket, store.currentFloor()?.repo, card.issue, card.key)) return void toast(`🗂️ ${w.name} is on task #${k.taskId}, not ${name}: take the card to an empty desk (P makes it a kanban task)`, 'warn');
      // A message on the task while the engine carries it; out of the process, upstream's prompt.
      promptWorker(net, w.id, prompt, takesMessage(d.task.status), card.issue, card.key);
      done();
    })
    .catch((err: Error) => toast(`🗂️ ${err.message}`, 'error'));
  return true;
}

/** R at a task worker whose task waits: the engine retries it. False when R isn't that here. */
export function retryTask(net: Net, w: WorkerInfo): boolean {
  if (!canRetry(w)) return false;
  const id = kanbanOf(w)!.taskId;
  kanbanApi(net)
    .request({ t: 'kanban.task.retry', id })
    .then(() => toast(`🗂️ Retrying task #${id}`))
    .catch((err: Error) => toast(`🗂️ ${err.message}`, 'error'));
  return true;
}

/** The hire dialogs' kanban option, for a desk on the floor you're on; undefined off a project's floor. */
export function hireOption(net: Net, deskId: () => string | undefined, deskLabel: string): KanbanOption | undefined {
  const project = store.floor;
  if (!project || !store.project) return undefined;
  return { net, project, deskId, deskLabel, title: `🗂️ New kanban task at ${deskLabel}` };
}

/**
 * The 📋 queue board's kanban toggle, for the floor you're on (undefined off a project's floor): the
 * task has no desk of its own, so the engine seats it at the next free one or queues it.
 */
export function queueOption(net: Net, onCreated?: (taskId: number) => void): KanbanOption | undefined {
  const project = store.floor;
  if (!project || !store.project) return undefined;
  officeCss();
  return { net, project, deskId: () => undefined, deskLabel: 'the next free desk', queued: true, onCreated };
}

/**
 * The floor's kanban tasks while the queue board is open, for the ones waiting their turn. A plain
 * kanban.snapshot, never kanban.subscribe: that would take the connection's one delta filter (a task
 * window's, say). It asks when it starts, after a task is made (`refresh`), when the tasks seated at
 * a desk change (`workersChanged`: a queued one got its worker) and every 30 s; one request at a time,
 * and one asked for meanwhile follows it. `rerender` only when the waiting tasks changed.
 */
export function kanbanQueueWatch(net: Net, rerender: () => void) {
  let tasks: KanbanTaskCard[] = [];
  let shown = '';
  let seated: string | undefined;
  let stopped = false;
  let busy = false;
  let again = false;
  const load = () => {
    const project = store.floor;
    if (stopped) return;
    if (!project) return show([]);
    busy = true;
    kanbanApi(net)
      .request<Snapshot>({ t: 'kanban.snapshot', project })
      .then((s) => s.tasks)
      .catch((): KanbanTaskCard[] => [])
      .then((cards) => {
        busy = false;
        if (stopped) return;
        show(cards);
        if (again) refresh();
      });
  };
  const show = (cards: KanbanTaskCard[]) => {
    tasks = cards.filter((c) => c.runState === 'queued');
    const key = tasks.map((c) => `${c.id}:${c.title}`).join('\n');
    if (key === shown) return;
    shown = key;
    rerender();
  };
  const refresh = () => {
    again = busy;
    if (!busy) load();
  };
  const tick = setInterval(refresh, 30_000);
  return {
    tasks: () => tasks,
    refresh,
    workersChanged() {
      const now = [...store.workers.values()].flatMap((w) => (w.kanban ? [w.kanban.taskId] : [])).sort((a, b) => a - b).join(',');
      if (now === seated) return;
      seated = now;
      refresh();
    },
    stop() {
      stopped = true;
      clearInterval(tick);
    },
  };
}

/**
 * The queue board's "🗂️ Kanban on this floor": its task workers, each opening its task, the tasks
 * waiting their turn (`tasks`: the floor's queued cards, from kanbanQueueWatch), and a link to the kanban.
 * Null when there's nothing to show.
 */
export function kanbanQueueSection(net: Net, tasks: readonly KanbanTaskCard[] = []): HTMLElement | null {
  const now = Date.now();
  const workers = [...store.workers.values()].filter((w) => w.kanban).sort((a, b) => a.kanban!.taskId - b.kanban!.taskId || a.id.localeCompare(b.id));
  const waiting = queuedKanbanTasks(tasks, new Set(workers.map((w) => w.kanban!.taskId)));
  if (!workers.length && !waiting.length) return null;
  const open = (id: number) => h('button.btn', { type: 'button', onclick: () => void import('./taskview').then((m) => m.openTaskWindow(net, id)) }, '🗂️ Task');
  return h(
    'div',
    {},
    h('h4', {}, '🗂️ Kanban on this floor', h('span.count', {}, String(workers.length + waiting.length)), h('a', { href: kanbanUrl(store.floor), style: 'margin-left:auto;font-size:13px' }, 'Open the kanban ↗')),
    h(
      'ul.queue-list',
      {},
      ...workers.map((w) => h('li', {}, h('div.queue-main', {}, h('div.queue-title', {}, kanbanChip(w, now)), h('div.queue-meta', {}, w.name)), h('div.queue-actions', {}, open(w.kanban!.taskId)))),
      ...waiting.map((t) =>
        h(
          'li',
          { class: 'queued' },
          h('div.queue-main', {}, h('div.queue-title', {}, `🗂️ #${t.id} ${t.title}`), h('div.queue-meta', {}, `⏳ waiting for a desk or a slot · ${STATUS_TEXT[t.status]} · by ${t.createdBy}`)),
          h('div.queue-actions', {}, open(t.id)),
        ),
      ),
    ),
  );
}
