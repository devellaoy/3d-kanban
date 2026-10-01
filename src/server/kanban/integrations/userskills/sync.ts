// The skills this repository keeps for its developers (user-skills/claude/*, user-skills/codex/*),
// synced into the machine's own homes: <claudeHome>/skills/<folder> and <codexHome>/skills/<folder>.
// Like ai-kanban's skill sync: a copy this sync made (or ai-kanban's) is brought up to date, one
// somebody else put there is left alone; files only the target has (node_modules) survive.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KanbanTool } from '../../../../shared/kanban/types.js';
import type { SyncResult } from '../skills/delivery.js';
import { skillHash, skillsIn } from '../skills/registry.js';

/** The file in a synced copy that says this sync put it there, and what it was. */
export const USER_MARKER = '.office-user-skill.json';
/** ai-kanban's marker; a copy carrying it is adopted. */
export const AIKANBAN_MARKER = '.aikanban-sync';

const EXCLUDED = new Set(['node_modules', '.DS_Store', USER_MARKER, AIKANBAN_MARKER]);

/** This install's user-skills/ folder (user-skills/claude/*, user-skills/codex/*). */
export function userSkillsDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const d = path.join(dir, 'user-skills');
    if (existsSync(path.join(d, 'claude')) || existsSync(path.join(d, 'codex'))) return d;
  }
  return undefined;
}

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
    for (const s of skillsIn(path.join(h.source, tool), tool, 'bundled')) {
      out.push(syncOne(s.location, path.join(home, 'skills', path.basename(s.location)), `${path.basename(s.location)} (${tool})`));
    }
  }
  return out;
}

function syncOne(src: string, dest: string, name: string): SyncResult {
  try {
    const want = skillHash(src, { skipDeps: true });
    if (!existsSync(dest)) {
      copy(src, dest, want);
      return { name, status: 'installed', detail: dest };
    }
    let marker: { hash?: string } | undefined;
    try {
      marker = JSON.parse(readFileSync(path.join(dest, USER_MARKER), 'utf8')) as { hash?: string };
    } catch {
      marker = undefined;
    }
    if (marker && marker.hash === want) return { name, status: 'current' };
    if (marker || existsSync(path.join(dest, AIKANBAN_MARKER))) {
      copy(src, dest, want);
      rmSync(path.join(dest, AIKANBAN_MARKER), { force: true });
      return { name, status: 'updated', detail: dest };
    }
    return { name, status: 'user-owned', detail: `${dest} is there already and this sync didn't put it there, so it was left as it is` };
  } catch (err) {
    return { name, status: 'failed', detail: (err as Error).message };
  }
}

function copy(from: string, to: string, hash: string) {
  mkdirSync(to, { recursive: true });
  // Filtered by basename: cpSync drops a whole subtree when its folder is refused.
  cpSync(from, to, { recursive: true, force: true, filter: (s) => !EXCLUDED.has(path.basename(s)) });
  writeFileSync(path.join(to, USER_MARKER), `${JSON.stringify({ source: '3d-kanban', hash, at: new Date().toISOString() }, null, 2)}\n`);
}

/** One log line per skill installed or updated, a warning per one left alone or failed, nothing for current ones. */
export function logResults(results: SyncResult[]) {
  for (const r of results) {
    if (r.status === 'installed' || r.status === 'updated') console.log(`agent-office: skill ${r.name} synced to ${r.detail}`);
    else if (r.status === 'user-owned' || r.status === 'failed') console.warn(`agent-office: skill ${r.name} ${r.status === 'failed' ? 'could not be synced' : 'not synced'}: ${r.detail}`);
  }
}
