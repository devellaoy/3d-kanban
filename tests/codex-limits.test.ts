// The Codex limits: the normaliser, the reader's polling rules (with a fake `ask` and clock, no
// child processes), the reset picker, `askAppServer` against a fake `codex` script, and the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexLimits } from '../src/shared/codex-limits/protocol.js';
import { askAppServer, CodexLimitsReader, codexPlanLimits, pickReset, type Answer, type Ask } from '../src/server/codex-limits/reader.js';
import { closeCodexLimits, codexLimitsOf } from '../src/server/codex-limits/index.js';
import { codexLimitsHooks } from '../src/server/codex-limits/handlers.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Client } from '../src/server/office/client.js';

const win = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = 1_800_000_000) => ({ usedPercent, windowDurationMins, resetsAt });
const flush = () => new Promise((r) => setImmediate(r));

// --- the normaliser ---------------------------------------------------------------------------------

test('a Plus plan: the 5-hour and weekly windows, shortest first, resets in ms', () => {
  const s = codexPlanLimits(
    { rateLimits: { limitId: 'codex', planType: 'plus', primary: win(62.7, 10_080, 1_800_600_000), secondary: win(10, 300, 1_800_000_000) } },
    'chatgpt',
    1234,
  );
  assert.deepEqual(s, {
    status: 'ready',
    plan: 'plus',
    windows: [
      { label: '5-hour', pct: 10, resetsAt: 1_800_000_000_000 },
      { label: 'Weekly', pct: 62.7, resetsAt: 1_800_600_000_000 },
    ],
    at: 1234,
    checkedAt: 1234,
  });
});

test('a Pro plan has only the week, as the primary window: labelled by its length, not its slot', () => {
  const s = codexPlanLimits({ rateLimits: { planType: 'pro', primary: win(40, 10_080), secondary: null } }, 'chatgpt', 5);
  assert.deepEqual(s.windows.map((w) => w.label), ['Weekly']);
  assert.equal(s.status, 'ready');
});

test('the codex bucket of a multi-bucket answer wins; odd lengths are labelled; percentages are clamped', () => {
  const s = codexPlanLimits(
    {
      rateLimits: { primary: win(2, 300) },
      rateLimitsByLimitId: { codex: { planType: 'plus', primary: win(140, 30, null), secondary: win(-4, 2880), rateLimitReachedType: 'rate_limit_reached' } },
    },
    undefined,
    100,
  );
  assert.deepEqual(s.windows, [{ label: '30m', pct: 100 }, { label: '2d', pct: 0, resetsAt: 1_800_000_000_000 }]);
  assert.equal(s.reached, true);
  const hours = codexPlanLimits({ rateLimits: { primary: win(1, 360), secondary: win(Number.NaN, 300) } }, undefined, 1);
  assert.deepEqual(hours.windows.map((w) => w.label), ['6h'], 'a window without a number is left out');
});

test('a window at 100% says reached; the plan is cut to 24 characters', () => {
  const s = codexPlanLimits({ rateLimits: { planType: 'x'.repeat(40), primary: win(100, 300) } }, 'chatgpt', 1);
  assert.equal(s.reached, true);
  assert.equal(s.plan?.length, 24);
  assert.equal(codexPlanLimits({ rateLimits: { primary: win(5, 300) } }, 'chatgpt', 1).reached, undefined);
});

test('an API key (or no sign-in) is signedOut; an answer with no windows is an error, never zeros', () => {
  for (const auth of ['apikey', 'headers', null]) assert.equal(codexPlanLimits({ rateLimits: { primary: win(5, 300) } }, auth, 9).status, 'signedOut');
  assert.equal(codexPlanLimits({ rateLimits: { primary: win(5, 300) } }, 'chatgptAuthTokens', 9).status, 'ready');
  assert.equal(codexPlanLimits({}, 'chatgpt', 9).status, 'error');
  assert.equal(codexPlanLimits(null, undefined, 9).status, 'error');
});

test('nothing that names the account crosses: accountId, credits and the rest are dropped', () => {
  const s = codexPlanLimits(
    { accountId: 'acct-secret', rateLimitResetCredits: { x: 1 }, rateLimits: { planType: 'pro', credits: { balance: '12.5' }, individualLimit: 3, primary: win(5, 300) } },
    'chatgpt',
    1,
  );
  assert.deepEqual(Object.keys(s).sort(), ['at', 'checkedAt', 'plan', 'status', 'windows']);
  assert.ok(!JSON.stringify(s).includes('acct-secret') && !JSON.stringify(s).includes('12.5'));
});

// --- the reset picker -------------------------------------------------------------------------------

const ready = (windows: CodexLimits['windows'], reached?: boolean): CodexLimits => ({ status: 'ready', windows, at: 1, checkedAt: 1, ...(reached ? { reached } : {}) });

test('pickReset: the latest reset among the windows at 100%', () => {
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 100, resetsAt: 5000 }, { label: 'Weekly', pct: 40, resetsAt: 90_000 }])), 5000);
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 100, resetsAt: 5000 }, { label: 'Weekly', pct: 100, resetsAt: 90_000 }])), 90_000);
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 40, resetsAt: 5000 }, { label: 'Weekly', pct: 100, resetsAt: 90_000 }])), 90_000);
});

test('pickReset: reached while no window is at 100% yet (the percentages lag): the fullest window\'s reset', () => {
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 99, resetsAt: 5000 }, { label: 'Weekly', pct: 40, resetsAt: 9000 }], true)), 5000);
});

test('pickReset: none at 100%, no reset time, or not ready: unknown', () => {
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 99, resetsAt: 5000 }, { label: 'Weekly', pct: 40, resetsAt: 9000 }])), undefined, 'not reached');
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 100 }])), undefined);
  assert.equal(pickReset(ready([{ label: '5-hour', pct: 99 }, { label: 'Weekly', pct: 40 }], true)), undefined, 'reached, but no reset time at all');
  assert.equal(pickReset({ ...ready([{ label: '5-hour', pct: 100, resetsAt: 5000 }]), status: 'error' }), undefined);
});

// --- the reader, with a fake ask and clock ----------------------------------------------------------

const good: Answer = { result: { rateLimits: { planType: 'plus', primary: win(30, 300) } }, auth: 'chatgpt' };

function rig(t: test.TestContext, opts: { codexPath?: () => string | null; answers?: Answer[]; second?: boolean } = {}) {
  if (!opts.second) t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000_000;
  const answers = opts.answers ?? [];
  const calls: { env: Record<string, string>; signal?: AbortSignal }[] = [];
  const changes: CodexLimits[] = [];
  const ask: Ask = async (_codex, env, signal) => {
    calls.push({ env, signal });
    return answers.shift() ?? good;
  };
  const reader = new CodexLimitsReader({ codexPath: opts.codexPath ?? (() => '/bin/codex'), env: { CODEX_HOME: '/h' }, onChange: (s) => changes.push(s), ask, now: () => clock });
  t.after(() => reader.close());
  const advance = async (ms: number) => {
    // In steps, so a timer set by a read that a tick caused is also reached.
    for (let left = ms; left > 0; ) {
      const step = Math.min(left, 10_000);
      clock += step;
      t.mock.timers.tick(step);
      await flush();
      left -= step;
    }
  };
  return { reader, calls, changes, advance, answers, clock: () => clock };
}

test('with no watchers nothing is ever asked, however long it waits', async (t) => {
  const r = rig(t);
  await r.advance(3 * 3_600_000);
  assert.equal(r.calls.length, 0);
  assert.equal(r.reader.state.status, 'off');
});

test('the first watcher reads once; watching again within the poll does not read; it polls every 2 minutes only while watched', async (t) => {
  const r = rig(t);
  r.reader.watch('a');
  await r.advance(1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.reader.state.status, 'ready');
  assert.deepEqual(r.changes.map((s) => s.status), ['checking', 'ready']);
  assert.equal(r.calls[0].env.CODEX_HOME, '/h');
  r.reader.watch('b'); // a second tab
  r.reader.unwatch('b');
  r.reader.unwatch('a'); // a tab switch away and back
  r.reader.watch('a');
  await r.advance(60_000);
  assert.equal(r.calls.length, 1, 'a reconnect or tab switch within 2 minutes reads nothing');
  await r.advance(60_000);
  assert.equal(r.calls.length, 2, 'a poll');
  await r.advance(2 * 60_000);
  assert.equal(r.calls.length, 3);
  r.reader.unwatch('a');
  await r.advance(3_600_000);
  assert.equal(r.calls.length, 3, 'no timer once nobody watches');
});

test('watching with a cache older than the poll reads at once', async (t) => {
  const r = rig(t);
  r.reader.watch('a');
  await r.advance(1);
  r.reader.unwatch('a');
  await r.advance(5 * 60_000);
  r.reader.watch('a');
  await r.advance(1);
  assert.equal(r.calls.length, 2);
});

test('refresh: at most every 20 seconds, and a running read is shared', async (t) => {
  const r = rig(t);
  await r.reader.refresh();
  assert.equal(r.calls.length, 1);
  await r.reader.refresh();
  assert.equal(r.calls.length, 1, 'too soon');
  await r.advance(21_000);
  const [p, q] = [r.reader.refresh(), r.reader.refresh()];
  await Promise.all([p, q]);
  assert.equal(r.calls.length, 2, 'two clicks at once make one read');
});

test('signed out: the next automatic read is 30 minutes away, a click still reads', async (t) => {
  const r = rig(t, { answers: [{ result: {}, auth: 'apikey' }] });
  r.reader.watch('a');
  await r.advance(1);
  assert.equal(r.reader.state.status, 'signedOut');
  await r.advance(29 * 60_000);
  assert.equal(r.calls.length, 1);
  await r.advance(2 * 60_000);
  assert.equal(r.calls.length, 2);
  assert.equal(r.reader.state.status, 'ready');
  const s = rig(t, { answers: [{ result: {}, auth: 'apikey' }], second: true });
  await s.reader.refresh();
  await s.advance(30_000);
  await s.reader.refresh();
  assert.equal(s.calls.length, 2);
});

test('an auth error from the app-server is signedOut too', async (t) => {
  const r = rig(t, { answers: [{ error: 'You are not logged in' }] });
  await r.reader.refresh();
  assert.equal(r.reader.state.status, 'signedOut');
});

test('a network failure that mentions auth is an error keeping the last windows, not signedOut', async (t) => {
  const r = rig(t, { answers: [good, { error: 'failed to refresh auth token: network unreachable' }] });
  await r.reader.refresh();
  await r.advance(21_000);
  await r.reader.refresh();
  assert.equal(r.reader.state.status, 'error');
  assert.equal(r.reader.state.windows.length, 1);
});

test('a codex that was removed (ENOENT): status missing, and the path is forgotten', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let forgot = 0;
  const reader = new CodexLimitsReader({ codexPath: () => '/gone/codex', env: {}, onChange: () => {}, onMissing: () => forgot++, ask: async () => ({ error: 'spawn /gone/codex ENOENT' }) });
  t.after(() => reader.close());
  await reader.refresh();
  assert.equal(reader.state.status, 'missing');
  assert.equal(forgot, 1);
});

test('three failures in a row: a 10-minute pause; a failed read keeps the last good windows', async (t) => {
  const r = rig(t, { answers: [good, { error: 'boom' }, { error: 'boom' }, { error: 'boom' }] });
  r.reader.watch('a');
  await r.advance(1);
  await r.advance(2 * 60_000);
  assert.equal(r.reader.state.status, 'error');
  assert.equal(r.reader.state.windows.length, 1, 'the last good ones');
  assert.equal(r.reader.state.at > 0, true);
  await r.advance(2 * 60_000);
  await r.advance(2 * 60_000);
  assert.equal(r.calls.length, 4);
  await r.advance(9 * 60_000);
  assert.equal(r.calls.length, 4, 'backing off');
  await r.advance(2 * 60_000);
  assert.equal(r.calls.length, 5);
});

test('no codex: status missing, never asked; it looks again later', async (t) => {
  let path: string | null = null;
  const r = rig(t, { codexPath: () => path });
  r.reader.watch('a');
  await r.advance(1);
  assert.equal(r.reader.state.status, 'missing');
  await r.advance(5 * 60_000);
  assert.equal(r.calls.length, 0);
  path = '/bin/codex';
  await r.advance(6 * 60_000);
  assert.equal(r.calls.length, 1);
  assert.equal(r.reader.state.status, 'ready');
});

test('fresh: reads at once whatever the cache and the 20-second gap; a read already under way does not count; a slow one is given up on after waitMs', async (t) => {
  const r = rig(t);
  await r.reader.refresh();
  assert.equal(r.calls.length, 1);
  assert.equal((await r.reader.fresh(5000))?.status, 'ready');
  assert.equal(r.calls.length, 2, 'read again straight away');
  assert.equal(r.reader.watching, 0);
  await r.advance(3 * 60_000);
  assert.equal(r.calls.length, 2, 'asking for it starts no polling');
  // A read that began before the call is waited for, and another follows it.
  const gates: (() => void)[] = [];
  const slow = rig(t, { second: true });
  const r2 = new CodexLimitsReader({
    codexPath: () => '/bin/codex',
    env: {},
    onChange: () => {},
    ask: () => new Promise<Answer>((res) => gates.push(() => res(good))),
    now: slow.clock,
  });
  t.after(() => r2.close());
  void r2.refresh();
  await flush();
  await slow.advance(1000);
  const p = r2.fresh(5000);
  await flush();
  assert.equal(gates.length, 1);
  gates[0]();
  await flush();
  await flush();
  assert.equal(gates.length, 2, 'a new read after the old one');
  gates[1]();
  assert.equal((await p)?.status, 'ready');
  // A read that never finishes: undefined after waitMs.
  const r3 = new CodexLimitsReader({ codexPath: () => '/bin/codex', env: {}, onChange: () => {}, ask: () => new Promise<Answer>(() => {}), now: slow.clock });
  t.after(() => r3.close());
  const q = r3.fresh(5000);
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(await q, undefined);
});

test('fresh: a read that was under way finishing during the wait is not the fresh one; the next hanging past waitMs gives undefined', async (t) => {
  const slow = rig(t);
  const gates: (() => void)[] = [];
  const r = new CodexLimitsReader({
    codexPath: () => '/bin/codex',
    env: {},
    onChange: () => {},
    ask: (_c, _e, signal) => new Promise<Answer>((res) => (gates.push(() => res(good)), signal?.addEventListener('abort', () => res({ error: 'stopped' })))),
    now: slow.clock,
  });
  t.after(() => r.close());
  void r.refresh();
  await flush();
  await slow.advance(1000);
  const p = r.fresh(5000);
  await flush();
  gates[0](); // the old read finishes during the wait...
  await flush();
  await flush();
  assert.equal(gates.length, 2); // ...and the one that counts hangs
  await slow.advance(5000);
  assert.equal(await p, undefined);
});

test('fresh: once the wait has run out, no further read is started', async (t) => {
  const slow = rig(t);
  const gates: (() => void)[] = [];
  const r = new CodexLimitsReader({ codexPath: () => '/bin/codex', env: {}, onChange: () => {}, ask: () => new Promise<Answer>((res) => gates.push(() => res(good))), now: slow.clock });
  t.after(() => r.close());
  void r.refresh();
  await flush();
  await slow.advance(1000);
  const p = r.fresh(5000);
  await flush();
  await slow.advance(5000);
  assert.equal(await p, undefined);
  gates[0](); // the old read ends after the wait did
  await flush();
  await flush();
  assert.equal(gates.length, 1, 'no new read was started for a caller that has gone');
});

test('close ends a running read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const reader = new CodexLimitsReader({ codexPath: () => '/bin/codex', env: {}, onChange: () => {}, ask: (_c, _e, s) => ((signal = s), new Promise<Answer>(() => {})) });
  void reader.refresh();
  await flush();
  reader.close();
  assert.equal(signal?.aborted, true);
});

// --- askAppServer, against a fake codex ---------------------------------------------------------------

const FAKE = `#!/usr/bin/env node
const mode = process.env.FAKE_MODE || 'ok';
const home = require('node:path').basename(process.env.CODEX_HOME || '');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (mode === 'hang') continue;
    if (m.id === 1) {
      if (mode === 'big') return void process.stdout.write('x'.repeat(2 * 1024 * 1024));
      process.stdout.write(JSON.stringify({ id: 1, result: { codexHome: process.env.CODEX_HOME } }) + '\\n');
    } else if (m.id === 2) {
      process.stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } }) + '\\n');
      process.stdout.write(JSON.stringify({ id: 2, result: { argv: process.argv.slice(2), rateLimits: { planType: home, primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 } } } }) + '\\n');
    }
  }
});
`;

function fakeCodex(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-codex-'));
  const file = path.join(dir, 'codex');
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

test('askAppServer: the app-server is asked with fixed arguments and the CODEX_HOME it is given', { skip: process.platform === 'win32' }, async () => {
  const codex = fakeCodex();
  for (const home of ['/x/alpha', '/x/beta']) {
    const a = await askAppServer(codex, { ...(process.env as Record<string, string>), CODEX_HOME: home });
    assert.equal(a.error, undefined);
    assert.equal(a.auth, 'chatgpt');
    const r = a.result as { argv: string[] };
    assert.deepEqual(r.argv, ['app-server', '--listen', 'stdio://']);
    const s = codexPlanLimits(a.result, a.auth, 1);
    assert.equal(s.plan, path.basename(home));
    assert.equal(s.windows[0].pct, 42);
  }
});

test('askAppServer: one that never answers times out; one that says too much is cut off', { skip: process.platform === 'win32' }, async () => {
  const codex = fakeCodex();
  const env = process.env as Record<string, string>;
  const hung = await askAppServer(codex, { ...env, FAKE_MODE: 'hang' }, undefined, { timeoutMs: 300 });
  assert.equal(hung.error, 'timed out');
  const big = await askAppServer(codex, { ...env, FAKE_MODE: 'big' });
  assert.equal(big.error, 'too much output');
  const none = await askAppServer(path.join(tmpdir(), 'no-such-codex'), env);
  assert.ok(none.error);
  const ac = new AbortController();
  const stopped = askAppServer(codex, { ...env, FAKE_MODE: 'hang' }, ac.signal);
  ac.abort();
  assert.equal((await stopped).error, 'stopped');
});

// --- the registry -------------------------------------------------------------------------------------

function office() {
  const sent: { to: string; msg: { t: string; state?: CodexLimits } }[] = [];
  const clients = new Map<string, Client>();
  const ctx = { clients, sendTo: (c: Client, msg: never) => void sent.push({ to: c.id, msg }) } as unknown as Ctx;
  const join = (id: string, out = false) => {
    const c = { id, out } as unknown as Client;
    clients.set(id, c);
    return c;
  };
  return { ctx, sent, join, clients };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'timed out');
}

test('registry: a home spelled two ways is one reader; each watcher hears only its own home; signed-out clients are skipped; leaving unwatches', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  const real = path.join(root, 'real');
  const other = path.join(root, 'other');
  mkdirSync(real);
  mkdirSync(other);
  symlinkSync(real, path.join(root, 'link'));
  const asked: string[] = [];
  const o = office();
  const homes: Record<string, string> = {};
  const reg = codexLimitsOf(o.ctx, {
    codexPath: () => '/bin/codex',
    homeOf: (c) => homes[c.id],
    ask: async (_c, env) => {
      asked.push(env.CODEX_HOME);
      return { result: { rateLimits: { planType: path.basename(env.CODEX_HOME), primary: win(10, 300) } }, auth: 'chatgpt' };
    },
  });
  t.after(() => closeCodexLimits(o.ctx));
  const [a, b, c, d] = [o.join('a'), o.join('b'), o.join('c'), o.join('d', true)];
  Object.assign(homes, { a: path.join(root, 'link'), b: real, c: other, d: other });
  reg.watch(a);
  reg.watch(b);
  reg.watch(c);
  reg.watch(d);
  await until(() => o.sent.filter((s) => s.msg.state?.status === 'ready').length >= 3);
  assert.deepEqual(asked.sort(), [realpathSync(real), realpathSync(other)].sort(), 'one read per home');
  const ready = (id: string) => o.sent.filter((s) => s.to === id && s.msg.state?.status === 'ready').map((s) => s.msg.state!.plan);
  assert.deepEqual(ready('a'), ['real']);
  assert.deepEqual(ready('b'), ['real']);
  assert.deepEqual(ready('c'), ['other']);
  assert.equal(o.sent.some((s) => s.to === 'd'), false, 'a signed-out client is sent nothing');
});

test('registry: a client that left (the closed hook) or was signed out is not sent a read that was already under way', async (t) => {
  const o = office();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  const reg = codexLimitsOf(o.ctx, {
    codexPath: () => '/bin/codex',
    ask: async () => {
      started = true;
      await gate;
      return { result: { rateLimits: { primary: win(10, 300) } }, auth: 'chatgpt' };
    },
  });
  t.after(() => closeCodexLimits(o.ctx));
  const [a, b, c] = [o.join('a'), o.join('b'), o.join('c')];
  reg.watch(a);
  reg.watch(b);
  reg.watch(c);
  await until(() => started);
  codexLimitsHooks.closed!(o.ctx, b);
  o.clients.delete('b');
  c.out = true;
  o.sent.length = 0;
  release();
  await until(() => o.sent.some((s) => s.to === 'a' && s.msg.state?.status === 'ready'));
  assert.deepEqual([...new Set(o.sent.map((s) => s.to))], ['a']);
});

test('registry: resetAt reads afresh: a poll at 97%, then the limit is hit, and the reset of the window now at 100% comes back', async (t) => {
  const o = office();
  const percents = [97, 100];
  let reads = 0;
  const reg = codexLimitsOf(o.ctx, {
    codexPath: () => '/bin/codex',
    ask: async () => ({ result: { rateLimits: { planType: 'plus', primary: win(percents[Math.min(reads++, 1)], 300, 1_800_000_000) } }, auth: 'chatgpt' }),
  });
  t.after(() => closeCodexLimits(o.ctx));
  reg.watch(o.join('a'));
  await until(() => reads === 1);
  await until(() => o.sent.some((s) => s.msg.state?.status === 'ready'));
  assert.equal(await reg.resetAt(), 1_800_000_000_000, 'the cache said 97%, a fresh read says 100%');
  assert.equal(reads, 2);
});
