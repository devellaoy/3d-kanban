import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, type FloorDef } from '../src/server/building.js';
import { MAX_FLOORS } from '../src/shared/floors.js';
import { isGitFloor } from '../src/server/floor-git.js';
import { projectInfo } from '../src/server/floor.js';

function office(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-building-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const floor = (id: string, palette: number): FloorDef => {
    const dir = path.join(root, 'acme', id);
    mkdirSync(dir, { recursive: true });
    return { id, name: id, repo: `acme/${id}`, dir, palette, addedBy: 'Sam', addedAt: 1 };
  };
  const defs = [floor('api', 0), floor('web', 1), floor('docs', 2)];
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify(defs));
  return { root, dataDir, defs };
}

const saved = (dataDir: string) => (JSON.parse(readFileSync(path.join(dataDir, 'floors.json'), 'utf8')) as FloorDef[]).map((d) => d.id);

test('a floor comes off the building and stays off, with its checkout left where it was', (t) => {
  const { root, dataDir, defs } = office(t);
  const building = new Building(dataDir, root);

  const r = building.remove('web');
  assert.equal(typeof r, 'object');
  assert.equal((r as FloorDef).dir, defs[1].dir);
  assert.deepEqual(building.list().map((d) => d.id), ['api', 'docs']);
  assert.deepEqual(saved(dataDir), ['api', 'docs']);
  assert.ok(existsSync(defs[1].dir), 'the checkout stays on disk');

  // After a restart it's still gone.
  assert.deepEqual(new Building(dataDir, root).list().map((d) => d.id), ['api', 'docs']);
});

test("floors that aren't there can't be taken off", (t) => {
  const { root, dataDir } = office(t);
  const building = new Building(dataDir, root);

  assert.equal(building.remove('nope'), 'No such floor');
  assert.deepEqual(saved(dataDir), ['api', 'web', 'docs']);
});

test('the floor the office was started in comes off too, stays off after a restart, and moves back in when its repository is added again', async (t) => {
  const { root, dataDir, defs } = office(t);
  // The office's own checkout, with its GitHub origin (how it's recognised once it's no longer a floor).
  execFileSync('git', ['init', '-q', defs[0].dir]);
  execFileSync('git', ['-C', defs[0].dir, 'remote', 'add', 'origin', 'https://github.com/acme/api.git']);
  const building = new Building(dataDir, root);
  building.ensureLocal(defs[0].dir, 'the office');
  assert.ok(building.isLocal('api'));
  assert.ok(!building.isLocal('web'));

  const r = building.remove('api', 'Sam');
  assert.equal((r as FloorDef).id, 'api');
  assert.ok(!building.isLocal('api'));
  assert.deepEqual(saved(dataDir), ['web', 'docs']);
  assert.ok(existsSync(defs[0].dir), 'the checkout stays on disk');

  // The next start doesn't put it back.
  const again = new Building(dataDir, root);
  assert.equal(again.ensureLocal(defs[0].dir, 'the office'), undefined);
  assert.deepEqual(again.list().map((d) => d.id), ['web', 'docs']);
  assert.deepEqual(saved(dataDir), ['web', 'docs']);

  // Adding acme/api again uses the checkout it always was (no clone, no GitHub needed).
  const started: string[] = [];
  const back = await again.add('https://github.com/acme/api', 'Sam', (d) => started.push(d.dir));
  assert.equal(typeof back, 'object', String(back));
  assert.equal((back as FloorDef).dir, defs[0].dir);
  assert.deepEqual(started, [defs[0].dir]);
  assert.ok(again.isLocal((back as FloorDef).id));
  assert.deepEqual(saved(dataDir), ['web', 'docs', 'api']);
  assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));

  // ...and it's a floor again at the next start.
  const third = new Building(dataDir, root);
  assert.equal(third.ensureLocal(defs[0].dir, 'the office')?.id, 'api');
  assert.deepEqual(third.list().map((d) => d.id), ['web', 'docs', 'api']);
});

// --- addDir: a folder as it is becomes a floor -------------------------------------------

/** A building whose data, projects folder and work folders are all apart, so a folder to add can sit beside them. */
function folders(t: { after(fn: () => void): void }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-office-adddir-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'office');
  const dataDir = path.join(home, '.agent-office');
  const projects = path.join(base, 'projects');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projects);
  const dir = (name: string) => {
    const d = path.join(base, 'work', name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const git = (d: string, origin?: string) => {
    execFileSync('git', ['init', '-q', d]);
    if (origin) execFileSync('git', ['-C', d, 'remote', 'add', 'origin', origin]);
  };
  return { base, home, dataDir, projects, dir, git, building: () => new Building(dataDir, projects) };
}

test('a plain folder becomes a floor named after it, with no repository, and survives a restart', (t) => {
  const f = folders(t);
  const notes = f.dir('Notes Pad');
  const building = f.building();
  const def = building.addDir(`  ${notes}  `, 'Sam') as FloorDef;
  assert.equal(typeof def, 'object');
  assert.equal(def.name, 'Notes Pad');
  assert.equal(def.id, 'notes-pad');
  assert.equal(def.repo, undefined);
  assert.equal(def.dir, notes);
  assert.equal(def.addedBy, 'Sam');
  assert.deepEqual(saved(f.dataDir), ['notes-pad']);
  assert.deepEqual(f.building().list().map((d) => [d.dir, d.repo]), [[notes, undefined]]);
  assert.ok(!existsSync(path.join(notes, '.agent-office')), 'nothing is written into it until its floor opens');
});

test("a checkout's GitHub origin is picked up, and a repository that already has a floor is refused", (t) => {
  const f = folders(t);
  const x = f.dir('x');
  f.git(x, 'https://github.com/acme/x.git');
  const building = f.building();
  assert.equal((building.addDir(x, 'Sam') as FloorDef).repo, 'acme/x');
  // A second checkout of the same repository.
  const copy = f.dir('x-copy');
  f.git(copy, 'git@github.com:Acme/X.git');
  assert.match(String(building.addDir(copy, 'Sam')), /acme\/x already has a floor \(x\)/);
  // An origin that isn't GitHub is no repository.
  const gl = f.dir('gl');
  f.git(gl, 'https://gitlab.com/acme/gl.git');
  assert.equal((building.addDir(gl, 'Sam') as FloorDef).repo, undefined);
});

test('the same folder typed in another case is the same floor', (t) => {
  const f = folders(t);
  const notes = f.dir('Notes');
  const building = f.building();
  assert.equal(typeof building.addDir(notes, 'Sam'), 'object');
  const lower = path.join(path.dirname(notes), 'notes');
  // Only a case-insensitive disk (macOS, Windows) has the lower-cased name too.
  if (!existsSync(lower)) return;
  assert.match(String(building.addDir(lower, 'Sam')), /already the Notes floor/);
  assert.match(String(building.addDir(`${notes.toUpperCase()}/`, 'Sam')), /already the Notes floor/);
  assert.equal(building.list().length, 1);
});

test('a folder nested inside a git repository, without a .git of its own, has no repository', (t) => {
  const f = folders(t);
  const outer = f.dir('outer');
  f.git(outer, 'https://github.com/acme/outer.git');
  const inner = path.join(outer, 'packages', 'inner');
  mkdirSync(inner, { recursive: true });
  const def = f.building().addDir(inner, 'Sam') as FloorDef;
  assert.equal(typeof def, 'object');
  assert.equal(def.repo, undefined);
});

test('paths that cannot be a project are each refused with a reason, and nothing is saved', (t) => {
  const f = folders(t);
  const building = f.building();
  const api = building.addDir(f.dir('api'), 'Sam') as FloorDef;
  const file = path.join(f.base, 'work', 'a-file');
  writeFileSync(file, 'x');
  const link = path.join(f.base, 'work', 'api-link');
  symlinkSync(api.dir, link);
  const inside = path.join(api.dir, 'src');
  mkdirSync(inside);
  const bad = (p: string, re: RegExp) => assert.match(String(building.addDir(p, 'Sam')), re, p);

  bad('', /Type the folder's full path/);
  bad('   ', /Type the folder's full path/);
  bad('/' + 'a'.repeat(1100), /too long/);
  bad('work/notes', /full path/);
  bad('./notes', /full path/);
  bad(path.join(f.base, 'missing'), /doesn't exist/);
  bad(file, /isn't a folder/);
  bad(api.dir, /already the api floor/);
  bad(link, /already the api floor/);
  bad(inside, /inside api's checkout/);
  bad(path.join(f.base, 'work'), /contains api's checkout/);
  bad('/', /Pick a project's own folder/);
  bad(os.homedir(), /Pick a project's own folder/);
  bad(f.dataDir, /office's own folder/);
  bad(f.home, /office's own folder/);
  bad(f.base, /office's own folder|contains/);
  bad(f.projects, /clones projects/);
  bad(path.dirname(f.projects), /office's own folder|clones projects|contains/);
  assert.deepEqual(saved(f.dataDir), ['api']);
});

test('~ is the home folder', (t) => {
  const f = folders(t);
  const was = process.env.HOME;
  // A stand-in home, so nothing touches the real one.
  process.env.HOME = f.base;
  t.after(() => {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  });
  const building = f.building();
  const def = building.addDir('~/work/tilde', 'Sam');
  assert.equal(typeof def, 'string', 'the folder is missing');
  assert.match(String(def), /~\/work\/tilde doesn't exist/);
  f.dir('tilde');
  assert.equal((building.addDir('~/work/tilde', 'Sam') as FloorDef).dir, path.join(f.base, 'work', 'tilde'));
  assert.match(String(building.addDir('~', 'Sam')), /Pick a project's own folder/);
});

test('a full building takes no more folders', (t) => {
  const f = folders(t);
  const building = f.building();
  for (let i = 0; i < MAX_FLOORS; i++) assert.equal(typeof building.addDir(f.dir(`f${i}`), 'Sam'), 'object');
  assert.match(String(building.addDir(f.dir('one-more'), 'Sam')), /building is full/);
});

test('a folder the office cannot write in is refused and not saved', { skip: process.getuid?.() === 0 }, (t) => {
  const f = folders(t);
  const ro = f.dir('ro');
  chmodSync(ro, 0o555);
  t.after(() => {
    try {
      chmodSync(ro, 0o755);
    } catch {
      // already cleaned up
    }
  });
  assert.match(String(f.building().addDir(ro, 'Sam')), /can't write in/);
  assert.ok(!existsSync(path.join(f.dataDir, 'floors.json')));
});

test('the started-in checkout taken off the building moves back in with addDir, and local-floor.json goes', (t) => {
  const f = folders(t);
  // Started in a project: its data folder is inside it.
  const proj = f.dir('proj');
  const dataDir = path.join(proj, '.agent-office');
  mkdirSync(dataDir);
  const building = new Building(dataDir, f.projects);
  assert.ok(building.ensureLocal(proj, 'the office'));
  building.remove('proj', 'Sam');
  assert.ok(existsSync(path.join(dataDir, 'local-floor.json')));
  const again = new Building(dataDir, f.projects);
  assert.equal(again.ensureLocal(proj, 'the office'), undefined);
  const back = again.addDir(proj, 'Sam') as FloorDef;
  assert.equal(typeof back, 'object');
  assert.ok(again.isLocal(back.id));
  assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));
  assert.equal(new Building(dataDir, f.projects).ensureLocal(proj, 'the office')?.id, back.id);
});

test('forget drops a floor without remembering it as taken off', (t) => {
  const f = folders(t);
  const building = f.building();
  const def = building.addDir(f.dir('gone'), 'Sam') as FloorDef;
  building.forget(def.id);
  assert.deepEqual(building.list(), []);
  assert.deepEqual(saved(f.dataDir), []);
  assert.ok(!existsSync(path.join(f.dataDir, 'local-floor.json')));
  assert.equal(typeof building.addDir(def.dir, 'Sam'), 'object');
});

test("a folder nested in a repository doesn't take that repository's branch or origin", (t) => {
  const f = folders(t);
  const outer = f.dir('outer');
  f.git(outer, 'https://github.com/acme/outer.git');
  const inner = path.join(outer, 'sub');
  mkdirSync(inner);
  assert.equal(isGitFloor(inner, false), false);
  assert.equal(isGitFloor(inner, true), true, 'the checkout the office was started in keeps what git says');
  assert.equal(isGitFloor(outer, false), true);
  const plain = projectInfo(inner, 'sub', 'claude', [], false);
  assert.equal(plain.branch, undefined);
  assert.equal(plain.remote, undefined);
  const real = projectInfo(outer, 'outer', 'claude', [], true);
  assert.equal(real.remote, 'https://github.com/acme/outer.git');
  // Upstream's way (started in a subfolder) still sees the repository.
  assert.equal(projectInfo(inner, 'sub', 'claude', []).remote, 'https://github.com/acme/outer.git');
});

test("the account's private folders and the office's data folder's insides are refused", (t) => {
  const f = folders(t);
  const was = process.env.HOME;
  // A stand-in home with the usual secret folders in it.
  process.env.HOME = f.base;
  t.after(() => {
    if (was === undefined) delete process.env.HOME;
    else process.env.HOME = was;
  });
  for (const n of ['.ssh', '.aws', '.gnupg', '.config/app', '.hidden']) mkdirSync(path.join(f.base, n), { recursive: true });
  mkdirSync(path.join(f.base, '.ssh', 'keys'));
  mkdirSync(path.join(f.dataDir, 'sub'));
  const building = f.building();
  const bad = (p: string, re: RegExp) => assert.match(String(building.addDir(p, 'Sam')), re, p);
  for (const p of ['.ssh', '.ssh/keys', '.aws', '.gnupg', '.config', '.config/app', '.hidden']) bad(path.join(f.base, p), /private folder/);
  bad('~/.hidden', /private folder/);
  bad(path.join(f.dataDir, 'sub'), /office's own folder/);
  // A hidden folder deeper down, or a visible one, is a project like any other.
  mkdirSync(path.join(f.base, 'work', '.dotproject'), { recursive: true });
  assert.equal(typeof building.addDir(path.join(f.base, 'work', '.dotproject'), 'Sam'), 'object');
});

test('a started-in checkout that moved back in is off again when its floor could not be opened', (t) => {
  const f = folders(t);
  const proj = f.dir('proj');
  const dataDir = path.join(proj, '.agent-office');
  mkdirSync(dataDir);
  const first = new Building(dataDir, f.projects);
  first.ensureLocal(proj, 'the office');
  first.remove('proj', 'Sam');
  const building = new Building(dataDir, f.projects);
  assert.equal(building.ensureLocal(proj, 'the office'), undefined);
  const def = building.addDir(proj, 'Sam') as FloorDef;
  assert.ok(!existsSync(path.join(dataDir, 'local-floor.json')));
  building.forget(def.id);
  assert.ok(existsSync(path.join(dataDir, 'local-floor.json')), 'taken off again');
  assert.ok(!building.isLocal(def.id));
  // A restart keeps it off, as before.
  assert.equal(new Building(dataDir, f.projects).ensureLocal(proj, 'the office'), undefined);
});

// --- the order of the floors ------------------------------------------------------------------

/** Floors of two owners, bottom-up: acme's api and web, then beta's site. */
function ordered(t: { after(fn: () => void): void }) {
  const o = office(t);
  const site: FloorDef = { id: 'site', name: 'site', repo: 'beta/site', dir: path.join(o.root, 'beta', 'site'), palette: 3, addedBy: 'Sam', addedAt: 1 };
  mkdirSync(site.dir, { recursive: true });
  writeFileSync(path.join(o.dataDir, 'floors.json'), JSON.stringify([o.defs[0], o.defs[1], site]));
  return { ...o, site };
}

test('moving a floor is saved and survives a restart', (t) => {
  const { root, dataDir } = ordered(t);
  const building = new Building(dataDir, root);
  assert.deepEqual(building.moveFloor('api', 'web'), { changed: true, up: true });
  assert.deepEqual(saved(dataDir), ['web', 'api', 'site']);
  assert.deepEqual(building.moveFloor('api', null), { changed: true, up: false });
  assert.deepEqual(new Building(dataDir, root).list().map((d) => d.id), ['api', 'web', 'site']);
});

test('a floor stays in its owner group, and unknown floors are turned away', (t) => {
  const { root, dataDir } = ordered(t);
  const building = new Building(dataDir, root);
  assert.deepEqual(building.moveFloor('api', 'site'), { err: "A floor stays in its owner's group" });
  assert.deepEqual(building.moveFloor('nope', null), { err: 'No such floor' });
  assert.deepEqual(building.moveFloor('api', 'nope'), { stale: true });
  assert.deepEqual(building.moveFloor('api', 'api'), { changed: false });
  assert.deepEqual(saved(dataDir), ['api', 'web', 'site']);
});

test('the order only needs the floors, not their checkouts', (t) => {
  const { root, dataDir, defs } = ordered(t);
  rmSync(defs[0].dir, { recursive: true });
  const building = new Building(dataDir, root);
  assert.deepEqual(building.moveFloor('web', 'api'), { changed: false });
  assert.deepEqual(building.list().map((d) => d.id), ['api', 'web', 'site']);
});

test('a group moves above another, and the floors inside keep their order', (t) => {
  const { root, dataDir } = ordered(t);
  const building = new Building(dataDir, root);
  assert.deepEqual(building.moveGroup('acme', 'beta'), { changed: true });
  assert.deepEqual(saved(dataDir), ['site', 'api', 'web']);
  assert.deepEqual(building.moveGroup('nope', null), { stale: true });
  assert.deepEqual(building.moveGroup('beta', 'beta'), { err: 'A group cannot move above itself' });
  assert.deepEqual(saved(dataDir), ['site', 'api', 'web']);
  assert.deepEqual(building.moveGroup('acme', null), { changed: true });
  assert.deepEqual(saved(dataDir), ['api', 'web', 'site']);
});

test('loading puts the floors of one owner together and saves that', (t) => {
  const { root, dataDir, defs, site } = ordered(t);
  writeFileSync(path.join(dataDir, 'floors.json'), JSON.stringify([defs[0], site, defs[1]]));
  assert.deepEqual(new Building(dataDir, root).list().map((d) => d.id), ['api', 'web', 'site']);
  assert.deepEqual(saved(dataDir), ['api', 'web', 'site']);
});

test('the checkout the office started in goes to the bottom of its own group, and that group to the bottom of the building, a folder with no repository joins the Local group at the top', (t) => {
  const { root, dataDir, site } = ordered(t);
  const building = new Building(dataDir, root);
  const own = path.join(root, 'own');
  mkdirSync(own);
  assert.equal(building.ensureLocal(own, 'the office')?.id, 'own');
  assert.deepEqual(saved(dataDir), ['own', 'api', 'web', site.id]);
  const other = path.join(root, 'other');
  mkdirSync(other);
  const added = building.addDir(other, 'Sam') as FloorDef;
  assert.deepEqual(saved(dataDir), ['own', added.id, 'api', 'web', site.id]);
});

test('the office checkout of an owner that already has floors lands at the bottom of that group, which sinks to the bottom', (t) => {
  const { root, dataDir, site } = ordered(t);
  const building = new Building(dataDir, root);
  const own = path.join(root, 'own');
  mkdirSync(own);
  execFileSync('git', ['init', '-q', own]);
  execFileSync('git', ['-C', own, 'remote', 'add', 'origin', 'https://github.com/beta/own.git']);
  assert.equal(building.ensureLocal(own, 'the office')?.id, 'own');
  assert.deepEqual(saved(dataDir), ['own', site.id, 'api', 'web']);
});
