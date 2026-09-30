import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, format, lang, moveReason, pickLang, setLang, t } from '../src/client/kanban/i18n.js';
import { checkMove } from '../src/shared/kanban/moves.js';
import { RUN_STATES, TASK_STATUSES } from '../src/shared/kanban/types.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('Finnish and English have exactly the same keys', () => {
  assert.deepEqual(Object.keys(DICTS.fi).sort(), Object.keys(DICTS.en).sort());
});

test('every translation keeps the same {placeholders} and is not empty', () => {
  for (const key of Object.keys(DICTS.en) as (keyof typeof DICTS.en)[]) {
    assert.deepEqual(placeholders(DICTS.fi[key]), placeholders(DICTS.en[key]), key);
    assert.ok(DICTS.fi[key].trim() && DICTS.en[key].trim(), key);
  }
});

test('the language: the saved pick, else the browser’s Finnish, else English', () => {
  assert.equal(pickLang('en', 'fi-FI'), 'en');
  assert.equal(pickLang(null, 'fi-FI'), 'fi');
  assert.equal(pickLang(null, 'FI'), 'fi');
  assert.equal(pickLang(undefined, 'sv-FI'), 'en');
  assert.equal(pickLang('de', undefined), 'en');
});

test('format fills known placeholders and leaves unknown ones', () => {
  assert.equal(format('#{id} of {n}', { id: 3 }), '#3 of {n}');
});

test('every reason moves.ts gives has a Finnish wording', () => {
  const before = lang();
  setLang('fi');
  try {
    const reasons = new Set<string>();
    for (const status of TASK_STATUSES) for (const runState of RUN_STATES) for (const hasWorker of [false, true]) for (const to of TASK_STATUSES) {
      const c = checkMove({ status, runState, hasWorker }, to);
      if (!c.ok) reasons.add(c.reason);
    }
    assert.ok(reasons.size > 5);
    for (const r of reasons) assert.notEqual(moveReason(r), r, `untranslated: ${r}`);
    assert.equal(moveReason('Something new'), 'Something new', 'an unknown reason shows as it is');
    assert.equal(t('col.todo'), 'Tehtävänä');
  } finally {
    setLang(before);
  }
});
