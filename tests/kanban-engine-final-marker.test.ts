import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalMarker, stripWorkDone, workDone } from '../src/server/kanban/engine/markers.js';
import { promptHead } from '../src/server/kanban/engine/turnhold.js';
import { readClaudeTurn } from '../src/server/kanban/engine/adapters/claude.js';
import { readCodexTurn } from '../src/server/kanban/engine/adapters/codex.js';
import { KANBAN_CONTRACTS, PROMPT_CONTRACT, finishNudge } from '../src/shared/kanban/prompts.js';

test('finalMarker: WORK DONE on its own line among the last three, for every phase but plan and review', () => {
  for (const phase of ['implement', 'fix', 'resume', 'pr', 'pr-fix', 'pr-conflicts', 'pr-comments', 'pr-answers'] as const) {
    assert.equal(finalMarker(phase, 'Fixed the redirect.\n\nWORK DONE'), true, phase);
    assert.equal(finalMarker(phase, 'Fixed the redirect.'), false, phase);
  }
  // Emphasis and a closing word are forgiven; the marker anywhere further up, mid-sentence, in a code block or in a quote is not one.
  assert.equal(finalMarker('implement', '**WORK DONE**'), true);
  assert.equal(finalMarker('implement', 'All good.\nWORK DONE\nThanks!'), true);
  assert.equal(finalMarker('implement', 'WORK DONE\na\nb\nc'), false);
  assert.equal(finalMarker('implement', 'I am not WORK DONE yet'), false);
  assert.equal(finalMarker('implement', 'Waiting.\n```\nWORK DONE\n```'), false);
  assert.equal(finalMarker('implement', 'The contract says:\n> WORK DONE'), false);
  assert.equal(workDone('PR: https://github.com/a/b/pull/1\nWORK DONE'), true);
  // The pr contract asks for the PR lines at the end too: they don't count against the tail.
  const prs = 'Opened them.\nWORK DONE\nPR: https://github.com/a/b/pull/1\nPR: https://github.com/a/b/pull/2\nPR: https://github.com/a/b/pull/3';
  assert.equal(finalMarker('pr', prs), true);
  assert.equal(stripWorkDone(prs), 'Opened them.\nPR: https://github.com/a/b/pull/1\nPR: https://github.com/a/b/pull/2\nPR: https://github.com/a/b/pull/3');
  // Case, closing punctuation and emoji are forgiven; the line must still be its own.
  for (const line of ['WORK DONE.', 'Work done', 'work done!', 'WORK DONE ✅', '**Work done** 🎉', '`WORK DONE`']) assert.equal(finalMarker('implement', `Fixed.\n${line}`), true, line);
  for (const line of ['work done yet?', 'Almost WORK DONE', 'WORK DONE soon']) assert.equal(finalMarker('implement', `Fixed.\n${line}`), false, line);
});

test('finalMarker: a plan ends with PLAN READY, QUESTIONS: or ExitPlanMode; a review with its verdict line', () => {
  assert.equal(finalMarker('plan', 'The plan.\nPLAN READY'), true);
  assert.equal(finalMarker('plan', 'QUESTIONS:\n1. Which one?'), true);
  assert.equal(finalMarker('plan', 'Still reading the code.'), false);
  assert.equal(finalMarker('plan', 'Still reading the code.', true), true);
  assert.equal(finalMarker('plan', 'Is this a plan? Is it?'), false);
  assert.equal(finalMarker('plan', 'WORK DONE'), false);
  for (const phase of ['review', 'pr-review'] as const) {
    assert.equal(finalMarker(phase, 'Findings.\nREVIEW: APPROVED'), true);
    assert.equal(finalMarker(phase, 'Findings.\nREVIEW: CHANGES_REQUESTED'), true);
    assert.equal(finalMarker(phase, 'Waiting for the helper.'), false);
    assert.equal(finalMarker(phase, 'Done.\nWORK DONE'), false);
    assert.equal(finalMarker(phase, 'REVIEW: APPROVED\n1\n2\n3'), false);
  }
});

test('stripWorkDone takes the marker off the end of an answer, and only the marker', () => {
  assert.equal(stripWorkDone('Fixed it.\n\nWORK DONE'), 'Fixed it.');
  assert.equal(stripWorkDone('Fixed it.\n**WORK DONE**\n'), 'Fixed it.');
  assert.equal(stripWorkDone('Fixed it.'), 'Fixed it.');
  assert.equal(stripWorkDone('Quoting:\n> WORK DONE\nand more'), 'Quoting:\n> WORK DONE\nand more');
  assert.equal(stripWorkDone('WORK DONE\nsome\nmore\nlines\nhere'), 'WORK DONE\nsome\nmore\nlines\nhere');
});

test('the contracts ask for the marker the engine reads, and the nudges ask for the same', () => {
  for (const id of ['implementSafety', 'investigateSafety', 'pr'] as const) assert.match(KANBAN_CONTRACTS[id], /end your final reply with a line that says only: WORK DONE/, id);
  for (const id of ['plan', 'review', 'prReview'] as const) assert.match(KANBAN_CONTRACTS[id], /interim update/, id);
  assert.doesNotMatch(KANBAN_CONTRACTS.panel, /WORK DONE/);
  assert.equal(PROMPT_CONTRACT['kanban.implement'], 'implementSafety');
  assert.match(finishNudge('implement'), /WORK DONE/);
  assert.match(finishNudge('plan'), /PLAN READY/);
  assert.match(finishNudge('review'), /REVIEW: APPROVED/);
  assert.equal(finishNudge('pr-review'), finishNudge('review'));
});

test('the contracts also ask for the announcement, and say the text marker stays required', () => {
  for (const id of ['implementSafety', 'investigateSafety', 'pr'] as const) {
    const c = KANBAN_CONTRACTS[id];
    assert.match(c, /run `office-tasks done` \(or call the agent-office MCP tool `report_turn` with kind done\)/, id);
    assert.match(c, /run `office-tasks ask` instead and end your reply with your questions/, id);
    assert.match(c, /If the command fails or isn't available, carry on: the WORK DONE line is enough/, id);
    assert.match(c, /Don't report when you only end a turn to wait/, id);
    assert.match(c, /end your final reply with a line that says only: WORK DONE/, id);
  }
  assert.match(KANBAN_CONTRACTS.pr, /office-tasks pr <its URL>`[^\n]*the PR: lines stay required/);
  assert.doesNotMatch(KANBAN_CONTRACTS.implementSafety, /office-tasks pr/);
  // A plan or a review may be a Codex sandbox with no network, or Claude's plan mode: only the MCP tool is named there.
  for (const id of ['plan', 'review', 'prReview'] as const) {
    assert.match(KANBAN_CONTRACTS[id], /If the agent-office MCP tool `report_turn` is available to you in this mode, also call it right before your final reply/, id);
    assert.doesNotMatch(KANBAN_CONTRACTS[id], /office-tasks/, id);
  }
  assert.match(KANBAN_CONTRACTS.plan, /kind plan-ready, or ask with your questions\)\. It never replaces the marker line/);
  assert.match(KANBAN_CONTRACTS.plan, /When you hand the plan over with ExitPlanMode, don't call it in that turn at all: ExitPlanMode is the announcement/);
  assert.match(KANBAN_CONTRACTS.review, /kind review, verdict approved or changes\)\. It never replaces the verdict line: the verdict line in your reply is what counts for an approval/);
  assert.doesNotMatch(KANBAN_CONTRACTS.panel, /report_turn|office-tasks/);
  assert.match(finishNudge('implement'), /office-tasks done/);
  assert.doesNotMatch(finishNudge('plan'), /office-tasks/);
  assert.doesNotMatch(finishNudge('review'), /office-tasks/);
});

test('the contracts stress the marker as the last line and ask for a final check; the nudges ask for the whole answer again', () => {
  assert.match(KANBAN_CONTRACTS.plan, /as its very last line/);
  assert.match(KANBAN_CONTRACTS.plan, /read the end of your reply once more/);
  for (const id of ['implementSafety', 'investigateSafety', 'pr'] as const) assert.match(KANBAN_CONTRACTS[id], /check that your reply really ends with that line/, id);
  for (const id of ['review', 'prReview'] as const) assert.match(KANBAN_CONTRACTS[id], /check that the verdict really is the last line/, id);
  for (const phase of ['implement', 'plan', 'review'] as const) {
    assert.match(finishNudge(phase), /only this reply/, phase);
    assert.match(finishNudge(phase), /again/, phase);
  }
});

// --- The log: queued prompts, office comments, a person's turn after the office's -----------------------

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-final-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  return (lines: object[]) => {
    const file = path.join(dir, `s${++n}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
}
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
const user = (content: unknown, s: number, extra: object = {}) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
const asst = (s: number, id: string, ...content: object[]) => ({ type: 'assistant', timestamp: at(s), message: { id, role: 'assistant', content } });
const text = (t: string) => ({ type: 'text', text: t });
const queued = (prompt: unknown, s: number, commandMode = 'prompt') => ({ type: 'attachment', timestamp: at(s), attachment: { type: 'queued_command', prompt, commandMode } });

test('a prompt typed while Claude works (a queued_command attachment) is a real prompt: the office\'s is heard, a person\'s is typed', (t) => {
  const write = scratch(t);
  const tool = asst(2, 'm1', { type: 'tool_use', id: 'x1', name: 'Bash', input: {} });
  const result = user([{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }], 3);
  const opts = { runStart: T0, promptAt: T0, promptHead: 'Implement' };
  // The office's own prompt was queued behind a running turn: it is in the log as an attachment, so it is heard.
  const heard = readClaudeTurn(write([user('Earlier prompt', -5), asst(-4, 'm0', text('Old.\nWORK DONE')), tool, queued('Implement task #7 now', 1), result, asst(5, 'm2', text('Done.\nWORK DONE'))]), opts);
  assert.equal(heard?.unheard, undefined);
  assert.equal(heard?.text, 'Done.\nWORK DONE');
  // The text may be an array of text blocks.
  assert.equal(readClaudeTurn(write([tool, queued([{ type: 'text', text: 'Implement task #7 now' }], 1), result, asst(5, 'm2', text('Done.'))]), opts)?.unheard, undefined);
  // The same line is no prompt when it is a notification.
  assert.equal(readClaudeTurn(write([tool, queued('Implement task #7 now', 1, 'task-notification'), result, asst(5, 'm2', text('Done.'))]), opts)?.unheard, true);
  // Not heard while it is missing, the earlier turn is read as without it.
  assert.equal(readClaudeTurn(write([user('Earlier prompt', -5), asst(-4, 'm0', text('Old.\nWORK DONE'))]), opts)?.unheard, true);
  // A person's prompt typed meanwhile is typed: the answer stops before it.
  const typed = readClaudeTurn(write([user('Implement task #7', 1), asst(2, 'm1', text('Working on it.')), queued('How is it going?', 3), asst(4, 'm2', text('Fine.'))]), { ...opts, promptHead: 'Implement' });
  assert.equal(typed?.typed, true);
  assert.equal(typed?.text, 'Working on it.');
});

test('a comment the office typed into the run is its own prompt: no typed turn, the answer is the last marked reply', (t) => {
  const write = scratch(t);
  const comment = 'Comment from Ada on task #7 while you work: also rename foo';
  const head = comment.slice(0, 40);
  const opts = { runStart: T0, promptAt: T0, promptHead: 'Implement', officePrompts: [{ at: T0 + 2000, head }] };
  const log = [user('Implement task #7', 1), asst(2, 'm1', { type: 'tool_use', id: 'x1', name: 'Bash', input: {} }), queued(comment, 3), user([{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }], 4), asst(5, 'm2', text('Renamed too.\nWORK DONE'))];
  const own = readClaudeTurn(write(log), opts);
  assert.equal(own?.typed, undefined);
  assert.equal(own?.unheard, undefined);
  assert.equal(own?.text, 'Renamed too.\nWORK DONE');
  // Without being told, the same line is a person's.
  assert.equal(readClaudeTurn(write(log), { ...opts, officePrompts: undefined })?.typed, true);
  // As a user line too (typed into a resting agent).
  const asUser = [user('Implement task #7', 1), asst(2, 'm1', text('Done.\nWORK DONE')), user(comment, 3), asst(4, 'm2', text('Renamed.\nWORK DONE'))];
  const t2 = readClaudeTurn(write(asUser), opts);
  assert.equal(t2?.typed, undefined);
  assert.equal(t2?.text, 'Renamed.\nWORK DONE');
});

test('a comment just typed that the log does not have yet is unheard; one long lost is not waited for', (t) => {
  const write = scratch(t);
  const log = write([user('Implement task #7', 1), asst(2, 'm1', text('Done.\nWORK DONE'))]);
  const now = Date.now();
  assert.equal(readClaudeTurn(log, { runStart: T0, promptAt: T0, officePrompts: [{ at: now - 1000, head: 'Comment from' }] })?.unheard, true);
  // Still waited for after a long tool call, and when a prompt hook heard it (the log may lag behind); after 15 minutes it is lost, not unheard.
  assert.equal(readClaudeTurn(log, { runStart: T0, promptAt: T0, officePrompts: [{ at: now - 120_000, head: 'Comment from' }] })?.unheard, true);
  assert.equal(readClaudeTurn(log, { runStart: T0, promptAt: T0, officePrompts: [{ at: now - 1000, head: 'Comment from', heard: true }] })?.unheard, true);
  assert.equal(readClaudeTurn(log, { runStart: T0, promptAt: T0, officePrompts: [{ at: now - 16 * 60_000, head: 'Comment from' }] })?.unheard, undefined);
  assert.deepEqual(readClaudeTurn(log, { runStart: T0, promptAt: T0, officePrompts: [{ at: now - 16 * 60_000, head: 'Comment from' }] })?.lost, { office: [0] });
});

test('lastText is the log\'s last turn when a person\'s typed turn took the end', (t) => {
  const write = scratch(t);
  const opts = { runStart: T0, promptAt: T0 };
  // The office's turn ended on interim text; the person's turn gave the final answer with the marker.
  const done = readClaudeTurn(write([user('Implement task #7', 1), asst(2, 'm1', text('Waiting for the helper.')), user('Status?', 3), asst(4, 'm2', text('All finished.\nWORK DONE'))]), opts);
  assert.equal(done?.typed, true);
  assert.equal(done?.text, 'Waiting for the helper.');
  assert.equal(done?.lastText, 'All finished.\nWORK DONE');
  // The typed turn is not over (a tool runs, or a prompt has no reply yet): no lastText.
  assert.equal(readClaudeTurn(write([user('Implement task #7', 1), asst(2, 'm1', text('Waiting.')), user('Status?', 3), asst(4, 'm2', text('Checking.'), { type: 'tool_use', id: 'x', name: 'Bash', input: {} })]), opts)?.lastText, undefined);
  assert.equal(readClaudeTurn(write([user('Implement task #7', 1), asst(2, 'm1', text('Waiting.')), user('Status?', 3)]), opts)?.lastText, undefined);
  // No typed prompt: nothing to add.
  assert.equal(readClaudeTurn(write([user('Implement task #7', 1), asst(2, 'm1', text('Done.'))]), opts)?.lastText, undefined);
});

// --- Teammates that approved their shutdown ---------------------------------------------------------------

test('a teammate whose transcript ends on its approval of a shutdown (the process died before the tool result) is at rest', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-team-final-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stamp = (s: number) => at(s);
  const lead = (own: object[], file = 'lead.jsonl') => {
    const lines = [
      user('Implement task #7', 1),
      asst(2, 'ma', { type: 'tool_use', id: 's1', name: 'Agent', input: { name: 'helper' } }),
      { ...user([{ type: 'tool_result', tool_use_id: 's1', content: [text('Spawned successfully.\nagent_id: helper@session-1\nname: helper')] }], 3), toolUseResult: { status: 'teammate_spawned', name: 'helper', teammate_id: 'helper@session-1', team_name: 'session-1' } },
      asst(4, 'mw', text('Waiting for the helper.')),
    ];
    const f = path.join(dir, file);
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const sub = path.join(dir, file.replace(/\.jsonl$/, ''), 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'agent-ahelper-1.meta.json'), JSON.stringify({ agentType: 'helper', name: 'helper', taskKind: 'in_process_teammate' }));
    writeFileSync(path.join(sub, 'agent-ahelper-1.jsonl'), own.map((l) => JSON.stringify({ isSidechain: true, ...l })).join('\n') + '\n');
    return f;
  };
  const request = user('<teammate-message teammate_id="team-lead">{"type":"shutdown_request"}</teammate-message>', 10);
  const approve = (message: unknown) => asst(11, 'sd', { type: 'tool_use', id: 'r1', name: 'SendMessage', input: { to: 'team-lead', message } });
  const base = [user('<teammate-message teammate_id="team-lead">Go</teammate-message>', 5), asst(6, 'm1', { type: 'tool_use', id: 'b1', name: 'Bash', input: {} })];
  const opts = { runStart: T0, promptAt: T0, since: T0 - 1000 };
  // Working: it ends on a tool call.
  assert.equal(readClaudeTurn(lead(base, 'a.jsonl'), opts)?.background, 1);
  // Approved shutdown: at rest, whatever shape the message has.
  for (const [i, message] of [{ type: 'shutdown_response', request_id: 'x', approve: true }, JSON.stringify({ type: 'shutdown_response', approve: true })].entries()) {
    assert.equal(readClaudeTurn(lead([...base, request, approve(message)], `b${i}.jsonl`), opts)?.background, undefined, `shape ${i}`);
  }
  // A refusal is work still under way.
  assert.equal(readClaudeTurn(lead([...base, request, approve({ type: 'shutdown_response', approve: false, reason: 'busy' })], 'c.jsonl'), opts)?.background, 1);
  // Any other message to the lead is not an approval.
  assert.equal(readClaudeTurn(lead([...base, asst(11, 'sd', { type: 'tool_use', id: 'r1', name: 'SendMessage', input: { to: 'team-lead', message: 'Done with part one' } })], 'd.jsonl'), opts)?.background, 1);
  void stamp;
});

test('codex: a comment typed into the run that its rollout has no user message for yet is unheard until its message shows, whatever the hook said', (t) => {
  const write = scratch(t);
  const at0 = Date.now() - 5000;
  const base = [
    { type: 'event_msg', timestamp: new Date(at0 - 10_000).toISOString(), payload: { type: 'user_message', message: 'Implement task #7' } },
    { type: 'event_msg', timestamp: new Date(at0 + 1000).toISOString(), payload: { type: 'task_complete', last_agent_message: 'Done.\nWORK DONE' } },
  ];
  const head = 'Comment from Ada on task #7';
  const unconfirmed = [{ at: at0, head }];
  assert.equal(readCodexTurn(write(base), { officePrompts: unconfirmed })?.unheard, true);
  assert.equal(readCodexTurn(write(base), { officePrompts: [{ at: at0, head, heard: true }] })?.unheard, true);
  assert.equal(readCodexTurn(write(base), {})?.unheard, undefined);
  const heard = [...base, { type: 'event_msg', timestamp: new Date(at0 + 2000).toISOString(), payload: { type: 'user_message', message: `${head} while you work: x` } }];
  assert.equal(readCodexTurn(write(heard), { officePrompts: unconfirmed })?.unheard, undefined);
});

// --- The log: prompts Claude Code logged wrapped in <pasted_content> ---------------------------------------

/** A text as Claude Code logs it pasted: the user line's string (blank lines before, a newline after) and the queued attachment's bare one. */
const pasted = (body: string, id = 'q7x2') => ({
  asUser: `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`,
  asQueued: `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`,
});
const C1 = 'Comment #5 from Ada on task #7 while you work:\nPlease also log the redirect target.';
const C2 = 'Comment #6 from Ada on task #7 while you work:\nAnd rename the helper.';

test('office comments logged wrapped in <pasted_content> (user line and queued attachment) are acknowledged', (t) => {
  const write = scratch(t);
  const officePrompts = [{ at: T0 + 2000, head: promptHead(C1) }, { at: T0 + 2500, head: promptHead(C2) }];
  const opts = { runStart: T0, promptAt: T0, promptHead: 'Implement', officePrompts };
  const tool = asst(2, 'm1', { type: 'tool_use', id: 'x1', name: 'Bash', input: {} });
  const log = [
    user('Implement task #7', 1),
    tool,
    queued(pasted(C1).asQueued, 3),
    user([{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }], 4),
    asst(5, 'm2', text('Logged.\nWORK DONE')),
    user(pasted(C2).asUser, 6, { origin: { kind: 'human' } }),
    asst(7, 'm3', text('Renamed.\nWORK DONE')),
  ];
  const r = readClaudeTurn(write(log), opts);
  assert.deepEqual([...(r?.seen ?? [])].sort(), [0, 1]);
  assert.equal(r?.unheard, undefined);
  assert.equal(r?.typed, undefined);
  assert.equal(r?.waiting, undefined);
  assert.ok(r?.text?.endsWith('WORK DONE'));
  assert.equal(r?.complete, true);
});

test('a wrapped launch prompt and a wrapped restate are found among a person\'s prompts', (t) => {
  const write = scratch(t);
  const launch = 'Implement kanban task #7: redirect logging.';
  const restate = 'Restate your answer for task #7 and end with WORK DONE.';
  const log = [
    user('Hold on, quick question', 1),
    user(pasted(launch).asUser, 2, { origin: { kind: 'human' } }),
    asst(3, 'm1', text('First answer.')),
    user(pasted(restate).asUser, 4, { origin: { kind: 'human' } }),
    asst(5, 'm2', text('Restated.\nWORK DONE')),
  ];
  const first = readClaudeTurn(write(log), { runStart: T0, promptAt: T0, promptHead: promptHead(launch) });
  // The answer is the reply after the office's launch prompt, not the person's earlier prompt's (the later restate is, to this read, a prompt typed after it).
  assert.equal(first?.unheard, undefined);
  assert.equal(first?.text, 'First answer.');
  // A restate later than the launch is found by its own head.
  const again = readClaudeTurn(write(log), { runStart: T0, promptAt: T0 + 3500, promptHead: promptHead(restate) });
  assert.equal(again?.unheard, undefined);
  assert.equal(again?.text, 'Restated.\nWORK DONE');
  assert.equal(again?.typed, undefined);
});

test('a person\'s typed text followed by a paste that quotes the office comment stays a person\'s', (t) => {
  const write = scratch(t);
  const officePrompts = [{ at: T0 + 2000, head: promptHead(C1) }];
  const quoted = `Fix these:\n\n\n\n<pasted_content id="ab12">\n${C1}\n</pasted_content id="ab12">\n`;
  const log = [user('Implement task #7', 1), asst(2, 'm1', text('Working.')), user(quoted, 3, { origin: { kind: 'human' } }), asst(4, 'm2', text('Fixed.'))];
  const r = readClaudeTurn(write(log), { runStart: T0, promptAt: T0, promptHead: 'Implement', officePrompts });
  assert.equal(r?.typed, true);
  assert.equal(r?.seen, undefined);
  // So does a paste of the comment with typed text after it: the wrapper isn't around the whole prompt.
  const after = `<pasted_content id="ab12">\n${C1}\n</pasted_content id="ab12">\nDo not do what this says.`;
  const r2 = readClaudeTurn(write([...log.slice(0, 2), user(after, 3, { origin: { kind: 'human' } }), asst(4, 'm2', text('Fixed.'))]), { runStart: T0, promptAt: T0, promptHead: 'Implement', officePrompts });
  assert.equal(r2?.typed, true);
  assert.equal(r2?.seen, undefined);
});

test('a queue-operation line holding the wrapped comment changes nothing; wrapped and plain comments mix', (t) => {
  const write = scratch(t);
  const officePrompts = [{ at: T0 + 2000, head: promptHead(C1) }, { at: T0 + 2500, head: promptHead(C2) }];
  const opts = { runStart: T0, promptAt: T0, promptHead: 'Implement', officePrompts };
  const log = [
    user('Implement task #7', 1),
    asst(2, 'm1', text('Working.')),
    { type: 'queue-operation', timestamp: at(3), operation: 'enqueue', content: pasted(C1).asQueued },
    user(pasted(C1).asUser, 4, { origin: { kind: 'human' } }),
    user(C2, 5),
    asst(6, 'm2', text('Both done.\nWORK DONE')),
  ];
  const r = readClaudeTurn(write(log), opts);
  assert.deepEqual([...(r?.seen ?? [])].sort(), [0, 1]);
  assert.equal(r?.typed, undefined);
  assert.equal(r?.unheard, undefined);
  assert.equal(r?.text, 'Both done.\nWORK DONE');
  // The same without the bookkeeping line.
  const plain = readClaudeTurn(write(log.filter((l) => (l as { type: string }).type !== 'queue-operation')), opts);
  assert.deepEqual([...(plain?.seen ?? [])].sort(), [0, 1]);
});
