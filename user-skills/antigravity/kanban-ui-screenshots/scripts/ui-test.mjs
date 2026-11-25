import { resolve } from 'node:path';

const actionFields = {
  click: ['locator'], fill: ['locator', 'value'], select: ['locator', 'values'],
  check: ['locator', 'checked'], press: ['locator', 'key'], hover: ['locator'],
  drag: ['locator', 'to'], upload: ['locator', 'files'], reload: [],
};
const assertionFields = {
  visible: ['locator'], hidden: ['locator'], attached: ['locator'], detached: ['locator'],
  enabled: ['locator'], disabled: ['locator'], focused: ['locator'],
  text: ['locator', 'expected'], value: ['locator', 'expected'],
  count: ['locator', 'expected'], checked: ['locator', 'expected'],
  url: ['expected'], order: ['locator', 'expected'], noHorizontalOverflow: [],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const strings = value => nonempty(value) || (Array.isArray(value) && value.every(nonempty));

function validateLocator(value) {
  if (nonempty(value)) return;
  if (!object(value)) throw new Error('Locator must be a CSS string or role/label/testId object');
  const keys = 'role' in value ? ['role', 'name', 'exact'] : 'label' in value ? ['label', 'exact'] : ['testId'];
  if (Object.keys(value).some(key => !keys.includes(key)) ||
      ('role' in value ? !nonempty(value.role) || !nonempty(value.name) : 'label' in value ? !nonempty(value.label) : !nonempty(value.testId)) ||
      ('exact' in value && typeof value.exact !== 'boolean')) throw new Error('Invalid locator object');
}

function validateOperation(operation, kind) {
  const fields = kind === 'action' ? actionFields : assertionFields;
  if (!object(operation) || typeof operation.type !== 'string' || !Object.hasOwn(fields, operation.type)) throw new Error(`Unknown ${kind} type`);
  const required = fields[operation.type];
  const allowed = [...required, 'type', 'timeout', ...(operation.type === 'noHorizontalOverflow' ? ['tolerance'] : [])];
  if (Object.keys(operation).some(key => !allowed.includes(key))) throw new Error(`Unknown field for ${kind} ${operation.type}`);
  if (required.some(key => !Object.hasOwn(operation, key))) throw new Error(`Missing required field for ${kind} ${operation.type}`);
  if ('timeout' in operation && (!Number.isFinite(operation.timeout) || operation.timeout <= 0 || operation.timeout > 300000)) throw new Error('timeout must be between 1 and 300000 ms');
  for (const key of ['locator', 'to']) if (key in operation) validateLocator(operation[key]);
  if (kind === 'action') {
    if (operation.type === 'fill' && typeof operation.value !== 'string') throw new Error('fill value must be a string');
    if (operation.type === 'check' && typeof operation.checked !== 'boolean') throw new Error('check checked must be boolean');
    if (operation.type === 'press' && !nonempty(operation.key)) throw new Error('press key must be a nonempty string');
    for (const key of ['values', 'files']) if (key in operation && !strings(operation[key])) throw new Error(`${key} must be a string or string array`);
  } else {
    const { type, expected } = operation;
    if (['text', 'value', 'url'].includes(type) && typeof expected !== 'string') throw new Error(`${type} expected must be string`);
    if (type === 'count' && (!Number.isInteger(expected) || expected < 0)) throw new Error('count expected must be nonnegative integer');
    if (type === 'checked' && typeof expected !== 'boolean') throw new Error('checked expected must be boolean');
    if (type === 'order' && (!Array.isArray(expected) || !expected.every(value => typeof value === 'string'))) throw new Error('order expected must be string array');
    if ('tolerance' in operation && (!Number.isFinite(operation.tolerance) || operation.tolerance < 0)) throw new Error('tolerance must be nonnegative');
  }
}

export function validateTestSteps(steps) {
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  for (const [index, step] of steps.entries()) {
    if (!object(step)) throw new Error(`Step ${index + 1} must be an object`);
    for (const [key, kind] of [['actions', 'action'], ['assertions', 'assertion']]) {
      if (!(key in step)) continue;
      if (!Array.isArray(step[key])) throw new Error(`Step ${index + 1} ${key} must be an array`);
      for (const operation of step[key]) validateOperation(operation, kind);
    }
  }
}

function locate(page, locator) {
  if (typeof locator === 'string') return page.locator(locator);
  if ('role' in locator) return page.getByRole(locator.role, { name: locator.name, exact: locator.exact ?? true });
  if ('label' in locator) return page.getByLabel(locator.label, { exact: locator.exact ?? true });
  return page.getByTestId(locator.testId);
}

function timeoutFor(operation, timeout = 5000) {
  const value = operation.timeout ?? timeout;
  if (!Number.isFinite(value) || value <= 0 || value > 300000) throw new Error('timeout must be between 1 and 300000 ms');
  return value;
}

export class UiTestError extends Error {
  constructor(message, record, records) {
    super(message);
    this.name = 'UiTestError';
    this.record = record;
    this.failure = record;
    this.diagnostic = message;
    this.records = [...records, record];
  }
}

function failure(kind, index, type, records, detail = {}) {
  const record = { kind, index, type, status: 'failed', ...detail };
  return new UiTestError(`${kind} ${index + 1} (${type}) failed`, record, records);
}

export async function runActions(page, actions, { timeout = 5000, flowDir = process.cwd() } = {}) {
  validateTestSteps([{ actions }]);
  const records = [];
  for (const [index, action] of actions.entries()) {
    const options = { timeout: timeoutFor(action, timeout) };
    try {
      const locator = action.locator === undefined ? null : locate(page, action.locator);
      switch (action.type) {
        case 'click': await locator.click(options); break;
        case 'fill': await locator.fill(action.value, options); break;
        case 'select': await locator.selectOption(action.values, options); break;
        case 'check': await locator.setChecked(action.checked, options); break;
        case 'press': await locator.press(action.key, options); break;
        case 'hover': await locator.hover(options); break;
        case 'drag': await locator.dragTo(locate(page, action.to), options); break;
        case 'upload': await locator.setInputFiles([action.files].flat().map(file => resolve(flowDir, file)), options); break;
        case 'reload': await page.reload({ ...options, waitUntil: 'domcontentloaded' }); break;
      }
      records.push({ kind: 'action', index, type: action.type, status: 'passed' });
    } catch {
      // Playwright error messages can include filled values, file paths and selectors.
      throw failure('action', index, action.type, records);
    }
  }
  return records;
}

async function observe(page, assertion, remaining) {
  const locator = assertion.locator === undefined ? null : locate(page, assertion.locator);
  const options = { timeout: Math.max(1, remaining) };
  switch (assertion.type) {
    case 'attached': return await locator.count() > 0;
    case 'detached': return await locator.count() === 0;
    case 'visible': return await locator.isVisible();
    case 'hidden': return await locator.isHidden();
    case 'enabled': return await locator.isEnabled(options);
    case 'disabled': return await locator.isDisabled(options);
    case 'focused': return await locator.evaluate(element => element === document.activeElement, undefined, options);
    case 'text': return await locator.textContent(options);
    case 'value': return await locator.inputValue(options);
    case 'count': return await locator.count();
    case 'checked': return await locator.isChecked(options);
    case 'url': return page.url();
    case 'order': return (await locator.allTextContents()).map(text => text.trim());
    case 'noHorizontalOverflow': return await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - document.documentElement.clientWidth);
  }
}

export async function runAssertions(page, assertions, { timeout = 5000, includeValues = false } = {}) {
  validateTestSteps([{ assertions }]);
  const records = [];
  for (const [index, assertion] of assertions.entries()) {
    const duration = timeoutFor(assertion, timeout);
    const deadline = Date.now() + duration;
    const expected = Object.hasOwn(assertion, 'expected') ? assertion.expected : assertion.type === 'noHorizontalOverflow' ? assertion.tolerance ?? 1 : true;
    let actual;
    let passed = false;
    do {
      try {
        actual = await observe(page, assertion, deadline - Date.now());
        passed = assertion.type === 'noHorizontalOverflow' ? actual <= expected : JSON.stringify(actual) === JSON.stringify(expected);
      } catch { actual = undefined; }
      if (passed || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    } while (true);
    const sensitive = !includeValues && ['text', 'value', 'url', 'order'].includes(assertion.type);
    const detail = { expected: sensitive ? '[redacted]' : expected, actual: actual === undefined ? '[unavailable]' : sensitive ? '[redacted]' : actual };
    if (!passed) throw failure('assertion', index, assertion.type, records, detail);
    records.push({ kind: 'assertion', index, type: assertion.type, status: 'passed', ...detail });
  }
  return records;
}
