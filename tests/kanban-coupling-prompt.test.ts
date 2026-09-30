// The kanban and the 3D office as one world (docs/kanban-coupling.md): P, an issue card dropped on a
// desk and Ask onto a task worker become task comments when sent asComment (anything else is typed
// straight in, as upstream; a reviewer refuses a comment);
// R on a task worker whose task waits is Retry; the executor can change whenever no run is live; a
// task waiting on a person is announced to the office's team notifications; the hook port can be
// pinned; and the engine's last hard-coded agent texts are editable prompts.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ADA, engineFixture, type EngineFixture, type Rule } from './kanban-engine-fixture.js';
import { promptTaskWorker, resumeTaskWorker } from '../src/server/kanban/coupling.js';
import { createCorePlugin } from '../src/server/kanban/ws.js';
import type { KanbanClient, KanbanContext } from '../src/server/kanban/registry.js';
import { next } from '../src/server/kanban/engine/machine.js';
import { loadConfig } from '../src/server/config.js';
import { Webhook } from '../src/server/webhook.js';
import { PROMPTS, fillPrompt } from '../src/shared/prompts.js';
import { resolveKanbanPrompt } from '../src/shared/kanban/prompts.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';

const IMPLEMENT: Rule = { when: 'Implement kanban task', reply: 'Changed the redirect.', commit: 'Fix the redirect' };
const GRACE = { name: 'Grace', admin: false };

/** The fixture's context as the kanban's own parts get it (taskChanged and card included). */
const ctxOf = (fx: EngineFixture) => ({ ...fx.ctx, taskChanged: () => {}, card: (id: number) => fx.repo.card(id) }) as KanbanContext;

async function inReview(fx: EngineFixture, patch: Parameters<EngineFixture['newTask']>[0] = {}) {
  const task = fx.newTask({ usePlan: false, useReview: false, ...patch });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  return fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
}

test('an asComment prompt to a task implementer is a comment its agent works on; the default is typed in; a reviewer refuses', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const issue = fillPrompt(PROMPTS['issue.work'].text, { number: 7, title: 'Dog barks', url: 'u' });
  fx.setRules([IMPLEMENT, { when: 'Also handle the logout', reply: 'Handled the logout too.', commit: 'Logout' }, { when: 'commented on task[\\s\\S]*GitHub issue #7', reply: 'Looked at issue 7.' }]);
  const ctx = ctxOf(fx);
  const task = await inReview(fx);
  const info = fx.workers.get(task.workerId!)!;

  // P (or Ask → this worker): a user comment from whoever typed it, and the engine follows the turn.
  const mark = fx.history(task.id).length;
  assert.equal(await promptTaskWorker(ctx, info, 'Also handle the logout', GRACE, true), undefined);
  const comment = fx.repo.listComments(task.id).comments.find((c) => c.authorKind === 'user');
  assert.equal(comment?.authorName, 'Grace');
  assert.equal(comment?.text, 'Also handle the logout');
  assert.ok(fx.broadcasts.some((m) => m.t === 'kanban.comment' && m.comment.id === comment!.id));
  await fx.sawTask(task.id, (x) => x.runState !== 'idle' || x.phase === 'resume', 'the comment worked on', 15_000, mark);
  let x = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle', 'back in review', 30_000);
  assert.equal(x.summary, 'Handled the logout too.');
  assert.ok(fx.repo.listRuns(task.id).some((r) => r.phase === 'resume' && r.status === 'succeeded'));

  // An issue card dropped on its desk sends the issue's prompt the same way.
  assert.equal(await promptTaskWorker(ctx, info, issue, ADA, true), undefined);
  x = await fx.waitTask(task.id, (y) => y.status === 'review' && y.runState === 'idle' && y.summary === 'Looked at issue 7.', 'the issue worked on', 30_000);

  // The default (the terminal's say box, upstream's callers): upstream's to type in, even at a reviewer.
  assert.equal(promptTaskWorker(ctx, info, 'ls', ADA), undefined);
  assert.equal(promptTaskWorker(ctx, { ...info, kanban: { ...info.kanban!, role: 'reviewer' } }, 'ls', ADA), undefined);
  // asComment: a reviewer refuses; not a task worker is upstream's; a task the automation isn't on refuses.
  assert.match((await promptTaskWorker(ctx, { ...info, kanban: { ...info.kanban!, role: 'reviewer' } }, 'Approve it', ADA, true)) ?? '', new RegExp(`is reviewing task #${task.id}`));
  assert.equal(promptTaskWorker(ctx, { ...info, kanban: undefined }, 'hi', ADA, true), undefined);
  const before = fx.repo.listComments(task.id).comments.length;
  for (const status of ['done', 'todo', 'archived'] as const) {
    fx.repo.updateTask(task.id, { status });
    assert.match((await promptTaskWorker(ctx, info, 'hi', ADA, true)) ?? '', new RegExp(`Task #${task.id} is in .*its agent isn't on it`), status);
  }
  assert.equal(fx.repo.listComments(task.id).comments.length, before, 'no comment stored for a refused one');
});

test('R on a task worker whose task waits is Retry; otherwise it is upstream’s resume', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ when: 'Implement kanban task', reply: '', delayMs: 800 }]);
  const ctx = ctxOf(fx);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const running = await fx.waitTask(task.id, (x) => x.runState === 'running' && !!x.workerId, 'running');
  const info = () => fx.workers.get(running.workerId!)!;
  assert.equal(resumeTaskWorker(ctx, info(), ADA), undefined, 'running: nothing to retry');
  // A turn with no reply the office can read: it waits, failed, with Retry.
  await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the failed turn', 20_000);

  fx.setRules([{ when: 'was cut short', reply: 'Finished it.', commit: 'Work' }]);
  const retried = resumeTaskWorker(ctx, info(), ADA);
  assert.ok(retried, 'a failed task is retried');
  assert.equal(await retried, undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.equal(done.workerId, running.workerId, 'the same worker carried on: no raw relaunch');
  assert.equal(done.summary, 'Finished it.');
  assert.ok(fx.invocations().some((i) => /was cut short/.test(i.prompt ?? '')));
  assert.equal(resumeTaskWorker(ctx, info(), ADA), undefined, 'in Review: upstream resumes it');
});

test('the executor changes whenever no run is live, and the next phase hires the new tool with a handoff', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([{ ...IMPLEMENT, delayMs: 1500 }, { when: 'You are taking over kanban task', reply: 'Renamed it in codex.', commit: 'Rename' }]);
  const ctx = ctxOf(fx);
  const plugin = createCorePlugin(ctx, { subscribe() {}, unsubscribe() {} });
  const got: KanbanServerMsg[] = [];
  const client: KanbanClient = { clientId: 'c1', name: 'Ada', admin: true, send: (m) => void got.push(m) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (msg: any) => (plugin.ws as any)[msg.t](client, msg) as Promise<void>;
  const last = () => got[got.length - 1];

  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  await fx.waitTask(task.id, (x) => x.runState === 'running', 'running');
  await send({ t: 'kanban.task.update', rid: 'r1', id: task.id, patch: { tool: 'codex' } });
  assert.equal(last().t, 'kanban.error');
  assert.match((last() as { message: string }).message, /tool can only be changed while no run is going/);
  const inReview = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  const claudeWorker = inReview.workerId!;

  await send({ t: 'kanban.task.update', rid: 'r2', id: task.id, patch: { tool: 'codex', model: null, review: { tool: 'codex' } } });
  assert.equal(last().t, 'kanban.ok', JSON.stringify(last()));
  assert.equal(fx.task(task.id).tool, 'codex');
  assert.deepEqual(fx.task(task.id).overrides.review, { tool: 'codex' });
  // Structural fields still only in To do.
  await send({ t: 'kanban.task.update', rid: 'r3', id: task.id, patch: { useReview: true } });
  assert.equal(last().t, 'kanban.error');

  const { comment } = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', kind: 'message', text: 'Rename the helper' });
  await fx.engine.commented(task.id, comment.id, ADA);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && x.summary === 'Renamed it in codex.', 'the codex turn', 30_000);
  assert.notEqual(done.workerId, claudeWorker, 'the claude worker went home');
  assert.equal(fx.workers.get(claudeWorker), undefined);
  assert.equal(fx.workers.get(done.workerId!)?.provider, 'codex');
  const handoff = fx.invocations().find((i) => i.kind === 'codex' && /You are taking over kanban task/.test(i.prompt ?? ''));
  assert.ok(handoff, 'the new tool got the handoff');
  assert.match(handoff.prompt ?? '', /Rename the helper/);
  const lastRun = fx.repo.listRuns(task.id).at(-1)!;
  assert.equal(lastRun.tool, 'codex');
});

test('a task waiting on a person is announced once per transition: plan approval, questions, ready for review', async (t) => {
  const told: string[] = [];
  const fx = await engineFixture({ notify: (title) => void told.push(title) });
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task #1 ', reply: 'Plan.\n\nPLAN READY', exitPlan: '1. Change it' },
    { when: 'You are planning kanban task #2 ', reply: 'QUESTIONS:\n1. Which page?' },
    IMPLEMENT,
  ]);
  const a = fx.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx.engine.start(a.id, ADA);
  await fx.waitTask(a.id, (x) => x.waitingReason === 'plan_approval', 'plan approval', 30_000);
  assert.deepEqual(told, [`🗂️ #${a.id} Fix the login redirect needs plan approval in Proj`]);
  // Another look at it (a comment queued meanwhile, a stop...) that leaves it waiting the same isn't announced again.
  await fx.engine.approvePlan(a.id, ADA);
  await fx.waitTask(a.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 30_000);
  assert.deepEqual(told.slice(1), [`🗂️ #${a.id} Fix the login redirect is ready for review in Proj`]);

  const b = fx.newTask({ usePlan: true, planApproval: 'manual', useReview: false });
  await fx.engine.start(b.id, ADA);
  await fx.waitTask(b.id, (x) => x.waitingReason === 'plan_questions', 'questions', 30_000);
  assert.equal(told.at(-1), `🗂️ #${b.id} Fix the login redirect has questions in Proj`);
  assert.equal(told.length, 3);
});

test("upstream's webhook posts the kanban's announcements like a worker's alert, and nothing without a webhook", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const hook = new Webhook(dir, () => 'The office', () => {});
  hook.announce('nobody hears this');
  assert.equal(hook.set(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, 'Ada'), undefined);
  hook.announce('🗂️ #14 Fix it needs plan approval in Proj');
  for (let i = 0; i < 100 && !bodies.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bodies, [{ text: '🗂️ #14 Fix it needs plan approval in Proj', event: 'needs_input', project: 'The office' }]);
  hook.stop();
});

test('--hook-port and AGENT_OFFICE_HOOK_PORT pin the hook port', (t) => {
  const load = (argv: string[], env?: string) => {
    const home = mkdtempSync(path.join(tmpdir(), 'kanban-hookport-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const exit = process.exit;
    const error = console.error;
    const before = process.env.AGENT_OFFICE_HOOK_PORT;
    const errors: string[] = [];
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code}: ${errors.join('\n')}`);
    }) as typeof process.exit;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    if (env === undefined) delete process.env.AGENT_OFFICE_HOOK_PORT;
    else process.env.AGENT_OFFICE_HOOK_PORT = env;
    try {
      return loadConfig(['--home', home, '--password', 'x', ...argv]);
    } finally {
      process.exit = exit;
      console.error = error;
      if (before === undefined) delete process.env.AGENT_OFFICE_HOOK_PORT;
      else process.env.AGENT_OFFICE_HOOK_PORT = before;
    }
  };
  assert.equal(load([]).hookPort, undefined, 'unpinned: the last office’s port, else any');
  assert.equal(load(['--hook-port', '7999']).hookPort, 7999);
  assert.equal(load([], '7998').hookPort, 7998);
  assert.equal(load(['--hook-port', '7997'], '7998').hookPort, 7997, 'the flag wins');
  assert.throws(() => load(['--hook-port', 'x']), /exit 2: agent-office: --hook-port needs a port number/);
  assert.throws(() => load(['--hook-port', '70000']), /exit 2/);
});

test("the engine's default answer and the prompts' headings are editable kanban prompts", () => {
  const s = { status: 'waiting' as const, runState: 'idle' as const, waitingReason: 'plan_questions' as const, reviewRound: 0, retryAttempts: 0 };
  const t = { type: 'implement' as const, usePlan: true, useReview: false, planApproval: 'manual' as const };
  const run = (cfg: Parameters<typeof next>[3]) => {
    const tr = next(s, { type: 'continue' }, t, cfg);
    assert.ok(!('error' in tr));
    const eff = tr.effects.find((e) => e.type === 'run');
    return eff && eff.type === 'run' ? eff.text : undefined;
  };
  assert.equal(run({ rounds: 1, reReviewLastFix: false }), PROMPTS['kanban.defaultAnswer'].text);
  assert.equal(run({ rounds: 1, reReviewLastFix: false, defaultAnswer: 'Assume the login page.' }), 'Assume the login page.');
  for (const id of ['kanban.defaultAnswer', 'kanban.sinceSaid', 'kanban.ticket', 'kanban.attachments', 'kanban.instructions', 'kanban.instructions.general', 'kanban.instructions.testing', 'kanban.instructions.repo', 'kanban.refsFile', 'kanban.acceptedPlan', 'kanban.prSummary', 'kanban.handoff.summary', 'kanban.handoff.comments'] as const) {
    assert.equal(PROMPTS[id].group, 'kanban', `${id} is in the office prompt editor`);
  }
  assert.equal(resolveKanbanPrompt('kanban.sinceSaid', {}, { text: 'Use the new API.' }), 'The user has since said:\nUse the new API.');
  assert.equal(resolveKanbanPrompt('kanban.ticket', { project: { 'kanban.ticket': 'Jira: {{ticket}}' } }, { ticket: 'UYT-1', url: '' }), 'Jira: UYT-1');
});
