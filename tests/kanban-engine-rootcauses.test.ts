// Regressions of a second review of the engine: the verdict comes from the final answer only, a
// model or effort change takes effect on the next relaunch, worktrees are cut from the configured
// base branch (the primary repository's too) and the prompt says so, and the multi-PR panel's brief
// is a layered kanban prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Floor } from '../src/server/floor.js';
import { readClaudeTurn } from '../src/server/kanban/engine/adapters/claude.js';
import { readCodexTurn } from '../src/server/kanban/engine/adapters/codex.js';
import { planOutcome, prLines, reviewVerdict } from '../src/server/kanban/engine/markers.js';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { KANBAN_PROMPT_DEFS } from '../src/shared/kanban/prompts.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { MeetingRequest } from '../src/shared/protocol.js';
import { ADA, engineFixture, makeRepo, type Invocation } from './kanban-engine-fixture.js';
import { WHO, def, makeCtx } from './kanban-integrations-ctx.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const promptOf = (i: Invocation) => i.prompt ?? (i.args.includes('--') ? i.args[i.args.indexOf('--') + 1] : undefined);
/** A CLI start (not a typed turn) that has `flag value` among its arguments. */
const hasFlag = (i: Invocation, flag: string, value: string) => i.args.some((a, k) => a === flag && i.args[k + 1] === value);

// --- 1. The verdict comes from the final answer ------------------------------------------------------

test('the verdict: only a standalone line at the end of the final answer, never a quoted or fenced one', () => {
  // An approval quoted earlier, findings at the end: changes requested.
  assert.equal(reviewVerdict('The last round said:\n> REVIEW: APPROVED\n\nBut now:\n1. The redirect drops the query string.\n2. No test covers it.'), 'changes_requested');
  assert.equal(reviewVerdict('REVIEW: APPROVED\n\nFindings after all:\n1. a\n2. b\n3. c'), 'changes_requested', 'a verdict far above the end is none');
  // Inside a code fence or a quote, even at the very end, it is no verdict.
  assert.equal(reviewVerdict('Findings.\n```\nREVIEW: APPROVED\n```'), 'changes_requested');
  assert.equal(reviewVerdict('Findings.\n~~~text\nREVIEW: APPROVED\n~~~'), 'changes_requested');
  assert.equal(reviewVerdict('Findings.\n> REVIEW: APPROVED'), 'changes_requested');
  assert.equal(reviewVerdict('Findings.\n```\nunclosed\nREVIEW: APPROVED'), 'changes_requested', 'an unclosed fence runs to the end');
  // A proper final verdict still decides, after a fenced block and with a closing word after it.
  assert.equal(reviewVerdict('```\nREVIEW: CHANGES_REQUESTED\n```\nAll good.\n\nREVIEW: APPROVED'), 'approved');
  assert.equal(reviewVerdict('All good.\n**REVIEW: APPROVED**\nThanks.'), 'approved');
  assert.equal(reviewVerdict('Fix a.\nREVIEW: CHANGES_REQUESTED'), 'changes_requested');
  // The plan markers and PR lines follow the same rule.
  assert.equal(planOutcome('The contract says:\n> PLAN READY\n\nWhich API? Keep v1?'), 'questions');
  assert.equal(planOutcome('```\nQUESTIONS:\n```\nThe plan.\nPLAN READY'), 'ready');
  assert.deepEqual(prLines('Like this:\n```\nPR: https://github.com/acme/x/pull/1\n```\n> PR: https://github.com/acme/x/pull/2\nPR: https://github.com/acme/x/pull/3'), [
    // A code block can hold the PRs an agent opened; only a quote is somebody else's.
    { url: 'https://github.com/acme/x/pull/1', repo: 'acme/x', number: 1 },
    { url: 'https://github.com/acme/x/pull/3', repo: 'acme/x', number: 3 },
  ]);
});

test('the adapters hand back the final answer: an approval said on the way is not the verdict (Claude and Codex)', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-final-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, lines: unknown[]) => {
    const file = path.join(dir, name);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  const say = (id: string, content: unknown[]) => ({ type: 'assistant', message: { id, role: 'assistant', content } });
  const claude = write('claude.jsonl', [
    { type: 'user', message: { role: 'user', content: 'This is review round 1 of 2' } },
    say('m1', [{ type: 'text', text: 'The previous reviewer wrote:\nREVIEW: APPROVED' }]),
    say('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    say('m2', [{ type: 'text', text: 'Findings:' }]),
    say('m2', [{ type: 'text', text: '1. The redirect drops the query string.' }]),
  ]);
  const c = readClaudeTurn(claude)!;
  assert.equal(c.text, 'Findings:\n\n1. The redirect drops the query string.', "the last message's text blocks only");
  assert.equal(reviewVerdict(c.text), 'changes_requested');
  const okClaude = write('claude-ok.jsonl', [{ type: 'user', message: { role: 'user', content: 'Review' } }, say('m1', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't', name: 'Grep', input: {} }]), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '' }] } }, say('m2', [{ type: 'text', text: 'All good.\n\nREVIEW: APPROVED' }])]);
  assert.equal(reviewVerdict(readClaudeTurn(okClaude)!.text), 'approved');

  const user = { type: 'event_msg', payload: { type: 'user_message', message: 'Review' } };
  const msg = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  const done = (text: string) => ({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });
  const codex = write('codex.jsonl', [user, msg('Quoting the last round:\nREVIEW: APPROVED'), msg('1. Missing test.'), done('1. Missing test.')]);
  assert.equal(readCodexTurn(codex)!.text, '1. Missing test.');
  assert.equal(reviewVerdict(readCodexTurn(codex)!.text), 'changes_requested');
  const okCodex = write('codex-ok.jsonl', [user, msg('Reading.'), done('Fine.\nREVIEW: APPROVED')]);
  assert.equal(reviewVerdict(readCodexTurn(okCodex)!.text), 'approved');
});

for (const tool of ['claude', 'codex'] as const) {
  test(`${tool} review: an approval quoted in an earlier message with findings at the end goes to the fix phase`, async (t) => {
    const fx = await engineFixture();
    t.after(() => fx.close());
    fx.settings.setProject('proj', { review: { tool, rounds: 1 } });
    fx.setRules([
      { when: 'Implement kanban task', reply: 'Done.', commit: 'Work' },
      { when: 'This is review round 1 of', earlier: 'The last review said:\nREVIEW: APPROVED', reply: 'Findings:\n1. The redirect drops the query string.' },
      { when: 'asks for changes', reply: 'Fixed the query string.', commit: 'Fix' },
      { when: 'has worked on your findings', reply: 'Now it is right.\n\nREVIEW: APPROVED' },
    ]);
    const task = fx.newTask({ usePlan: false });
    assert.equal(await fx.engine.start(task.id, ADA), undefined);
    await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
    const runs = fx.repo.listRuns(task.id);
    assert.deepEqual(runs.map((r) => `${r.phase}/${r.verdict ?? '-'}`), ['implement/-', 'review/changes_requested', 'fix/-', 'review/approved']);
    const review = fx.repo.listComments(task.id).comments.find((c) => c.kind === 'review')!;
    assert.equal(review.text, 'Findings:\n1. The redirect drops the query string.', 'the comment is the final answer');
  });
}

test('claude: a Stop hook ahead of the final answer in the log waits for it, else takes the answer the hook carried (#310)', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.settings.setProject('proj', { review: { tool: 'claude', rounds: 1 } });
  fx.setRules([
    // The log catches up a moment after the Stop hook.
    { when: 'Implement kanban task', earlier: 'The after shots look sharp. Cleaning up last.', reply: 'The fog stays outside now.', commit: 'Work', lateLogMs: 200 },
    // The log never catches up: the Stop hook's last_assistant_message is the answer.
    { when: 'This is review round 1 of', earlier: 'Reading the diff.', reply: 'No findings.\n\nREVIEW: APPROVED', lateLogMs: -1 },
  ]);
  const task = fx.newTask({ usePlan: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 40_000);
  const runs = fx.repo.listRuns(task.id);
  assert.deepEqual(runs.map((r) => `${r.phase}/${r.verdict ?? '-'}`), ['implement/-', 'review/approved']);
  const comments = fx.repo.listComments(task.id).comments;
  assert.equal(comments.find((c) => c.kind === 'result')?.text, 'The fog stays outside now.', 'the result is the final answer, not what it said on the way');
  assert.equal(comments.find((c) => c.kind === 'review')?.text, 'No findings.\n\nREVIEW: APPROVED');
  assert.equal(runs[0].summary, 'The fog stays outside now.');
});

// --- 2. A model or effort change takes effect ------------------------------------------------------

test('plan waiting, the model and effort changed, approve: the relaunch runs on the new ones; same flags relaunch too', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  fx.setRules([
    { when: 'You are planning kanban task', reply: 'The plan.\n\nPLAN READY' },
    { when: 'Implement kanban task', reply: 'Implemented.', commit: 'Work' },
    { when: 'commented on task', reply: 'Handled.', commit: 'More' },
  ]);
  const task = fx.newTask({ model: 'sonnet', effort: 'low', planApproval: 'manual', useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const waiting = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'plan_approval', 'the plan waiting for approval');
  const starts = () => fx.invocations().filter((i) => i.kind === 'claude' && !i.prompt);
  assert.ok(hasFlag(starts()[0], '--model', 'sonnet') && hasFlag(starts()[0], '--effort', 'low'));
  // What kanban.task.update does while no run is live.
  fx.repo.updateTask(task.id, { model: 'opus', effort: 'high' });
  assert.equal(await fx.engine.approvePlan(task.id, ADA), undefined);
  const done = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.equal(done.workerId, waiting.workerId, 'the same worker, relaunched');
  const implement = starts()[1];
  assert.ok(implement.args.includes('--resume'), 'on the same session');
  assert.ok(hasFlag(implement, '--model', 'opus') && hasFlag(implement, '--effort', 'high'), `implement runs on opus/high: ${implement.args.join(' ')}`);
  assert.ok(!implement.args.includes('sonnet'));
  assert.equal(fx.workers.get(done.workerId!)?.model, 'opus', "the worker's info follows");
  assert.equal(fx.workers.get(done.workerId!)?.effort, 'high');

  // A resume has implement's flags; only the model changed, which still has it relaunched rather than typed.
  fx.repo.updateTask(task.id, { model: 'haiku' });
  const c = fx.repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text: 'One more thing.' }).comment;
  await fx.engine.commented(task.id, c.id, ADA);
  await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle' && fx.repo.listRuns(task.id).length === 3, 'the resume done');
  assert.equal(starts().length, 3, 'relaunched for the new model');
  assert.ok(hasFlag(starts()[2], '--model', 'haiku'));
  assert.equal(fx.workers.get(done.workerId!)?.model, 'haiku');
});

// --- 4. The configured base branch --------------------------------------------------------------

test('the configured base branch: the primary and another repository are cut from develop (origin first) with main checked out, and the prompt says so', async (t) => {
  const side = mkdtempSync(path.join(tmpdir(), 'kanban-base-'));
  t.after(() => rmSync(side, { recursive: true, force: true }));
  // The other repository has an origin whose develop is ahead of the local develop.
  const api = path.join(side, 'api');
  makeRepo(api);
  git(api, 'branch', 'develop');
  const origin = path.join(side, 'api-origin.git');
  git(side, 'init', '-q', '--bare', origin);
  git(api, 'remote', 'add', 'origin', origin);
  git(api, 'push', '-q', 'origin', 'main', 'develop');
  const other = path.join(side, 'api-other');
  git(side, 'clone', '-q', '-b', 'develop', origin, other);
  git(other, 'commit', '--allow-empty', '-q', '-m', 'On origin develop only');
  git(other, 'push', '-q', 'origin', 'develop');
  const originDevelop = git(other, 'rev-parse', 'HEAD');

  const fx = await engineFixture();
  t.after(() => fx.close());
  // The primary: develop has a commit main doesn't, and main is what's checked out.
  git(fx.dir, 'checkout', '-q', '-b', 'develop');
  git(fx.dir, 'commit', '--allow-empty', '-q', '-m', 'On develop');
  const develop = git(fx.dir, 'rev-parse', 'HEAD');
  git(fx.dir, 'checkout', '-q', 'main');
  fx.def.repos = [
    { id: 'proj', name: 'Proj', kind: 'git', dir: fx.dir, primary: true, baseBranch: 'develop' },
    { id: 'api', name: 'API', kind: 'git', dir: api, remote: 'acme/api', primary: false, baseBranch: 'develop' },
  ];
  fx.setRules([{ when: 'Implement kanban task', reply: 'Nothing to do.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column', 20_000);
  const ws = r.workspace!;
  assert.equal(ws.worktree.from, 'develop');
  assert.equal(ws.worktree.base, develop, 'the start point is kept on the workspace');
  assert.equal(git(path.join(fx.dir, ws.worktree.path), 'rev-parse', 'HEAD'), develop, 'the primary worktree is cut from develop, not main');
  assert.equal(ws.repos?.[0].from, 'develop');
  assert.equal(ws.repos?.[0].base, originDevelop, "origin's develop, fetched before the hire");
  assert.equal(git(path.join(fx.dir, ws.repos![0].path), 'rev-parse', 'HEAD'), originDevelop);
  const prompt = promptOf(fx.invocations().find((i) => i.kind === 'claude' && promptOf(i) && /Implement kanban task/.test(promptOf(i)!))!)!;
  assert.match(prompt, /`\.\/proj\/`: Proj \(acme\/proj\), on a fresh branch the office cut from `develop`/);
  assert.match(prompt, /`\.\/api\/`: API \(acme\/api\), on a fresh branch the office cut from `develop`/);
  assert.doesNotMatch(prompt, /cut from `main`/);

  // A base branch that isn't there fails the hire with a reason, rather than cutting from main.
  fx.def.repos = [{ id: 'proj', name: 'Proj', kind: 'git', dir: fx.dir, primary: true, baseBranch: 'release' }];
  const bad = fx.newTask({ usePlan: false, useReview: false });
  assert.match(String(await fx.engine.start(bad.id, ADA)), /The base branch release isn't in .*neither locally nor on origin/);
  const failed = await fx.waitTask(bad.id, (x) => x.status === 'waiting' && x.waitingReason === 'failed', 'the hire failing');
  assert.match(failed.waitingText ?? '', /base branch release isn't in/);
  assert.equal(fx.repo.listRuns(bad.id).at(-1)?.status, 'failed');
  assert.equal(failed.workerId, undefined);
  assert.equal(failed.workspace, undefined);
});

test('without a configured base branch the prompt names the branch the checkout is on', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  git(fx.dir, 'checkout', '-q', '-b', 'trunk');
  fx.setRules([{ when: 'Implement kanban task', reply: 'Nothing to do.' }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  await fx.engine.start(task.id, ADA);
  const r = await fx.waitTask(task.id, (x) => x.status === 'review' && x.runState === 'idle', 'the review column');
  assert.equal(r.workspace?.worktree.from, 'trunk', "upstream's rule, unchanged");
  const prompt = promptOf(fx.invocations().find((i) => i.kind === 'claude' && promptOf(i) && /Implement kanban task/.test(promptOf(i)!))!)!;
  assert.match(prompt, /on a fresh branch the office cut from `trunk`/);
});

// --- 5. The multi-PR panel's brief is a layered prompt ---------------------------------------------

test('🤝 the multi-PR panel brief is the kanban.pr.panel prompt: an office rewrite, then a project override, is what the meeting gets', async () => {
  const d = KANBAN_PROMPT_DEFS['kanban.pr.panel'];
  assert.equal(PROMPTS['kanban.pr.panel'].group, 'kanban', 'in the office prompt editor');
  for (const v of ['prs', 'project', 'task', 'posted', 'postedRepo']) assert.ok(v in d.vars, v);

  const ctx = makeCtx();
  const base = path.join(ctx.tmp, 'repos');
  const web = path.join(base, 'web');
  const api = path.join(base, 'api');
  for (const x of [web, api]) mkdirSync(path.join(x, '.git'), { recursive: true });
  const pc = makeCtx([def('web', web, { repo: 'o/web', repos: [{ id: 'web', name: 'web', kind: 'git', dir: web, remote: 'o/web', primary: true }, { id: 'api', name: 'api', kind: 'git', dir: api, remote: 'o/api', primary: false }] })]);
  const pull = (number: number, headRefName: string, title: string) => ({ number, title, url: `https://github.com/x/y/pull/${number}`, state: 'OPEN', isDraft: false, headRefName });
  const lists: Record<string, unknown[]> = { 'o/web': [pull(10, 'feat/login', 'Login')], 'o/api': [pull(3, 'feat/login', 'Login API')] };
  const started: MeetingRequest[] = [];
  pc.floors.set('web', {
    githubFor: (repo?: string) => ({ pulls: { items: lists[repo ?? 'o/web'], fetchedAt: 1, loading: false } }),
    project: { agentProviders: ['claude'] },
    meetings: { start: (req: MeetingRequest) => void started.push(req) },
  } as unknown as Floor);
  let office: Record<string, { text: string }> = {};
  pc.officePrompts = () => office;
  const parts = createPullsParts(pc, { gh: async () => Promise.reject(new Error('gh not needed')) });
  const call = () => parts.api.panel!({ project: 'web', prs: [{ repo: 'o/api', number: 3 }, { repo: 'o/web', number: 10 }] }, WHO);

  assert.equal(await call(), undefined);
  assert.match(started[0].prompt, /^Review these pull requests in the project web together/, 'the default');
  office = { 'kanban.pr.panel': { text: 'Office brief for {{project}}: {{prs}}\nPosted on {{postedRepo}}#{{posted}}.' } };
  assert.equal(await call(), undefined);
  assert.equal(started[1].prompt, 'Office brief for web: - o/api#3 “Login API” (branch feat/login) https://github.com/x/y/pull/3\n- o/web#10 “Login” (branch feat/login) https://github.com/x/y/pull/10\nPosted on o/web#10.');
  pc.settings.setProject('web', { prompts: { 'kanban.pr.panel': 'Project brief: {{prs}}' } });
  assert.equal(await call(), undefined);
  assert.match(started[2].prompt, /^Project brief: - o\/api#3/);
});
