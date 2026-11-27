// "Write with AI" on a project's instructions, without the DOM (src/client/kanban/instructionsdraftmodel.ts):
// what is asked, which answer still counts, what a failure says and what the review window says.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DraftRuns, INSTRUCTIONS_ANSWER_MS, cancelRequest, clipToField, draftFailure, draftRequest, reviewLead, reviewMode, reviewTitle, closesSettingsToo, KeptTexts } from '../src/client/kanban/instructionsdraftmodel.js';
import { KanbanError } from '../src/client/kanban/api.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';

test('the request carries the field and its text, and the browser waits past the office’s five minutes', () => {
  const ask = draftRequest('web', 'prReview', 'Start the API first');
  assert.deepEqual(ask, { t: 'kanban.instructions.draft', project: 'web', field: 'prReview', text: 'Start the API first' });
  assert.deepEqual(draftRequest('web', 'testing', ''), { t: 'kanban.instructions.draft', project: 'web', field: 'testing', text: '' });
  assert.deepEqual(cancelRequest('web'), { t: 'kanban.instructions.draft.cancel', project: 'web' });
  assert.ok(INSTRUCTIONS_ANSWER_MS > 5 * 60_000);
  for (const msg of [ask, draftRequest('web', 'testing', ''), cancelRequest('web')]) assert.equal(typeof parseKanbanClientMsg({ ...msg, rid: 'k1' }), 'object', 'the office takes the message');
});

test('only one of the two fields is written at a time', () => {
  const runs = new DraftRuns();
  const n = runs.start('testing');
  assert.equal(typeof n, 'number');
  assert.equal(runs.running, 'testing');
  assert.equal(runs.start('prReview'), null, 'the other field waits');
  assert.equal(runs.start('testing'), null, 'and so does a second press on the same one');
  assert.equal(runs.settle(n!), true);
  assert.equal(runs.running, null);
  assert.equal(typeof runs.start('prReview'), 'number', 'free again once the answer came');
});

test('an answer counts once, and only for the run it was asked in', () => {
  const runs = new DraftRuns();
  const first = runs.start('testing')!;
  assert.equal(runs.drop(), true, 'Cancel, or the pane drawn anew');
  assert.equal(runs.settle(first), false, 'the cancelled run’s answer is dropped');
  assert.equal(runs.drop(), false, 'nothing left to cancel');
  const second = runs.start('prReview')!;
  assert.notEqual(second, first);
  assert.equal(runs.settle(first), false, 'a late answer of the old run does not end the new one');
  assert.equal(runs.running, 'prReview');
  assert.equal(runs.settle(second), true);
  assert.equal(runs.settle(second), false, 'not twice');
});

test('a failure says why, except a cancelled or replaced request', () => {
  assert.equal(draftFailure(new KanbanError('cancelled', true)), null);
  assert.equal(draftFailure(new KanbanError('Canceled', true)), null);
  assert.equal(draftFailure(new KanbanError('Claude isn’t signed in yet', true)), 'Couldn’t write the instructions: Claude isn’t signed in yet');
  assert.equal(draftFailure(new KanbanError('The office didn’t answer')), 'Couldn’t write the instructions: The office didn’t answer');
  assert.equal(draftFailure(undefined), 'Couldn’t write the instructions: no reason given');
});

test('the review window is named after its field', () => {
  assert.equal(reviewTitle('testing'), 'Debugging and testing: written by AI');
  assert.equal(reviewTitle('prReview'), 'Pull-request review: written by AI');
});

test('the lead says nothing is saved yet, and that a field with text is replaced', () => {
  const empty = reviewLead('testing', 'use', ' \n');
  assert.match(empty, /^Check the text before you use it\./);
  assert.match(empty, /Nothing is saved until you press Save/);
  assert.doesNotMatch(empty, /replaces/);
  const filled = reviewLead('prReview', 'use', 'Start the API first');
  assert.match(filled, /replaces the text that is in Pull-request review now/);
  assert.match(filled, /Nothing is saved until you press Save/);
});

test('a field that is gone or locked gets the text to copy, not to use', () => {
  assert.equal(reviewMode({ connected: true, locked: false }), 'use');
  assert.equal(reviewMode({ connected: false, locked: false }), 'copy');
  assert.equal(reviewMode({ connected: true, locked: true }), 'copy');
  const gone = reviewLead('testing', 'copy', '');
  assert.match(gone, /Debugging and testing field .* no longer open/);
  assert.match(gone, /copy it/);
  assert.doesNotMatch(gone, /press Save/);
});

test('the text is cut to what the field takes', () => {
  assert.equal(clipToField('abcdef', 4), 'abcd');
  assert.equal(clipToField('abc', 4), 'abc');
  assert.equal(clipToField('abcdef', -1), 'abcdef', 'a field without a maxlength takes it all');
});

test('in the 3D office the review window\'s ✕ and Esc leave the settings too; its buttons and the kanban page do not', () => {
  assert.equal(closesSettingsToo({ byButton: false, inOffice: true }), true);
  assert.equal(closesSettingsToo({ byButton: true, inOffice: true }), false);
  assert.equal(closesSettingsToo({ byButton: false, inOffice: false }), false);
});

test('only the boxes the person changed are kept, given back once to the same project and only where they differ', () => {
  const k = new KeptTexts();
  const saved = { general: 'old general', testing: '', prReview: '' };
  k.keep('app', { general: 'old general', testing: 'half written', prReview: '' }, saved);
  assert.equal(k.has('app'), true);
  assert.equal(k.has('app'), true, 'asking uses nothing up');
  assert.deepEqual(k.take('other', saved), {});
  // Another admin saved new general instructions while the settings were closed: the untouched box keeps their text.
  assert.deepEqual(k.take('app', { general: 'NEW general, saved elsewhere', testing: '', prReview: '' }), { testing: 'half written' });
  assert.deepEqual(k.take('app', saved), {}, 'given back once');
  // Nothing changed: nothing is kept, and an earlier keep of the project goes.
  k.keep('app', { general: 'x' }, { general: '' });
  k.keep('app', { general: '' }, { general: '' });
  assert.equal(k.has('app'), false);
});
