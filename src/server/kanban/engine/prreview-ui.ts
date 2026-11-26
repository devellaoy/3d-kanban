// The UI test before a pull-request review (the request's `uiTest`): the pr-review phase's first run, by an implementer-role agent in
// a fresh worktree of the involved repositories on their configured base branches (so the app starts as it is before the pull
// requests), who takes before and after pictures into the task's images folder. The pictures stay with the task: none is added to a
// pull request. When its turn ends the tester goes home with its worktree, and the review starts by itself (machine event
// `prUiTested`). Split out of prreview-launch.ts; PrReviews hands it the request and the engine's deps.

import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import { nextFreeSeat } from '../../../shared/layout.js';
import type { DepartureIntent, KanbanPrReviewRequest, KanbanTask } from '../../../shared/kanban/types.js';
import { repoSources } from '../projects.js';
import { reposText, skillPhase, type ComposeExtra } from './compose.js';
import type { Live, Via } from './live.js';
import { queuedOf, type RunEffect } from './machine.js';
import { fetchPrHeads, prKey, prLine, type HeadPr } from './prheads.js';
import type { PrReviewDeps } from './prreview-launch.js';
import { slot, slotPatch } from './slot.js';
import { typeable } from './turnhold.js';
import { ensureUiImagesDir, uiImagesDir } from './uitesting.js';
import { instructionReadDirs, prReviewRepoIds } from './launchdirs.js';
import { grantDir } from '../uploads.js';

const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };

/**
 * Hires the tester: it never carries on an earlier one (a Retry, an office restart or an answer to its question starts the UI test
 * again, with what the user said); the old tester goes home with its worktree first. Like every hire it may be queued.
 */
export async function launchUi(d: PrReviewDeps, req: KanbanPrReviewRequest, task: KanbanTask, def: FloorDef, floor: Floor, via: Via, asked: RunEffect): Promise<string | { queued: string } | undefined> {
  const kept = typeof asked.text === 'string' && asked.text ? asked.text : undefined;
  const defaults = d.ctx.settings.get().defaults;
  const tool = defaults.tool, model = defaults.model, effort = defaults.effort;
  const adapter = d.adapters[tool];
  const involved = prReviewRepoIds(def, req.prs);

  const prev = slot(task, 'implementer').workerId ? floor.workers.get(slot(task, 'implementer').workerId!) : undefined;
  if (prev) await floor.sendHome(prev.id, 'all', ENGINE);
  d.update(task.id, slotPatch('implementer', { workerId: null, sessionId: null }));

  const owner = d.hireOwner(task, via.who);
  const signIn = owner && tool === 'claude' && d.ctx.runAs && !d.ctx.runAs.claudeReady(owner) ? d.signInMissing(task, owner, via.who) : undefined;
  const full = signIn ? undefined : d.noRoom(floor, undefined, undefined, 'implementer');
  if (full) return { queued: full };

  const run = d.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'implementer', tool, model, effort, launch: { ...queuedOf({ ...asked, pending: undefined, phase: 'pr-review', role: 'implementer' }), prompt: kept ? asked.prompt : 'pr.uitest', ...(via.commentId !== undefined ? { commentId: via.commentId } : {}) } });
  d.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
  const fail = (err: string) => (d.finishRun(run.id, task.project, { status: 'failed', error: err }), err);
  if (signIn) return fail(signIn);
  await d.freshBase(floor, def, involved);
  const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
  if (!desk) {
    d.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its tester' });
    return { queued: d.noRoom(floor, undefined, undefined, 'implementer') ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
  }

  // Every head, fetched: the tester checks each pull request out itself, in a worktree of its own (the ref its line names).
  const heads = await fetchPrHeads(def, req.prs as HeadPr[], d.git, true);
  const prs = (req.prs as HeadPr[]).map((p) => {
    const got = heads.fetched.get(prKey(p));
    return `${prLine(p)} — ${got ? `its head is fetched as origin/${got.ref}` : `its head is not fetched: git fetch origin pull/${p.number}/head, then FETCH_HEAD is its head`}`;
  });
  const x: ComposeExtra = {
    phase: 'implement', // the tester ends its turn like an implementer: the work-done line
    prs: prs.join('\n'),
    prTask: '',
    prRepos: reposText(def, { repoIds: involved, workspace: undefined }, floor.dir),
    prRepoIds: involved,
    text: kept,
  };
  const imagesDir = uiImagesDir(d.ctx.filesDir, task.id);
  try {
    ensureUiImagesDir(imagesDir);
  } catch (err) {
    return fail(`The folder for the pictures couldn't be made: ${(err as Error).message}`);
  }
  const prompt = typeable(d.compose.build('pr.uitest', def, task, tool, floor.dir, x));
  const extras = d.ctx.workerExtras(task.id, tool, skillPhase('implement'));
  const launchArgs = adapter.launchArgs('implement', { ...d.ctx.settings.launchPermissions(task.project, task.overrides), sandbox: false, network: true, addDirs: [grantDir(d.ctx.filesDir, task.id)], readDirs: instructionReadDirs(d.ctx, task.project), model, effort, extra: extras.args });
  const by = `${via.who?.name ?? 'Kanban'} (kanban #${task.id})`;
  const hired = floor.workers.spawn(desk, by, prompt, true, 'agent', tool, adapter.spawnModel(model), adapter.spawnEffort(effort), undefined, owner, repoSources(def, involved), undefined, {
    launchArgs,
    bases: d.baseBranches(def, involved),
    kanban: { taskId: task.id, role: 'implementer' },
    env: extras.env,
    settingsFile: 'kanban',
  });
  if (typeof hired === 'string') {
    if (!/taken out of the floor/.test(hired)) return fail(hired);
    d.finishRun(run.id, task.project, { status: 'interrupted', error: hired });
    return { queued: d.noRoom(floor, undefined, undefined, 'implementer') ?? "Queued: its desk was taken out of the floor. It starts by itself when a desk frees." };
  }
  const live: Live = { taskId: task.id, runId: run.id, phase: 'implement', ui: true, role: 'implementer', tool, workerId: hired.id, floorId: task.project, exitPlan: false, ended: false, eff: { ...asked, pending: undefined, ...(kept ? { text: kept } : {}) }, via, ack: () => d.ctx.repo.clearRunLaunch(run.id) };
  d.follow(live, prompt);
  d.ctx.repo.updateRun(run.id, { workerId: hired.id });
  d.update(task.id, { ...slotPatch('implementer', { workerId: hired.id }), runState: 'running' });
  d.exitedAtHire(live);
  return undefined;
}

/**
 * The tester's turn ended with its reply: it is a `result` comment of the task, the tester goes home with its worktree removed (a
 * worker that is not a reviewer would keep it), and the review starts. Returns the machine event for that.
 */
export async function uiEnded(d: PrReviewDeps, task: KanbanTask, live: Live, text: string, say: (kind: 'result', text: string) => void): Promise<{ type: 'prUiTested' }> {
  say('result', text);
  const floor = d.ctx.floor(live.floorId);
  if (floor?.workers.get(live.workerId)) await floor.sendHome(live.workerId, 'all', ENGINE);
  d.update(task.id, slotPatch('implementer', { workerId: null, sessionId: null }));
  return { type: 'prUiTested' };
}
