// Where and whether a task's worker can be hired (docs/kanban-architecture.md §4): the free desk or the spot behind the
// implementer's chair, the office's worker limit, the sign-in the hire runs on and the fresh base its worktree is cut from.
// Split out of the orchestrator; it holds nothing of the engine's own state, only the context.

import path from 'node:path';
import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import { DESK_BY_ID, deskBuilt, nextFreeSeat, watchSpotOf } from '../../../shared/layout.js';
import type { KanbanRole, KanbanTask } from '../../../shared/kanban/types.js';
import { Worktrees } from '../../worktrees.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import { projectRepos, repoSources } from '../projects.js';

/**
 * The configured base branch of each git repository a task's worktree is cut in (the primary always,
 * the others as `repoIds` says), by checkout folder, for SpawnExtra.bases and the fetch before a hire.
 */
export function baseBranches(def: FloorDef, repoIds: string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of projectRepos(def)) if (r.kind === 'git' && r.baseBranch && (r.primary || !repoIds || repoIds.includes(r.id))) out[path.resolve(r.dir)] = r.baseBranch;
  return out;
}

export class Seating {
  /** Each repository's worktree plumbing, for fetching its base before a hire (see freshBase). */
  private trees = new Map<string, Worktrees>();

  constructor(private ctx: Pick<KanbanContext, 'runAs' | 'capacity'>) {}

  /** Upstream's why-message when `owner` (see hireOwner) has no Claude sign-in, saying whose it is when it isn't the caller's. */
  signInMissing(task: Pick<KanbanTask, 'id' | 'createdBy' | 'createdByAccount'>, owner: string, who?: KanbanCaller): string {
    const why = this.ctx.runAs!.why('claude');
    if (owner !== task.createdByAccount || owner === who?.accountId) return why;
    return `Task #${task.id} runs as its creator, ${task.createdBy}, whose Claude sign-in is missing. ${why}`;
  }

  /**
   * Why a new hire can't be made now, as the queued task's conversation says it: no free desk (the
   * `preferred` one or any other), or the office at its worker limit. Undefined when there's room.
   * `countsWith` (see sharesLimit): the worker limit isn't this hire's to wait for. `role`: a reviewer's
   * `preferred` is the spot behind its implementer's seat (see watchSpotFor), anyone else's a seat.
   */
  noRoom(floor: Floor, preferred?: string, countsWith?: string, role?: KanbanRole): string | undefined {
    const desk = (preferred && !this.deskRefusal(floor, preferred, role === 'reviewer')) || nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.());
    if (!desk) return "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees.";
    if (countsWith) return undefined;
    const full = this.ctx.capacity?.();
    return full ? `Queued: ${full.replace(/[.\s]+$/, '')}. It starts by itself when the office has room.` : undefined;
  }

  /**
   * Where a task's reviewer goes: the spot behind its implementer's chair, over its shoulder, watching
   * its screen, so a review takes no desk. The implementer's desk while it's there, else the desk the
   * task last sat at (it comes back there for the fixes), but only while nobody else sits there: never
   * behind another task's or a person's worker. Undefined otherwise (the reviewer then takes the next
   * free seat, as any hire does).
   */
  watchSpotFor(task: Pick<KanbanTask, 'id' | 'workerId' | 'deskId'>, floor: Floor): string | undefined {
    const implementer = task.workerId ? floor.workers.get(task.workerId) : undefined;
    let deskId = implementer?.deskId;
    if (!deskId && task.deskId) {
      const there = floor.workers.list().find((w) => w.deskId === task.deskId);
      if (!there || there.kanban?.taskId === task.id) deskId = task.deskId;
    }
    const desk = deskId ? DESK_BY_ID.get(deskId) : undefined;
    if (!desk || desk.station || desk.room || desk.watch) return undefined;
    return watchSpotOf(desk.id);
  }

  /**
   * A task counts once against the office's worker limit: its reviewer's hire doesn't wait for the
   * place its own implementer holds, which nothing would ever free (the implementer stays at its desk
   * for the fixes). The implementer's worker id while it is at its desk, for SpawnExtra.countsWith;
   * once it's gone, a reviewer is held to the limit like any hire.
   */
  sharesLimit(task: Pick<KanbanTask, 'workerId'>, role: KanbanRole, floor: Floor): string | undefined {
    return role === 'reviewer' && task.workerId && floor.workers.get(task.workerId) ? task.workerId : undefined;
  }

  /**
   * A worktree cut next starts from what's on GitHub now, as upstream's hires do (withFreshBase, the
   * queue): the floor's base and each other repository's, the configured base branch where there is one.
   */
  async freshBase(floor: Floor, def: FloorDef, repoIds: string[] | null) {
    const fetching: Promise<void>[] = [];
    const bases = baseBranches(def, repoIds);
    const own = floor.workers.fetchBase?.(bases[path.resolve(def.dir)]);
    if (own) fetching.push(own);
    for (const r of repoSources(def, repoIds)) {
      try {
        let trees = this.trees.get(r.dir);
        if (!trees) this.trees.set(r.dir, (trees = new Worktrees(r.dir)));
        const f = trees.fetch(bases[path.resolve(r.dir)]);
        if (f) fetching.push(f);
      } catch {
        // not a checkout git can fetch in: its worktree starts from what's there
      }
    }
    await Promise.all(fetching);
  }

  /** Why a task's worker can't be hired at `deskId` now, if it can't: a desk or bean bag that's built and free. */
  deskRefusal(floor: Floor, deskId: string, watch = false): string | undefined {
    const desk = DESK_BY_ID.get(deskId);
    if (!desk || desk.station || desk.room || !!desk.watch !== watch) return `${deskId} isn't a desk a task's worker can be hired at`;
    if (!deskBuilt(desk, floor.workers.wing?.() ?? 0) || floor.workers.removed?.().has(desk.watch ?? desk.id)) return desk.beanbag ? `${desk.label} isn't on this floor: put a bean bag down in build mode (U)` : `${desk.label} isn't built on this floor yet, or was taken out of it`;
    if (floor.workers.deskOccupied(deskId)) return `${desk.label} is taken: pick a free desk`;
    return undefined;
  }
}
