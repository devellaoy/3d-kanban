// A kanban task's Changes view: upstream's Changes window (ui/changes.ts), its look and its keys,
// for every repository of the task and one commit at a time too. One view, in two frames: a window of
// its own (openTaskChanges: C or 🌿 Changes at a task worker, which upstream's openChanges hands over
// to), and the task view's Changes tab (mountChangesView, on the kanban page and in a task window).
//
// Two sources behind it. While the task's worker is on this page's floor and the repository is in its
// workspace, All changes and Uncommitted are upstream's live data over the WebSocket (changes.watch,
// counted in changeswatch.ts), with its diffs, pictures, commit, discard and PR. Otherwise, and for
// Per commit always, the office reads the task's worktree or its branch over HTTP
// (GET /api/kanban/tasks/<id>/changes|commits|commit, integrations/changes): read-only, with ↻.
// When the worker goes, the view carries on from the HTTP side; when it comes, it goes live again.

import './changesview.css';
import { changedImageType, type ChangesState, type ServerMsg } from '../../shared/protocol';
import type { KanbanChangesList, KanbanCommitChanges, KanbanCommitList, KanbanDiff, KanbanRepoChanges, KanbanRepoChangesInfo, KanbanUncommitted } from '../../shared/kanban/types.js';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, type Modal } from '../ui/dom';
import { confirmDialog, openPrompt } from '../ui/prompt';
import { onChangesMessage, pathLabel, plusMinus, renderDiff, renderPreview } from '../ui/changes';
import { getJson } from './api';
import { LatestReads, branchMoved, changesModes, httpNeeds, liveFloor, liveRow, prHostName, prOfRepo, repoOfFloor, sortRepos, stepRow, taskRow, uncommittedNow, type ChangeRow, type ChangesMode } from './changesmodel';
import { holdChangesWatch } from './changeswatch';
import { fmtTime } from './labels';
import { splitDiff } from './model';
import { kstore } from './store';
import { apiUrl } from '../multiplayer/visit';

const MODE_NAMES: Record<ChangesMode, string> = { all: 'All changes', commits: 'Per commit', uncommitted: '✏️ Uncommitted' };
const SOURCE_NAME: Record<KanbanRepoChangesInfo['source'], string> = { worktree: 'from the task’s worktree', checkout: 'from the project’s checkout' };

/** What the left list and the diff show right now. */
type Listing =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'rows'; rows: ChangeRow[]; more: number; live: boolean; parts?: Map<string, string>; last?: string; truncated?: boolean; empty: string[] };

export interface ChangesViewOptions {
  net: Net;
  taskId: number;
  /** The task's worker: its live data while it's on this page's floor. */
  workerId?: string;
  /** The repository to open on (ProjectRepo.id; the primary one when not given). */
  repo?: string;
  /** Or upstream's floor id for it (openChanges' `repo`): none for the primary one. */
  floor?: string;
  /** The task's pull requests, for the repository tabs (else the kanban page's card, else the worker's own). */
  prs?: () => readonly { repoId: string; number: number }[] | undefined;
}

/** A diff's files' parts, cut once per answer, and the last file's path (where a cut diff stops). */
const partsCache = new WeakMap<KanbanDiff, { parts: Map<string, string>; last?: string }>();
function partsOf(d: KanbanDiff): { parts: Map<string, string>; last?: string } {
  let m = partsCache.get(d);
  if (!m) {
    const split = splitDiff(d.diff);
    partsCache.set(d, (m = { parts: new Map(split.map((p) => [p.path, p.text])), last: split[split.length - 1]?.path }));
  }
  return m;
}

class ChangesView {
  readonly bar = h('nav.changes-tabs.kb-cv-bar', { 'aria-label': 'Repositories and what to show' });
  private commitsHead = h('h4', {}, 'Commits');
  private commitList = h('ol', { role: 'listbox', 'aria-label': 'Commits' });
  private commitsBox = h('div.kb-cv-commits.hidden', {}, this.commitsHead, this.commitList);
  private filesHead = h('h4', {}, 'Changed files');
  private list = h('ul', { role: 'listbox', 'aria-label': 'Changed files' });
  private diffHead = h('div.dh');
  private diffBody = h('div.diff-scroll');
  readonly body = h('div.changes-body', {}, h('aside.changes-files', {}, this.commitsBox, this.filesHead, this.list), h('section.changes-diff', {}, this.diffHead, this.diffBody));
  private summary = h('span.grow');
  private discardBtn = h('button.btn', { type: 'button', title: 'Throw away every uncommitted change in this checkout' }, '🗑️ Discard all') as HTMLButtonElement;
  private commitBtn = h('button.btn', { type: 'button', title: 'git add -A && git commit' }, '✅ Commit…') as HTMLButtonElement;
  private prSlot = h('span.pr-slot');

  private workerId: string | undefined;
  private askedRepo: string | undefined;
  private askedFloor: string | undefined;
  private changes: KanbanChangesList | null = null;
  private listError = '';
  private repoId = '';
  private mode: ChangesMode = 'all';
  private live: { workerId: string; floor: string | undefined; state: ChangesState | null; release: () => void } | null = null;
  private whole = new Map<string, KanbanRepoChanges | string>();
  private commits = new Map<string, KanbanCommitList | string>();
  /** Live: how many files the worktree has uncommitted against HEAD (git status only). */
  private counts = new Map<string, KanbanUncommitted | string>();
  /** A burst of live updates is one round of HTTP reads, a moment later. */
  private debounce: ReturnType<typeof setTimeout> | undefined;
  /** The commit list last drawn, and the commit picked then: unchanged, it isn't drawn again. */
  private commitsDrawn: { list: unknown; picked?: string } | null = null;
  private commit: { key: string; data: KanbanCommitChanges | string } | null = null;
  /** What was read over HTTP that the live checkout has moved past: kept on screen until it's read again. */
  private stale = new Set<string>();
  /** The latest HTTP read of each `whole:<repo>` / `commits:<repo>` / `count:<repo>`: an answer to an older one (or one forgotten since) is dropped. */
  private reads = new LatestReads();
  private picked = new Map<string, string>();
  private selected: string | null = null;
  /** What the diff pane shows; a new one draws it again. */
  private diffKey = '';
  /** The live file signature the shown diff was fetched for, and the one asked for. */
  private shownSig: string | null = null;
  private requestedSig = '';
  private loading = false;
  /** Bumped by every HTTP answer, so a refreshed diff is drawn again. */
  private gen = 0;
  private seq = 0;
  private offs: (() => void)[] = [];
  private destroyed = false;

  constructor(
    private o: ChangesViewOptions,
    readonly foot: HTMLElement,
    /** Something the frame's header shows changed (the window's title and branch). */
    private onChange?: () => void,
  ) {
    this.workerId = o.workerId;
    this.askedRepo = o.repo;
    this.askedFloor = o.floor;
    foot.append(this.summary, this.discardBtn, this.commitBtn, this.prSlot);
    this.discardBtn.addEventListener('click', () => this.discardAll());
    this.commitBtn.addEventListener('click', () => this.commitAll());
  }

  start() {
    this.offs.push(
      onChangesMessage((msg) => this.onMsg(msg)),
      // The worker coming, going, or opening a PR.
      store.on('workers', () => {
        if (this.sync()) return;
        this.paintBar();
        this.onChange?.();
      }),
    );
    this.paint();
    void this.refresh();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.seq++;
    clearTimeout(this.debounce);
    this.live?.release();
    this.live = null;
    for (const off of this.offs) off();
  }

  /** The task's worker changed (a new hire), or went (undefined). */
  setWorker(id: string | undefined) {
    if (id === this.workerId) return;
    this.workerId = id;
    this.sync();
    this.onChange?.();
  }

  /** Upstream's openChanges asked again for this worker: show that repository. */
  showRepo(repo?: string, floor?: string) {
    if (!this.changes) {
      this.askedRepo = repo;
      this.askedFloor = floor;
      return;
    }
    const id = repo ?? repoOfFloor(this.changes.project, floor);
    if (this.changes.repos.some((r) => r.id === id)) this.pickRepo(id);
  }

  worker() {
    return this.workerId ? store.workers.get(this.workerId) : undefined;
  }

  /** The branch line of the window's header. */
  branchText(): string {
    const s = this.live?.state;
    if (this.live) return !s || s.error ? '' : s.base === 'HEAD' ? `🌿 ${s.branch} · uncommitted changes` : `🌿 ${s.branch} · vs ${s.base}`;
    const info = this.info();
    if (!info?.branch || info.error) return '';
    return `🌿 ${info.branch}${info.base ? ` · vs ${info.base}` : ''}`;
  }

  // --- Data -------------------------------------------------------------------------------------

  private info(): KanbanRepoChangesInfo | undefined {
    return this.changes?.repos.find((r) => r.id === this.repoId);
  }

  private base = (): string => apiUrl(`/api/kanban/tasks/${this.o.taskId}`);

  /** Reads the task's repositories again, and whatever is on screen (the first time, and with ↻). */
  private async refresh() {
    const seq = ++this.seq;
    this.whole.clear();
    this.commits.clear();
    this.counts.clear();
    this.reads.clear();
    this.stale.clear();
    this.commit = null;
    this.gen++;
    try {
      const list = await getJson<KanbanChangesList>(`${this.base()}/changes`);
      if (seq !== this.seq) return;
      this.changes = { ...list, repos: sortRepos(list.repos) };
      this.listError = '';
      const asked = this.askedRepo ?? (this.askedFloor !== undefined || !this.repoId ? repoOfFloor(list.project, this.askedFloor) : undefined);
      this.askedRepo = this.askedFloor = undefined;
      const repos = this.changes.repos;
      if (asked && repos.some((r) => r.id === asked)) this.repoId = asked;
      else if (!repos.some((r) => r.id === this.repoId)) this.repoId = (repos.find((r) => !r.error) ?? repos[0])?.id ?? '';
    } catch (err) {
      if (seq !== this.seq) return;
      this.listError = (err as Error).message;
    }
    if (this.sync()) return;
    this.paint();
    void this.fetchShown();
  }

  /**
   * Follows the worker's checkout live when it can show the repository on screen, and stops when it
   * can't (another repository, the worker gone or on another floor). True when that changed (and the
   * view was drawn again).
   */
  private sync(): boolean {
    if (this.destroyed) return false;
    const project = this.changes?.project;
    const lf = project && this.repoId ? liveFloor(this.worker(), project, this.repoId) : null;
    const want = lf && this.workerId ? { workerId: this.workerId, floor: lf.floor } : null;
    const cur = this.live;
    if (cur && want && cur.workerId === want.workerId && cur.floor === want.floor) return false;
    if (!cur && !want) return false;
    cur?.release();
    this.live = want ? { ...want, state: null, release: holdChangesWatch(this.o.net, want.workerId, want.floor) } : null;
    // What was read over HTTP before (or before following it live) may be long out of date: read it again.
    this.forget(this.repoId);
    this.shownSig = null;
    this.loading = false;
    this.diffKey = '';
    this.paint();
    void this.fetchShown();
    return true;
  }

  /** Fetches what the repository and mode on screen need over HTTP, when it isn't there yet. */
  private async fetchShown() {
    const repo = this.repoId;
    if (this.destroyed || !repo || this.info()?.error) return;
    const q = `repo=${encodeURIComponent(repo)}`;
    const load = async <T>(name: 'whole' | 'commits' | 'count', map: Map<string, T | string>, url: string) => {
      const key = `${name}:${repo}`;
      // One on its way already: its answer comes, and a stale mark left meanwhile reads again after it.
      if (this.reads.pending(key)) return;
      if (map.has(repo) && !this.stale.delete(key)) return;
      const token = this.reads.start(key);
      let got: T | string;
      try {
        got = await getJson<T>(url);
      } catch (err) {
        got = (err as Error).message;
      }
      if (!this.reads.take(key, token) || this.destroyed) return;
      map.set(repo, got);
      this.gen++;
      if (repo === this.repoId) this.paint();
      if (this.stale.has(key)) this.later();
    };
    const needs = httpNeeds(this.mode, !!this.live);
    if (needs.count && this.sameCheckout()) void load('count', this.counts, `${this.base()}/uncommitted?${q}`);
    if (needs.commits) {
      await load('commits', this.commits, `${this.base()}/commits?${q}`);
      const list = this.commits.get(repo);
      if (repo !== this.repoId || typeof list !== 'object') return;
      // The newest commit, until another is picked (and again when the picked one is gone, say after a rebase).
      const had = this.picked.get(repo);
      if ((!had || !list.commits.some((c) => c.hash === had)) && list.commits.length) this.picked.set(repo, list.commits[0].hash);
      const hash = this.picked.get(repo);
      if (hash && this.commit?.key !== `${repo}:${hash}`) void this.pickCommit(hash);
    } else if (needs.whole) await load('whole', this.whole, `${this.base()}/changes?${q}`);
  }

  /** The HTTP reads a burst of live updates made stale, once it's over. */
  private later() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.fetchShown(), 400);
  }

  /** Whether the office reads the checkout the live data comes from: the task's worktree (a worker in the shared project folder has none). */
  private sameCheckout(): boolean {
    return this.info()?.source === 'worktree' && !!this.live?.state?.dir;
  }

  /** Drops what was read over HTTP for a repository, and the commit picked from it. */
  private forget(repo: string) {
    this.whole.delete(repo);
    this.commits.delete(repo);
    this.counts.delete(repo);
    if (this.commit?.key.startsWith(`${repo}:`)) this.commit = null;
    for (const key of [`whole:${repo}`, `commits:${repo}`, `count:${repo}`]) {
      this.stale.delete(key);
      this.reads.forget(key);
    }
  }

  private async pickCommit(hash: string) {
    const repo = this.repoId;
    const key = `${repo}:${hash}`;
    this.picked.set(repo, hash);
    this.commit = { key, data: '' };
    this.selected = null;
    this.paint();
    let data: KanbanCommitChanges | string;
    try {
      data = await getJson<KanbanCommitChanges>(`${this.base()}/commit?${new URLSearchParams({ repo, hash })}`);
    } catch (err) {
      data = (err as Error).message;
    }
    if (this.destroyed || this.commit?.key !== key) return;
    this.commit = { key, data };
    this.gen++;
    this.paint();
  }

  /** Uncommitted files in the repository on screen: null without a worktree, undefined while not known yet. */
  private uncommittedCount(): number | null | undefined {
    const repo = this.repoId;
    if (this.live) {
      const c = this.counts.get(repo);
      const againstHead = typeof c === 'object' && !('error' in c) ? c.uncommitted : undefined;
      const key = `count:${repo}`;
      return uncommittedNow({ live: this.live.state, sameCheckout: this.sameCheckout(), againstHead, fresh: !this.stale.has(key) && !this.reads.pending(key) });
    }
    const whole = this.whole.get(repo);
    if (typeof whole === 'object' && !whole.error) return whole.workingTree ? whole.workingTree.files.length : null;
    const commits = this.commits.get(repo);
    if (typeof commits === 'object') return commits.uncommitted;
    return undefined;
  }

  /** The modes on offer now, and the uncommitted count they go by. */
  private modesNow(): { modes: ChangesMode[]; count: number | null | undefined } {
    const count = this.uncommittedCount();
    return { modes: changesModes(count === undefined ? (this.mode === 'uncommitted' ? 0 : null) : count, this.mode), count };
  }

  private where(): string {
    return this.live?.state?.dir ? this.live.state.dir : 'the project folder';
  }

  private name(): string {
    return this.worker()?.name ?? 'The worker';
  }

  private listing(): Listing {
    if (!this.changes) return this.listError ? { kind: 'error', text: this.listError } : { kind: 'loading' };
    const info = this.info();
    if (!info) return { kind: 'note', text: 'This task has no repository to show.' };
    if (this.mode === 'commits') {
      if (info.error) return { kind: 'note', text: info.error };
      const list = this.commits.get(this.repoId);
      if (list === undefined) return { kind: 'loading' };
      if (typeof list === 'string') return { kind: 'error', text: list };
      if (list.error) return { kind: 'note', text: list.error };
      if (!list.commits.length) return { kind: 'note', text: 'No commits on the branch yet.' };
      const hash = this.picked.get(this.repoId);
      if (!hash) return { kind: 'note', text: 'Pick a commit to see its changes.' };
      const c = this.commit;
      if (!c || c.key !== `${this.repoId}:${hash}` || c.data === '') return { kind: 'loading' };
      if (typeof c.data === 'string') return { kind: 'error', text: c.data };
      return { kind: 'rows', rows: c.data.files.map((f) => taskRow(f)), more: 0, live: false, ...partsOf(c.data), truncated: c.data.truncated, empty: ['This commit changes no files.'] };
    }
    // A worker in the shared project folder: the office has no worktree to read, so Uncommitted is the live list's.
    if (this.live && this.mode === 'uncommitted' && !this.sameCheckout()) {
      const s = this.live.state;
      if (!s) return { kind: 'loading' };
      if (s.error) return { kind: 'error', text: `Couldn't read ${this.where()}: ${s.error}` };
      return { kind: 'rows', rows: s.files.filter((f) => f.uncommitted).map(liveRow), more: 0, live: true, empty: [`Nothing uncommitted in ${this.where()}.`] };
    }
    if (this.live && this.mode === 'all') {
      const s = this.live.state;
      if (!s) return { kind: 'loading' };
      if (s.error) return { kind: 'error', text: `Couldn't read ${this.where()}: ${s.error}` };
      return {
        kind: 'rows',
        rows: s.files.map(liveRow),
        more: s.more,
        live: true,
        empty: [s.base === 'HEAD' ? `Nothing uncommitted in ${this.where()}.` : `${this.name()} hasn't changed anything since ${s.base} yet.`, 'This window follows the checkout as the worker works, so changes show up here as they are made.'],
      };
    }
    if (info.error) return { kind: 'note', text: info.error };
    const whole = this.whole.get(this.repoId);
    if (whole === undefined) return { kind: 'loading' };
    if (typeof whole === 'string') return { kind: 'error', text: whole };
    if (whole.error) return { kind: 'note', text: whole.error };
    if (this.mode === 'uncommitted') {
      const wt = whole.workingTree;
      if (!wt) return { kind: 'note', text: 'The task has no worktree now, so nothing is uncommitted.' };
      return { kind: 'rows', rows: wt.files.map((f) => taskRow(f, true)), more: 0, live: false, ...partsOf(wt), truncated: wt.truncated, empty: ['Nothing uncommitted in the task’s worktree.'] };
    }
    const vs = whole.branch && whole.base ? `Nothing on ${whole.branch} that ${whole.base} lacks yet.` : 'No changes against the base.';
    return { kind: 'rows', rows: whole.files.map((f) => taskRow(f)), more: 0, live: false, ...partsOf(whole), truncated: whole.truncated, empty: [vs] };
  }

  // --- Actions ----------------------------------------------------------------------------------

  private pickRepo(id: string) {
    if (id === this.repoId) return;
    this.repoId = id;
    this.selected = null;
    this.diffKey = '';
    if (!this.sync()) {
      this.paint();
      void this.fetchShown();
    }
  }

  private setMode(mode: ChangesMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.selected = null;
    this.paint();
    void this.fetchShown();
  }

  private select(p: string) {
    if (p === this.selected) return;
    this.selected = p;
    this.paint();
  }

  keydown(e: KeyboardEvent) {
    const down = e.key === 'ArrowDown' || e.key === 'j';
    if (!down && e.key !== 'ArrowUp' && e.key !== 'k') return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
    const l = this.listing();
    if (l.kind !== 'rows') return;
    const next = stepRow(l.rows, this.selected, down ? 1 : -1);
    if (next) this.select(next);
    e.preventDefault();
    e.stopPropagation();
  }

  private send(msg: { t: 'changes.discard'; path?: string } | { t: 'changes.commit'; message: string } | { t: 'changes.pr'; title: string; body: string }) {
    const live = this.live;
    if (live) this.o.net.send({ ...msg, workerId: live.workerId, repo: live.floor });
  }

  private discardAll() {
    const s = this.live?.state;
    const n = this.uncommittedCount() ?? 0;
    // The shared project folder: everyone's edits are in it, not just this worker's. Said first, and on the button.
    const shared = !s?.dir;
    confirmDialog(
      shared ? `⚠️ Discard everyone's uncommitted changes in the shared project folder?` : `Discard all uncommitted changes at ${this.name()}'s desk?`,
      shared
        ? `${this.name()} works in the project folder itself, so this throws away every uncommitted edit there, anyone's, not just its own: ${n} file${n === 1 ? '' : 's'} back to the last commit, and new files deleted. Commits stay.`
        : `This puts ${n} file${n === 1 ? '' : 's'} in ${this.where()} back to the last commit and deletes new files. Commits stay.`,
      shared ? "Discard everyone's changes" : 'Discard everything',
      () => this.send({ t: 'changes.discard' }),
    );
  }

  private commitAll() {
    const s = this.live?.state;
    const n = this.uncommittedCount() ?? 0;
    openPrompt({
      title: `✅ Commit ${n} file${n === 1 ? '' : 's'}`,
      subtitle: `Stages everything in ${this.where()} and commits it${s?.branch ? ` on ${s.branch}` : ''}.`,
      placeholder: 'What changed, and why',
      submitLabel: 'Commit',
      onSubmit: (text) => this.send({ t: 'changes.commit', message: text }),
    });
  }

  // --- Messages ---------------------------------------------------------------------------------

  private requestDiff(row: ChangeRow) {
    const live = this.live;
    if (!live) return;
    this.loading = true;
    this.requestedSig = row.sig ?? '';
    this.o.net.send({ t: 'changes.diff', workerId: live.workerId, path: row.path, repo: live.floor });
  }

  private onMsg(msg: ServerMsg) {
    const live = this.live;
    if (this.destroyed || !live) return;
    if (msg.t === 'changes' && msg.state.workerId === live.workerId && msg.state.repo === live.floor) {
      const moved = branchMoved(live.state, msg.state);
      live.state = msg.state;
      // The checkout changed: what was read over HTTP for this repository is old now. It stays on screen
      // until the fresh answer is in (the commit picked, too, is checked against the new list); the
      // count goes by the live flags meanwhile. The commits only when the branch moved.
      const repo = this.repoId;
      if (moved && this.commits.has(repo)) this.stale.add(`commits:${repo}`);
      if (this.whole.has(repo)) this.stale.add(`whole:${repo}`);
      if (this.counts.has(repo)) this.stale.add(`count:${repo}`);
      this.later();
      this.paint();
    } else if (msg.t === 'changes.diff' && msg.workerId === live.workerId && msg.repo === live.floor && msg.path === this.selected && this.diffKey.startsWith('live:')) {
      this.loading = false;
      this.shownSig = this.requestedSig;
      const f = live.state?.files.find((x) => x.path === this.selected);
      const text = msg.error ? h('div.changes-empty', {}, h('p', {}, msg.error)) : renderDiff(msg.diff, msg.truncated);
      const type = f ? changedImageType(f.path) : undefined;
      // A picture's diff only says it differs, so show the picture instead. An SVG is text too: its diff stays below.
      if (f && type) this.diffBody.replaceChildren(renderPreview(live.workerId, live.floor, f), ...(type === 'image/svg+xml' ? [text] : []));
      else this.diffBody.replaceChildren(text);
      // The file changed again while the diff was on its way: fetch the fresh one.
      if (f && f.sig !== this.shownSig) this.requestDiff(liveRow(f));
    }
  }

  // --- Drawing ----------------------------------------------------------------------------------

  paint() {
    if (this.destroyed) return;
    const { modes, count: n } = this.modesNow();
    if (!modes.includes(this.mode)) {
      this.mode = 'all';
      void this.fetchShown();
    }
    const l = this.listing();
    if (l.kind !== 'rows' || !l.rows.some((r) => r.path === this.selected)) this.selected = l.kind === 'rows' ? (l.rows[0]?.path ?? null) : null;
    this.paintBar(modes, n);
    this.paintCommits();
    this.paintList(l);
    this.paintDiffHead(l);
    this.paintDiff(l);
    this.paintFooter();
    this.onChange?.();
  }

  private paintBar(modes?: ChangesMode[], count?: number | null) {
    if (!modes) ({ modes, count } = this.modesNow());
    const repos = this.changes?.repos ?? [];
    const project = this.changes?.project ?? '';
    const prs = this.o.prs?.() ?? kstore.tasks.get(this.o.taskId)?.prs;
    const w = this.worker();
    const out: HTMLElement[] = [];
    if (repos.length > 1) {
      out.push(
        h(
          'div.kb-cv-repos',
          { role: 'tablist', 'aria-label': 'Repositories' },
          ...repos.map((r) => {
            const pr = prOfRepo(project, r.id, prs, w);
            const on = r.id === this.repoId;
            return h(
              'button.btn',
              { type: 'button', role: 'tab', class: on ? 'on' : '', 'aria-selected': String(on), title: r.error ?? (r.branch ? `${r.name}: ${r.branch}` : r.name), onclick: () => this.pickRepo(r.id) },
              `📁 ${r.name}`,
              pr ? h('small', {}, ` · #${pr}`) : null,
            );
          }),
        ),
      );
    }
    out.push(
      h(
        'div.kb-cv-modes',
        { role: 'group', 'aria-label': 'What to show' },
        ...modes.map((m) =>
          h(
            'button',
            { type: 'button', 'aria-pressed': String(m === this.mode), title: m === 'uncommitted' ? 'Edits and new files in the worktree that aren’t committed yet' : m === 'commits' ? 'The branch one commit at a time' : 'The branch against its base', onclick: () => this.setMode(m) },
            m === 'uncommitted' && count ? `${MODE_NAMES[m]} (${count})` : MODE_NAMES[m],
          ),
        ),
      ),
      h('button.btn.kb-cv-refresh', { type: 'button', title: 'Read the task’s changes again', 'aria-label': 'Refresh', onclick: () => void this.refresh() }, '↻'),
    );
    this.bar.replaceChildren(...out);
  }

  private paintCommits() {
    const list = this.mode === 'commits' ? this.commits.get(this.repoId) : undefined;
    const show = typeof list === 'object' && !list.error && list.commits.length > 0;
    this.commitsBox.classList.toggle('hidden', !show);
    if (!show) {
      this.commitsDrawn = null;
      return this.commitList.replaceChildren();
    }
    const picked = this.picked.get(this.repoId);
    if (this.commitsDrawn?.list === list && this.commitsDrawn.picked === picked) return;
    this.commitsDrawn = { list, picked };
    this.commitsHead.textContent = `${list.commits.length} commit${list.commits.length > 1 ? 's' : ''}`;
    this.commitList.replaceChildren(
      ...list.commits.map((c) => {
        const at = Date.parse(c.date);
        return h(
          'li',
          { class: c.hash === picked ? 'on' : '', role: 'option', 'aria-selected': String(c.hash === picked), tabindex: -1, title: c.subject, onclick: () => {
              if (c.hash !== picked) void this.pickCommit(c.hash);
            } },
          h('code', {}, c.hash.slice(0, 7)),
          h('span.subj', {}, c.subject),
          h('small', { title: fmtTime(at) }, `${c.author} · ${timeAgo(at)}`),
        );
      }),
    );
    this.commitList.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }

  private paintList(l: Listing) {
    this.list.replaceChildren();
    const rows = l.kind === 'rows' ? l.rows : [];
    const more = l.kind === 'rows' ? l.more : 0;
    const n = rows.length;
    const what = this.mode === 'commits' ? (n ? `${n} file${n > 1 ? 's' : ''} in this commit` : 'Files in this commit') : n ? `${n}${more ? '+' : ''} changed file${n > 1 || more ? 's' : ''}` : 'Changed files';
    this.filesHead.textContent = what;
    for (const f of rows) {
      this.list.append(
        h(
          'li',
          { class: f.path === this.selected ? 'on' : '', role: 'option', 'aria-selected': f.path === this.selected ? 'true' : 'false', tabindex: -1, onclick: () => this.select(f.path) },
          h('span.st', { class: f.tone, title: f.word }, f.letter),
          pathLabel(f.path),
          f.uncommitted ? h('span.dirty', { title: 'Not committed yet' }) : null,
          plusMinus(f.additions, f.deletions, f.binary),
        ),
      );
    }
    if (more) this.list.append(h('li.empty', {}, `…and ${more} more`));
    this.list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }

  private paintDiffHead(l: Listing) {
    const f = l.kind === 'rows' ? l.rows.find((r) => r.path === this.selected) : undefined;
    if (!f) return this.diffHead.replaceChildren();
    this.diffHead.replaceChildren(
      h('span.st', { class: f.tone }, f.letter),
      h('span.path', { title: f.path }, f.from ? `${f.from} → ${f.path}` : f.path),
      h('span.word', {}, f.uncommitted ? `${f.word} · not committed` : f.word),
      plusMinus(f.additions, f.deletions, f.binary),
    );
    if (l.kind === 'rows' && l.live && f.uncommitted && !this.live?.state?.busy) {
      const discardOne = h('button.btn', { type: 'button', title: 'Throw away the uncommitted changes to this file' }, '↩︎ Discard');
      discardOne.addEventListener('click', () =>
        confirmDialog(`Discard the changes to ${f.path.split('/').pop()}?`, `This puts ${f.path} back to the last commit in ${this.where()}. ${f.word === 'new file' ? 'The file is deleted.' : 'Committed changes stay.'}${this.live?.state?.dir ? '' : ' ⚠️ That is the shared project folder: anyone’s uncommitted edits to this file go too.'}`, 'Discard', () =>
          this.send({ t: 'changes.discard', path: f.path }),
        ),
      );
      this.diffHead.append(discardOne);
    }
  }

  private paintDiff(l: Listing) {
    const empty = (key: string, ...kids: HTMLElement[]) => {
      if (key === this.diffKey) return;
      this.diffKey = key;
      this.diffBody.replaceChildren(h('div.changes-empty', {}, ...kids));
    };
    if (l.kind === 'loading') return empty('loading', h('div.spinner'));
    if (l.kind === 'error') return empty(`error:${l.text}`, h('div.big', {}, '🚧'), h('p', {}, l.text));
    if (l.kind === 'note') return empty(`note:${l.text}`, h('div.big', {}, '🌱'), h('p', {}, l.text));
    const row = l.rows.find((r) => r.path === this.selected);
    if (!row) return empty(`none:${this.mode}:${l.empty.join()}`, h('div.big', {}, '🌱'), ...l.empty.map((t, i) => h(i ? 'p.note' : 'p', {}, t)));
    const key = `${l.live ? 'live' : `http:${this.gen}`}:${this.repoId}:${this.mode}:${this.mode === 'commits' ? this.picked.get(this.repoId) : ''}:${row.path}`;
    if (l.live) {
      if (key !== this.diffKey) {
        this.diffKey = key;
        this.shownSig = null;
        this.diffBody.replaceChildren(h('div.changes-empty', {}, h('div.spinner')));
        this.requestDiff(row);
      } else if (this.shownSig !== null && this.shownSig !== row.sig && !this.loading) this.requestDiff(row);
      return;
    }
    if (key === this.diffKey) return;
    this.diffKey = key;
    const parts = l.parts;
    const text = parts?.get(row.path);
    const last = l.last === row.path;
    if (text) this.diffBody.replaceChildren(renderDiff(text, !!l.truncated && last));
    else this.diffBody.replaceChildren(h('div.changes-empty', {}, h('p', {}, l.truncated ? '✂️ The diff is over 2 MB: this file is past where it stops.' : row.binary ? 'A binary file: no diff to show.' : 'No diff to show for this file.')));
  }

  private paintFooter() {
    this.summary.replaceChildren();
    this.prSlot.replaceChildren();
    const live = !!this.live;
    this.discardBtn.classList.toggle('hidden', !live);
    this.commitBtn.classList.toggle('hidden', !live);
    if (live) return this.liveFooter();
    const info = this.info();
    if (!info || info.error) return;
    const whole = this.whole.get(this.repoId);
    const commits = this.commits.get(this.repoId);
    const bits: (string | HTMLElement)[] = [];
    if (typeof whole === 'object' && !whole.error) {
      const n = whole.files.length;
      bits.push(`${n} file${n === 1 ? '' : 's'}`);
      if (n) bits.push(plusMinus(whole.files.reduce((a, f) => a + f.additions, 0), whole.files.reduce((a, f) => a + f.deletions, 0)));
    }
    if (typeof commits === 'object' && !commits.error) bits.push(`${commits.commits.length} commit${commits.commits.length === 1 ? '' : 's'}`);
    if (info.branch) bits.push(info.base ? `${info.branch} vs ${info.base}` : info.branch);
    bits.push(SOURCE_NAME[info.source]);
    if (info.headCommit) bits.push(h('code', { title: info.headCommit }, info.headCommit.slice(0, 7)));
    this.summary.append(...bits.map((b) => (typeof b === 'string' ? h('span', {}, b) : b)));
  }

  /** Upstream's footer, as its window has it: what's uncommitted and ahead, commit, discard, open a PR. */
  private liveFooter() {
    const s = this.live?.state ?? null;
    const busy = !!s?.busy;
    const uncommitted = this.uncommittedCount() ?? 0;
    const adds = s?.files.reduce((n, f) => n + f.additions, 0) ?? 0;
    const dels = s?.files.reduce((n, f) => n + f.deletions, 0) ?? 0;
    if (busy) this.summary.append(h('span.spinner'), h('span', {}, s!.busy!));
    else if (s && !s.error) {
      const bits: (string | HTMLElement)[] = [];
      if (s.files.length) bits.push(plusMinus(adds, dels));
      bits.push(uncommitted ? `${uncommitted} uncommitted` : s.files.length ? 'all committed' : '');
      if (s.ahead) bits.push(`${s.ahead} commit${s.ahead > 1 ? 's' : ''} ahead of ${s.base}`);
      if (!s.dir) bits.push(h('span', { title: "This worker works in the project folder itself, so this is everything uncommitted there — everyone's edits, not just its own." }, '📁 shared project folder'));
      else bits.push(h('span', { title: `Its own worktree at ${s.dir}` }, `📁 ${s.dir}`));
      this.summary.append(...bits.filter(Boolean).map((b) => (typeof b === 'string' ? h('span', {}, b) : b)));
    }
    this.discardBtn.disabled = busy || !uncommitted;
    this.commitBtn.disabled = busy || !uncommitted;
    this.commitBtn.textContent = uncommitted ? `✅ Commit ${uncommitted} file${uncommitted > 1 ? 's' : ''}…` : '✅ Commit…';
    if (!s) return;
    if (s.pr) this.prSlot.append(h('a.btn.primary', { href: s.pr.url, target: '_blank', rel: 'noopener', title: `Open on ${prHostName(s.pr.url)}` }, `🔀 PR #${s.pr.number} ↗`));
    else if (s.prBase) {
      const why = busy ? '' : uncommitted ? 'Commit first' : !s.ahead ? `Nothing on ${s.branch} that ${s.prBase} lacks yet` : '';
      const pr = h('button.btn.primary', { type: 'button', title: why || `Push ${s.branch} and open a pull request against ${s.prBase}` }, '🔀 Open PR…') as HTMLButtonElement;
      pr.disabled = busy || !!why;
      pr.addEventListener('click', () =>
        openPrompt({
          title: '🔀 Open a pull request',
          subtitle: `Pushes ${s.branch} to origin and opens a PR against ${s.prBase}. The first line is the title; the rest is the description.`,
          initial: s.subject ?? '',
          placeholder: 'Title',
          submitLabel: 'Open PR ↗',
          onSubmit: (text) => {
            const [first, ...rest] = text.split('\n');
            this.send({ t: 'changes.pr', title: first.trim(), body: rest.join('\n').trim() });
          },
        }),
      );
      this.prSlot.append(pr);
    }
  }
}

export interface ChangesViewHandle {
  el: HTMLElement;
  /** The task's worker changed (or went). */
  setWorker(workerId: string | undefined): void;
  /** Stops following the worker live and takes the view out. */
  destroy(): void;
}

/** The view inside another frame (the task view's Changes tab): no header of its own, filling `host`'s height. */
export function mountChangesView(host: HTMLElement, o: ChangesViewOptions): ChangesViewHandle {
  const view = new ChangesView(o, h('div.kb-cv-foot'));
  const el = h('div.kb-changes-view.kb-cv', {}, view.bar, view.body, view.foot);
  el.addEventListener('keydown', (e) => view.keydown(e));
  host.append(el);
  view.start();
  return {
    el,
    setWorker: (id) => view.setWorker(id),
    destroy() {
      view.destroy();
      el.remove();
    },
  };
}

export interface TaskChangesOptions {
  taskId: number;
  workerId?: string;
  repo?: string;
  floor?: string;
  /** ⌨️ Terminal in the header: the worker's terminal instead. */
  onTerminal?: () => void;
}

let current: { taskId: number; workerId?: string; view: ChangesView; modal: Modal } | null = null;

/**
 * The view in a window of its own, upstream's Changes window's frame: the worker's dot and name, the
 * branch, ⌨️ Terminal, ✕. Asked again for the same task and worker, it switches repository; another
 * one closes it, as upstream's does.
 */
export function openTaskChanges(net: Net, o: TaskChangesOptions) {
  if (current && current.taskId === o.taskId && current.workerId === o.workerId) return current.view.showRepo(o.repo, o.floor);
  const previous = current;
  const w = o.workerId ? store.workers.get(o.workerId) : undefined;
  const dot = h('span.dot', { style: `background:${w?.color ?? '#ccc'}` });
  const title = h('h2');
  const branch = h('span.branch');
  const terminalBtn = h('button.btn', { type: 'button', title: 'Open the terminal instead' }, '⌨️ Terminal');
  const closeBtn = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const renderHeader = () => {
    const now = view.worker();
    if (now) dot.setAttribute('style', `background:${now.color}`);
    title.textContent = now ? `${now.name} · changes` : `Task #${o.taskId} · changes`;
    branch.textContent = view.branchText();
  };
  const view = new ChangesView({ net, ...o }, h('footer'), () => renderHeader());
  const el = h(
    'div.modal.desk-changes.kb-cv',
    { role: 'dialog', 'aria-label': w ? `${w.name}'s changes` : `Task #${o.taskId}'s changes`, tabindex: -1 },
    h('header', {}, dot, title, branch, o.onTerminal ? terminalBtn : null, closeBtn),
    view.bar,
    view.body,
    view.foot,
  );
  el.addEventListener('keydown', (e) => view.keydown(e));
  terminalBtn.addEventListener('click', () => {
    o.onTerminal?.();
    modal.close();
  });
  const modal = openModal(el, {
    doing: w ? `🌿 looking over ${w.name}'s changes` : `🌿 looking over task #${o.taskId}'s changes`,
    onClose: () => {
      view.destroy();
      if (current?.modal === modal) current = null;
    },
  });
  current = { taskId: o.taskId, workerId: o.workerId, view, modal };
  previous?.modal.close();
  closeBtn.addEventListener('click', () => modal.close());
  view.start();
  renderHeader();
  setTimeout(() => el.focus(), 30);
}
