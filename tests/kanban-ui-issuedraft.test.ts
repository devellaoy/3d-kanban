// The prompt drafted from a picked issue in the New task form, without the DOM
// (src/client/kanban/issuedraft.ts): what is asked, and when its answer still goes to the description.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_ANSWER_MS, draftApplies, draftFailure, requestIssueDraft, type DraftForm } from '../src/client/kanban/issuedraft.js';
import { KanbanError } from '../src/client/kanban/api.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';

const asked = { seq: 3, issueKey: 'gh:acme/web#12' };
const form = (f: Partial<DraftForm> = {}): DraftForm => ({ seq: 3, open: true, pickedKey: 'gh:acme/web#12', description: '', ...f });

test('a draft goes to the description when nothing has changed since it was asked for', () => {
  assert.equal(draftApplies(asked, form()), true);
  assert.equal(draftApplies(asked, form({ description: ' \n\t' })), true, 'blank space is still an empty description');
});

test('a draft is dropped when the form has moved on', () => {
  assert.equal(draftApplies(asked, form({ description: 'Fix the login' })), false, 'something was written meanwhile');
  assert.equal(draftApplies(asked, form({ pickedKey: 'gh:acme/web#13' })), false, 'another issue is picked');
  assert.equal(draftApplies(asked, form({ pickedKey: null })), false, 'the issue was unlinked');
  assert.equal(draftApplies(asked, form({ open: false })), false, 'the window closed');
  assert.equal(draftApplies(asked, form({ seq: 4 })), false, 'a newer request, or something that voided this one');
});

test('the request names the issue and its source, waits past the office’s own limit, and gives the text', async () => {
  const sent: { msg: unknown; ms?: number }[] = [];
  const api = {
    request: async (msg: unknown, ms?: number) => {
      sent.push({ msg, ms });
      return { t: 'kanban.issueDraft', text: sent.length === 1 ? 'Fix the login loop' : '' };
    },
  } as unknown as Parameters<typeof requestIssueDraft>[0];
  assert.equal(await requestIssueDraft(api, 'web', { key: 'gh:acme/web#12', sourceId: 'src-1' }), 'Fix the login loop');
  assert.equal(await requestIssueDraft(api, 'web', { key: 'UYT-1' }), '', 'nothing to write is an empty text, not an error');
  assert.deepEqual(sent[0], { msg: { t: 'kanban.issues.draft', project: 'web', issueKey: 'gh:acme/web#12', source: 'src-1' }, ms: DRAFT_ANSWER_MS });
  assert.deepEqual(sent[1].msg, { t: 'kanban.issues.draft', project: 'web', issueKey: 'UYT-1' });
  assert.ok(DRAFT_ANSWER_MS > 45_000);
  for (const s of sent) assert.equal(typeof parseKanbanClientMsg({ ...(s.msg as object), rid: 'k1' }), 'object', 'the office takes the message');
});

test('a failed draft says why, except one a newer request replaced', () => {
  assert.equal(draftFailure(new KanbanError('cancelled', true)), null);
  assert.equal(draftFailure(new KanbanError('Claude isn’t signed in yet', true)), 'Couldn’t draft a prompt: Claude isn’t signed in yet');
  assert.equal(draftFailure(new KanbanError('The office didn’t answer')), 'Couldn’t draft a prompt: The office didn’t answer');
});
