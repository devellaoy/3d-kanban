// A Composer over a real project with two repositories, for the prompt tests of the review comments (the same set-up as kanban-engine-prompts.test.ts, smaller).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { Composer } from '../src/server/kanban/engine/compose.js';
import type { KanbanContext } from '../src/server/kanban/registry.js';
import { KanbanSettingsStore } from '../src/server/kanban/settings.js';
import { PROMPTS } from '../src/shared/prompts.js';
import { makeRepo } from './kanban-engine-fixture.js';

export function setupCompose(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kanban-prcomments-')));
  const homes = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  t.after(() => {
    for (const [k, v] of Object.entries(homes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'proj');
  makeRepo(dir);
  const api = path.join(root, 'api');
  makeRepo(api);
  const def: FloorDef = {
    id: 'proj',
    name: 'Proj',
    dir,
    repo: 'acme/proj',
    palette: 0,
    addedBy: 't',
    addedAt: 0,
    repos: [
      { id: 'proj', name: 'Proj', kind: 'git', dir, primary: true },
      { id: 'api', name: 'API', kind: 'git', dir: api, remote: 'azure:contoso/Web/api', primary: false },
    ],
  };
  const repo = new KanbanRepository(openKanbanDb(':memory:'));
  const ctx = {
    repo,
    settings: new KanbanSettingsStore(root),
    dataDir: root,
    filesDir: path.join(root, 'files'),
    officePrompts: () => ({}),
    officeText: (id: keyof typeof PROMPTS) => PROMPTS[id].text,
    languages: () => ({}),
    projects: () => [def],
    project: (id: string) => (id === def.id ? def : undefined),
    floor: () => undefined,
    repos: () => def.repos!,
    toast: () => undefined,
  } as unknown as KanbanContext;
  return { root, dir, def, repo, ctx, compose: new Composer(ctx) };
}
