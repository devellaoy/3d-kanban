import './meetingpast.css';
import { MEETING_PATTERNS } from '../../shared/meetings';
import { fmtCost, fmtTokens, type MeetingArchiveList, type MeetingFileInfo, type MeetingFileText, type MeetingRecord } from '../../shared/protocol';
import { apiUrl } from '../multiplayer/visit';
import { store } from '../state';
import { h, timeAgo, toast } from './dom';
import { markdownFile } from './markdown';

// The meeting window's earlier meetings: the floor's archive (GET /api/meetings), a meeting's details and
// its notes folder, and one note read at a time. What's in the notes was written by agents, so it only
// ever reaches the page as text or as markdown that markdownFile sanitizes.

type ArchivedMeeting = MeetingRecord & { orphan?: boolean };

/** A request's answer, or why there isn't one (with the HTTP status, 0 when the request never got there). */
type Got<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function get<T>(path: string, params: Record<string, string> = {}): Promise<Got<T>> {
  const q = new URLSearchParams({ ...params, floor: store.floor ?? '' }).toString();
  try {
    const r = await fetch(apiUrl(`${path}?${q}`), { credentials: 'same-origin' });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.json().catch(() => null))?.error ?? `HTTP ${r.status}` };
    return { ok: true, data: (await r.json()) as T };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What to say when a note can't be shown. */
function fileProblem(status: number, error: string): string {
  if (status === 413) return 'This file is too big to show here (over 1 MB). It’s still in the meeting’s notes folder.';
  if (status === 415) return 'This file isn’t text, so it can’t be shown here.';
  if (status === 404) return 'This file isn’t there any more.';
  return `Couldn’t open the file: ${error}`;
}

const isMd = (name: string) => /\.(md|markdown)$/i.test(name);
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** What the list depends on: the newest earlier meeting, the finished ones still on a table, and the floor. It's refetched when this changes. */
const listKey = () => [store.floor ?? '', store.meeting.past[0]?.id ?? '', ...store.meeting.rooms.flatMap((r) => (r.current && r.current.status !== 'running' ? [r.current.id] : []))].join('|');
const roomLabel = (id?: string) => (id ? (store.meeting.rooms.find((r) => r.id === id)?.label ?? id) : '');

/**
 * The earlier meetings view: a searchable list beside the picked meeting's details, files and the open
 * file (one panel at a time on a narrow screen). `back` returns to the window's previous view; `refresh`
 * (on every meeting event) only refetches the list when it's asked to or the floor's earlier meetings changed.
 */
export function meetingPast(back: () => void): { body: HTMLElement; foot: Node[]; refresh(reload?: boolean): void } {
  let meetings: ArchivedMeeting[] | null = null;
  let more = false;
  let listError = '';
  let seen = '';
  let seenFloor = store.floor;
  let listSeq = 0;
  let picked: ArchivedMeeting | null = null;
  let files: MeetingFileInfo[] | null = null;
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

  const matches = (m: ArchivedMeeting) => {
    const q = search.value.trim().toLowerCase();
    return !q || (typeof m.title === 'string' && m.title.toLowerCase().includes(q)) || (typeof m.prompt === 'string' && m.prompt.toLowerCase().includes(q));
  };

  const renderList = () => {
    if (!meetings) {
      count.textContent = listError ? '' : 'Looking through the notes…';
      list.replaceChildren(listError ? h('li.mp-none.bad', {}, `Couldn’t load the earlier meetings: ${listError}`) : '');
      return;
    }
    const shown = meetings.filter(matches);
    count.textContent = !meetings.length ? '' : shown.length === meetings.length ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}${more ? ', the newest' : ''}` : `${shown.length} of ${meetings.length}`;
    if (!meetings.length) return list.replaceChildren(h('li.mp-none', {}, 'No earlier meetings on this floor yet. A meeting shows up here once it’s over.'));
    if (!shown.length) return list.replaceChildren(h('li.mp-none', {}, 'No meeting matches that.'));
    list.replaceChildren(
      ...shown.map((m) => {
        const p = MEETING_PATTERNS[m.pattern];
        const room = roomLabel(m.room);
        const line = m.orphan
          ? `${new Date(m.finishedAt).toLocaleString()} · no record, only notes`
          : [room, m.status === 'done' ? '✅ done' : '⛔ stopped', m.calledBy, timeAgo(new Date(m.finishedAt).toISOString())].filter(Boolean).join(' · ');
        return h(
          'li',
          {},
          h('button.mp-item', { type: 'button', class: m.id === picked?.id ? 'on' : '', 'aria-current': m.id === picked?.id ? 'true' : false, onclick: () => pick(m) },
            h('span.mp-item-title', {}, `${m.orphan || !p ? '🗂️' : p.icon} ${m.title}`),
            h('span.mp-item-line', {}, line)),
        );
      }),
    );
  };
  search.addEventListener('input', renderList);

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
      if (picked) picked = meetings.find((m) => m.id === picked!.id) ?? picked;
    } else if (!meetings) listError = got.error;
    else toast(`Couldn’t refresh the earlier meetings: ${got.error}`, 'warn');
    renderList();
    if (!picked) renderDetail();
  };

  const renderDetail = () => {
    const m = picked;
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
      if (Array.isArray(m.seats) && m.seats.length) rows.push(row('At the table', h('ul.mp-seats', {}, ...m.seats.map((s, i) => h('li', {}, h('b', {}, s.role), s.workerName ? ` · ${s.workerName}` : '', i === 0 ? h('span.muted', {}, ' (head)') : '')))));
    } else rows.push(row('Ended', new Date(m.finishedAt).toLocaleString()));
    detail.replaceChildren(
      h('h3.mp-title', {}, `${m.orphan || !p ? '🗂️' : p.icon} ${m.title}`),
      m.orphan ? h('p.muted', {}, 'Only its notes folder is left: the office kept no record of this meeting.') : '',
      h('dl.mp-facts', {}, ...rows),
      m.summary ? h('p.mp-summary', {}, m.summary) : '',
      typeof m.prompt === 'string' && m.prompt ? h('div.mp-question', {}, h('b', {}, 'The question'), h('pre', {}, m.prompt)) : '',
    );
  };

  const renderFiles = () => {
    if (!picked) return fileList.replaceChildren();
    if (filesError) return fileList.replaceChildren(h('p.mp-none.bad', {}, `Couldn’t list the notes: ${filesError}`));
    if (!files) return fileList.replaceChildren(h('p.mp-none', {}, 'Opening the notes folder…'));
    if (!files.length) return fileList.replaceChildren(h('p.mp-none', {}, 'There are no notes left for this meeting.'));
    const item = (f: MeetingFileInfo) =>
      h('li', {}, h('button.mp-file', { type: 'button', class: `${f.kind === 'output' ? 'output' : ''} ${open?.name === f.name ? 'on' : ''}`, 'aria-current': open?.name === f.name ? 'true' : false, onclick: () => openFile(f.name) },
        h('span.mp-file-name', {}, `${f.kind === 'output' ? '📄' : '📝'} ${f.name}`),
        f.kind === 'output' ? h('span.pill.done', {}, 'output') : '',
        h('span.muted', {}, fmtSize(f.size))));
    const outputs = files.filter((f) => f.kind === 'output');
    const groups = new Map<string, MeetingFileInfo[]>();
    for (const f of files.filter((x) => x.kind !== 'output')) {
      const g = f.round ? `Round ${f.round}` : 'Other';
      groups.set(g, [...(groups.get(g) ?? []), f]);
    }
    // Rounds in order, the files that belong to none last.
    const names = [...groups.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : Number(a.slice(6)) - Number(b.slice(6))));
    fileList.replaceChildren(
      h('h4', {}, '🗂️ Files'),
      outputs.length ? h('ul.mp-file-list', {}, ...outputs.map(item)) : '',
      ...names.flatMap((g) => [h('h5', {}, g), h('ul.mp-file-list', {}, ...groups.get(g)!.map(item))]),
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
      h('button.btn.small', { type: 'button', title: 'Copy the file’s text', onclick: () => copy(f.text) }, '📋 Copy'),
      h('button.btn.small', { type: 'button', title: 'Save the file', onclick: () => download(f) }, '⬇️ Download'),
    );
    preview.replaceChildren(head, md && !raw ? markdownFile(f.text) : h('pre.mp-raw', {}, f.text));
  };

  const pick = async (m: ArchivedMeeting) => {
    picked = m;
    files = null;
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
    const seq = ++filesSeq;
    const got = await get<{ files: MeetingFileInfo[] }>(`/api/meetings/${encodeURIComponent(m.id)}/files`);
    if (seq !== filesSeq) return;
    if (got.ok) files = got.data.files;
    else filesError = got.error;
    renderFiles();
    // The output is what most people came for: open it straight away.
    const out = files?.find((f) => f.kind === 'output');
    if (out) void openFile(out.name);
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

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast('📋 Copied'),
      () => toast('Couldn’t copy: the browser said no', 'warn'),
    );

  const download = (f: MeetingFileText) => {
    const url = URL.createObjectURL(new Blob([f.text], { type: isMd(f.name) ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }));
    // Not through h(): its href guard lets only http(s) through, and this is a blob: of our own.
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name.split('/').pop() || 'note.txt';
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
