// Who may see which floor: the collaborator permission with the public-repo fallback, the 10-minute
// cache, and a floor needing every one of its repositories (and a GitHub remote at all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Access, floorRepos, type GhRunner } from '../src/server/multiplayer/access.js';
import type { FloorDef } from '../src/server/building.js';

/** A gh stand-in: `perms` maps "owner/repo|login" to a permission or an error status; `priv` maps a repo to private or not. */
function gh(perms: Record<string, string>, priv: Record<string, boolean> = {}) {
  const calls: string[] = [];
  const run: GhRunner = async (args) => {
    const [, endpoint] = args;
    calls.push(endpoint);
    const perm = /^repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(endpoint);
    if (perm) {
      const v = perms[`${perm[1]}|${perm[2]}`.toLowerCase()];
      if (v === undefined || /^\d+$/.test(v)) throw new Error(`gh: HTTP ${v ?? 404}`);
      return `${v}\n`;
    }
    const repo = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (repo && repo[1] in priv) return `${priv[repo[1]]}\n`;
    throw new Error('gh: HTTP 404');
  };
  return { run, calls };
}

test('every collaborator level that can read is allowed, none and unknown are not', async () => {
  const perms: Record<string, string> = {};
  for (const level of ['admin', 'maintain', 'write', 'triage', 'read']) perms[`acme/r-${level}|vera`] = level;
  perms['acme/r-none|vera'] = 'none';
  const { run } = gh(perms, { 'acme/r-none': true });
  const a = new Access(run);
  for (const level of ['admin', 'maintain', 'write', 'triage', 'read']) assert.equal(await a.canRead('vera', `acme/r-${level}`), true, level);
  assert.equal(await a.canRead('vera', 'acme/r-none'), false);
  assert.equal(await a.canRead('vera', 'acme/missing'), false);
});

test('a public repository is open to anyone, a private one is not, when the collaborators call is refused', async () => {
  const { run, calls } = gh({ 'acme/pub|vera': '403', 'acme/priv|vera': '403' }, { 'acme/pub': false, 'acme/priv': true });
  const a = new Access(run);
  assert.equal(await a.canRead('vera', 'acme/pub'), true);
  assert.equal(await a.canRead('vera', 'acme/priv'), false);
  assert.ok(calls.includes('repos/acme/pub'), 'fell back to the repository itself');
});

test('answers are remembered (a yes longer than a no) and bad names never reach gh', async () => {
  let now = 1_000_000;
  const { run, calls } = gh({ 'acme/a|vera': 'read' });
  const a = new Access(run, () => now);
  await a.canRead('Vera', 'acme/a'); // the login's case does not matter for GitHub, nor for the cache
  await a.canRead('vera', 'ACME/a');
  assert.equal(calls.length, 1, 'cached');
  now += 9 * 60_000;
  await a.canRead('vera', 'acme/a');
  assert.equal(calls.length, 1, 'still cached after 9 minutes');
  now += 2 * 60_000;
  await a.canRead('vera', 'acme/a');
  assert.equal(calls.length, 2, 'asked again after 10');
  // A no is asked again sooner.
  await a.canRead('vera', 'acme/no');
  const n = calls.length;
  now += 61_000;
  await a.canRead('vera', 'acme/no');
  assert.ok(calls.length > n);
  const before = calls.length;
  for (const [login, repo] of [['ve ra', 'acme/a'], ['vera', '../a'], ['vera', 'acme/..'], ['vera', 'a/b/c'], ['vera;x', 'acme/a']]) assert.equal(await a.canRead(login, repo), false);
  assert.equal(calls.length, before);
});

function floors() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-access-'));
  const dir = (n: string) => {
    const d = path.join(root, n);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const def = (id: string, repo: string | undefined, extra: Partial<FloorDef> = {}): FloorDef => ({ id, name: id, repo, dir: dir(id), palette: 0, addedBy: 'x', addedAt: 1, ...extra });
  return { root, def, dir };
}

test('a floor is open only when every repository of the project is readable', async (t) => {
  const { root, def, dir } = floors();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const web = def('web', 'acme/web');
  const shop = def('shop', 'acme/shop', {
    repos: [
      { id: 'shop', name: 'shop', kind: 'git', dir: dir('shop'), remote: 'acme/shop', primary: true },
      { id: 'api', name: 'api', kind: 'git', dir: dir('shop-api'), remote: 'acme/api', primary: false },
    ],
  });
  const folder = def('notes', undefined); // a plain folder: nothing on GitHub to check
  const { run } = gh({ 'acme/web|vera': 'read', 'acme/shop|vera': 'write', 'acme/api|vera': '404' }, { 'acme/api': true });
  const a = new Access(run);
  const all = [web, shop, folder];
  assert.deepEqual(await a.allowedFloors(all, ['web', 'shop', 'notes'], 'vera'), ['web'], 'shop needs acme/api too, notes is not shareable');
  assert.deepEqual(await a.allowedFloors(all, [], 'vera'), [], 'nothing is shared by default');
  assert.deepEqual(await a.allowedFloors(all, ['shop'], 'vera'), []);
  const open = new Access(gh({ 'acme/web|vera': 'read', 'acme/shop|vera': 'write', 'acme/api|vera': 'read' }).run);
  assert.deepEqual(await open.allowedFloors(all, ['shop', 'web', 'gone'], 'vera'), ['web', 'shop'], "in the building's order, unknown ids ignored");
  assert.deepEqual(floorRepos(shop).repos, ['acme/shop', 'acme/api']);
});

test('a floor with no GitHub repository, or one repository without a remote, cannot be shared', (t) => {
  const { root, def, dir } = floors();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = new Access(gh({}).run);
  assert.equal(a.shareable(def('notes', undefined)).shareable, false);
  assert.match(a.shareable(def('notes2', undefined)).why ?? '', /No GitHub repository/);
  assert.equal(a.shareable(def('web', 'acme/web')).shareable, true);
  const mixed = def('mixed', 'acme/mixed', {
    repos: [
      { id: 'mixed', name: 'mixed', kind: 'git', dir: dir('mixed'), remote: 'acme/mixed', primary: true },
      { id: 'local', name: 'local scratch', kind: 'folder', dir: dir('scratch'), primary: false },
    ],
  });
  const s = a.shareable(mixed);
  assert.equal(s.shareable, false);
  assert.match(s.why ?? '', /local scratch has no GitHub repository/);
});
