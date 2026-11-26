// A pull-request review's start (phase pr-review): the task it runs on (or a new investigate task for it), and the run
// that hires its reviewer in a worktree of each repository the pull requests are in. Split out of the orchestrator like
// Holds; the engine's own state reaches it through the small `PrReviewDeps` interface.

import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import { nextFreeSeat } from '../../../shared/layout.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import type { DepartureIntent, KanbanComment, KanbanRun, KanbanPrReviewRequest, KanbanRole, KanbanTask, KanbanTool } from '../../../shared/kanban/types.js';
import type { ReviewPanelPart } from '../../../shared/kanban/review.js';
import { sameRepo } from '../../../shared/floors.js';
import { projectRepos, repoSources } from '../projects.js';
import type { TaskAgentAdapter } from './adapters/types.js';
import { Composer, isFolderProject, reposText, skillPhase, type ComposeExtra } from './compose.js';
import type { Comments } from './comments.js';
import type { Live, Via } from './live.js';
import { queuedOf, type MachineEvent, type RunEffect } from './machine.js';
import { slot, slotPatch } from './slot.js';
import { typeable } from './turnhold.js';
import { homeCleanup } from './workspace.js';
import { prReviewDirs, prReviewRepoIds } from './launchdirs.js';
import { fetchPrHeads, prLine, readingNote, trusted, type GitRunner, type HeadPr } from './prheads.js';
import { reviewVerdict } from './markers.js';
import { launchUi, uiEnded } from './prreview-ui.js';

export type { GitRunner };

/** A pull request as a review request may name it: the pulls plugin hands on what it looked up (its base branch and whether it is a fork's too). */
export type ReviewedPr = HeadPr;

/** What the engine lends to the pull-request review's start. */
export interface PrReviewDeps {
  ctx: KanbanContext;
  adapters: Record<KanbanTool, TaskAgentAdapter>;
  compose: Composer;
  comments: Comments<Live>;
  reviewSettings(task: Pick<KanbanTask, 'project' | 'overrides'>): ReturnType<KanbanContext['settings']['effectiveReview']>;
  sharesLimit(task: Pick<KanbanTask, 'workerId'>, role: KanbanRole, floor: Floor): string | undefined;
  signInMissing(task: Pick<KanbanTask, 'id' | 'createdBy' | 'createdByAccount'>, owner: string, who?: KanbanCaller): string;
  noRoom(floor: Floor, preferred?: string, countsWith?: string, role?: KanbanRole): string | undefined;
  freshBase(floor: Floor, def: FloorDef, repoIds: string[] | null): Promise<void>;
  hireOwner(task: Pick<KanbanTask, 'createdByAccount'>, who?: Pick<KanbanCaller, 'accountId'>): string | undefined;
  baseBranches(def: FloorDef, repoIds: string[] | null): Record<string, string>;
  watch(floorId: string): Floor | undefined;
  op(taskId: number, fn: (task: KanbanTask) => Promise<string | undefined | void>): Promise<string | void>;
  apply(taskId: number, e: MachineEvent, via?: Via): Promise<string | undefined>;
  running(taskId: number): boolean;
  finishRun(id: number, project: string, patch: Parameters<KanbanContext['repo']['finishRun']>[1]): void;
  update(id: number, patch: { reviewerWorkerId?: string | null; reviewerSessionId?: string | null; runState?: KanbanTask['runState'] }): void;
  note(task: Pick<KanbanTask, 'id' | 'project'>, text: string, runId?: number): void;
  pushTask(task: KanbanTask | undefined): void;
  /** Follows the hired reviewer's run: registers the live run and types its prompt. */
  follow(live: Live, prompt: string): void;
  exitedAtHire(live: Live): void;
  now(): number;
  /** Runs git in a repository's checkout, to fetch the pull requests' heads (the real git when absent; tests inject their own). */
  git?: GitRunner;
  /** The deadline of all the heads' fetches together (prheads.ts HEADS_DEADLINE_MS when absent). */
  headsMs?: number;
}

/** How the engine sends its own workers home (the orchestrator's ENGINE). */
const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** How much of a run's text its row keeps (the orchestrator's SUMMARY_MAX): a longer one is cut there, verdict line and all. */
const SUMMARY_MAX = 20_000;
/** How long an identical review request is answered with the task already made for it. */
const ASKED_MS = 60_000;

export class PrReviews {
  /** Reviews asked for lately, by what they ask: the answer given (or still to come) for an identical request. */
  private asked = new Map<string, { answer: Promise<{ taskId: number; workerId?: string } | string>; at?: number }>();
  /** The pull requests' lines of each task's latest review, as the main reviewer's prompt had them (an additional reviewer's prompt takes the same). */
  private lines = new Map<number, string>();
  /** A main reviewer's solo run's whole text, by task: its run row keeps only the first SUMMARY_MAX characters, and the round's fallback posts the review whole. Cleared when the round is published. */
  private solo = new Map<number, string>();

  constructor(private d: PrReviewDeps) {}

  /**
   * Several pull requests reviewed together, as a run of its own (phase pr-review): on the task the
   * request names, or on a new investigate task for it. The request comes checked (KanbanPullsApi.review);
   * this checks only what the engine itself needs.
   */
  review(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> {
    // An identical request (a second click, a retry of a request the browser gave up on) while this one starts, or within a minute of it, is answered with
    // the same task: no second review is made. Another set of pull requests, or other choices, is another review; a refusal is forgotten at once.
    const key = JSON.stringify([req.project, req.prs.map((p) => `${p.repo.toLowerCase()}#${p.number}`).sort(), req.taskId ?? null, !!req.post, !!req.uiTest, req.tool ?? null, req.model ?? null, req.effort ?? null, who.accountId ?? who.name]);
    const now = this.d.now();
    for (const [k, v] of this.asked) if (v.at !== undefined && now - v.at > ASKED_MS) this.asked.delete(k);
    const known = this.asked.get(key);
    if (known) return known.answer;
    const answer = this.begin(req, who);
    const entry: { answer: typeof answer; at?: number } = { answer };
    this.asked.set(key, entry);
    void answer.then((r) => (typeof r === 'string' ? this.asked.delete(key) : (entry.at = this.d.now())), () => this.asked.delete(key));
    return answer;
  }

  private async begin(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> {
    const def = this.d.ctx.project(req.project);
    if (!def) return `There's no project ${req.project}`;
    if (!this.d.watch(req.project)) return "The project's floor isn't open, so there's nowhere to seat a reviewer";
    if (isFolderProject(def)) return 'A folder project has no pull requests to review';
    if (!req.prs.length) return 'Pick at least one pull request';
    const labels = req.prs.map((p) => `${p.repo}#${p.number}`);
    const target = this.taskFor(req, def, who);
    if (typeof target === 'string') return target;
    const { taskId, named, created } = target;
    const request: KanbanPrReviewRequest = { project: req.project, prs: req.prs, ...(named !== undefined ? { taskId: named } : {}), ...(req.tool ? { tool: req.tool } : {}), ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(req.post ? { post: true } : {}), ...(req.uiTest ? { uiTest: true } : {}) };
    // A fork's pull request is never checked out or run: with every one a fork's there is nothing to test, and the review starts directly.
    const ui = !!request.uiTest && (req.prs as ReviewedPr[]).some(trusted);
    const err = await this.d.op(taskId, async (task) => {
      if (this.d.running(task.id)) return 'Stop it first: it is running';
      // Who asked is kept beside the request: the review is posted as them, and a Retry keeps it.
      this.d.ctx.repo.appendEvent(task.id, 'pr.review', { by: who.name, prs: labels, request, ...(who.accountId ? { account: who.accountId } : {}) });
      if (request.uiTest && !ui) this.d.note(task, 'No pull request of this review is confirmed not to be from a fork, and the office never checks out or runs code that might be a fork\'s, so there is no UI to test: the review starts without it.');
      return this.d.apply(task.id, { type: 'prReview', ...(ui ? { ui: true as const } : {}) }, { who, prReview: request });
    });
    const task = this.d.ctx.repo.getTask(taskId);
    if (!err && task?.runState === 'queued' && task.queuedRun?.phase === 'pr-review') {
      // No room now (a desk, the worker limit): the task waits in the queue and the review starts by itself.
      this.d.note(task, `${who.name} asked for a review of ${labels.join(', ')}`);
      return { taskId };
    }
    const workerId = ui ? task?.workerId : task?.reviewerWorkerId; // a UI test's tester is the task's implementer
    const info = workerId ? this.d.ctx.floor(req.project)?.workers.get(workerId) : undefined;
    if (err || !task || !workerId || !info) {
      // A review task that never got its reviewer is no use to anyone: it goes again.
      if (created && task && !this.d.running(task.id)) {
        this.d.ctx.repo.deleteTask(task.id);
        this.d.ctx.broadcast({ t: 'kanban.task.removed', id: task.id, project: task.project }, task.project);
      }
      return err || 'The reviewer could not be hired';
    }
    this.d.note(task, `${who.name} asked ${info.name} to ${ui ? 'test the UI of, and then review,' : 'review'} ${labels.join(', ')}`);
    return { taskId, workerId };
  }

  /** The request of the task's latest pull-request review (for a Retry), as reviewPrs recorded it. */
  last(taskId: number): KanbanPrReviewRequest | undefined {
    const req = this.lastEvent(taskId)?.request;
    return req && Array.isArray(req.prs) ? req : undefined;
  }

  private lastEvent(taskId: number): { request?: KanbanPrReviewRequest; account?: string } | undefined {
    return [...this.d.ctx.repo.listEvents(taskId)].reverse().find((x) => x.kind === 'pr.review')?.data as { request?: KanbanPrReviewRequest; account?: string } | undefined;
  }

  /**
   * The task a review goes into: the one the request names when every pull request is its, else a new
   * investigate task of its own, so one task's findings and column aren't another's. Or why it can't.
   */
  taskFor(req: KanbanPrReviewRequest, def: FloorDef, who: KanbanCaller): { taskId: number; named?: number; created?: KanbanTask } | string {
    const { repo } = this.d.ctx;
    const labels = req.prs.map((p) => `${p.repo}#${p.number}`);
    let created: KanbanTask | undefined;
    let named = req.taskId;
    let mixed: string | undefined;
    // A review that tests the UI is always a task of its own: the pictures are kept with it, and a task whose pull requests the office opened would have them added to those pull requests (see checkScreenshots).
    if (req.uiTest && named !== undefined) {
      mixed = `This review was asked for on task #${named} and tests the UI too. Its pictures are not added to any pull request, so it is a review task of its own and task #${named} is left alone.`;
      named = undefined;
    }
    if (named !== undefined) {
      const t = repo.getTask(named);
      if (!t || t.project !== req.project) return `There's no task #${named} in this project`;
      const theirs = (req.prs as ReviewedPr[]).filter((p) => !this.prOfTask(t, def, p));
      if (theirs.length) {
        const whose = theirs.map((p) => {
          const ids = repo.tasksOfPr(p.repo, p.number).filter((id) => id !== t.id);
          return `${p.repo}#${p.number} ${ids.length ? `is ${ids.map((id) => `#${id}`).join(', ')}'s` : 'belongs to no task the kanban knows'}`;
        });
        mixed = `This review was asked for on task #${t.id}, but not every pull request is its (${whose.join('; ')}), so it is a review task of its own.`;
        named = undefined;
      }
    }
    if (named === undefined) {
      const review = this.d.ctx.settings.effectiveReview(req.project);
      const involved = projectRepos(def).filter((r) => r.primary || (r.kind === 'git' && r.remote && req.prs.some((p) => sameRepo(r.remote!, p.repo))));
      const ticket = this.commonTicket(req.prs as ReviewedPr[]);
      created = repo.createTask({
        project: req.project,
        title: clip(`PR review: ${labels.join(', ')}`, 100),
        description: `A review of these pull requests together:\n${(req.prs as ReviewedPr[]).map((p) => `- ${p.repo}#${p.number}${p.title ? ` ${p.title}` : ''}${p.url ? ` (${p.url})` : ''}`).join('\n')}`,
        type: 'investigate',
        ...(ticket ? { ticket } : {}),
        repoIds: involved.map((r) => r.id),
        tool: req.tool ?? review.tool,
        usePlan: false,
        planApproval: 'auto',
        useReview: false,
        createdBy: who.name,
        ...(who.accountId ? { createdByAccount: who.accountId } : {}),
        startedAt: this.d.now(),
        flags: { descriptionLocked: true },
      });
      this.d.pushTask(created);
      if (mixed) this.d.note(created, mixed);
    }
    return { taskId: created?.id ?? named!, ...(named !== undefined ? { named } : {}), ...(created ? { created } : {}) };
  }

  /** Whether a pull request is the task's: linked to it (pr_links), or opened from its branch in that repository. */
  private prOfTask(task: KanbanTask, def: FloorDef, p: ReviewedPr): boolean {
    const r = projectRepos(def).find((x) => x.kind === 'git' && !!x.remote && sameRepo(x.remote, p.repo));
    if (task.prs.some((k) => k.number === p.number && (k.repo ? sameRepo(k.repo, p.repo) : k.repoId === r?.id))) return true;
    if (!r || !p.branch) return false;
    return (this.d.ctx.repo.repoBranches(task.id)[r.id] ?? task.branch) === p.branch;
  }

  /** The ticket every one of the pull requests belongs to (their tasks', or named in their titles or branches), if there's one. */
  private commonTicket(prs: ReviewedPr[]): string | undefined {
    const sets = prs.map((p) => {
      const out = new Set<string>();
      for (const id of this.d.ctx.repo.tasksOfPr(p.repo, p.number)) {
        const t = this.d.ctx.repo.getTask(id)?.ticket;
        if (t) out.add(t);
      }
      for (const m of `${p.title ?? ''} ${p.branch ?? ''}`.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![0-9])/g)) out.add(m[1]);
      return out;
    });
    return [...(sets[0] ?? [])].find((t) => sets.every((x) => x.has(t)));
  }

  /** Where a pr-review run goes: a UI test (the implementer's), an additional reviewer (`seat`), a combine, or the main reviewer's own review (hired anew). */
  start(task: KanbanTask, def: FloorDef, floor: Floor, via: Via, restarted: boolean, asked: RunEffect, seat = 0, part?: ReviewPanelPart): Promise<string | { queued: string } | undefined> {
    if (isFolderProject(def)) return Promise.resolve('A folder project has no pull requests to review');
    if (seat > 0) return this.launchCo(task, def, floor, via, seat, asked);
    if (asked.role === 'implementer') {
      const req = via.prReview ?? this.last(task.id);
      return req?.prs.length ? launchUi(this.d, req, task, def, floor, via, asked) : Promise.resolve('There are no pull requests to test: pick them again');
    }
    // The combine goes on in the main reviewer's own session (Restarts.reviewer), the only one that holds the round's worktree: with that reviewer gone, a hire would not be it.
    if (part === 'combine') return Promise.resolve('The main reviewer is no longer at its desk, so the reviews cannot be combined: Retry reviews the pull requests again from the start');
    return this.launch(task, def, floor, via, restarted, asked, part);
  }

  /**
   * A pull-request review's run: its own reviewer, hired fresh in a worktree of each repository the
   * pull requests are in (never the floor's checkout, never the task's worktree), cut from the head of the
   * first pull request of each (see prheads.ts), with the review's read-only flags. A Retry reviews them
   * again from the start. `part`: 'solo' when additional reviewers take part in the round (see ReviewPanel).
   */
  async launch(task: KanbanTask, def: FloorDef, floor: Floor, via: Via, restarted: boolean, asked: RunEffect, part?: ReviewPanelPart): Promise<string | { queued: string } | undefined> {
    const kept = !asked.text ? this.d.comments.take(task, via.pendingSince, (m) => !!m.answer) : undefined;
    const eff: RunEffect = { ...asked, pending: undefined, ...(kept ? { text: kept.text } : {}) };
    if (kept) via.taken = kept.msgs; // what the user said to a reviewer that asked: the comment that answered it, or (a Retry, whichever prompt it picks) that answer given back; the rest of the queue is the implementer's
    const req = via.prReview ?? this.last(task.id);
    if (!req?.prs.length) return 'There are no pull requests to review: pick them again';
    this.solo.delete(task.id); // a new round: nothing of an older one's text
    const review = this.d.reviewSettings(task), tool: KanbanTool = req.tool ?? review.tool, same = !req.tool || req.tool === review.tool;
    const model = req.model ?? (same ? review.model : undefined), effort = req.effort ?? (same ? review.effort : undefined);
    const adapter = this.d.adapters[tool], involved = prReviewRepoIds(def, req.prs);

    // Whoever reviewed for the task before goes home: this review starts in a worktree of its own.
    const prev = slot(task, 'reviewer').workerId ? floor.workers.get(slot(task, 'reviewer').workerId!) : undefined;
    if (prev && (prev.status === 'working' || (prev.status === 'starting' && !restarted))) return `${prev.name} is busy: wait for its turn to end`;
    if (prev) await floor.sendHome(prev.id, homeCleanup(task, prev), ENGINE);
    this.d.update(task.id, slotPatch('reviewer', { workerId: null, sessionId: null }));

    const extras = this.d.ctx.workerExtras(task.id, tool, skillPhase('pr-review'));
    const dirs = prReviewDirs(this.d.ctx, task, !!eff.text || !!req.uiTest);
    const launchArgs = adapter.launchArgs('pr-review', { ...this.d.ctx.settings.launchPermissions(task.project, task.overrides), sandbox: review.sandbox, model, effort, extra: extras.args, ...dirs });

    const owner = this.d.hireOwner(task, via.who);
    const signIn = owner && tool === 'claude' && this.d.ctx.runAs && !this.d.ctx.runAs.claudeReady(owner) ? this.d.signInMissing(task, owner, via.who) : undefined;
    const countsWith = this.d.sharesLimit(this.d.ctx.repo.getTask(task.id) ?? task, 'reviewer', floor);
    // No desk, or the office's worker limit: queued as any hire is (the drain runs it again, the
    // pull requests from its pr.review event).
    const full = signIn ? undefined : this.d.noRoom(floor, undefined, countsWith);
    if (full) return { queued: full };

    const run = this.d.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'reviewer', tool, model, effort, ...(part ? { panel: part } : {}), launch: { ...queuedOf({ ...eff, phase: 'pr-review', role: 'reviewer' }), prompt: eff.text ? eff.prompt : 'pr.review', ...(via.taken?.length ? { taken: via.taken } : {}), ...(via.commentId !== undefined ? { commentId: via.commentId } : {}) } });
    this.d.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const fail = (err: string) => {
      this.d.finishRun(run.id, task.project, { status: 'failed', error: err });
      return err;
    };
    if (signIn) return fail(signIn);
    // The heads are fetched while the bases are (both bounded: the answer to the browser waits for them).
    const headsP = fetchPrHeads(def, req.prs as ReviewedPr[], this.d.git, false, this.d.headsMs);
    await this.d.freshBase(floor, def, involved);
    const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
    if (!desk) {
      // Taken while its bases were fetched: back to the queue.
      this.d.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its reviewer' });
      return { queued: this.d.noRoom(floor, undefined, countsWith) ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
    }
    // The pull requests' heads, fetched: the reviewer's worktree is cut from the first one of each repository.
    const heads = await headsP;
    const x: ComposeExtra = { ...this.described(floor, def, task, req, involved, heads, eff.text), focus: review.focus };
    this.lines.set(task.id, x.prs ?? '');
    const prompt = typeable(this.d.compose.build('pr.review', def, task, tool, floor.dir, x));
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;
    const hired = floor.workers.spawn(desk, by, prompt, true, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, repoSources(def, involved), undefined, {
      launchArgs,
      bases: { ...this.d.baseBranches(def, involved), ...heads.bases },
      ...(countsWith ? { countsWith } : {}),
      kanban: { taskId: task.id, role: 'reviewer' },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return /taken out of the floor/.test(hired) ? (this.d.finishRun(run.id, task.project, { status: 'interrupted', error: hired }), { queued: this.d.noRoom(floor, undefined, countsWith) ?? "Queued: its desk was taken out of the floor. It starts by itself when a desk frees." }) : fail(hired);
    const live: Live = { taskId: task.id, runId: run.id, phase: 'pr-review', role: 'reviewer', ...(part ? { panel: part } : {}), tool, workerId: hired.id, floorId: task.project, exitPlan: false, ended: false, eff, via, ack: () => this.d.ctx.repo.clearRunLaunch(run.id) };
    this.d.follow(live, prompt);
    this.d.ctx.repo.updateRun(run.id, { workerId: hired.id });
    this.d.update(task.id, { ...slotPatch('reviewer', { workerId: hired.id }), runState: 'running' });
    this.d.exitedAtHire(live);
    return undefined;
  }

  /** What the review's prompts take: the pull requests' lines (how each is to be read), the task they belong to, the worktrees, and the request's post and uiTest. */
  private described(floor: Floor, def: FloorDef, task: KanbanTask, req: KanbanPrReviewRequest, involved: string[], heads: Awaited<ReturnType<typeof fetchPrHeads>>, text?: string): ComposeExtra {
    const prs = (req.prs as ReviewedPr[]).map((p) => `${prLine(p)} — ${readingNote(p, heads, def)}`).join('\n');
    const attached = req.taskId !== undefined;
    return {
      phase: 'pr-review',
      prs,
      prTask: attached ? `They are kanban task #${task.id}'s: ${task.title}${task.ticket ? ` (${task.ticket})` : ''}` : '',
      prRepos: reposText(def, { repoIds: involved, workspace: undefined }, floor.dir),
      prRepoIds: involved,
      text,
      ...(req.post ? { post: true } : {}),
      ...(req.uiTest ? { uiTest: true } : {}),
    };
  }

  /** What a run of the pr-review phase that goes through the engine's ordinary launch (a combine, a continued review) takes besides: the repositories, the pull requests, post and uiTest. */
  composeExtra(def: FloorDef, taskId: number): Partial<ComposeExtra> {
    const req = this.last(taskId);
    return { prRepoIds: prReviewRepoIds(def, req?.prs ?? []), ...(req?.prs.length ? { prs: (req.prs as ReviewedPr[]).map(prLine).join('\n') } : {}), ...(req?.post ? { post: true } : {}), ...(req?.uiTest ? { uiTest: true } : {}) };
  }

  /**
   * An additional reviewer's run of a pull-request review (seat 1..4), by the rules of the engine's ordinary launch for one: no queued
   * comments, no `launch` record on its run row, never the task's runState; its own tool, model, effort and focus; hired anew each
   * round into the MAIN reviewer's worktree, which the main reviewer owns (it leaves last and takes the worktree with it; see the guard
   * in Orchestrator.keepsWorktree). Its prompt is the review prompt, its focus and the additional reviewer's rule.
   */
  async launchCo(task: KanbanTask, def: FloorDef, floor: Floor, via: Via, seat: number, asked: RunEffect): Promise<string | { queued: string } | undefined> {
    const fresh = this.d.ctx.repo.getTask(task.id) ?? task;
    const review = this.d.reviewSettings(fresh);
    const spec = fresh.coReviewers?.find((c) => c.seat === seat) ?? review.extra?.[seat - 1]; // the seat as the round was opened with
    if (!spec) return `There is no additional reviewer ${seat} in the review settings`;
    const main = fresh.reviewerWorkerId ? floor.workers.get(fresh.reviewerWorkerId) : undefined;
    const req = this.last(task.id);
    if (!main?.worktree) return 'The main reviewer is not at its desk, so there is no worktree for an additional reviewer to sit in';
    if (!req?.prs.length) return 'There are no pull requests to review: pick them again';
    const { tool, model, effort } = spec;
    const adapter = this.d.adapters[tool], involved = prReviewRepoIds(def, req.prs);
    // The seat is hired anew each round (the worktree of an earlier round is gone, and a session does not outlive it): an older worker of it goes home.
    const old = slot(fresh, 'reviewer', seat).workerId;
    if (old && floor.workers.get(old)) await floor.sendHome(old, 'keep', ENGINE);
    this.d.update(task.id, slotPatch('reviewer', { workerId: null, sessionId: null }, seat, this.d.ctx.repo.getTask(task.id) ?? fresh));

    const owner = this.d.hireOwner(fresh, via.who);
    if (owner && tool === 'claude' && this.d.ctx.runAs && !this.d.ctx.runAs.claudeReady(owner)) return this.d.signInMissing(fresh, owner, via.who);
    const full = this.d.noRoom(floor, undefined, undefined, 'reviewer');
    if (full) return { queued: full };
    const x: ComposeExtra = { ...(await this.coExtra(floor, def, fresh, req, involved)), panel: 'co', focus: spec.focus };
    const prompt = typeable(this.d.compose.build('pr.review', def, fresh, tool, floor.dir, x));
    const extras = this.d.ctx.workerExtras(task.id, tool, skillPhase('pr-review'));
    const launchArgs = adapter.launchArgs('pr-review', { ...this.d.ctx.settings.launchPermissions(task.project, task.overrides), sandbox: review.sandbox, model, effort, extra: extras.args, ...prReviewDirs(this.d.ctx, fresh, !!req.uiTest) });

    const run = this.d.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'reviewer', tool, model, effort, seat, panel: 'co' });
    this.d.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const fail = (err: string) => (this.d.finishRun(run.id, task.project, { status: 'failed', error: err }), err);
    const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
    if (!desk) {
      this.d.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its reviewer' });
      return { queued: this.d.noRoom(floor, undefined, undefined, 'reviewer') ?? "Queued: there's no free desk on the floor for its worker." };
    }
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;
    const hired = floor.workers.spawn(desk, by, prompt, false, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, [], undefined, {
      launchArgs,
      reuse: { worktree: main.worktree, repos: main.repos },
      kanban: { taskId: task.id, role: 'reviewer', seat },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return /taken out of the floor/.test(hired) ? (this.d.finishRun(run.id, task.project, { status: 'interrupted', error: hired }), { queued: this.d.noRoom(floor, undefined, undefined, 'reviewer') ?? "Queued: its desk was taken out of the floor." }) : fail(hired);
    const live: Live = { taskId: task.id, runId: run.id, phase: 'pr-review', role: 'reviewer', seat, panel: 'co', tool, workerId: hired.id, floorId: task.project, exitPlan: false, ended: false, eff: { ...asked, pending: undefined }, via };
    this.d.follow(live, prompt);
    this.d.ctx.repo.updateRun(run.id, { workerId: hired.id });
    this.d.update(task.id, slotPatch('reviewer', { workerId: hired.id, sessionId: null }, seat, this.d.ctx.repo.getTask(task.id) ?? fresh, { tool, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(spec.focus ? { focus: spec.focus } : {}) }));
    this.d.exitedAtHire(live);
    return undefined;
  }

  /** An additional reviewer's prompt takes the pull requests' lines the main reviewer's got (kept when it was hired), else works them out again (an office restart in between). */
  private async coExtra(floor: Floor, def: FloorDef, task: KanbanTask, req: KanbanPrReviewRequest, involved: string[]): Promise<ComposeExtra> {
    const kept = this.lines.get(task.id);
    const heads = kept ? { bases: {}, uiBases: {}, targets: new Set<string>(), fetched: new Map(), checkedOut: new Set<string>() } : await fetchPrHeads(def, req.prs as ReviewedPr[], this.d.git, false, this.d.headsMs);
    const x = this.described(floor, def, task, req, involved, heads);
    return kept ? { ...x, prs: kept } : x;
  }

  // --- The end of a pr-review run -----------------------------------------------------------------

  /**
   * A pull-request review's turn ended with its result: the round's final text is the task's review comment (the main reviewer's solo run
   * of a round with additional reviewers is published later, by the panel, or replaced by its combine run), and is posted on the
   * pull requests when the request asked for it. Returns the machine event.
   */
  ended(task: KanbanTask, live: Live, text: string, pending: boolean, say: (kind: KanbanComment['kind'], text: string) => void): MachineEvent {
    if (live.panel === 'solo') this.solo.set(task.id, text);
    else {
      say('review', text);
      this.solo.delete(task.id);
      this.published(task, text, reviewVerdict(text));
    }
    return { type: 'prReviewed', pending };
  }

  /** The UI test's turn ended: see uiEnded. */
  uiEnded(task: KanbanTask, live: Live, text: string, say: (kind: 'result', text: string) => void) {
    return uiEnded(this.d, task, live, text, say);
  }

  /**
   * A round's final review text is out: posts it when the request has `post`, once the task's own operation is over. `verdict` is the run's own,
   * never read again from the text (which may be cut).
   */
  published(task: Pick<KanbanTask, 'id' | 'project' | 'createdByAccount'>, text: string, verdict: KanbanRun['verdict'], cut = false) {
    const req = this.last(task.id);
    if (!req?.post) return;
    void this.d.op(task.id, () => this.post(task, req, text, verdict, cut));
  }

  /** The panel publishes the main reviewer's own result (no additional reviewer gave one): its whole text when the engine still has it, else the run's stored summary, said to be cut where it was. */
  publishedSolo(task: Pick<KanbanTask, 'id' | 'project' | 'createdByAccount'>, summary: string, verdict: KanbanRun['verdict']) {
    const whole = this.solo.get(task.id);
    this.solo.delete(task.id);
    this.published(task, whole ?? summary, verdict, !whole && summary.length > SUMMARY_MAX);
  }

  /**
   * Posts the review on each pull request (KanbanPullsApi.postReview) and says in the task's conversation how each went. A failure to post
   * is never the task's: it keeps its state and column.
   */
  private async post(task: Pick<KanbanTask, 'id' | 'project' | 'createdByAccount'>, req: KanbanPrReviewRequest, text: string, verdict: KanbanRun['verdict'], cut: boolean) {
    const prs = req.prs as ReviewedPr[];
    const api = this.d.ctx.pulls.postReview;
    let results: { repo: string; number: number; url?: string; error?: string }[];
    try {
      results = api ? await api(task.project, prs, text, this.lastEvent(task.id)?.account ?? this.d.hireOwner(task), { verdict, cut }) : prs.map((p) => ({ repo: p.repo, number: p.number, error: "this office can't post reviews" }));
    } catch (err) {
      results = prs.map((p) => ({ repo: p.repo, number: p.number, error: (err as Error).message }));
    }
    for (const r of results) this.d.note(task, r.error ? `Could not post the review on ${r.repo}#${r.number}: ${clip(r.error, 300)}` : `Posted the review on ${r.repo}#${r.number}${r.url ? `: ${r.url}` : ''}`);
  }
}
