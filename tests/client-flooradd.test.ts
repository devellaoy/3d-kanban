import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';
import { DROPPED, folderPath, requestFloor, routeFloorAdded } from '../src/client/ui/flooradd.js';

/** A stand-in for the page's Net: it keeps what was sent. */
const fakeNet = () => {
  const sent: ClientMsg[] = [];
  return { sent, send: (msg: ClientMsg) => void sent.push(msg) };
};
const added = (extra: Omit<Extract<ServerMsg, { t: 'floor.added' }>, 't'>) => ({ t: 'floor.added', ...extra }) as ServerMsg;
/** Whether the promise has settled yet. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  return done;
};

/** The request id a floor.add went with. */
const ridOf = (msg: ClientMsg | undefined) => (msg as { rid?: string } | undefined)?.rid;

test('a folder request sends floor.add with the folder and an id, and resolves on the answer with that id', async () => {
  const net = fakeNet();
  const answer = requestFloor(net, { dir: '/work/notes' });
  const rid = ridOf(net.sent[0]);
  assert.ok(rid);
  assert.deepEqual(net.sent, [{ t: 'floor.add', dir: '/work/notes', rid }]);
  routeFloorAdded(added({ dir: '/work/notes', rid: `${rid}x`, floor: 'other' }));
  assert.equal(await settled(answer), false);
  routeFloorAdded(added({ dir: '/work/notes', rid, floor: 'notes' }));
  assert.deepEqual(await answer, { floor: 'notes' });
});

test('two requests for the same repository each hear their own answer', async () => {
  const net = fakeNet();
  const first = requestFloor(net, { repo: 'acme/x' });
  const second = requestFloor(net, { repo: 'acme/x' });
  const [a, b] = net.sent.map(ridOf);
  assert.ok(a && b && a !== b);
  routeFloorAdded(added({ repo: 'acme/x', rid: b, error: 'Already being cloned' }));
  assert.equal(await settled(first), false);
  assert.deepEqual(await second, { error: 'Already being cloned' });
  routeFloorAdded(added({ repo: 'acme/x', rid: a, floor: 'x' }));
  assert.deepEqual(await first, { floor: 'x' });
});

test('an answer without an id (an older office) goes by the folder it echoes', async () => {
  const answer = requestFloor(fakeNet(), { dir: '/work/notes' });
  routeFloorAdded(added({ dir: '/work/other', floor: 'other' }));
  routeFloorAdded(added({ repo: '/work/notes', floor: 'wrong' }));
  assert.equal(await settled(answer), false);
  routeFloorAdded(added({ dir: '/work/notes', floor: 'notes' }));
  assert.deepEqual(await answer, { floor: 'notes' });
});

test("without ids, a repository request ignores another repository's answer and takes its own error", async () => {
  const answer = requestFloor(fakeNet(), { repo: 'acme/x' });
  routeFloorAdded(added({ repo: 'acme/y', floor: 'y' }));
  routeFloorAdded(added({ dir: 'acme/x', floor: 'wrong' }));
  assert.equal(await settled(answer), false);
  routeFloorAdded(added({ repo: 'acme/x', error: 'nope' }));
  assert.deepEqual(await answer, { error: 'nope' });
});

test('a connection that starts over tells every request still waiting, and they stop listening', async () => {
  const a = requestFloor(fakeNet(), { dir: '/a' });
  const b = requestFloor(fakeNet(), { repo: 'acme/b' });
  routeFloorAdded({ t: 'welcome' } as ServerMsg);
  assert.deepEqual(await a, { error: DROPPED });
  assert.deepEqual(await b, { error: DROPPED });
  // A late answer finds nobody waiting.
  routeFloorAdded(added({ dir: '/a', floor: 'a' }));
});

test('a folder path is told from owner/name by how it starts', () => {
  for (const path of ['/', '/Users/me/notes', '  ~/work/notes ', '~', '.', '..', './notes', '../x', '.\\notes', '..\\x', '\\\\server\\share', 'C:\\work', 'd:/work']) assert.equal(folderPath(path), path.trim(), path);
  // A dot alone doesn't make a path: a repository's name can start with one.
  for (const other of ['acme/x', 'https://github.com/acme/x', 'notes', '', '   ', 'acme', '.github', '.dotfiles', '...', '..foo', '.github/workflows']) assert.equal(folderPath(other), undefined, other);
});
