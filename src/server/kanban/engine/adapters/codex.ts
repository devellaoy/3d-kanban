// Codex as a task agent: its per-phase flags and reading a turn from its rollout JSONL
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, see M0 in docs/fork.md). Each line is
// `{ type, payload }`: `event_msg` lines are the session's events (user_message, task_complete,
// error...), `response_item` lines what the model saw and said.

import type { KanbanEffort, RunPhase } from '../../../../shared/kanban/types.js';
import { isObj, readJsonLines, type LaunchOptions, type TaskAgentAdapter, type TurnResult } from './types.js';

/** Codex's reasoning efforts: it has minimal…xhigh, so max is xhigh. */
function codexEffort(effort: KanbanEffort | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === 'max' ? 'xhigh' : effort;
}

/** Text of a response_item message's content blocks. */
function messageText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content.filter(isObj) : [];
  return content
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter((t) => t.trim())
    .join('\n\n')
    .trim();
}

/** A user message Codex adds itself (the environment, the AGENTS.md instructions), not a prompt. */
function isContextMessage(text: string): boolean {
  return /^\s*<(?:environment_context|user_instructions|permissions instructions|INSTRUCTIONS)\b/i.test(text) || text.startsWith('# AGENTS.md instructions');
}

/** The turn after the last prompt; its `text` is the final answer (task_complete's last_agent_message, else the last assistant message). */
export function readCodexTurn(file: string): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  // Where the last turn starts: its user_message event (or, in older rollouts, the user response_item).
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const p = isObj(l.payload) ? l.payload : undefined;
    if (!p) continue;
    if (l.type === 'event_msg' && p.type === 'user_message') {
      from = i;
      break;
    }
    if (l.type === 'response_item' && p.type === 'message' && p.role === 'user' && !isContextMessage(messageText(p))) {
      from = i;
      break;
    }
  }
  let final: string | undefined;
  let complete = false;
  let lastAssistant = '';
  let apiError: string | undefined;
  for (const l of lines.slice(from + 1)) {
    const p = isObj(l.payload) ? l.payload : undefined;
    if (!p) continue;
    if (l.type === 'event_msg' && p.type === 'task_complete') {
      complete = true;
      final = typeof p.last_agent_message === 'string' ? p.last_agent_message : final;
    } else if (l.type === 'event_msg' && (p.type === 'error' || p.type === 'stream_error') && typeof p.message === 'string') {
      apiError = p.message;
    } else if (l.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = messageText(p);
      if (t) lastAssistant = t;
    }
  }
  const text = (final ?? lastAssistant).trim() || (apiError ?? '');
  return { text, complete, ...(apiError ? { apiError } : {}) };
}

export const codexAdapter: TaskAgentAdapter = {
  tool: 'codex',
  launchArgs(phase: RunPhase, opts: LaunchOptions): string[] {
    const args: string[] = [];
    if (phase === 'plan' || phase === 'review') args.push('-s', 'read-only', '-a', 'never');
    // Reading pull requests takes gh, and gh the network, which Codex's read-only sandbox has none of:
    // the workspace sandbox with the network on, in the reviewer's own throwaway worktree (the review
    // contract keeps it from writing even there).
    else if (phase === 'pr-review') args.push('-s', 'workspace-write', '-a', 'never', '-c', 'sandbox_workspace_write.network_access=true');
    // An investigation writes its report: the workspace sandbox, with the report folder writable too.
    else if (opts.investigate || opts.permission === 'workspace-write') {
      args.push('-s', 'workspace-write', '-a', 'never');
      // Codex reads anywhere in any mode; only writing outside the workspace needs the folder named.
      for (const d of new Set(opts.addDirs ?? [])) args.push('--add-dir', d);
    } else args.push('--dangerously-bypass-approvals-and-sandbox');
    if (opts.model) args.push('-m', opts.model);
    const effort = codexEffort(opts.effort);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(...(opts.extra ?? []));
    return args;
  },
  readTurnResult: readCodexTurn,
  // Upstream doesn't take a model or effort for Codex workers: both go in launchArgs.
  spawnModel: () => undefined,
  spawnEffort: () => undefined,
};
