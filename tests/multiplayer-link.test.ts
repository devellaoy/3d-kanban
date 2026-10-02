// The office's pieces of the relay link that need no relay: the saved file, the address rules and
// GitHub's device flow (with GitHub stubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MpConfigStore } from '../src/server/multiplayer/config.js';
import { Identity } from '../src/server/multiplayer/identity.js';
import { normalizeRelayUrl } from '../src/server/multiplayer/link.js';

test('the relay address is normalized, and plain ws:// is for this machine only', () => {
  const ok = (input: string, url: string) => assert.deepEqual(normalizeRelayUrl(input), { url }, input);
  ok('https://relay.example.com', 'wss://relay.example.com/mp');
  ok('wss://relay.example.com', 'wss://relay.example.com/mp');
  ok('relay.example.com:8443', 'wss://relay.example.com:8443/mp');
  ok('https://relay.example.com/custom?x=1#y', 'wss://relay.example.com/custom');
  ok('ws://localhost:4700', 'ws://localhost:4700/mp');
  ok('http://127.0.0.1:4700/', 'ws://127.0.0.1:4700/mp');
  ok('ws://[::1]:4700', 'ws://[::1]:4700/mp');
  for (const bad of ['', '   ', 'ws://relay.example.com', 'http://relay.example.com', 'ftp://x.example.com', 'wss://user:pw@relay.example.com', 'https://', 'x'.repeat(301)]) {
    assert.ok('error' in normalizeRelayUrl(bad), bad);
  }
});

test('multiplayer.json is private, survives garbage, and keeps one key per floor', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'multiplayer.json');
  const store = new MpConfigStore(dir);
  assert.deepEqual(store.get(), { enabled: false, url: '', password: '', identityToken: '', sharedFloors: [], floorKeys: {} });
  store.update({ enabled: true, url: 'wss://r.example/mp', password: 'pw', identityToken: 'tok', sharedFloors: ['web'] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const key = store.floorKey('web');
  assert.match(key, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(store.floorKey('web'), key);
  assert.notEqual(store.floorKey('docs'), key);
  const again = new MpConfigStore(dir).get();
  assert.equal(again.password, 'pw');
  assert.deepEqual(again.sharedFloors, ['web']);
  assert.equal(again.floorKeys.web, key);
  writeFileSync(file, '{ "enabled": "yes", "url": 5, "sharedFloors": [1, "web"], "floorKeys": { "web": "no!" } }');
  assert.deepEqual(new MpConfigStore(dir).get(), { enabled: false, url: '', password: '', identityToken: '', sharedFloors: ['web'], floorKeys: {} });
  writeFileSync(file, 'not json');
  assert.equal(new MpConfigStore(dir).get().url, '');
  assert.ok(!readFileSync(file, 'utf8').includes('pw'));
});

/** GitHub as a script: each call to the token endpoint answers the next reply. */
function github(replies: Record<string, unknown>[]) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const f = (async (url: string, init: { body: string }) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, body });
    const json = url.endsWith('/device/code') ? { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } : replies.shift()!;
    return { status: 200, json: async () => json };
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('the device flow shows a code, waits out pending and slow_down, and returns the token', async () => {
  const gh = github([{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_token' }]);
  const waits: number[] = [];
  const shown: (string | undefined)[] = [];
  const id: Identity = new Identity({ fetch: gh.f, sleep: async (ms) => void waits.push(ms), onChange: () => shown.push(id.device?.code) });
  assert.equal(await id.start('cid'), 'gho_token');
  assert.deepEqual(waits, [5000, 5000, 10_000], 'slow_down raises the interval');
  assert.deepEqual(shown, ['ABCD-1234', undefined], 'the code shows while waiting and goes away after');
  assert.equal(gh.calls[0].body.get('client_id'), 'cid');
  assert.equal(gh.calls[0].body.get('scope'), '', 'no scopes: the token reads nothing private');
  assert.equal(gh.calls[1].body.get('device_code'), 'dev123');
  assert.equal(gh.calls[1].body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(id.running, false);
});

test('the device flow ends with a reason when denied or expired, and can be cancelled', async () => {
  const sleep = async () => {};
  await assert.rejects(new Identity({ fetch: github([{ error: 'access_denied' }]).f, sleep }).start('cid'), /denied/);
  await assert.rejects(new Identity({ fetch: github([{ error: 'expired_token' }]).f, sleep }).start('cid'), /ran out/);
  await assert.rejects(new Identity({ fetch: github([{ error: 'weird', error_description: 'GitHub says no' }]).f, sleep }).start('cid'), /GitHub says no/);
  const gh = github([{ error: 'authorization_pending' }]);
  let id: Identity;
  id = new Identity({ fetch: gh.f, sleep: async () => id.cancel() });
  await assert.rejects(id.start('cid'), /cancelled/);
  assert.equal(id.device, undefined);
});
