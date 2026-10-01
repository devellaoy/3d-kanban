import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isatty } from 'node:tty';
import { interactive } from '../src/server/setup.js';

test('startup detects a terminal without opening standard-input/output streams', () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const stdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  const expected = isatty(0) && isatty(1) && !process.env.CI;
  try {
    // In the Windows watch-process chain, opening inherited piped stdin can hang.
    for (const name of ['stdin', 'stdout']) {
      Object.defineProperty(process, name, { configurable: true, get() {
        throw new Error('Startup must not open ' + name + ' just to detect a terminal');
      } });
    }
    assert.equal(interactive(), expected);
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
    Object.defineProperty(process, 'stdout', stdout);
  }
});
