import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs, settlePlan, expandFlowArgs, buildJobs, subjectSlug, shotFileName, findNameCollisions,
  runPool, summaryLine, suiteLine, assignStatePaths, sidedStatePath, stateMissingOrigin, nonNegNum, labelName, usableState, hasLegacySessionStorage, scrubUrls, displayUrl, safeOrigin, writeFileAtomic,
} from './flow-suite.mjs';

const UI_IMAGE_RE = /^[a-z0-9][a-z0-9._-]{0,80}-(before|after)\.png$/;

test('parseArgs: boolean flags only consume true/false-like values', () => {
  const a = parseArgs(['--flow', 'a.json', '--settle', 'b.json', '--mobile', '--width', '500']);
  assert.deepEqual(a.flow, 'a.json');
  assert.equal(a.settle, true);
  assert.deepEqual(a._, ['b.json']);
  assert.equal(a.mobile, true);
  assert.equal(a.width, '500');
  assert.equal(parseArgs(['--settle', 'false']).settle, 'false');
  assert.equal(parseArgs(['--no-settle', '0', 'x.json'])['no-settle'], '0');
  assert.deepEqual(parseArgs(['--no-settle', 'x.json'])._, ['x.json']);
  assert.equal(parseArgs(['--settle=false']).settle, 'false');
  assert.deepEqual(parseArgs(['--flow', 'a', '--flow', 'b']).flow, ['a', 'b']);
});

test('settlePlan: idle is skipped by waitSelector or assertions-only, load wait replaces it', () => {
  assert.deepEqual(settlePlan({ timeout: 30000 }), { idleMs: 2000, loadMs: 0, delayMs: 800 });
  assert.deepEqual(settlePlan({ timeout: 1000 }), { idleMs: 1000, loadMs: 0, delayMs: 800 });
  assert.deepEqual(settlePlan({ hasWaitSelector: true }), { idleMs: 0, loadMs: 2000, delayMs: 0 });
  assert.deepEqual(settlePlan({ hasAssertions: true }), { idleMs: 0, loadMs: 2000, delayMs: 800 });
  assert.equal(settlePlan({ hasAssertions: true, hasInteraction: true }).idleMs, 2000);
});

test('settlePlan: explicit delay, no-settle, force and cap', () => {
  assert.equal(settlePlan({ hasWaitSelector: true, delayExplicit: true, delay: 5 }).delayMs, 5);
  assert.deepEqual(settlePlan({ setting: false, hasWaitSelector: true }), { idleMs: 0, loadMs: 0, delayMs: 0 });
  assert.deepEqual(settlePlan({ setting: false }), { idleMs: 0, loadMs: 0, delayMs: 800 });
  assert.equal(settlePlan({ setting: true, hasWaitSelector: true }).idleMs, 2000);
  assert.equal(settlePlan({ settleTimeout: 8000 }).idleMs, 8000);
  assert.equal(settlePlan({ settleTimeout: 8000, timeout: 3000 }).idleMs, 3000);
});

test('expandFlowArgs: repeated flags, folders, json positionals, skipped non-flows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-suite-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.json'), JSON.stringify({ steps: [] }));
  await writeFile(join(dir, 'sub', 'a.json'), JSON.stringify({ steps: [{}] }));
  await writeFile(join(dir, 'sub', 'state.json'), JSON.stringify({ cookies: [] }));
  await writeFile(join(dir, 'sub', 'notes.txt'), 'x');
  await writeFile(join(dir, 'sub', 'c-broken.json'), '{ "steps": [ oops');
  const one = join(dir, 'one.json');
  const folder = await expandFlowArgs({ flow: [join(dir, 'sub'), one], _: [one, 'ignored.txt', join(dir, 'two.json')] });
  assert.deepEqual(folder.files, [join(dir, 'sub', 'a.json'), join(dir, 'sub', 'b.json'), join(dir, 'sub', 'c-broken.json'), one, join(dir, 'two.json')]);
  assert.equal(folder.notes.length, 1);
  assert.match(folder.notes[0], /state\.json/);
  assert.deepEqual((await expandFlowArgs({ _: ['x.json'] })).files, []);
  // A glob positional that is not a flow is skipped; the same file named by --flow stays a job.
  const notFlow = join(dir, 'sub', 'state.json');
  const glob = await expandFlowArgs({ flow: one, _: [notFlow, join(dir, 'sub', 'a.json')] });
  assert.deepEqual(glob.files, [one, join(dir, 'sub', 'a.json')]);
  assert.match(glob.notes[0], /state\.json/);
  assert.deepEqual((await expandFlowArgs({ flow: notFlow })).files, [notFlow]);
});

test('buildJobs: sides, overrides and naming', () => {
  const entries = [{ path: '/x/one.json', flow: { name: 'one', baseUrl: 'http://flow' } }, { path: '/x/two.json', flow: {} }];
  const plain = buildJobs(entries, {});
  assert.deepEqual(plain.map(j => [j.label, j.baseUrl, j.side, j.multi]), [['one', 'http://flow', null, true], ['two', null, null, true]]);
  const sided = buildJobs(entries.slice(0, 1), { beforeUrl: 'http://b', afterUrl: 'http://a' });
  assert.deepEqual(sided.map(j => [j.label, j.baseUrl, j.seq]), [['one@before', 'http://b', 1], ['one@after', 'http://a', 2]]);
  assert.equal(buildJobs(entries.slice(0, 1), { afterUrl: 'http://a' })[0].side, 'after');
  const side = buildJobs(entries.slice(0, 1), { baseUrl: 'http://o', side: 'after' })[0];
  assert.deepEqual([side.side, side.baseUrl, side.multi], ['after', 'http://o', false]);
  assert.throws(() => buildJobs(entries, { side: 'x' }));
  assert.throws(() => buildJobs(entries, { side: 'before', beforeUrl: 'http://b' }));
  assert.throws(() => buildJobs(entries, { baseUrl: 'http://o', afterUrl: 'http://a' }), /--base-url/);
  assert.equal(buildJobs([{ path: '/x/y.json', flow: { name: 'my  flow\tx' } }], { side: 'after' })[0].label, 'my-flow-x@after');
  assert.equal(labelName('a b'), 'a-b');
});

test('subjectSlug and shotFileName follow the task image name rule', () => {
  assert.equal(subjectSlug('01 Kori / Mobile!'), '01-kori-mobile-');
  assert.equal(subjectSlug('---X'), 'x');
  assert.equal(subjectSlug('ÄÖ'), 'shot');
  for (const name of ['Home Page', '_x', 'a'.repeat(300), '.hidden', 'ok.v2_a-b']) {
    for (const side of ['before', 'after']) {
      assert.match(shotFileName({ name: 'f', side, namedBySide: true }, name, 1, 0), UI_IMAGE_RE, name);
    }
  }
  assert.equal(shotFileName({ name: 'My Flow', side: 'after', namedBySide: true }, null, 3, 0), 'my-flow-shot-3-after.png');
  // A side without --out-dir keeps the timestamp so nothing is overwritten in tmp.
  assert.equal(shotFileName({ name: 'f', side: 'before' }, 'Home', 1, 99), 'f-Home-before-99.png');
  assert.equal(shotFileName({ name: 'my flow', side: null }, 'Home', 1, 1234), 'my-flow-Home-1234.png');
  assert.equal(shotFileName({ name: 'f', side: null, multi: true, seq: 2 }, null, 1, 9), 'f-shot-1-9-2.png');
});

test('findNameCollisions only flags sided duplicates', () => {
  const flow = steps => ({ steps });
  const jobs = [
    { label: 'a@before', side: 'before', namedBySide: true, name: 'a', flow: flow([{ shot: 'Home' }, { shot: true }]) },
    { label: 'b@before', side: 'before', namedBySide: true, name: 'b', flow: flow([{ shot: 'home' }, { shot: true }]) },
    { label: 'a@after', side: 'after', namedBySide: true, name: 'a', flow: flow([{ shot: 'Home' }]) },
    { label: 'bad', side: 'before', namedBySide: true, name: 'bad', flow: undefined },
  ];
  assert.deepEqual(findNameCollisions(jobs), [{ file: 'home-before.png', owners: ['a@before', 'b@before'] }]);
  assert.deepEqual(findNameCollisions(jobs.map(j => ({ ...j, namedBySide: false }))), []);
});

test('runPool respects the limit, keeps order and survives rejections', async () => {
  let running = 0, peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async n => {
    running++; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 10));
    running--;
    if (n === 3) throw new Error('boom');
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[4].value, 10);
  assert.equal(results[2].reason.message, 'boom');
  assert.deepEqual(await runPool([], 4, async () => 1), []);
});

test('state paths: per-side files and read-only shared paths', () => {
  assert.equal(sidedStatePath('/t/s.json', 'before'), '/t/s.before.json');
  const jobs = [{ side: 'before', flow: {} }, { side: 'after', flow: {} }];
  const present = new Set(['/t/s.before.json', '/t/s.after.json']);
  assert.deepEqual(assignStatePaths(jobs, '/t/s.json', p => present.has(p)), []);
  assert.deepEqual(jobs.map(j => [j.statePath, j.stateWritable]), [['/t/s.before.json', true], ['/t/s.after.json', true]]);
  // Only the unsided file exists: it is NOT used (a session belongs to one address).
  const fb = [{ side: 'before', label: 'a@before', flow: {} }, { side: 'after', label: 'a@after', flow: {} }];
  const fbNotes = assignStatePaths(fb, '/t/s.json', p => p === '/t/s.json');
  assert.deepEqual(fb.map(j => [j.statePath, j.stateWritable]), [['/t/s.before.json', true], ['/t/s.after.json', true]]);
  assert.equal(fbNotes.length, 2);
  assert.match(fbNotes[0], /session starts empty.*not used because a session belongs to one address.*--before-url and --after-url/);
  // Neither exists in a sided run: one note per path, still writable.
  const none2 = [{ side: 'before', flow: {} }, { side: 'after', flow: {} }];
  const n2 = assignStatePaths(none2, '/t/s.json', () => false);
  assert.equal(n2.length, 2);
  assert.match(n2[0], /session starts empty/);
  assert.equal(none2[0].stateWritable, true);
  const shared = [{ side: null, flow: {} }, { side: null, flow: {} }, { side: null, flow: { state: '/t/own.json' } }];
  const notes = assignStatePaths(shared, '/t/s.json', () => true);
  assert.equal(notes.length, 1);
  assert.deepEqual(shared.map(j => j.stateWritable), [false, false, true]);
  const none = [{ flow: {} }];
  assignStatePaths(none, null);
  assert.deepEqual([none[0].statePath, none[0].stateWritable], [null, false]);
});

test('stateMissingOrigin checks cookies and origins for the job origin', () => {
  const url = 'http://127.0.0.1:5001/x';
  assert.equal(stateMissingOrigin(null, url), false);
  assert.equal(stateMissingOrigin({ cookies: [], origins: [] }, url), true);
  assert.equal(stateMissingOrigin({ cookies: [{ domain: '127.0.0.1' }], origins: [] }, url), false);
  assert.equal(stateMissingOrigin({ cookies: [], origins: [{ origin: 'http://127.0.0.1:5001' }] }, url), false);
  assert.equal(stateMissingOrigin({ cookies: [], origins: [{ origin: 'http://127.0.0.1:5002' }] }, url), true);
  assert.equal(stateMissingOrigin({ cookies: [{ domain: '.example.com' }] }, 'https://app.example.com/'), false);
});

test('summary lines', () => {
  assert.equal(summaryLine({ name: 'a', side: 'before', status: 'passed', shots: ['x', 'y'], reportPath: '/r.json' }),
    'FLOW a@before passed shots=2 report=/r.json');
  assert.equal(summaryLine({ name: 'a', status: 'capture-only', shots: 1 }), 'FLOW a capture-only shots=1');
  assert.equal(summaryLine({ name: 'a', status: 'failed', shots: [], reportPath: '/r', stateMissingOrigin: true, failedStep: 3,
    failure: { kind: 'assertion', index: 2, type: 'visible', reason: 'not-found', matches: 0 } }),
  'FLOW a failed shots=0 state=missing-origin report=/r failed-step=3 assertion 2 visible: not-found, matches=0');
  assert.equal(summaryLine({ name: 'a', status: 'failed', shots: [], failedStep: 1, failure: { kind: 'step', type: 'waitSelector', reason: 'timeout' } }),
    'FLOW a failed shots=0 failed-step=1 step waitSelector: timeout');
  assert.equal(summaryLine({ name: 'a', status: 'failed', shots: [], error: 'bad\nflow' }), 'FLOW a failed shots=0 error=bad flow');
  assert.equal(suiteLine([{ status: 'passed' }, { status: 'failed' }, { status: 'capture-only' }, { status: 'passed' }], 1234.4),
    'SUITE 2/4 passed, 1 failed, 1 capture-only, 1234 ms');
});

test('nonNegNum accepts an explicit 0', () => {
  assert.equal(nonNegNum('0', 800), 0);
  assert.equal(nonNegNum(0, 800), 0);
  assert.equal(nonNegNum(undefined, 800), 800);
  assert.equal(nonNegNum(true, 800), 800);
  assert.equal(nonNegNum('-1', 800), 800);
  assert.equal(settlePlan({ delay: 0, delayExplicit: true }).delayMs, 0);
});

test('usableState drops sessionStorage that belongs to another origin', () => {
  const state = { cookies: [], origins: [{ origin: 'http://a:1' }], sessionStorage: { token: 'x' }, sessionStorageOrigin: 'http://a:1' };
  assert.deepEqual(usableState(state, 'http://b:2/'), { state: { ...state, sessionStorage: {} }, missingOrigin: true });
  assert.equal(usableState(state, 'http://a:1/').state.sessionStorage.token, 'x');
  assert.deepEqual(usableState(null, 'http://a:1/'), { state: null, missingOrigin: false });
});

test('safeOrigin keeps only the origin', () => {
  assert.equal(safeOrigin('http://h:1/path?token=1'), 'http://h:1');
  assert.equal(safeOrigin('not a url'), '[redacted]');
  assert.equal(safeOrigin(null), null);
});

test('writeFileAtomic writes mode 0600 and leaves no temp file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-suite-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 's.json');
  await writeFile(file, 'old', { mode: 0o644 });
  await writeFileAtomic(file, '{"a":1}');
  assert.equal(await readFile(file, 'utf8'), '{"a":1}');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['s.json']);
  await assert.rejects(writeFileAtomic(join(dir, 'missing', 's.json'), 'x'));
});

test('summaryLine shows the drag destination', () => {
  assert.match(summaryLine({ name: 'a', status: 'failed', shots: [], failedStep: 2,
    failure: { kind: 'action', index: 1, type: 'drag', target: 'to', reason: 'not-found', matches: 0 } }),
  /failed-step=2 action 1 drag \(to\): not-found, matches=0$/);
});

test('stateMissingOrigin uses the saved sessionStorage origin; legacy files bind to the target', () => {
  const saved = { cookies: [], origins: [], sessionStorage: { token: 'x' }, sessionStorageOrigin: 'http://a:1' };
  assert.equal(stateMissingOrigin(saved, 'http://a:1/x'), false);
  assert.equal(stateMissingOrigin(saved, 'http://b:2/x'), true);
  const legacy = { cookies: [], origins: [], sessionStorage: { token: 'x' } };
  assert.equal(stateMissingOrigin(legacy, 'http://b:2/x'), true);
  assert.equal(hasLegacySessionStorage(legacy), true);
  assert.equal(hasLegacySessionStorage(saved), false);
  assert.equal(hasLegacySessionStorage({ sessionStorage: {} }), false);
  assert.equal(stateMissingOrigin({ cookies: [], origins: [], sessionStorage: {} }, 'http://a:1/'), true);
});

test('URL scrubbing and goto address handle parentheses and IPv6', () => {
  const url = 'http://[::1]:8080/a(1)/b?token=T';
  assert.equal(displayUrl(url), 'http://[::1]:8080');
  assert.equal(displayUrl('https://example.test/items(42)/detail?token=TEST'), 'https://example.test');
  assert.equal(displayUrl(url, true), url);
  assert.equal(displayUrl('not a url'), '[redacted-url]');
  assert.equal(scrubUrls(`goto ${url} failed`), 'goto http://[::1]:8080 failed');
  assert.equal(scrubUrls('see https://example.test/items(42)/detail?token=TEST now'), 'see https://example.test now');
  assert.equal(scrubUrls('"https://h.test/x]y?t=1"'), '"https://h.test"');
  assert.equal(scrubUrls('http://:bad/x?t=1 end'), '[redacted-url] end');
});
