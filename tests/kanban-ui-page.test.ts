// The kanban page and the shared task view, without the DOM: the ?tab= deep link, which tabs a task
// view shows on the page and embedded, the 📍 Show in 3D link, cutting a diff into its files, and the
// kanban bus's watches (one subscription per connection, never fighting a page's own).

import test from 'node:test';
import assert from 'node:assert/strict';
import { deepLink, isTaskTab, parseDeepLink, showIn3dLink, splitDiff, tabFor, TASK_TABS, visibleTabs } from '../src/client/kanban/model.js';
import { KanbanApi } from '../src/client/kanban/api.js';
import type { Net } from '../src/client/net.js';
import type { ServerMsg } from '../src/shared/protocol.js';

test('?tab= opens a task on that tab; anything else is ignored', () => {
  assert.deepEqual(parseDeepLink('?task=12&tab=changes'), { task: 12, tab: 'changes', settings: false });
  assert.deepEqual(parseDeepLink('?task=12&tab=terminal&project=web'), { task: 12, project: 'web', tab: 'terminal', settings: false });
  assert.deepEqual(parseDeepLink('?task=12&tab=nope'), { task: 12, settings: false });
  assert.deepEqual(parseDeepLink('?task=12&tab=__proto__'), { task: 12, settings: false });
  // A tab without a task means nothing.
  assert.deepEqual(parseDeepLink('?tab=plan'), { settings: false });
  assert.ok(TASK_TABS.every(isTaskTab));
  assert.equal(isTaskTab('Overview'), false);
});

test('the page keeps the open tab in its link', () => {
  assert.equal(deepLink('?task=7', { tab: 'runs' }), '?task=7&tab=runs');
  assert.equal(deepLink('?task=7&tab=runs', { tab: 'overview' }), '?task=7');
  assert.equal(deepLink('?task=7&tab=runs', { tab: null }), '?task=7');
  assert.equal(deepLink('?task=7&tab=runs', { task: 9, tab: 'plan' }), '?task=9&tab=plan');
  // Closing the task takes its tab with it; no task, no tab.
  assert.equal(deepLink('?project=web&task=7&tab=runs', { task: null }), '?project=web');
  assert.equal(deepLink('?project=web', { tab: 'runs' }), '?project=web');
});

test('the task view shows every tab on the page, and no Terminal embedded', () => {
  assert.deepEqual(visibleTabs(false), ['overview', 'conversation', 'plan', 'runs', 'terminal', 'changes', 'prs']);
  assert.deepEqual(visibleTabs(true), ['overview', 'conversation', 'plan', 'runs', 'changes', 'prs']);
  assert.equal(tabFor('terminal', false), 'terminal');
  assert.equal(tabFor('terminal', true), 'overview');
  assert.equal(tabFor('changes', true), 'changes');
  assert.equal(tabFor(undefined, true), 'overview');
  assert.equal(tabFor('bogus', false), 'overview');
});

test('the worker window’s task tab has no Changes tab (its header’s 🌿 Changes opens the view)', () => {
  assert.deepEqual(visibleTabs(true, false), ['overview', 'conversation', 'plan', 'runs', 'prs']);
  assert.deepEqual(visibleTabs(false, false), ['overview', 'conversation', 'plan', 'runs', 'terminal', 'prs']);
  assert.equal(tabFor('changes', true, false), 'overview');
  assert.equal(tabFor('changes', true, true), 'changes');
  assert.equal(tabFor('plan', true, false), 'plan');
});

test('📍 Show in 3D goes to the worker’s desk, or to the floor', () => {
  assert.equal(showIn3dLink('api', 'w-1', 'd3'), '/?floor=api&worker=w-1&desk=d3');
  assert.equal(showIn3dLink('api', 'w-1'), '/?floor=api&worker=w-1');
  assert.equal(showIn3dLink('api'), '/?floor=api');
  // A desk without its worker says nothing, and odd ids are left out.
  assert.equal(showIn3dLink('api', undefined, 'd3'), '/?floor=api');
  assert.equal(showIn3dLink('api', 'w 1&x=y', 'd3'), '/?floor=api');
});

test('a unified diff is cut into its files', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1,2 @@',
    ' one',
    '+two',
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 100%',
    'rename from old name.txt',
    'rename to new name.txt',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/with space.bin b/with space.bin',
    'Binary files a/with space.bin and b/with space.bin differ',
    '',
  ].join('\n');
  const parts = splitDiff(diff);
  assert.deepEqual(
    parts.map((p) => p.path),
    ['a.txt', 'new name.txt', 'gone.txt', 'with space.bin'],
  );
  assert.match(parts[0].text, /^\+two$/m);
  assert.doesNotMatch(parts[0].text, /old name/);
  assert.deepEqual(splitDiff(''), []);
});

/** A Net stand-in: records what's sent, and lets the test deliver messages. */
function fakeNet() {
  const sent: { t: string; project?: string | null }[] = [];
  const handlers: ((m: ServerMsg) => void)[] = [];
  const net = {
    up: true,
    send: (m: { t: string; project?: string | null }) => void sent.push(m),
    onMessage: (h: (m: ServerMsg) => void) => void handlers.push(h),
    onStatus: () => {},
  };
  return { net: net as unknown as Net, sent, deliver: (m: unknown) => handlers.forEach((h) => h(m as ServerMsg)) };
}

test('watches share the connection’s one subscription and end it with the last one', () => {
  const { net, sent } = fakeNet();
  const api = new KanbanApi(net);
  const a = api.watch('api');
  const b = api.watch('api');
  assert.deepEqual(sent, [{ t: 'kanban.subscribe', project: 'api' }]);
  // Another project too: all of them, as one filter.
  const c = api.watch('web');
  assert.deepEqual(sent.at(-1), { t: 'kanban.subscribe', project: null });
  c();
  assert.deepEqual(sent.at(-1), { t: 'kanban.subscribe', project: 'api' });
  a();
  assert.equal(sent.length, 3);
  b();
  assert.deepEqual(sent.at(-1), { t: 'kanban.unsubscribe' });
  b();
  assert.equal(sent.length, 4);
});

test('a page’s own subscription wins; watches ride on it', () => {
  const { net, sent, deliver } = fakeNet();
  const api = new KanbanApi(net);
  api.send({ t: 'kanban.subscribe', project: 'web' });
  const off = api.watch('api');
  off();
  assert.deepEqual(sent, [{ t: 'kanban.subscribe', project: 'web' }]);
  assert.equal(api.pageSubscribed, true);
  // After a reconnect the page subscribes again itself: the watches still send nothing.
  api.watch('api');
  deliver({ t: 'welcome' });
  assert.equal(sent.length, 1);
});

test('a reconnect subscribes the watches again', () => {
  const { net, sent, deliver } = fakeNet();
  const api = new KanbanApi(net);
  api.watch('api');
  deliver({ t: 'welcome' });
  assert.deepEqual(sent, [
    { t: 'kanban.subscribe', project: 'api' },
    { t: 'kanban.subscribe', project: 'api' },
  ]);
});
