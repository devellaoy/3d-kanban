import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_MODE_UNAVAILABLE, inAutoMode, observeLeadHook, planFromHook, planModeOf } from '../src/server/kanban/engine/automode.js';
import type { Live } from '../src/server/kanban/engine/live.js';
import type { WorkerObservation } from '../src/server/workers/types.js';

const live = (): Live => ({ taskId: 1, runId: 7, phase: 'implement', workerId: 'w', floorId: 'f', ended: false, tool: 'claude', role: 'implementer', exitPlan: false });
const hook = (permission_mode: unknown, extra: Record<string, unknown> = {}, hookEvent = 'PreToolUse', tool?: string) =>
  ({ workerId: 'w', info: {}, event: 'hook', hookEvent, tool, payload: { permission_mode, ...extra } }) as unknown as WorkerObservation;
const AUTO = ['--permission-mode', 'auto'];

test('inAutoMode reads the permission mode flag, and planModeOf says a plan is not in auto mode', () => {
  assert.equal(inAutoMode(AUTO), true);
  assert.equal(inAutoMode(['--permission-mode', 'bypassPermissions']), false);
  assert.equal(inAutoMode(['--permission-mode', 'plan']), false);
  assert.equal(inAutoMode(['--add-dir', 'auto']), false);
  assert.equal(inAutoMode(undefined), false);
  assert.deepEqual(planModeOf('plan', ['--permission-mode', 'plan']), { planMode: true });
  assert.deepEqual(planModeOf('plan', ['-s', 'read-only']), { planMode: true }, 'Codex has no auto mode');
  assert.deepEqual(planModeOf('plan', [...AUTO, '--disallowedTools', 'Edit']), {});
  assert.deepEqual(planModeOf('implement', ['--permission-mode', 'plan']), {});
});

test('auto mode asked for and not on: one note per run, from the lead only', () => {
  const l = live();
  const notes: string[] = [];
  const see = (o: WorkerObservation, args: string[] | null = AUTO) => observeLeadHook(l, o, () => args ?? undefined, (t) => void notes.push(t));
  see(hook('auto'));
  see(hook('default', { agent_id: 'helper@1' }));
  assert.deepEqual(notes, [], 'auto mode is on; a subagent has a mode of its own');
  see(hook('default'), ['--permission-mode', 'bypassPermissions']);
  see(hook('default'), null);
  assert.deepEqual(notes, [], 'auto mode was not asked for');
  see(hook(undefined));
  assert.deepEqual(notes, [], 'a payload without a mode says nothing');
  see(hook('default'));
  see(hook('default'));
  see(hook('default', {}, 'Stop'));
  assert.deepEqual(notes, [AUTO_MODE_UNAVAILABLE]);
  assert.match(notes[0], /auto mode isn't available here/);
  assert.match(notes[0], /Choose another mode in Settings/);
  // The next run has its own Live: it is told again.
  const next = live();
  observeLeadHook(next, hook('default'), () => AUTO, (t) => void notes.push(t));
  assert.equal(notes.length, 2);
});

test('the lead hook still tells ExitPlanMode from other tools', () => {
  const l = live();
  const none = () => undefined;
  observeLeadHook(l, hook('plan', {}, 'PreToolUse', 'ExitPlanMode'), none, () => {});
  assert.equal(l.exitPlan, true);
  observeLeadHook(l, hook('plan', {}, 'PostToolUse', 'Read'), none, () => {});
  assert.equal(l.exitPlan, true);
  observeLeadHook(l, hook('plan', {}, 'PreToolUse', 'Read'), none, () => {});
  assert.equal(l.exitPlan, false);
});

test("ExitPlanMode's hook carries the plan: it stands in when the session log does not have the call yet", () => {
  const l = live();
  const see = (o: WorkerObservation) => observeLeadHook(l, o, () => ['--permission-mode', 'plan'], () => {});
  see(hook('plan', { tool_input: { plan: 'The plan', planFilePath: '/p.md' } }, 'PreToolUse', 'ExitPlanMode'));
  assert.equal(l.exitPlan, true);
  assert.equal(l.hookPlan, 'The plan');
  // The log lags: no result at all, or one without the plan.
  assert.deepEqual(planFromHook(l, undefined, true), { text: '', complete: false, plan: 'The plan', exitPlan: true });
  assert.deepEqual(planFromHook(l, { text: 'Reading.', complete: false }, true), { text: 'Reading.', complete: false, plan: 'The plan', exitPlan: true });
  // The log has it: the log's plan is kept. And a turn that did not end in ExitPlanMode is left alone.
  const logged = { text: '', complete: false, plan: 'From the log', exitPlan: true };
  assert.equal(planFromHook(l, logged, true), logged);
  assert.equal(planFromHook(l, undefined, false), undefined);
  // Claude went on with another tool: the plan is no longer what the turn ended on.
  see(hook('plan', {}, 'PreToolUse', 'Read'));
  assert.equal(l.exitPlan, false);
  assert.equal(l.hookPlan, undefined);
  assert.equal(planFromHook(l, undefined, true), undefined);
});
