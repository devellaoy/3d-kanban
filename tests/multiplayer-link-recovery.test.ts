// The office's link against a real relay (port 0) with scripted GitHub checks: a passing GitHub or
// relay hiccup must not ask the person to sign in again, and a wake from sleep reconnects at once.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MpConfigStore } from '../src/server/multiplayer/config.js';
import { TokenRejected, type IdentityVerifier } from '../src/server/multiplayer/github-user.js';
import { Link } from '../src/server/multiplayer/link.js';
import { startRelay, type RunningRelay } from '../src/server/multiplayer/relay/server.js';

const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanup.reverse()) await c();
});
const warn = console.warn;
console.warn = () => {};
after(() => void (console.warn = warn));

/** A relay whose GitHub check runs `script` (throwing what it throws, once per hello). */
async function setup(script: (hello: number) => Error | undefined, officeCheck: IdentityVerifier, extra: { now?: () => number; wakeTickMs?: number } = {}) {
  let hellos = 0;
  const relay: RunningRelay = await startRelay({
    port: 0,
    host: '127.0.0.1',
    password: 'pw',
    log: () => {},
    verifier: {
      login: async () => {
        const err = script(++hellos);
        if (err) throw err;
        return 'alice';
      },
    },
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-link-'));
  const config = new MpConfigStore(dir);
  config.update({ enabled: true, url: `ws://127.0.0.1:${relay.port}/mp`, password: 'pw', identityToken: 'tok' });
  const seen = { identity: false };
  const link: Link = new Link({
    config,
    version: '0.0.0',
    onChange: () => void (seen.identity ||= link.needsIdentity),
    onMessage: () => {},
    onDown: () => {},
    verifier: officeCheck,
    unavailableMinMs: 100,
    ...extra,
  });
  cleanup.push(async () => {
    link.disconnect();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { link, seen, hellos: () => hellos };
}

async function until(what: string, cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const fine: IdentityVerifier = { login: async () => 'alice' };

test('GitHub failing once on the relay does not ask for a sign-in', async () => {
  const t = await setup((n) => (n === 1 ? new Error('timeout') : undefined), fine);
  t.link.connect();
  await until('online', () => t.link.status === 'online');
  assert.equal(t.seen.identity, false);
  assert.equal(t.hellos(), 2);
});

test('an old relay refusing a good token once (4403) is retried after our own check', async () => {
  const t = await setup((n) => (n === 1 ? new TokenRejected('x') : undefined), fine);
  t.link.connect();
  await until('online', () => t.link.status === 'online');
  assert.equal(t.seen.identity, false);
});

test('a token both the relay and GitHub reject ends in sign-in again, with no more hellos', async () => {
  const t = await setup(() => new TokenRejected('x'), { login: async () => Promise.reject(new TokenRejected('x')) });
  t.link.connect();
  await until('error', () => t.link.status === 'error');
  assert.equal(t.link.needsIdentity, true);
  const n = t.hellos();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.hellos(), n);
});

test('after a wake from sleep an online link reconnects at once', async () => {
  let clock = 1_000_000;
  const t = await setup(() => undefined, fine, { now: () => clock, wakeTickMs: 50 });
  t.link.connect();
  await until('online', () => t.link.status === 'online');
  assert.equal(t.hellos(), 1);
  clock += 3_600_000;
  await until('second hello', () => t.hellos() === 2, 3000);
  await until('online again', () => t.link.status === 'online');
});

test('a link waiting out a long pause reconnects at once after a wake', async () => {
  let clock = 1_000_000;
  const t = await setup((n) => (n === 1 ? new Error('timeout') : undefined), fine, { now: () => clock, wakeTickMs: 50, unavailableMinMs: 60_000 });
  t.link.connect();
  await until('waiting', () => t.link.status === 'connecting' && t.hellos() === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t.hellos(), 1, 'still waiting out the long pause');
  clock += 3_600_000;
  await until('online', () => t.link.status === 'online', 3000);
});

test('a wake while our own GitHub check is running opens no extra connection', async () => {
  let clock = 1_000_000;
  let release: () => void = () => {};
  let checking = false;
  const slowCheck: IdentityVerifier = {
    login: () =>
      new Promise((resolve) => {
        checking = true;
        release = () => resolve('alice');
      }),
  };
  // Hello 1: GitHub hiccup (4504, a retry that fires); hello 2: refused (4403, our slow check); then fine.
  const t = await setup((n) => (n === 1 ? new Error('timeout') : n === 2 ? new TokenRejected('x') : undefined), slowCheck, { now: () => clock, wakeTickMs: 50 });
  t.link.connect();
  await until('checking the token', () => checking && t.hellos() === 2);
  clock += 3_600_000;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.hellos(), 2, 'the wake did not open another connection mid-check');
  release();
  await until('online', () => t.link.status === 'online');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t.hellos(), 3);
  assert.equal(t.link.status, 'online');
  assert.equal(t.seen.identity, false);
});
