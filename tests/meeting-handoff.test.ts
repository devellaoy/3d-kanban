import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_MAX, QUESTION_MAX, TEXT_MAX, composeHandoff, handoffTag, handoffVars, outputFileName, sourceLine, toggleParagraph, type HandoffTemplates } from '../src/shared/meeting-handoff.js';
import { HANDOFF_MAX, cleanHandoffs, cleanRecord, meetingRecord } from '../src/shared/meetings.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { Meeting, MeetingRecord } from '../src/shared/protocol.js';

const templates: HandoffTemplates = { main: PROMPTS['meeting.handoff'].text, pr: PROMPTS['meeting.handoff.pr'].text, stopped: PROMPTS['meeting.handoff.stopped'].text, branch: PROMPTS['meeting.handoff.branch'].text };
const rec = (extra: Partial<MeetingRecord> = {}): MeetingRecord => ({ id: 'abcdef01', pattern: 'debate', title: 'Pick a cache', status: 'done', summary: 'Debate · 3 rounds', calledBy: 'Ada', finishedAt: 1, output: 'docs/decisions/pick-a-cache.md', prompt: 'Which cache?', ...extra });
const compose = (o: Partial<Parameters<typeof composeHandoff>[0]> = {}) => composeHandoff({ record: rec(), output: '# Use Redis', templates, withBranch: false, canAttach: true, ...o });

test('a hand-off starts with the title, fills the placeholders and ends with where it came from', () => {
  const { text, attach } = compose();
  assert.equal(attach, false);
  assert.equal(text.split('\n')[0], 'Pick a cache');
  assert.match(text, /The meeting “Pick a cache” \(Debate\) was about:\nWhich cache\?/);
  assert.match(text, /\(docs\/decisions\/pick-a-cache\.md\)/);
  assert.match(text, /# Use Redis/);
  assert.doesNotMatch(text, /\{\{/);
  assert.equal(text.split('\n\n').at(-1), 'Handed on from the meeting “Pick a cache” (Debate, abcdef01).');
});

test('a review hand-off says to work on the pull request, a stopped one that the result may be partial', () => {
  const r = compose({ record: rec({ pattern: 'review', pr: 12, status: 'stopped', summary: 'Review · ⛔ over budget' }) });
  assert.match(r.text, /pull request #12, and the result below is that review\./);
  // The new worktree has the base's code only: the PR's head is merged into the worker's own branch, never checked out.
  assert.match(r.text, /`git fetch origin pull\/12\/head` and `git merge FETCH_HEAD`/);
  assert.match(r.text, /Don't check out or push to the pull request's branch/);
  assert.match(r.text, /stopped before it finished \(Review · ⛔ over budget\)/);
  assert.match(r.text, /PR #12\)\.$/);
  assert.doesNotMatch(compose().text, /pull request #|stopped before/);
});

test('the branch paragraph is only in with withBranch, a branch and a commit; it is handed back for toggling', () => {
  const withB = rec({ branch: 'meeting/pick', commit: 'abc123' });
  const on = compose({ record: withB, withBranch: true });
  const off = compose({ record: withB });
  assert.match(on.text, /git merge meeting\/pick/);
  assert.doesNotMatch(off.text, /git merge/);
  assert.equal(on.branchParagraph, off.branchParagraph);
  assert.match(on.branchParagraph, /commit abc123/);
  assert.equal(on.text.indexOf(on.branchParagraph) < on.text.indexOf('Handed on from'), true);
  assert.equal(compose({ record: rec({ branch: 'b' }), withBranch: true }).branchParagraph, '');
  assert.doesNotMatch(compose({ record: rec({ branch: 'b' }), withBranch: true }).text, /git merge/);
});

test('the question is cut at QUESTION_MAX', () => {
  const v = handoffVars(rec({ prompt: 'q'.repeat(QUESTION_MAX + 5) }), 'c');
  assert.equal((v.question as string).length, QUESTION_MAX + 1);
  assert.ok((v.question as string).endsWith('…'));
  assert.equal(handoffVars(rec(), 'c').pr, '');
  assert.equal(handoffVars(rec({ pr: 4 }), 'c').pr, '4');
});

test('the output goes inline up to INLINE_MAX, then is attached; a long template forces it sooner', () => {
  const at = compose({ output: 'x'.repeat(INLINE_MAX) });
  assert.equal(at.attach, false);
  assert.ok(at.text.length <= TEXT_MAX);
  const over = compose({ output: 'x'.repeat(INLINE_MAX + 1) });
  assert.equal(over.attach, true);
  assert.match(over.text, /\(The meeting's output, output-pick-a-cache\.md, is attached: read it first\.\)/);
  assert.doesNotMatch(over.text, /xxxx/);
  const long = compose({ output: 'x'.repeat(5000), templates: { ...templates, main: `${'t'.repeat(15_000)}\n\n{{content}}` } });
  assert.equal(long.attach, true);
});

test('without attachments the output is cut to fit and says where the rest is', () => {
  const r = compose({ output: 'x'.repeat(50_000), canAttach: false });
  assert.equal(r.attach, false);
  assert.ok(r.text.length <= TEXT_MAX);
  assert.match(r.text, /\(Cut short: the whole output is in the meeting's notes, \.agent-office\/meetings\/abcdef01\/output-pick-a-cache\.md in the project's main checkout, not in a worktree\.\)/);
  const tight = compose({ output: 'x'.repeat(5000), canAttach: false, templates: { ...templates, main: `${'t'.repeat(16_000)}\n\n{{content}}` } });
  assert.ok(tight.text.length <= TEXT_MAX);
  assert.match(tight.text, /Cut short/);
});

test('toggleParagraph puts a paragraph before the source line, takes it out only verbatim, and is idempotent', () => {
  const text = 'Title\n\nBody\n\nSource.';
  assert.equal(toggleParagraph(text, 'Extra', true), 'Title\n\nBody\n\nExtra\n\nSource.');
  assert.equal(toggleParagraph(toggleParagraph(text, 'Extra', true), 'Extra', true), 'Title\n\nBody\n\nExtra\n\nSource.');
  assert.equal(toggleParagraph('Title\n\nBody\n\nExtra\n\nSource.', 'Extra', false), text);
  assert.equal(toggleParagraph(text, 'Extra', false), text);
  assert.equal(toggleParagraph('Title\n\nBody\n\nExtra edited\n\nSource.', 'Extra', false), 'Title\n\nBody\n\nExtra edited\n\nSource.');
  assert.equal(toggleParagraph('Only', 'Extra', true), 'Only\n\nExtra');
  assert.equal(toggleParagraph(text, '', true), text);
  assert.equal(toggleParagraph(text, '', false), text);
});

test('tag, source line and output file name', () => {
  assert.equal(handoffTag('abcdef01'), 'meeting:abcdef01');
  assert.ok(handoffTag('abcdef01').length <= 40);
  assert.equal(sourceLine(rec({ pattern: 'review', pr: 3, branch: 'b', commit: 'c1' })), 'Handed on from the meeting “Pick a cache” (Review panel, abcdef01, branch b, commit c1, PR #3).');
  assert.equal(outputFileName('docs/a/b.md'), 'output-b.md');
  assert.equal(outputFileName('docs\\a\\b.md'), 'output-b.md');
  assert.equal(outputFileName('b.md'), 'output-b.md');
});

test('cleanHandoffs keeps what is valid and the newest ten', () => {
  assert.equal(cleanHandoffs(undefined), undefined);
  assert.equal(cleanHandoffs('x'), undefined);
  assert.equal(cleanHandoffs([{ by: 'a', at: 1 }, { task: 0, by: 'a', at: 1 }, { task: 1.5, by: 'a', at: 1 }, { worker: '', by: 'a', at: 1 }, { task: 2, by: 'a', at: NaN }, null, 4]), undefined);
  assert.deepEqual(cleanHandoffs([{ task: 2, by: 'a', at: 1, junk: true }, { worker: 'W', by: 'b', at: 2 }, { task: 3, by: 5, at: 1 }, { worker: 'x'.repeat(81), by: 'b', at: 2 }]), [{ task: 2, by: 'a', at: 1 }, { worker: 'W', by: 'b', at: 2 }]);
  const many = cleanHandoffs(Array.from({ length: 15 }, (_, i) => ({ task: i + 1, by: 'a', at: i })))!;
  assert.equal(many.length, HANDOFF_MAX);
  assert.equal(many[0].task, 6);
  assert.equal(many.at(-1)!.task, 15);
});

test('a record carries handedTo through meetingRecord and cleanRecord', () => {
  const m = { id: 'abcdef01', room: 'meeting', pattern: 'debate', title: 'T', prompt: 'P', output: 'o.md', seats: [], status: 'done', round: 1, rounds: 3, tokens: 0, cost: 0, costKnown: false, calledBy: 'Ada', finishedAt: 5, handedTo: [{ task: 4, by: 'Ada', at: 1 }] } as unknown as Meeting;
  const r = meetingRecord(m);
  assert.deepEqual(r.handedTo, [{ task: 4, by: 'Ada', at: 1 }]);
  assert.deepEqual(cleanRecord(JSON.parse(JSON.stringify(r)))!.handedTo, [{ task: 4, by: 'Ada', at: 1 }]);
  assert.equal(cleanRecord({ ...r, handedTo: [{ junk: 1 }] })!.handedTo, undefined);
  assert.equal('handedTo' in meetingRecord({ ...m, handedTo: undefined }), false);
});
