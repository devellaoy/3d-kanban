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
  // Claude went on with another tool: the turn no longer ends on the plan (the hook's copy stays for a sibling's sake: it is only read for a plan exit).
  see(hook('plan', {}, 'PreToolUse', 'Read'));
  assert.equal(l.exitPlan, false);
  assert.equal(l.hookPlan, 'The plan');
  // The next prompt drops it.
  see(hook('plan', {}, 'UserPromptSubmit'));
  assert.equal(l.hookPlan, undefined);
  assert.equal(planFromHook(l, undefined, true), undefined);
});

test("a sibling tool of ExitPlanMode (report_turn) is not Claude going on; the dialog's answer or the next prompt ends the plan", () => {
  const REPORT = 'mcp__agent-office__report_turn';
  const run = (events: [string, string, Record<string, unknown>?][]) => {
    const l = live();
    for (const [event, tool, input] of events) observeLeadHook(l, hook('plan', input ? { tool_input: input } : {}, event, tool), () => undefined, () => {});
    return l;
  };
  const plan = { plan: 'The plan' };
  // The order Claude Code hooks a message in: ExitPlanMode, its sibling, then the approval dialog.
  for (const events of [
    [['PreToolUse', 'ExitPlanMode', plan], ['PermissionRequest', 'ExitPlanMode', plan], ['PreToolUse', REPORT]],
    [['PreToolUse', 'ExitPlanMode', plan], ['PreToolUse', REPORT]],
    [['PreToolUse', 'ExitPlanMode', plan], ['PreToolUse', REPORT], ['PermissionRequest', 'ExitPlanMode', plan]],
  ] as [string, string, Record<string, unknown>?][][]) {
    const l = run(events);
    assert.equal(l.exitPlan, true, JSON.stringify(events));
    assert.equal(l.hookPlan, 'The plan');
  }
  // Another tool before the dialog is up is Claude going on, but the hook's plan is kept: the dialog's own PermissionRequest (which may carry
  // no plan) makes it the turn's end again, whatever the sibling was (a todo update, a shell command).
  const went = run([['PreToolUse', 'ExitPlanMode', plan], ['PreToolUse', 'Read']]);
  assert.deepEqual([went.exitPlan, went.hookPlan], [false, 'The plan']);
  for (const sibling of ['Read', 'TodoWrite', 'Bash', 'mcp__agent-office__get_task']) {
    const back = run([['PreToolUse', 'ExitPlanMode', plan], ['PreToolUse', sibling], ['PermissionRequest', 'ExitPlanMode']]);
    assert.deepEqual([back.exitPlan, back.hookPlan, back.planAsked], [true, 'The plan', true], sibling);
  }
  // Another tool's own permission dialog is not the plan's: a needs_input after it is no plan exit.
  const other = run([['PreToolUse', 'ExitPlanMode', plan], ['PermissionRequest', 'ExitPlanMode'], ['PreToolUse', 'Bash'], ['PermissionRequest', 'Bash']]);
  assert.deepEqual([other.exitPlan, other.planAsked], [false, false]);
  // With the dialog up, even another tool is no going on; a payload without a plan keeps an earlier one.
  const asked = run([['PreToolUse', 'ExitPlanMode', plan], ['PermissionRequest', 'ExitPlanMode'], ['PreToolUse', 'Read']]);
  assert.deepEqual([asked.exitPlan, asked.hookPlan], [true, 'The plan']);
  // The dialog answered, or the next prompt: all of it is cleared, and a tool is what it was before.
  for (const end of [['PostToolUse', 'ExitPlanMode'], ['PostToolUseFailure', 'ExitPlanMode'], ['UserPromptSubmit', '']] as [string, string][]) {
    const l = run([['PreToolUse', 'ExitPlanMode', plan], ['PermissionRequest', 'ExitPlanMode', plan], end]);
    assert.deepEqual([l.exitPlan, l.hookPlan, l.planAsked], [false, undefined, false], end[0]);
    observeLeadHook(l, hook('plan', {}, 'PreToolUse', REPORT), () => undefined, () => {});
    assert.equal(l.exitPlan, false);
  }
  // A Stop alone changes nothing (a needs_input queued behind it still needs the plan).
  assert.equal(run([['PreToolUse', 'ExitPlanMode', plan], ['PermissionRequest', 'ExitPlanMode', plan], ['Stop', '']]).hookPlan, 'The plan');
});
