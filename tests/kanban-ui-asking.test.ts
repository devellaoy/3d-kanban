// A task whose agent asked something, as the task view and the card show it (client/kanban/asking.ts):
// a question in a live terminal, a live permission prompt, and a question whose run is over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { askingLive, askingView } from '../src/client/kanban/asking.js';

const RUNNING = [{ status: 'succeeded' }, { status: 'running' }] as const;
const OVER = [{ status: 'succeeded' }, { status: 'stopped' }] as const;
const TERMINAL = /terminal/i;

test('a question whose run is over (held while asking and resumed, or an office restart): an answer box, and nothing sends you to a terminal', () => {
  // What Resume leaves of a task held while its agent was asking: no live run, no worker, no askingKind.
  for (const runs of [OVER, [{ status: 'interrupted' }] as const, [] as const, undefined]) {
    const v = askingView({ phase: 'implement' }, runs);
    assert.equal(v.live, false);
    assert.equal(v.answerBox, true, 'the answer box is there');
    assert.equal(v.terminalOf, undefined, 'no Open the terminal');
    assert.equal(v.instruction, undefined, 'no "answer it in its terminal"');
    for (const text of [v.title, v.note, v.sendTitle]) assert.doesNotMatch(text, TERMINAL);
    assert.match(v.note, /starts the agent again/);
    assert.match(v.sendTitle, /starts again/);
  }
});

test('a run that is over decides, whatever is left of the worker or of what it asked', () => {
  // After an office restart the worker may still sit at its desk with its agent ended; a turn that ended on a question keeps askingKind.
  for (const askingKind of [undefined, 'question', 'permission'] as const) {
    const v = askingView({ phase: 'implement', workerId: 'w1', askingKind }, OVER);
    assert.deepEqual([v.live, v.answerBox, v.terminalOf, v.instruction], [false, true, undefined, undefined], String(askingKind));
  }
});

test('a question in a live terminal: the answer box, typed into its terminal, with the way to the terminal', () => {
  const v = askingView({ phase: 'implement', workerId: 'w1', reviewerWorkerId: 'r1', askingKind: 'question' }, RUNNING);
  assert.deepEqual([v.live, v.answerBox, v.terminalOf, v.instruction], [true, true, 'w1', undefined]);
  assert.equal(v.title, 'The agent is asking in its terminal');
  assert.equal(v.note, 'Your answer is typed into its terminal, as if you typed it there.');
  assert.match(v.sendTitle, /Type your answer into the agent’s terminal/);
  // The reviewer is the one asking during a review round.
  for (const phase of ['review', 'pr-review'] as const) assert.equal(askingView({ phase, workerId: 'w1', reviewerWorkerId: 'r1', askingKind: 'question' }, RUNNING).terminalOf, 'r1');
});

test('a live permission prompt, or one the office can’t tell, still goes to the terminal: no answer box', () => {
  const permission = askingView({ phase: 'implement', workerId: 'w1', askingKind: 'permission' }, RUNNING);
  assert.deepEqual([permission.live, permission.answerBox, permission.terminalOf], [true, false, 'w1']);
  assert.equal(permission.instruction, 'The agent asks for a permission: answer it in its terminal.');
  const unknown = askingView({ phase: 'implement', workerId: 'w1' }, RUNNING);
  assert.deepEqual([unknown.live, unknown.answerBox, unknown.terminalOf], [true, false, 'w1']);
  assert.equal(unknown.instruction, 'The agent waits on something in its terminal: answer it there.');
  for (const v of [permission, unknown]) assert.equal(v.note, 'A comment waits until that turn is over.');
});

test('a card has no runs: a hired worker for the asking role stands for a live run', () => {
  assert.equal(askingLive({ phase: 'implement', workerId: 'w1' }), true);
  assert.equal(askingLive({ phase: 'implement' }), false);
  assert.equal(askingLive({ phase: 'review', workerId: 'w1' }), false, 'the reviewer asks in a review round');
  assert.equal(askingLive({ phase: 'review', reviewerWorkerId: 'r1' }), true);
  assert.equal(askingView({ phase: 'implement' }).title, 'The agent asked a question');
  assert.equal(askingView({ phase: 'implement', workerId: 'w1' }).title, 'The agent is asking in its terminal');
});

test('the waiting banner and the card draw an asking task from asking.ts, the banner with the task’s runs', () => {
  const read = (f: string) => readFileSync(path.join('src', 'client', 'kanban', f), 'utf8');
  const banner = read('taskwaiting.ts');
  assert.match(banner, /askingView\(task, c\.detail\?\.runs\)/);
  assert.match(banner, /const inTerminal = !!asking && !asking\.answerBox;/);
  assert.match(banner, /const workerId = asking\?\.terminalOf;/);
  assert.doesNotMatch(banner, /askingKind|in its terminal/, 'what an asking task says is decided in asking.ts only');
  assert.match(read('card.ts'), /askingView\(c\)\.title/);
});
