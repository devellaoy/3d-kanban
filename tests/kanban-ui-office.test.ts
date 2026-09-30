// The kanban in the 3D office and the 2D view, without the DOM (src/client/kanban/office.ts): a task
// worker's card and name tag, who waits on you, the send-home Done default, where J goes, the
// kanban's 📍 Show in 3D link, the kanban.task.create a hire sends, the worker window's tabs, and
// what a prompt to a task worker does.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRetry,
  cardIsTasks,
  countdown,
  doneDefault,
  hireTaskMsg,
  issueDescription,
  issueTicket,
  kanbanCard,
  kanbanStarter,
  kanbanUrl,
  officeLink,
  parseOfficeLink,
  promptKind,
  queuedKanbanTasks,
  TabMemory,
  tabLabel,
  taskWaiting,
  titleFrom,
  withoutOfficeLink,
  workerLabel,
  workerTabs,
  type HireTaskForm,
} from '../src/client/kanban/office.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import type { KanbanTaskCard, KanbanWorkerSummary } from '../src/shared/kanban/types.js';
import { showIn3dLink } from '../src/client/kanban/model.js';

const NOW = 1_000_000;
const k = (s: Partial<KanbanWorkerSummary> = {}): Pick<WorkerInfo, 'kanban'> => ({ kanban: { taskId: 14, role: 'implementer', ...s } });

test('the desk card: task, title, phase and round, what it waits on', () => {
  assert.deepEqual(kanbanCard(k({ title: 'Fix the login', status: 'in_progress', phase: 'review', runState: 'running', round: 2, rounds: 3 }), NOW), {
    name: '🗂️ #14 · Fix the login',
    summary: 'review 2/3',
  });
  assert.deepEqual(kanbanCard(k({ status: 'waiting', phase: 'plan', runState: 'idle', waitingReason: 'plan_approval' }), NOW), {
    name: '🗂️ #14',
    summary: 'waiting · ✅ the plan waits for your approval',
  });
  // The last phase isn't shown once its run is over: the column is.
  assert.equal(kanbanCard(k({ status: 'review', phase: 'review', runState: 'idle', round: 3, rounds: 3 }), NOW)!.summary, 'in review 3/3 · 👀 ready for your review');
  assert.equal(kanbanCard(k({ status: 'waiting', runState: 'idle', waitingReason: 'usage_limit', retryAt: NOW + 65_000 }), NOW)!.summary, 'waiting · ⏳ retries in 1 min 05 s');
  assert.equal(kanbanCard(k({ status: 'in_progress', phase: 'implement', runState: 'queued' }), NOW)!.summary, '⏳ queued for a desk');
  assert.equal(kanbanCard(k({ role: 'reviewer', title: 'Fix the login' }), NOW)!.name, '🔍 reviewing #14 · Fix the login');
  assert.equal(kanbanCard(k({ title: 'x'.repeat(60) }), NOW)!.name.length, '🗂️ #14 · '.length + 40);
  assert.equal(kanbanCard({ kanban: undefined }, NOW), undefined);
  assert.equal(workerLabel({ name: 'Ada', ...k() }), 'Ada · #14');
  assert.equal(workerLabel({ name: 'Ada', kanban: undefined }), 'Ada');
  assert.equal(countdown(NOW + 3_600_000 + 120_000, NOW), '1 h 02 min');
  assert.equal(countdown(NOW - 1, NOW), 'any moment');
});

test('who waits on you: a task waiting on a person, or an unseen review; not one the engine carries on', () => {
  const w = (status: WorkerInfo['status'], acked: boolean, s: Partial<KanbanWorkerSummary>) => ({ status, acked, ...k(s) });
  assert.equal(taskWaiting(w('done', true, { status: 'waiting', waitingReason: 'plan_questions' })), true);
  assert.equal(taskWaiting(w('done', false, { status: 'waiting', waitingReason: 'usage_limit' })), false);
  assert.equal(taskWaiting(w('done', false, { status: 'review' })), true);
  assert.equal(taskWaiting(w('done', true, { status: 'review' })), false);
  assert.equal(taskWaiting(w('done', false, { status: 'in_progress' })), false);
  assert.equal(taskWaiting(w('needs_input', true, { status: 'in_progress' })), true);
  // Working, or not a task worker: upstream's rule.
  assert.equal(taskWaiting(w('working', false, { status: 'waiting', waitingReason: 'failed' })), undefined);
  assert.equal(taskWaiting({ status: 'done', acked: false, kanban: undefined }), undefined);
});

test('sending home: Done is ticked in review, not while it runs, and absent when there is nothing to move', () => {
  assert.equal(doneDefault('review'), true);
  for (const s of ['todo', 'in_progress', 'waiting'] as const) assert.equal(doneDefault(s), false);
  assert.equal(doneDefault('done'), null);
  assert.equal(doneDefault('archived'), null);
  assert.equal(doneDefault(undefined), null);
});

test('J: the task you face on its conversation, else the floor’s board', () => {
  assert.equal(kanbanUrl('api', k()), '/kanban?project=api&task=14&tab=conversation');
  assert.equal(kanbanUrl('api', { kanban: undefined }), '/kanban?project=api');
  assert.equal(kanbanUrl('api'), '/kanban?project=api');
  assert.equal(kanbanUrl(null), '/kanban');
});

test('the office deep link: floor, worker and desk, and nothing unsafe', () => {
  assert.deepEqual(parseOfficeLink('?floor=api&worker=w-1&desk=d3'), { floor: 'api', worker: 'w-1', desk: 'd3' });
  assert.deepEqual(parseOfficeLink('?floor=api'), { floor: 'api' });
  assert.deepEqual(parseOfficeLink('?floor=api&worker=../x&desk=<b>'), { floor: 'api' });
  assert.equal(parseOfficeLink('?worker=w-1'), null);
  assert.equal(parseOfficeLink('?floor=Not%20A%20Floor'), null);
  // What the kanban's 📍 Show in 3D makes is what the office reads.
  assert.deepEqual(parseOfficeLink(showIn3dLink('api', 'w-1', 'd3').slice(1)), { floor: 'api', worker: 'w-1', desk: 'd3' });
  assert.equal(officeLink({ floor: 'api', worker: 'w-1', desk: 'd3' }), '/?floor=api&worker=w-1&desk=d3');
  assert.equal(withoutOfficeLink('?floor=api&worker=w-1&desk=d3&3d'), '?3d=');
  assert.equal(withoutOfficeLink('?floor=api'), '');
});

const form = (f: Partial<HireTaskForm> = {}): HireTaskForm => ({
  project: 'api',
  deskId: 'd3',
  text: 'Fix the login\n\nIt loops on Safari.',
  type: 'implement',
  usePlan: true,
  useReview: true,
  rounds: 2,
  repoIds: [],
  allRepoIds: [],
  provider: 'claude',
  ...f,
});

test('the hire form’s kanban.task.create: title, description, desk and the process', () => {
  const made = hireTaskMsg(form({ planApproval: 'manual', model: 'opus', effort: 'high' }));
  assert.ok('msg' in made);
  assert.deepEqual(made.msg, {
    t: 'kanban.task.create',
    start: true,
    deskId: 'd3',
    task: {
      project: 'api',
      title: 'Fix the login',
      description: 'Fix the login\n\nIt loops on Safari.',
      type: 'implement',
      tool: 'claude',
      model: 'opus',
      effort: 'high',
      usePlan: true,
      useReview: true,
      planApproval: 'manual',
      review: { rounds: 2 },
    },
  });
  // An investigation has no plan, review or PRs; no desk leaves it to the engine.
  const inv = hireTaskMsg(form({ type: 'investigate', deskId: undefined, provider: 'codex' }));
  assert.ok('msg' in inv);
  assert.deepEqual(inv.msg, { t: 'kanban.task.create', start: true, task: { project: 'api', title: 'Fix the login', description: 'Fix the login\n\nIt loops on Safari.', type: 'investigate', tool: 'codex' } });
  // Review off: no rounds; rounds are kept to 1..10.
  const off = hireTaskMsg(form({ useReview: false, rounds: 5 }));
  assert.ok('msg' in off && !off.msg.task.review);
  const many = hireTaskMsg(form({ rounds: 40 }));
  assert.ok('msg' in many && many.msg.task.review?.rounds === 10);
});

test('the hire form: repositories keep the primary one, all of them is the default', () => {
  const all = hireTaskMsg(form({ repoIds: ['web'], allRepoIds: ['api', 'web'], primaryId: 'api' }));
  assert.ok('msg' in all && all.msg.task.repoIds === undefined);
  const some = hireTaskMsg(form({ repoIds: [], allRepoIds: ['api', 'web', 'docs'], primaryId: 'api' }));
  assert.ok('msg' in some);
  assert.deepEqual(some.msg.task.repoIds, ['api']);
  const two = hireTaskMsg(form({ repoIds: ['docs'], allRepoIds: ['api', 'web', 'docs'], primaryId: 'api' }));
  assert.ok('msg' in two);
  assert.deepEqual(two.msg.task.repoIds, ['api', 'docs']);
});

test('the hire form says no without a title or with a provider the kanban can’t run', () => {
  assert.ok('error' in hireTaskMsg(form({ text: '  \n ' })));
  assert.ok('error' in hireTaskMsg(form({ provider: 'opencode' })));
  assert.equal(titleFrom('\n  ' + 'a'.repeat(200)).length, 120);
  assert.equal(titleFrom('first\nsecond'), 'first');
});

test('an issue as a task: ticket, description and a card that is the task’s own', () => {
  assert.equal(issueTicket('acme/api', 12), 'gh:acme/api#12');
  assert.equal(issueTicket(undefined, 12), undefined);
  assert.equal(issueDescription({ title: 'Login loops', body: 'On Safari.', url: 'https://github.com/acme/api/issues/12' }), 'On Safari.\n\nSource: https://github.com/acme/api/issues/12');
  assert.equal(issueDescription({ title: 'Login loops' }), 'Login loops');
  const made = hireTaskMsg(form({ text: issueDescription({ title: 'Login loops', body: 'On Safari.' }), title: 'Login loops', ticket: 'gh:acme/api#12', ticketUrl: 'https://github.com/acme/api/issues/12' }));
  assert.ok('msg' in made);
  assert.equal(made.msg.task.title, 'Login loops');
  assert.equal(made.msg.task.ticket, 'gh:acme/api#12');
  assert.equal(cardIsTasks('gh:acme/api#12', 'acme/api', 12), true);
  assert.equal(cardIsTasks('gh:acme/api#12', 'acme/api', 13), false);
  assert.equal(cardIsTasks(undefined, 'acme/api', 12), false);
});

test('the worker window’s tabs: only a task worker has them, and each worker keeps its own', () => {
  assert.deepEqual(workerTabs({ kanban: undefined }), []);
  // No 📝 Changes tab: upstream's own 🌿 Changes button is in the window's header.
  assert.deepEqual(workerTabs(k()), ['terminal', 'task']);
  assert.equal(tabLabel('task', k()), '🗂️ Task #14');
  assert.equal(tabLabel('terminal', k()), '🖥️ Terminal');
  const m = new TabMemory();
  const tabs = workerTabs(k());
  assert.equal(m.opening('w1', tabs), 'terminal');
  m.chose('w1', 'task');
  assert.equal(m.opening('w1', tabs), 'task');
  assert.equal(m.opening('w2', tabs), 'terminal');
  assert.equal(m.opening('w1', tabs, 'terminal'), 'terminal');
  assert.equal(m.opening('w2', tabs, 'task'), 'task');
});

test('a prompt to a task worker, R, and who started it', () => {
  assert.equal(promptKind(k({ status: 'in_progress' })), 'message');
  assert.equal(promptKind(k({ role: 'reviewer' })), 'terminal');
  assert.equal(promptKind({ kanban: undefined }), 'plain');
  assert.equal(canRetry(k({ status: 'waiting', runState: 'idle', waitingReason: 'failed' })), true);
  assert.equal(canRetry(k({ status: 'waiting', runState: 'running' })), false);
  assert.equal(canRetry(k({ status: 'waiting', runState: 'idle', waitingReason: 'plan_approval' })), false);
  assert.equal(canRetry(k({ status: 'waiting', runState: 'idle', waitingReason: 'usage_limit' })), false);
  assert.equal(canRetry(k({ status: 'review' })), false);
  assert.equal(canRetry(k({ role: 'reviewer', status: 'waiting' })), false);
  assert.equal(kanbanStarter('Sam (kanban #14)'), 'Sam');
  assert.equal(kanbanStarter('Sam (queue)'), undefined);
});

test('the queue board lists the kanban tasks waiting their turn that no worker at a desk shows', () => {
  const card = (id: number, status: KanbanTaskCard['status'], runState: KanbanTaskCard['runState']) => ({ id, status, runState }) as KanbanTaskCard;
  const cards = [card(9, 'in_progress', 'queued'), card(3, 'in_progress', 'queued'), card(4, 'in_progress', 'running'), card(5, 'todo', 'idle'), card(6, 'waiting', 'idle'), card(7, 'in_progress', 'queued')];
  assert.deepEqual(
    queuedKanbanTasks(cards, new Set([7])).map((c) => c.id),
    [3, 9],
    'queued ones only, oldest first; #7 (its reviewer waits while its implementer sits at a desk) is on its worker’s row',
  );
  assert.deepEqual(queuedKanbanTasks([], new Set()), []);
});
