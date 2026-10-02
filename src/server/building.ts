import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_PALETTES, MAX_FLOORS, normalizeRepo, sameRepo } from '../shared/floors.js';
import { floorGroupKey, insertFloor, moveFloorAbove, moveGroupAbove, normalizeOrder } from '../shared/floororder.js';
import type { ProjectsDirState, RepoChoice } from '../shared/protocol.js';
import { gh } from './github.js';
import type { ProjectRepo } from '../shared/kanban/types.js';
import { loadRepos } from './kanban/repos-file.js';

/** A floor as floors.json keeps it. */
export interface FloorDef {
  id: string;
  name: string;
  /** owner/name on GitHub. */
  repo?: string;
  dir: string;
  palette: number;
  addedBy: string;
  addedAt: number;
  /** The project's repositories, the floor's own checkout the primary one (see server/kanban/projects.ts). */
  repos?: ProjectRepo[];
}

/** A projects folder picked in ⚙️ Settings (or with --projects), as projects-folder.json keeps it. */
interface PickedDir {
  dir: string;
  by: string;
  at: number;
}

/** The checkout the office was started in, once it's been taken off the building (local-floor.json). */
interface LocalOff {
  dir: string;
  by: string;
  at: number;
}

/** Folders under home that hold keys and settings, never a project. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.config'];

/** How long the list of repositories `gh` can see is reused before it's asked again. */
const REPOS_TTL_MS = 5 * 60_000;
const MAX_REPOS = 1000;
const CLONE_TIMEOUT_MS = 30 * 60_000;

/**
 * The floors of the building, saved in <office>/.agent-office/floors.json: which projects there are,
 * where their checkouts live, and how each floor is painted. New floors are cloned with the office
 * machine's `gh` login into <projects>/<owner>/<repo>; the projects folder can be picked in ⚙️ Settings
 * (kept in projects-folder.json).
 */
export class Building {
  private defs: FloorDef[] = [];
  private file: string;
  private pickedFile: string;
  private picked?: PickedDir;
  /** Floors being cloned, by lower-cased repo. Not saved until the clone is there. */
  private cloning = new Map<string, FloorDef>();
  private repoCache?: { at: number; repos: Promise<RepoChoice[]> };
  /** The checkout the office was started in (see ensureLocal), and the repository it's a checkout of. */
  private local?: { dir: string; repo?: string };
  /** The floor that checkout is, while it is one. */
  private localId?: string;
  private localFile: string;
  /** The floor addDir just moved the started-in checkout back in as, and the taking off it undid (see forget). */
  private movedBack?: { id: string; off: LocalOff };
  /** That checkout was taken off the building: a restart doesn't put it back. */
  private localOff?: LocalOff;

  constructor(
    /** The office's own data folder; `gh` runs there, since the projects folder may not exist yet. */
    private dataDir: string,
    /** Where new floors are cloned unless another folder was picked. */
    private defaultProjectsDir: string,
  ) {
    this.file = path.join(dataDir, 'floors.json');
    this.pickedFile = path.join(dataDir, 'projects-folder.json');
    this.localFile = path.join(dataDir, 'local-floor.json');
    this.load();
    this.loadPicked();
    this.loadLocalOff();
  }

  /** Where new floors are cloned. Floors already there stay where they are when it moves. */
  get projectsDir(): string {
    return this.picked?.dir ?? this.defaultProjectsDir;
  }

  projectsDirState(): ProjectsDirState {
    return { dir: tildify(this.projectsDir), custom: !!this.picked, by: this.picked?.by, at: this.picked?.at };
  }

  /** Clones new floors into `raw` from now on ('~' is the home folder; '' goes back to the default). Returns why it can't, if it can't. */
  setProjectsDir(raw: string, by: string): string | undefined {
    const text = raw.trim();
    let dir = this.defaultProjectsDir;
    if (text) {
      const typed = untildify(text);
      if (!path.isAbsolute(typed)) return 'Use a full path, like ~/Workspace';
      dir = path.resolve(typed);
    }
    if (dir !== this.defaultProjectsDir) {
      const why = unwritable(dir);
      if (why) return why;
      // Cloning into a project would nest checkouts inside its git tree.
      const inside = this.defs.find((d) => within(dir, path.resolve(d.dir)));
      if (inside) return `${tildify(dir)} is inside ${inside.name}'s checkout — pick a folder outside every project`;
    }
    this.picked = dir === this.defaultProjectsDir ? undefined : { dir, by, at: Date.now() };
    try {
      writeFileSync(this.pickedFile, JSON.stringify(this.picked ?? {}, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the projects folder: ${(err as Error).message}`);
    }
    return undefined;
  }

  list(): FloorDef[] {
    return this.defs;
  }

  /** Floors on their way: shown in the elevator, but nobody can ride there yet. */
  pending(): FloorDef[] {
    return [...this.cloning.values()];
  }

  /**
   * Makes the checkout the office was started in a floor, if it isn't one yet: `agent-office <dir>`
   * has always meant that project. Once someone takes it off the building it stays off (the office
   * still keeps its own data in it), until its repository is added again from the elevator.
   */
  ensureLocal(dir: string, by: string): FloorDef | undefined {
    const abs = path.resolve(dir);
    const real = realOf(abs);
    const known = this.defs.find((d) => realOf(d.dir) === real);
    this.local = { dir: abs, repo: known?.repo ?? originRepo(abs) };
    if (known) {
      this.localId = known.id;
      if (this.localOff) this.setLocalOff(undefined);
      return known;
    }
    if (this.localOff && realOf(this.localOff.dir) === real) return undefined;
    // Named after its folder, as the office always called it.
    const def = this.newDef(path.basename(abs), this.local.repo, abs, by);
    this.defs = insertFloor(this.defs, def, 'bottom');
    this.localId = def.id;
    this.save();
    return def;
  }

  /** Moves a floor just above floor `above` of its owner's group, or to the bottom of it (null). Returns why it can't. */
  moveFloor(id: string, above: string | null): string | undefined {
    if (!this.defs.some((d) => d.id === id)) return 'No such floor';
    const moved = moveFloorAbove(this.defs, id, above);
    if (!moved) return "A floor stays in its owner's group";
    return this.reorder(moved);
  }

  /** Moves a floor group (see floorGroupKey) just above group `above`, or to the bottom of the building (null). Returns why it can't. */
  moveGroup(key: string, above: string | null): string | undefined {
    const keys = new Set(this.defs.map(floorGroupKey));
    if (!keys.has(key) || (above !== null && !keys.has(above))) return 'No such group of floors';
    const moved = moveGroupAbove(this.defs, key, above);
    return moved ? this.reorder(moved) : 'A group cannot move above itself';
  }

  private reorder(defs: FloorDef[]): undefined {
    if (defs.some((d, i) => d !== this.defs[i])) {
      this.defs = defs;
      this.save();
    }
    return undefined;
  }

  /** The office keeps its own data in this floor's checkout. */
  isLocal(id: string): boolean {
    return id === this.localId;
  }

  /**
   * Takes a floor off the building. Its checkout stays where it is, with its workers, queue and
   * pictures in its .agent-office folder: adding the repository again moves back in, as long as the
   * checkout is still where the projects folder clones it (or it's the one the office was started
   * in). Returns the floor, or why it can't.
   */
  remove(id: string, by = '?'): FloorDef | string {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return [...this.cloning.values()].some((d) => d.id === id) ? "That floor is still being cloned — take it off once it's there" : 'No such floor';
    this.defs = this.defs.filter((d) => d !== def);
    if (this.isLocal(id)) {
      this.localId = undefined;
      this.setLocalOff({ dir: def.dir, by, at: Date.now() });
    }
    this.save();
    return def;
  }

  /**
   * Clones a repository into the projects folder and adds it as a floor. `started` hears about the
   * floor as soon as the clone begins; resolves to the finished floor, or to why there's none. A
   * checkout that's already where the clone would go is used as it is.
   */
  async add(input: string, by: string, started: (def: FloorDef) => void): Promise<FloorDef | string> {
    const wanted = normalizeRepo(input);
    if (!wanted) return 'Pick a repository, or type it as owner/name';
    if (this.defs.some((d) => sameRepo(d.repo, wanted))) return `${wanted} already has a floor`;
    if (this.cloning.has(wanted.toLowerCase())) return `${wanted} is already being cloned`;
    if (this.defs.length + this.cloning.size >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    // The office's own checkout, taken off before: it moves back in where it is, not into a second clone.
    const home = this.local;
    if (this.localOff && home && sameRepo(home.repo, wanted) && existsSync(home.dir)) {
      const def = this.newDef(path.basename(home.dir), home.repo, home.dir, by);
      started(def);
      this.defs = insertFloor(this.defs, def, 'groupTop');
      this.localId = def.id;
      this.setLocalOff(undefined);
      this.save();
      return def;
    }
    // Asking GitHub first says whether this login can see it at all, and gets the name's real case.
    let repo: string;
    try {
      const view = JSON.parse(await gh(['repo', 'view', wanted, '--json', 'nameWithOwner'], this.dataDir, 30_000)) as { nameWithOwner?: string };
      repo = normalizeRepo(view.nameWithOwner) ?? wanted;
    } catch (err) {
      return `Couldn't find ${wanted} on GitHub: ${(err as Error).message}`;
    }
    const key = repo.toLowerCase();
    if (this.defs.some((d) => sameRepo(d.repo, repo))) return `${repo} already has a floor`;
    if (this.cloning.has(key)) return `${repo} is already being cloned`;
    const [owner, name] = repo.split('/');
    const dest = path.join(this.projectsDir, owner, name);
    if (this.defs.some((d) => path.resolve(d.dir) === dest)) return `${dest} is already a floor`;
    const def = this.newDef(name, repo, dest, by);
    this.cloning.set(key, def);
    started(def);
    try {
      const err = await cloneInto(repo, dest);
      if (err) return err;
    } finally {
      this.cloning.delete(key);
    }
    this.defs = insertFloor(this.defs, def, 'groupTop');
    this.save();
    return def;
  }

  /**
   * Makes an existing folder on the office's machine a floor as it is: nothing is cloned, and git is
   * optional (a checkout's origin on GitHub is picked up, a plain folder just has no repository).
   * `raw` is the typed path ('~' is the home folder). Returns the floor, or why it can't be one.
   */
  addDir(raw: string, by: string): FloorDef | string {
    const text = raw.trim();
    if (!text) return "Type the folder's full path, like ~/work/notes";
    if (text.length > 1024) return 'That path is too long';
    const typed = untildify(text);
    if (!path.isAbsolute(typed)) return "Use the folder's full path, like /Users/me/work/notes or ~/work/notes";
    const dir = path.resolve(typed);
    try {
      if (!statSync(dir).isDirectory()) return `${tildify(dir)} isn't a folder`;
    } catch {
      return `${tildify(dir)} doesn't exist on the office's machine`;
    }
    const real = realOf(dir);
    const shown = tildify(dir);
    if (real === realOf(path.parse(dir).root) || real === realOf(os.homedir())) return `Pick a project's own folder, not ${shown}`;
    // The office's data folder (.agent-office), the office home it sits in, and anything holding them;
    // except the checkout the office was started in, which holds its own data folder.
    const startedHere = [this.local?.dir, this.localOff?.dir].some((d) => d && realOf(d) === real);
    const data = realOf(this.dataDir);
    if (!startedHere && (within(data, real) || within(real, data))) return `${shown} is the office's own folder (or holds or is inside it) — pick a project's folder`;
    // Where the account keeps its secrets and settings: hidden folders straight under home, and anything in or around the usual ones.
    const home = realOf(os.homedir());
    if ((path.dirname(real) === home && path.basename(real).startsWith('.')) || SECRET_DIRS.some((n) => within(real, path.join(home, n)) || within(path.join(home, n), real))) return `${shown} is a private folder of your account — pick a project's own folder`;
    if (within(realOf(this.projectsDir), real)) return `${shown} is where the office clones projects (or holds that folder) — pick a project's own folder`;
    for (const d of [...this.defs, ...this.cloning.values()]) {
      const there = realOf(d.dir);
      if (real === there) return `${shown} is already the ${d.name} floor`;
      if (within(real, there)) return `${shown} is inside ${d.name}'s checkout`;
      if (within(there, real)) return `${shown} contains ${d.name}'s checkout`;
    }
    if (this.defs.length + this.cloning.size >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      return `The office can't write in ${shown}`;
    }
    // Only a folder with a .git of its own is a checkout: one nested in some other repository isn't.
    const repo = existsSync(path.join(dir, '.git')) ? originRepo(dir) : undefined;
    if (repo) {
      const has = this.defs.find((d) => sameRepo(d.repo, repo));
      if (has) return `${has.repo ?? repo} already has a floor (${has.name})`;
      if (this.cloning.has(repo.toLowerCase())) return `${repo} is being cloned right now`;
    }
    const def = this.newDef(path.basename(dir), repo, dir, by);
    // The checkout the office was started in, taken off before: it moves back in.
    this.movedBack = undefined;
    if (this.localOff && realOf(this.localOff.dir) === real) {
      this.movedBack = { id: def.id, off: this.localOff };
      this.localId = def.id;
      this.setLocalOff(undefined);
    }
    this.defs = insertFloor(this.defs, def, 'groupTop');
    this.save();
    return def;
  }

  /** Drops a floor that was just added but couldn't be opened. Unlike remove, it isn't remembered as taken off; the started-in checkout that moved back in goes back to being off. */
  forget(id: string): void {
    if (this.movedBack?.id === id) {
      this.setLocalOff(this.movedBack.off);
      this.movedBack = undefined;
    }
    this.defs = this.defs.filter((d) => d.id !== id);
    if (this.localId === id) this.localId = undefined;
    this.save();
  }

  /** Repositories the office's `gh` login can clone, most recently pushed first. */
  async repos(refresh = false): Promise<RepoChoice[]> {
    const cached = this.repoCache;
    if (cached && !refresh && Date.now() - cached.at < REPOS_TTL_MS) return cached.repos;
    const repos = listRepos(this.dataDir);
    this.repoCache = { at: Date.now(), repos };
    // A failure is worth asking again next time, not keeping for five minutes.
    repos.catch(() => {
      if (this.repoCache?.repos === repos) this.repoCache = undefined;
    });
    return repos;
  }

  /** Sets (or, undefined, clears) a floor's repositories, checked by server/kanban/projects.ts. */
  setRepos(id: string, repos: ProjectRepo[] | undefined): FloorDef | string {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return 'No such floor';
    if (repos?.length) def.repos = repos;
    else delete def.repos;
    this.save();
    return def;
  }

  /** Renames a floor (the project's name); its id, folder and repository stay. Returns why not, if not. */
  setName(id: string, raw: string): FloorDef | string {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return 'No such floor';
    const name = raw.trim();
    if (!name || name.length > 100) return 'A project needs a name (at most 100 characters)';
    if ([...this.defs, ...this.cloning.values()].some((d) => d.id !== id && d.name.toLowerCase() === name.toLowerCase())) return `There's already a project called ${name}`;
    def.name = name;
    this.save();
    return def;
  }

  private newDef(name: string, repo: string | undefined, dir: string, by: string): FloorDef {
    const taken = new Set([...this.defs, ...this.cloning.values()].map((d) => d.id));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'floor';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    // The first look nobody has, so floors side by side never match; then round again.
    const used = new Set([...this.defs, ...this.cloning.values()].map((d) => d.palette));
    const free = FLOOR_PALETTES.findIndex((_, i) => !used.has(i));
    const palette = free >= 0 ? free : (this.defs.length + this.cloning.size) % FLOOR_PALETTES.length;
    return { id, name, repo, dir, palette, addedBy: by, addedAt: Date.now() };
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FloorDef>[];
      const ids = new Set<string>();
      for (const s of Array.isArray(saved) ? saved : []) {
        if (typeof s.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(s.id) || ids.has(s.id) || typeof s.dir !== 'string' || !path.isAbsolute(s.dir)) continue;
        ids.add(s.id);
        this.defs.push({
          id: s.id,
          name: typeof s.name === 'string' && s.name ? s.name.slice(0, 100) : path.basename(s.dir),
          repo: normalizeRepo(s.repo),
          dir: s.dir,
          palette: Number.isInteger(s.palette) && (s.palette as number) >= 0 ? (s.palette as number) : 0,
          addedBy: typeof s.addedBy === 'string' ? s.addedBy : '?',
          addedAt: typeof s.addedAt === 'number' ? s.addedAt : Date.now(),
        });
        // A project's repositories (a floor without any is one repository, as always).
        const repos = loadRepos(s.repos, s.id, s.dir);
        if (repos) this.defs[this.defs.length - 1].repos = repos;
      }
      // Floors of one owner sit together; a hand-edited or older file that doesn't is put right.
      const ordered = normalizeOrder(this.defs);
      const moved = ordered.some((d, i) => d !== this.defs[i]);
      this.defs = ordered;
      if (moved) this.save();
    } catch (err) {
      console.error(`agent-office: ${this.file} couldn't be read, so the building starts empty: ${(err as Error).message}`);
    }
  }

  private loadPicked() {
    try {
      const saved = JSON.parse(readFileSync(this.pickedFile, 'utf8')) as Partial<PickedDir>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.picked = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never picked: the default
    }
  }

  private loadLocalOff() {
    try {
      const saved = JSON.parse(readFileSync(this.localFile, 'utf8')) as Partial<LocalOff>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.localOff = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never taken off
    }
  }

  private setLocalOff(off: LocalOff | undefined) {
    this.localOff = off;
    try {
      if (off) writeFileSync(this.localFile, JSON.stringify(off, null, 2), { mode: 0o600 });
      else rmSync(this.localFile, { force: true });
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.localFile}: ${(err as Error).message}`);
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.defs, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the floors: ${(err as Error).message}`);
    }
  }
}

/** A path under the home folder as ~/…, for showing people. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** A path with symlinks resolved, so two ways to name a folder compare equal; the path itself when it can't be resolved. */
function realOf(p: string): string {
  try {
    // The native one gives the name's case as it is on disk, so ~/Notes and ~/notes are one folder on a case-insensitive disk.
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function untildify(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `dir` is `parent` or somewhere under it. */
function within(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the office couldn't make checkouts under `dir`, if it couldn't. It's made on the first clone, so it needn't exist yet. */
function unwritable(dir: string): string | undefined {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    if (!statSync(at).isDirectory()) return `${tildify(at)} isn't a folder`;
    accessSync(at, constants.W_OK);
  } catch {
    return `The office can't write in ${tildify(at)}`;
  }
  return undefined;
}

/** The GitHub repository a checkout's origin points at. */
export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/** Clones `repo` to `dest`, or checks that what's already there is that repository. Resolves to an error, if any. */
async function cloneInto(repo: string, dest: string): Promise<string | undefined> {
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) return `${dest} is already there and isn't a folder`;
    if (readdirSync(dest).length) {
      // Cloned before (a floor that was taken off the list, or by hand): move back in.
      return sameRepo(originRepo(dest), repo) ? undefined : `${dest} already exists and isn't a checkout of ${repo} — move it out of the way first`;
    }
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return `Couldn't make ${path.dirname(dest)}: ${(err as Error).message}`;
  }
  return new Promise((resolve) => {
    execFile('gh', ['repo', 'clone', repo, dest], { cwd: path.dirname(dest), timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve(undefined);
      const why = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      resolve(`Couldn't clone ${repo}: ${why || 'gh failed'}`);
    });
  });
}

async function listRepos(cwd: string): Promise<RepoChoice[]> {
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  );
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
