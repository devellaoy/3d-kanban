// "O" at a worker's desk (`worker.pr`): the kanban's engine has an agent open the pull requests.
// Upstream's own draft PR (the handler in ws/handlers/workers.ts) runs only when the engine hands the
// message back with PR_FALLBACK.
import type { Client } from '../../office/client.js';
import type { Ctx } from '../../office/context.js';
import { str } from '../../office/input.js';
import { dispatch } from '../../ws/dispatch.js';
import { kanbanCaller, prFallback } from '../office.js';
import { PR_FALLBACK } from '../registry.js';

/** Hands a `worker.pr` message to the kanban; false when upstream's handler should have it (the engine did already). */
export function prViaKanban(ctx: Ctx, c: Client, msg: { t: 'worker.pr'; workerId: string }): boolean {
  const { kanban } = ctx;
  if (!kanban || prFallback.has(msg)) return false;
  const wid = str(msg.workerId, 32);
  const f = ctx.workerFloor(wid);
  if (!f) return true;
  void kanban.engine.prForWorker(f.id, wid, kanbanCaller(ctx, c)).then(
    (r) => {
      if (r !== PR_FALLBACK) return ctx.warn(c, r || undefined);
      prFallback.add(msg);
      dispatch(ctx, c, msg);
    },
    (err: Error) => ctx.warn(c, err.message),
  );
  return true;
}
