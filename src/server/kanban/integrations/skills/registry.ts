// The skills the office can find: the ones it ships (skills/claude, skills/codex), the machine's
// (~/.claude/skills, $CODEX_HOME/skills), each signed-in account's Claude home
// (<dataDir>/homes/<id>/claude/skills), and every project repository's .claude/skills. A skill is a
// folder with a SKILL.md whose frontmatter names and describes it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KanbanTool, SkillInfo } from '../../../../shared/kanban/types.js';

/** A skill's name as the settings keep it (see sanitizeSkillSelection). */
export const SKILL_NAME_RE = /^[A-Za-z0-9][\w.:-]{0,99}$/;
/** The file in a delivered copy that says the office put it there, and what it was. */
export const MARKER = '.office-skill.json';

/** SKILL.md's frontmatter: its name and description (single-line or folded values). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      value = more.join(value.startsWith('|') ? '\n' : ' ');
    }
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[kv[1]] = value;
  }
  return { ...(out.name ? { name: out.name } : {}), ...(out.description ? { description: out.description } : {}) };
}

/** The file in a user-skills copy that says 3d-kanban's sync put it there, and what it was. */
export const USER_MARKER = '.office-user-skill.json';
/** ai-kanban's sync marker; a copy carrying it is adopted. */
export const AIKANBAN_MARKER = '.aikanban-sync';
/** What a user skill's hash and its copy leave out, at any depth: installed dependencies and the sync markers. */
export const USER_SKILL_EXCLUDES: ReadonlySet<string> = new Set(['node_modules', '.DS_Store', USER_MARKER, AIKANBAN_MARKER]);

/** Every file of a skill's folder, relative, sorted (its marker left out), a few levels deep. `exclude` leaves out more names at any depth. */
export function skillFiles(dir: string, opts: { exclude?: ReadonlySet<string> } = {}): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n === MARKER || n === '.DS_Store') continue;
      if (opts.exclude?.has(n)) continue;
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 6) walk(p, r, depth + 1);
        else if (st.isFile()) out.push(r);
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

/** A hash of what a skill's folder holds (names and contents), to tell copies apart. */
export function skillHash(dir: string, opts?: { exclude?: ReadonlySet<string> }): string {
  const h = createHash('sha256');
  for (const f of skillFiles(dir, opts)) {
    h.update(f).update('\0');
    try {
      h.update(readFileSync(path.join(dir, f)));
    } catch {
      // unreadable: counts as empty
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** The skills directly under `root` (each a folder with a SKILL.md). */
export function skillsIn(root: string, tool: KanbanTool, origin: SkillInfo['origin'], installedIn: string[] = []): SkillInfo[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const n of names) {
    const dir = path.join(root, n);
    const md = path.join(dir, 'SKILL.md');
    if (!existsSync(md)) continue;
    let fm: ReturnType<typeof parseFrontmatter> = {};
    try {
      fm = parseFrontmatter(readFileSync(md, 'utf8').slice(0, 20_000));
    } catch {
      continue;
    }
    const name = fm.name && SKILL_NAME_RE.test(fm.name) ? fm.name : n;
    if (!SKILL_NAME_RE.test(name)) continue;
    out.push({ name, description: (fm.description ?? '').slice(0, 1000), tool, location: dir, origin, installedIn });
  }
  return out;
}

/** This install's skills/ folder (skills/claude/*, skills/codex/*). */
export function bundledSkillsDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const d = path.join(dir, 'skills');
    if (existsSync(path.join(d, 'claude')) || existsSync(path.join(d, 'codex'))) return d;
  }
  return undefined;
}

export interface SkillRoots {
  bundled?: string;
  /** The machine's Claude home (~/.claude). */
  claudeHome: string;
  /** $CODEX_HOME, else ~/.codex. */
  codexHome: string;
  /** Account homes: <dataDir>/homes/<id>/claude. */
  accountHomes: string[];
  /** Project repositories' checkouts (their .claude/skills). */
  repoDirs: string[];
}

export function defaultRoots(dataDir: string, repoDirs: string[]): SkillRoots {
  const homes = path.join(dataDir, 'homes');
  let accounts: string[] = [];
  try {
    accounts = readdirSync(homes)
      .map((id) => path.join(homes, id, 'claude'))
      .filter((d) => existsSync(d));
  } catch {
    // nobody signed in with their own
  }
  return {
    bundled: bundledSkillsDir(),
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    accountHomes: accounts,
    repoDirs: [...new Set(repoDirs)],
  };
}

/** Every skill it can find. A bundled Codex skill already synced to the Codex home says so in installedIn. */
export function discoverSkills(roots: SkillRoots): SkillInfo[] {
  const codexSkills = path.join(roots.codexHome, 'skills');
  const out: SkillInfo[] = [];
  if (roots.bundled) {
    out.push(...skillsIn(path.join(roots.bundled, 'claude'), 'claude', 'bundled'));
    for (const s of skillsIn(path.join(roots.bundled, 'codex'), 'codex', 'bundled')) {
      const copy = path.join(codexSkills, path.basename(s.location));
      out.push({ ...s, installedIn: existsSync(path.join(copy, MARKER)) ? [roots.codexHome] : [] });
    }
  }
  out.push(...skillsIn(path.join(roots.claudeHome, 'skills'), 'claude', 'user', [roots.claudeHome]));
  // The office's own copies in the Codex home are listed as bundled above.
  out.push(...skillsIn(codexSkills, 'codex', 'user', [roots.codexHome]).filter((s) => !existsSync(path.join(s.location, MARKER))));
  for (const home of roots.accountHomes) out.push(...skillsIn(path.join(home, 'skills'), 'claude', 'account', [home]));
  for (const dir of roots.repoDirs) out.push(...skillsIn(path.join(dir, '.claude', 'skills'), 'claude', 'repo'));
  return out;
}

/** The skill a name means for a tool, preferring what the office can deliver itself (bundled, then a repository's). */
export function findSkill(skills: SkillInfo[], tool: KanbanTool, name: string, repoDirs?: string[]): SkillInfo | undefined {
  const mine = skills.filter((s) => s.tool === tool && s.name === name);
  const inRepo = (s: SkillInfo) => !repoDirs || repoDirs.some((d) => s.location.startsWith(path.join(d, '.claude', 'skills') + path.sep));
  return mine.find((s) => s.origin === 'bundled') ?? mine.find((s) => s.origin === 'repo' && inRepo(s)) ?? mine.find((s) => s.origin === 'user') ?? mine.find((s) => s.origin === 'account');
}
