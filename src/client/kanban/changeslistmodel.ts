// What the Changes view's file list (changeslist.ts) remembers between its paints, without the DOM, so
// tests/kanban-ui-changes.test.ts can run it: tree or list, and the folders closed in each repository.
// A folder somebody closed stays closed until they open it, or until they pick a file inside it on
// purpose (the keys stepping into it, or coming back to the tree with a file picked in the list).

import { buildTree, dirsAbove, treeOrder, treeRows } from '../ui/filetree';

export type FilesMode = 'tree' | 'list';

export class FileListState {
  /** The closed folders (their paths) of each scope (a repository's id). */
  private closed = new Map<string, Set<string>>();

  constructor(public mode: FilesMode = 'tree') {}

  /** The folders closed in a scope. */
  shut(scope: string): ReadonlySet<string> {
    return this.closed.get(scope) ?? new Set();
  }

  /** Closes an open folder, opens a closed one. */
  toggle(scope: string, dir: string) {
    const shut = this.closed.get(scope) ?? new Set<string>();
    this.closed.set(scope, shut);
    if (!shut.delete(dir)) shut.add(dir);
  }

  /** The rows in the order the list shows them (files inside closed folders too), for stepping with the keys. */
  order<T extends { path: string }>(rows: readonly T[]): readonly T[] {
    return this.mode === 'tree' ? treeOrder(buildTree(rows)) : rows;
  }

  /**
   * The file to select when none is: the first one in sight, so a closed folder stays closed (coming
   * back to a repository whose first folder was closed doesn't open it). The very first one when every
   * file is inside a closed folder.
   */
  first<T extends { path: string }>(rows: readonly T[], scope: string): T | undefined {
    if (this.mode !== 'tree') return rows[0];
    const root = buildTree(rows);
    for (const r of treeRows(root, this.shut(scope))) if (r.kind === 'file') return r.file;
    return treeOrder(root)[0];
  }

  /** Opens the closed folders above a file that was picked on purpose. Whether any was closed. */
  reveal(rows: readonly { path: string }[], scope: string, path: string): boolean {
    const shut = this.closed.get(scope);
    if (this.mode !== 'tree' || !shut?.size) return false;
    let opened = false;
    for (const dir of dirsAbove(buildTree(rows), path)) opened = shut.delete(dir) || opened;
    return opened;
  }

  /** Tree or list. Back in the tree, the selected file (picked in the list, maybe inside a closed folder) is in sight. */
  setMode(mode: FilesMode, rows: readonly { path: string }[], scope: string, selected: string | null) {
    this.mode = mode;
    if (selected) this.reveal(rows, scope, selected);
  }
}
