// A pull-request review's start (phase pr-review): the task it runs on (or a new investigate task for it), and the run
// that hires its reviewer in a worktree of each repository the pull requests are in. Split out of the orchestrator like
// Holds; the engine's own state reaches it through the small `PrReviewDeps` interface.

import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import { nextFreeSeat } from '../../../shared/layout.js';
import type { KanbanCaller, KanbanContext } from '../registry.js';
import type { DepartureIntent, KanbanPrReviewRequest, KanbanRole, KanbanTask, KanbanTool, PrRef } from '../../../shared/kanban/types.js';
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

/** A pull request as a review request may name it: the pulls plugin hands on what it looked up. */
export type ReviewedPr = PrRef & { title?: string; url?: string; branch?: string };

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
}

/** How the engine sends its own workers home (the orchestrator's ENGINE). */
const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

export class PrReviews {
  constructor(private d: PrReviewDeps) {}

  /**
   * Several pull requests reviewed together, as a run of its own (phase pr-review): on the task the
   * request names, or on a new investigate task for it. The request comes checked (KanbanPullsApi.review);
   * this checks only what the engine itself needs.
   */
  async review(req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> {
    const def = this.d.ctx.project(req.project);
    if (!def) return `There's no project ${req.project}`;
    if (!this.d.watch(req.project)) return "The project's floor isn't open, so there's nowhere to seat a reviewer";
    if (isFolderProject(def)) return 'A folder project has no pull requests to review';
    if (!req.prs.length) return 'Pick at least one pull request';
    const labels = req.prs.map((p) => `${p.repo}#${p.number}`);
    const target = this.taskFor(req, def, who);
    if (typeof target === 'string') return target;
    const { taskId, named, created } = target;
    const request: KanbanPrReviewRequest = { project: req.project, prs: req.prs, ...(named !== undefined ? { taskId: named } : {}), ...(req.tool ? { tool: req.tool } : {}), ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) };
    const err = await this.d.op(taskId, async (task) => {
      if (this.d.running(task.id)) return 'Stop it first: it is running';
      this.d.ctx.repo.appendEvent(task.id, 'pr.review', { by: who.name, prs: labels, request });
      return this.d.apply(task.id, { type: 'prReview' }, { who, prReview: request });
    });
    const task = this.d.ctx.repo.getTask(taskId);
    if (!err && task?.runState === 'queued' && task.queuedRun?.phase === 'pr-review') {
      // No room now (a desk, the worker limit): the task waits in the queue and the review starts by itself.
      this.d.note(task, `${who.name} asked for a review of ${labels.join(', ')}`);
      return { taskId };
    }
    const workerId = task?.reviewerWorkerId;
    const info = workerId ? this.d.ctx.floor(req.project)?.workers.get(workerId) : undefined;
    if (err || !task || !workerId || !info) {
      // A review task that never got its reviewer is no use to anyone: it goes again.
      if (created && task && !this.d.running(task.id)) {
        this.d.ctx.repo.deleteTask(task.id);
        this.d.ctx.broadcast({ t: 'kanban.task.removed', id: task.id, project: task.project }, task.project);
      }
      return err || 'The reviewer could not be hired';
    }
    this.d.note(task, `${who.name} asked ${info.name} to review ${labels.join(', ')}`);
    return { taskId, workerId };
  }

  /** The request of the task's latest pull-request review (for a Retry), as reviewPrs recorded it. */
  last(taskId: number): KanbanPrReviewRequest | undefined {
    const e = [...this.d.ctx.repo.listEvents(taskId)].reverse().find((x) => x.kind === 'pr.review');
    const req = (e?.data as { request?: KanbanPrReviewRequest } | undefined)?.request;
    return req && Array.isArray(req.prs) ? req : undefined;
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

  /**
   * A pull-request review's run: its own reviewer, hired fresh in a worktree of each repository the
   * pull requests are in (never the floor's checkout, never the task's worktree), with the review's
   * read-only flags. A Retry reviews them again from the start.
   */
  async launch(task: KanbanTask, def: FloorDef, floor: Floor, via: Via, restarted: boolean, asked: RunEffect): Promise<string | { queued: string } | undefined> {
    if (isFolderProject(def)) return 'A folder project has no pull requests to review';
    const kept = !asked.text ? this.d.comments.take(task, via.pendingSince, (m) => !!m.answer) : undefined;
    const eff: RunEffect = { ...asked, pending: undefined, ...(kept ? { text: kept.text } : {}) };
    if (kept) via.taken = kept.msgs; // what the user said to a reviewer that asked: the comment that answered it, or (a Retry, whichever prompt it picks) that answer given back; the rest of the queue is the implementer's
    const req = via.prReview ?? this.last(task.id);
    if (!req?.prs.length) return 'There are no pull requests to review: pick them again';
    const review = this.d.reviewSettings(task), tool: KanbanTool = req.tool ?? review.tool, same = !req.tool || req.tool === review.tool;
    const model = req.model ?? (same ? review.model : undefined), effort = req.effort ?? (same ? review.effort : undefined);
    const adapter = this.d.adapters[tool], involved = prReviewRepoIds(def, req.prs);

    // Whoever reviewed for the task before goes home: this review starts in a worktree of its own.
    const prev = slot(task, 'reviewer').workerId ? floor.workers.get(slot(task, 'reviewer').workerId!) : undefined;
    if (prev && (prev.status === 'working' || (prev.status === 'starting' && !restarted))) return `${prev.name} is busy: wait for its turn to end`;
    if (prev) await floor.sendHome(prev.id, homeCleanup(task, prev), ENGINE);
    this.d.update(task.id, slotPatch('reviewer', { workerId: null, sessionId: null }));

    const attached = req.taskId !== undefined;
    const prs = (req.prs as ReviewedPr[]).map((p) => `- ${p.repo}#${p.number}${p.title ? ` “${p.title}”` : ''}${p.branch ? ` (branch ${p.branch})` : ''} ${p.url ?? `https://github.com/${p.repo}/pull/${p.number}`}`).join('\n');
    const x: ComposeExtra = {
      phase: 'pr-review',
      prs,
      prTask: attached ? `They are kanban task #${task.id}'s: ${task.title}${task.ticket ? ` (${task.ticket})` : ''}` : '',
      prRepos: reposText(def, { repoIds: involved, workspace: undefined }, floor.dir), prRepoIds: involved, text: eff.text,
    };
    const prompt = typeable(this.d.compose.build('pr.review', def, task, tool, floor.dir, x));
    const extras = this.d.ctx.workerExtras(task.id, tool, skillPhase('pr-review'));
    const dirs = prReviewDirs(this.d.ctx, task, !!eff.text);
    const launchArgs = adapter.launchArgs('pr-review', { ...this.d.ctx.settings.launchPermissions(task.project, task.overrides), sandbox: review.sandbox, model, effort, extra: extras.args, ...dirs });

    const owner = this.d.hireOwner(task, via.who);
    const signIn = owner && tool === 'claude' && this.d.ctx.runAs && !this.d.ctx.runAs.claudeReady(owner) ? this.d.signInMissing(task, owner, via.who) : undefined;
    const countsWith = this.d.sharesLimit(this.d.ctx.repo.getTask(task.id) ?? task, 'reviewer', floor);
    // No desk, or the office's worker limit: queued as any hire is (the drain runs it again, the
    // pull requests from its pr.review event).
    const full = signIn ? undefined : this.d.noRoom(floor, undefined, countsWith);
    if (full) return { queued: full };

    const run = this.d.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'reviewer', tool, model, effort, launch: { ...queuedOf({ ...eff, phase: 'pr-review', role: 'reviewer' }), prompt: eff.text ? eff.prompt : 'pr.review', ...(via.taken?.length ? { taken: via.taken } : {}), ...(via.commentId !== undefined ? { commentId: via.commentId } : {}) } });
    this.d.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
    const fail = (err: string) => {
      this.d.finishRun(run.id, task.project, { status: 'failed', error: err });
      return err;
    };
    if (signIn) return fail(signIn);
    await this.d.freshBase(floor, def, involved);
    const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
    if (!desk) {
      // Taken while its bases were fetched: back to the queue.
      this.d.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its reviewer' });
      return { queued: this.d.noRoom(floor, undefined, countsWith) ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
    }
    const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;
    const hired = floor.workers.spawn(desk, by, prompt, true, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, repoSources(def, involved), undefined, {
      launchArgs,
      bases: this.d.baseBranches(def, involved),
      ...(countsWith ? { countsWith } : {}),
      kanban: { taskId: task.id, role: 'reviewer' },
      env: extras.env,
      settingsFile: 'kanban',
    });
    if (typeof hired === 'string') return /taken out of the floor/.test(hired) ? (this.d.finishRun(run.id, task.project, { status: 'interrupted', error: hired }), { queued: this.d.noRoom(floor, undefined, countsWith) ?? "Queued: its desk was taken out of the floor. It starts by itself when a desk frees." }) : fail(hired);
    const live: Live = { taskId: task.id, runId: run.id, phase: 'pr-review', role: 'reviewer', tool, workerId: hired.id, floorId: task.project, exitPlan: false, ended: false, eff, via, ack: () => this.d.ctx.repo.clearRunLaunch(run.id) };
    this.d.follow(live, prompt);
    this.d.ctx.repo.updateRun(run.id, { workerId: hired.id });
    this.d.update(task.id, { ...slotPatch('reviewer', { workerId: hired.id }), runState: 'running' });
    this.d.exitedAtHire(live);
    return undefined;
  }
}
