// What the 3D office and the 2D view do with a task worker (docs/kanban-coupling.md, "3D actions → task
// events"): P or ✍️ onto it, an issue card handed to it, R when its task waits, the hire dialogs' kanban
// option, and the queue board's read-only kanban section. The pure parts are in office.ts.

import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { CarriedIssue, WorkerInfo } from '../../shared/protocol';
import { cardLabel } from '../../shared/kanban/issuecard.js';
import type { Net } from '../net';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { openPrompt } from '../ui/prompt';
import { kanbanApi } from './api';
import type { KanbanOption } from './hireform';
import { canRetry, cardIsTasks, kanbanChip, kanbanOf, kanbanUrl, promptKind, takesMessage } from './office';
import { officeCss } from './officecss';

type Detail = Extract<KanbanServerMsg, { t: 'kanban.task.detail' }>;

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
 * The queue board's read-only "🗂️ Kanban on this floor": its task workers, each opening its task, and
 * a link to the kanban. Null when nobody on the floor has a task.
 */
export function kanbanQueueSection(net: Net): HTMLElement | null {
  const now = Date.now();
  const workers = [...store.workers.values()].filter((w) => w.kanban).sort((a, b) => a.kanban!.taskId - b.kanban!.taskId || a.id.localeCompare(b.id));
  if (!workers.length) return null;
  return h(
    'div',
    {},
    h('h4', {}, '🗂️ Kanban on this floor', h('span.count', {}, String(workers.length)), h('a', { href: kanbanUrl(store.floor), style: 'margin-left:auto;font-size:13px' }, 'Open the kanban ↗')),
    h(
      'ul.queue-list',
      {},
      ...workers.map((w) =>
        h(
          'li',
          {},
          h('div.queue-main', {}, h('div.queue-title', {}, kanbanChip(w, now)), h('div.queue-meta', {}, w.name)),
          h(
            'div.queue-actions',
            {},
            h('button.btn', { type: 'button', onclick: () => void import('./taskview').then((m) => m.openTaskWindow(net, w.kanban!.taskId)) }, '🗂️ Task'),
          ),
        ),
      ),
    ),
  );
}
