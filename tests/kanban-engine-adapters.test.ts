import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateWorkerModel } from '../src/server/agents.js';
import { backgroundLeft, claudeAdapter, claudeAlias, claudeInterruptedSince, readClaudeTurn, teammateTags } from '../src/server/kanban/engine/adapters/claude.js';
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

// Synthetic transcripts in the shapes docs/fork.md's M0 spike results describe (no real session content).
const cUser = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const cAssistant = (content: unknown[], extra: object = {}, id?: string) => ({ type: 'assistant', message: { ...(id ? { id } : {}), role: 'assistant', content }, ...extra });
const text = (t: string) => ({ type: 'text', text: t });
const messageTextOf = (l: { message: { content: unknown } }) => String(l.message.content);

test('claude launch flags per phase, with the review sandbox, extra dirs, models and plugin extras', () => {
  const base = { permission: 'bypass' as const, sandbox: false };
  assert.deepEqual(claudeAdapter.launchArgs('plan', { ...base, addDirs: ['/refs', '/refs'] }), ['--permission-mode', 'plan', '--add-dir', '/refs']);
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix', 'pr-conflicts'] as const) assert.deepEqual(claudeAdapter.launchArgs(phase, base), ['--permission-mode', 'bypassPermissions'], phase);
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
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix', 'pr-conflicts'] as const) assert.deepEqual(codexAdapter.launchArgs(phase, base), ['--dangerously-bypass-approvals-and-sandbox'], phase);
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

test('claude transcript: a last message that calls a tool is not the final answer yet (the Stop hook can beat the log)', (t) => {
  const write = scratch(t);
  // #306: the Stop hook came while the log still ended at a tool's result, before the final answer.
  const early = [
    cUser('Implement task #306'),
    cAssistant([text('The after shots look sharp. Cleaning up last.')], {}, 'msg_a'),
    cAssistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log' } }], {}, 'msg_a'),
    cUser([{ type: 'tool_result', tool_use_id: 't1', content: 'abc123 Fix' }]),
  ];
  assert.deepEqual(readClaudeTurn(write('early.jsonl', early)), { text: 'The after shots look sharp. Cleaning up last.', complete: false });
  // Not even the tool's result logged yet.
  assert.deepEqual(readClaudeTurn(write('no-result.jsonl', early.slice(0, 3))), { text: 'The after shots look sharp. Cleaning up last.', complete: false, toolRunning: true });
  // A subagent's tool result doesn't make the main turn's final answer unfinished, nor its tool calls.
  const done = write('done.jsonl', [
    ...early,
    cAssistant([text('The fog stays outside now.')], {}, 'msg_b'),
    cAssistant([{ type: 'tool_use', id: 's1', name: 'Read', input: {} }], { isSidechain: true }),
    cUser([{ type: 'tool_result', tool_use_id: 's1', content: 'x' }], { isSidechain: true }),
    { type: 'system', subtype: 'stop_hook_summary' },
  ]);
  assert.deepEqual(readClaudeTurn(done), { text: 'The fog stays outside now.', complete: true });
});

test('claude transcript: background agents the run set off and that still work', (t) => {
  const write = scratch(t);
  const launch = (id: string) => cUser([{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${id} (internal ID)` }] }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } });
  const note = (id: string) => cUser(`<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`, { origin: { kind: 'task-notification', producer: 'session-task' } });
  const head = [cUser('Implement task #7'), cAssistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }], {}, 'm1'), launch('ag1'), cAssistant([text('Waiting for it.')], {}, 'm2')];
  // The turn ended on the launch: the interim text, and one agent still working.
  assert.deepEqual(readClaudeTurn(write('bg.jsonl', head)), { text: 'Waiting for it.', complete: true, background: 1 });
  // Its notification starts a new turn; the answer is read from there and nothing is left.
  assert.deepEqual(readClaudeTurn(write('bg-done.jsonl', [...head, note('ag1'), cAssistant([text('All done.')], {}, 'm3')])), { text: 'All done.', complete: true });
  // The notification as an attachment inside another turn counts too, whatever its status.
  const queued = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>ag1</task-id>\n<status>stopped</status>\n</task-notification>' } };
  assert.equal(readClaudeTurn(write('bg-queued.jsonl', [...head, queued, cAssistant([text('Carried on.')], {}, 'm3')]))?.background, undefined);
  // An older CLI sets no origin: the tag alone marks the notification, and it isn't the office's prompt.
  assert.equal(readClaudeTurn(write('bg-old.jsonl', [...head, cUser('<task-notification>\n<task-id>ag1</task-id>\n</task-notification>'), cAssistant([text('Ok.')], {}, 'm3')]))?.background, undefined);
  // A SendMessage resume sets an agent that already reported at work again, until its next notification.
  const resume = cUser([{ type: 'tool_result', tool_use_id: 's1', content: 'Resuming agent ag1' }], { toolUseResult: { success: true, message: 'Resuming agent ag1', resumedAgentId: 'ag1' } });
  const again = [...head, note('ag1'), cAssistant([text('Sending it back.')], {}, 'm3'), resume, cAssistant([text('Waiting again.')], {}, 'm4')];
  assert.equal(readClaudeTurn(write('bg-resume.jsonl', again))?.background, 1);
  assert.equal(readClaudeTurn(write('bg-resume-done.jsonl', [...again, note('ag1'), cAssistant([text('Finished.')], {}, 'm5')]))?.background, undefined);
  // A notification its turn hasn't answered yet: Claude is about to work, so the run isn't over.
  assert.deepEqual(readClaudeTurn(write('bg-unanswered.jsonl', [...head, note('ag1')])), { text: '', complete: false, resuming: true });
  // A typed prompt quoting the tag (origin human) isn't a notification: it is the window's prompt.
  const typed = cUser('<task-notification>\n<task-id>ag1</task-id>\n</task-notification>', { origin: { kind: 'human' } });
  assert.deepEqual(readClaudeTurn(write('bg-human.jsonl', [...head, typed])), { text: '', complete: false });
  // An agent from an earlier prompt's turn isn't this run's.
  assert.equal(readClaudeTurn(write('bg-earlier.jsonl', [...head, cUser('Review task #7'), cAssistant([text('Fine.')], {}, 'm9')]))?.background, undefined);
  // A launch logged as text only (no toolUseResult) counts.
  const textOnly = cUser([{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched successfully.\nagentId: ag2 (internal ID)' }]);
  const agentCall = cAssistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }], {}, 'm1');
  assert.equal(readClaudeTurn(write('bg-text.jsonl', [cUser('Go'), agentCall, textOnly, cAssistant([text('Waiting.')])]))?.background, 1);
  // The same words in another tool's result (a file it read) are no launch.
  const readCall = cAssistant([{ type: 'tool_use', id: 'a1', name: 'Read', input: {} }], {}, 'm1');
  assert.equal(readClaudeTurn(write('bg-forged.jsonl', [cUser('Go'), readCall, textOnly, cAssistant([text('Read it.')])]))?.background, undefined);
  // A Bash run_in_background command is counted too (see the next test).
  // Its prompt cut off by the log's tail: nothing to count.
  assert.equal(readClaudeTurn(write('bg-cut.jsonl', [launch('ag3'), cAssistant([text('Waiting.')])]))?.background, undefined);
});

test('claude transcript: background commands (Bash run_in_background, Monitor) the run set off and that still work', (t) => {
  const write = scratch(t);
  const call = (id: string, name: string, input: object = {}, mid = 'm-' + id) => cAssistant([{ type: 'tool_use', id, name, input }], {}, mid);
  const result = (id: string, content: string, toolUseResult?: object) => cUser([{ type: 'tool_result', tool_use_id: id, content }], toolUseResult ? { toolUseResult } : {});
  const bashRes = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  const launch = (id: string) => [call('b1', 'Bash', { command: 'npm test', run_in_background: true }), result('b1', `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output`, { ...bashRes, backgroundTaskId: id })];
  const wait = cAssistant([text('Waiting for the full suite.')], {}, 'mw');
  const noteBody = (id: string, inner: string) => `<task-notification>\n<task-id>${id}</task-id>\n${inner}\n</task-notification>`;
  const done = (id: string) => noteBody(id, `<status>completed</status>\n<summary>Background command "suite" completed (exit code 0)</summary>`);
  const asUser = (body: string) => cUser(body, { origin: { kind: 'task-notification' } });
  const asQueued = (body: string) => ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: body } });
  const bg = (...lines: object[]) => readClaudeTurn(write('c.jsonl', [cUser('Implement task #7'), ...lines]))?.background;

  assert.equal(bg(...launch('bash1'), wait), 1);
  // Its completion, as a user line (its own turn) or an attachment inside another turn.
  assert.equal(bg(...launch('bash1'), wait, asUser(done('bash1')), cAssistant([text('It passed.')], {}, 'm2')), undefined);
  assert.equal(bg(...launch('bash1'), wait, asQueued(done('bash1')), cAssistant([text('It passed.')], {}, 'm2')), undefined);
  // A failed or killed one is over too; one that reports a status of another kind is not.
  assert.equal(bg(...launch('bash1'), wait, asUser(noteBody('bash1', '<status>failed</status>')), cAssistant([text('x')], {}, 'm2')), undefined);
  assert.equal(bg(...launch('bash1'), wait, asUser(noteBody('bash1', '<status>killed</status>')), cAssistant([text('x')], {}, 'm2')), undefined);
  assert.equal(bg(...launch('bash1'), wait, asUser(noteBody('bash1', '<status>running</status>')), cAssistant([text('x')], {}, 'm2')), 1);
  // Two commands, one done.
  assert.equal(bg(...launch('bash1'), call('b2', 'Bash', {}), result('b2', 'x', { ...bashRes, backgroundTaskId: 'bash2' }), wait, asUser(done('bash1')), cAssistant([text('One left.')], {}, 'm2')), 1);
  // A command the timeout moved to the background.
  const moved = [call('b1', 'Bash', { command: 'npm test' }), result('b1', 'Command did not complete within its 120s timeout and was moved to the background (ID: bash3). Output is being written to: /tmp/bash3.output', { ...bashRes, backgroundTaskId: 'bash3', timedOutAfterMs: 120000 })];
  assert.equal(bg(...moved, wait), 1);
  // Known by its text only (no toolUseResult): a Bash result counts, a file read quoting the words doesn't.
  assert.equal(bg(call('b1', 'Bash', { run_in_background: true }), result('b1', 'Command running in background with ID: bash4. Output is being written to: /tmp/bash4.output'), wait), 1);
  // Without run_in_background on the call, only the timeout's own words at the start of the text count.
  assert.equal(bg(call('b1', 'Bash'), result('b1', 'Command running in background with ID: bash4.'), wait), undefined);
  assert.equal(bg(call('b1', 'Bash'), result('b1', 'Command did not complete within its 120s timeout and was moved to the background (ID: bash5).'), wait), 1);
  // A command's stdout quoting the words mid-text is no launch, with or without the flag.
  assert.equal(bg(call('b1', 'Bash', { run_in_background: true }), result('b1', 'ok\nCommand running in background with ID: x\nit was moved to the background (ID: y)'), wait), undefined);
  assert.equal(bg(call('b1', 'Bash'), result('b1', 'echo: Command did not complete within its 120s timeout and was moved to the background (ID: x)'), wait), undefined);
  // A launch logged before the process started (`since`) died with it, whichever tool made it.
  const early = new Date(Date.UTC(2026, 9, 1, 6, 0, 0)).toISOString();
  const since = Date.UTC(2026, 9, 1, 7, 0, 0);
  const stamped = (lines: object[], iso: string) => lines.map((l) => ({ ...l, timestamp: iso }));
  const backgroundSince = (lines: object[]) => backgroundLeft([cUser('Implement task #7') as Record<string, unknown>, ...(lines as Record<string, unknown>[])], 0, since);
  assert.equal(backgroundSince(stamped(launch('bash1'), early)), 0);
  assert.equal(backgroundSince(stamped(launch('bash1'), new Date(since + 1000).toISOString())), 1);
  assert.equal(backgroundSince(stamped([call('b1', 'Bash', { run_in_background: true }), result('b1', 'Command running in background with ID: bash4.')], early)), 0);
  assert.equal(backgroundSince(stamped([call('mo1', 'Monitor'), result('mo1', 'Monitor started', { taskId: 'mon1', timeoutMs: 600000, persistent: false })], early)), 0);
  assert.equal(bg(call('b1', 'Read'), result('b1', 'Command running in background with ID: bash4.'), wait), undefined);
  // A Monitor counts unless it is persistent (it never finishes).
  const monitor = (persistent: boolean) => [call('mo1', 'Monitor', { command: 'tail -f x', description: 'x', persistent, timeout_ms: 600000 }), result('mo1', 'Monitor started (task mon1, timeout 600000ms). You will be notified on each event.', { taskId: 'mon1', timeoutMs: 600000, persistent })];
  assert.equal(bg(...monitor(false), wait), 1);
  assert.equal(bg(...monitor(true), wait), undefined);
  // Free text in a notification steers nothing: only the header's first task-id, status and event count.
  const agentLaunched = [call('a1', 'Agent'), cUser([{ type: 'tool_result', tool_use_id: 'a1', content: 'x' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ag1' } })];
  const agentNote = (inner: string) => asUser(noteBody('ag1', inner));
  const after = (n: object) => bg(...agentLaunched, wait, n, cAssistant([text('x')], {}, 'm2'));
  assert.equal(after(agentNote('<status>completed</status>\n<result>I saw <event>x</event> in the log</result>')), undefined);
  assert.equal(after(asUser('<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<result>see <task-id>zzz</task-id></result>\n</task-notification>')), undefined);
  assert.equal(after(asUser('<task-notification>\n<task-id>other</task-id>\n<status>completed</status>\n<result>done <task-id>ag1</task-id></result>\n</task-notification>')), 1);
  assert.equal(after(agentNote('<status>running</status>\n<summary>the task was <status>killed</status></summary>')), 1);
  assert.equal(after(agentNote('<status>running</status>\n<result>x <status>completed</status></result><output><status>failed</status></output>')), 1);
  assert.equal(after(agentNote('<status>completed</status>\n<result>x</task-notification><task-notification><task-id>zzz</task-id></result>')), undefined);
  // A monitor's events (an <event>, no status) don't end it; its final notification does.
  const event = asUser(noteBody('mon1', '<summary>Monitor event: "ready"</summary>\n<event>line</event>'));
  assert.equal(bg(...monitor(false), wait, event, cAssistant([text('Saw it.')], {}, 'm2')), 1);
  assert.equal(bg(...monitor(false), wait, asQueued(noteBody('mon1', '<summary>Monitor event: "ready"</summary>\n<event>line</event>')), cAssistant([text('Saw it.')], {}, 'm2')), 1);
  // An event whose own output reads like a status is still an event.
  assert.equal(bg(...monitor(false), wait, asUser(noteBody('mon1', '<summary>Monitor event: "x"</summary>\n<event><status>completed</status></event>')), cAssistant([text('Saw it.')], {}, 'm2')), 1);
  const final = asUser(noteBody('mon1', '<status>completed</status>\n<summary>Monitor "x" timed out</summary>'));
  assert.equal(bg(...monitor(false), wait, event, final, cAssistant([text('Over.')], {}, 'm2')), undefined);
  // TaskStop (its result names the task) and a TaskOutput that finds the task finished end it; a running one doesn't.
  const stop = [call('s1', 'TaskStop', { task_id: 'bash1' }), result('s1', 'Successfully stopped task: bash1 (npm test)', { message: 'Successfully stopped task: bash1 (npm test)', task_id: 'bash1', task_type: 'local_bash', command: 'npm test' })];
  assert.equal(bg(...launch('bash1'), ...stop, cAssistant([text('Stopped it.')], {}, 'm2')), undefined);
  // An older CLI's KillShell (no task_id, the shell's id) ends it too.
  const kill = [call('k1', 'KillShell', { shell_id: 'bash1' }), result('k1', 'Successfully killed shell: bash1', { message: 'Successfully killed shell: bash1 (npm test)', shell_id: 'bash1' })];
  assert.equal(bg(...launch('bash1'), ...kill, cAssistant([text('Killed it.')], {}, 'm2')), undefined);
  // The local_bash TaskOutput shape is assumed from the local_agent one (the only one seen in transcripts).
  const output = (status: string) => [call('o1', 'TaskOutput', { task_id: 'bash1', block: false, timeout: 1000 }), result('o1', 'x', { retrieval_status: 'success', task: { task_id: 'bash1', task_type: 'local_bash', status, description: 'npm test', output: '' } })];
  assert.equal(bg(...launch('bash1'), ...output('completed'), cAssistant([text('Read it.')], {}, 'm2')), undefined);
  assert.equal(bg(...launch('bash1'), ...output('running'), cAssistant([text('Still going.')], {}, 'm2')), 1);
  // An agent's notification without a <status> (the older shape) still ends it.
  const agent = [call('a1', 'Agent'), cUser([{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched successfully.' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ag1' } })];
  assert.equal(bg(...agent, wait), 1);
  assert.equal(bg(...agent, wait, asUser('<task-notification>\n<task-id>ag1</task-id>\n</task-notification>'), cAssistant([text('ok')], {}, 'm2')), undefined);
  // A command's notification is no prompt of the office's: the turn is read from its own prompt, and unanswered it is "resuming".
  assert.deepEqual(readClaudeTurn(write('n.jsonl', [cUser('Implement task #7'), ...launch('bash1'), wait, asUser(done('bash1'))])), { text: '', complete: false, resuming: true });
  assert.deepEqual(readClaudeTurn(write('n2.jsonl', [cUser('Implement task #7'), ...launch('bash1'), wait, asUser(done('bash1')), cAssistant([text('It passed.')], {}, 'm2')])), { text: 'It passed.', complete: true });
  // A command from an earlier prompt's turn isn't this run's.
  assert.equal(bg(...launch('bash1'), wait, cUser('Review task #7'), cAssistant([text('Fine.')], {}, 'm9')), undefined);

  // A prompt a human types into the worker's terminal looks like the office's: with `runStart` the window stays at the run's own prompt.
  const ts = (s: number) => new Date(Date.UTC(2026, 9, 1, 8, 0, s)).toISOString();
  const runStart = Date.UTC(2026, 9, 1, 8, 0, 0) - 1000;
  const timed = (lines: object[], from = 0) => lines.map((l, i) => ({ ...l, timestamp: ts(from + i) }));
  const human = [cUser('Also check the docs'), cAssistant([text('Checked.')], {}, 'mh')];
  const typedMidRun = [cUser('Implement task #7'), ...launch('bash1'), wait, ...human];
  // Without runStart the typed prompt is the window's start: the launch vanishes (the old behaviour).
  assert.equal(readClaudeTurn(write('h1.jsonl', timed(typedMidRun)))?.background, undefined);
  assert.equal(readClaudeTurn(write('h2.jsonl', timed(typedMidRun)), { runStart })?.background, 1);
  // Its end logged after the typed prompt ends it.
  assert.equal(readClaudeTurn(write('h3.jsonl', timed([...typedMidRun, asUser(done('bash1')), cAssistant([text('It passed.')], {}, 'mp')])), { runStart })?.background, undefined);
  // A previous run's prompt and launch before runStart aren't counted.
  const previous = timed([cUser('Implement task #6'), ...launch('old1'), wait, cUser('Fix task #6')], -60);
  const own = timed([cUser('Implement task #7'), cAssistant([text('Done.')], {}, 'mo')]);
  assert.equal(readClaudeTurn(write('h4.jsonl', [...previous, ...own]), { runStart })?.background, undefined);
  // ... and a typed prompt later doesn't bring it back, nor hide the run's own launch.
  assert.equal(readClaudeTurn(write('h5.jsonl', [...previous, ...timed(typedMidRun)]), { runStart })?.background, 1);
  // No timestamps: no prompt matches runStart, so the last office prompt is the start as before.
  assert.equal(readClaudeTurn(write('h6.jsonl', typedMidRun), { runStart })?.background, undefined);
  assert.equal(readClaudeTurn(write('h7.jsonl', [cUser('Implement task #7'), ...launch('bash1'), wait]), { runStart })?.background, 1);
  // Only a logged end ends a task: one never reported still counts after the typed prompt.
  assert.equal(readClaudeTurn(write('h8.jsonl', timed([...typedMidRun, cUser('Anything else?'), cAssistant([text('No.')], {}, 'mn')])), { runStart })?.background, 1);
});

test('claude transcript: a prompt typed into the terminal after the office\'s is not the run\'s answer', (t) => {
  const write = scratch(t);
  const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
  const at = (n: number) => new Date(T0 + n * 1000).toISOString();
  const timed = (lines: object[], from = 1) => lines.map((l, i) => ({ ...l, timestamp: at(from + i) }));
  const read = (lines: object[], opts: { runStart?: number; promptAt?: number } = { runStart: T0, promptAt: T0 }) => readClaudeTurn(write('t.jsonl', lines), opts);
  const launch = [cAssistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }], {}, 'ml'), cUser([{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ag1 (internal ID)' }] }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ag1' } })];
  const interimText = cAssistant([text('Waiting for the helper.')], {}, 'mi');
  const note = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<summary>Agent "helper" completed</summary>\n</task-notification>' } };
  const notice = cUser('<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' } });

  // The helper ends inside the typed turn (its notification is an attachment there): the office's last text is the interim one.
  const a = read(timed([cUser('Implement task #7'), ...launch, interimText, cUser('How is it going?'), note, cAssistant([text('Fine, all done.')], {}, 'mt')]));
  assert.deepEqual(a, { text: 'Waiting for the helper.', complete: true, typed: true, interim: true });
  // Typed while the agent wrote its final message: the office's segment has the answer (answered or not, the typed turn doesn't count).
  const final = [cUser('Implement task #7'), cAssistant([text('All done.')], {}, 'mf')];
  assert.deepEqual(read(timed([...final, cUser('And the docs?')])), { text: 'All done.', complete: true, typed: true, typedOpen: true });
  assert.deepEqual(read(timed([...final, cUser('And the docs?'), cAssistant([text('Fine.')], {}, 'mc')])), { text: 'All done.', complete: true, typed: true });
  // Without runStart or promptAt the last prompt is the turn, as before.
  assert.deepEqual(readClaudeTurn(write('b.jsonl', timed([...final, cUser('And the docs?'), cAssistant([text('Fine.')], {}, 'mc')]))), { text: 'Fine.', complete: true });
  assert.deepEqual(readClaudeTurn(write('c.jsonl', [...final, cUser('And the docs?'), cAssistant([text('Fine.')], {}, 'mc')]), { runStart: T0 }), { text: 'Fine.', complete: true });

  // A person's prompt before the office's: promptAt finds the office's.
  const before = timed([cUser('Chat with me'), cAssistant([text('chat')], {}, 'mc'), cUser('Review task #7'), cAssistant([text('REVIEW: APPROVED')], {}, 'mr')]);
  assert.deepEqual(read(before, { runStart: T0, promptAt: T0 + 3000 }), { text: 'REVIEW: APPROVED', complete: true });
  // A typed prompt before a notification turn: the answer is the notification turn's.
  assert.deepEqual(read(timed([cUser('Implement task #7'), ...launch, interimText, cUser('How is it going?'), cAssistant([text('Fine.')], {}, 'mc'), notice, cAssistant([text('The helper agreed.')], {}, 'mn')])), { text: 'The helper agreed.', complete: true });

  // The office's restate prompt (promptAt): its turn is the answer, a typed prompt after that is skipped again, with no interim (nothing is out).
  const restated = [cUser('Implement task #7'), ...launch, interimText, cUser('How is it going?'), note, cAssistant([text('Fine.')], {}, 'mt'), cUser('Someone typed into your terminal'), cAssistant([text('Changed the redirect.')], {}, 'mx')];
  const restateAt = T0 + (restated.length - 1) * 1000;
  assert.deepEqual(read(timed(restated), { runStart: T0, promptAt: restateAt }), { text: 'Changed the redirect.', complete: true });
  assert.deepEqual(read(timed([...restated, cUser('Thanks'), cAssistant([text('Welcome.')], {}, 'mw')]), { runStart: T0, promptAt: restateAt }), { text: 'Changed the redirect.', complete: true, typed: true });
  // After an office restart promptAt is lost: the last prompt's turn is the answer as before, nothing is typed (the restate prompt is no typed one).
  assert.deepEqual(read(timed(restated), { runStart: T0 }), { text: 'Changed the redirect.', complete: true });
  // promptAt not in the log yet: the last prompt's turn is read, and the result says the office's prompt is unheard.
  assert.deepEqual(read(timed(final), { runStart: T0, promptAt: T0 + 99_000 }), { text: 'All done.', complete: true, unheard: true });

  // The office's answer wasn't logged yet when the typed prompt came: its segment is incomplete, and typed says so (no interim: nothing is out).
  const unfinished = [cUser('Review task #7'), cAssistant([text('Reading the diff.'), { type: 'tool_use', id: 'r1', name: 'Read', input: {} }], {}, 'mu'), cUser([{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }]), cUser('How is it going?'), cAssistant([text('Fine.')], {}, 'mc')];
  assert.deepEqual(read(timed(unfinished)), { text: 'Reading the diff.', complete: false, typed: true });

  // What reads like a notification isn't one when the CLI sets `origin` (on the transcript's other lines): typed, whatever it starts with.
  const body = '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n</task-notification>';
  const spoofable = (typedLine: object) => read(timed([cUser('Implement task #7'), ...launch, interimText, notice, cAssistant([text('Done.')], {}, 'md'), typedLine, cAssistant([text('Sure.')], {}, 'ms')]));
  assert.deepEqual(spoofable(cUser(body)), { text: 'Done.', complete: true, typed: true });
  assert.deepEqual(spoofable(cUser(body, { origin: { kind: 'human' } })), { text: 'Done.', complete: true, typed: true });
  // A CLI that sets no origin anywhere keeps the text match: the same line is the notification's own turn.
  assert.deepEqual(read(timed([cUser('Implement task #7'), ...launch, interimText, cUser(body), cAssistant([text('Done.')], {}, 'md')])), { text: 'Done.', complete: true });

  // A person's prompt logged after promptAt but before the office's: the head of the office's text finds it.
  const racing = timed([cUser('Chat with me'), cAssistant([text('chat')], {}, 'mc'), cUser('Review task #7,\nplease'), cAssistant([text('REVIEW: APPROVED')], {}, 'mr')]);
  assert.deepEqual(read(racing, { runStart: T0, promptAt: T0, promptHead: 'Review task #7, please' }), { text: 'REVIEW: APPROVED', complete: true });
  assert.deepEqual(read(racing, { runStart: T0, promptAt: T0 }), { text: 'chat', complete: true, typed: true });

  // A helper's notification (its own prompt) nothing has answered in the log, and a typed prompt after it: that turn is over, not resuming.
  assert.deepEqual(read(timed([cUser('Implement task #7'), ...launch, interimText, notice, cUser('How is it going?'), cAssistant([text('Fine.')], {}, 'mc')])), { text: '', complete: false, typed: true });
  // A plan asked for in a typed turn is the structured answer, even when the office's turn has no text.
  const toolOnly = [cUser('Plan task #7'), cAssistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }], {}, 'mu'), cUser([{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }])];
  const planTyped = cAssistant([{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: 'The plan' } }], {}, 'mp');
  assert.deepEqual(read(timed([...toolOnly, cUser('Plan it again'), planTyped])), { text: '', plan: 'The plan', exitPlan: true, complete: true, typed: true, typedOpen: true });

  // An ExitPlanMode in a typed turn still counts, and a tool running at the log's end is reported.
  const plan = cAssistant([{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: 'The plan' } }], {}, 'mp');
  assert.deepEqual(read(timed([...final, cUser('Plan it again'), plan])), { text: 'All done.', plan: 'The plan', exitPlan: true, complete: true, typed: true, typedOpen: true });
  const tool = cAssistant([{ type: 'tool_use', id: 'x1', name: 'Bash', input: {} }], {}, 'mx');
  assert.deepEqual(read(timed([...final, cUser('Run it'), cAssistant([text('Running.')], {}, 'my'), tool])), { text: 'All done.', complete: true, toolRunning: true, typed: true, typedOpen: true });
});

test('claude transcript: teammates (agent teams) still working, from their own transcripts and the lead\'s log', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 6, 0, s)).toISOString();
  // An idle body's own time defaults to its line's (`idle()`'s placeholder), as a notification logged on time has it.
  const withTs = (lines: object[], s: number) => lines.map((l, i) => JSON.parse(JSON.stringify({ timestamp: at(s + i), ...l }).replace(/__LINE__/g, at(s + i))) as object);
  /** A lead log (with its teammates' transcripts beside it, as Claude Code keeps them), as the lead's file. */
  const lead = (lines: object[], team: Record<string, object[]> = {}) => {
    const file = path.join(dir, `lead${++n}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    mkdirSync(path.join(dir, `lead${n}`, 'subagents'), { recursive: true });
    for (const [name, own] of Object.entries(team)) {
      const base = path.join(dir, `lead${n}`, 'subagents', `agent-a${name}-abc`);
      writeFileSync(`${base}.jsonl`, own.map((l) => JSON.stringify(l)).join('\n') + '\n');
      // The file's mtime is when it was last written, as the log's last timestamp says.
      const stamped = own.map((l) => Date.parse((l as { timestamp?: string }).timestamp ?? '')).filter(Boolean);
      if (stamped.length) utimesSync(`${base}.jsonl`, Math.max(...stamped) / 1000, Math.max(...stamped) / 1000);
      writeFileSync(`${base}.meta.json`, JSON.stringify({ agentType: name, name, taskKind: 'in_process_teammate', teamName: 'session-1' }));
    }
    // A background agent lives there too, and isn't a teammate.
    writeFileSync(path.join(dir, `lead${n}`, 'subagents', 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'general-purpose', taskKind: 'local_agent' }));
    writeFileSync(path.join(dir, `lead${n}`, 'subagents', 'agent-bg1.jsonl'), JSON.stringify({ type: 'user', timestamp: at(50), message: { role: 'user', content: 'x' } }) + '\n');
    return file;
  };
  const spawn = (name: string, id: string) => [
    cAssistant([{ type: 'tool_use', id, name: 'Agent', input: { name } }], {}, `m-${id}`),
    cUser([{ type: 'tool_result', tool_use_id: id, content: [text(`Spawned successfully.\nagent_id: ${name}@session-1\nname: ${name}`)] }], { toolUseResult: { status: 'teammate_spawned', name, teammate_id: `${name}@session-1`, team_name: 'session-1' } }),
  ];
  const send = (to: string, id: string) => [
    cAssistant([{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'again' } }], {}, `m-${id}`),
    cUser([{ type: 'tool_result', tool_use_id: id, content: [text('{"success":true}')] }], { toolUseResult: { success: true, message: `Message sent to ${to}'s inbox`, routing: { sender: 'team-lead', target: `@${to}` } } }),
  ];
  const tag = (id: string, body: string, attrs = '') => `<teammate-message teammate_id="${id}" color="blue"${attrs}>\n${body}\n</teammate-message>`;
  const idle = (from: string, extra: object = {}) => JSON.stringify({ type: 'idle_notification', from, timestamp: '__LINE__', idleReason: 'available', ...extra });
  const mail = (...tags: string[]) => cUser(`Another Claude session sent a message:\n${tags.join('\n')}`);
  const msgFrom = (id: string, ...blocks: object[]) => ({ type: 'assistant', message: { id: `t-${id}`, role: 'assistant', content: blocks } });
  const wait = cAssistant([text('Waiting for the teammates.')], {}, 'mw');

  // Two teammates just spawned, their transcripts not written yet (the log lags): both are at work.
  const spawned = lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), wait], 1));
  assert.deepEqual(readClaudeTurn(spawned), { text: 'Waiting for the teammates.', complete: true, background: 2 });

  // Their own transcripts: one ends in text (at rest), one in a tool call. A message queued for a resting one wakes it.
  const head = withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), wait], 1);
  const own = (last: object[], s = 10) => withTs([cUser(tag('team-lead', 'Do it.')), msgFrom('1', { type: 'thinking', thinking: '' }), ...last], s);
  const mixed = lead(head, { a: own([msgFrom('2', text('Done.'))]), b: own([msgFrom('3', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })]) });
  assert.equal(readClaudeTurn(mixed)?.background, 1);
  const queued = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'more' } };
  assert.equal(readClaudeTurn(lead(head, { a: own([msgFrom('2', text('Done.')), { ...queued, timestamp: at(30) }]), b: own([msgFrom('3', text('Done.'))]) }))?.background, 1);
  assert.equal(readClaudeTurn(lead(head, { a: own([msgFrom('2', text('Done.')), { ...cUser(tag('team-lead', 'More.')), timestamp: at(30) }]), b: own([msgFrom('3', text('Done.'))]) }))?.background, 1);
  // Thinking not yet followed by its text is no rest either; a teammate that has said nothing isn't.
  assert.equal(readClaudeTurn(lead(head, { a: own([]), b: own([msgFrom('3', text('Done.'))]) }))?.background, 1);
  assert.equal(readClaudeTurn(lead(head, { a: own([msgFrom('2', text('Done.'))]), b: own([msgFrom('3', text('Done.'))]) }))?.background, undefined);

  // A teammate's message isn't the office's prompt: the background agent launched before it still counts, and the turn after it is read.
  const launch = cUser([{ type: 'tool_result', tool_use_id: 'a1', content: [text('Async agent launched successfully.\nagentId: ag1 (internal ID)')] }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ag1' } });
  const bgHead = [cUser('Implement task #7'), cAssistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { run_in_background: true } }], {}, 'm1'), launch, cAssistant([text('Waiting.')], {}, 'm2')];
  const mailed = readClaudeTurn(lead([...bgHead, mail(tag('x', idle('x'))), cAssistant([text('x is at rest.')], {}, 'm3')]));
  assert.deepEqual(mailed, { text: 'x is at rest.', complete: true, background: 1 });
  // The last prompt a teammate's message nothing has answered: the lead is about to take its turn.
  assert.deepEqual(readClaudeTurn(lead([...bgHead, mail(tag('x', 'Report.', ' summary="Done"'))])), { text: '', complete: false, background: 1, resuming: true });
  // A typed prompt quoting the tag (origin human) is the window's prompt.
  assert.deepEqual(readClaudeTurn(lead([...bgHead, cUser(tag('x', 'Report.'), { origin: { kind: 'human' } })])), { text: '', complete: false });

  // A prompt typed over the office's turns: the answer is interim only when a teammate is still at work by the lead's log at that point.
  const mine = { runStart: Date.parse(at(0)), promptAt: Date.parse(at(0)) };
  const typedAfterTeam = (...mid: object[]) => lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait, ...mid, cUser('How is it going?'), cAssistant([text('Fine.')], {}, 'mc')], 1));
  assert.deepEqual(readClaudeTurn(typedAfterTeam(), mine), { text: 'Waiting for the teammates.', complete: true, background: 1, typed: true, interim: true });
  // The teammate finished (idle) and the agent gave its final answer: that answer stands, nothing to restate.
  const finished = [mail(tag('a', idle('a'))), cAssistant([text('All done.')], {}, 'mf')];
  assert.deepEqual(readClaudeTurn(typedAfterTeam(...finished), mine), { text: 'All done.', complete: true, typed: true });
  // A wake after the idle puts it back at work.
  assert.equal(readClaudeTurn(typedAfterTeam(...finished, ...send('a', 'q9')), mine)?.interim, true);

  // A prompt typed into the terminal after the spawn doesn't hide the teammate when the window starts at the run's prompt (`runStart`).
  const typedAfter = lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait, cUser('Also check the docs'), cAssistant([text('Checked.')], {}, 'mh')], 1));
  assert.equal(readClaudeTurn(typedAfter)?.background, undefined);
  assert.equal(readClaudeTurn(typedAfter, { runStart: Date.parse(at(0)) })?.background, 1);

  // A teammate of an earlier phase (spawned before the office's last prompt) that this phase wakes with SendMessage is at work
  // although its transcript still ends at rest.
  const old = withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait, cUser('Fix task #7'), ...send('a', 'q1'), wait], 1);
  const rested = { a: own([msgFrom('2', text('Done.'))], 2) };
  assert.equal(readClaudeTurn(lead(old, rested))?.background, 1);
  // ... and it isn't one the lead never wrote to.
  assert.equal(readClaudeTurn(lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait, cUser('Fix task #7'), wait], 1), rested))?.background, undefined);
  // Its transcript newer than the message says it answered: at rest again.
  assert.equal(readClaudeTurn(lead(old, { a: own([msgFrom('2', text('Done.'))], 40) }))?.background, undefined);
  // The message to a teammate that can't be found failed: nothing wakes. A broadcast wakes every one.
  const failed = cUser([{ type: 'tool_result', tool_use_id: 'q1', content: 'no such teammate' }], { toolUseResult: { success: false, message: 'no such teammate' } });
  assert.equal(readClaudeTurn(lead(withTs([cUser('Fix'), cAssistant([{ type: 'tool_use', id: 'q1', name: 'SendMessage', input: { to: 'a' } }], {}, 'mq'), failed, wait], 1), rested))?.background, undefined);
  assert.equal(readClaudeTurn(lead(withTs([cUser('Fix'), ...send('*', 'q1').map((l, i) => (i ? { ...l, toolUseResult: { success: true, routing: { target: '*' } } } : l)), wait], 1), { a: own([msgFrom('2', text('Done.'))], 0) }))?.background, 1);
  // Without a toolUseResult (an older CLI): the call's own `to`.
  const older = withTs([cUser('Fix'), cAssistant([{ type: 'tool_use', id: 'q1', name: 'SendMessage', input: { to: 'a', message: 'm' } }], {}, 'mq'), cUser([{ type: 'tool_result', tool_use_id: 'q1', content: 'sent' }]), wait], 1);
  assert.equal(readClaudeTurn(lead(older, { a: own([msgFrom('2', text('Done.'))], 0) }))?.background, 1);

  // A teammate sending another a message goes idle with a "[to Y]" summary. The sender's own transcript is the truth for the send:
  // its SendMessage newer than Y's last line wakes Y (the summary of the notification, a few lines on, adds nothing).
  const relay = withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), wait, mail(tag('a', idle('a', { summary: '[to b] take over' }))), cAssistant([text('Waiting on b.')], {}, 'm9')], 1);
  const dm = (from: string, to: string, id: string) => [
    cAssistant([{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'hi' } }], {}, `m-${id}`),
    cUser([{ type: 'tool_result', tool_use_id: id, content: [text('{"success":true}')] }], { toolUseResult: { success: true, routing: { sender: from, target: `@${to}` } } }),
  ];
  const sender = (to: string, s: number) => withTs([cUser(tag('team-lead', 'Do it.')), msgFrom('1', { type: 'thinking', thinking: '' }), ...dm('a', to, 'd1'), msgFrom('2', text('Sent.'))], s);
  assert.equal(readClaudeTurn(lead(relay, { a: sender('b', 10), b: own([msgFrom('3', text('Done.'))], 3) }))?.background, 1);
  // ... a sender with no transcript (only its spawn): the summary wakes Y.
  assert.equal(readClaudeTurn(lead(relay, { b: own([msgFrom('3', text('Done.'))], 3) }))?.background, 1);
  // A send to the lead (team-lead, main) wakes nobody.
  assert.equal(readClaudeTurn(lead(relay, { a: sender('team-lead', 10), b: own([msgFrom('3', text('Done.'))], 3) }))?.background, undefined);

  // #336: the idle notification of a sender can reach the lead minutes late, its "[to b]" summary naming a message b answered long ago.
  // a sent at 12 and b answered by 15; the notification came at 40: b is at rest.
  const late = [...withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), wait], 1), ...withTs([mail(tag('a', idle('a', { summary: '[to b] take over' }))), cAssistant([text('Waiting on b.')], {}, 'm9')], 40)];
  const answered = { a: sender('b', 10), b: withTs([cUser(tag('a', 'take over')), msgFrom('1', { type: 'thinking', thinking: '' }), msgFrom('2', text('Done.'))], 13) };
  assert.equal(readClaudeTurn(lead(late, answered))?.background, undefined);

  // A teammate's own idle notification can reach the lead late too: b went idle at 15, was woken by a's DM at 20 and runs a long Bash
  // call (its transcript ends in a tool call at 25); the stale idle, logged by the lead at 40, dated by its own timestamp, doesn't rest it.
  const stale = [...withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), wait], 1), ...withTs([mail(tag('b', idle('b', { timestamp: at(15) }))), cAssistant([text('b is idle.')], {}, 'm9')], 40)];
  const woken = { a: sender('b', 18), b: withTs([cUser(tag('a', 'again')), msgFrom('1', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })], 24) };
  assert.equal(readClaudeTurn(lead(stale, woken))?.background, 1);
  assert.deepEqual(teammateTags(messageTextOf(mail(tag('b', idle('b', { timestamp: at(15) }))))), [{ from: 'b', type: 'idle_notification', at: Date.parse(at(15)) }]);

  // An idle body with no timestamp is dated by the lead's line.
  const undated = [...withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait], 1), ...withTs([mail(tag('a', idle('a', { timestamp: undefined }))), cAssistant([text('a is idle.')], {}, 'm9')], 40)];
  assert.equal(readClaudeTurn(lead(undated, { a: own([msgFrom('2', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })], 20) }))?.background, undefined);

  // A rest and a wake on the same ms: working.
  const tie = [...withTs([cUser('Implement task #7'), ...spawn('b', 's2'), wait], 1), ...withTs([cAssistant([{ type: 'tool_use', id: 'q1', name: 'SendMessage', input: { to: 'b' } }], {}, 'mq')], 29), { ...send('b', 'q1')[1], timestamp: at(30) }, ...withTs([mail(tag('b', idle('b', { timestamp: at(30) }))), cAssistant([text('b.')], {}, 'm9')], 40)];
  assert.equal(readClaudeTurn(lead(tie, { b: own([msgFrom('3', text('Done.'))], 3) }))?.background, 1);

  // A meta with only `agentType` (no `name`) still names the sender: its late "[to b]" is suppressed all the same.
  const nameless = lead(late, answered);
  writeFileSync(path.join(path.dirname(nameless), path.basename(nameless, '.jsonl'), 'subagents', 'agent-aa-abc.meta.json'), JSON.stringify({ agentType: 'a', taskKind: 'in_process_teammate' }));
  assert.equal(readClaudeTurn(nameless)?.background, undefined);

  // A late termination is dated by its own time: an old one doesn't override the lead's later wake of b; one newer than b's last line rests it.
  const ended = (stamp: number, s: number) => [...withTs([cUser('Implement task #7'), ...spawn('b', 's2'), wait, ...send('b', 'q1')], 26), ...withTs([mail(tag('b', JSON.stringify({ type: 'teammate_terminated', from: 'b', timestamp: at(stamp) }))), cAssistant([text('b ended.')], {}, 'm9')], s)];
  assert.equal(readClaudeTurn(lead(ended(20, 60), { b: own([msgFrom('3', text('Done.'))], 3) }))?.background, 1);
  assert.equal(readClaudeTurn(lead(ended(70, 80), { b: own([msgFrom('3', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })], 3) }))?.background, undefined);

  // A teammate closing with a message to the lead ("[to main]": a name that is no teammate's) wakes nobody, with or without a transcript.
  const report = withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait, mail(tag('a', idle('a', { summary: '[to main] done' }))), cAssistant([text('Done.')], {}, 'm9')], 1);
  assert.equal(readClaudeTurn(lead(report, { a: own([msgFrom('2', text('Done.'))], 2) }))?.background, undefined);
  assert.equal(readClaudeTurn(lead(report))?.background, undefined);

  // One that last wrote before `since` died with an earlier process, even if its transcript ends in a tool call.
  const dead = { a: own([msgFrom('2', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })], 5) };
  const deadLead = lead(withTs([cUser('Implement task #7'), wait], 1), dead);
  assert.equal(readClaudeTurn(deadLead, { since: Date.UTC(2026, 9, 1, 6, 0, 0) })?.background, 1);
  assert.equal(readClaudeTurn(deadLead, { since: Date.UTC(2026, 9, 1, 6, 5, 0) })?.background, undefined);
  // Its spawn before `since` (an earlier process's) wakes nothing either.
  assert.equal(readClaudeTurn(lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait], 1)), { since: Date.UTC(2026, 9, 1, 6, 5, 0) })?.background, undefined);

  // Several tags on one line, their JSON bodies holding `}` and `>`: all are read. a and b go to rest; c, spawned after, doesn't.
  const result = 'Changed `{ a: 1 }` and `x => y`; "}" too';
  const crowd = withTs([cUser('Implement task #7'), ...spawn('a', 's1'), ...spawn('b', 's2'), mail(tag('a', idle('a', { result }), ' summary="A -> B"'), tag('b', idle('b', { result }))), ...spawn('c', 's3'), wait], 1);
  assert.equal(readClaudeTurn(lead(crowd))?.background, 1);
  assert.deepEqual(teammateTags(messageTextOf(mail(tag('a', idle('a', { result, summary: '[to b] hi' }), ' summary="A -> B"'), tag('b@session-1', 'Report in words.')))), [{ from: 'a', type: 'idle_notification', summary: '[to b] hi' }, { from: 'b' }]);

  // Several transcripts of one name (a respawn): the one written last speaks, whichever the directory lists last.
  const twin = (oldIsFirst: boolean) => {
    const file = lead(withTs([cUser('Implement task #7'), ...spawn('a', 's1'), wait], 1));
    const folder = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    const put = (id: string, lines: object[]) => {
      writeFileSync(path.join(folder, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      writeFileSync(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'a', name: 'a', taskKind: 'in_process_teammate' }));
    };
    // The dead one ends in a tool call, the live one at rest.
    put(oldIsFirst ? 'a1' : 'a2', own([msgFrom('2', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })], 5));
    put(oldIsFirst ? 'a2' : 'a1', own([msgFrom('3', text('Done.'))], 20));
    return file;
  };
  assert.equal(readClaudeTurn(twin(true))?.background, undefined);
  assert.equal(readClaudeTurn(twin(false))?.background, undefined);

  // A long transcript (more lines than a call can spread) is read from its tail: it rests, or works, by its last lines.
  const filler = Array.from({ length: 200_000 }, () => '{"type":"progress"}').join('\n');
  const longOwn = (last: object[]) => `${filler}\n${[...own(last, 10)].map((l) => JSON.stringify(l)).join('\n')}\n`;
  const longLead = (last: object[]) => {
    const file = lead(head);
    writeFileSync(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', 'agent-along-abc.jsonl'), longOwn(last));
    writeFileSync(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', 'agent-along-abc.meta.json'), JSON.stringify({ agentType: 'long', name: 'long', taskKind: 'in_process_teammate' }));
    return file;
  };
  // (a and b have no transcript here but are spawned; the long one is a third teammate.)
  const base = readClaudeTurn(lead(head))?.background;
  assert.equal(readClaudeTurn(longLead([msgFrom('9', text('Done.'))]))?.background, base! + 0);
  assert.equal(readClaudeTurn(longLead([msgFrom('9', { type: 'tool_use', id: 'x', name: 'Bash', input: {} })]))?.background, base! + 1);

  // A transcript that can't be read (a folder in its place) is no rest.
  const broken = lead(withTs([cUser('Implement task #7'), wait], 1));
  const brokenDir = path.join(path.dirname(broken), path.basename(broken, '.jsonl'), 'subagents');
  mkdirSync(path.join(brokenDir, 'agent-abroken-1.jsonl'));
  writeFileSync(path.join(brokenDir, 'agent-abroken-1.meta.json'), JSON.stringify({ agentType: 'broken', name: 'broken', taskKind: 'in_process_teammate' }));
  assert.equal(readClaudeTurn(broken)?.background, 1);
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

test('claudeInterruptedSince: an Esc Claude logged as an interrupt line at or after the stop, not an earlier one or a quoted one', (t) => {
  const write = scratch(t);
  const at = Date.parse('2026-01-01T10:00:10Z');
  const interrupt = (ts: string) => cUser([text('[Request interrupted by user]')], { timestamp: ts });
  const file = write('s.jsonl', [cUser('go'), interrupt('2026-01-01T10:00:00Z'), cUser([{ type: 'tool_result', tool_use_id: 't', content: '[Request interrupted by user]' }], { timestamp: '2026-01-01T10:00:20Z' })]);
  assert.equal(claudeInterruptedSince(file, at), false);
  assert.equal(claudeInterruptedSince(write('t.jsonl', [cUser('go'), interrupt('2026-01-01T10:00:11Z')]), at), true);
  assert.equal(claudeInterruptedSince(write('u.jsonl', [cUser('go'), cUser('[Request interrupted by user for tool use]', { timestamp: '2026-01-01T10:00:11Z' })]), at), true);
  assert.equal(claudeInterruptedSince(path.join(path.dirname(file), 'missing.jsonl'), at), false);
});
