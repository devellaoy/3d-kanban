// The task view's Changes tab without a worker: what the task changed, read by the office from the
// task's worktrees or its branch (integrations/changes, GET /api/kanban/tasks/<id>/changes|commits|
// commit). A repository picker, the whole change or one commit at a time, the worktree's uncommitted
// work, and a file list whose diffs open one by one. The diff lines use upstream's Changes window
// classes (.diff-lines, .dl), which style.css has on every page.

import { h } from '../ui/dom';
import type { KanbanChangedFile, KanbanChangesList, KanbanCommit, KanbanCommitChanges, KanbanCommitList, KanbanDiff, KanbanRepoChanges, KanbanRepoChangesInfo } from '../../shared/kanban/types.js';
import { splitDiff } from './model';
import { fmtAgo, fmtTime } from './labels';
import { select } from './ui';

type Mode = 'whole' | 'commits' | 'working';

/** A JSON answer from the office's HTTP API, or its `{error}` as a thrown Error. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new Error((body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const STATUS_LETTER: Record<KanbanChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', unmerged: 'U', untracked: '?' };
const STATUS_NAME: Record<KanbanChangedFile['status'], string> = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', copied: 'copied', typechange: 'type changed', unmerged: 'unmerged', untracked: 'new file' };
const SOURCE_NAME: Record<KanbanRepoChangesInfo['source'], string> = { worktree: 'from the task’s worktree', checkout: 'from the project’s checkout' };

/** A path with its folder dimmed, so the file name stands out in a long list. */
function pathLabel(f: KanbanChangedFile): HTMLElement {
  const i = f.path.lastIndexOf('/');
  return h('span.kb-path', { title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, f.oldPath ? h('span.dir', {}, `${f.oldPath} → `) : null, i >= 0 ? h('span.dir', {}, f.path.slice(0, i + 1)) : null, f.path.slice(i + 1));
}

/** A unified diff's lines, numbered: hunk headers, added and removed lines (upstream's look). */
function diffLines(text: string): HTMLElement {
  const out = h('div.diff-lines');
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    let cls = 'ctx';
    let o = '';
    let n = '';
    let code = raw;
    if (raw.startsWith('@@')) {
      inHunk = true;
      cls = 'hunk';
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldN = Number(m[1]);
        newN = Number(m[2]);
      }
    } else if (!inHunk) {
      // The file's name is in its summary already; keep only the header lines that say something else.
      if (/^(diff --git|index |--- |\+\+\+ |similarity index)/.test(raw)) continue;
      cls = 'meta';
    } else if (raw.startsWith('+')) {
      cls = 'add';
      n = String(newN++);
      code = raw.slice(1);
    } else if (raw.startsWith('-')) {
      cls = 'del';
      o = String(oldN++);
      code = raw.slice(1);
    } else if (raw.startsWith('\\')) cls = 'meta';
    else {
      o = String(oldN++);
      n = String(newN++);
      code = raw.slice(1);
    }
    out.append(h('div.dl', { class: cls }, h('span.ln', {}, o), h('span.ln', {}, n), h('span.code', {}, code)));
  }
  return out;
}

/** The files of a diff, each opening to its own part of it (drawn only when opened: big changes stay quick). */
function fileList(d: KanbanDiff, open: Set<string>): HTMLElement {
  const parts = new Map(splitDiff(d.diff).map((p) => [p.path, p.text]));
  const list = h('div.kb-difffiles');
  if (!d.files.length) list.append(h('p.kb-muted', {}, 'No changes against the base.'));
  for (const f of d.files) {
    const el = h(
      'details.kb-difffile',
      { open: open.has(f.path) },
      h(
        'summary',
        {},
        h('span.kb-fstat', { class: f.status, title: STATUS_NAME[f.status] }, STATUS_LETTER[f.status]),
        pathLabel(f),
        h('span.kb-pm', {}, ...(f.binary ? ['binary'] : [h('span.add', {}, `+${f.additions}`), ' ', h('span.del', {}, `−${f.deletions}`)])),
      ),
    ) as HTMLDetailsElement;
    const fill = () => {
      if (el.childElementCount > 1) return;
      const text = parts.get(f.path);
      el.append(text ? diffLines(text) : h('p.kb-muted', {}, 'No diff to show (binary, or too big).'));
    };
    if (el.open) fill();
    el.addEventListener('toggle', () => {
      if (el.open) {
        open.add(f.path);
        fill();
      } else open.delete(f.path);
    });
    list.append(el);
  }
  if (d.truncated) list.append(h('p.kb-error', {}, '✂️ The diff is over 2 MB: it stops here.'));
  return list;
}

export interface ChangesPaneOptions {
  taskId: number;
  /** The row of "open the live Changes window" buttons, when a worker is attached and the page can open it. */
  live(): HTMLElement | null;
}

/** The Changes tab's content, which keeps its own state across the view's redraws. */
export class ChangesPane {
  readonly el = h('div.kb-changes', {}, h('p.kb-muted', {}, 'Loading…'));
  private list: KanbanChangesList | null = null;
  private error = '';
  private repo = '';
  private mode: Mode = 'whole';
  private whole = new Map<string, KanbanRepoChanges | string>();
  private commits = new Map<string, KanbanCommitList | string>();
  private commit: { key: string; data: KanbanCommitChanges | string } | null = null;
  private picked = new Map<string, string>();
  private open = new Set<string>();
  private loading = false;
  private seq = 0;

  constructor(private o: ChangesPaneOptions) {}

  private base(): string {
    return `/api/kanban/tasks/${this.o.taskId}`;
  }

  /** Reads the task's repositories again, and whatever the pane shows (the first time, and with ↻). */
  async refresh() {
    const seq = ++this.seq;
    this.loading = true;
    this.whole.clear();
    this.commits.clear();
    this.commit = null;
    this.paint();
    try {
      const list = await getJson<KanbanChangesList>(`${this.base()}/changes`);
      if (seq !== this.seq) return;
      this.list = list;
      this.error = '';
      if (!list.repos.some((r) => r.id === this.repo)) this.repo = (list.repos.find((r) => !r.error) ?? list.repos[0])?.id ?? '';
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = (err as Error).message;
    } finally {
      if (seq === this.seq) this.loading = false;
    }
    this.paint();
    void this.fetchShown();
  }

  /** The first time the tab is looked at. */
  shown() {
    if (!this.list && !this.loading && !this.error) void this.refresh();
    else this.paint();
  }

  private info(): KanbanRepoChangesInfo | undefined {
    return this.list?.repos.find((r) => r.id === this.repo);
  }

  /** Fetches what the current repository and mode need, when it isn't there yet. */
  private async fetchShown() {
    const repo = this.repo;
    if (!repo || this.info()?.error) return;
    const q = `repo=${encodeURIComponent(repo)}`;
    const load = async <T>(map: Map<string, T | string>, url: string) => {
      if (map.has(repo)) return;
      try {
        map.set(repo, await getJson<T>(url));
      } catch (err) {
        map.set(repo, (err as Error).message);
      }
      if (repo === this.repo) this.paint();
    };
    if (this.mode === 'commits') {
      await load(this.commits, `${this.base()}/commits?${q}`);
      const hash = this.picked.get(repo);
      if (hash && this.commit?.key !== `${repo}:${hash}`) void this.pickCommit(hash);
    } else await load(this.whole, `${this.base()}/changes?${q}`);
  }

  private async pickCommit(hash: string) {
    const repo = this.repo;
    const key = `${repo}:${hash}`;
    this.picked.set(repo, hash);
    this.commit = { key, data: 'Loading…' };
    this.paint();
    let data: KanbanCommitChanges | string;
    try {
      data = await getJson<KanbanCommitChanges>(`${this.base()}/commit?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`);
    } catch (err) {
      data = (err as Error).message;
    }
    if (this.commit?.key !== key) return;
    this.commit = { key, data };
    this.paint();
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.paint();
    void this.fetchShown();
  }

  paint() {
    const top: HTMLElement[] = [];
    const live = this.o.live();
    if (live) top.push(live);
    if (this.error) {
      this.el.replaceChildren(...top, h('div.kb-error', {}, `⚠️ ${this.error}`, ' ', h('button.btn.small', { type: 'button', onclick: () => void this.refresh() }, 'Try again')));
      return;
    }
    if (!this.list) {
      this.el.replaceChildren(...top, h('p.kb-muted', {}, 'Loading…'));
      return;
    }
    const repos = this.list.repos;
    const info = this.info();
    const whole = this.whole.get(this.repo);
    const working = typeof whole === 'object' ? whole.workingTree : null;
    const bar = h('div.kb-changes-bar');
    if (repos.length > 1) {
      const sel = select<string>(repos.map((r) => [r.id, `📦 ${r.name}`] as const), this.repo, { 'aria-label': 'Repository' });
      sel.addEventListener('change', () => {
        this.repo = sel.value;
        if (this.mode === 'working') this.mode = 'whole';
        this.paint();
        void this.fetchShown();
      });
      bar.append(sel);
    }
    const seg = h('div.kb-seg', { role: 'group' });
    const segBtn = (mode: Mode, label: string, disabled = false, title?: string) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(this.mode === mode), disabled, title }, label) as HTMLButtonElement;
      b.addEventListener('click', () => this.setMode(mode));
      seg.append(b);
    };
    segBtn('whole', 'Whole change');
    segBtn('commits', 'Per commit');
    // The worktree's own entry: there only when the task has one (its answer says so).
    if (working) segBtn('working', `✏️ Uncommitted${working.files.length ? ` (${working.files.length})` : ''}`, false, 'Edits and new files in the worktree that aren’t committed yet');
    bar.append(seg, h('span.grow'), h('button.btn.small', { type: 'button', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => void this.refresh() }, '↻'));
    if (this.mode === 'whole' || this.mode === 'working') {
      bar.append(
        h('button.btn.small', { type: 'button', onclick: () => this.allFiles(true) }, 'Open all'),
        h('button.btn.small', { type: 'button', onclick: () => this.allFiles(false) }, 'Close all'),
      );
    }
    const out: HTMLElement[] = [...top, bar];
    if (info) {
      out.push(
        h(
          'p.kb-changes-src',
          {},
          info.branch && info.base ? `${info.branch} against ${info.base}` : (info.branch ?? ''),
          ' · ',
          SOURCE_NAME[info.source],
          info.headCommit ? h('code', {}, ` ${info.headCommit.slice(0, 10)}`) : null,
        ),
      );
    }
    if (info?.error) out.push(h('p.kb-muted', {}, `ℹ️ ${info.error}`));
    else if (this.mode === 'commits') out.push(...this.commitsView());
    else {
      if (whole === undefined) out.push(h('p.kb-muted', {}, 'Loading…'));
      else if (typeof whole === 'string') out.push(h('div.kb-error', {}, `⚠️ ${whole}`));
      else if (whole.error) out.push(h('p.kb-muted', {}, `ℹ️ ${whole.error}`));
      else if (this.mode === 'working') out.push(working && working.files.length ? fileList(working, this.open) : h('p.kb-muted', {}, 'Nothing uncommitted.'));
      else out.push(h('p.kb-muted', {}, `${whole.files.length} files`), fileList(whole, this.open));
    }
    this.el.replaceChildren(...out);
  }

  private allFiles(open: boolean) {
    for (const d of this.el.querySelectorAll<HTMLDetailsElement>('details.kb-difffile')) d.open = open;
  }

  private commitsView(): HTMLElement[] {
    const list = this.commits.get(this.repo);
    if (list === undefined) return [h('p.kb-muted', {}, 'Loading…')];
    if (typeof list === 'string') return [h('div.kb-error', {}, `⚠️ ${list}`)];
    if (list.error) return [h('p.kb-muted', {}, `ℹ️ ${list.error}`)];
    if (!list.commits.length) return [h('p.kb-muted', {}, 'No commits on the branch yet.')];
    const picked = this.picked.get(this.repo);
    const out: HTMLElement[] = [
      h(
        'ol.kb-commits',
        {},
        ...list.commits.map((c: KanbanCommit) =>
          h(
            'li',
            {},
            h(
              'button.kb-commit',
              { type: 'button', class: picked === c.hash ? 'on' : '', 'aria-pressed': String(picked === c.hash), onclick: () => void this.pickCommit(c.hash) },
              h('code', {}, c.hash.slice(0, 8)),
              h('span.kb-commit-subject', {}, c.subject),
              h('small', { title: fmtTime(Date.parse(c.date)) }, `${c.author} · ${fmtAgo(Date.parse(c.date))}`),
            ),
          ),
        ),
      ),
    ];
    const cur = this.commit;
    if (!picked || !cur || cur.key !== `${this.repo}:${picked}`) out.push(h('p.kb-muted', {}, 'Pick a commit to see its diff.'));
    else if (typeof cur.data === 'string') out.push(h('p.kb-muted', {}, cur.data));
    else out.push(h('h4.kb-commit-head', {}, h('code', {}, cur.data.commit.hash.slice(0, 10)), ` ${cur.data.commit.subject}`), fileList(cur.data, this.open));
    return out;
  }
}
