// The example env files of a project's repositories (`.env.example` and the like), as key names only. The
// instructions draft (index.ts) can't read any `.env*` file itself (its deny list covers them all, since a
// name like `.env.ci` or `.env.backup` says nothing of what the file holds), so the office reads the ones
// that are examples by name and passes on which keys they list, never a value.
//
// The search never leaves the repositories (links are not followed, neither to a file nor to a folder), never
// holds the office up (asynchronous, with a cap on the entries looked at and on the time taken) and ends when
// its request is cancelled.

import { lstat, readdir, readFile } from 'node:fs/promises';
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

/**
 * The names a dotenv text sets (`KEY=`, `export KEY=`), in order, each once. A quoted value is skipped whole,
 * over as many lines as it has, so nothing inside one (a line of a key that ends in `==`, say) reads as a name.
 * A quote that is never closed makes its value the rest of that line, as dotenv reads it.
 */
export function envKeys(text: string): string[] {
  const keys = new Set<string>();
  const n = text.length;
  const lineEnd = (from: number) => {
    const at = text.indexOf('\n', from);
    return at < 0 ? n : at;
  };
  let i = 0;
  while (i < n && keys.size < KEYS_MAX) {
    const end = lineEnd(i);
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/.exec(text.slice(i, end));
    if (!m) {
      i = end + 1;
      continue;
    }
    if (m[1].length <= KEY_MAX) keys.add(m[1]);
    const at = i + m[0].length;
    const quote = text[at];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      i = end + 1;
      continue;
    }
    // The closing quote, wherever it is; in double quotes a backslash escapes the next character.
    let j = at + 1;
    while (j < n && text[j] !== quote) j += quote === '"' && text[j] === '\\' ? 2 : 1;
    i = lineEnd(j < n ? j : at) + 1;
  }
  return [...keys];
}

export interface EnvSearchOptions {
  /** Whether the request the search is for has ended (cancelled, or replaced by a newer one). */
  stopped?: () => boolean;
  entriesMax?: number;
  timeMs?: number;
}

/** A block for the agent's input: each example env file under `dirs` with its key names, or '' when there is none. */
export async function envExampleKeys(dirs: readonly string[], o: EnvSearchOptions = {}): Promise<string> {
  const out: string[] = [];
  const deadline = Date.now() + (o.timeMs ?? ENV_SEARCH_MS);
  let left = o.entriesMax ?? ENV_ENTRIES_MAX;
  const over = () => out.length >= FILES_MAX || left <= 0 || Date.now() > deadline || !!o.stopped?.();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (over()) return;
    let entries;
    try {
      // The entries' own kinds (as lstat would say): a link is a link here, whatever it points at.
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (over()) return;
      left--;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < DEPTH && !SKIP.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && EXAMPLE.test(e.name)) {
        try {
          // Checked again on the path itself: a regular file of a sensible size, not a link put there meanwhile.
          const st = await lstat(full);
          if (!st.isFile() || st.size > BYTES_MAX) continue;
          const keys = envKeys(await readFile(full, 'utf8'));
          out.push(`- ${full}: ${keys.length ? keys.join(', ') : '(no keys)'}`);
        } catch {
          // unreadable: not listed
        }
      }
    }
  };
  for (const root of dirs) {
    try {
      // A repository folder that is itself a link is still the project's own: only what lies under it is held to no links.
      await walk(root, 0);
    } catch {
      // nothing from this one
    }
  }
  return out.join('\n');
}
