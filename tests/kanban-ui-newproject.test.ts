import test from 'node:test';
import assert from 'node:assert/strict';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { KanbanProjectInfo } from '../src/shared/kanban/types.js';
import { whenListed } from '../src/client/kanban/newproject.js';
import { kstore } from '../src/client/kanban/store.js';

const project = (id: string) => ({ id, name: id }) as KanbanProjectInfo;
const meta = (ids: string[]) =>
  ({ t: 'kanban.meta', projects: ids.map(project), settings: null, secrets: { jira: { configured: false }, apiKey: { configured: false } }, me: { admin: true, name: 'me' } }) as unknown as KanbanServerMsg;
/** A stand-in for the kanban bus: answers kanban.meta.get with `answer`, and keeps what was asked. */
const fakeApi = (answer: () => Promise<KanbanServerMsg>) => {
  const asked: string[] = [];
  return { asked, request: <T,>(msg: { t: string }) => (asked.push(msg.t), answer() as Promise<T>) };
};
const tick = () => new Promise((r) => setImmediate(r));

test('a new project nobody sends the list for is picked from the meta it asks for', async () => {
  kstore.projects = [];
  const api = fakeApi(async () => meta(['notes']));
  const created: string[] = [];
  whenListed(api, 'notes', (id) => created.push(id));
  await tick();
  assert.deepEqual(api.asked, ['kanban.meta.get']);
  assert.deepEqual(created, ['notes']);
  assert.ok(kstore.projectOf('notes'));
});

test('a project already listed is picked at once, without asking', () => {
  kstore.projects = [project('acme')];
  const api = fakeApi(async () => meta(['acme']));
  const created: string[] = [];
  whenListed(api, 'acme', (id) => created.push(id));
  assert.deepEqual(created, ['acme']);
  assert.deepEqual(api.asked, []);
});

test("meta that doesn't list it yet leaves it to the project list, which picks it once, when it comes", async () => {
  kstore.projects = [];
  const created: string[] = [];
  whenListed(fakeApi(async () => meta([])), 'later', (id) => created.push(id));
  await tick();
  assert.deepEqual(created, []);
  assert.equal(kstore.projects.length, 0);
  kstore.apply({ t: 'kanban.projects', projects: [project('later')] } as KanbanServerMsg);
  kstore.apply({ t: 'kanban.projects', projects: [project('later')] } as KanbanServerMsg);
  assert.deepEqual(created, ['later']);
});

test('no answer to the meta still waits for the project list', async () => {
  kstore.projects = [];
  const created: string[] = [];
  whenListed(fakeApi(() => Promise.reject(new Error('lost'))), 'quiet', (id) => created.push(id));
  await tick();
  kstore.apply({ t: 'kanban.projects', projects: [project('quiet')] } as KanbanServerMsg);
  assert.deepEqual(created, ['quiet']);
});
