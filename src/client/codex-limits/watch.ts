// Who wants the Codex limits read: the office's panel and the kanban's readouts. The office reads
// them only while a visible tab asks, so this keeps the set of reasons and tells it when that changes.
import type { Net } from '../net';

export type CodexLimitsReason = 'panel' | 'kanban';

const reasons = new Set<CodexLimitsReason>();
/** What the office was last told for this page (undefined: nothing yet). */
let sent = false;
const hooked = new WeakSet<Net>();
let listening = false;
let current: Net | null = null;

const effective = () => reasons.size > 0 && document.visibilityState === 'visible';

function sync(net: Net) {
  const on = effective();
  if (on === sent) return;
  sent = on;
  net.send({ t: 'codex-limits.watch', on });
}

/** This page wants the Codex limits in view for `reason` (or no longer does). */
export function wantCodexLimits(net: Net, reason: CodexLimitsReason, on: boolean) {
  current = net;
  if (!hooked.has(net)) {
    hooked.add(net);
    // A reconnected office has forgotten the watch (the welcome comes first on every connection).
    net.onMessage((msg) => {
      if (msg.t !== 'welcome') return;
      sent = false;
      sync(net);
    });
  }
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => current && sync(current));
  }
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  sync(net);
}

/** Read them again now. */
export function refreshCodexLimits(net: Net) {
  net.send({ t: 'codex-limits.refresh' });
}
