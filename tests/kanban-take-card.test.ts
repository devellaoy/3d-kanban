import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Floor } from '../src/server/floor.js';
import { takeCard } from '../src/server/take-card.js';
import { gates } from '../src/server/office/gates.js';
import { setWallProvider } from '../src/server/kanban/integrations/issues/wall.js';

function fakeFloor() {
  const info = { id: 'w1' } as Record<string, unknown>;
  const dropped: unknown[][] = [];
  const claimed: unknown[][] = [];
  const floor = { id: 'app', def: { repo: 'acme/api' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, queue: { dropIssue: (...a: unknown[]) => dropped.push(a) }, workers: { get: () => info }, claimCard: async (...a: unknown[]) => (claimed.push(a), undefined) };
  return { floor: floor as never, info, dropped, claimed };
}

test('takeCard: drops the card off the queue, records the worker’s issue and claims it under the owner’s gh', async () => {
  const f = fakeFloor();
  const said: string[] = [];
  assert.equal(await takeCard(f.floor, () => ({ env: { GH_TOKEN: 'ada' } }), { n: 4, owner: 'ada', workerId: 'w1' }, (t) => said.push(t)), undefined);
  assert.deepEqual(f.dropped, [[4, undefined]]);
  assert.equal(f.info.issueKey, 'gh:acme/api#4');
  assert.deepEqual(f.claimed, [[4, undefined, { env: { GH_TOKEN: 'ada' } }]]);
  assert.deepEqual(said, []);
});

test('takeCard without an owner (the office’s gh is theirs) claims with no identity, which also moves the Status', async () => {
  const f = fakeFloor();
  await takeCard(f.floor, () => assert.fail('asked'), { n: 4, key: 'gh:acme/web#9' });
  assert.deepEqual(f.claimed, [[4, 'gh:acme/web#9', undefined]]);
});

test('takeCard for an account without a gh sign-in claims nothing, says why once and gives it back', async () => {
  const f = fakeFloor();
  const said: string[] = [];
  assert.equal(await takeCard(f.floor, () => 'Sign in to GitHub first', { n: 5, owner: 'bob', workerId: 'w1' }, (t) => said.push(t)), 'Sign in to GitHub first');
  assert.deepEqual(f.claimed, []);
  assert.deepEqual(said, ["Couldn't assign issue #5 on GitHub: Sign in to GitHub first"]);
  assert.equal(f.info.issueKey, 'gh:acme/api#5', 'the worker’s PR still closes it');
});

test('takeCard for a queue task leaves the queue alone', async () => {
  const f = fakeFloor();
  await takeCard(f.floor, () => undefined, { n: 4, fromQueue: true });
  assert.deepEqual(f.dropped, []);
});

test('a card taken at a desk: the gate warns the person, and moves no Status for an account without a gh sign-in', async () => {
  const started: string[] = [];
  setWallProvider({ started: async (_p: string, k: string) => (started.push(k), undefined), refresh() {} } as never);
  const f = fakeFloor();
  const warned: string[] = [];
  const ctx = { signins: { ghAs: () => 'Sign in to GitHub first' }, warn: (_c: unknown, t: string) => warned.push(t) };
  gates(ctx as never).takeIssue({ accountId: 'bob' } as never, f.floor, 6, undefined, 'w1');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.claimed, []);
  assert.deepEqual(started, []);
  assert.deepEqual(warned, ["Couldn't assign issue #6 on GitHub: Sign in to GitHub first"]);
  gates({ signins: { ghAs: () => assert.fail('no account') }, warn: assert.fail } as never).takeIssue({} as never, f.floor, 7);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.claimed, [[7, undefined, undefined]], 'the shared password: the office’s gh');
  setWallProvider(undefined);
});

test('claimCard goes through cardRef: a primary-repository key claims through the floor’s GitHub, a Jira key is left be', async () => {
  const started: string[] = [];
  setWallProvider({ started: async (_p: string, k: string) => (started.push(k), undefined), refresh() {} } as never);
  const claims: number[] = [];
  const floor = { id: 'app', def: { repo: 'acme/api' }, dir: '.', git: true, cardRef: Floor.prototype.cardRef, ctx: { toast() {} }, github: { claim: async (n: number) => (claims.push(n), undefined) } };
  assert.equal(await Floor.prototype.claimCard.call(floor as never, undefined, 'gh:acme/api#12'), undefined);
  assert.equal(await Floor.prototype.claimCard.call(floor as never, 3, undefined), undefined);
  assert.equal(await Floor.prototype.claimCard.call(floor as never, undefined, 'UYT-1'), undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(claims, [12, 3]);
  assert.deepEqual(started, ['gh:acme/api#12', 'gh:acme/api#3']);
  setWallProvider(undefined);
});
