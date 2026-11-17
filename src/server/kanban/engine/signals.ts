// What an agent's own announcement of how its turn ends does (docs/kanban-architecture.md §4, "The end of a turn"): `office-tasks done` and
// its like (the MCP tool report_turn) reach the engine as a TurnSignal, which applySignal turns into the text marker the readers in markers.ts
// look for; and the Stop hook gate (Claude only) that gives an agent that ended its turn unconfirmed, or with uncommitted work, a way to go on.

import { gateDirty, gateUnconfirmed, PLAN_READY, QUESTIONS_HEADING } from '../../../shared/kanban/prompts.js';
import type { TurnSignal } from '../../../shared/kanban/signals.js';
import type { KanbanRole, KanbanTask, KanbanTool, RunPhase } from '../../../shared/kanban/types.js';
import type { TurnResult } from './adapters/types.js';
import { finalMarker, looksInterrupted, planOutcome, prLines, reviewFindings, reviewVerdict, stripPlanMarkers, stripWorkDone, workDone } from './markers.js';
import type { HeldRun } from './turnhold.js';

// --- Small helpers of the hook handling ---------------------------------------------------------------

/** How much of a Stop hook's final answer is kept (it becomes a comment, a summary, a PR comment). */
const STOP_TEXT_MAX = 100_000;
/** A tool that asks the user a question in the terminal: Claude's AskUserQuestion, Codex's request_user_input. */
export const QUESTION_TOOL = /(?:^|[._])(?:AskUserQuestion|ask_user_question|request_user_input)$/;

/** A hook payload from a subagent or a teammate: Claude Code adds `agent_id` only to those. */
export const agentHook = (payload: unknown): boolean => typeof (payload as { agent_id?: unknown } | undefined)?.agent_id === 'string';

/** The final answer a Claude Stop hook carries (`last_assistant_message`), capped; undefined without one. */
export const stopMessage = (payload: unknown): string | undefined => {
  const last = (payload as { last_assistant_message?: unknown } | undefined)?.last_assistant_message;
  const t = typeof last === 'string' ? last.trim() : '';
  return t ? (t.length > STOP_TEXT_MAX ? `${t.slice(0, STOP_TEXT_MAX)}…` : t) : undefined;
};

// --- The announcement ---------------------------------------------------------------------------------

/** A run as the announcement follows it. */
export interface SignalRun extends HeldRun {
  stopping?: unknown;
}

const PR_PHASES = ['pr', 'pr-fix', 'pr-conflicts'];

/** What a phase's announcement may be, as the commands the agent runs. */
const takes = (phase: string) => (phase === 'plan' ? '"office-tasks plan-ready" or "office-tasks ask"' : phase === 'review' || phase === 'pr-review' ? '"office-tasks review approved|changes"' : `"office-tasks done" or "office-tasks ask"${PR_PHASES.includes(phase) ? ' and "office-tasks pr <url>"' : ''}`);
const called = (sig: TurnSignal) => (sig.kind === 'review' ? `review ${sig.verdict}` : sig.kind);

/**
 * Takes an agent's announcement for its run: the error text when the run can't take it (no run of the worker's going, one that ended or is
 * stopping, a phase the announcement doesn't belong to), else nothing. A `pr` is added to the run's reported pull requests and leaves the
 * announcement as it is; any other replaces it. It is only for the turn it was made in (see Orchestrator.prompted).
 */
export function acceptSignal(live: SignalRun | undefined, sig: TurnSignal): string | void {
  if (!live || live.ended) return 'No run of yours is going: there is nothing to report';
  if (live.stopping) return 'Your run is being stopped: there is nothing to report';
  const phase = live.phase;
  const review = phase === 'review' || phase === 'pr-review';
  const ok = phase === 'compact' ? false : phase === 'plan' ? sig.kind === 'plan-ready' || sig.kind === 'ask' : review ? sig.kind === 'review' : sig.kind === 'done' || sig.kind === 'ask' || (sig.kind === 'pr' && PR_PHASES.includes(phase));
  if (!ok) return phase === 'compact' ? 'This run only tidies its session: there is nothing to report' : `This run is in its ${phase} phase: it takes ${takes(phase)}, not "${called(sig)}"`;
  if (sig.kind === 'pr') {
    if (!/^https?:\/\//i.test(sig.url)) return 'A pull request is reported by its http(s) URL';
    const url = prLines(`PR: ${sig.url}`)[0]?.url ?? sig.url;
    const had = (live.signalPrs ??= []);
    if (!had.some((u) => u.toLowerCase() === url.toLowerCase())) had.push(url);
    return;
  }
  live.signal = sig.kind === 'review' ? { kind: 'review', verdict: sig.verdict } : { kind: sig.kind };
}

/** What an announcement makes of the turn's final text. */
export interface Applied {
  /** The text with the announcement written into it as the marker the readers look for. */
  text: string;
  /** Something the task's conversation should say about it. */
  note?: string;
  /** The agent asks the user (a phase that is not a plan): the run ends and the task waits for the answer. */
  asked?: true;
}

/**
 * The final text as the agent's announcement says it should read, so that the readers downstream (planOutcome, reviewVerdict, prLines, workDone)
 * take it as if the agent had written it. Undefined: the announcement decides nothing, and the text is read as it is. An announcement alone
 * never ends a turn with no answer (empty text), and one that `approved` a review doesn't approve it unless the text says so too: anything in
 * the reviewer's shell holds the hook token, the verdict in the lead's own final answer is the stronger statement.
 */
export function applySignal(phase: RunPhase, text: string, signal: NonNullable<HeldRun['signal']>, prs: string[]): Applied | undefined {
  if (!text.trim()) return undefined;
  const t = text.trim();
  const review = phase === 'review' || phase === 'pr-review';
  if (phase === 'plan') {
    if (signal.kind === 'plan-ready') return { text: finalMarker('plan', t) && planOutcome(t) === 'ready' ? t : `${t}\n\n${PLAN_READY}` };
    if (signal.kind !== 'ask') return undefined;
    const bare = stripPlanMarkers(t);
    return { text: finalMarker('plan', bare) ? bare : `${QUESTIONS_HEADING}\n${bare}` };
  }
  if (review) {
    if (signal.kind !== 'review') return undefined;
    if (signal.verdict === 'approved') return finalMarker(phase, t) && reviewVerdict(t) === 'approved' ? { text: t } : undefined;
    const said = reviewVerdict(t) === 'approved';
    return { text: `${reviewFindings(t)}\nREVIEW: CHANGES_REQUESTED`.trim(), ...(said ? { note: 'The reviewer announced changes requested while its answer said approved: taken as changes requested' } : {}) };
  }
  if (signal.kind === 'ask') return { text: stripWorkDone(t), asked: true };
  if (signal.kind !== 'done') return undefined;
  const have = new Set(prLines(t).map((p) => p.url.toLowerCase()));
  let out = t;
  for (const url of prs) if (!have.has(url.toLowerCase())) out += `\nPR: ${url}`;
  return { text: workDone(out) ? out : `${out}\nWORK DONE` };
}

/** Forgets the run's announcement (and the pull requests it reported): it only applies to the turn it was made in. */
export function expireSignal(live: HeldRun) {
  live.signal = undefined;
  live.signalPrs = undefined;
}

// --- The Stop hook gate -------------------------------------------------------------------------------

/** A run as the Stop hook gate follows it. */
export interface GateRun extends SignalRun {
  tool: KanbanTool;
  role: KanbanRole;
}

/** What the gate borrows from the orchestrator. */
export interface StopGateDeps<L extends GateRun> {
  task(id: number): Pick<KanbanTask, 'id' | 'project' | 'type'> | undefined;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  /** The run's turn as its session log has it now. */
  read(live: L): Promise<TurnResult | undefined>;
  /** The worktree-relative folders of the run's workspace with uncommitted changes (none for a folder project). */
  uncommitted(live: L): Promise<string[]>;
  /** How many Stops of a run may be blocked at most (0: the gate is off). */
  maxBlocks(): number;
  /** The pause between two reads of the log (ms). */
  readPauseMs(): number;
  /** How long the whole decision may take before the Stop is let through (ms; 10 s). */
  deadlineMs?: number;
}

/** The phases whose end is no WORK DONE: never gated. */
const UNGATED = ['plan', 'review', 'pr-review', 'compact'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Stop hook gate: a Claude implementer's Stop that is no end of its work (it neither said it was done nor announced it) or leaves uncommitted
 * changes behind is answered with `block`, the text the agent then reads as the hook's feedback and goes on from. A Stop is let through whenever
 * anything is unclear (a log still behind, work running, an interrupted turn, a decision that takes long), and after the run's `maxBlocks` blocks
 * (with a note, once), so that the gate can never keep an agent from ending its turn.
 */
export class StopGate<L extends GateRun> {
  constructor(private deps: StopGateDeps<L>) {}

  /** `block`: the text to hand back to the agent (its Stop does not end the turn); an empty answer lets the Stop through. Never throws. */
  async decide(live: L | undefined, payload: unknown): Promise<{ block?: string }> {
    let timer: NodeJS.Timeout | undefined;
    // Past the deadline the Stop has been let through: a judgement that comes later must not count a block nobody was told of.
    const late = { is: false };
    try {
      const deadline = new Promise<{ block?: string }>((resolve) => {
        timer = setTimeout(() => ((late.is = true), resolve({})), this.deps.deadlineMs ?? 10_000);
      });
      return await Promise.race([this.judge(live, payload, late), deadline]);
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  private async judge(live: L | undefined, payload: unknown, late: { is: boolean }): Promise<{ block?: string }> {
    const max = this.deps.maxBlocks();
    if (!live || max <= 0 || live.ended || live.tool !== 'claude' || live.role !== 'implementer' || agentHook(payload)) return {};
    if (UNGATED.includes(live.phase) || live.stopping || live.restating || live.signal?.kind === 'ask') return {};
    const p = (payload ?? {}) as { stop_hook_active?: unknown; background_tasks?: unknown };
    if (Array.isArray(p.background_tasks) && p.background_tasks.some((b) => (b as { status?: unknown } | null)?.status === 'running')) return {};
    const blocks = Math.max(live.gateBlocks ?? 0, p.stop_hook_active === true ? 1 : 0);
    // The log lags a Stop: read again a moment before it is taken for what it shows.
    let r = await this.deps.read(live);
    for (let i = 0; i < 2 && !r?.complete; i++) {
      await sleep(this.deps.readPauseMs());
      r = await this.deps.read(live);
    }
    if (r && (r.background || r.resuming || r.unheard || r.typed || r.toolRunning)) return {};
    const said = stopMessage(payload) ?? r?.text ?? '';
    if (looksInterrupted(said, r?.apiError)) return {};
    const done = live.signal?.kind === 'done';
    // Nothing to judge it on: the log shows no answer and the Stop carried none.
    if (!done && !said.trim()) return {};
    const task = this.deps.task(live.taskId);
    if (!task) return {};
    let folders: string[] = [];
    if (done || finalMarker(live.phase, said)) {
      if (task.type !== 'investigate') folders = await this.deps.uncommitted(live);
      if (!folders.length) return {};
    }
    if (late.is) return {};
    if (blocks >= max) {
      if (!live.gateNoted) {
        live.gateNoted = true;
        this.deps.note(task, folders.length ? `Its agent ended its turn with uncommitted changes in ${folders.join(', ')}, even when the office asked twice: went on as before` : 'Its agent ended its turn without saying it was done, even when the office asked twice: went on as before', live.runId);
      }
      return {};
    }
    live.gateBlocks = blocks + 1;
    live.gated = true;
    live.signal = undefined;
    live.lastHookAt = Date.now();
    return { block: folders.length ? gateDirty(folders) : gateUnconfirmed() };
  }
}
