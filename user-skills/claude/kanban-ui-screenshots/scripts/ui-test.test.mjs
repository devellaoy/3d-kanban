import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTestSteps, runActions, runAssertions, UiTestError } from './ui-test.mjs';

test('validates all actions and assertions before browser use', () => {
  validateTestSteps([{ actions: [
    { type: 'click', locator: { role: 'button', name: 'Save' } },
    { type: 'fill', locator: { label: 'Name' }, value: '' },
    { type: 'select', locator: '#select', values: ['one'] },
    { type: 'check', locator: '#check', checked: false },
    { type: 'press', locator: '#name', key: 'Tab' },
    { type: 'hover', locator: { testId: 'menu' } },
    { type: 'drag', locator: '#one', to: '#two' },
    { type: 'upload', locator: '#file', files: [] },
    { type: 'reload' },
  ], assertions: [
    ...['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled', 'focused'].map(type => ({ type, locator: '#x' })),
    { type: 'text', locator: '#x', expected: '' },
    { type: 'value', locator: '#x', expected: 'private' },
    { type: 'count', locator: '#x', expected: 0 },
    { type: 'checked', locator: '#x', expected: false },
    { type: 'url', expected: 'http://localhost/' },
    { type: 'order', locator: 'li', expected: ['one', 'two'] },
    { type: 'noHorizontalOverflow', tolerance: 0 },
  ] }]);
});

test('rejects unknown fields, misspellings, malformed locators and unbounded timeouts', () => {
  for (const action of [
    { type: 'toString' }, { type: 'Click', locator: '#x' },
    { type: 'click', locator: '#x', force: true },
    { type: 'fill', locator: '#x', value: 1 },
    { type: 'reload', timeout: 0 }, { type: 'reload', timeout: Infinity },
    { type: 'click', locator: { role: 'button' } },
    { type: 'click', locator: { label: 'X', testId: 'X' } },
  ]) assert.throws(() => validateTestSteps([{ actions: [action] }]));
  for (const assertion of [
    { type: 'count', locator: 'li', expected: -1 },
    { type: 'count', locator: 'li', expected: 1.2 },
    { type: 'checked', locator: '#x', expected: 'true' },
    { type: 'order', locator: 'li', expected: [1] },
    { type: 'noHorizontalOverflow', tolerance: -1 },
    { type: 'visible', locator: '#x', expected: true },
  ]) assert.throws(() => validateTestSteps([{ assertions: [assertion] }]));
});

test('actions use ordered Playwright locator operations and relative upload paths', async () => {
  const calls = [];
  const locator = new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, ...args]); } });
  const page = { locator: () => locator, getByRole: (...args) => { calls.push(['getByRole', ...args]); return locator; } };
  const records = await runActions(page, [
    { type: 'fill', locator: '#x', value: 'private' },
    { type: 'click', locator: { role: 'button', name: 'Save' } },
    { type: 'upload', locator: '#file', files: 'fixture.txt' },
  ], { flowDir: '/tmp/ui-fixture' });
  assert.deepEqual(calls.map(call => call[0]), ['fill', 'getByRole', 'click', 'setInputFiles']);
  assert.deepEqual(calls[3][1], ['/tmp/ui-fixture/fixture.txt']);
  assert.equal(JSON.stringify(records).includes('private'), false);
});

test('action errors do not leak Playwright value/selector error text', async () => {
  const page = { locator: () => ({ fill: () => { throw new Error('SECRET token in locator'); } }) };
  await assert.rejects(runActions(page, [{ type: 'fill', locator: '#secret', value: 'SECRET' }]), error => {
    assert.ok(error instanceof UiTestError);
    assert.equal(error.failure.status, 'failed');
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    return true;
  });
});

test('assertions retry, report safe values and support explicit detailed opt-in', async () => {
  let attempts = 0;
  const page = { locator: () => ({
    isVisible: async () => ++attempts >= 2,
    inputValue: async () => 'private value',
    count: async () => 3,
  }) };
  const records = await runAssertions(page, [
    { type: 'visible', locator: '#x' },
    { type: 'value', locator: '#x', expected: 'private value' },
    { type: 'count', locator: '#x', expected: 3 },
  ], { timeout: 200 });
  assert.equal(attempts, 2);
  assert.equal(records[1].actual, '[redacted]');
  assert.equal(records[2].actual, 3);
  const detailed = await runAssertions(page, [{ type: 'value', locator: '#x', expected: 'private value' }], { includeValues: true });
  assert.equal(detailed[0].actual, 'private value');
});

test('failed assertions stop subsequent checks with bounded retry and sanitized detail', async () => {
  let later = false;
  const page = { locator: () => ({ inputValue: async () => 'SECRET', isVisible: async () => { later = true; return true; } }) };
  await assert.rejects(runAssertions(page, [
    { type: 'value', locator: '#x', expected: 'OTHER_SECRET', timeout: 20 },
    { type: 'visible', locator: '#x' },
  ]), error => {
    assert.equal(error.failure.expected, '[redacted]');
    assert.equal(error.failure.actual, '[redacted]');
    assert.equal(JSON.stringify(error).includes('SECRET'), false);
    return true;
  });
  assert.equal(later, false);
});
