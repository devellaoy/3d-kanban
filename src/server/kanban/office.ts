// The kanban inside the office's context: installing it once the floors are
// open, who a connection is to it, and the small lookups the office's handlers share when they touch it.
import { codexLimitsOf } from '../codex-limits/index.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { str } from '../office/input.js';
import { mpOf } from '../multiplayer/registry.js';
import { installKanban, type Kanban } from './index.js';
import type { KanbanCaller, KanbanClient } from './registry.js';

/** The kanban, on the building's floors, the office's prompts and the hook server (ctx.kanban). */
export function openKanban(ctx: Ctx, hookPort: number): Kanban {
  return installKanban({
    dataDir: ctx.cfg.dataDir,
    floors: () => ctx.building.list(),
    floor: (id) => ctx.floors.get(id),
    // Saved, then a visitor loses the floor at once (before the caller broadcasts the new list, which would
    // show them the new repositories under the old scope), then the elevator hears it.
    saveRepos: (id, repos) => {
      const r = ctx.building.setRepos(id, repos);
      if (typeof r !== 'string') mpOf(ctx)?.floorsChanged();
      ctx.floorsChanged();
      return r;
    },
    // A project renamed from the kanban's settings: saved, its floor's top bar info too, then the elevator and the kanban hear it.
    saveName: (id, name) => {
      const r = ctx.building.setName(id, name);
      if (typeof r === 'string') return r;
      const floor = ctx.floors.get(id);
      if (floor) floor.project.name = r.name;
      ctx.floorsChanged();
      return r;
    },
    officePrompts: () => ctx.prompts.state().custom,
    hookUrl: `http://127.0.0.1:${hookPort}`,
    toast: (id, text, level) => ctx.toastFloor(ctx.floors.get(id), text, level),
    // Task hires wait (queued) for the worker limit, keep to upstream's sign-in rule, and a task waiting on a person is announced.
    capacity: () => ctx.machine.full(),
    runAs: ctx.signins,
    // GitHub writes on issues (comments, assignees) go out under the person's own gh sign-in, as taking a card does.
    ghAs: (id) => (id ? ctx.signins.ghAs(id) : undefined),
    notify: (title, detail) => ctx.webhook.announce(title, detail),
    // A Codex usage limit resumes when its account's own limits say they reset.
    codexResetAt: (home) => codexLimitsOf(ctx).resetAt(home),
  });
}

/** Who a connection is, to the kanban. */
export const kanbanCaller = (ctx: Ctx, c: Client): KanbanCaller => ({ clientId: c.id, accountId: c.accountId, name: c.peer.name, admin: ctx.meOfClient(c).admin });
// `clientId` again: KanbanCaller's is optional (a caller over HTTP has none), a KanbanClient's isn't.
export const kanbanClient = (ctx: Ctx, c: Client): KanbanClient => ({ ...kanbanCaller(ctx, c), clientId: c.id, send: (m) => ctx.sendTo(c, m), warn: (text) => ctx.sendTo(c, { t: 'toast', text, level: 'warn' }) });

/** Which of the project's repositories (owner/name) a PR window's message or request is about; none: the floor's own. */
export const ghRepoOf = (v: unknown) => str(v, 201).trim() || undefined;
export const notInProject = (repo: string | undefined) => `${repo} isn't one of this project's repositories`;

/** `worker.pr` messages the kanban engine handed back to upstream's own draft PR (see PR_FALLBACK). */
export const prFallback = new WeakSet<object>();
