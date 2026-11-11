// The ✨ New task form's message, without the DOM (src/client/kanban/createmsg.ts): a task titled by its
// first line, or one made from the issue picked with Select issue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownTitle, newTaskMsg, reviewOverride, reviewStart, type NewTaskFields, type ReviewForm } from '../src/client/kanban/createmsg.js';

const fields = (f: Partial<NewTaskFields> = {}): NewTaskFields => ({
  project: 'api',
  description: 'Fix the login\n\nIt loops on Safari.',
  ticket: '',
  ticketUrl: '',
  rest: { repoIds: null, type: 'implement', usePlan: true, useReview: false },
  ...f,
});

test('the new-task messages carry once when given and are unchanged without it', () => {
  const plain = newTaskMsg(fields(), null);
  const keyed = newTaskMsg(fields({ once: 'try-1-abcdefgh' }), null);
  assert.ok('msg' in plain && 'msg' in keyed);
  assert.equal('once' in plain.msg, false);
  assert.deepEqual(keyed.msg, { ...plain.msg, once: 'try-1-abcdefgh' });
  const issue = newTaskMsg(fields({ ticket: 'gh:o/r#1', once: 'try-1-abcdefgh' }), { key: 'gh:o/r#1' });
  assert.ok('msg' in issue && issue.msg.t === 'kanban.issues.createTask');
  assert.equal(issue.msg.once, 'try-1-abcdefgh');
  const issuePlain = newTaskMsg(fields({ ticket: 'gh:o/r#1' }), { key: 'gh:o/r#1' });
  assert.ok('msg' in issuePlain);
  assert.equal('once' in issuePlain.msg, false);
});

test('a new task without an issue: kanban.task.create, titled by the first line', () => {
  const made = newTaskMsg(fields(), null);
  assert.ok('msg' in made);
  assert.deepEqual(made.msg, {
    t: 'kanban.task.create',
    task: { project: 'api', title: 'Fix the login', repoIds: null, type: 'implement', usePlan: true, useReview: false, description: 'Fix the login\n\nIt loops on Safari.' },
  });
  const started = newTaskMsg(fields({ start: true, ticket: ' UYT-9 ', ticketUrl: ' https://example.test/9 ' }), undefined);
  assert.ok('msg' in started && started.msg.t === 'kanban.task.create');
  assert.equal(started.msg.start, true);
  assert.equal(started.msg.task.ticket, 'UYT-9');
  assert.equal(started.msg.task.ticketUrl, 'https://example.test/9');
  // A long first line is cut like a hire's.
  const long = newTaskMsg(fields({ description: 'x'.repeat(400) }), null);
  assert.ok('msg' in long && long.msg.t === 'kanban.task.create');
  assert.equal(long.msg.task.title.length, 120);
});

test('a new task with nothing written is turned down', () => {
  assert.deepEqual(newTaskMsg(fields({ description: '  \n\n ' }), null), { error: 'Say what the task is: its first line is the title' });
  // A ticket alone names nothing.
  assert.ok('error' in newTaskMsg(fields({ description: '', ticket: 'UYT-9' }), null));
});

test('a new task with an issue picked: kanban.issues.createTask, no title of its own', () => {
  const picked = { key: 'gh:acme/api#5' };
  const made = newTaskMsg(fields({ ticket: 'gh:acme/api#5', ticketUrl: 'https://github.com/acme/api/issues/5', start: true }), picked);
  assert.ok('msg' in made);
  assert.deepEqual(made.msg, {
    t: 'kanban.issues.createTask',
    project: 'api',
    issueKey: 'gh:acme/api#5',
    start: true,
    task: { repoIds: null, type: 'implement', usePlan: true, useReview: false, description: 'Fix the login\n\nIt loops on Safari.' },
  });
  // Nothing written is fine: the issue's text is the description.
  const bare = newTaskMsg(fields({ description: ' ', ticket: 'gh:acme/api#5' }), picked);
  assert.ok('msg' in bare && bare.msg.t === 'kanban.issues.createTask');
  assert.deepEqual(bare.msg.task, { repoIds: null, type: 'implement', usePlan: true, useReview: false });
  assert.equal('start' in bare.msg, false);
});

test('a ticket typed over the picked one makes a plain task with the typed ticket', () => {
  const made = newTaskMsg(fields({ ticket: 'UYT-77', ticketUrl: 'https://github.com/acme/api/issues/5' }), { key: 'gh:acme/api#5' });
  assert.ok('msg' in made && made.msg.t === 'kanban.task.create');
  assert.equal(made.msg.task.ticket, 'UYT-77');
  assert.equal(made.msg.task.title, 'Fix the login');
  // Emptied by hand: no ticket at all.
  const none = newTaskMsg(fields({ ticket: '' }), { key: 'gh:acme/api#5' });
  assert.ok('msg' in none && none.msg.t === 'kanban.task.create');
  assert.equal('ticket' in none.msg.task, false);
});

test('markdownTitle skips the lines that are only an image or a file link', () => {
  assert.equal(markdownTitle('![shot.png](/api/kanban/attachments/a1)\n\n[log.txt](/api/kanban/attachments/b2)\nThe login loops\nmore'), 'The login loops');
  assert.equal(markdownTitle('  \n# Fix the login\nbody'), '# Fix the login');
  // A link inside a sentence is part of what it says.
  assert.equal(markdownTitle('See [the log](/x) first'), 'See [the log](/x) first');
  // Nothing but attachments: the first of them names it.
  assert.equal(markdownTitle('![shot.png](/a1)\n[log.txt](/b2)'), '![shot.png](/a1)');
  assert.equal(markdownTitle(''), '');
});

const review = (o: Partial<ReviewForm> = {}): ReviewForm => ({ useReview: true, choose: false, rounds: 2, baseRounds: 2, tool: 'claude', model: '', effort: '', reReviewLastFix: false, ...o });

test('the project’s number of review rounds with no reviewer chosen is no override: the message is as it was', () => {
  assert.equal(reviewOverride(review()), undefined);
  assert.equal(reviewOverride(review({ useReview: false, rounds: 5, choose: true })), undefined, 'no review rounds, nothing of its own');
  // Sent as create.ts does: the override goes into the message only when there is one.
  const rv = reviewOverride(review());
  const made = newTaskMsg(fields({ rest: { repoIds: null, type: 'implement', usePlan: true, useReview: true, ...(rv ? { review: rv } : {}) } }), null);
  assert.ok('msg' in made && made.msg.t === 'kanban.task.create');
  assert.deepEqual(made.msg.task, { project: 'api', title: 'Fix the login', repoIds: null, type: 'implement', usePlan: true, useReview: true, description: fields().description });
  // Another number alone is the task's own rounds; a chosen reviewer carries everything.
  assert.deepEqual(reviewOverride(review({ rounds: 4 })), { rounds: 4 });
  assert.deepEqual(reviewOverride(review({ choose: true, tool: 'codex', model: ' gpt-5 ', effort: 'high', reReviewLastFix: true })), { tool: 'codex', rounds: 2, reReviewLastFix: true, model: 'gpt-5', effort: 'high' });
});

test('editing a task shows its stored rounds, and saving it unchanged changes nothing', () => {
  assert.deepEqual(reviewStart({ rounds: 5 }, 2), { rounds: 5, choose: false, ownRounds: true });
  assert.deepEqual(reviewStart(undefined, 2), { rounds: 2, choose: false, ownRounds: false });
  assert.deepEqual(reviewStart({ tool: 'codex', rounds: 3, reReviewLastFix: false }, 2), { rounds: 3, choose: true, ownRounds: true });
  // What the form then sends is what was stored.
  const stored = { rounds: 5 };
  const start = reviewStart(stored, 2);
  assert.deepEqual(reviewOverride(review({ rounds: start.rounds, choose: start.choose })), stored);
});
