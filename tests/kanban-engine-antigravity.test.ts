import test from 'node:test';
import assert from 'node:assert/strict';
import { ADA, engineFixture, type Invocation } from './kanban-engine-fixture.js';

const hasArgs = (inv: Invocation, ...args: string[]) => args.every((a) => inv.args.includes(a));

test('antigravity: a plan run ends with PLAN READY and waits for its approval; the implement run resumes its conversation and runs without plan mode', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'Step one, step two.\n\nPLAN READY' },
    { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' },
  ]);
  const task = fx.newTask({ tool: 'antigravity', model: 'gemini-4-hydrogen', effort: 'max', planApproval: 'manual', useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan approval');
  assert.match(fx.repo.latestPlan(task.id)?.text ?? '', /Step one, step two\./);
  assert.equal(fx.repo.listRuns(task.id)[0].tool, 'antigravity');
  const plan = fx.invocations().find((i) => i.kind === 'agy' && !i.prompt)!;
  assert.ok(hasArgs(plan, '--dangerously-skip-permissions', '--mode', 'plan', '--model', 'gemini-4-hydrogen', '--effort', 'xhigh'));
  assert.ok(!plan.args.includes('--add-dir') && !plan.args.includes('--sandbox'));
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.deepEqual(fx.repo.listRuns(task.id).map((r) => `${r.phase}/${r.tool}/${r.status}`), ['plan/antigravity/succeeded', 'implement/antigravity/succeeded']);
  const implement = fx.invocations().filter((i) => i.kind === 'agy' && !i.prompt).at(-1)!;
  assert.ok(hasArgs(implement, '--dangerously-skip-permissions', '--resume', waiting.sessionId!));
  assert.ok(!implement.args.includes('--mode'));
  assert.ok(done.sessionId);
});
