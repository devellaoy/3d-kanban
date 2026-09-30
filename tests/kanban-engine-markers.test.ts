import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, looksInterrupted, planOutcome, prLines, resetTime, reviewFindings, reviewVerdict, stripPlanMarkers } from '../src/server/kanban/engine/markers.js';

test('plan outcome: PLAN READY, a QUESTIONS: heading, and the question-mark heuristic', () => {
  assert.equal(planOutcome('The plan.\n\nPLAN READY'), 'ready');
  assert.equal(planOutcome('The plan.\n**PLAN READY**'), 'ready', 'emphasis around the marker');
  assert.equal(planOutcome('Should it? Or not?\nPLAN READY'), 'ready', 'the marker wins over question marks');
  assert.equal(planOutcome('QUESTIONS:\n1. Which API?\n2. Keep v1?'), 'questions');
  assert.equal(planOutcome('Some context.\n## QUESTIONS:\n1. Which one'), 'questions', 'as a markdown heading');
  assert.equal(planOutcome('QUESTIONS: 1. only one'), 'questions');
  // Neither marker: two question marks are questions, unless the plan was written to a .md file.
  assert.equal(planOutcome('Do we keep v1? And the old flag?'), 'questions');
  assert.equal(planOutcome('Do we keep v1? And the old flag? The plan is in /Users/me/.claude/plans/x.md'), 'ready');
  assert.equal(planOutcome('Saved to `~/plans/x.md`. Why? Because? '), 'ready');
  assert.equal(planOutcome('One question? That is all.'), 'ready');
  assert.equal(planOutcome('A plain plan with no markers.'), 'ready');
  // A plan's own "Open questions" section is no QUESTIONS: heading.
  assert.equal(planOutcome('## Open questions\nnone\nPLAN READY'), 'ready');
  assert.equal(planOutcome('## Open questions\nnone'), 'ready');
  // Leaving plan mode is a finished plan, however many question marks it has, unless it asks.
  assert.equal(planOutcome('Why? How?', true), 'ready');
  assert.equal(planOutcome('QUESTIONS:\n1. Why?', true), 'questions');
  assert.equal(stripPlanMarkers('Step 1\nStep 2\n\nPLAN READY\n'), 'Step 1\nStep 2');
});

test('review verdict: the last REVIEW: line decides, none is changes requested', () => {
  assert.equal(reviewVerdict('All good.\nREVIEW: APPROVED'), 'approved');
  assert.equal(reviewVerdict('Findings...\nREVIEW: CHANGES_REQUESTED'), 'changes_requested');
  assert.equal(reviewVerdict('REVIEW: CHANGES_REQUESTED\nLater I looked again.\nREVIEW: APPROVED'), 'approved');
  assert.equal(reviewVerdict('REVIEW: APPROVED\n\nREVIEW: CHANGES_REQUESTED'), 'changes_requested');
  assert.equal(reviewVerdict('Nothing to say.'), 'changes_requested');
  // Only a line of its own counts: a mention in a sentence is no verdict.
  assert.equal(reviewVerdict('I would write REVIEW: APPROVED if it were done.'), 'changes_requested');
  assert.equal(reviewVerdict('  **REVIEW: APPROVED**  '), 'approved');
  assert.equal(reviewFindings('1. Fix x\nREVIEW: CHANGES_REQUESTED'), '1. Fix x');
});

test('PR lines: every URL once, GitHub ones with their repository and number', () => {
  const found = prLines('Opened them.\nPR: https://github.com/acme/api/pull/12\nPR: https://github.com/acme/web/pull/7.\nPR: https://github.com/acme/api/pull/12\nPR: https://gitlab.com/x/-/merge_requests/3\nSee PR: https://nope in a sentence');
  assert.deepEqual(found, [
    { url: 'https://github.com/acme/api/pull/12', repo: 'acme/api', number: 12 },
    { url: 'https://github.com/acme/web/pull/7', repo: 'acme/web', number: 7 },
    { url: 'https://gitlab.com/x/-/merge_requests/3' },
  ]);
});

test('usage limits and lost connections, and when they reset', () => {
  assert.equal(looksInterrupted("You've hit your limit · resets 3pm (Europe/Helsinki)"), true);
  assert.equal(looksInterrupted('Claude AI usage limit reached|1767225600'), true);
  assert.equal(looksInterrupted('API Error: 529 {"type":"overloaded_error"}'), true);
  assert.equal(looksInterrupted('stream disconnected before completion: error sending request'), true);
  assert.equal(looksInterrupted('', 'Connection error.'), true);
  assert.equal(looksInterrupted('Done: tests pass.'), false);
  // A real answer that talks about rate limiting is still an answer.
  assert.equal(looksInterrupted(`I added rate limit middleware to the API. ${'Details. '.repeat(80)}`), false);

  const now = new Date(2026, 8, 30, 10, 0, 0).getTime();
  assert.equal(resetTime('resets 3pm', now), new Date(2026, 8, 30, 15, 0, 0).getTime());
  assert.equal(resetTime('resets at 9:30am', now), new Date(2026, 9, 1, 9, 30, 0).getTime(), 'already past today: tomorrow');
  assert.equal(resetTime('usage limit reached|1893456000', now), 1893456000 * 1000);
  assert.equal(resetTime('try again later', now), undefined);
  assert.equal(backoffMs(1), 5 * 60_000);
  assert.equal(backoffMs(2), 10 * 60_000);
  assert.equal(backoffMs(10), 60 * 60_000);
});
