import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interactive } from '../src/server/setup.js';

test('startup detects a terminal without opening standard-input/output streams', () => {
  const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const stdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  // Keep this test synchronous: nothing may run while the throwing getters are installed.
  try {
    // In the Windows watch-process chain, opening inherited piped stdin can hang.
    for (const name of ['stdin', 'stdout']) {
      Object.defineProperty(process, name, { configurable: true, get() {
        throw new Error('Startup must not open ' + name + ' just to detect a terminal');
      } });
    }
    assert.doesNotThrow(() => interactive());
  } finally {
    Object.defineProperty(process, 'stdin', stdin);
    Object.defineProperty(process, 'stdout', stdout);
  }
});
