import './windows.css';
import type { GhPull, GhPullDetail, GhReviewComment } from '../../../shared/protocol';
import type { Net } from '../../net';
import { store } from '../../state';
import { h } from '../dom';
import { icon, iconButton } from '../icons';
import { outLink, prPill, segmented } from '../kit';
import { modalShell, openShell } from '../shell';
import { tabCount, tabStrip } from '../tabs';
// Which task owns the pull request, and which of the project's repositories it is in (github/ghrepo.ts).
import { prOwner } from '../../kanban/prowner';
import { ghLabel, ghUrl, sameItem } from './ghrepo';
import { hostLabel, hostOfUrl } from '../../../shared/hosting/remote';
import { getJson, getText } from './api';
import { commentBox } from './comment-box';
import { conflicted, hostedMergeStatus, mergeBox, mergeStatus, openMerge } from './merge';
import { commentCard, errorBox, nodes, reviewBadge, spinnerRow, stateOf } from './pieces';
import { FILES_KEY, mergePref, pref, savePref, TAB_KEY } from './prefs';
import { fixAndMergePrompt, fixConflictsPrompt, type BoardActions } from './prompts';
import { buildTree, looksGenerated, parseDiff, renderFileDiff, renderThread, repliesOf, Reviewed, STATUS_WORD, treeOrder, type DiffFile, type TreeDir } from './pulldiff';
import { pullFooter, pullRail } from './pull-rail';

// The window behind a card on the PR board, in the shared shell (ui/shell.ts). A PR opens on its
// conversation (how it stands and its checks, the description, comments, reviews and line comments,
// the comment box) beside a rail of details and ways to hand it to a worker (pull-rail.ts), with a Files
// tab for the diff, where you tick files off as reviewed; closing and merging it are in the footer.

export function openPull(first: GhPull, net: Net, actions: BoardActions) {
  let it = first;
  const itemUrl = it.url;
  // Which of the project's repositories it's in (none: the floor's own, as upstream).
  const repo = first.repo;
  // A pull request on Azure DevOps or Bitbucket: the window reads and comments on it, and what only GitHub has (labels, merging, closing, gh's fix-up prompts) is left out.
  const host = hostOfUrl(it.url) ?? 'github';
  const onGitHub = host === 'github';
  const label = ghLabel(it.number, repo);
  const reviewed = new Reviewed(it.url);
  const owner = prOwner(net, () => it); // the task that owns it
  let detail: GhPullDetail | null = null;
  let detailError = '';
  let files: DiffFile[] | null = null;
  let diffError = '';
  let tab: 'conversation' | 'files' = pref<string>(TAB_KEY, '') === 'files' ? 'files' : 'conversation';
  let mode: 'tree' | 'list' = pref<string>(FILES_KEY, '') === 'list' ? 'list' : 'tree';
  let filter = '';
  let current = '';
  const collapsedDirs = new Set<string>();
  /** Files you opened or closed yourself; the rest follow the defaults (reviewed ones closed). */
  const open = new Map<string, boolean>();
  const sections = new Map<string, { sec: HTMLElement; body: HTMLElement; box: HTMLInputElement; built: boolean; big: boolean }>();

  // --- Frame
  const state = h('span.iw-slot');
  const review = h('span.iw-slot');
  const line = h('span.gh-line');
  const reload = iconButton('refresh-cw', 'Refresh', { title: `Refresh: read it from ${hostLabel(host)} again` });
  // The shared tab strip (ui/tabs.ts); the labels are filled in by renderFrame.
  const strip = tabStrip<typeof tab>([{ id: 'conversation', label: '' }, { id: 'files', label: '' }], tab, (t) => setTab(t), 'Pull request sections', 'ghtab');
  const tabConv = strip.buttons.get('conversation')!;
  const tabFiles = strip.buttons.get('files')!;
  // The comment box stays put while the conversation above it is redrawn, so a load finishing
  // doesn't take the focus (or the text) away from someone typing.
  const thread = h('div.gh-items');
  const comment = commentBox('pull', it.number, itemUrl, net, (c) => {
    if (!detail) return loadAll();
    detail.comments.push(c);
    renderConv();
    renderFrame();
  }, repo);
  const filesPane = h('div.pd');
  const shell = modalShell({
    cls: 'gh-window w1200',
    kind: 'rich',
    title: it.title,
    label: `Pull request ${label}`,
    id: repo ? `${repo.split('/').pop()} #${it.number}` : label,
    pill: state,
    meta: [review],
    tools: [reload],
    lines: [line],
    tabs: strip.el,
    body: h('div.gh-conv', {}, thread, comment.el),
    rail: [],
    footerLeft: [outLink(`Open on ${hostLabel(host)}`, it.url)],
  });
  const el = shell.el;
  el.tabIndex = -1;
  // The diff takes the whole width: it stands beside the conversation and its rail, one of the two shown.
  shell.main.after(filesPane);

  const handToWorker = () => {
    const p = mergePref(detail?.repo.methods ?? ['squash', 'merge', 'rebase']);
    if (detail && conflicted(detail)) actions.assign(fixConflictsPrompt(it, p.method, p.deleteBranch), `Fix conflicts & merge PR #${it.number}`);
    else actions.assign(fixAndMergePrompt(it, p.method, p.deleteBranch), `Fix up & merge PR #${it.number}`);
  };

  const renderFrame = () => {
    state.replaceChildren(prPill(stateOf(it)));
    review.replaceChildren(...nodes(it.reviewDecision ? reviewBadge(it.reviewDecision) : null));
    shell.setTitle(it.title);
    const commits = detail ? `${detail.commits} commit${detail.commits === 1 ? '' : 's'}` : 'its commits';
    line.replaceChildren(h('strong', {}, it.author), it.state === 'MERGED' ? ` merged ${commits} into ` : ` wants to merge ${commits} into `, h('code.code-chip', {}, it.baseRefName), ' from ', h('code.code-chip', {}, it.headRefName));
    const done = files ? files.filter((f) => reviewed.mark(f) === 'reviewed').length : 0;
    tabConv.replaceChildren(...nodes('Conversation', detail ? tabCount(detail.comments.length + detail.reviews.length + detail.reviewComments.filter((c) => !c.replyTo).length) : null));
    tabFiles.replaceChildren(...nodes('Files changed', files ? tabCount(files.length) : null, files?.length ? h('span.gh-progress', { class: done === files.length ? 'all' : '', title: `${done} of ${files.length} reviewed` }, icon('check', { size: 12 }), `${done}/${files.length}`) : null));
    strip.set(tab);
    shell.main.classList.toggle('hidden', tab !== 'conversation');
    shell.rail!.classList.toggle('hidden', tab !== 'conversation');
    filesPane.classList.toggle('hidden', tab !== 'files');

    const side = {
      it,
      detail,
      files: files ? files.length : null,
      net,
      actions,
      onGitHub,
      conflicts: !!detail && conflicted(detail),
      owner: owner.button(), // Fix via task #N
      ownerTask: owner.taskId(),
      openTask: (id: number) => void import('../../kanban/taskview').then((m) => m.openTaskWindow(net, id)),
      handToWorker,
      merge: () => detail && openMerge(it, detail, net, handToWorker, loadAll),
      reload: loadAll,
      relabel: (labels: GhPull['labels']) => ((it = { ...it, labels }), renderFrame()),
    };
    shell.rail!.replaceChildren(...pullRail(side));
    shell.setFooter([outLink(`Open on ${hostLabel(host)}`, it.url)], pullFooter(side));
  };

  // --- Conversation
  const showInDiff = (c: GhReviewComment) => {
    setTab('files');
    requestAnimationFrame(() => revealLine(c.path, c.side, c.line));
  };

  const renderConv = () => {
    const opened = commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt, url: it.url }, itemUrl, 'opened this', { role: 'Author' });
    if (detailError) return thread.replaceChildren(opened, errorBox(detailError, loadAll));
    if (!detail) return thread.replaceChildren(opened, spinnerRow('Loading the conversation…'));
    const d = detail;
    const replies = repliesOf(d.reviewComments);
    const items: { at: string; node: HTMLElement }[] = [
      ...d.comments.map((c) => ({ at: c.createdAt, node: commentCard(c, itemUrl, '', c.author === it.author ? { role: 'Author' } : {}) })),
      ...d.reviews.map((r) => ({ at: r.createdAt, node: commentCard(r, itemUrl, '', { review: r.state ?? '', role: 'Reviewer' }) })),
      ...d.reviewComments
        .filter((c) => !c.replyTo)
        .map((c) => ({
          at: c.createdAt,
          node: h(
            'article.gh-thread',
            {},
            h(
              'header.gh-thread-head',
              {},
              icon('message-square', { size: 14 }),
              h('code', { title: c.path }, `${c.path}${c.line ? `:${c.line}` : ''}`),
              c.line == null ? h('span.gh-badge.muted', {}, 'Outdated') : h('button.link-btn', { type: 'button', onclick: () => showInDiff(c) }, 'Show in diff'),
            ),
            renderThread(c, replies, itemUrl),
          ),
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    // How it stands comes first: elsewhere the office doesn't merge, and the box says where it does.
    thread.replaceChildren(mergeBox(onGitHub ? mergeStatus(d) : hostedMergeStatus(d, hostLabel(host)), d.checks), opened, ...items.map((x) => x.node));
    if (!items.length) thread.append(h('p.gh-quiet', {}, 'No comments or reviews yet.'));
  };

  // --- Files
  /** The files in the order the sidebar lists them, after the filter. */
  let order: DiffFile[] = [];
  const shown = () => {
    if (!files) return [];
    const q = filter.trim().toLowerCase();
    const list = mode === 'tree' ? treeOrder(buildTree(files)) : files;
    return q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list;
  };

  const isOpenFile = (f: DiffFile) => open.get(f.path) ?? reviewed.mark(f) !== 'reviewed';

  const buildBody = (f: DiffFile) => {
    const s = sections.get(f.path)!;
    s.body.replaceChildren();
    s.built = true;
    s.body.append(renderFileDiff(f, detail?.reviewComments ?? [], itemUrl));
  };

  let budget = 0;
  const syncSection = (f: DiffFile) => {
    const s = sections.get(f.path)!;
    const mark = reviewed.mark(f);
    const isOpen = isOpenFile(f);
    s.sec.classList.toggle('closed', !isOpen);
    s.sec.classList.toggle('reviewed', mark === 'reviewed');
    s.box.checked = mark === 'reviewed';
    s.sec.querySelector('.pd-stale')?.classList.toggle('hidden', mark !== 'stale');
    if (!isOpen || s.built) return;
    // Big files and lock files wait for a click, so a huge PR doesn't lock up the window.
    if (s.big && !open.get(f.path)) {
      s.body.replaceChildren(
        h('div.pd-big', {}, looksGenerated(f.path) ? 'Generated or lock file — not shown by default.' : `Large diff (${f.lines.length} lines) — not shown by default.`, h('button.btn', { type: 'button', onclick: () => (open.set(f.path, true), buildBody(f)) }, 'Show diff')),
      );
      return;
    }
    buildBody(f);
  };

  const setReviewed = (f: DiffFile, on: boolean, advance = false) => {
    reviewed.set(f, on);
    open.delete(f.path);
    const s = sections.get(f.path);
    const pane = filesPane.querySelector<HTMLElement>('.pd-main');
    syncSection(f);
    // Closing a file you were reading: keep its header in view instead of jumping past the next one.
    if (on && s && pane && s.sec.offsetTop < pane.scrollTop) pane.scrollTop = s.sec.offsetTop;
    if (on && advance) {
      const next = order.slice(order.indexOf(f) + 1).find((x) => reviewed.mark(x) !== 'reviewed');
      if (next) scrollToFile(next.path);
    }
    renderSide();
    renderFrame();
  };

  const scrollToFile = (p: string, reveal = false) => {
    const s = sections.get(p);
    const pane = filesPane.querySelector<HTMLElement>('.pd-main');
    const f = files?.find((x) => x.path === p);
    if (!s || !pane || !f) return;
    if (reveal && !isOpenFile(f)) {
      open.set(p, true);
      syncSection(f);
    }
    pane.scrollTop = s.sec.offsetTop;
    setCurrent(p);
  };

  const revealLine = (p: string, side: 'LEFT' | 'RIGHT', line: number | null) => {
    const f = files?.find((x) => x.path === p);
    const s = sections.get(p);
    if (!f || !s) return;
    open.set(p, true);
    syncSection(f);
    if (!s.built) buildBody(f);
    const row = s.body.querySelector<HTMLElement>(side === 'LEFT' ? `.pd-l[data-old="${line}"]:not(.add)` : `.pd-l[data-new="${line}"]`);
    const pane = filesPane.querySelector<HTMLElement>('.pd-main')!;
    if (!row) return scrollToFile(p);
    // Rows sit in .pd-main's coordinates (it's the positioned ancestor), like the sections.
    pane.scrollTop = row.offsetTop - pane.clientHeight / 3;
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
    setCurrent(p);
  };

  const side = h('aside.pd-side');
  const fileList = h('ul.pd-files', { role: 'tree' });
  const filterInput = h('input.inp', { type: 'text', placeholder: 'Filter files…', 'aria-label': 'Filter files' }) as HTMLInputElement;
  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    renderFiles();
  });

  const setCurrent = (p: string) => {
    if (current === p) return;
    current = p;
    for (const li of fileList.querySelectorAll<HTMLElement>('li[data-path]')) {
      const on = li.dataset.path === p;
      li.classList.toggle('on', on);
      if (on) li.scrollIntoView({ block: 'nearest' });
    }
  };

  const checkBtn = (f: DiffFile) => {
    const mark = reviewed.mark(f);
    return h(
      'button.pd-tick',
      {
        type: 'button',
        class: mark,
        title: mark === 'reviewed' ? 'Reviewed — click to unmark' : mark === 'stale' ? 'Changed since you reviewed it' : 'Mark as reviewed',
        'aria-pressed': String(mark === 'reviewed'),
        onclick: ((e: Event) => {
          e.stopPropagation();
          setReviewed(f, mark !== 'reviewed');
        }) as EventListener,
      },
      mark === 'reviewed' ? icon('check', { size: 12 }) : mark === 'stale' ? '!' : null,
    );
  };

  const countComments = (p: string) => detail?.reviewComments.filter((c) => c.path === p && !c.replyTo).length ?? 0;

  const fileRow = (f: DiffFile, depth: number) => {
    const slash = f.path.lastIndexOf('/');
    const n = countComments(f.path);
    return h(
      'li.pd-row',
      { 'data-path': f.path, class: `${current === f.path ? 'on' : ''} ${reviewed.mark(f)}`, style: `--depth:${depth}`, role: 'treeitem', title: f.path, onclick: () => scrollToFile(f.path, true) },
      checkBtn(f),
      h('span.pd-st', { class: f.status, title: STATUS_WORD[f.status] }, f.status),
      // The name first and its folder after, so a narrow sidebar cuts the folder, not the name.
      h('span.pd-path', {}, f.path.slice(slash + 1), mode === 'list' && slash >= 0 ? h('span.dir', {}, ` ${f.path.slice(0, slash)}`) : null),
      n ? h('span.pd-c', { title: `${n} comment${n > 1 ? 's' : ''}` }, icon('message-square', { size: 12 }), String(n)) : null,
      h('span.gh-pm', {}, f.binary ? h('span.bin', {}, 'bin') : h('span', {}, h('span.add', {}, `+${f.additions}`), ' ', h('span.del', {}, `−${f.deletions}`))),
    );
  };

  const dirRows = (d: TreeDir, depth: number, visible: Set<DiffFile>, out: HTMLElement[]) => {
    for (const sub of d.dirs) {
      const inside = treeOrder(sub).filter((f) => visible.has(f));
      if (!inside.length) continue;
      const shut = collapsedDirs.has(sub.path) && !filter;
      const all = inside.every((f) => reviewed.mark(f) === 'reviewed');
      out.push(
        h(
          'li.pd-dir',
          {
            style: `--depth:${depth}`,
            role: 'treeitem',
            'aria-expanded': String(!shut),
            title: sub.path,
            onclick: () => {
              if (collapsedDirs.has(sub.path)) collapsedDirs.delete(sub.path);
              else collapsedDirs.add(sub.path);
              renderSide();
            },
          },
          icon(shut ? 'chevron-right' : 'chevron-down', { size: 14, cls: 'pd-caret' }),
          icon(shut ? 'folder' : 'folder-open', { size: 14 }),
          h('span.pd-path', {}, sub.name),
          all ? h('span.pd-done', { title: 'Everything in here is reviewed' }, icon('check', { size: 14 })) : null,
        ),
      );
      if (!shut) dirRows(sub, depth + 1, visible, out);
    }
    for (const f of d.files) if (visible.has(f)) out.push(fileRow(f, depth));
  };

  const renderSide = () => {
    if (!files) return;
    const rows: HTMLElement[] = [];
    if (mode === 'tree') dirRows(buildTree(files), 0, new Set(order), rows);
    else rows.push(...order.map((f) => fileRow(f, 0)));
    if (!rows.length) rows.push(h('li.pd-none', {}, filter ? 'No files match.' : 'No files changed.'));
    fileList.replaceChildren(...rows);
    const done = files.filter((f) => reviewed.mark(f) === 'reviewed').length;
    const bar = side.querySelector<HTMLElement>('.pd-bar i');
    if (bar) bar.style.width = `${files.length ? (100 * done) / files.length : 0}%`;
    const txt = side.querySelector<HTMLElement>('.pd-done-txt');
    if (txt) txt.textContent = `${done} of ${files.length} file${files.length === 1 ? '' : 's'} reviewed`;
  };

  const renderFiles = () => {
    order = shown();
    renderSide();
    const main = filesPane.querySelector<HTMLElement>('.pd-main');
    if (!main || !files) return;
    main.replaceChildren(...order.map((f) => sections.get(f.path)!.sec));
    if (!order.length) main.append(h('div.pd-note', {}, 'No files match the filter.'));
  };

  const setupFiles = () => {
    const was = filesPane.querySelector<HTMLElement>('.pd-main')?.scrollTop ?? 0;
    filesPane.replaceChildren();
    sections.clear();
    if (diffError) return filesPane.append(errorBox(diffError, loadAll));
    if (!files) return filesPane.append(spinnerRow('Loading the diff…'));
    const modes = segmented<typeof mode>([['tree', 'Tree'], ['list', 'List']], mode, (m) => ((mode = m), savePref(FILES_KEY, m), renderFiles()), 'How the files are listed');
    modes.el.classList.add('pd-mode');
    side.replaceChildren(
      h('div.pd-side-head', {}, modes.el, h('div.pd-bar', {}, h('i')), h('div.pd-done-txt')),
      filterInput,
      fileList,
      h('div.pd-keys', {}, h('kbd.kbd', {}, 'J'), h('kbd.kbd', {}, 'K'), 'next / previous file · ', h('kbd.kbd', {}, 'V'), 'reviewed'),
    );
    const main = h('div.pd-main', { tabindex: -1 });
    budget = 0;
    for (const f of files) {
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.addEventListener('change', () => setReviewed(f, box.checked));
      const body = h('div.pd-fbody');
      const n = countComments(f.path);
      const big = looksGenerated(f.path) || f.lines.length > 800 || budget > 6000;
      if (!big) budget += f.lines.length;
      const sec = h(
        'section.pd-file',
        { 'data-path': f.path },
        h(
          'header.pd-fh',
          {},
          h('button.pd-fold', { type: 'button', 'aria-label': 'Show or hide this file', onclick: () => (open.set(f.path, !isOpenFile(f)), syncSection(f)) }, icon('chevron-down', { size: 16 })),
          h('span.pd-st', { class: f.status, title: STATUS_WORD[f.status] }, f.status),
          h('span.pd-fpath', { title: f.path }, f.status === 'R' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
          h('span.gh-pm', {}, f.binary ? h('span.bin', {}, 'binary') : h('span', {}, h('span.add', {}, `+${f.additions}`), ' ', h('span.del', {}, `−${f.deletions}`))),
          n ? h('span.pd-c', {}, icon('message-square', { size: 12 }), String(n)) : null,
          h('span.pd-stale.hidden', { title: 'The file changed after you marked it reviewed' }, 'changed since review'),
          h('label.pd-viewed', { title: 'Mark as reviewed (V)' }, box, 'Reviewed'),
        ),
        body,
      );
      sections.set(f.path, { sec, body, box, built: false, big });
      syncSection(f);
    }
    main.addEventListener('scroll', () => {
      if (spy) return;
      spy = requestAnimationFrame(() => {
        spy = 0;
        const top = main.scrollTop + 12;
        let at = '';
        for (const f of order) {
          const s = sections.get(f.path)!;
          if (s.sec.offsetTop > top) break;
          at = f.path;
        }
        if (at) setCurrent(at);
      });
    });
    filesPane.append(side, main);
    renderFiles();
    main.scrollTop = was;
    if (!current && order[0]) setCurrent(order[0].path);
  };
  let spy = 0;

  const step = (dir: 1 | -1) => {
    const i = order.findIndex((f) => f.path === current);
    const next = order[Math.max(0, Math.min(order.length - 1, i + dir))];
    if (next) scrollToFile(next.path, true);
  };

  el.addEventListener('keydown', (e) => {
    if (tab !== 'files' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input[type=text], textarea')) return;
    if (e.key === 'j' || e.key === 'n') step(1);
    else if (e.key === 'k' || e.key === 'p') step(-1);
    else if (e.key === 'v') {
      const f = files?.find((x) => x.path === current);
      if (f) setReviewed(f, reviewed.mark(f) !== 'reviewed', true);
    } else return;
    e.preventDefault();
  });

  const setTab = (t: typeof tab) => {
    tab = t;
    savePref(TAB_KEY, t);
    renderFrame();
    if (t === 'files') filesPane.querySelector<HTMLElement>('.pd-main')?.focus({ preventScroll: true });
  };

  // --- Loading
  let generation = 0;
  function loadAll() {
    const g = ++generation;
    detailError = '';
    diffError = '';
    renderConv();
    getJson<GhPullDetail>(ghUrl(`/api/gh/pull?number=${it.number}`, repo))
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        comment.setViewer(d.viewer);
        // Who owns it is asked once, on open, and again when its state changes (a merged PR is nobody's to fix).
        if (d.state !== it.state) owner.load(renderFrame);
        it = { ...it, state: d.state, isDraft: d.isDraft, reviewDecision: d.reviewDecision };
        // Line comments go into the diff, so draw it again with them.
        if (files) setupFiles();
      })
      .catch((err) => g === generation && (detailError = (err as Error).message))
      .finally(() => g === generation && (renderFrame(), renderConv()));
    getText(ghUrl(`/api/gh/pull/diff?number=${it.number}`, repo))
      .then((text) => {
        if (g !== generation) return;
        files = parseDiff(text);
      })
      .catch((err) => g === generation && (diffError = (err as Error).message))
      .finally(() => g === generation && (setupFiles(), renderFrame()));
    renderFrame();
  }
  reload.addEventListener('click', () => {
    net.send({ t: 'gh.refresh' });
    loadAll();
  });

  const unsub = store.on('pulls', () => {
    const fresh = store.pulls.items.find((p) => sameItem(p, it)); // in its repository
    if (!fresh) return;
    it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
    renderFrame();
  });
  openShell(shell, {
    doing: `🔀 reading PR ${label}`,
    onClose: () => {
      unsub();
      comment.dispose();
    },
  });
  renderFrame();
  setupFiles();
  owner.load(renderFrame);
  loadAll();
  setTimeout(() => el.focus({ preventScroll: true }), 30);
}
