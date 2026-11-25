import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { KanbanRepository, type NewComment, type NewRun } from '../src/server/kanban/db/repository.js';
import { taskConversation } from '../src/server/kanban/conversation.js';
import { conversationFilePath, planFilePath, syncConversationFile, syncPlanFile } from '../src/server/kanban/taskfiles.js';
import { grantDir } from '../src/server/kanban/uploads.js';

const T0 = Date.UTC(2026, 0, 5, 9, 30);
const MIN = 60_000;

function setup(t: { after(fn: () => void): void }) {
  const db = openKanbanDb(':memory:');
  t.after(() => db.close());
  const repo = new KanbanRepository(db);
  const task = repo.createTask({ project: 'web', title: 'T', tool: 'claude', usePlan: true, planApproval: 'manual', useReview: true, createdBy: 'Ada' });
  let clock = T0;
  const tick = () => (clock += MIN);
  const user = (text: string, o: Partial<NewComment> = {}) => repo.addComment({ taskId: task.id, authorKind: 'user', authorName: 'Ada', text, createdAt: tick(), ...o }).comment;
  const agent = (kind: NewComment['kind'], text: string, o: Partial<NewComment> = {}) => repo.addComment({ taskId: task.id, authorKind: 'agent', authorName: 'Bot', kind, text, createdAt: tick(), ...o }).comment;
  const run = (o: Partial<NewRun> & Pick<NewRun, 'phase'>, verdict?: 'approved' | 'changes_requested') => {
    const r = repo.createRun({ taskId: task.id, tool: 'claude', ...o });
    return verdict ? repo.finishRun(r.id, { status: 'done', verdict })! : r;
  };
  const conv = () => taskConversation({ repo }, task.id, (c) => c.text);
  return { repo, task, user, agent, run, conv, tick };
}

test('only user messages and review findings count; nothing else makes a conversation', (t) => {
  const s = setup(t);
  s.agent('result', 'done', { runId: s.run({ phase: 'implement' }).id });
  s.agent('status', 'working');
  assert.equal(s.conv(), undefined);
});

test('a user message gets a dated heading with its author; the preceding result is included once', (t) => {
  const s = setup(t);
  const impl = s.run({ phase: 'implement' });
  s.agent('status', 'working');
  s.agent('result', 'All done.', { runId: impl.id });
  s.agent('status', 'idle');
  s.user('Please change X');
  s.user('And Y');
  const md = s.conv()!.markdown();
  assert.match(md, /^# Conversation of task #1\n/);
  assert.match(md, /## 2026-01-05 09:32 UTC — What the agent had said or asked \(Bot\)\n\n> All done\./);
  assert.match(md, /## 2026-01-05 09:34 UTC — Ada\n\n> Please change X/);
  assert.equal(md.match(/All done\./g)!.length, 1);
  assert.ok(!md.includes('working'));
  assert.ok(md.indexOf('All done.') < md.indexOf('Please change X') && md.indexOf('Please change X') < md.indexOf('And Y'));
});

test('a question before a user message is included; plan, message and pr-review comments and system rows are not', (t) => {
  const s = setup(t);
  s.agent('plan', 'PLAN TEXT');
  s.agent('message', 'UNFINISHED');
  s.agent('review', 'PR REVIEW', { runId: s.run({ phase: 'pr-review', round: 1 }, 'approved').id });
  s.repo.addComment({ taskId: s.task.id, authorKind: 'system', authorName: 'Kanban', text: 'SYSTEM', createdAt: s.tick() });
  s.agent('questions', 'Which one?');
  s.user('The first');
  const md = s.conv()!.markdown();
  assert.match(md, /Which one\?/);
  for (const no of ['PLAN TEXT', 'UNFINISHED', 'PR REVIEW', 'SYSTEM']) assert.ok(!md.includes(no), no);
});

test('qualifiers: plan draft waiting, terminal answer, queued', (t) => {
  const s = setup(t);
  s.user('before any plan');
  const p1 = s.repo.addPlan(s.task.id, 'p1', undefined, s.tick());
  s.user('while draft one waits');
  s.repo.addPlan(s.task.id, 'p2', undefined, s.tick());
  s.repo.acceptPlan(s.task.id, 'Ada', undefined, s.tick());
  s.user('after acceptance');
  s.user('typed in terminal', { runId: s.run({ phase: 'implement' }).id });
  const r = s.run({ phase: 'implement' });
  s.agent('questions', 'asked?', { runId: r.id });
  s.user('answer in recorded question', { runId: r.id });
  s.user('later one', { pending: true });
  assert.ok(p1);
  const md = s.conv()!.markdown();
  const head = (text: string) => md.split('\n').find((l, i, a) => a[i + 2] === `> ${text}`)!;
  assert.doesNotMatch(head('before any plan'), /plan draft/);
  assert.match(head('while draft one waits'), /said while plan draft v1 waited for approval/);
  assert.doesNotMatch(head('after acceptance'), /plan draft/);
  assert.match(head('typed in terminal'), /typed as an answer in the agent's terminal; the question was not recorded/);
  assert.doesNotMatch(head('answer in recorded question'), /terminal/);
  assert.match(head('later one'), /queued: the implementer has not been given this yet/);
});

test('a draft that is still the latest waits "forever"', (t) => {
  const s = setup(t);
  s.repo.addPlan(s.task.id, 'p1', undefined, s.tick());
  s.user('still waiting');
  assert.match(s.conv()!.markdown(), /plan draft v1 waited/);
});

test('review cycles are numbered across two cycles; fix and resume replies are headed', (t) => {
  const s = setup(t);
  const rev = (round: number | undefined, v?: 'approved' | 'changes_requested') => s.agent('review', `finding ${round}`, { runId: s.run({ phase: 'review', round }, v).id });
  rev(1, 'changes_requested');
  s.agent('result', 'fixed 1', { runId: s.run({ phase: 'fix', round: 1 }).id });
  rev(2, 'approved');
  rev(1, 'changes_requested');
  s.agent('result', 'fixed again', { runId: s.run({ phase: 'fix', round: 1 }).id });
  rev(2);
  s.user('one more thing');
  s.agent('result', 'resumed reply', { runId: s.run({ phase: 'resume' }).id });
  const md = s.conv()!.markdown();
  const order = ['Review cycle 1, round 1: CHANGES_REQUESTED', "Implementer's reply to review cycle 1, round 1", 'Review cycle 1, round 2: APPROVED', 'Review cycle 2, round 1: CHANGES_REQUESTED', "Implementer's reply to review cycle 2, round 1", 'Review cycle 2, round 2\n', "Ada\n\n> one more thing", "Implementer's reply to the user's message"];
  let at = -1;
  for (const h of order) {
    const i = md.indexOf(h);
    assert.ok(i > at, h);
    at = i;
  }
});

test('co-reviewer seats and pr-review runs are left out; a review comment with no run is skipped', (t) => {
  const s = setup(t);
  s.agent('review', 'SEAT', { runId: s.run({ phase: 'review', round: 1, seat: 2 }, 'approved').id });
  s.agent('review', 'ORPHAN');
  assert.equal(s.conv(), undefined);
  s.agent('review', 'MAIN', { runId: s.run({ phase: 'review', round: 1 }, 'approved').id });
  const md = s.conv()!.markdown();
  assert.ok(md.includes('MAIN') && !md.includes('SEAT') && !md.includes('ORPHAN'));
});

test('more than 500 comments are all included', (t) => {
  const s = setup(t);
  for (let i = 0; i < 1203; i++) s.user(`msg-${i}.`);
  const md = s.conv()!.markdown(10_000_000);
  assert.equal(md.match(/msg-\d+\./g)!.length, 1203);
  assert.ok(md.indexOf('msg-0.') < md.indexOf('msg-1202.'));
});

test('over budget the oldest agent texts are shortened, user messages never, under budget nothing', (t) => {
  const s = setup(t);
  const user = 'U'.repeat(3000);
  for (let i = 0; i < 4; i++) {
    s.agent('review', `${String(i).repeat(5000)}`, { runId: s.run({ phase: 'review', round: i + 1 }, 'changes_requested').id });
    s.user(user);
  }
  const c = s.conv()!;
  const full = c.markdown(10_000_000);
  assert.ok(!full.includes('cut here') && !full.includes('shortened'));
  assert.equal(c.markdown(full.length), full);
  const budget = full.length - 6500;
  const md = c.markdown(budget);
  assert.equal(md.match(/U{3000}/g)!.length, 4);
  const cuts = md.match(/\(cut here: 3500 more characters\)/g)!.length;
  assert.equal(cuts, 2);
  assert.match(md, new RegExp(`${cuts} older agent entries are shortened in this file; each says where it is cut\\.`));
  assert.ok(md.includes('0'.repeat(1500)) && !md.includes('0'.repeat(1501)));
  assert.ok(md.includes('3'.repeat(5000)), 'the newest agent text is whole');
  assert.ok(md.length <= budget);
  // User text alone over the budget: nothing more is cut.
  assert.equal(c.markdown(1).match(/U{3000}/g)!.length, 4);
});

test('tail keeps the newest entries and says how many were left out', (t) => {
  const s = setup(t);
  for (let i = 0; i < 10; i++) s.user(`message number ${i} ${'x'.repeat(100)}`);
  const c = s.conv()!;
  assert.equal(c.tail(1_000_000).startsWith('(') , false);
  const out = c.tail(1000);
  assert.ok(out.length <= 1000);
  assert.match(out, /^\((\d+) older entries left out\)\n/);
  const left = Number(out.match(/^\((\d+)/)![1]);
  assert.ok(left > 0 && left < 10);
  assert.ok(out.includes('message number 9 ') && !out.includes('message number 0 '));
  assert.equal(out.match(/message number/g)!.length, 10 - left);
});

function files(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kanban-taskfiles-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('task files are written read-only in the grant folder, not rewritten when identical, removed with no text', (t) => {
  const root = files(t);
  const plan = syncPlanFile(root, 7, 'The plan');
  assert.equal(plan, path.join(grantDir(root, 7), 'accepted-plan.md'));
  assert.equal(plan, planFilePath(root, 7));
  assert.equal(readFileSync(plan!, 'utf8'), 'The plan\n');
  if (process.platform !== 'win32') assert.equal(statSync(plan!).mode & 0o777, 0o444);
  const conv = syncConversationFile(root, 7, '# C');
  assert.equal(conv, conversationFilePath(root, 7));
  const ino = statSync(plan!).ino;
  assert.equal(syncPlanFile(root, 7, 'The plan'), plan);
  assert.equal(statSync(plan!).ino, ino);
  assert.equal(syncPlanFile(root, 7, 'Changed'), plan);
  assert.equal(readFileSync(plan!, 'utf8'), 'Changed\n');
  assert.equal(syncPlanFile(root, 7, undefined), undefined);
  assert.ok(!existsSync(plan!) && existsSync(conv!));
  assert.equal(syncConversationFile(root, 7, ''), undefined);
  assert.ok(!existsSync(conv!));
});

test('no text and no folder: nothing is made', (t) => {
  const root = files(t);
  assert.equal(syncPlanFile(root, 9, undefined), undefined);
  assert.ok(!existsSync(grantDir(root, 9)));
});

test('a failed write does not throw and returns undefined', (t) => {
  const root = files(t);
  mkdirSync(planFilePath(root, 3), { recursive: true });
  assert.equal(syncPlanFile(root, 3, 'text'), undefined);
  assert.equal(syncConversationFile(root, 3, 'text') !== undefined, true);
});

test('bodies are quoted: a heading-like line in a text is not a heading', (t) => {
  const s = setup(t);
  s.agent('review', 'finding', { runId: s.run({ phase: 'review', round: 1 }, 'changes_requested').id });
  s.agent('result', 'fixed\n\n## 2026-01-05 09:40 UTC — Ada\nfake', { runId: s.run({ phase: 'fix', round: 1 }).id });
  s.user('pasted\n## Another');
  const md = s.conv()!.markdown();
  const headings = md.split('\n').filter((l) => l.startsWith('## '));
  assert.equal(headings.length, 3);
  assert.match(md, /\n> ## 2026-01-05 09:40 UTC — Ada\n> fake\n/);
  assert.match(md, /\n>\n/);
});

test('an accepted plan is marked, but markers alone make no conversation', (t) => {
  const s = setup(t);
  s.repo.addPlan(s.task.id, 'p1', undefined, s.tick());
  s.repo.acceptPlan(s.task.id, 'Ada', undefined, s.tick());
  assert.equal(s.conv(), undefined);
  s.user('later');
  const md = s.conv()!.markdown();
  assert.match(md, /## 2026-01-05 09:32 UTC — Plan v1 accepted by Ada\n/);
  assert.ok(md.indexOf('Plan v1 accepted') < md.indexOf('later'));
  assert.ok(s.conv()!.tail(100_000).includes('Plan v1 accepted'));
});

test('a terminal answer gets no preceding agent text attached', (t) => {
  const s = setup(t);
  const r = s.run({ phase: 'implement' });
  s.agent('result', 'STALE RESULT', { runId: r.id });
  s.user('typed', { runId: r.id });
  assert.ok(!s.conv()!.markdown().includes('STALE RESULT'));
});

test('a body is only shortened when that saves something; a throwing userText falls back to the raw text', (t) => {
  const s = setup(t);
  const body = 'z'.repeat(1600);
  s.agent('review', body, { runId: s.run({ phase: 'review', round: 1 }, 'approved').id });
  s.user('raw text');
  const md = s.conv()!.markdown(1);
  assert.ok(md.includes(body) && !md.includes('cut here'));
  const c = taskConversation({ repo: s.repo }, s.task.id, () => {
    throw new Error('no folder');
  })!;
  assert.match(c.markdown(), /> raw text/);
});
