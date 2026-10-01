// Who wants the Codex limits read: the office's panel and the kanban's readouts. The office reads
// them only while a visible tab asks, so this keeps the set of reasons and tells it when that changes.
import type { Net } from '../net';

export type CodexLimitsReason = 'panel' | 'kanban';

const reasons = new Set<CodexLimitsReason>();
/** What the office was last told for this page: not watching, until a reason comes. */
let sent = false;
/** There is one Net per page: the first caller's, hooked once. */
let net: Net | null = null;

const effective = () => reasons.size > 0 && document.visibilityState === 'visible';

function sync() {
  const on = effective();
  if (!net || on === sent) return;
  sent = on;
  net.send({ t: 'codex-limits.watch', on });
}

/** This page wants the Codex limits in view for `reason` (or no longer does). */
export function wantCodexLimits(to: Net, reason: CodexLimitsReason, on: boolean) {
  if (!net) {
    net = to;
    // A reconnected office has forgotten the watch (the welcome comes first on every connection).
    net.onMessage((msg) => {
      if (msg.t !== 'welcome') return;
      sent = false;
      sync();
    });
    document.addEventListener('visibilitychange', sync);
  }
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  sync();
}

/** Read them again now. */
export function refreshCodexLimits(net: Net) {
  net.send({ t: 'codex-limits.refresh' });
}
