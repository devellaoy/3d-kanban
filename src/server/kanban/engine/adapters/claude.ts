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

function messageText(line: Record<string, unknown>): string {
  const content = isObj(line.message) ? line.message.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isObj).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

function toolResultText(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(isObj).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}

/**
 * Claude Code's own prompt to itself when a background agent finishes. Older CLIs set no origin, so
 * only a line without one is told by its text: a typed prompt (origin human) quoting the tag isn't it.
 */
function isTaskNotification(line: Record<string, unknown>): boolean {
  if (line.type !== 'user') return false;
  if (isObj(line.origin)) return line.origin.kind === 'task-notification';
  return messageText(line).startsWith('<task-notification>');
}

/** A notification's text, as its own turn's prompt or as an attachment inside another turn; '' for any other line. */
function notificationText(line: Record<string, unknown>): string {
  if (isTaskNotification(line)) return messageText(line);
  const att = isObj(line.attachment) ? line.attachment : undefined;
  return line.type === 'attachment' && att?.commandMode === 'task-notification' && typeof att.prompt === 'string' ? att.prompt : '';
}

/**
 * How many background agents the run has working: each one's last event in the log is its launch or a
 * resume (SendMessage), not a notification. Counted from `start`, the office's last prompt (so an
 * earlier run's agents don't count; -1, the log's tail cut before it: none). Bash's run_in_background
 * isn't one, and a launch known only by its text counts just from an Agent or Task call's result.
 */
export function backgroundLeft(lines: Record<string, unknown>[], start: number): number {
  if (start < 0) return 0;
  const agents = new Map<string, boolean>();
  const tools = new Map<unknown, unknown>();
  for (const line of lines.slice(start + 1)) {
    if (line.isSidechain === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') for (const b of content) if (b.type === 'tool_use') tools.set(b.id, b.name);
    const res = isObj(line.toolUseResult) ? line.toolUseResult : undefined;
    if (res?.isAsync === true && res.status === 'async_launched') {
      const id = res.agentId ?? res.taskId;
      if (typeof id === 'string') agents.set(id, true);
    } else if (typeof res?.resumedAgentId === 'string') agents.set(res.resumedAgentId, true);
    else if (!res && line.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result' || (tools.get(b.tool_use_id) !== 'Agent' && tools.get(b.tool_use_id) !== 'Task')) continue;
        const text = toolResultText(b);
        const id = text.startsWith('Async agent launched successfully') ? /^agentId:\s*([\w-]+)/m.exec(text)?.[1] : undefined;
        if (id) agents.set(id, true);
      }
    }
    for (const m of notificationText(line).matchAll(/<task-id>([^<]*)<\/task-id>/g)) agents.set(m[1].trim(), false);
  }
  return [...agents.values()].filter(Boolean).length;
}

/**
 * The turn after the last real prompt. Its `text` is the final answer only: the text blocks of the
 * turn's last assistant message (Claude logs one message's blocks as lines sharing its message id),
 * never what it said on the way, so a verdict or marker it quoted earlier doesn't count.
 * A last message that calls a tool (ExitPlanMode aside) isn't a final answer: the Stop hook can come
 * before Claude has logged the reply after that tool's result, so the turn isn't complete yet.
 */
export function readClaudeTurn(file: string): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  // The last real prompt, and the office's own (the last that isn't a notification) the agents are counted from.
  let from = -1;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isRealPrompt(lines[i])) continue;
    if (from < 0) from = i;
    if (!isTaskNotification(lines[i])) {
      start = i;
      break;
    }
  }
  let texts: string[] = [];
  let message: unknown;
  let plan: string | undefined;
  let exitPlan = false;
  let planToolId: string | undefined;
  let apiError: string | undefined;
  let answered = false;
  let toolPending = false;
  // The last message's tool calls still without a result in the log.
  let running = new Set<unknown>();
  for (const line of lines.slice(from + 1)) {
    if (line.isSidechain === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') {
      answered = true;
      // A new message: what an earlier one said is no longer the final answer.
      const id = msg?.id;
      if (id === undefined || id !== message) {
        texts = [];
        apiError = undefined;
        toolPending = false;
        running = new Set();
      }
      message = id;
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
          } else {
            exitPlan = false;
            toolPending = true;
            running.add(b.id);
          }
        }
      }
    } else if (line.type === 'user') {
      for (const b of content) if (b.type === 'tool_result') running.delete(b.tool_use_id);
      // ExitPlanMode answered (approved or not): the plan is no longer what the turn ended on.
      if (planToolId && content.some((b) => b.type === 'tool_result' && b.tool_use_id === planToolId)) exitPlan = false;
    }
  }
  const left = backgroundLeft(lines, start);
  // The last prompt is a notification nothing has answered yet: Claude is about to take its turn.
  const resuming = from >= 0 && !answered && isTaskNotification(lines[from]);
  return { text: texts.join('\n\n'), ...(plan !== undefined ? { plan } : {}), ...(exitPlan ? { exitPlan } : {}), complete: answered && !toolPending && (texts.length > 0 || exitPlan), ...(apiError ? { apiError } : {}), ...(running.size ? { toolRunning: true } : {}), ...(left ? { background: left } : {}), ...(resuming ? { resuming } : {}) };
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
