// Claude Code as a task agent: its per-phase flags and reading a turn from its transcript JSONL
// (see docs/fork.md, M0 spike results). The transcript has one line per event; `type: 'assistant'` lines carry
// `message.content[]` blocks (text, tool_use), `type: 'user'` lines are prompts or tool results.

import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * A teammate's message to the lead (agent teams): a `user` line with no origin, as the lead gets it, whose
 * text is "Another Claude session sent a message:" and its `<teammate-message>` tags. It is no prompt of
 * the office's, and a typed prompt quoting the tag (origin human) isn't it.
 */
function isTeammateMessage(line: Record<string, unknown>): boolean {
  if (line.type !== 'user' || (isObj(line.origin) && line.origin.kind === 'human')) return false;
  const text = messageText(line).trimStart();
  return text.startsWith('<teammate-message') || (text.startsWith('Another Claude session sent a message') && text.includes('<teammate-message'));
}

/** A line the agent sends itself (a background agent's notification, a teammate's message), not one the office prompted. */
const isAgentNotice = (line: Record<string, unknown>): boolean => isTaskNotification(line) || isTeammateMessage(line);

/** A teammate's name from a teammate id or a routing target: `server-impl@session-1` → `server-impl`. */
const teammateName = (v: unknown): string | undefined => (typeof v === 'string' && v.replace(/^@/, '').split('@')[0]) || undefined;

/** A `<teammate-message>` opening tag and its attributes. */
const OPEN_TAG = /<teammate-message((?:\s+[\w-]+="[^"]*")*)\s*>/g;

/**
 * The `<teammate-message>` tags of a line's text: who sent each, and for a JSON body (an idle notification
 * and the like) its `type`, `summary` and own `timestamp` (`at`, ms). The body is the text between the
 * tags, parsed whole: it can hold `}` and `>` (a result's code), which a pattern for the JSON would cut short.
 */
export function teammateTags(text: string): { from: string; type?: string; summary?: string; at?: number }[] {
  const out: { from: string; type?: string; summary?: string; at?: number }[] = [];
  const close = '</teammate-message>';
  let at = 0;
  for (;;) {
    // Each closing tag by indexOf: a lazy pattern across the body rescans a long text from every opening tag.
    OPEN_TAG.lastIndex = at;
    const m = OPEN_TAG.exec(text);
    if (!m) break;
    const bodyAt = m.index + m[0].length;
    const end = text.indexOf(close, bodyAt);
    if (end < 0) break;
    at = end + close.length;
    let from = teammateName(/\bteammate_id="([^"]*)"/.exec(m[1])?.[1]);
    let type: string | undefined;
    let summary: string | undefined;
    let when: number | undefined;
    try {
      const body = JSON.parse(text.slice(bodyAt, end).trim()) as unknown;
      if (isObj(body)) {
        if (typeof body.type === 'string') type = body.type;
        if (typeof body.summary === 'string') summary = body.summary;
        if (typeof body.timestamp === 'string') when = Date.parse(body.timestamp) || undefined;
        from = teammateName(body.from) ?? from;
      }
    } catch {
      // a report in words, not JSON
    }
    if (from) out.push({ from, ...(type ? { type } : {}), ...(summary ? { summary } : {}), ...(when ? { at: when } : {}) });
  }
  return out;
}

/** What the lead's log says of a teammate: it was woken (busy) or went to rest, when. `*`: every teammate (a broadcast). */
export interface TeammateEvent {
  name: string;
  busy: boolean;
  at: number;
  /** A spawn: it makes the name a teammate (a wake of any other name, the lead's say, is no teammate's). */
  spawn?: true;
  /** A wake read off an idle notification's `[to Y]` summary: the sender, whose own transcript knows the send's real time. */
  relayedBy?: string;
}

const atOf = (line: Record<string, unknown>): number => (typeof line.timestamp === 'string' ? Date.parse(line.timestamp) || 0 : 0);

/**
 * The messages sent (SendMessage) in a log from `start` on, each a wake (busy) of its recipient at the
 * line's own time: SendMessage's `routing.target`, else (an older CLI) the call's `to`. The recipient may
 * be no teammate (the lead, `main`): the caller drops such names. Split out of `teammateEvents` so a
 * teammate's transcript can reuse it; the lead's log is walked twice, which is cheap.
 */
export function messagesSent(lines: Record<string, unknown>[], start: number): TeammateEvent[] {
  const events: TeammateEvent[] = [];
  const tools = new Map<unknown, { name: unknown; input: Record<string, unknown> }>();
  for (const line of lines.slice(start + 1)) {
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') for (const b of content) if (b.type === 'tool_use') tools.set(b.id, { name: b.name, input: isObj(b.input) ? b.input : {} });
    if (line.type !== 'user' || isTeammateMessage(line)) continue;
    const res = isObj(line.toolUseResult) ? line.toolUseResult : undefined;
    if (res?.success === false) continue;
    const routing = isObj(res?.routing) ? res.routing : undefined;
    if (typeof routing?.target === 'string') {
      const to = routing.target.replace(/^@/, '');
      if (to) events.push({ name: to, busy: true, at: atOf(line) });
      continue;
    }
    if (res) continue;
    // No toolUseResult (an older CLI): the call's own words.
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const call = tools.get(b.tool_use_id);
      if (call?.name === 'SendMessage' && typeof call.input.to === 'string') events.push({ name: call.input.to.replace(/^@/, ''), busy: true, at: atOf(line) });
    }
  }
  return events;
}

/**
 * The teammate events in the lead's log from `start` on: a spawn (`teammate_spawned`, or its "Spawned
 * successfully" text) or a message the lead sent to one (`messagesSent`) wakes it (only a teammate: one
 * spawned, or with a transcript, never the lead a teammate reports to); an idle notification (or shutdown,
 * termination) lets its sender rest, dated by the notification's own timestamp (it can reach the lead
 * minutes late: a stale idle must not override a later wake). Its `[to Y]` summary names the sender's latest peer DM, which can be
 * long answered (the notification can reach the lead minutes late), so that wake is only a fallback, marked
 * `relayedBy` its sender: a teammate's own transcript is the truth for its peer DMs (`teammatesBusy`), and
 * the summary counts only for a sender whose transcript can't be read.
 */
export function teammateEvents(lines: Record<string, unknown>[], start: number): TeammateEvent[] {
  const events: TeammateEvent[] = [];
  if (start < 0) return events;
  const tools = new Map<unknown, { name: unknown; input: Record<string, unknown> }>();
  for (const line of lines.slice(start + 1)) {
    const lineAt = atOf(line);
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') for (const b of content) if (b.type === 'tool_use') tools.set(b.id, { name: b.name, input: isObj(b.input) ? b.input : {} });
    if (isTeammateMessage(line)) {
      for (const t of teammateTags(messageText(line))) {
        // The body's own time, when it went idle: the notification can reach the lead minutes after.
        const at = t.at ?? lineAt;
        if (t.type === 'idle_notification' || t.type === 'shutdown_approved' || t.type === 'teammate_terminated') events.push({ name: t.from, busy: false, at });
        const to = t.type === 'idle_notification' ? /^\[to ([^\]\s]+)\]/.exec(t.summary ?? '')?.[1] : undefined;
        if (to) events.push({ name: teammateName(to) ?? to, busy: true, at, relayedBy: t.from });
      }
      continue;
    }
    if (line.type !== 'user') continue;
    const res = isObj(line.toolUseResult) ? line.toolUseResult : undefined;
    if (res?.status === 'teammate_spawned') {
      const name = teammateName(res.name ?? res.teammate_id);
      if (name) events.push({ name, busy: true, at: lineAt, spawn: true });
      continue;
    }
    if (res) continue;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const call = tools.get(b.tool_use_id);
      if (call?.name === 'Agent' && typeof call.input.name === 'string' && toolResultText(b).startsWith('Spawned successfully')) events.push({ name: call.input.name, busy: true, at: lineAt, spawn: true });
    }
  }
  return [...events, ...messagesSent(lines, start)];
}

/** Whether a teammate's own transcript ends mid-work: a message or tool result in for it to answer, or its last message isn't text alone, or nothing said yet. */
function transcriptBusy(lines: Record<string, unknown>[]): boolean {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === 'assistant') {
      last = i;
      break;
    }
  }
  if (last < 0) return true;
  // At rest only after a message of text alone: a tool call, or thinking not yet followed by its text, is work under way.
  const msg = lines[last].message;
  const blocks = isObj(msg) && Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
  if (!blocks.length || blocks.some((b) => b.type !== 'text')) return true;
  return lines.slice(last + 1).some((l) => l.type === 'user' || (l.type === 'attachment' && isObj(l.attachment) && l.attachment.type === 'queued_command'));
}

/** A teammate's transcript is read from its last 512 KB: enough for its last message and what follows. */
const TEAMMATE_TAIL = 512 * 1024;

/**
 * How many of the run's teammates (agent teams) are working, counted from their own transcripts, which
 * Claude Code keeps next to the lead's at `<log without .jsonl>/subagents/agent-*.jsonl` with a `.meta.json`
 * (`taskKind: in_process_teammate`). They live as long as the Claude process: one whose last line is older
 * than `since`, the process's start, died with an earlier one (its file's mtime says so, unread). Of the
 * transcripts of one name (a respawn) the one written last speaks. The lead's log `events` newer than a
 * teammate's last line override it (its transcript lags what the lead sent it); one with no transcript
 * yet is busy when the lead spawned it, and one whose transcript can't be read is busy too: an error is
 * no rest. A teammate's message to another is read from the sender's own transcript, at its own time, and
 * wakes the recipient; the sender's idle-notification `[to Y]` summary (`relayedBy`) counts only when that
 * transcript wasn't read, as it can reach the lead minutes late, naming a message already answered.
 * (A meta that can't be read or parsed is skipped: it is being written, and the spawn event covers it.)
 */
export function teammatesBusy(leadFile: string, since: number, events: TeammateEvent[]): number {
  const dir = `${leadFile.replace(/\.jsonl$/, '')}/subagents`;
  // Per teammate name: its transcript's last line (ms) and whether it ends mid-work.
  const own = new Map<string, { last: number; busy: boolean }>();
  // The peer DMs the transcripts read hold, and whose transcripts those were.
  const sent: TeammateEvent[] = [];
  // Keyed by `teammateName`, as an event's `relayedBy` is: the two must match, or a summary isn't suppressed.
  const read = new Set<string>();
  let metas: string[] = [];
  try {
    metas = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    // no teammates, or no folder yet
  }
  for (const f of metas) {
    let name: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as unknown;
      if (!isObj(meta) || meta.taskKind !== 'in_process_teammate') continue;
      name = teammateName(meta.name ?? meta.agentType);
    } catch {
      // a meta being written
    }
    if (!name) continue;
    const file = `${dir}/${f.replace(/\.meta\.json$/, '.jsonl')}`;
    let last = -1;
    let busy = true;
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime < since) {
        // Written last before the process began: dead, whatever it ended on.
        last = mtime;
        busy = false;
      } else {
        const lines = readJsonLines(file, TEAMMATE_TAIL);
        if (lines) {
          for (let i = lines.length - 1; i >= 0 && last < 0; i--) last = atOf(lines[i]) || -1;
          busy = transcriptBusy(lines);
          sent.push(...messagesSent(lines, -1));
          read.add(name);
        } else last = Infinity;
      }
    } catch {
      // no transcript yet, or one that can't be read: busy, and newer than any word of the lead's
      last = Infinity;
    }
    const cur = own.get(name);
    if (!cur || last > cur.last || (last === cur.last && busy)) own.set(name, { last, busy });
  }
  // A name no spawn or meta makes a teammate (the lead's own, in a teammate's "[to main]") is never counted.
  for (const e of events) if (e.spawn && !own.has(e.name)) own.set(e.name, { last: -1, busy: true });
  // The newest word the lead's log has of each name since the process began, and of a broadcast.
  // On the same ms a wake beats a rest: an error on the side of working, as `own` does.
  const newer = (e: TeammateEvent, than: TeammateEvent) => e.at > than.at || (e.at === than.at && e.busy);
  const word = new Map<string, TeammateEvent>();
  let all: TeammateEvent | undefined;
  for (const e of [...events, ...sent]) {
    if (e.at < since || (e.relayedBy && read.has(e.relayedBy))) continue;
    // A broadcast counts only when it woke (busy): a rest is no one's but its sender's.
    if (e.name === '*') {
      if (e.busy && (!all || newer(e, all))) all = e;
    } else if (!word.has(e.name) || newer(e, word.get(e.name)!)) word.set(e.name, e);
  }
  let busy = 0;
  for (const [name, { last, busy: tail }] of own) {
    // Matching a broadcast to a name is harmless even for one spawned after it: the spawn event is always newer than the broadcast, so it wins.
    const named = word.get(name);
    const newest = named && (!all || named.at >= all.at) ? named : all;
    // The newest word, when that is newer than the teammate's own last line.
    if (newest && newest.at > last ? newest.busy : last >= since && tail) busy++;
  }
  return busy;
}

/** A notification's text, as its own turn's prompt or as an attachment inside another turn; '' for any other line. */
function notificationText(line: Record<string, unknown>): string {
  if (isTaskNotification(line)) return messageText(line);
  const att = isObj(line.attachment) ? line.attachment : undefined;
  return line.type === 'attachment' && att?.commandMode === 'task-notification' && typeof att.prompt === 'string' ? att.prompt : '';
}

/** The `<status>` values a finished background task's notification carries (seen in Claude Code's transcripts). */
const TERMINAL_STATUS = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * Whether one `<task-notification>` block ends its task: it has a terminal `<status>`, or no status at
 * all (the older shape). A Monitor's per-event notification has an `<event>` and no status: the monitor
 * goes on, so it doesn't end it.
 */
const endsTask = (block: string): boolean => {
  const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(block)?.[1];
  return status !== undefined ? TERMINAL_STATUS.has(status) : !/<event>/.test(block);
};

/**
 * How many background tasks the run has working: each one's last event in the log is its launch (an
 * agent, a Bash `run_in_background` command or one moved to the background by its timeout, a
 * non-persistent Monitor) or a resume (SendMessage), not its end. A task ends by a notification with a
 * terminal status, a TaskStop, or a TaskOutput that finds it finished. A persistent Monitor never ends,
 * so it isn't counted. Counted from `start`, the office's last prompt (so an earlier run's tasks don't
 * count; -1, the log's tail cut before it: none). A launch known only by its text counts just from an
 * Agent, Task or Bash call's result.
 */
export function backgroundLeft(lines: Record<string, unknown>[], start: number): number {
  if (start < 0) return 0;
  const tasks = new Map<string, boolean>();
  const tools = new Map<unknown, unknown>();
  for (const line of lines.slice(start + 1)) {
    if (line.isSidechain === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    const content = Array.isArray(msg?.content) ? msg.content.filter(isObj) : [];
    if (line.type === 'assistant') for (const b of content) if (b.type === 'tool_use') tools.set(b.id, b.name);
    const res = isObj(line.toolUseResult) ? line.toolUseResult : undefined;
    if (res?.isAsync === true && res.status === 'async_launched') {
      const id = res.agentId ?? res.taskId;
      if (typeof id === 'string') tasks.set(id, true);
    } else if (typeof res?.resumedAgentId === 'string') tasks.set(res.resumedAgentId, true);
    else if (typeof res?.backgroundTaskId === 'string') tasks.set(res.backgroundTaskId, true);
    else if (typeof res?.taskId === 'string' && typeof res.timeoutMs === 'number') {
      if (res.persistent !== true) tasks.set(res.taskId, true);
    } else if (typeof res?.task_id === 'string' && typeof res.task_type === 'string') tasks.set(res.task_id, false);
    else if (isObj(res?.task) && typeof res.task.task_id === 'string' && TERMINAL_STATUS.has(String(res.task.status))) tasks.set(res.task.task_id, false);
    else if (!res && line.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const tool = tools.get(b.tool_use_id);
        const text = tool === 'Agent' || tool === 'Task' || tool === 'Bash' ? toolResultText(b) : '';
        const id = text.startsWith('Async agent launched successfully')
          ? /^agentId:\s*([\w-]+)/m.exec(text)?.[1]
          : /^Command running in background with ID: (\w+)/.exec(text)?.[1] ?? /was moved to the background \(ID: (\w+)\)/.exec(text)?.[1];
        if (id) tasks.set(id, true);
      }
    }
    const note = notificationText(line);
    const blocks = [...note.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map((m) => m[1]);
    for (const block of blocks.length ? blocks : note ? [note] : []) {
      if (!endsTask(block)) continue;
      for (const m of block.matchAll(/<task-id>([^<]*)<\/task-id>/g)) tasks.set(m[1].trim(), false);
    }
  }
  return [...tasks.values()].filter(Boolean).length;
}

/**
 * The turn after the last real prompt. Its `text` is the final answer only: the text blocks of the
 * turn's last assistant message (Claude logs one message's blocks as lines sharing its message id),
 * never what it said on the way, so a verdict or marker it quoted earlier doesn't count.
 * A last message that calls a tool (ExitPlanMode aside) isn't a final answer: the Stop hook can come
 * before Claude has logged the reply after that tool's result, so the turn isn't complete yet.
 */
export function readClaudeTurn(file: string, opts?: { since?: number }): TurnResult | undefined {
  const lines = readJsonLines(file);
  if (!lines) return undefined;
  // The last real prompt, and the office's own (the last that isn't a notification) the background tasks are counted from.
  let from = -1;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isRealPrompt(lines[i])) continue;
    if (from < 0) from = i;
    if (!isAgentNotice(lines[i])) {
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
  // Background agents, commands and teammates alike: the turn's Stop isn't the run's end while any still works.
  const left = backgroundLeft(lines, start) + teammatesBusy(file, opts?.since ?? 0, teammateEvents(lines, start));
  // The last prompt is a notification or a teammate's message nothing has answered yet: Claude is about to take its turn.
  const resuming = from >= 0 && !answered && isAgentNotice(lines[from]);
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
