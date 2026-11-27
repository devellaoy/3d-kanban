// The example env files of a project's repositories (`.env.example` and the like), as key names only. The
// instructions draft (index.ts) can't read any `.env*` file itself (its deny list covers them all, since a
// name like `.env.ci` or `.env.backup` says nothing of what the file holds), so the office reads the ones
// that are examples by name and passes on which keys they list, never a value.
//
// The search never leaves the repositories (links are not followed, neither to a file nor to a folder) and never
// holds the office up: folders are read a few entries at a time, every entry counts against a cap, and when the
// time is up the request goes on with what was found so far, even if a disk call is still out. It ends when
// its request is cancelled.

import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';

const EXAMPLE = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults?)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'bin', 'obj', 'target', '.next', '.nuxt', '.venv', 'venv']);
/** How deep under a repository's root the files are looked for. */
const DEPTH = 3;
const FILES_MAX = 20;
const BYTES_MAX = 64_000;
const KEYS_MAX = 150;
const KEY_MAX = 100;
/** Directory entries looked at in all, the repositories together. */
export const ENV_ENTRIES_MAX = 20_000;
/** The longest the whole search may take. */
export const ENV_SEARCH_MS = 3000;

const QUOTES = new Set(['"', "'", '`']);

/**
 * The names a dotenv text sets (`KEY=`, `export KEY=`, `KEY: `), in order, each once, read the way dotenv reads
 * the file: a quoted value is skipped whole, over as many lines as it has, so nothing inside one (a line of a
 * key that ends in `==`, say) reads as a name. In any of the three quotes a backslash before the quote character
 * keeps it from closing the value, and the value may start on a line after its `=`. A quote that is never closed
 * makes its value the rest of that line. A byte order mark at the start is not part of the first name.
 */
export function envKeys(raw: string): string[] {
  const text = raw.replace(/^﻿/, '');
  const keys = new Set<string>();
  const n = text.length;
  const lineEnd = (from: number) => {
    const at = text.indexOf('\n', from);
    return at < 0 ? n : at;
  };
  let i = 0;
  while (i < n && keys.size < KEYS_MAX) {
    const end = lineEnd(i);
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)(?:[ \t]*=|:[ \t])/.exec(text.slice(i, end));
    if (!m) {
      i = end + 1;
      continue;
    }
    if (m[1].length <= KEY_MAX) keys.add(m[1]);
    // The value's first character, which may be on a later line.
    let at = i + m[0].length;
    while (at < n && /\s/.test(text[at])) at++;
    const quote = text[at];
    let close = -1;
    if (QUOTES.has(quote)) {
      let j = at + 1;
      while (j < n && text[j] !== quote) j += text[j] === '\\' && text[j + 1] === quote ? 2 : 1;
      if (j < n) close = j;
    }
    // Past the whole quoted value, or (no quote, or one never closed) past the line the name is on.
    i = lineEnd(close >= 0 ? close : i) + 1;
  }
  return [...keys];
}

export interface EnvSearchOptions {
  /** Whether the request the search is for has ended (cancelled, or replaced by a newer one). */
  stopped?: () => boolean;
  entriesMax?: number;
  timeMs?: number;
  /** Stand-in for the folder reader, for tests. */
  opendir?: typeof opendir;
}

/**
 * A block for the agent's input: each example env file under `dirs` with its key names (sorted by path), or ''
 * when there is none. Resolves within the time allowed whatever the disk does, with what was found by then.
 */
export async function envExampleKeys(dirs: readonly string[], o: EnvSearchOptions = {}): Promise<string> {
  const out: string[] = [];
  const open = o.opendir ?? opendir;
  let left = o.entriesMax ?? ENV_ENTRIES_MAX;
  let timedOut = false;
  const over = () => timedOut || out.length >= FILES_MAX || left <= 0 || !!o.stopped?.();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (over()) return;
    let handle;
    try {
      handle = await open(dir);
    } catch {
      return;
    }
    const folders: string[] = [];
    try {
      // One entry at a time (the handle reads the folder in small batches), each counted: a folder of any size costs no more than the cap.
      for (;;) {
        if (over()) return;
        const e = await handle.read();
        if (!e) break;
        left--;
        // The entry's own kind: a link is a link here, whatever it points at, and is passed by.
        if (e.isDirectory()) {
          if (depth < DEPTH && !SKIP.has(e.name)) folders.push(e.name);
        } else if (e.isFile() && EXAMPLE.test(e.name)) {
          const full = path.join(dir, e.name);
          try {
            // Checked again on the path itself: a regular file of a sensible size, not a link put there meanwhile.
            const st = await lstat(full);
            if (!st.isFile() || st.size > BYTES_MAX) continue;
            const keys = envKeys(await readFile(full, 'utf8'));
            if (!over()) out.push(`- ${full}: ${keys.length ? keys.join(', ') : '(no keys)'}`);
          } catch {
            // unreadable: not listed
          }
        }
      }
    } catch {
      // the folder went, or can't be read on: what was found stays
    } finally {
      await handle.close().catch(() => {});
    }
    for (const name of folders) await walk(path.join(dir, name), depth + 1);
  };

  const search = (async () => {
    // A repository folder that is itself a link is still the project's own: only what lies under it is held to no links.
    for (const root of dirs) await walk(root, 0).catch(() => {});
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, o.timeMs ?? ENV_SEARCH_MS));
  });
  // The time limit holds even while a disk call is out: the request goes on, and the walk stops at its next step.
  await Promise.race([search, timeout]);
  clearTimeout(timer);
  return [...out].sort().join('\n');
}
