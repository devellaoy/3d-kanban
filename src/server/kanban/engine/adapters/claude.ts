// Claude Code as a task agent: its per-phase flags and reading a turn from its transcript JSONL
// (see docs/fork.md, M0 spike results). The transcript has one line per event; `type: 'assistant'` lines carry
// `message.content[]` blocks (text, tool_use), `type: 'user'` lines are prompts or tool results.

import { isClaudeModel, type ClaudeModel } from '../../../../shared/protocol.js';
import type { KanbanEffort, RunPhase } from '../../../../shared/kanban/types.js';
import { atOf, isRealPrompt, isTaskNotification, isTeammateMessage, messageText, teammateEvents, teammatesAtWork, teammatesBusy, toolResultText, transcriptBusy } from './claude-team.js';
import { isObj, readJsonLines, type LaunchOptions, type TaskAgentAdapter, type TurnResult } from './types.js';

export { messagesSent, teammateEvents, teammateTags, teammatesBusy, type TeammateEvent } from './claude-team.js';

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

/** A notification's text, as its own turn's prompt or as an attachment inside another turn; '' for any other line. */
function notificationText(line: Record<string, unknown>): string {
  if (isTaskNotification(line)) return messageText(line);
  const att = isObj(line.attachment) ? line.attachment : undefined;
  return line.type === 'attachment' && att?.commandMode === 'task-notification' && typeof att.prompt === 'string' ? att.prompt : '';
}

/** The `<status>` values a finished background task's notification carries (seen in Claude Code's transcripts). */
const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed', 'stopped']);

/** The free-text bodies of a notification: an agent's result, a command's or monitor's output, the summary. Never read for structure. */
const FREE_TEXT = /<(result|output|summary)>[\s\S]*?<\/\1>/g;
const EVENT_BODY = /<event>[\s\S]*?<\/event>/g;

/**
 * The tasks a notification text ends, read from its headers only: the first `<task-id>`, `<status>` and
 * `<event>` of each `<task-notification>` block. The free-text bodies (result, output, summary, and an
 * event's content) are cut out first, so an agent's answer or a command's output quoting a tag (a
 * `<status>killed</status>`, another task's id, an `<event>`) steers nothing. A block ends its task when it
 * has a terminal `<status>` or none at all (the older shape); a Monitor's per-event notification has an
 * `<event>`: the monitor goes on, so it never ends it.
 */
function endedTasks(note: string): string[] {
  const headers = note.replace(FREE_TEXT, '').replace(EVENT_BODY, '<event></event>');
  const blocks = [...headers.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map((m) => m[1]);
  const ended: string[] = [];
  for (const block of blocks.length ? blocks : [headers]) {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(block)?.[1].trim();
    const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(block)?.[1];
    if (id && !block.includes('<event>') && (status === undefined || TERMINAL_STATUS.has(status))) ended.push(id);
  }
  return ended;
}

/**
 * How many background tasks the run has working: each one's last event in the log is its launch (an
 * agent, a Bash `run_in_background` command or one moved to the background by its timeout, a
 * non-persistent Monitor) or a resume (SendMessage), not its end. A task ends by a notification with a
 * terminal status, a TaskStop (or an older CLI's KillShell), or a TaskOutput that finds it finished. A persistent Monitor never ends,
 * so it isn't counted. Counted from `start`, the run's first office prompt (so an earlier run's tasks don't
 * count; -1, the log's tail cut before it: none). A launch logged before `since` (the process's start)
 * died with that process (a restart ends the helpers): not counted. A launch known only by its text counts
 * just from an Agent, Task or Bash call's result (a Bash one only with `run_in_background`, or the words of its timeout).
 * Only the lines before index `end` are read, when it is given.
 */
export function backgroundLeft(lines: Record<string, unknown>[], start: number, since?: number, end?: number): number {
  if (start < 0) return 0;
  const tasks = new Map<string, boolean>();
  // Every launch goes through here, so none can skip the restart check: a launch logged before the process started died with it.
  const launch = (id: unknown, line: Record<string, unknown>) => {
    const at = atOf(line);
    if (typeof id === 'string') tasks.set(id, since === undefined || !(at > 0 && at < since));
  };
  const ended = (id: unknown) => typeof id === 'string' && tasks.set(id, false);
  const tools = new Map<unknown, { name: unknown; input: Record<string, unknown> }>();
  for (const line of lines.slice(start + 1, end)) {
    if (line.isSidechain === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') for (const b of content) if (b.type === 'tool_use') tools.set(b.id, { name: b.name, input: isObj(b.input) ? b.input : {} });
    const res = isObj(line.toolUseResult) ? line.toolUseResult : undefined;
    if (res?.isAsync === true && res.status === 'async_launched') launch(res.agentId ?? res.taskId, line); // Agent / Task
    else if (typeof res?.resumedAgentId === 'string') launch(res.resumedAgentId, line); // SendMessage
    else if (typeof res?.backgroundTaskId === 'string') launch(res.backgroundTaskId, line); // Bash, also one its timeout moved to the background
    else if (typeof res?.taskId === 'string' && typeof res.timeoutMs === 'number') {
      if (res.persistent !== true) launch(res.taskId, line); // Monitor; a persistent one never finishes
    } else if (typeof res?.task_id === 'string' && typeof res.task_type === 'string') ended(res.task_id); // TaskStop
    else if (typeof res?.shell_id === 'string' && typeof res.message === 'string') ended(res.shell_id); // KillShell, an older CLI's TaskStop: its shape is assumed, none was seen in transcripts
    else if (isObj(res?.task) && TERMINAL_STATUS.has(String(res.task.status))) {
      // TaskOutput that finds the task finished. Only the `local_agent` shape was seen in transcripts: a Bash task's is assumed to be the same.
      ended(res.task.task_id);
    } else if (!res && line.type === 'user') {
      // Logged without a toolUseResult: the launch is read from the result text of the tools that make one.
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const tool = tools.get(b.tool_use_id);
        const text = toolResultText(b).slice(0, 500);
        if (tool?.name === 'Agent' || tool?.name === 'Task') {
          if (text.startsWith('Async agent launched successfully')) launch(/^agentId:\s*([\w-]+)/m.exec(text)?.[1], line);
        } else if (tool?.name === 'Bash') {
          // Anchored: a command's own output quoting the words is no launch. Without run_in_background only the timeout's words count.
          const timedOut = /^Command did not complete within[^\n]*?was moved to the background \(ID: (\w+)\)/.exec(text)?.[1];
          launch(timedOut ?? (tool.input.run_in_background === true ? /^Command running in background with ID: (\w+)/.exec(text)?.[1] : undefined), line);
        }
      }
    }
    const note = notificationText(line);
    if (!note) continue;
    for (const id of endedTasks(note)) ended(id);
  }
  return [...tasks.values()].filter(Boolean).length;
}

/**
 * Whether a line is an agent's notice (a background agent's notification, a teammate's message). In a log whose CLI sets `origin`
 * on its lines, a notification must carry it: one that only reads like a notification is something typed.
 */
function noticeTest(lines: Record<string, unknown>[]): (line: Record<string, unknown>) => boolean {
  const origin = lines.some((l) => l.type === 'user' && isObj(l.origin));
  return (l) => isTeammateMessage(l) || (isTaskNotification(l) && (!origin || isObj(l.origin)));
}

/** A prompt's text with its whitespace collapsed, as the office's fingerprint of what it typed (`promptHead`) is compared. */
const collapsed = (line: Record<string, unknown>) => messageText(line).replace(/\s+/g, ' ').trim();

/**
 * The index of the first real prompt, not a notification, logged at or after `at` (ms); with a `head` (the start of what the office
 * typed) the first of those that starts with it, else the first of them; when the tail was cut after it, the first of the run's prompts
 * still in it (never later than the last office prompt); -1 when none (or no timestamps).
 */
function runPrompt(lines: Record<string, unknown>[], at: number, notice: (l: Record<string, unknown>) => boolean, head?: string): number {
  const ok = (l: Record<string, unknown>) => isRealPrompt(l) && !notice(l) && atOf(l) >= at;
  const own = head ? lines.findIndex((l) => ok(l) && collapsed(l).startsWith(head)) : -1;
  return own >= 0 ? own : lines.findIndex(ok);
}

/**
 * The office's turn: the one after its last prompt (`promptAt` finds the prompt, else the last real one). Its `text` is the final answer only: the text blocks of the
 * turn's last assistant message (Claude logs one message's blocks as lines sharing its message id),
 * never what it said on the way, so a verdict or marker it quoted earlier doesn't count.
 * A last message that calls a tool (ExitPlanMode aside) isn't a final answer: the Stop hook can come
 * before Claude has logged the reply after that tool's result, so the turn isn't complete yet.
 * A prompt typed into the terminal after the office's looks the same in the log: the first real prompt after the last
 * office one (the office's own, or an agent's notification) is `typed`, and the answer is only what came before it. Its
 * turn is skipped (but for a plan, and `toolRunning`, which follow the log's end); `typedOpen` says it hasn't ended in the log.
 * `promptAt` given but its prompt not in the log yet: `unheard`, and the last prompt's turn is read as without it.
 */
export function readClaudeTurn(file: string, opts?: { since?: number; runStart?: number; promptAt?: number; promptHead?: string }): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  const notice = noticeTest(lines);
  // The last real prompt, and the office's own the background tasks are counted from: the run's first (a prompt typed into
  // the terminal meanwhile doesn't move it; the first of the run's still in the tail when its own was cut), else the last that
  // isn't a notification.
  let from = -1;
  let start = opts?.runStart !== undefined ? runPrompt(lines, opts.runStart, notice) : -1;
  const found = start >= 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isRealPrompt(lines[i])) continue;
    if (from < 0) from = i;
    if (found || !notice(lines[i])) {
      if (!found) start = i;
      break;
    }
  }
  // The office's prompt (the last it gave the run, by `promptAt`, found by the head of its text when that is given): the turn read starts at the
  // last of its own or an agent's notification after it. Any other real prompt after it is typed. Without a promptAt (the teammate gate has none)
  // the last real prompt is the turn, and nothing is typed.
  const own = opts?.promptAt !== undefined ? runPrompt(lines, opts.promptAt, notice, opts.promptHead) : -1;
  const unheard = opts?.promptAt !== undefined && own < 0;
  let cut = -1;
  if (own >= 0) {
    for (let i = lines.length - 1; i >= own; i--) {
      if (!isRealPrompt(lines[i]) || (i !== own && !notice(lines[i]))) continue;
      from = i;
      break;
    }
    cut = lines.findIndex((l, i) => i > from && isRealPrompt(l));
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
  // A plan, or an ExitPlanMode answered (approved or not: the plan is no longer what the turn ended on).
  const planned = (b: Record<string, unknown>) => {
    const input = isObj(b.input) ? b.input : {};
    plan = typeof input.plan === 'string' ? input.plan : plan;
    exitPlan = true;
    planToolId = typeof b.id === 'string' ? b.id : undefined;
  };
  const answeredPlan = (content: Record<string, unknown>[]) => {
    if (planToolId && content.some((b) => b.type === 'tool_result' && b.tool_use_id === planToolId)) exitPlan = false;
  };
  const end = cut >= 0 ? cut : lines.length;
  for (const line of lines.slice(from + 1, end)) {
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
          if (b.name === 'ExitPlanMode') planned(b);
          else {
            exitPlan = false;
            toolPending = true;
            running.add(b.id);
          }
        }
      }
    } else if (line.type === 'user') {
      for (const b of content) if (b.type === 'tool_result') running.delete(b.tool_use_id);
      answeredPlan(content);
    }
  }
  // From the typed prompt on the answer is frozen: only the plan, and the log's last message's running tools, still follow the log.
  // `after` is what the log has since its last prompt.
  const after: Record<string, unknown>[] = [];
  for (const line of cut >= 0 ? lines.slice(cut) : []) {
    if (line.isSidechain === true) continue;
    if (isRealPrompt(line)) after.length = 0;
    else after.push(line);
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') {
      if (msg?.id === undefined || msg.id !== message) running = new Set();
      message = msg?.id;
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        if (b.name === 'ExitPlanMode') planned(b);
        else {
          exitPlan = false;
          running.add(b.id);
        }
      }
    } else if (line.type === 'user') {
      for (const b of content) if (b.type === 'tool_result') running.delete(b.tool_use_id);
      answeredPlan(content);
    }
  }
  // Background agents, commands and teammates alike: the turn's Stop isn't the run's end while any still works.
  const left = backgroundLeft(lines, start, opts?.since) + teammatesBusy(file, opts?.since ?? 0, teammateEvents(lines, start));
  // The last prompt is a notification or a teammate's message nothing has answered yet: Claude is about to take its turn.
  const resuming = from >= 0 && !answered && notice(lines[from]);
  // Typed over the office's turns: those ended with background work still out (an agent, a command, a teammate at work), so their text is an interim one.
  const interim = cut >= 0 && (backgroundLeft(lines, start, opts?.since, cut) > 0 || teammatesAtWork(teammateEvents(lines, start, cut), opts?.since));
  // The typed turn isn't over in the log: the log's last prompt has no reply of text alone yet (or a tool runs).
  const open = cut >= 0 && transcriptBusy(after);
  return { text: texts.join('\n\n'), ...(plan !== undefined ? { plan } : {}), ...(exitPlan ? { exitPlan } : {}), complete: answered && !toolPending && (texts.length > 0 || exitPlan), ...(apiError ? { apiError } : {}), ...(running.size ? { toolRunning: true } : {}), ...(left ? { background: left } : {}), ...(resuming ? { resuming } : {}), ...(cut >= 0 ? { typed: true as const } : {}), ...(interim ? { interim: true as const } : {}), ...(open ? { typedOpen: true as const } : {}), ...(unheard ? { unheard: true as const } : {}) };
}

/** Claude logs an Esc on a turn as a user line "[Request interrupted by user…]" (it fires no Stop hook): whether one was logged at or after `since` (ms). */
export function claudeInterruptedSince(file: string, since: number): boolean {
  const said = (l: Record<string, unknown>) => {
    const c = isObj(l.message) ? l.message.content : undefined;
    return (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(isObj).map((b) => b.text) : []).some((t) => typeof t === 'string' && t.startsWith('[Request interrupted by user'));
  };
  return !!readJsonLines(file)?.some((l) => l.type === 'user' && atOf(l) >= since && said(l));
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
  interruptedSince: claudeInterruptedSince,
  spawnModel: claudeAlias,
  spawnEffort: (effort?: KanbanEffort) => (effort === 'minimal' ? 'low' : effort),
};
