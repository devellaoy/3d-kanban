// The Codex limits panel's messages, riding the office's socket (see ClientMsg/ServerMsg in
// shared/protocol.ts): the Codex sign-in's 5-hour and weekly allowance, read on demand
// (server/codex-limits/) for the browsers that have the panel or a kanban readout in view.
import type { PlanWindow } from '../protocol/usage.js';

/**
 * - `off`: nobody asked yet (the browser's starting state).
 * - `checking`: the first read is under way.
 * - `ready`: windows read.
 * - `signedOut`: Codex runs on no ChatGPT plan (signed out, or an API key): no allowance to show.
 * - `missing`: no `codex` on the office's machine.
 * - `error`: the last read failed; `windows` are the last good ones, as of `at`.
 */
export type CodexLimitsStatus = 'off' | 'checking' | 'ready' | 'signedOut' | 'missing' | 'error';

/** One Codex sign-in's allowance, display-only: nothing that names the account crosses the wire. */
export interface CodexLimits {
  status: CodexLimitsStatus;
  /** 'plus', 'pro', 'team'…, when known (at most 24 characters). */
  plan?: string;
  /** Shortest window first: the 5-hour one, then the week. Pro plans may have the week alone. */
  windows: PlanWindow[];
  /** When the windows were read (ms since epoch); 0 before the first good read. */
  at: number;
  /** When a read was last tried, good or not (ms since epoch); 0 before the first. */
  checkedAt: number;
  /** Codex says the limit is reached (or a window is at 100%). */
  reached?: boolean;
}

export type CodexLimitsClientMsg =
  /** This browser has the Codex limits in view (`on`) or no longer has (`off`). The office reads them only while someone has. */
  | { t: 'codex-limits.watch'; on: boolean }
  /** Read them again now (a watcher only; at most every 20 seconds). */
  | { t: 'codex-limits.refresh' };

export type CodexLimitsServerMsg =
  /** The allowance of the Codex sign-in this browser watches. */
  { t: 'codex-limits'; state: CodexLimits };
