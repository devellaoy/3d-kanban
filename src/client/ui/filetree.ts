// A list of changed files as a folder tree, without the DOM: used by the PR window's Files tab
// (ui/github/pull-window.ts) and the task's Changes view (kanban/changesview.ts, kanban/changeslist.ts).

export interface TreeDir<T> {
  name: string;
  path: string;
  dirs: TreeDir<T>[];
  files: T[];
}

/** Folders with their files, single-child folder chains squashed ("src/client/ui"), like GitHub. The input is not changed. */
export function buildTree<T extends { path: string }>(files: readonly T[]): TreeDir<T> {
  const root: TreeDir<T> = { name: '', path: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const p = d.path ? `${d.path}/${part}` : part;
      let next = d.dirs.find((x) => x.name === part && x.path === p);
      if (!next) d.dirs.push((next = { name: part, path: p, dirs: [], files: [] }));
      d = next;
    }
    d.files.push(f);
  }
  const squash = (d: TreeDir<T>): TreeDir<T> => {
    d.dirs = d.dirs.map(squash);
    while (d.dirs.length === 1 && !d.files.length && d.path) {
      const only = d.dirs[0];
      d = { name: `${d.name}/${only.name}`, path: only.path, dirs: only.dirs, files: only.files };
    }
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    return d;
  };
  return squash(root);
}

/** Files in the order the tree shows them, so the diff pane matches the sidebar. */
export function treeOrder<T>(d: TreeDir<T>): T[] {
  return [...d.dirs.flatMap(treeOrder), ...d.files];
}

export type TreeRow<T> = { kind: 'dir'; dir: TreeDir<T>; depth: number; shut: boolean } | { kind: 'file'; file: T; depth: number };

/** The rows the tree shows, top to bottom: a folder row, then (unless its path is in `collapsed`) what is in it one level deeper; the root itself has no row and its own files come last at depth 0. */
export function treeRows<T>(root: TreeDir<T>, collapsed: ReadonlySet<string>): TreeRow<T>[] {
  const out: TreeRow<T>[] = [];
  const walk = (d: TreeDir<T>, depth: number): void => {
    for (const sub of d.dirs) {
      const shut = collapsed.has(sub.path);
      out.push({ kind: 'dir', dir: sub, depth, shut });
      if (!shut) walk(sub, depth + 1);
    }
    for (const file of d.files) out.push({ kind: 'file', file, depth });
  };
  walk(root, 0);
  return out;
}

/** The `path` keys of the tree's folders above the file at `path`, outermost first; empty for a root-level file or one that isn't in the tree. */
export function dirsAbove<T extends { path: string }>(root: TreeDir<T>, path: string): string[] {
  const walk = (d: TreeDir<T>, above: string[]): string[] | null => {
    if (d.files.some((f) => f.path === path)) return above;
    for (const sub of d.dirs) {
      const found = walk(sub, [...above, sub.path]);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []) ?? [];
}
