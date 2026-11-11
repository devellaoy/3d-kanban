// The ✨ New task form's message, without the DOM (src/client/kanban/createmsg.ts): a task titled by its
// first line, or one made from the issue picked with 🔗 Select issue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownTitle, newTaskMsg, type NewTaskFields } from '../src/client/kanban/createmsg.js';

const fields = (f: Partial<NewTaskFields> = {}): NewTaskFields => ({
  project: 'api',
  description: 'Fix the login\n\nIt loops on Safari.',
  ticket: '',
  ticketUrl: '',
  rest: { repoIds: null, type: 'implement', usePlan: true, useReview: false },
  ...f,
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
