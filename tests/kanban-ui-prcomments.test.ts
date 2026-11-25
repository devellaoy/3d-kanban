import test from 'node:test';
import assert from 'node:assert/strict';
import { PR_ANSWER_TEXT_MAX, type PrCommentItem, type PrCommentsState } from '../src/shared/kanban/prcomments.js';
import { DraftStore, EMPTY_TEXT, RUNNING_TEXT, SEND_TITLE, answeredCount, countText, draftAnswers, droppedText, groupByPr, placeText, safeHref, sendState, textHint, viewOf, type Drafts } from '../src/client/kanban/prcommentsmodel.js';

const P1 = 'https://github.com/acme/api/pull/1';
const P2 = 'https://github.com/acme/web/pull/7';
const item = (id: string, patch: Partial<PrCommentItem> = {}): PrCommentItem => ({ id, pr: P1, kind: 'line', author: 'ada', url: `${P1}#r${id}`, body: 'b', meaning: 'm', valid: 'yes', validWhy: '', causedByTask: 'yes', causedWhy: '', recommend: 'fix', recommendWhy: '', ...patch });
const ITEMS = [item('a'), item('b', { pr: P2 }), item('c')];
const OK = { ok: true };

test('the list is by pull request, in the order of the task’s links, with what the task no longer links last', () => {
  const prs = [
    { url: P2, number: 7, repo: 'acme/web', repoId: 'web' },
    { url: P1, number: 1, repo: 'acme/api', repoId: 'api' },
    { url: 'https://github.com/acme/api/pull/9', number: 9, repo: 'acme/api', repoId: 'api' },
  ];
  const gone = item('d', { pr: 'https://github.com/acme/old/pull/3' });
  const g = groupByPr([...ITEMS, gone], prs, (p) => p.repoId);
  assert.deepEqual(g.map((x) => [x.repo, x.number, x.items.map((i) => i.id)]), [['web', 7, ['b']], ['api', 1, ['a', 'c']], [undefined, undefined, ['d']]]);
  assert.equal(g.some((x) => x.number === 9), false, 'a pull request without comments has no heading');
  assert.equal(groupByPr(ITEMS, prs)[0].repo, 'acme/web', 'the repository as the link names it, without a namer');
});

test('each state has its view: nothing, a line, the failure, or the list (locked once sent)', () => {
  const s = (patch: Partial<PrCommentsState>): PrCommentsState => ({ status: 'ready', items: [], dropped: 0, ...patch });
  assert.deepEqual(viewOf(null), { kind: 'none' });
  assert.deepEqual(viewOf(s({ status: 'none' })), { kind: 'none' });
  assert.deepEqual(viewOf(s({ status: 'running' })), { kind: 'line', text: RUNNING_TEXT });
  assert.deepEqual(viewOf(s({ status: 'failed', error: 'no file' })), { kind: 'failed', error: 'no file' });
  assert.equal((viewOf(s({ status: 'failed' })) as { error: string }).error.length > 0, true);
  assert.deepEqual(viewOf(s({ fetchedAt: 5 })), { kind: 'line', text: EMPTY_TEXT });
  assert.deepEqual(viewOf(s({ fetchedAt: 5, items: ITEMS })), { kind: 'list', locked: false, fetchedAt: 5 });
  assert.deepEqual(viewOf(s({ fetchedAt: 5, items: ITEMS, sent: { answers: [], at: 9 } })), { kind: 'list', locked: true, fetchedAt: 5 });
  assert.equal(droppedText(1), '1 item the agent wrote could not be read');
  assert.equal(droppedText(3), '3 items the agent wrote could not be read');
});

test('a comment’s place is its file and line, else its kind; only an https address becomes a link', () => {
  assert.equal(placeText({ kind: 'line', path: 'src/a.ts', line: 12 }), 'src/a.ts:12');
  assert.equal(placeText({ kind: 'line', path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(placeText({ kind: 'conversation' }), 'Conversation');
  assert.equal(placeText({ kind: 'review' }), 'Review');
  assert.equal(safeHref(P1), P1);
  for (const bad of ['http://github.com/a', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '', undefined]) assert.equal(safeHref(bad), undefined, String(bad));
});

test('drafts are kept per task and per fetched list: a new fetch starts clean', () => {
  const store = new DraftStore();
  const d = store.of(1, 100);
  d.set('a', { decision: 'fix' });
  assert.equal(store.of(1, 100), d, 'the same list gets the same drafts back');
  assert.equal(store.of(2, 100).size, 0, 'another task has its own');
  assert.equal(store.of(1, 200).size, 0, 'a list fetched again starts empty');
  assert.equal(store.of(1, 100).size, 0, 'and the old list’s drafts are gone');
  store.of(1, 100).set('a', { decision: 'skip' });
  store.clear(1);
  assert.equal(store.of(1, 100).size, 0);
});

test('the drafts become the answers: only decided comments, the text trimmed, capped and left out when empty', () => {
  const d: Drafts = new Map([
    ['a', { decision: 'fix', text: '   ' }],
    ['b', { text: 'typed, nothing picked' }],
    ['c', { decision: 'custom', text: `  ${'x'.repeat(PR_ANSWER_TEXT_MAX + 50)}  ` }],
    ['zz', { decision: 'fix' }],
  ]);
  const a = draftAnswers(ITEMS, d);
  assert.deepEqual(a.map((x) => x.id), ['a', 'c'], 'in the list’s order, nothing for an id the list doesn’t have');
  assert.deepEqual(a[0], { id: 'a', decision: 'fix' });
  assert.equal(a[1].text?.length, PR_ANSWER_TEXT_MAX);
});

test('the count and Send: every comment needs a decision, Other its text, and the task must be able to take it', () => {
  const d: Drafts = new Map();
  assert.equal(countText(answeredCount(ITEMS, d), ITEMS.length), '0 of 3 answered');
  assert.deepEqual(sendState(ITEMS, d, OK), { enabled: false, title: 'Pick Fix, Don’t fix or Other for every comment first' });
  d.set('a', { decision: 'fix' });
  d.set('b', { decision: 'skip', text: 'tell them why' });
  d.set('c', { decision: 'custom' });
  assert.equal(answeredCount(ITEMS, d), 2, 'an Other without text is not answered yet');
  assert.deepEqual(sendState(ITEMS, d, OK), { enabled: false, title: 'An Other answer needs its text' });
  d.set('c', { decision: 'custom', text: '  \n ' });
  assert.equal(sendState(ITEMS, d, OK).enabled, false, 'blank text is no text');
  d.set('c', { decision: 'custom', text: 'only the test' });
  assert.equal(countText(answeredCount(ITEMS, d), ITEMS.length), '3 of 3 answered');
  assert.deepEqual(sendState(ITEMS, d, OK), { enabled: true, title: SEND_TITLE });
  assert.deepEqual(sendState(ITEMS, d, { ok: false, reason: 'Stop it first: it is running' }), { enabled: false, title: 'Stop it first: it is running' });
  assert.equal(sendState([], new Map(), OK).enabled, false, 'an empty list has nothing to send');
});

test('the text box says whether its text is needed', () => {
  assert.match(textHint('custom'), /required/);
  for (const dec of [undefined, 'fix', 'skip'] as const) assert.match(textHint(dec), /optional/);
});
