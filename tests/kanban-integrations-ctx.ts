// A KanbanContext for the integrations' tests: a real (in-memory) database, real settings and
// secrets files in a temp folder, projects as given, and everything that goes out recorded.

import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import type { Floor } from '../src/server/floor.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanSecrets, KanbanSettingsStore } from '../src/server/kanban/settings.js';
import { projectRepos } from '../src/server/kanban/projects.js';
import type { KanbanCaller, KanbanClient, KanbanContext } from '../src/server/kanban/registry.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';

export interface TestCtx extends KanbanContext {
  sent: { msg: KanbanServerMsg; project: string | null }[];
  toasts: { floor: string; text: string; level?: string }[];
  started: number[];
  /** Tasks `taskChanged` was called for. */
  changed: number[];
  floors: Map<string, Floor>;
  tmp: string;
}

export function makeCtx(defs: FloorDef[] = [], opts: { start?: (id: number) => string | void; ghAs?: KanbanContext['ghAs'] } = {}): TestCtx {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kanban-int-'));
  const dataDir = path.join(tmp, '.agent-office');
  mkdirSync(dataDir, { recursive: true });
  const repo = new KanbanRepository(openKanbanDb(':memory:'));
  const settings = new KanbanSettingsStore(dataDir);
  const floors = new Map<string, Floor>();
  const ctx = {
    tmp,
    dataDir,
    filesDir: path.join(dataDir, 'kanban'),
    repo,
    settings,
    secrets: new KanbanSecrets(dataDir),
    projects: () => defs,
    project: (id: string) => defs.find((d) => d.id === id),
    floor: (id: string) => floors.get(id),
    floors,
    repos: (id: string) => {
      const d = defs.find((x) => x.id === id);
      return d ? projectRepos(d) : [];
    },
    setRepos: () => 'not in tests',
    setName: () => 'not in tests',
    officePrompts: () => ({}),
    hookUrl: 'http://127.0.0.1:4555',
    sent: [] as TestCtx['sent'],
    toasts: [] as TestCtx['toasts'],
    started: [] as number[],
    changed: [] as number[],
    broadcast(msg: KanbanServerMsg, project: string | null) {
      ctx.sent.push({ msg, project });
    },
    toast(floor: string, text: string, level?: string) {
      ctx.toasts.push({ floor, text, level });
    },
    card: (id: number) => repo.card(id),
    taskChanged: (id: number) => void ctx.changed.push(id),
    ...(opts.ghAs ? { ghAs: opts.ghAs } : {}),
    attachmentFile: () => undefined,
    workerExtras: () => ({ args: [], env: {} }),
  } as unknown as TestCtx;
  ctx.engine = {
    start: async (id: number) => {
      ctx.started.push(id);
      const err = opts.start?.(id);
      if (!err) repo.updateTask(id, { status: 'in_progress', runState: 'queued' });
      return err;
    },
  } as unknown as KanbanContext['engine'];
  return ctx;
}

export const WHO: KanbanCaller = { name: 'Tester', admin: true, accountId: 'acc1' };

/** A browser connection that keeps what it's sent. */
export function client(admin = true, accountId?: string): KanbanClient & { got: KanbanServerMsg[]; warned: string[] } {
  const got: KanbanServerMsg[] = [];
  const warned: string[] = [];
  return { clientId: 'c1', name: 'Tester', admin, ...(accountId ? { accountId } : {}), got, warned, send: (m) => void got.push(m), warn: (text) => void warned.push(text) };
}

export function def(id: string, dir: string, extra: Partial<FloorDef> = {}): FloorDef {
  return { id, name: id, dir, palette: 0, addedBy: 'test', addedAt: 0, ...extra };
}
