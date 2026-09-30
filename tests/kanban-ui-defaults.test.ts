import test from 'node:test';
import assert from 'node:assert/strict';
import { KANBAN_DEFAULTS, projectDefaults, REVIEW_DEFAULTS } from '../src/client/kanban/defaults.js';
import { DEFAULT_REVIEW, defaultKanbanSettings, defaultProjectSettings } from '../src/server/kanban/settings.js';

test("the kanban page's fallback defaults are the server's", () => {
  const { schemaVersion: _v, projects: _p, ...server } = defaultKanbanSettings();
  assert.deepEqual(KANBAN_DEFAULTS, server);
  assert.deepEqual(REVIEW_DEFAULTS, DEFAULT_REVIEW);
  assert.deepEqual(projectDefaults(), defaultProjectSettings());
});

test('projectDefaults hands out a fresh copy each time', () => {
  const a = projectDefaults();
  a.issueSources.push({ id: 'x', kind: 'github-repo', repos: [], filters: {} });
  assert.equal(projectDefaults().issueSources.length, 0);
});
