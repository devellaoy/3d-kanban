// The example env files of a project's repositories (`.env.example` and the like), as key names only. The
// instructions draft (index.ts) can't read any `.env*` file itself (its deny list covers them all, since a
// name like `.env.ci` or `.env.backup` says nothing of what the file holds), so the office reads the ones
// that are examples by name and passes on which keys they list, never a value.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const EXAMPLE = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist|defaults?)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'bin', 'obj', 'target', '.next', '.nuxt', '.venv', 'venv']);
/** How deep under a repository's root the files are looked for. */
const DEPTH = 3;
const FILES_MAX = 20;
const BYTES_MAX = 64_000;
const KEYS_MAX = 150;
/** Folders looked into per repository, so a huge tree can't hold the request up. */
const FOLDERS_MAX = 2000;

/** The names a dotenv text sets (`KEY=`, `export KEY=`), in order, each once. */
export function envKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys].slice(0, KEYS_MAX);
}

/** A block for the agent's input: each example env file under `dirs` with its key names, or '' when there is none. */
export function envExampleKeys(dirs: readonly string[]): string {
  const out: string[] = [];
  for (const root of dirs) {
    let folders = 0;
    const walk = (dir: string, depth: number) => {
      if (out.length >= FILES_MAX || ++folders > FOLDERS_MAX) return;
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (out.length >= FILES_MAX) return;
        const full = path.join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            if (depth < DEPTH && !SKIP.has(name)) walk(full, depth + 1);
          } else if (st.isFile() && EXAMPLE.test(name) && st.size <= BYTES_MAX) {
            const keys = envKeys(readFileSync(full, 'utf8'));
            out.push(`- ${full}: ${keys.length ? keys.join(', ') : '(no keys)'}`);
          }
        } catch {
          // unreadable: not listed
        }
      }
    };
    walk(root, 0);
  }
  return out.join('\n');
}
