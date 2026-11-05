// Shell tabs: real /bin/sh ptys in a tmp dir, driven through ShellTabs with fake clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellTabServerMsg } from '../src/shared/shelltabs/protocol.js';
import type { Client } from '../src/server/office/client.js';
import { ShellTabs, MAX_SHELL_TABS } from '../src/server/shelltabs/shells.js';

const skip = process.platform === 'win32';
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shelltabs-')));

function setup() {
  const sent: { c: Client; msg: ShellTabServerMsg }[] = [];
  const tabs = new ShellTabs(
    {
      send: (c, msg) => sent.push({ c, msg }),
      spec: (id) => (id === 'gone' ? 'That worker is no longer in the building' : { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' } }),
    },
    { shell: '/bin/sh', args: [] },
  );
  const client = () => ({}) as Client;
  const last = (c: Client) => sent.filter((s) => s.c === c && s.msg.t === 'shelltab.tabs').map((s) => s.msg).at(-1) as Extract<ShellTabServerMsg, { t: 'shelltab.tabs' }>;
  const output = (c: Client, tabId: string) => sent.filter((s) => s.c === c && s.msg.t === 'shelltab.data' && s.msg.tabId === tabId).map((s) => (s.msg as { data: string }).data).join('');
  const until = async (ok: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), 'timed out');
  };
  return { tabs, sent, client, last, output, until };
}

test('open lists the tab, tells the opener, attach sends a snapshot', { skip }, () => {
  const { tabs, sent, client, last } = setup();
  try {
    const sub = client();
    const opener = client();
    tabs.list(sub, 'w1');
    assert.deepEqual(last(sub).tabs, []);
    assert.equal(tabs.open(opener, 'w1', 'Ann'), undefined);
    const mine = last(opener);
    assert.equal(mine.tabs.length, 1);
    assert.equal(mine.tabs[0].title, '🐚 Shell 1');
    assert.equal(mine.tabs[0].by, 'Ann');
    assert.equal(mine.opened, mine.tabs[0].id);
    assert.equal(last(sub).tabs.length, 1);
    assert.equal(last(sub).opened, undefined);
    tabs.attach(opener, mine.opened!);
    const snap = sent.find((s) => s.msg.t === 'shelltab.snapshot');
    assert.ok(snap && snap.c === opener);
  } finally {
    tabs.closeAll();
  }
});

test('input runs in the worker folder; input without attach is ignored', { skip }, async () => {
  const { tabs, client, last, output, until } = setup();
  try {
    const c = client();
    const other = client();
    tabs.open(c, 'w1', 'Ann');
    const id = last(c).opened!;
    tabs.input(other, id, 'echo nope\n'); // not attached
    tabs.attach(c, id);
    tabs.input(c, id, 'echo hi; pwd\n');
    await until(() => output(c, id).includes(dir));
    assert.match(output(c, id), /hi/);
    assert.ok(!output(c, id).includes('nope\r\n'));
  } finally {
    tabs.closeAll();
  }
});

test('close and exit remove the tab; the next one takes the lowest free number', { skip }, async () => {
  const { tabs, client, last, until } = setup();
  try {
    const c = client();
    tabs.list(c, 'w1');
    tabs.open(c, 'w1', 'Ann');
    tabs.open(c, 'w1', 'Ann');
    const [a, b] = last(c).tabs;
    tabs.close(a.id);
    assert.deepEqual(last(c).tabs.map((t) => t.id), [b.id]);
    tabs.attach(c, b.id);
    tabs.input(c, b.id, 'exit\n');
    await until(() => last(c).tabs.length === 0);
    tabs.open(c, 'w1', 'Ann');
    assert.equal(last(c).tabs[0].title, '🐚 Shell 1');
  } finally {
    tabs.closeAll();
  }
});

test('a worker going home ends its shells; the limit is six; a refused spec warns', { skip }, () => {
  const { tabs, client, last } = setup();
  try {
    const c = client();
    tabs.list(c, 'w1');
    for (let i = 0; i < MAX_SHELL_TABS; i++) assert.equal(tabs.open(c, 'w1', 'Ann'), undefined);
    assert.match(tabs.open(c, 'w1', 'Ann') ?? '', /at most 6/);
    assert.equal(tabs.open(c, 'gone', 'Ann'), 'That worker is no longer in the building');
    tabs.removeWorker('w1');
    assert.equal(last(c).tabs.length, 0);
  } finally {
    tabs.closeAll();
  }
});

test('resize with zero or junk does not throw', { skip }, () => {
  const { tabs, client, last } = setup();
  try {
    const c = client();
    tabs.open(c, 'w1', 'Ann');
    const id = last(c).opened!;
    tabs.attach(c, id);
    tabs.resize(c, id, 0, 0);
    tabs.resize(c, id, NaN, 9999);
    tabs.resize(c, id, 100, 30);
  } finally {
    tabs.closeAll();
  }
});

test('a viewer whose socket is backed up skips output and gets a snapshot once it drains', { skip }, async () => {
  const { tabs, sent, last, until } = setup();
  try {
    const slow = { ws: { bufferedAmount: 100 * 1024 * 1024 } } as unknown as Client;
    tabs.open(slow, 'w1', 'Ann');
    const id = last(slow).opened!;
    tabs.attach(slow, id);
    const datas = () => sent.filter((s) => s.c === slow && s.msg.t === 'shelltab.data').length;
    const snaps = () => sent.filter((s) => s.c === slow && s.msg.t === 'shelltab.snapshot').length;
    tabs.input(slow, id, 'echo one\n');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(datas(), 0);
    assert.equal(snaps(), 1); // just the attach
    (slow as unknown as { ws: { bufferedAmount: number } }).ws.bufferedAmount = 0;
    await until(() => snaps() === 2, 4000);
    assert.equal(datas(), 0);
  } finally {
    tabs.closeAll();
  }
});

test('closing kills the whole process group, even a child that ignores SIGHUP', { skip }, async () => {
  const { tabs, client, last, until } = setup();
  const file = path.join(dir, 'child.pid');
  try {
    const c = client();
    tabs.open(c, 'w1', 'Ann');
    const id = last(c).opened!;
    tabs.attach(c, id);
    tabs.input(c, id, `(trap "" HUP; sleep 30 & echo $! > ${file}; wait)\n`);
    await until(() => existsSync(file) && readFileSync(file, 'utf8').trim() !== '');
    const pid = Number(readFileSync(file, 'utf8'));
    process.kill(pid, 0); // alive
    tabs.close(id);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 6000);
  } finally {
    tabs.closeAll();
  }
});

test('after a disconnect a new client re-lists and re-attaches, and the shell works again', { skip }, async () => {
  const { tabs, sent, client, last, output, until } = setup();
  try {
    const a = client();
    tabs.list(a, 'w1');
    tabs.open(a, 'w1', 'Ann');
    const id = last(a).opened!;
    tabs.attach(a, id);
    tabs.input(a, id, 'echo before\n');
    await until(() => output(a, id).includes('before'));
    tabs.forget(a); // what the socket closing does
    tabs.input(a, id, 'echo ghost\n');
    const a2 = client(); // the reconnected socket
    tabs.list(a2, 'w1');
    assert.equal(last(a2).tabs[0].id, id);
    tabs.attach(a2, id);
    assert.ok(sent.some((s) => s.c === a2 && s.msg.t === 'shelltab.snapshot' && s.msg.tabId === id));
    tabs.input(a2, id, 'echo after\n');
    await until(() => output(a2, id).includes('after'));
    assert.ok(!output(a2, id).includes('ghost\r\n'));
  } finally {
    tabs.closeAll();
  }
});

test('a resize reaches every viewer, and the viewer count follows attach and detach', { skip }, () => {
  const { tabs, sent, client, last } = setup();
  try {
    const a = client();
    const b = client();
    tabs.open(a, 'w1', 'Ann');
    const id = last(a).opened!;
    const sizes = (c: Client) => sent.filter((s) => s.c === c && s.msg.t === 'shelltab.size').map((s) => s.msg as Extract<ShellTabServerMsg, { t: 'shelltab.size' }>);
    tabs.attach(a, id);
    assert.equal(sizes(a).at(-1)?.viewers, 1);
    tabs.attach(b, id);
    assert.equal(sizes(a).at(-1)?.viewers, 2);
    assert.equal(sizes(b).at(-1)?.viewers, 2);
    tabs.resize(a, id, 100, 30);
    for (const c of [a, b]) assert.deepEqual([sizes(c).at(-1)?.cols, sizes(c).at(-1)?.rows], [100, 30]);
    const n = sizes(b).length;
    tabs.resize(a, id, 100, 30); // unchanged: nothing sent
    assert.equal(sizes(b).length, n);
    tabs.detach(b, id);
    assert.equal(sizes(a).at(-1)?.viewers, 1);
    tabs.attach(b, id);
    tabs.forget(b); // b's socket closed
    assert.equal(sizes(a).at(-1)?.viewers, 1);
  } finally {
    tabs.closeAll();
  }
});
