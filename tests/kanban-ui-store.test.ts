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
  const secrets = { jira: [{ id: 'jira', name: 'x', site: 'x.atlassian.net', configured: true }], apiKey: { configured: false } };
  s.applyMeta({ projects, settings, secrets, me: { admin: true, name: 'Ada' } });
  assert.equal(s.projects, projects);
  assert.equal(s.settings, settings);
  assert.deepEqual(s.secrets, secrets);
  assert.deepEqual(s.me, { admin: true, name: 'Ada' });
  assert.deepEqual([...s.tasks.keys()], [1]);
  assert.equal(s.loaded, false);
  assert.deepEqual(heard, ['projects', 'settings', 'me']);
});
