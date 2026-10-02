// The skills this repository keeps for its developers (user-skills/claude/*, user-skills/codex/*),
// synced into the machine's own homes: <claudeHome>/skills/<folder> and <codexHome>/skills/<folder>.
// Like ai-kanban's skill sync: a copy this sync made (or ai-kanban's) is brought up to date (hand edits
// included), one somebody else put there is left alone. A copy is built outside the scanned skills/ folder,
// in <home>/.office-user-skills-tmp, and swapped in whole; the target's own node_modules survives, files
// removed from the source disappear.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KanbanTool } from '../../../../shared/kanban/types.js';
import type { SyncResult } from '../skills/delivery.js';
import { AIKANBAN_MARKER, USER_MARKER, USER_SKILL_EXCLUDES, skillHash, skillsIn } from '../skills/registry.js';

export { AIKANBAN_MARKER, USER_MARKER };

/** This install's user-skills/ folder (user-skills/claude/*, user-skills/codex/*). */
export function userSkillsDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const d = path.join(dir, 'user-skills');
    if (existsSync(path.join(d, 'claude')) || existsSync(path.join(d, 'codex'))) return d;
  }
  return undefined;
}

/** Where copies are built, directly in a home (not in its skills/, which the registry scans). */
const TMP_DIR = '.office-user-skills-tmp';

export interface UserSkillHomes {
  source: string;
  claudeHome: string;
  codexHome: string;
}

/** Syncs every skill folder of `<source>/claude` and `<source>/codex` into the matching home. */
export function syncUserSkills(h: UserSkillHomes): SyncResult[] {
  const out: SyncResult[] = [];
  const tools: [KanbanTool, string][] = [
    ['claude', h.claudeHome],
    ['codex', h.codexHome],
  ];
  for (const [tool, home] of tools) {
    const tmpRoot = path.join(home, TMP_DIR);
    cleanStale(tmpRoot, path.join(home, 'skills'));
    for (const s of skillsIn(path.join(h.source, tool), tool, 'bundled')) {
      out.push(syncOne(s.location, path.join(home, 'skills', path.basename(s.location)), tmpRoot, `${path.basename(s.location)} (${tool})`));
    }
    try {
      rmdirSync(tmpRoot); // only when empty
    } catch {
      // not there, or not empty
    }
  }
  return out;
}

/** Removes what a dead process left in the tmp root (`<folder>-<pid>`, `<folder>-<pid>.old`); a `.old` whose skill is gone is put back. */
function cleanStale(tmpRoot: string, skillsDir: string) {
  let names: string[];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^(.+)-(\d+)(\.old)?$/.exec(n);
    if (!m || Number(m[2]) === process.pid) continue;
    try {
      process.kill(Number(m[2]), 0);
      continue; // running (or not ours to ask)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue;
    }
    try {
      const p = path.join(tmpRoot, n);
      const dest = path.join(skillsDir, m[1]);
      if (m[3] && !existsSync(dest)) renameSync(p, dest);
      else rmSync(p, { recursive: true, force: true });
    } catch {
      // left for the next sync
    }
  }
}

function syncOne(src: string, dest: string, tmpRoot: string, name: string): SyncResult {
  try {
    const want = skillHash(src, { exclude: USER_SKILL_EXCLUDES });
    let st;
    try {
      st = lstatSync(dest);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink()) return { name, status: 'user-owned', detail: `${dest} is a link, so it was left as it is` };
    let marker: { hash?: string } | undefined;
    if (st) {
      try {
        marker = JSON.parse(readFileSync(path.join(dest, USER_MARKER), 'utf8')) as { hash?: string };
      } catch {
        marker = undefined;
      }
      const adopted = existsSync(path.join(dest, AIKANBAN_MARKER));
      if (marker && marker.hash === want && !adopted) return { name, status: 'current' };
      if (!marker && !adopted) return { name, status: 'user-owned', detail: `${dest} is there already and this sync didn't put it there, so it was left as it is` };
    }
    install(src, dest, tmpRoot, want, !!st);
    return st ? { name, status: 'updated', detail: dest } : { name, status: 'installed', detail: dest };
  } catch (err) {
    return { name, status: 'failed', detail: (err as Error).message };
  }
}

/** Builds the copy in the tmp root and moves it into place; an existing copy is set aside first and restored if that fails. */
function install(src: string, dest: string, tmpRoot: string, hash: string, replace: boolean) {
  const folder = path.basename(dest);
  const tmp = path.join(tmpRoot, `${folder}-${process.pid}`);
  const old = `${tmp}.old`;
  let movedModules = false;
  let aside = false;
  try {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    copy(src, tmp, hash);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (replace) {
      const nm = path.join(dest, 'node_modules');
      if (lstatSync(nm, { throwIfNoEntry: false })?.isDirectory()) {
        renameSync(nm, path.join(tmp, 'node_modules'));
        movedModules = true;
      }
      renameSync(dest, old);
      aside = true;
    }
    renameSync(tmp, dest);
  } catch (err) {
    try {
      if (aside && !existsSync(dest)) renameSync(old, dest);
      if (movedModules && existsSync(path.join(tmp, 'node_modules')) && !existsSync(path.join(dest, 'node_modules'))) renameSync(path.join(tmp, 'node_modules'), path.join(dest, 'node_modules'));
    } catch {
      // the old copy stays in the tmp root; the next sync puts it back
    }
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  rmSync(old, { recursive: true, force: true });
}

function copy(from: string, to: string, hash: string) {
  mkdirSync(to, { recursive: true });
  // Filtered by basename: cpSync drops a whole subtree when its folder is refused.
  cpSync(from, to, { recursive: true, force: true, filter: (s) => !USER_SKILL_EXCLUDES.has(path.basename(s)) });
  writeFileSync(path.join(to, USER_MARKER), `${JSON.stringify({ source: '3d-kanban', hash, at: new Date().toISOString() }, null, 2)}\n`);
}

/** One log line per skill installed or updated, a warning per one left alone or failed, nothing for current ones. */
export function logResults(results: SyncResult[]) {
  for (const r of results) {
    if (r.status === 'installed' || r.status === 'updated') console.log(`agent-office: skill ${r.name} synced to ${r.detail}`);
    else if (r.status === 'user-owned' || r.status === 'failed') console.warn(`agent-office: skill ${r.name} ${r.status === 'failed' ? 'could not be synced' : 'not synced'}: ${r.detail}`);
  }
}
