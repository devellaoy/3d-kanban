// Antigravity (`agy`) as a task agent: its per-phase flags and reading a turn from its conversation
// transcript (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl). One step per
// line: `{ step_index, source, type, status, created_at, content?, tool_calls?, error? }`. The log has no
// end-of-turn line: a turn is over when its last step is the model's answer (a PLANNER_RESPONSE without tool calls).

import type { KanbanEffort, RunPhase } from '../../../../shared/kanban/types.js';
import { officeReceipts } from './office.js';
import { isObj, OFFICE_PROMPT_WAIT_MS, readJsonLines, type LaunchOptions, type ReadOpts, type TaskAgentAdapter, type TurnResult } from './types.js';

/** Antigravity's efforts are low…xhigh: minimal is low, max is xhigh. */
function antigravityEffort(effort: KanbanEffort | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === 'minimal' ? 'low' : effort === 'max' ? 'xhigh' : effort;
}

/** A step's time in ms, as the latest moment it may have happened: `created_at` has second precision, so a step is "at or after" a prompt of the same second. */
const stepAt = (l: Record<string, unknown>): number => Date.parse(String(l.created_at)) + 999;

/** The text of a USER_INPUT step: what the person (or the office) typed, between the USER_REQUEST tags (else the whole content). */
function requestText(l: Record<string, unknown>): string | undefined {
  if (l.type !== 'USER_INPUT') return undefined;
  const c = typeof l.content === 'string' ? l.content : '';
  return /^<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/.exec(c)?.[1] ?? c;
}

/** The model's answer step: a PLANNER_RESPONSE with text and no tool calls. */
const isAnswer = (l: Record<string, unknown>): boolean => l.type === 'PLANNER_RESPONSE' && typeof l.content === 'string' && !!l.content.trim() && !(Array.isArray(l.tool_calls) && l.tool_calls.length);

/** The turn after the last prompt; its `text` is the last answer step. */
export function readAntigravityTurn(file: string, opts?: ReadOpts): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (requestText(lines[i]) !== undefined) {
      from = i;
      break;
    }
  }
  const turn = lines.slice(from + 1);
  const answer = [...turn].reverse().find(isAnswer);
  const last = turn[turn.length - 1];
  const complete = !!last && isAnswer(last) && last.status === 'DONE';
  // An API error the CLI retried through (a response follows it) is not the turn's end.
  let apiError: string | undefined;
  for (const l of turn) {
    if (l.type === 'ERROR_MESSAGE' && typeof l.error === 'string') apiError = l.error;
    else if (l.type === 'PLANNER_RESPONSE') apiError = undefined;
  }
  const text = (typeof answer?.content === 'string' ? answer.content : '').trim() || (apiError ?? '');
  // The comments the office typed that the log has no prompt for yet make the turn read an earlier one (see readCodexTurn).
  const users = lines.flatMap((l) => (requestText(l) !== undefined ? [{ at: stepAt(l), text: requestText(l)!.replace(/\s+/g, ' ') }] : []));
  const seen = (at: number, head?: string) => users.some((u) => u.at >= at && (!head || u.text.includes(head)));
  const expired = (at: number) => Date.now() - at >= OFFICE_PROMPT_WAIT_MS;
  const prompts = opts?.officePrompts ?? [];
  const first = lines.cut ? lines.reduce((m, l) => Math.min(m, Date.parse(String(l.created_at)) || Infinity), Infinity) : Infinity;
  const { received, fresh } = officeReceipts(prompts, users, (t, head) => t.includes(head), Number.isFinite(first) ? first : undefined);
  const waiting = prompts.map((p, i) => ({ p, i })).filter(({ i }) => !received.has(i));
  const launching = opts?.promptAt !== undefined && users.length > 0 && users[users.length - 1].at < opts.promptAt && !seen(opts.promptAt, opts.promptHead);
  const lost = {
    ...(launching && expired(opts!.promptAt!) ? { launch: true as const } : {}),
    office: waiting.filter(({ p }) => expired(p.at)).map(({ i }) => i),
  };
  const isLost = !!lost.launch || lost.office.length > 0;
  const unheard = (launching && !lost.launch) || waiting.some(({ p }) => !expired(p.at));
  return { text, complete, ...(apiError ? { apiError } : {}), ...(unheard ? { unheard: true as const } : {}), ...(isLost ? { lost } : {}), ...(waiting.length ? { waiting: waiting.map(({ i }) => i) } : {}), ...(fresh.length ? { seen: fresh } : {}) };
}

export const antigravityAdapter: TaskAgentAdapter = {
  tool: 'antigravity',
  launchArgs(phase: RunPhase, opts: LaunchOptions): string[] {
    // No sandbox the office can rely on (--sandbox stopped neither writes outside the workspace nor the network), so every
    // phase runs with all permissions; plan mode only advises. opts.addDirs/readDirs aren't passed: with --add-dir the agent's shell
    // commands ran with their cwd in the added folder instead of the workspace, and it reads anywhere anyway.
    const args = ['--dangerously-skip-permissions'];
    if (phase === 'plan' || phase === 'review') args.push('--mode', 'plan');
    if (opts.model) args.push('--model', opts.model);
    const effort = antigravityEffort(opts.effort);
    if (effort) args.push('--effort', effort);
    args.push(...(opts.extra ?? []));
    return args;
  },
  readTurnResult: readAntigravityTurn,
  // The transcript names no prompt: a USER_INPUT at or after the time the office typed it, carrying `head` when there is one, is the one.
  promptReceived: (file, at, head) => readJsonLines(file)?.some((l) => {
    const text = requestText(l);
    return text !== undefined && stepAt(l) >= at && (!head || text.replace(/\s+/g, ' ').includes(head));
  }),
  // Both go in launchArgs, like Codex.
  spawnModel: () => undefined,
  spawnEffort: () => undefined,
};
