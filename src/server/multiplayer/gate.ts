// The inbound gate for visitors, in front of every message a visitor's browser sends (see
// ws/dispatch.ts). The rules are the pure tables in shared/multiplayer/allow.ts; this gives them
// the office's own lookups for what a message names (a worker's floor, a task's project).
import { taskRepoIds } from '../../shared/multiplayer/repos.js';
import { visitorMay } from '../../shared/multiplayer/allow.js';
import type { ClientMsg } from '../../shared/protocol.js';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';

/**
 * Every repository a worker works in: its own floor and the repositories it also works in
 * (WorkerInfo.repos[].floor, a floor id or `<floor>~<repo>`), whole, since a repository taken out of a
 * project later is still in an old worker's workspace. A visitor sees the worker only when all of them
 * are theirs (repoOk); undefined for no such worker.
 */
export function workerFloors(ctx: Ctx, workerId: string): string[] | undefined {
  const floor = ctx.workerFloor(workerId);
  const info = floor?.workers.get(workerId);
  return floor && info ? [floor.id, ...(info.repos ?? []).map((r) => r.floor)] : undefined;
}

/** Whether `c` may send `msg`: anyone but a visitor may; a visitor only what the tables allow in their scope. */
export function visitorAllows(ctx: Ctx, c: Client, msg: ClientMsg): boolean {
  if (!c.visitor) return true;
  return visitorMay(msg, c.visitor, {
    workerFloors: (id) => workerFloors(ctx, id),
    projectOfTask: (id) => ctx.kanban?.ctx.repo.getTask(id)?.project,
    taskRepos: (id) => taskRepos(ctx, id),
  });
}

/** The repositories a task names (see taskRepoIds); undefined for no such task. */
export function taskRepos(ctx: Ctx, taskId: number): string[] | undefined {
  const task = ctx.kanban?.ctx.repo.getTask(taskId);
  return task ? taskRepoIds(task) : undefined;
}
