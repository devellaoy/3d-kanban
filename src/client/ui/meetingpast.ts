import './meetingpast.css';
import { MEETING_PATTERNS, archiveKey } from '../../shared/meetings';
import { fmtCost, fmtTokens, type ArchivedMeeting, type MeetingArchiveList, type MeetingFileInfo, type MeetingFiles, type MeetingFileText } from '../../shared/protocol';
import { store } from '../state';
import { fileProblem, get } from './meetingapi';
import { handoffButtons, type HandoffHost } from './meetinghandoff';
import type { Net } from '../net';
import { h, timeAgo, toast } from './dom';
import { markdownFile } from './markdown';
import { copy } from './team';

// The meeting window's earlier meetings: the floor's archive (GET /api/meetings), a meeting's details and
// its notes folder, and one note read at a time. What's in the notes was written by agents, so it only
// ever reaches the page as text or as markdown that markdownFile sanitizes.

const isMd = (name: string) => /\.(md|markdown)$/i.test(name);
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const listKey = () => archiveKey(store.floor, store.meeting);
const roomLabel = (id?: string) => (id ? (store.meeting.rooms.find((r) => r.id === id)?.label ?? id) : '');

/**
 * The earlier meetings view: a searchable list beside the picked meeting's details, files and the open
 * file (one panel at a time on a narrow screen). `back` returns to the window's previous view; `refresh`
 * (on every meeting event) only refetches the list when it's asked to or the floor's earlier meetings changed.
 */
export function meetingPast(back: () => void, hand?: { handoff: HandoffHost; net: Net; close(): void }): { body: HTMLElement; foot: Node[]; refresh(reload?: boolean): void } {
  let meetings: ArchivedMeeting[] | null = null;
  let more = false;
  let listError = '';
  let seen = '';
  let seenFloor = store.floor;
  let listSeq = 0;
  let picked: ArchivedMeeting | null = null;
  /** The picked meeting in full (the list has only a snippet of its question); the list's line shows until it arrives. */
  let full: ArchivedMeeting | null = null;
  let fullSeq = 0;
  let files: MeetingFileInfo[] | null = null;
  let skipped = 0;
  let filesError = '';
  let filesSeq = 0;
  let open: { name: string; text?: MeetingFileText; error?: string } | null = null;
  let fileSeq = 0;
  let raw = false;

  const search = h('input', { type: 'text', placeholder: 'Search titles and questions…', 'aria-label': 'Search earlier meetings', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const count = h('div.mp-count');
  const list = h('ul.mp-list', { 'aria-label': 'Earlier meetings' });
  const side = h('div.mp-side', {}, h('div.mp-find', {}, search), count, list);
  const toList = h('button.btn.small.mp-back', { type: 'button' }, '← All meetings');
  const detail = h('div.mp-detail');
  const fileList = h('div.mp-files');
  const preview = h('div.mp-preview');
  const main = h('div.mp-main', {}, toList, detail, fileList, preview);
  const root = h('div.mp', {}, side, main);

  /** On a narrow screen: the list, or the picked meeting. */
  const showDetail = (on: boolean) => root.classList.toggle('mp-picked', on);
  toList.addEventListener('click', () => {
    showDetail(false);
    (list.querySelector('.mp-item.on') as HTMLElement | null)?.focus();
  });

  /** The list's rows with what the search looks in (lowercased title and question snippet), made once per list load. */
  let rows: { m: ArchivedMeeting; li: HTMLElement; text: string }[] = [];
  const noMatch = h('li.mp-none', {}, 'No meeting matches that.');

  /** Hides the rows the search doesn't match, without rebuilding them. */
  const filterList = () => {
    if (!meetings?.length) return;
    const q = search.value.trim().toLowerCase();
    let n = 0;
    for (const r of rows) {
      r.li.hidden = !!q && !r.text.includes(q);
      if (!r.li.hidden) n++;
    }
    noMatch.hidden = n > 0;
    count.textContent = n === meetings.length ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}${more ? ', the newest' : ''}` : `${n} of ${meetings.length}`;
  };

  const renderList = () => {
    rows = [];
    if (!meetings) {
      count.textContent = listError ? '' : 'Looking through the notes…';
      list.replaceChildren(listError ? h('li.mp-none.bad', {}, `Couldn’t load the earlier meetings: ${listError}`) : '');
      return;
    }
    count.textContent = '';
    if (!meetings.length) return list.replaceChildren(h('li.mp-none', {}, 'No earlier meetings on this floor yet. A meeting shows up here once it’s over.'));
    rows = meetings.map((m) => {
      const p = MEETING_PATTERNS[m.pattern];
      const room = roomLabel(m.room);
      const line = m.orphan
        ? `${new Date(m.finishedAt).toLocaleString()} · no record, only notes`
        : [room, m.status === 'done' ? '✅ done' : '⛔ stopped', m.calledBy, timeAgo(new Date(m.finishedAt).toISOString())].filter(Boolean).join(' · ');
      const li = h(
        'li',
        {},
        h('button.mp-item', { type: 'button', class: m.id === picked?.id ? 'on' : '', 'aria-current': m.id === picked?.id ? 'true' : false, onclick: () => pick(m) },
          h('span.mp-item-title', {}, `${m.orphan || !p ? '🗂️' : p.icon} ${m.title}`),
          h('span.mp-item-line', {}, line)),
      );
      return { m, li, text: `${typeof m.title === 'string' ? m.title : ''}\n${typeof m.prompt === 'string' ? m.prompt : ''}`.toLowerCase() };
    });
    list.replaceChildren(...rows.map((r) => r.li), noMatch);
    filterList();
  };
  search.addEventListener('input', filterList);

  const loadList = async () => {
    const seq = ++listSeq;
    seen = listKey();
    listError = '';
    renderList();
    const got = await get<MeetingArchiveList>('/api/meetings');
    if (seq !== listSeq) return;
    if (got.ok) {
      meetings = got.data.meetings;
      more = got.data.more;
      // The picked meeting's line comes from the new list, and stays picked while it's still on it.
      if (picked) {
        picked = meetings.find((m) => m.id === picked!.id) ?? picked;
        renderDetail(); // a late commit or review link shows; the notes and the open file stay as they are
        void loadFull(picked.id); // and the full record is fetched again, for the same reason
      }
    } else if (!meetings) listError = got.error;
    else toast(`Couldn’t refresh the earlier meetings: ${got.error}`, 'warn');
    renderList();
    if (!picked) renderDetail();
  };

  const renderDetail = () => {
    const m = full && full.id === picked?.id ? full : picked;
    if (!m) {
      detail.replaceChildren(h('p.mp-none', {}, meetings?.length ? 'Pick a meeting to see how it went and read its notes.' : ''));
      return;
    }
    const p = MEETING_PATTERNS[m.pattern];
    const room = roomLabel(m.room);
    const row = (label: string, ...value: (Node | string)[]) => h('div.mp-row', {}, h('dt', {}, label), h('dd', {}, ...value));
    const rows: HTMLElement[] = [];
    if (!m.orphan) {
      rows.push(row('Pattern', `${p ? `${p.icon} ${p.label}` : m.pattern}${room ? ` · ${room}` : ''}`));
      rows.push(row('Ended', `${m.status === 'done' ? '✅ done' : '⛔ stopped'} ${timeAgo(new Date(m.finishedAt).toISOString())}${m.calledBy ? ` · called by ${m.calledBy}` : ''}`));
      if (m.rounds) rows.push(row('Rounds', String(m.rounds)));
      if (m.tokens) rows.push(row('Spend', `${fmtTokens(m.tokens)} tokens${m.cost !== undefined ? ` · ${fmtCost(m.cost)}` : ''}`));
      if (m.branch) rows.push(row('Branch', h('code', {}, m.branch), m.commit ? ` · commit ${m.commit}` : ''));
      if (m.reviewUrl?.startsWith('https://')) rows.push(row('Review', h('a', { href: m.reviewUrl, target: '_blank', rel: 'noopener noreferrer' }, `🔍 The review${m.pr ? ` on PR #${m.pr}` : ''} ↗`)));
      if (m.handedTo?.length) {
        rows.push(
          row('Handed on', ...m.handedTo.flatMap((x, i) => [i ? ', ' : '', x.task !== undefined ? h('button.btn.small', { type: 'button', title: `Open task #${x.task}`, onclick: () => hand && void import('../kanban/taskview').then((k) => k.openTaskWindow(hand.net, x.task!)) }, `#${x.task}`) : (x.worker ?? '')])),
        );
      }
      if (Array.isArray(m.seats) && m.seats.length) rows.push(row('At the table', h('ul.mp-seats', {}, ...m.seats.map((s, i) => h('li', {}, h('b', {}, s.role), s.workerName ? ` · ${s.workerName}` : '', i === 0 ? h('span.muted', {}, ' (head)') : '')))));
    } else rows.push(row('Ended', new Date(m.finishedAt).toLocaleString()));
    detail.replaceChildren(
      h('h3.mp-title', {}, `${m.orphan || !p ? '🗂️' : p.icon} ${m.title}`),
      m.orphan ? h('p.muted', {}, 'Only its notes folder is left: the office kept no record of this meeting.') : '',
      h('dl.mp-facts', {}, ...rows),
      m.summary ? h('p.mp-summary', {}, m.summary) : '',
      // The output is what's handed on: only once the notes are listed is it known to be there.
      hand && !m.orphan && files?.some((f) => f.kind === 'output') ? h('div.mp-handoff', {}, ...handoffButtons(hand.net, m.id, hand.handoff, hand.close)) : '',
      typeof m.prompt === 'string' && m.prompt ? h('div.mp-question', {}, h('b', {}, 'The question'), h('pre', {}, m.prompt)) : '',
    );
  };

  const renderFiles = () => {
    if (!picked) return fileList.replaceChildren();
    if (filesError) return fileList.replaceChildren(h('p.mp-none.bad', {}, `Couldn’t list the notes: ${filesError}`));
    if (!files) return fileList.replaceChildren(h('p.mp-none', {}, 'Opening the notes folder…'));
    const skippedNote = skipped ? h('p.mp-none.muted', {}, `${skipped} item${skipped === 1 ? '' : 's'} not shown (folders or links)`) : '';
    if (!files.length) return fileList.replaceChildren(h('p.mp-none', {}, skipped ? 'No notes can be shown for this meeting.' : 'There are no notes left for this meeting.'), skippedNote);
    const item = (f: MeetingFileInfo) =>
      h('li', {}, h('button.mp-file', { type: 'button', class: `${f.kind === 'output' ? 'output' : ''} ${open?.name === f.name ? 'on' : ''}`, 'aria-current': open?.name === f.name ? 'true' : false, onclick: () => openFile(f.name) },
        h('span.mp-file-name', {}, `${f.kind === 'output' ? '📄' : '📝'} ${f.name}`),
        f.kind === 'output' ? h('span.pill.done', {}, 'output') : '',
        h('span.muted', {}, fmtSize(f.size))));
    const outputs = files.filter((f) => f.kind === 'output');
    const groups = new Map<number, MeetingFileInfo[]>();
    for (const f of files.filter((x) => x.kind !== 'output')) {
      const r = f.round ?? Infinity; // the files that belong to no round come last
      groups.set(r, [...(groups.get(r) ?? []), f]);
    }
    const rounds = [...groups.keys()].sort((a, b) => a - b);
    fileList.replaceChildren(
      h('h4', {}, '🗂️ Files'),
      outputs.length ? h('ul.mp-file-list', {}, ...outputs.map(item)) : '',
      ...rounds.flatMap((r) => [h('h5', {}, r === Infinity ? 'Other' : `Round ${r}`), h('ul.mp-file-list', {}, ...groups.get(r)!.map(item))]),
      skippedNote,
    );
  };

  const renderPreview = () => {
    if (!open) return preview.replaceChildren();
    const head = h('div.mp-preview-head', {}, h('b.mp-file-name', {}, open.name));
    if (open.error) return preview.replaceChildren(head, h('p.mp-none.bad', {}, open.error));
    const f = open.text;
    if (!f) return preview.replaceChildren(head, h('p.mp-none', {}, 'Opening…'));
    const md = isMd(f.name);
    if (md) head.append(h('button.btn.small', { type: 'button', 'aria-pressed': String(raw), onclick: () => ((raw = !raw), renderPreview()) }, raw ? '👁️ Rendered' : '🔤 Raw'));
    head.append(
      h('button.btn.small', { type: 'button', title: 'Copy the file’s text', onclick: () => copyText(f.text) }, '📋 Copy'),
      h('button.btn.small', { type: 'button', title: 'Save the file', onclick: () => download(f) }, '⬇️ Download'),
    );
    preview.replaceChildren(head, md && !raw ? markdownFile(f.text, { images: false }) : h('pre.mp-raw', {}, f.text));
  };

  const pick = async (m: ArchivedMeeting) => {
    picked = m;
    full = null;
    files = null;
    skipped = 0;
    filesError = '';
    open = null;
    raw = false;
    fileSeq++;
    showDetail(true);
    renderList();
    renderDetail();
    renderFiles();
    renderPreview();
    main.scrollTop = 0;
    void loadFull(m.id);
    const seq = ++filesSeq;
    const got = await get<MeetingFiles>(`/api/meetings/${encodeURIComponent(m.id)}/files`);
    if (seq !== filesSeq) return;
    if (got.ok) {
      files = got.data.files;
      skipped = got.data.skipped;
    } else filesError = got.error;
    renderFiles();
    renderDetail();
    // The output is what most people came for: open it straight away.
    const out = files?.find((f) => f.kind === 'output');
    if (out) void openFile(out.name);
  };

  /** Fetches the picked meeting's full record; the answer of an earlier pick (or of one that's no longer picked) is dropped. */
  const loadFull = async (id: string) => {
    const seq = ++fullSeq;
    const got = await get<ArchivedMeeting>(`/api/meetings/${encodeURIComponent(id)}`);
    if (seq !== fullSeq || picked?.id !== id || !got.ok) return; // on failure the list's line stays
    full = got.data;
    renderDetail();
  };

  const openFile = async (name: string) => {
    const id = picked?.id;
    if (!id) return;
    open = { name };
    raw = false;
    renderFiles();
    renderPreview();
    const seq = ++fileSeq;
    const got = await get<MeetingFileText>(`/api/meetings/${encodeURIComponent(id)}/file`, { name });
    if (seq !== fileSeq) return;
    open = got.ok ? { name, text: got.data } : { name, error: fileProblem(got.status, got.error) };
    renderPreview();
  };

  const copyText = (text: string) => void copy(text).then((ok) => (ok ? toast('📋 Copied') : toast('Couldn’t copy: the browser said no', 'warn')));

  const download = (f: MeetingFileText) => {
    const url = URL.createObjectURL(new Blob([f.text], { type: isMd(f.name) ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }));
    // Not through h(): its href guard lets only http(s) through, and this is a blob: of our own.
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  renderList();
  renderDetail();
  void loadList();

  return {
    body: root,
    foot: [h('span.grow', {}, 'The meetings’ notes stay in the floor’s .agent-office/meetings/ folder.'), h('button.btn', { type: 'button', onclick: back }, '← Back')],
    refresh(reload = false) {
      const key = listKey();
      if (key === seen && !reload) return;
      // Another floor has other meetings: back to its list.
      if (store.floor !== seenFloor) {
        seenFloor = store.floor;
        picked = null;
        full = null;
        fullSeq++;
        files = null;
        open = null;
        filesSeq++;
        fileSeq++;
        meetings = null;
        showDetail(false);
        renderDetail();
        renderFiles();
        renderPreview();
      }
      void loadList();
    },
  };
}
