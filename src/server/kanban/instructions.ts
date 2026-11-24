// A project's instructions as files the agents read (prompts name the paths instead of inlining the text):
// `<filesDir>/instructions/<project>/{general,testing,repo-<id>}.md`, kept in step with the settings and the project's repositories.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KanbanContext } from './registry.js';

export interface InstructionTexts {
  general?: string;
  testing?: string;
  repos?: { id: string; instructions?: string }[];
}

export interface InstructionFiles {
  dir: string;
  general?: string;
  testing?: string;
  /** A repository id to the path of its file. */
  repos: Record<string, string>;
}

const PROJECT_ID = /^[a-z0-9-]{1,40}$/;
const REPO_ID = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function instructionsDir(filesDir: string, projectId: string): string {
  return path.join(filesDir, 'instructions', projectId);
}

const fail = (what: string, err: unknown) => console.error(`agent-office: couldn't ${what}: ${(err as Error).message}`);

/** Writes `text` to `file` unless it is there already; blank text removes the file. Returns whether the file now holds the text. */
function put(file: string, text: string | undefined): boolean {
  const body = text?.trim() ? `${text.trim()}\n` : '';
  if (!body) {
    rmSync(file, { force: true });
    return false;
  }
  try {
    if (readFileSync(file, 'utf8') === body) return true;
  } catch {
    // missing or unreadable: written below
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o444 });
    renameSync(tmp, file);
    chmodSync(file, 0o444);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

/** Never throws. A path is present only when that file exists with the current text. */
export function syncInstructionFiles(filesDir: string, projectId: string, texts: InstructionTexts): InstructionFiles {
  const dir = instructionsDir(filesDir, projectId);
  const out: InstructionFiles = { dir, repos: {} };
  if (!PROJECT_ID.test(projectId)) return out;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    fail(`make the instructions folder of project ${projectId}`, err);
    return { dir, repos: {} };
  }
  const part = (name: string, text: string | undefined): string | undefined => {
    const file = path.join(dir, name);
    try {
      return put(file, text) ? file : undefined;
    } catch (err) {
      fail(`write ${file}`, err);
      return undefined;
    }
  };
  const general = part('general.md', texts.general);
  if (general) out.general = general;
  const testing = part('testing.md', texts.testing);
  if (testing) out.testing = testing;
  const keep = new Set<string>();
  for (const r of texts.repos ?? []) {
    if (!REPO_ID.test(r.id)) continue;
    const file = part(`repo-${r.id}.md`, r.instructions);
    if (file) {
      out.repos[r.id] = file;
      keep.add(path.basename(file));
    }
  }
  try {
    for (const n of readdirSync(dir)) {
      if (/^repo-.+\.md$/.test(n) && !keep.has(n)) rmSync(path.join(dir, n), { force: true });
    }
  } catch (err) {
    fail(`clear the old files of project ${projectId}'s instructions`, err);
  }
  return out;
}

/** Never throws. */
export function removeInstructionDir(filesDir: string, projectId: string): void {
  if (!PROJECT_ID.test(projectId)) return;
  try {
    rmSync(instructionsDir(filesDir, projectId), { recursive: true, force: true });
  } catch (err) {
    fail(`remove project ${projectId}'s instructions`, err);
  }
}

/** Removes the folders of projects that no longer exist. Never throws. */
export function pruneInstructionDirs(filesDir: string, projectIds: string[]): void {
  const live = new Set(projectIds);
  try {
    const root = path.join(filesDir, 'instructions');
    if (!existsSync(root)) return;
    for (const n of readdirSync(root)) if (!live.has(n)) rmSync(path.join(root, n), { recursive: true, force: true });
  } catch (err) {
    fail('prune the instructions of removed projects', err);
  }
}

/** The texts of a project as they are now: its settings and every repository of it. */
export function projectInstructionTexts(ctx: Pick<KanbanContext, 'settings' | 'repos'>, projectId: string): InstructionTexts {
  const ps = ctx.settings.project(projectId);
  return { general: ps.generalInstructions, testing: ps.testingInstructions, repos: ctx.repos(projectId).map((r) => ({ id: r.id, instructions: r.instructions })) };
}
