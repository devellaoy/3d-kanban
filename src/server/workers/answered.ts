import { providerAdapter } from '../providers/index.js';
import type { WorkerStatus } from '../../shared/protocol.js';
import { screenText } from './terminal.js';
import type { Worker } from './types.js';

/** How long a prompt must stay off the screen (after first found gone) before it counts as answered. */
export const PROMPT_GONE_MS = 500;

/**
 * A permission prompt answered in the terminal fires no hook until the approved tool has finished, so
 * read the answer off the screen: a prompt seen (see ProviderAdapter.screen.asking) and then gone is answered.
 * A prompt never seen changes nothing. Called from the screen flush.
 */
export function checkAnswered(w: Worker, setStatus: (w: Worker, status: WorkerStatus) => void, now = Date.now()) {
  const asking = w.info.kind === 'agent' ? providerAdapter(w.info.provider)?.screen?.asking : undefined;
  if (!w.term || !asking) return;
  const s = w.info.status;
  const watch = w.promptWatch;
  if (s !== 'needs_input' && !(s === 'working' && watch?.left)) {
    w.promptWatch = undefined;
    return;
  }
  if (s === 'needs_input' && w.bootBlocked) return;
  // The whole screen, not only what this run printed (see checkBlocked): a terminal taken back after an office restart has its open prompt above that mark.
  const shown = asking(screenText(w.term));
  if (s === 'working') {
    // A prompt is there after all (the next of several queued ones, whose hook was already heard, or the same one back from behind another view).
    if (!shown) return;
    setStatus(w, 'needs_input');
    w.promptWatch = { since: w.info.waitingSince, seen: true };
    return;
  }
  // A new wait (or another one than the watched) starts a fresh watch, so nothing goes stale.
  const p = watch && watch.since === w.info.waitingSince ? watch : (w.promptWatch = { since: w.info.waitingSince, seen: false });
  if (shown) {
    p.seen = true;
    p.goneAt = undefined;
  } else if (p.seen) {
    // Not on the first check: the TUI may be mid-redraw.
    if (p.goneAt === undefined) p.goneAt = now;
    else if (now - p.goneAt >= PROMPT_GONE_MS) {
      setStatus(w, 'working');
      w.promptWatch = { seen: false, left: true };
    }
  }
}

/**
 * A hook of the worker was heard: its work moved on by its own account, so the screen is no longer watched for a prompt
 * coming back (what a later tool prints may look like one). A prompt it asks from here on says so with its own hook.
 */
export function hookHeard(w: Worker) {
  if (w.promptWatch?.left) w.promptWatch = undefined;
}
