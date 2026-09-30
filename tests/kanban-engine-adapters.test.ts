import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateWorkerModel } from '../src/server/agents.js';
import { claudeAdapter, claudeAlias, readClaudeTurn } from '../src/server/kanban/engine/adapters/claude.js';
import { MODEL_RE } from '../src/shared/kanban/protocol.js';
import { codexAdapter, readCodexTurn } from '../src/server/kanban/engine/adapters/codex.js';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-adapters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name: string, lines: unknown[]) => {
    const file = path.join(dir, name);
    writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    return file;
  };
}

// Synthetic transcripts in the shapes docs/fork.md's M0 notes describe (no real session content).
const cUser = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const cAssistant = (content: unknown[], extra: object = {}, id?: string) => ({ type: 'assistant', message: { ...(id ? { id } : {}), role: 'assistant', content }, ...extra });
const text = (t: string) => ({ type: 'text', text: t });

test('claude launch flags per phase, with the review sandbox, extra dirs, models and plugin extras', () => {
  const base = { permission: 'bypass' as const, sandbox: false };
  assert.deepEqual(claudeAdapter.launchArgs('plan', { ...base, addDirs: ['/refs', '/refs'] }), ['--permission-mode', 'plan', '--add-dir', '/refs']);
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix', 'compact'] as const) assert.deepEqual(claudeAdapter.launchArgs(phase, base), ['--permission-mode', 'bypassPermissions'], phase);
  assert.deepEqual(claudeAdapter.launchArgs('review', base), ['--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(claudeAdapter.launchArgs('review', { ...base, sandbox: true }), ['--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  // A pull-request review has the review's flags (Bash keeps the network, for gh).
  assert.deepEqual(claudeAdapter.launchArgs('pr-review', { ...base, sandbox: true }), ['--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  // Upstream's spawn gets the alias; a full model id is a flag after it. Plugin extras come last.
  assert.equal(claudeAdapter.spawnModel('opus'), 'opus');
  assert.equal(claudeAdapter.spawnModel('claude-opus-4-5'), 'opus');
  assert.deepEqual(claudeAdapter.launchArgs('implement', { ...base, model: 'claude-opus-4-5', extra: ['--plugin-dir', '/skills'] }), ['--permission-mode', 'bypassPermissions', '--model', 'claude-opus-4-5', '--plugin-dir', '/skills']);
  assert.deepEqual(claudeAdapter.launchArgs('implement', { ...base, model: 'opus' }), ['--permission-mode', 'bypassPermissions']);
  assert.equal(claudeAdapter.spawnEffort('minimal'), 'low');
  assert.equal(claudeAdapter.spawnEffort('max'), 'max');
});

test('claude model ids: a full id passes upstream as its alias and runs as itself', () => {
  for (const [id, alias] of [
    ['claude-opus-5-5[1m]', 'opus'],
    ['claude-sonnet-5-5', 'sonnet'],
    ['claude-3-5-haiku-20241022', 'haiku'],
    ['fable', 'fable'],
  ] as const) {
    assert.equal(claudeAlias(id), alias, id);
    const spawned = claudeAdapter.spawnModel(id);
    assert.equal(validateWorkerModel('agent', 'claude', spawned), undefined, `${id} passes upstream's spawn`);
    assert.ok(MODEL_RE.test(id), `${id} passes the kanban's input check`);
  }
  assert.equal(claudeAdapter.spawnModel('gpt-5.5'), undefined, 'no family, no alias');
  // Upstream puts --model <alias> ahead of the phase flags; the full id after it is the one the CLI takes.
  const args = claudeAdapter.launchArgs('review', { permission: 'bypass', sandbox: false, model: 'claude-opus-5-5[1m]' });
  assert.deepEqual(args.slice(-2), ['--model', 'claude-opus-5-5[1m]']);
});

test('codex launch flags per phase, the workspace-write setting, models and efforts', () => {
  const base = { permission: 'bypass' as const, sandbox: true };
  assert.deepEqual(codexAdapter.launchArgs('plan', base), ['-s', 'read-only', '-a', 'never']);
  assert.deepEqual(codexAdapter.launchArgs('review', base), ['-s', 'read-only', '-a', 'never']);
  // Reading pull requests takes gh and so the network: the workspace sandbox with the network on.
  assert.deepEqual(codexAdapter.launchArgs('pr-review', base), ['-s', 'workspace-write', '-a', 'never', '-c', 'sandbox_workspace_write.network_access=true']);
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix'] as const) assert.deepEqual(codexAdapter.launchArgs(phase, base), ['--dangerously-bypass-approvals-and-sandbox'], phase);
  assert.deepEqual(codexAdapter.launchArgs('implement', { ...base, permission: 'workspace-write', addDirs: ['/uploads'] }), ['-s', 'workspace-write', '-a', 'never', '--add-dir', '/uploads']);
  // An investigation writes only its report folder.
  assert.deepEqual(codexAdapter.launchArgs('implement', { ...base, investigate: true, addDirs: ['/reports/task-3'] }), ['-s', 'workspace-write', '-a', 'never', '--add-dir', '/reports/task-3']);
  assert.deepEqual(codexAdapter.launchArgs('fix', { ...base, model: 'gpt-5.5', effort: 'max', extra: ['-c', 'x=1'] }), ['--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-c', 'x=1']);
  assert.equal(codexAdapter.spawnModel('gpt-5.5'), undefined);
  assert.equal(codexAdapter.spawnEffort('high'), undefined);
});

test('claude transcript: the text after the last real prompt, skipping tool results, meta lines and subagents', (t) => {
  const write = scratch(t);
  const file = write('claude.jsonl', [
    { type: 'permission-mode', permissionMode: 'default' },
    cUser('First task'),
    cAssistant([text('Old answer. REVIEW: APPROVED')]),
    cUser('Second task'),
    cUser('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    cAssistant([text('Let me look.'), { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }]),
    cUser([{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }]),
    cAssistant([text('Subagent noise')], { isSidechain: true }),
    'not json at all',
    cAssistant([text('All fixed.\n\nREVIEW: CHANGES_REQUESTED')]),
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  const r = readClaudeTurn(file);
  // The final answer only: what it said on the way ("Let me look.") isn't part of it.
  assert.deepEqual(r, { text: 'All fixed.\n\nREVIEW: CHANGES_REQUESTED', complete: true });
  // A prompt with only an image and text blocks counts as a prompt; one still being answered isn't complete.
  const open = write('open.jsonl', [cUser('x'), cAssistant([text('a')]), cUser([text('Look at this'), { type: 'image', source: {} }])]);
  assert.deepEqual(readClaudeTurn(open), { text: '', complete: false });
  assert.equal(readClaudeTurn(path.join(path.dirname(file), 'missing.jsonl')), undefined);
});

test('claude transcript: ExitPlanMode is the plan, until it is answered', (t) => {
  const write = scratch(t);
  const pending = write('plan.jsonl', [
    cUser('Plan task #4'),
    cAssistant([text('Reading the code first.'), { type: 'tool_use', id: 'g', name: 'Grep', input: {} }]),
    cUser([{ type: 'tool_result', tool_use_id: 'g', content: '' }]),
    // One message, logged as a line per block with the message's id.
    cAssistant([text('Here is the plan.\n\nPLAN READY')], {}, 'msg_2'),
    cAssistant([{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: '1. Change a\n2. Test b' } }], {}, 'msg_2'),
  ]);
  assert.deepEqual(readClaudeTurn(pending), { text: 'Here is the plan.\n\nPLAN READY', plan: '1. Change a\n2. Test b', exitPlan: true, complete: true });
  const answered = write('answered.jsonl', [
    cUser('Plan task #4'),
    cAssistant([{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: 'The plan' } }]),
    cUser([{ type: 'tool_result', tool_use_id: 'p1', content: 'User rejected' }]),
    cAssistant([text('Understood.')]),
  ]);
  const r = readClaudeTurn(answered);
  assert.equal(r?.exitPlan, undefined);
  assert.equal(r?.plan, 'The plan');
  // An API error line (a usage limit) is flagged.
  const limit = write('limit.jsonl', [cUser('Go'), cAssistant([text("You've hit your limit · resets 3pm")], { isApiErrorMessage: true })]);
  assert.equal(readClaudeTurn(limit)?.apiError, "You've hit your limit · resets 3pm");
});

test('codex rollout: the last task_complete of the last turn, else the last assistant message', (t) => {
  const write = scratch(t);
  const meta = { type: 'session_meta', payload: { id: 's1', cwd: '/w' } };
  const ctxMsg = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } };
  const user = (t: string) => [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } }, { type: 'event_msg', payload: { type: 'user_message', message: t } }];
  const say = (t: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] } });
  const done = (t: string | null) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'x', last_agent_message: t } });
  const file = write('rollout.jsonl', [meta, ctxMsg, ...user('Review round 1'), say('old'), done('Findings\nREVIEW: CHANGES_REQUESTED'), ...user('Review round 2'), { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, say('Looks fine now.\nREVIEW: APPROVED'), done('Looks fine now.\nREVIEW: APPROVED')]);
  assert.deepEqual(readCodexTurn(file), { text: 'Looks fine now.\nREVIEW: APPROVED', complete: true });
  // Not finished yet: the last assistant message, and not complete (the engine reads again).
  const running = write('running.jsonl', [meta, ...user('Task'), say('Working on it')]);
  assert.deepEqual(readCodexTurn(running), { text: 'Working on it', complete: false });
  // A stale task_complete from the turn before is not this turn's.
  const stale = write('stale.jsonl', [meta, ...user('One'), done('first'), ...user('Two')]);
  assert.deepEqual(readCodexTurn(stale), { text: '', complete: false });
  // task_complete without a message falls back to the assistant's last message; errors are flagged.
  const fallback = write('fallback.jsonl', [meta, ...user('Go'), say('The answer'), done(null)]);
  assert.deepEqual(readCodexTurn(fallback), { text: 'The answer', complete: true });
  const error = write('error.jsonl', [meta, ...user('Go'), { type: 'event_msg', payload: { type: 'error', message: 'stream disconnected before completion' } }, done(null)]);
  assert.deepEqual(readCodexTurn(error), { text: 'stream disconnected before completion', complete: true, apiError: 'stream disconnected before completion' });
});
