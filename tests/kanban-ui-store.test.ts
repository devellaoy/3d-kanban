// The kanban page's store: what ⚙️ Settings takes from a snapshot outside the kanban page (the 3D
// office has no board, so the cards stay as they are).

import test from 'node:test';
import assert from 'node:assert/strict';
import { KanbanStore } from '../src/client/kanban/store.js';
import type { KanbanProjectInfo, KanbanSettings, KanbanTaskCard } from '../src/shared/kanban/types.js';

test('applyMeta takes the projects, settings, secrets and who you are, and leaves the cards alone', () => {
  const s = new KanbanStore();
  s.tasks.set(1, { id: 1 } as KanbanTaskCard);
  const heard: string[] = [];
  for (const t of ['tasks', 'projects', 'settings', 'me', 'snapshot'] as const) s.on(t, () => heard.push(t));
  const projects = [{ id: 'web', name: 'Web', repos: [] }] as unknown as KanbanProjectInfo[];
  const settings = { archiveAfterDays: 7 } as unknown as KanbanSettings;
  const secrets = { jira: [{ id: 'jira', name: 'x', site: 'x.atlassian.net' }], apiKey: { configured: false } };
  s.applyMeta({ projects, settings, secrets, me: { admin: true, name: 'Ada' } });
  assert.equal(s.projects, projects);
  assert.equal(s.settings, settings);
  assert.deepEqual(s.secrets, secrets);
  assert.deepEqual(s.me, { admin: true, name: 'Ada' });
  assert.deepEqual([...s.tasks.keys()], [1]);
  assert.equal(s.loaded, false);
  assert.deepEqual(heard, ['projects', 'settings', 'me']);
});

test("a one-off snapshot of the board's project asked for without the archive leaves an open archive's cards alone", () => {
  // The PR board's 👤 Mine (and a hire form) ask for a kanban.snapshot of their own; the bus hands
  // every answer to the page's store too.
  const s = new KanbanStore();
  s.project = 'web';
  s.includeArchived = true;
  const snap = (ids: number[], includeArchived: boolean) =>
    ({ t: 'kanban.snapshot', project: 'web', ...(includeArchived ? { includeArchived: true } : {}), tasks: ids.map((id) => ({ id }) as KanbanTaskCard), projects: [], settings: {} as KanbanSettings, secrets: { jira: [], apiKey: { configured: false } }, me: { admin: false, name: 'Ada' } }) as const;
  assert.equal(s.apply(snap([1, 2], true)), true);
  assert.equal(s.apply(snap([1], false)), false);
  assert.deepEqual([...s.tasks.keys()], [1, 2]);
  // What it says about the office is still news.
  assert.equal(s.me.name, 'Ada');
  // And the other way: archived cards never land on a board whose archive is closed.
  s.includeArchived = false;
  assert.equal(s.apply(snap([1], false)), true);
  assert.equal(s.apply(snap([1, 2], true)), false);
  assert.deepEqual([...s.tasks.keys()], [1]);
});
