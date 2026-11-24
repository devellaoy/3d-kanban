import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dateInputValue, dayStartMs, holdPassed } from '../src/client/kanban/holdtime.js';
import { commentNote, resumeTarget, resumeTitle, sendTitle } from '../src/client/kanban/holdwords.js';
import { checkMove } from '../src/shared/kanban/moves.js';
import { TASK_STATUSES } from '../src/shared/kanban/types.js';

test('dayStartMs: the start of the local day a date input names', () => {
  const ms = dayStartMs('2026-11-15');
  assert.ok(ms !== undefined);
  const d = new Date(ms);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 15, 0, 0]);
});

test('dayStartMs: empty, malformed and impossible dates are nothing', () => {
  for (const v of ['', 'tomorrow', '2026-1-5', '2026-02-31', '2026-13-01']) assert.equal(dayStartMs(v), undefined, v);
});

test('dateInputValue and dayStartMs round-trip', () => {
  assert.equal(dateInputValue(dayStartMs('2027-03-09')!), '2027-03-09');
  assert.equal(dateInputValue(new Date(2026, 0, 5, 18, 30).getTime()), '2026-01-05');
});

test('holdPassed: only once the day has begun to be behind us', () => {
  const day = dayStartMs('2026-11-15')!;
  assert.equal(holdPassed(undefined, day), false);
  assert.equal(holdPassed(day, day), false);
  assert.equal(holdPassed(day, day + 1), true);
});

// --- Resume and a comment on a held task (holdwords.ts) ------------------------------------------------

const hold = (from: 'waiting' | 'review') => ({ at: 1, by: 'Ada', from });

test('Resume goes to the column the task was held from, a move the server takes as only a change of state', () => {
  for (const from of ['waiting', 'review'] as const) {
    const to = resumeTarget({ hold: hold(from) });
    assert.equal(to, from);
    assert.deepEqual(checkMove({ status: 'on_hold', runState: 'idle', heldFrom: from }, to), { ok: true, action: 'unhold' });
  }
  assert.equal(resumeTarget({}), 'waiting', 'a hold that names no column is one from Waiting');
  // Never to In progress: that move is refused for a held task.
  assert.equal(checkMove({ status: 'on_hold', runState: 'idle', heldFrom: 'waiting' }, 'in_progress').ok, false);
});

test('Resume says where the task goes and that nothing starts', () => {
  assert.equal(resumeTitle({ hold: hold('waiting') }), 'Take it off hold: it goes back to Waiting, nothing starts');
  assert.equal(resumeTitle({ hold: hold('review') }), 'Take it off hold: it goes back to Review, nothing starts');
  assert.equal(resumeTitle({}), 'Take it off hold: it goes back to Waiting, nothing starts');
});

test('a comment on a held task is said to take it off hold and start the agent, never to be kept for a resume', () => {
  const title = sendTitle({ status: 'on_hold', runState: 'idle' });
  assert.match(title, /comes off hold/);
  assert.match(title, /agent goes back to work/);
  assert.equal(commentNote('on_hold'), 'a comment takes it off hold and starts the agent');
  for (const text of [title, commentNote('on_hold')]) assert.doesNotMatch(text, /kept|resume/i);
  // The other states say what they did before.
  assert.equal(commentNote('todo'), 'a comment is kept with the task');
  assert.equal(commentNote('done'), 'a comment is kept with the task');
  for (const status of ['in_progress', 'waiting', 'review'] as const) assert.equal(commentNote(status), 'a comment puts the agent back to work');
  for (const status of ['todo', 'done', 'archived'] as const) assert.match(sendTitle({ status, runState: 'idle' }), /no agent starts/);
  assert.match(sendTitle({ status: 'in_progress', runState: 'running' }), /in its terminal now/);
  assert.equal(sendTitle({ status: 'waiting', runState: 'idle' }), 'Add the comment: the agent takes it and goes back to work');
  for (const status of TASK_STATUSES) assert.ok(sendTitle({ status, runState: 'idle' }).startsWith('Add the comment'), status);
});

test('Resume has no dialog: the button and a move off hold send the move as it is, and only a move to On hold asks first', () => {
  const read = (f: string) => readFileSync(path.join('src', 'client', 'kanban', f), 'utf8');
  const bar = read('taskactionbar.ts');
  const resume = bar.slice(bar.indexOf("case 'resume':"), bar.indexOf("case 'hold':"));
  assert.match(resume, /resumeTarget\(task\)/);
  assert.match(resume, /move\(to, b/);
  assert.doesNotMatch(resume, /Dialog|in_progress|note/);
  const dialog = read('holddialog.ts');
  assert.doesNotMatch(dialog, /openResumeDialog|in_progress|A message for the agent/);
  const flow = dialog.slice(dialog.indexOf('export function moveWithDialog'));
  assert.match(flow, /if \(to === 'on_hold'\) return openHoldDialog/);
  assert.equal(flow.match(/open\w+Dialog/g)?.length, 1, 'one dialog, for a move to On hold');
  assert.doesNotMatch(read('holddialog.css'), /kb-hold-since/);
});
