// The 3D office's side of the kanban coupling (docs/kanban-coupling.md): files dropped on the worker
// window's task pane stay out of the terminal; "💬 Message task" (asComment) only for a task the
// engine carries on, and Ask sends asComment only then; and the hire dialogs' "🗂️ Run as a kanban
// task" toggle starts off in every new dialog. The DOM parts run on a few-line stand-in for the DOM.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inTaskPane, promptKind, takesMessage, TASK_PANE_CLASS } from '../src/client/kanban/office.js';
import type { KanbanWorkerSummary } from '../src/shared/kanban/types.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const k = (s: Partial<KanbanWorkerSummary> = {}): Pick<WorkerInfo, 'kanban'> => ({ kanban: { taskId: 14, role: 'implementer', ...s } });

/** An element as far as closest() goes: its own classes and its ancestors'. */
const node = (classes: string[], parent?: { closest(sel: string): unknown }) => ({
  closest(sel: string): unknown {
    return classes.includes(sel.replace(/^\./, '')) ? this : (parent?.closest(sel) ?? null);
  },
});

test("a drop on the worker window's task pane isn't the terminal's", () => {
  const pane = node([TASK_PANE_CLASS]);
  const composer = node(['kb-composer'], node(['kb-attach'], pane));
  assert.equal(inTaskPane(composer as unknown as EventTarget), true, 'the attach zone, inside the task pane');
  assert.equal(inTaskPane(pane as unknown as EventTarget), true);
  assert.equal(inTaskPane(node(['xterm'], node(['term-host'])) as unknown as EventTarget), false, 'the terminal takes its own drops');
  assert.equal(inTaskPane(null), false);
  assert.equal(inTaskPane({} as EventTarget), false, 'not an element (the window)');
});

test('"💬 Message task" only for a task the engine carries on; otherwise upstream’s prompt', () => {
  for (const status of ['in_progress', 'waiting', 'review'] as const) {
    assert.equal(promptKind(k({ status })), 'message', status);
    assert.equal(takesMessage(status), true);
  }
  for (const status of ['todo', 'done', 'archived'] as const) {
    assert.equal(promptKind(k({ status })), 'plain', `${status}: typed straight in, as upstream (the server refuses a comment)`);
    assert.equal(takesMessage(status), false);
  }
  assert.equal(promptKind(k()), 'plain', 'no column known: upstream’s');
  assert.equal(promptKind(k({ role: 'reviewer', status: 'review' })), 'terminal');
  assert.equal(promptKind({ kanban: undefined }), 'plain');
});

class FakeEl {
  className = '';
  checked = false;
  disabled = false;
  value = '';
  textContent = '';
  isConnected = false;
  children: unknown[] = [];
  attrs = new Map<string, string>();
  classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  append(...c: unknown[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: unknown[]) {
    this.children = c;
  }
  addEventListener() {}
}

/** The DOM and storage the modules touch, as stand-ins; returns the storage. */
const saved = new Map<string, string>();
function installFakeDom() {
  const g = globalThis as Record<string, unknown>;
  g.Node ??= FakeEl;
  g.document ??= { createElement: (tag: string) => new FakeEl(tag), getElementById: () => null };
  g.localStorage ??= { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  return saved;
}

test('Ask → an existing worker: asComment only to a task implementer the engine carries on', async () => {
  installFakeDom();
  const { askWorker } = await import('../src/client/kanban/office3d.js');
  const { store } = await import('../src/client/state.js');
  const sent: unknown[] = [];
  const net = { send: (m: unknown) => void sent.push(m) } as never;
  const worker = (id: string, kanban?: KanbanWorkerSummary) => store.workers.set(id, { id, name: id, kanban } as WorkerInfo);
  worker('open', { taskId: 14, role: 'implementer', status: 'waiting' });
  worker('done', { taskId: 15, role: 'implementer', status: 'done' });
  worker('plain');
  for (const id of ['open', 'done', 'plain', 'gone']) askWorker(net, id, 'Do it');
  assert.deepEqual(sent, [
    { t: 'worker.prompt', workerId: 'open', prompt: 'Do it', asComment: true },
    { t: 'worker.prompt', workerId: 'done', prompt: 'Do it' },
    { t: 'worker.prompt', workerId: 'plain', prompt: 'Do it' },
    { t: 'worker.prompt', workerId: 'gone', prompt: 'Do it' },
  ]);
  for (const id of ['open', 'done', 'plain']) store.workers.delete(id);
});

test('the kanban hire toggle starts off in every new dialog, even after one had it on', async () => {
  // What an older build left: the toggle remembered on.
  installFakeDom().set('agent-office.kanban-hire', '1');
  const { kanbanSection } = await import('../src/client/kanban/hireform.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opt = { net: {} as any, project: 'proj', deskId: () => 'd1', deskLabel: 'Desk 1' };
  const provider = { value: () => 'claude', element: new FakeEl('div') } as never;
  const first = kanbanSection(opt, provider);
  assert.equal(first.on(), false, 'off even though an older build remembered it on');
  // Turned on in one dialog: the next one is off again.
  const box = ((first.element as unknown as FakeEl).children[0] as FakeEl).children[0] as FakeEl;
  box.checked = true;
  assert.equal(first.on(), true);
  assert.equal(kanbanSection(opt, provider).on(), false);
});
