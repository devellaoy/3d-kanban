// The kanban's routes on the hook server (hooks/server.ts), loopback only.
import type http from 'node:http';
import type { Ctx } from '../../office/context.js';
import { send } from '../../http/util.js';
import { DESK_BY_ID } from '../../../shared/layout.js';
import type { WorkerInfo } from '../../../shared/protocol.js';
import type { KanbanHookCaller } from '../registry.js';

/** Who a hook request comes from, as the kanban's routes see it: the worker, the account it runs as and, for a person's hire only, that person. */
export function hookCaller(me: WorkerInfo, floorId: string, accountId?: string, accountName?: string): KanbanHookCaller {
  return {
    workerId: me.id,
    floorId,
    ...(me.kanban ? { taskId: me.kanban.taskId } : {}),
    name: me.name,
    kind: me.kind,
    ...(DESK_BY_ID.get(me.deskId)?.station ? { station: true } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountName ? { accountName } : {}),
    // Only a person's hire names a person: the queue's, an agent's and the kanban's name something else.
    ...(me.byPerson && me.createdBy ? { hiredBy: me.createdBy } : {}),
  };
}

/** /office/tasks*, the kanban's routes for workers: the asking worker's own hook token says who (and which task) it is. */
export async function officeTasks(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const { kanban } = ctx;
  if (!kanban) return send(res, 503, { error: 'The kanban is starting' });
  const workerId = url.searchParams.get('worker') ?? '';
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const floor = ctx.workerFloor(workerId);
  const me = floor?.workers.authenticate(workerId, token);
  if (!floor || !me) return send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
  try {
    const accountId = floor.workers.ownerOf(me.id);
    const who = hookCaller(me, floor.id, accountId, accountId ? ctx.accounts.get(accountId)?.name : undefined);
    if (!(await kanban.handleHook(req, res, url, who))) send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
}

/** /api/tasks/reference and /api/v1 for ai-kanban's scripts; the kanban decides who may. */
export async function kanbanLoopback(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const { kanban } = ctx;
  if (!kanban) return send(res, 503, { error: 'The kanban is starting' });
  try {
    if (!(await kanban.handleLoopback(req, res, url))) send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
}

/** Whether a hook-server path is one of the kanban's. */
export const isTasksPath = (p: string) => p === '/office/tasks' || p.startsWith('/office/tasks/');
export const isLoopbackPath = (p: string) => p === '/api/tasks/reference' || p === '/api/v1' || p.startsWith('/api/v1/');
