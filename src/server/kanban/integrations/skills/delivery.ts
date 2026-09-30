// Getting picked skills to a task's agent. Claude: a generated Claude Code plugin
// (<filesDir>/skills/plugin-<hash>, `.claude-plugin/plugin.json` + `skills/`) holding the bundled
// and repository skills picked, passed with --plugin-dir; nothing is copied into anyone's config
// home, and skills installed in the worker's own home load by themselves. Codex has no such flag:
// the bundled skills picked are copied into $CODEX_HOME/skills with a marker, and a copy the user
// changed is never overwritten (the result says an update is available instead).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillInfo } from '../../../../shared/kanban/types.js';
import { MARKER, skillHash } from './registry.js';

export const PLUGIN_NAME = 'office-kanban-skills';

/**
 * The plugin folder holding `skills` (each copied under skills/<its folder name>), made once per
 * set of contents: the same skills, unchanged, give the same folder. Returns its path.
 */
export function pluginDir(filesDir: string, skills: SkillInfo[]): string {
  const sorted = [...new Map(skills.map((s) => [s.name, s])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const h = createHash('sha256');
  for (const s of sorted) h.update(s.name).update('\0').update(skillHash(s.location)).update('\0');
  const dir = path.join(filesDir, 'skills', `plugin-${h.digest('hex').slice(0, 12)}`);
  if (existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
  // Built beside it and moved in whole, so a worker never gets half a plugin.
  const tmp = `${dir}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(tmp, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills the 3d-kanban office picked for this task (generated; do not edit).' }, null, 2)}\n`,
  );
  const used = new Set<string>();
  for (const s of sorted) {
    let folder = path.basename(s.location);
    if (used.has(folder)) folder = s.name.replace(/[^\w.-]/g, '-');
    used.add(folder);
    cpSync(s.location, path.join(tmp, 'skills', folder), { recursive: true, filter: (src) => path.basename(src) !== MARKER });
  }
  try {
    renameSync(tmp, dir);
  } catch {
    // Someone made the same one meanwhile: theirs is as good.
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

export type SyncResult = { name: string; status: 'installed' | 'updated' | 'current' | 'update-available' | 'user-owned' | 'failed'; detail?: string };

/**
 * Copies bundled Codex skills into `<codexHome>/skills/<folder>`. A copy the office made and nobody
 * changed is brought up to date; one somebody changed, or a skill of the same name the office didn't
 * put there, is left alone.
 */
export function syncCodexSkills(codexHome: string, skills: SkillInfo[]): SyncResult[] {
  const out: SyncResult[] = [];
  for (const s of skills) {
    const dest = path.join(codexHome, 'skills', path.basename(s.location));
    const want = skillHash(s.location);
    try {
      if (existsSync(dest)) {
        let marker: { hash?: string } | undefined;
        try {
          marker = JSON.parse(readFileSync(path.join(dest, MARKER), 'utf8')) as { hash?: string };
        } catch {
          marker = undefined;
        }
        if (!marker?.hash) {
          out.push({ name: s.name, status: 'user-owned', detail: `${dest} is there already and the office didn't put it there` });
          continue;
        }
        const now = skillHash(dest);
        if (now !== marker.hash) {
          out.push({ name: s.name, status: want === marker.hash ? 'current' : 'update-available', detail: `${dest} was changed by hand, so the office leaves it` });
          continue;
        }
        if (now === want) {
          out.push({ name: s.name, status: 'current' });
          continue;
        }
        rmSync(dest, { recursive: true, force: true });
        copy(s.location, dest, want);
        out.push({ name: s.name, status: 'updated' });
        continue;
      }
      copy(s.location, dest, want);
      out.push({ name: s.name, status: 'installed' });
    } catch (err) {
      out.push({ name: s.name, status: 'failed', detail: (err as Error).message });
    }
  }
  return out;
}

function copy(from: string, to: string, hash: string) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== MARKER });
  writeFileSync(path.join(to, MARKER), `${JSON.stringify({ source: '3d-kanban', hash, at: new Date().toISOString() }, null, 2)}\n`);
}
