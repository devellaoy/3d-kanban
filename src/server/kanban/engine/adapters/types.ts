// What the engine needs from each agent CLI it drives (docs/kanban-architecture.md §4): the flags a
// phase launches with, and the final text of a turn, read from the session's own log.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ImplementPermission, KanbanEffort, KanbanTool, RunPhase } from '../../../../shared/kanban/types.js';

export interface LaunchOptions {
  /** How implement-like phases run (see ImplementPermission). */
  permission: ImplementPermission;
  /** The reviewer is kept off the web too. */
  sandbox: boolean;
  /** An investigation: read-only work that writes its report into `addDirs`. */
  investigate?: boolean;
  /** Folders outside the workspace the agent reads (or, investigating, writes its report in). */
  addDirs?: string[];
  model?: string;
  effort?: KanbanEffort;
  /** What the plugins add (skills and the like: ctx.workerExtras().args), last. */
  extra?: string[];
}

/** A turn's result, as far as the log has it. */
export interface TurnResult {
  /**
   * The final answer of the turn: its last assistant message only (Claude: that message's text blocks;
   * Codex: task_complete's last_agent_message), empty when there is none yet. Markers and verdicts are
   * read from this alone.
   */
  text: string;
  /** Claude's ExitPlanMode plan, when the turn ended by leaving plan mode. */
  plan?: string;
  /** The turn ended in ExitPlanMode (it waits for the plan to be approved). */
  exitPlan?: boolean;
  /** The log shows the turn as ended (Codex: task_complete; Claude: an answer after the prompt). */
  complete: boolean;
  /** The turn ended in an API error (a usage limit, the network), with its message. */
  apiError?: string;
  /**
   * Claude: the last message calls a tool whose result isn't in the log (the tool still runs), so
   * nothing but the log may say how the turn ended: a Stop hook then is not to be trusted.
   */
  toolRunning?: boolean;
  /**
   * Claude: how many of the run's background agents are still working (their last event in the log
   * is a launch or a resume, not a notification). The turn's Stop then isn't the run's end. Absent when none.
   */
  background?: number;
}

export interface TaskAgentAdapter {
  tool: KanbanTool;
  /** The CLI flags for a phase, ahead of the resume and prompt arguments upstream adds. */
  launchArgs(phase: RunPhase, opts: LaunchOptions): string[];
  /** The last turn of the session logged at `transcriptPath`; undefined when it can't be read. */
  readTurnResult(transcriptPath: string): TurnResult | undefined;
  /** What upstream's spawn may carry as the worker's model (it validates it); the rest goes in launchArgs. */
  spawnModel(model?: string): string | undefined;
  spawnEffort(effort?: KanbanEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
}

/** A session log can be long: its last 16 MB hold the turn the engine wants. */
const TAIL_BYTES = 16 * 1024 * 1024;

/** The JSON lines of a log (the tail of a big one), skipping any that don't parse. */
export function readJsonLines(file: string): Record<string, unknown>[] | undefined {
  let text: string;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    // Cut mid-line: the first line is a fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return undefined;
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // a line being written, or not JSON
    }
  }
  return out;
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
