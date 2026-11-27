// The changed files of the task's Changes view (changesview.ts): its header (how many, and the
// Tree / List switch) and the list under it. A folder tree as the PR window's Files tab has it
// (ui/filetree.ts: folders that open and close, one-folder chains on one row), or the flat list of
// whole paths. The view draws it again on every live update, so what must survive a paint lives here:
// the switch's choice (kept in the browser), the folders closed in each repository, and the list
// element itself with where it is scrolled to.

import { h } from '../ui/dom';
import { buildTree, dirsAbove, treeOrder, treeRows } from '../ui/filetree';
import { pref, savePref } from '../ui/github/prefs';
import { icon } from '../ui/icons';
import { segmented } from '../ui/kit';
import { pathLabel, plusMinus } from '../ui/changes';
import type { ChangeRow } from './changesmodel';

/** Where the browser keeps the Tree / List choice. */
export const CHANGES_FILES_KEY = 'agent-office.changes-files';

type FilesMode = 'tree' | 'list';

export interface ChangesFilesPaint {
  rows: ChangeRow[];
  /** Files past the ones listed (the live list stops at a cap). */
  more: number;
  selected: string | null;
  /** The files of one commit, for the header's words. */
  perCommit: boolean;
  /** Whose folders these are (the repository's id): each one's closed folders are its own. */
  scope: string;
}

export class ChangesFileList {
  private mode: FilesMode = pref<string>(CHANGES_FILES_KEY, '') === 'list' ? 'list' : 'tree';
  private count = h('h4', {}, 'Changed files');
  private list = h('ul', { role: 'tree', 'aria-label': 'Changed files', tabindex: -1 });
  private modes = segmented<FilesMode>([['tree', 'Tree'], ['list', 'List']], this.mode, (m) => this.setMode(m), 'How the files are listed');
  readonly el = h('div.kb-cv-files', {}, h('div.kb-cv-fhead', {}, this.count, this.modes.el), this.list);
  /** The closed folders (their paths) of each scope. */
  private closed = new Map<string, Set<string>>();
  private last: ChangesFilesPaint = { rows: [], more: 0, selected: null, perCommit: false, scope: '' };
  /** What the list was last scrolled for: the selected row is brought into sight only when this changes. */
  private shown = '';

  constructor(private onSelect: (path: string) => void) {
    this.modes.buttons.get('tree')!.title = 'Show the files in their folders';
    this.modes.buttons.get('list')!.title = 'Show the files as a flat list of paths';
  }

  /** Draws the header and the list. Called on every paint of the view, live updates included. */
  paint(o: ChangesFilesPaint) {
    // A newly selected file (the first one by default, after another commit or repository) is never left inside a closed folder.
    const shut = this.closed.get(o.scope);
    if (this.mode === 'tree' && shut?.size && o.selected && (o.selected !== this.last.selected || o.scope !== this.last.scope)) for (const dir of dirsAbove(buildTree(o.rows), o.selected)) shut.delete(dir);
    this.last = o;
    const n = o.rows.length;
    this.count.textContent = o.perCommit ? (n ? `${n} file${n > 1 ? 's' : ''} in this commit` : 'Files in this commit') : n ? `${n}${o.more ? '+' : ''} changed file${n > 1 || o.more ? 's' : ''}` : 'Changed files';
    this.draw();
  }

  /** The rows in the order the list shows them (files inside closed folders too), for stepping with the keys. */
  order(rows: ChangeRow[]): ChangeRow[] {
    return this.mode === 'tree' ? treeOrder(buildTree(rows)) : rows;
  }

  /** Opens the closed folders above a file, so selecting it shows it. The caller selects it next, which draws the list. */
  reveal(rows: ChangeRow[], path: string) {
    const shut = this.closed.get(this.last.scope);
    if (this.mode !== 'tree' || !shut?.size) return;
    let opened = false;
    for (const dir of dirsAbove(buildTree(rows), path)) opened = shut.delete(dir) || opened;
    // Already the selected one (the last file, inside a closed folder): nothing else will draw it.
    if (opened && path === this.last.selected) {
      this.shown = '';
      this.draw();
    }
  }

  private setMode(m: FilesMode) {
    this.mode = m;
    savePref(CHANGES_FILES_KEY, m);
    this.draw();
  }

  private toggle(dir: string) {
    const scope = this.last.scope;
    const shut = this.closed.get(scope) ?? new Set<string>();
    this.closed.set(scope, shut);
    if (!shut.delete(dir)) shut.add(dir);
    this.draw();
  }

  private fileRow(f: ChangeRow, depth?: number): HTMLElement {
    const on = f.path === this.last.selected;
    const tree = depth !== undefined;
    // A nested repository is listed as "vendor/lib/": its name is the folder's, not the nothing after the slash.
    const name = f.path.replace(/\/+$/, '');
    return h(
      'li',
      { class: on ? 'on' : '', role: tree ? 'treeitem' : 'option', 'aria-selected': String(on), tabindex: -1, ...(tree ? { 'aria-level': depth + 1, title: f.path, style: `--depth:${depth}` } : {}), onclick: () => this.onSelect(f.path) },
      h('span.st', { class: f.tone, title: f.word }, f.letter),
      tree ? h('span.path', {}, name.slice(name.lastIndexOf('/') + 1)) : pathLabel(f.path),
      f.uncommitted ? h('span.dirty', { title: 'Not committed yet' }) : null,
      plusMinus(f.additions, f.deletions, f.binary),
    );
  }

  /** The list alone, from what was last painted: a folder opening or closing and the switch need no more. */
  private draw() {
    const { rows, more, selected, scope } = this.last;
    const tree = this.mode === 'tree';
    // The rows are made again, so the focus one of them had would be lost, and the keys with it.
    const focused = this.list.contains(document.activeElement);
    const out: HTMLElement[] = [];
    if (tree) {
      for (const r of treeRows(buildTree(rows), this.closed.get(scope) ?? new Set())) {
        if (r.kind === 'file') out.push(this.fileRow(r.file, r.depth));
        else
          out.push(
            h(
              'li.kb-cv-dir',
              { role: 'treeitem', 'aria-expanded': String(!r.shut), 'aria-level': r.depth + 1, tabindex: -1, title: r.dir.path, style: `--depth:${r.depth}`, onclick: () => this.toggle(r.dir.path) },
              icon(r.shut ? 'chevron-right' : 'chevron-down', { size: 14 }),
              icon(r.shut ? 'folder' : 'folder-open', { size: 14 }),
              h('span.path', {}, r.dir.name),
            ),
          );
      }
    } else for (const f of rows) out.push(this.fileRow(f));
    if (more) out.push(h('li.empty', {}, `…and ${more} more`));
    this.list.setAttribute('role', tree ? 'tree' : 'listbox');
    this.list.replaceChildren(...out);
    if (focused) this.list.focus({ preventScroll: true });
    // Only for a new selection, layout or repository: a live update or a folder closing leaves the list where it is.
    const shown = `${this.mode}\n${scope}\n${selected ?? ''}`;
    if (shown !== this.shown) this.list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
    this.shown = shown;
  }
}
