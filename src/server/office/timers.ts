import type { Ctx } from './context.js';
import { SLOW_CLIENT_BYTES } from './client.js';

/** The office's own clocks: terminals re-sent to viewers who fell behind, and the heartbeat. Returns what stops them. */
export function startTimers(ctx: Ctx): () => void {
  const { clients } = ctx;
  const resync = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.stale.size || c.ws.bufferedAmount > SLOW_CLIENT_BYTES / 8) continue;
      for (const wid of c.stale) {
        const snap = c.attached.has(wid) ? ctx.workerFloor(wid)?.workers.attach(wid, c.id, c.peer.name, !c.visitor) : undefined;
        if (snap) ctx.sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
      }
      c.stale.clear();
    }
  }, 1000);

  // Drop dead connections so ghosts don't linger in the office.
  // Also signs out anyone `agent-office accounts` revoked, and passes on role changes made there.
  const heartbeat = setInterval(() => {
    let accountsMoved = false;
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        continue;
      }
      // A visitor only needs the liveness ping (their RemoteSocket answers it); they have no account to re-check.
      if (!c.out && !c.visitor && (!ctx.stillIn(c) || c.admin !== ctx.meOf(c).admin)) accountsMoved = true;
      c.isAlive = false;
      c.ws.ping();
    }
    if (accountsMoved) ctx.accountsChanged();
  }, 20_000);

  return () => {
    clearInterval(heartbeat);
    clearInterval(resync);
  };
}
