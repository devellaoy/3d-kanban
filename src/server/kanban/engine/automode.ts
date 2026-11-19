// Claude's auto mode in a run: whether a worker was launched in it, and the note a run gets when Claude could not turn it on.

import type { WorkerObservation } from '../../workers/types.js';
import type { TurnResult } from './adapters/types.js';
import type { Live } from './live.js';
import { agentHook } from './signals.js';

/** What the task is told when Claude was asked for auto mode and did not start in it (see autoModeUnavailable). */
export const AUTO_MODE_UNAVAILABLE =
  "Claude's auto mode isn't available here (the account, the model or the organisation's policy), so this phase runs in Manual mode and asks for permission in the terminal. Choose another mode in Settings (Kanban → New tasks, or the project).";

/** Whether Claude's launch flags ask for auto mode. */
export function inAutoMode(args: readonly string[] | undefined): boolean {
  const i = args?.indexOf('--permission-mode') ?? -1;
  return i >= 0 && args?.[i + 1] === 'auto';
}

/**
 * Claude Code puts `permission_mode` in every hook payload: "auto" when auto mode is on, and "default" when it was asked for and is not
 * available (Claude then starts in Manual mode, silently). The run's lead hooks tell once per run; a subagent's or teammate's
 * hook has a mode of its own and says nothing about the lead's.
 */
export function autoModeUnavailable(live: Pick<Live, 'autoModeNoted'>, o: WorkerObservation, args: () => readonly string[] | undefined, note: (text: string) => void) {
  if (live.autoModeNoted || o.event !== 'hook' || agentHook(o.payload)) return;
  if ((o.payload as { permission_mode?: unknown } | undefined)?.permission_mode !== 'default' || !inAutoMode(args())) return;
  live.autoModeNoted = true;
  note(AUTO_MODE_UNAVAILABLE);
}

/** KanbanWorkerSummary.planMode: a plan phase whose worker was not launched in auto mode (see taskWaiting). */
export function planModeOf(phase: string, args: readonly string[] | undefined): { planMode?: true } {
  return phase === 'plan' && !inAutoMode(args) ? { planMode: true } : {};
}

/**
 * What a lead's hook tells of its run's mode: Claude asked to leave plan mode (ExitPlanMode: its needs_input is the finished plan), or went on
 * with another tool; and, in auto mode, whether auto mode is there at all.
 */
export function observeLeadHook(live: Live, o: WorkerObservation, args: () => readonly string[] | undefined, note: (text: string) => void) {
  if ((o.hookEvent === 'PreToolUse' || o.hookEvent === 'PermissionRequest') && o.tool === 'ExitPlanMode') {
    live.exitPlan = true;
    const plan = (o.payload as { tool_input?: { plan?: unknown } } | undefined)?.tool_input?.plan;
    if (typeof plan === 'string' && plan.trim()) live.hookPlan = plan;
  } else if (o.hookEvent === 'PreToolUse' && o.tool) [live.exitPlan, live.hookPlan] = [false, undefined];
  autoModeUnavailable(live, o, args, note);
}

/**
 * A turn that ended in ExitPlanMode, with the plan its hook carried when the session log does not have the call yet: Claude Code
 * (2.1.327) runs the hook, and shows the approval dialog, before it writes the tool call to the log, so reading the log right then
 * finds no plan and the run used to fail with "the turn ended without a reply the office could read".
 */
export function planFromHook(live: Pick<Live, 'hookPlan'>, result: TurnResult | undefined, planExit: boolean): TurnResult | undefined {
  if (!planExit || !live.hookPlan || result?.plan?.trim()) return result;
  return { text: '', complete: false, ...result, plan: live.hookPlan, exitPlan: true };
}
