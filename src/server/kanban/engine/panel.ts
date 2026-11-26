// A review round with additional reviewers (docs/kanban-architecture.md §4, "Review panel"). The state machine knows nothing of it: the
// round is made of ordinary review runs, and the machine still gets exactly one `reviewed` event for it.
//
//   solo     the main reviewer's own review (seat 0); its end publishes nothing, it hands over to `settle`
//   co       one run per additional reviewer (seat 1..4), each on a worker of its own in the task's worktree
//   combine  the main reviewer once more (seat 0), typed with the other reviewers' findings; its verdict is the round's
//
// Everything a co-reviewer's run does stays here: its end, its question, its exit, its departure. Nothing of it is a task comment or a
// machine event. The state is derived from the run rows (`view`) and `task.coReviewers`, so it survives an office restart; only the
// deadline timers live in memory (`recover` sets them again).

import type { Floor } from '../../floor.js';
import type { ReviewPanelPart } from '../../../shared/kanban/review.js';
import { KANBAN_TOOL_NAMES } from '../../../shared/kanban/tools.js';
import type { DepartureIntent, KanbanRun, KanbanTask, KanbanTool } from '../../../shared/kanban/types.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import type { ComposeExtra } from './compose.js';
import type { Live, Via } from './live.js';
import type { MachineEvent, RunEffect } from './machine.js';
import { looksInterrupted, reviewFindings, reviewVerdict, stripWorkDone } from './markers.js';
import { slotPatch } from './slot.js';
import type { TurnResult } from './adapters/types.js';
import { homeCleanup } from './workspace.js';

/** How long the round waits for its additional reviewers once the main reviewer's own review is in. */
export const PANEL_WAIT_MS = 15 * 60_000;
/** One reviewer's findings in the combine prompt: it is pasted into a terminal. */
const FINDINGS_MAX = 6000;
const SUMMARY_MAX = 20_000;
const OFFICE: KanbanCaller = { name: 'Kanban', admin: true };
const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** What the engine lends to the panel. */
export interface PanelDeps {
  ctx: KanbanContext;
  now(): number;
  waitMs(): number;
  /** Starts a run of the round (Orchestrator.launchRun). */
  launch(task: KanbanTask, eff: RunEffect, via: Via, seat: number, part: ReviewPanelPart, more?: Partial<ComposeExtra>): Promise<string | { queued: string } | undefined>;
  /** Every run the engine follows on the task. */
  livesOf(taskId: number): Live[];
  forget(live: Live): void;
  finishRun(id: number, project: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]): unknown;
  update(id: number, patch: Parameters<KanbanContext['repo']['updateTask']>[1]): unknown;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  /** A reviewer's result as a comment of the task (kind review). */
  say(task: KanbanTask, run: KanbanRun, text: string): void;
  apply(taskId: number, e: MachineEvent, via?: Via): Promise<string | undefined>;
  serial<T>(taskId: number, fn: () => Promise<T>): Promise<T>;
  drain(floorId: string): void;
}

/** The round as its run rows say it. */
interface Round {
  solo: KanbanRun;
  /** The latest run of each additional reviewer's seat since the solo run began. */
  co: Map<number, KanbanRun>;
  combine?: KanbanRun;
  /** The solo run is one the office relaunched after a restart: the round began earlier. */
  resumed?: boolean;
}

const toolName = (tool: KanbanTool) => KANBAN_TOOL_NAMES[tool];

export class ReviewPanel {
  private timers = new Map<number, NodeJS.Timeout>();
  /** Tasks whose wait for the additional reviewers has run out. */
  private expired = new Set<number>();

  constructor(private d: PanelDeps) {}

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** "Reviewer 2 (Codex, focus: Security)": the seat's name in the task's conversation and in the combine prompt. */
  label(seat: number, tool: KanbanTool, model?: string, focus?: string): string {
    return `Reviewer ${seat + 1} (${toolName(tool)}${model ? ` ${model}` : ''}${focus ? `, focus: ${focus}` : ''})`;
  }

  // --- The round's shape ------------------------------------------------------------------------

  /** What a launch of the main reviewer's review is in a round with several reviewers (none when the task has no additional reviewers, or it is another run). */
  plan(task: KanbanTask, eff: RunEffect): { part: ReviewPanelPart; eff: RunEffect; more?: Partial<ComposeExtra> } | undefined {
    if (eff.role !== 'reviewer' || eff.phase !== 'review') return undefined;
    // A round that is already open comes from the run rows and the task's stored seats, whatever the settings say now; the settings only decide whether a NEW round has additional reviewers.
    const last = this.d.ctx.repo.listRuns(task.id).filter((r) => !r.seat && r.phase !== 'compact').at(-1);
    if (eff.prompt === 'restarted' || eff.prompt === 'continue') {
      // A combine run that did not end (it never started, a usage limit, a crash, an office restart: failed or interrupted, not stopped by a person) goes again as a combine
      // from the round's results, not as a round of its own. A Stop followed by Retry runs the whole round again.
      const round = last?.panel === 'combine' && (last.status === 'failed' || last.status === 'interrupted') ? this.view(task.id) : undefined;
      if (round && [...round.co.values()].some((r) => r.status === 'succeeded' && r.summary)) return { part: 'combine', eff: { ...eff, prompt: 'rereview' }, more: { panel: 'combine', reviews: this.reviews(task, round) } };
      // A solo run the office relaunched after a restart is the same round, with its stored seats.
      if (eff.prompt === 'restarted' && last?.panel === 'solo' && task.coReviewers?.length) return { part: 'solo', eff };
    }
    if (!this.d.ctx.settings.effectiveReview(task.project, task.overrides).extra?.length) return undefined; // a new round without additional reviewers
    return ['review', 'rereview', 'continue', 'restarted'].includes(eff.prompt) ? { part: 'solo', eff } : undefined;
  }

  /** The round of the task's latest main-reviewer run that began one (a 'solo' run), from the run rows. */
  view(taskId: number): Round | undefined {
    const runs = this.d.ctx.repo.listRuns(taskId);
    let at = -1;
    runs.forEach((r, i) => {
      if (r.panel === 'solo' && !r.seat) at = i;
    });
    if (at < 0) return undefined;
    // A solo run the office relaunched after a restart (the earlier one is interrupted) is the same round: the seats' runs since the first count.
    let first = at;
    for (;;) {
      const before = runs.slice(0, first).reverse().find((r) => !r.seat);
      if (before?.panel !== 'solo' || before.status !== 'interrupted' || before.round !== runs[at].round) break;
      first = runs.indexOf(before);
    }
    const co = new Map<number, KanbanRun>();
    let combine: KanbanRun | undefined;
    for (const r of runs.slice(first + 1)) {
      if (r.seat && r.panel === 'co') co.set(r.seat, r);
      else if (!r.seat && r.panel === 'combine') combine = r;
    }
    return { solo: runs[at], co, ...(combine ? { combine } : {}), ...(first !== at ? { resumed: true } : {}) };
  }

  /** The task is in review with the main reviewer's own review in and nobody running: between the solo run and the combine (or the published result). */
  gap(taskId: number): boolean {
    const task = this.d.ctx.repo.getTask(taskId);
    if (!task || task.status !== 'in_progress' || task.phase !== 'review' || task.runState === 'idle' || task.runState === 'queued') return false;
    const r = this.view(taskId);
    return !!r && r.solo.status === 'succeeded' && !r.combine && !this.d.livesOf(taskId).some((l) => !l.seat);
  }

  // --- Starting the round -----------------------------------------------------------------------

  /** The main reviewer's solo run has started: every additional reviewer starts its own. A seat that can't start is noted and left out. */
  async open(task: KanbanTask, eff: RunEffect, via: Via) {
    this.clear(task.id);
    // The settings are read when a round opens: the seats are then kept on the task. A solo run the office relaunched after a restart is the same round:
    // it goes on with those seats, keeping the ones that are running here or have their result in.
    const stored = task.coReviewers ?? [];
    const goingOn = eff.prompt === 'restarted' && stored.length > 0 && !!this.view(task.id)?.resumed;
    const floor = this.d.ctx.floor(task.project);
    // A new round's seats are its settings wholesale (an absent model or effort is the default); only what is needed to come back is carried over from the seat's last round.
    // The stored session is used when the tool is unchanged: a changed model or effort relaunches the same session with them.
    const seats = goingOn ? stored : (this.d.ctx.settings.effectiveReview(task.project, task.overrides).extra ?? []).map((spec, i) => {
      const old = stored.find((c) => c.seat === i + 1);
      const same = old?.tool === spec.tool;
      return { seat: i + 1, tool: spec.tool, ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}), ...(spec.focus ? { focus: spec.focus } : {}), ...(old?.workerId && floor?.workers.get(old.workerId) ? { workerId: old.workerId } : {}), ...(same && old?.sessionId ? { sessionId: old.sessionId } : {}) };
    });
    if (!goingOn) this.d.update(task.id, { coReviewers: seats.length ? seats : null });
    const kept = goingOn ? this.view(task.id)?.co : undefined;
    for (const { seat, tool, model, focus } of seats) {
      const had = kept?.get(seat);
      if (had && (had.status === 'succeeded' || (had.status === 'running' && this.d.livesOf(task.id).some((l) => l.runId === had.id)))) continue;
      const label = this.label(seat, tool, model, focus);
      const paused = this.d.ctx.hiringPaused?.();
      const err = paused ? `hiring is paused: ${paused}` : await this.d.launch(this.d.ctx.repo.getTask(task.id) ?? task, { type: 'run', phase: 'review', role: 'reviewer', prompt: (eff.round ?? 1) > 1 ? 'rereview' : 'review', ...(eff.round !== undefined ? { round: eff.round } : {}) }, { ...(via.who ? { who: via.who } : {}) }, seat, 'co');
      if (err) this.d.note(task, `${label} could not start: ${clip(typeof err === 'string' ? err : err.queued, 300)}`);
    }
  }

  // --- Ends of the round's runs -----------------------------------------------------------------

  /** An additional reviewer's turn is over (its live is forgotten, the session saved): its result is kept on its run, or the seat did not finish. */
  async coEnded(live: Live, task: KanbanTask, o: { result?: TurnResult; unfinished?: boolean; asked?: boolean; sessionId?: string }) {
    const text = o.result ? stripWorkDone(o.result.text.trim()) : '';
    const seat = live.seat ?? 0;
    const info = this.spec(task, seat);
    let why: string | undefined;
    if (!o.result || (!o.result.complete && !text)) why = 'its turn ended without a reply the office could read';
    else if (looksInterrupted(o.result.text, o.result.apiError)) why = 'a usage limit or a lost connection interrupted it';
    else if (o.unfinished) why = 'it never gave its verdict, even when asked for it';
    else if (o.asked) why = 'it asked a question, and there is nobody to answer it in a review panel';
    if (why) {
      this.d.finishRun(live.runId, task.project, { status: 'failed', error: why, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
      this.d.note(task, `${this.label(seat, info.tool, info.model, info.focus)} did not finish: ${why}`, live.runId);
    } else this.d.finishRun(live.runId, task.project, { status: 'succeeded', summary: clip(text, SUMMARY_MAX), verdict: reviewVerdict(text), ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
    await this.settle(task.id);
  }

  /** An additional reviewer's run is over without a result (its agent exited or asks in its terminal, it was sent home): the seat did not finish. */
  async coGone(live: Live, why: string, status: 'interrupted' | 'stopped' = 'interrupted', settle = true) {
    live.ended = true;
    this.d.forget(live);
    const task = this.d.ctx.repo.getTask(live.taskId);
    this.d.finishRun(live.runId, live.floorId, { status, error: why });
    if (!task) return;
    const info = this.spec(task, live.seat ?? 0);
    this.d.note(task, `${this.label(live.seat ?? 0, info.tool, info.model, info.focus)} did not finish: ${why}`, live.runId);
    if (settle) await this.settle(task.id);
  }

  /** A person sent an additional reviewer's worker home: its seat did not finish (never `reviewAbandoned`), and the seat forgets the worker. */
  async left(workerId: string, taskId: number, own: Live | undefined, by: string) {
    const task = this.d.ctx.repo.getTask(taskId);
    const entry = task?.coReviewers?.find((c) => (own ? c.seat === own.seat : c.workerId === workerId));
    if (!task || !(own?.seat ?? entry?.seat)) return;
    // Only the seat's own worker is forgotten: an older worker leaving after the seat was given to a new one leaves the new one's id alone.
    if (entry?.workerId === workerId) this.d.update(task.id, slotPatch('reviewer', { workerId: null }, entry.seat, task));
    if (own) await this.coGone(own, `${by} sent it home`);
  }

  /** The main reviewer's solo run ended with a result: the round goes on with whatever the others have done. */
  soloEnded(task: KanbanTask) {
    return this.settle(task.id);
  }

  // --- Settling -----------------------------------------------------------------------------------

  /**
   * Once the solo run has ended and every additional reviewer has finished or dropped: no result of theirs → the main reviewer's own
   * is the round's; otherwise the main reviewer combines them. Waits for the seats still running, at most `waitMs` from the solo run's end.
   */
  async settle(taskId: number): Promise<void> {
    const task = this.d.ctx.repo.getTask(taskId);
    const round = task && this.view(taskId);
    // The task left its review (stopped, moved on) with the round's seats still about: they end, and their workers go home.
    if (task && round && !round.combine && (task.status !== 'in_progress' || task.phase !== 'review')) return this.close(task, 'The review round is over');
    if (!task || !round || round.combine || round.solo.status !== 'succeeded') return this.clear(taskId);
    const live = this.d.livesOf(taskId);
    if (live.some((l) => !l.seat)) return; // the main reviewer's run is still going
    const running = [...round.co.values()].filter((r) => r.status === 'running');
    if (running.length) {
      if (!this.expired.has(taskId) && !this.late(round)) return this.arm(taskId, round);
      for (const r of running) {
        const l = live.find((x) => x.runId === r.id);
        if (l) await this.coGone(l, 'it was still working when the wait for the reviewers ran out', 'interrupted', false);
        else this.d.finishRun(r.id, task.project, { status: 'interrupted', error: 'It was still working when the wait for the reviewers ran out' });
      }
      return this.settle(taskId); // once, with the seats dropped: coGone settling by itself here would publish the round twice
    }
    this.clear(taskId);
    const fresh = this.view(taskId) ?? round;
    const done = [...fresh.co.values()].filter((r) => r.status === 'succeeded' && r.summary);
    if (!done.length) {
      await this.publish(task, fresh.solo);
      return;
    }
    const current = this.d.ctx.repo.getTask(taskId) ?? task;
    const eff: RunEffect = { type: 'run', phase: 'review', role: 'reviewer', prompt: 'rereview', ...(fresh.solo.round !== undefined ? { round: fresh.solo.round } : {}) };
    const err = await this.d.launch(current, eff, { who: OFFICE }, 0, 'combine', { panel: 'combine', reviews: this.reviews(current, fresh) });
    if (err) {
      // The round's results stay in the run rows: the combine waits for a Retry, as one that failed after it started does. Publishing the main reviewer's own result would drop the findings.
      const why = clip(typeof err === 'string' ? err : err.queued, 300);
      const latest = this.d.ctx.repo.listRuns(taskId).filter((r) => !r.seat).at(-1);
      if (!(latest?.panel === 'combine' && latest.id > fresh.solo.id)) {
        const row = this.d.ctx.repo.createRun({ taskId, phase: 'review', ...(fresh.solo.round !== undefined ? { round: fresh.solo.round } : {}), role: 'reviewer', tool: fresh.solo.tool, model: fresh.solo.model, effort: fresh.solo.effort, panel: 'combine', status: 'failed' });
        this.d.finishRun(row.id, task.project, { status: 'failed', error: why });
      }
      await this.close(current);
      await this.d.apply(taskId, { type: 'failed', error: `The reviews could not be combined: ${why}. Retry to combine them.` }, { who: OFFICE });
      this.d.drain(task.project);
    }
  }

  private late(round: Round): boolean {
    return round.solo.finishedAt !== undefined && this.d.now() - round.solo.finishedAt >= this.d.waitMs();
  }

  private arm(taskId: number, round: Round) {
    if (this.timers.has(taskId)) return;
    const ms = Math.max(0, (round.solo.finishedAt ?? this.d.now()) + this.d.waitMs() - this.d.now());
    const soloId = round.solo.id;
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      if (this.view(taskId)?.solo.id !== soloId) return; // a timer of an earlier round
      this.expired.add(taskId);
      void this.d.serial(taskId, () => this.settle(taskId));
    }, ms);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  private clear(taskId: number) {
    clearTimeout(this.timers.get(taskId));
    this.timers.delete(taskId);
    this.expired.delete(taskId);
  }

  /** The main reviewer's own result is the round's: it goes down the path every review's result takes, as one `reviewed`. */
  private async publish(task: KanbanTask, solo: KanbanRun) {
    await this.close(task);
    const now = this.d.ctx.repo.getTask(task.id) ?? task;
    this.d.say(now, solo, solo.summary ?? '');
    const pending = now.pendingMessages.some((m) => !m.parked);
    await this.d.apply(task.id, { type: 'reviewed', ...(solo.round !== undefined ? { round: solo.round } : {}), approved: solo.verdict === 'approved', pending }, { who: OFFICE });
    this.d.drain(task.project);
  }

  /** What the combine prompt shows of the round: each reviewer's verdict and findings, the seats that did not finish named as such. */
  reviews(task: KanbanTask, round: Round): string {
    const one = (name: string, r: KanbanRun | undefined, gone: string) => {
      if (!r || r.status !== 'succeeded') return `${name}: ${r ? gone : 'did not start'}. Nothing of it to check.`;
      return `${name}: ${r.verdict === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED'}\n${clip(reviewFindings(r.summary ?? '') || '(no findings listed)', FINDINGS_MAX)}`;
    };
    const out = [one(`${this.label(0, round.solo.tool, round.solo.model)}, you`, round.solo, 'did not finish')];
    // The round's own reviewers: the seats it was opened with and the runs they made, whatever the settings say now.
    const seats = [...new Set([...(task.coReviewers ?? []).map((c) => c.seat), ...round.co.keys()])].sort((a, b) => a - b);
    for (const seat of seats) {
      const row = round.co.get(seat), entry = task.coReviewers?.find((c) => c.seat === seat);
      out.push(one(this.label(seat, row?.tool ?? entry?.tool ?? 'claude', row ? row.model : entry?.model, entry?.focus), row, 'did not finish'));
    }
    return out.join('\n\n');
  }

  // --- Closing --------------------------------------------------------------------------------------

  /**
   * The round is over, or cut off (a stop, a hold, the main reviewer gone): every additional reviewer still running is over as `status`
   * with `why`, and their workers go home (the worktree stays; the sessions are kept for the next round). The part before the first
   * await is synchronous: a caller that doesn't wait still has the runs finished.
   */
  async close(task: Pick<KanbanTask, 'id' | 'project'>, why?: string, status: 'interrupted' | 'stopped' = 'interrupted') {
    this.clear(task.id);
    for (const l of this.d.livesOf(task.id).filter((x) => x.seat)) {
      l.ended = true;
      this.d.forget(l);
      this.d.finishRun(l.runId, l.floorId, { status, error: why ?? 'The review round ended before it finished' });
    }
    await this.home(task.id);
  }

  /**
   * The additional reviewers' workers go home, and their seats forget them (the sessions stay). Every worker on the floor that is one of
   * this task's additional reviewers goes, listed in `coReviewers` or not (a seat's id may have been lost).
   */
  async home(taskId: number) {
    const task = this.d.ctx.repo.getTask(taskId);
    const floor: Floor | undefined = task && this.d.ctx.floor(task.project);
    if (!task) return;
    const ids = new Set(task.coReviewers?.flatMap((c) => (c.workerId ? [c.workerId] : [])));
    for (const w of floor?.workers.list() ?? []) if (w.kanban?.taskId === taskId && w.kanban.role === 'reviewer' && (w.kanban.seat ?? 0) >= 1) ids.add(w.id);
    if (task.coReviewers?.some((c) => c.workerId)) this.d.update(task.id, { coReviewers: task.coReviewers.map((c) => ({ ...c, workerId: undefined })) });
    for (const id of ids) {
      const info = floor?.workers.get(id);
      if (info) await floor!.sendHome(info.id, homeCleanup(task, info), ENGINE);
    }
  }

  private spec(task: KanbanTask, seat: number): { tool: KanbanTool; model?: string; focus?: string } {
    const c = task.coReviewers?.find((x) => x.seat === seat);
    return { tool: c?.tool ?? 'claude', ...(c?.model ? { model: c.model } : {}), ...(c?.focus ? { focus: c.focus } : {}) };
  }

  // --- Restart ----------------------------------------------------------------------------------

  /** After the runs are re-attached: a round that was between its solo run and its combine goes on (waiting for the seats still running, or combining). */
  recover() {
    for (const t of this.d.ctx.repo.tasksWhere({ status: ['in_progress'] })) if (this.gap(t.id)) void this.d.serial(t.id, () => this.settle(t.id));
  }

  /** After the runs are re-attached: a task with additional reviewers about but no main run going and no gap to settle is a round that does not go on (its main run was cut off and waits, or was interrupted): they end and go home. */
  stale() {
    const ids = new Set<number>(); // a restored worker carries only its task and role, so the seats come from the tasks
    for (const t of this.d.ctx.repo.tasksWhere({ status: ['in_progress', 'waiting', 'review'] })) if (t.coReviewers?.some((c) => c.workerId)) ids.add(t.id);
    for (const def of this.d.ctx.projects()) for (const w of this.d.ctx.floor(def.id)?.workers.list() ?? []) if (w.kanban && (w.kanban.seat ?? 0) >= 1) ids.add(w.kanban.taskId);
    for (const id of ids) {
      const task = this.d.ctx.repo.getTask(id);
      if (task && !this.d.livesOf(id).some((l) => !l.seat) && !this.gap(id)) void this.d.serial(id, () => this.close(task, 'The review round did not go on after the office restarted'));
    }
  }
}
