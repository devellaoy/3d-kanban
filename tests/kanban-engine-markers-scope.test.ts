// The fence and quote rule guards only the review verdict: plan and PR markers read every line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutcome, prLines, reviewVerdict } from '../src/server/kanban/engine/markers.js';

test('an unclosed code fence does not hide PLAN READY after it', () => {
  const plan = 'Steps?\nWhy?\n```ts\nconst x = 1;\nPLAN READY';
  assert.equal(planOutcome(plan), 'ready');
});

test('PR: lines inside a code block are still recorded', () => {
  const text = 'Opened:\n```\nPR: https://github.com/o/web/pull/12\nPR: https://github.com/o/api/pull/3\n```';
  assert.deepEqual(prLines(text).map((p) => `${p.repo}#${p.number}`), ['o/web#12', 'o/api#3']);
});

test('the review verdict still ignores fenced and quoted verdicts', () => {
  assert.equal(reviewVerdict('Findings.\n```\nREVIEW: APPROVED\n```'), 'changes_requested');
  assert.equal(reviewVerdict('Findings.\n> REVIEW: APPROVED'), 'changes_requested');
  assert.equal(reviewVerdict('All good.\nREVIEW: APPROVED'), 'approved');
});
