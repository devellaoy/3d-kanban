// The UI test before a pull-request review (the request's `uiTest`): the pr-review phase's first run, by an implementer-role agent in
// a fresh worktree of the involved repositories on their configured base branches (so the app starts as it is before the pull
// requests), who tests the UI and the functionality the pull requests change with real browser actions, takes before and after
// pictures into the task's images folder and writes a test report in the task's grant folder (ui-test-report.md; the reply is the
// fallback when it left none). The pictures stay with the task: none is added to a pull request; the reviewers read the report.
// When its turn ends the tester goes home with its worktree, and the review starts by itself (machine event `prUiTested`). Split out of prreview-launch.ts; PrReviews hands it the request and the engine's deps.

import path from 'node:path';
import type { FloorDef } from '../../building.js';
import type { Floor } from '../../floor.js';
import { nextFreeSeat } from '../../../shared/layout.js';
import type { DepartureIntent, KanbanPrReviewRequest, KanbanTask } from '../../../shared/kanban/types.js';
import { repoSources } from '../projects.js';
import { reposText, skillPhase, type ComposeExtra } from './compose.js';
import type { Live, Via } from './live.js';
import { queuedOf, type RunEffect } from './machine.js';
import { fetchPrHeads, prKey, prLine, repoOf, trusted, type HeadPr } from './prheads.js';
import type { PrReviewDeps } from './prreview-launch.js';
import { slot, slotPatch } from './slot.js';
import { typeable } from './turnhold.js';
import { ensureUiImagesDir, uiImagesDir } from './uitesting.js';
import { instructionReadDirs, prReviewRepoIds } from './launchdirs.js';
import { grantDir } from '../uploads.js';
import { dropUiTestReport, readUiTestReport, storeUiTestReport } from '../taskfiles.js';

const ENGINE: DepartureIntent = { by: 'Kanban', reason: 'engine' };
/** The heading the tester's prompt asks its report to start with. */
const REPORT_HEADING = /^#{1,6}\s*UI test report\b/im;

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
  // An earlier tester's report is not this one's; and no file is left, so the tester can create it itself (the office's copies are read-only).
  dropUiTestReport(d.ctx.filesDir, task.id);

  const owner = d.hireOwner(task, via.who);
  const signIn = owner && tool === 'claude' && d.ctx.runAs && !d.ctx.runAs.claudeReady(owner) ? d.signInMissing(task, owner, via.who) : undefined;
  const full = signIn ? undefined : d.noRoom(floor, undefined, undefined, 'implementer');
  if (full) return { queued: full };

  const run = d.ctx.repo.createRun({ taskId: task.id, phase: 'pr-review', role: 'implementer', tool, model, effort, launch: { ...queuedOf({ ...asked, pending: undefined, phase: 'pr-review', role: 'implementer' }), prompt: kept ? asked.prompt : 'pr.uitest', ...(via.commentId !== undefined ? { commentId: via.commentId } : {}) } });
  d.ctx.broadcast({ t: 'kanban.run', run, project: task.project }, task.project);
  const fail = (err: string) => (d.finishRun(run.id, task.project, { status: 'failed', error: err }), err);
  if (signIn) return fail(signIn);
  // A fork's pull request, or one not confirmed not to be, is never checked out or run: it is left out of the test, and the prompt says why.
  const all = req.prs as HeadPr[], testable = all.filter(trusted);
  if (!testable.length) return fail('No pull request is confirmed not to be from a fork, and the office never checks out or runs code that might be: there is no UI to test');
  // Every head and each repository's first target, fetched while the configured bases are, all bounded.
  const headsP = fetchPrHeads(def, testable, d.git, true, d.headsMs);
  await d.freshBase(floor, def, involved);
  const desk = nextFreeSeat((id) => floor.workers.deskOccupied(id), floor.workers.wing?.() ?? 0, floor.workers.removed?.())?.id;
  if (!desk) {
    d.finishRun(run.id, task.project, { status: 'interrupted', error: 'There was no free desk for its tester' });
    return { queued: d.noRoom(floor, undefined, undefined, 'implementer') ?? "Queued: there's no free desk on the floor for its worker. It starts by itself when one frees." };
  }

  const heads = await headsP;
  const note = (p: HeadPr) => {
    const got = heads.fetched.get(prKey(p));
    const repo = repoOf(def, p);
    const start = repo ? heads.uiBases[path.resolve(repo.dir)] : undefined;
    const head = got ? `its head is fetched as origin/${got.ref}` : `its head is not fetched: git fetch origin pull/${p.number}/head, then FETCH_HEAD is its head`;
    const target = !p.base ? 'its target branch is not known, so your workspace is on the configured base branch'
      : p.base === start ? `it targets ${p.base}, which your workspace starts from (origin/${p.base})`
      : `it targets ${p.base}, ${start ? `not ${start} that your workspace starts from` : 'and your workspace is on the configured base branch'}: ${start ? '' : 'unless that is the same branch, '}take its "before" pictures in a worktree of its own target, ${heads.targets.has(prKey(p)) ? '' : `git fetch origin ${p.base}, then `}git worktree add --detach ./base-${p.number} origin/${p.base}`;
    return `${prLine(p)} — ${head}; ${target}`;
  };
  const prs = [
    ...testable.map(note),
    ...all.filter((p) => !trusted(p)).map((p) => `${prLine(p)} — ${p.fork === true ? 'from a fork' : 'the office could not confirm it is not from a fork'}: not checked out, not run and not tested`),
  ];
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
    bases: { ...d.baseBranches(def, involved), ...heads.uiBases }, // each repository's tester worktree starts from the target of the first pull request tested there
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
 * The report of a UI test, from what the tester wrote in its file (`own`, see readUiTestReport) and its last reply: the file's
 * text comes first; a reply that is a report too (it has the report's heading) and says something the file does not is kept
 * after it, so neither a draft in the file nor a short reply loses the other's findings. Without a file it is the reply.
 */
export function uiTestReport(own: string | undefined, reply: string): string {
  const text = reply.trim();
  if (!own) return text;
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  if (!REPORT_HEADING.test(text) || flat(own).includes(flat(text))) return own;
  return `${own}\n\n---\n\nThe tester's final reply:\n\n${text}`;
}

/**
 * The tester's turn ended with its reply. Its report (uiTestReport) is one text: it replaces whatever is at the report's path as
 * the office's own copy, which the reviewers read, and it is the `result` comment of the task. The tester goes home with its
 * worktree removed (a worker that is not a reviewer would keep it), and the review starts. Returns the machine event for that.
 */
export async function uiEnded(d: PrReviewDeps, task: KanbanTask, live: Live, text: string, say: (kind: 'result', text: string) => void): Promise<{ type: 'prUiTested' }> {
  const report = uiTestReport(readUiTestReport(d.ctx.filesDir, task.id), text);
  say('result', report);
  // Whatever the tester left at the path is replaced unread: a file over the limit, a link or a folder is not compared with or written through.
  storeUiTestReport(d.ctx.filesDir, task.id, report);
  const floor = d.ctx.floor(live.floorId);
  if (floor?.workers.get(live.workerId)) await floor.sendHome(live.workerId, 'all', ENGINE);
  d.update(task.id, slotPatch('implementer', { workerId: null, sessionId: null }));
  return { type: 'prUiTested' };
}
