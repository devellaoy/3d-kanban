// What a task's worker tells the office about its own turn, on the hook server (worker token already checked by officeTasks):
//  POST /office/tasks/signal  how the turn ends: `office-tasks done`, the MCP tool report_turn (the engine decides what it counts for).
//  POST /office/tasks/stop    a kanban Claude worker's Stop hook (the wrapper in launch.ts posts it here). The engine may block the
//                             Stop with a text for the agent; otherwise the Stop goes on to upstream as /hooks/claude?event=Stop would.
// Each handler answers 404 for any other path and 405 for a non-POST: the refs plugin answers 405 to every non-GET under /office/tasks.

import type { KanbanContext, KanbanHookHandler, KanbanPlugin } from './registry.js';
import { parseTurnSignal } from '../../shared/kanban/signals.js';
import { readJson, sendJson } from './integrations/util.js';

/** The hook payload's size limit, as the hook server's own readBody. */
const STOP_BODY_MAX = 1024 * 1024;
const SIGNAL_HELP = 'Send {"kind": "plan-ready" | "ask" | "done"}, {"kind": "review", "verdict": "approved" | "changes"} or {"kind": "pr", "url": …}';

export function createSignals(ctx: KanbanContext): KanbanPlugin {
  const signal: KanbanHookHandler = async (req, res, url, who) => {
    if (url.pathname !== '/office/tasks/signal') return sendJson(res, 404, { error: 'Not found' }), true;
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' }), true;
    const body = await readJson(req);
    const sig = typeof body === 'string' ? undefined : parseTurnSignal(body);
    if (!sig) return sendJson(res, 400, { error: SIGNAL_HELP }), true;
    const refused = ctx.engine.signal(who.workerId, sig);
    if (refused) return sendJson(res, 409, { error: refused }), true;
    sendJson(res, 200, { ok: true });
    return true;
  };

  const stop: KanbanHookHandler = async (req, res, url, who) => {
    if (url.pathname !== '/office/tasks/stop') return sendJson(res, 404, { error: 'Not found' }), true;
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' }), true;
    const body = await readJson(req, STOP_BODY_MAX);
    // A body that isn't JSON still counts as the Stop it is.
    const payload = typeof body === 'string' || body === undefined ? {} : body;
    let block: string | undefined;
    try {
      block = (await ctx.engine.stopGate(who.workerId, payload)).block || undefined;
    } catch (err) {
      // Any error of the gate is no block: the Stop must still reach the office.
      console.error(`agent-office: the kanban's Stop gate failed: ${(err as Error).message}`);
    }
    // A blocked Stop is not the end of a turn: upstream hears nothing and the worker stays working.
    if (block) return sendJson(res, 200, { decision: 'block', reason: block }), true;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    try {
      ctx.floor(who.floorId)?.workers.handleProviderHook('claude', who.workerId, token, 'Stop', payload);
    } catch (err) {
      console.error(`agent-office: the kanban couldn't pass a Stop on: ${(err as Error).message}`);
    }
    sendJson(res, 200, {});
    return true;
  };

  return { name: 'signals', hook: { '/office/tasks/signal': signal, '/office/tasks/stop': stop } };
}
