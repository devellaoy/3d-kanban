// Claude Code as a task agent: its per-phase flags and reading a turn from its transcript JSONL
// (see M0 in docs/fork.md). The transcript has one line per event; `type: 'assistant'` lines carry
// `message.content[]` blocks (text, tool_use), `type: 'user'` lines are prompts or tool results.

import { isClaudeModel, type ClaudeModel } from '../../../../shared/protocol.js';
import type { KanbanEffort, RunPhase } from '../../../../shared/kanban/types.js';
import { isObj, readJsonLines, type LaunchOptions, type TaskAgentAdapter, type TurnResult } from './types.js';

/** What a reviewer may never use: it reads and runs things, but changes nothing. */
export const REVIEW_DISALLOWED = ['Edit', 'Write', 'NotebookEdit'];
/** And off the web, with the review sandbox on. */
export const REVIEW_SANDBOXED = ['WebFetch', 'WebSearch'];

/**
 * The alias upstream takes for a Claude model (validateWorkerModel only knows fable, opus, sonnet and
 * haiku): a full id names its family (`claude-opus-5-5[1m]` → opus). Undefined when it names none.
 */
export function claudeAlias(model: string | undefined): ClaudeModel | undefined {
  if (!model) return undefined;
  if (isClaudeModel(model)) return model;
  const m = /(?:^|[^a-z])(fable|opus|sonnet|haiku)(?![a-z])/i.exec(model);
  return m ? (m[1].toLowerCase() as ClaudeModel) : undefined;
}

function addDirs(dirs: string[] | undefined): string[] {
  return [...new Set(dirs ?? [])].flatMap((d) => ['--add-dir', d]);
}

/** A prompt the user (or the office) typed, not a tool's result or Claude's own bookkeeping. */
function isRealPrompt(line: Record<string, unknown>): boolean {
  if (line.type !== 'user' || line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return false;
  const msg = isObj(line.message) ? line.message : undefined;
  const content = msg?.content;
  if (typeof content === 'string') return !content.startsWith('<local-command-stdout>') && !content.startsWith('<local-command-caveat>');
  if (!Array.isArray(content)) return false;
  const blocks = content.filter(isObj);
  return blocks.some((b) => b.type === 'text' || b.type === 'image') && !blocks.some((b) => b.type === 'tool_result');
}

export function readClaudeTurn(file: string): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRealPrompt(lines[i])) {
      from = i;
      break;
    }
  }
  const texts: string[] = [];
  let plan: string | undefined;
  let exitPlan = false;
  let planToolId: string | undefined;
  let apiError: string | undefined;
  let answered = false;
  for (const line of lines.slice(from + 1)) {
    if (line.isSidechain === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') {
      answered = true;
      for (const b of content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          texts.push(b.text.trim());
          if (line.isApiErrorMessage === true) apiError = b.text.trim();
        } else if (b.type === 'tool_use') {
          if (b.name === 'ExitPlanMode') {
            const input = isObj(b.input) ? b.input : {};
            plan = typeof input.plan === 'string' ? input.plan : plan;
            exitPlan = true;
            planToolId = typeof b.id === 'string' ? b.id : undefined;
          } else exitPlan = false;
        }
      }
    } else if (line.type === 'user' && planToolId) {
      // ExitPlanMode answered (approved or not): the plan is no longer what the turn ended on.
      if (content.some((b) => b.type === 'tool_result' && b.tool_use_id === planToolId)) exitPlan = false;
    }
  }
  return { text: texts.join('\n\n'), ...(plan !== undefined ? { plan } : {}), ...(exitPlan ? { exitPlan } : {}), complete: answered && (texts.length > 0 || exitPlan), ...(apiError ? { apiError } : {}) };
}

export const claudeAdapter: TaskAgentAdapter = {
  tool: 'claude',
  launchArgs(phase: RunPhase, opts: LaunchOptions): string[] {
    const args: string[] = [];
    if (phase === 'plan') args.push('--permission-mode', 'plan');
    else if (phase === 'review' || phase === 'pr-review') args.push('--permission-mode', 'bypassPermissions', '--disallowedTools', ...REVIEW_DISALLOWED, ...(opts.sandbox ? REVIEW_SANDBOXED : []));
    // implement, fix, resume, pr, pr-fix, compact, and an investigation (which writes its report
    // files: the contract keeps it off the repositories). Bash keeps the network in every phase, so a
    // pull-request review's gh works with the review sandbox on too.
    else args.push('--permission-mode', 'bypassPermissions');
    args.push(...addDirs(opts.addDirs));
    // Upstream passes the alias (spawnModel) as its own --model; a full id goes here, after it, and
    // the CLI takes the last --model it is given.
    if (opts.model && !isClaudeModel(opts.model)) args.push('--model', opts.model);
    args.push(...(opts.extra ?? []));
    return args;
  },
  readTurnResult: readClaudeTurn,
  spawnModel: claudeAlias,
  spawnEffort: (effort?: KanbanEffort) => (effort === 'minimal' ? 'low' : effort),
};
