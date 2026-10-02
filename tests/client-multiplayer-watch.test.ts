// An admin browser asks the office to watch the multiplayer link as soon as it is connected, and again
// after every reconnect, so the Players entry is right without opening Settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMsg } from '../src/shared/protocol.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)), removeItem: (k: string) => void storage.delete(k) },
});

const { store } = await import('../src/client/state/index.js');
const { installMultiplayer } = await import('../src/client/multiplayer/index.js');

test('mp.watch is sent once per connection, when admin, and mp.state updates the store at any time', () => {
  const sent: { t: string }[] = [];
  const handlers: ((up: boolean) => void)[] = [];
  const net = { up: false, send: (m: { t: string }) => sent.push(m), onStatus: (h: (up: boolean) => void) => handlers.push(h) };
  installMultiplayer({ net } as never);
  const status = (up: boolean) => {
    net.up = up;
    handlers.forEach((h) => h(up));
  };
  const me = (admin: boolean) => {
    store.me = { ...store.me, admin };
    store.emit('me');
  };

  status(true);
  me(false);
  assert.equal(sent.length, 0, 'not for a non-admin');
  me(true);
  assert.deepEqual(sent, [{ t: 'mp.watch' }]);
  me(true);
  assert.equal(sent.length, 1, 'once per connection');
  status(false);
  me(true);
  assert.equal(sent.length, 1, 'not while down');
  status(true);
  assert.equal(sent.length, 2, 'again after a reconnect');

  let fired = 0;
  store.on('mp', () => fired++);
  store.apply({ t: 'mp.state', state: { status: 'online', url: 'u', configured: true, offline: false, passwordSet: true, players: [], floors: [] } } as ServerMsg);
  assert.equal(store.mp.configured, true);
  assert.equal(fired, 1);
});
