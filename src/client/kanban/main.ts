// The kanban page (/kanban): the task process as a board, beside the 3D office. It connects the way the
// 2D view does (a Net in lite mode: in the office without standing anywhere in it), subscribes to the
// kanban's deltas for one project or all of them, and reuses upstream's windows for a task worker's
// terminal and changes. Picking a project also takes you to its floor, so 🏢 3D opens where you were.

import { Net } from '../net';
import { AVATAR_COLORS, lastFloor, loadProfile, saveProfile, store } from '../state';
import { randomLook } from '../../shared/avatar';
import { $, h, modalOpen, openModal, toast } from '../ui/dom';
import { openTerminal, openTerminalFor, routeTerminalMessage } from '../ui/terminal';
import { openChanges, openChangesFor, routeChangesMessage } from '../ui/changes';
import { routeWorktreeMessage } from '../ui/prompt';
import { routePullMessage } from '../ui/pull';
import { openPromptEditor } from '../ui/prompts';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { KANBAN_TOOLS, type KanbanTool, type TaskStatus } from '../../shared/kanban/types.js';
import { kanbanApi, type KanbanError, type KanbanOk } from './api';
import { Board } from './board';
import { tickCountdowns } from './card';
import { openCreate } from './create';
import { DetailPanel, isDetailTab } from './detail';
import { openIssues } from './issues';
import { boardStats, deepLink, EMPTY_FILTER, filterActive, parseDeepLink, STATE_FILTERS, TICKET_FILTERS, type BoardFilter, type StateFilter, type TicketFilter } from './model';
import { openKanbanSettings } from './settings';
import { kstore } from './store';
import { LANGS, lang, onLang, setLang, t, toolName, type Lang } from './i18n';
import { run, select, textInput } from './ui';

const link = parseDeepLink(location.search);
const FILTER_KEY = 'kanban.filter';
const PROJECT_KEY = 'kanban.project';

// ---- Who you are, and the connection --------------------------------------------------------------
const saved = loadProfile();
store.profile = { name: saved?.name ?? 'Guest', color: saved?.color ?? AVATAR_COLORS[1], look: saved?.look ?? randomLook() };
const net = new Net(() => store.profile, () => null, true);
const api = kanbanApi(net);
let bootVersion = '';

function loadFilter(): BoardFilter {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
    if (f && typeof f === 'object') {
      return {
        q: '',
        repos: Array.isArray(f.repos) ? f.repos.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20) : [],
        state: STATE_FILTERS.includes(f.state) ? f.state : 'all',
        tools: Array.isArray(f.tools) ? f.tools.filter((x: unknown): x is KanbanTool => KANBAN_TOOLS.includes(x as KanbanTool)) : [],
        ticket: TICKET_FILTERS.includes(f.ticket) ? f.ticket : 'any',
      };
    }
  } catch {
    // storage blocked or garbled
  }
  return { ...EMPTY_FILTER };
}
const filter = loadFilter();
function saveFilter() {
  try {
    // The search box isn't kept: it's for the moment.
    localStorage.setItem(FILTER_KEY, JSON.stringify({ ...filter, q: '' }));
  } catch {
    // storage blocked
  }
}

/** The project the page opens on: the link's, else the one picked here last, else the floor you were on. */
function firstProject(): string | null {
  if (link.project) return link.project;
  try {
    const p = localStorage.getItem(PROJECT_KEY);
    if (p === '') return null;
    if (p) return p;
  } catch {
    // storage blocked
  }
  return lastFloor();
}
kstore.project = firstProject();

// ---- The page -------------------------------------------------------------------------------------
const bar = $('kb-bar');
const boardEl = $('kb-board');
const detailEl = $('kb-detail');
let archiveOpen = false;

const board = new Board({
  root: boardEl,
  filter: () => filter,
  open: (id) => openTask(id),
  move: (id, to) => move(id, to),
  archiveOpen: () => archiveOpen,
  toggleArchive: () => toggleArchive(),
  selected: () => detail.id,
});

const detail = new DetailPanel({
  api,
  root: detailEl,
  openTask: (id) => openTask(id),
  closed: () => {
    history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { task: null })}`);
    board.render();
    // Back to the card it was opened from, for the keyboard.
    if (lastOpened) boardEl.querySelector<HTMLElement>(`.kb-card[data-id="${lastOpened}"]`)?.focus();
  },
  edit: (task) => openCreate(api, { task }),
  moveMenu: (id) => board.moveMenu(id),
  openTerminal: (workerId, project) => onFloor(project, workerId, () => showTerminal(workerId)),
  openChanges: (workerId, project, repo) => onFloor(project, workerId, () => openChanges(net, workerId, () => showTerminal(workerId), repo)),
});

let lastOpened: number | null = null;
function openTask(id: number, tab?: string) {
  lastOpened = id;
  detail.open(id, isDetailTab(tab) ? tab : undefined);
  history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { task: id })}`);
  board.render();
}

async function move(id: number, to: TaskStatus) {
  const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.task.move', id, to }));
  if (ok?.startError) toast(ok.startError, 'warn');
}

function toggleArchive() {
  archiveOpen = !archiveOpen;
  kstore.includeArchived = archiveOpen;
  subscribe();
  renderBar();
  board.render();
}

/** A task worker's terminal. The narrow screen gets the keypad, as on the 2D view. */
function showTerminal(workerId: string) {
  openTerminal(net, workerId, () => openChanges(net, workerId, () => showTerminal(workerId)), undefined, { keypad: window.matchMedia('(max-width: 700px)').matches });
}

/**
 * Runs `then` once the page is on `project`'s floor with `workerId` in sight: the office tells a page
 * only about the workers of the floor it's on, so another project's terminal takes a ride first.
 */
function onFloor(project: string, workerId: string, then: () => void) {
  if (store.floor === project && store.workers.has(workerId)) return then();
  if (store.floor === project) return toast(t('workerGone'), 'warn');
  const note = toast(t('goingToFloor', { name: kstore.projectOf(project)?.name ?? project }));
  let done = false;
  const check = () => {
    if (done || store.floor !== project) return;
    done = true;
    offFloor();
    offWorkers();
    clearTimeout(timer);
    note.remove();
    if (store.workers.has(workerId)) then();
    else toast(t('workerGone'), 'warn');
  };
  const offFloor = store.on('floor', check);
  const offWorkers = store.on('workers', check);
  const timer = setTimeout(() => {
    offFloor();
    offWorkers();
    if (!done) toast(t('floorTimeout'), 'error');
  }, 8000);
  net.send({ t: 'floor.go', floor: project });
}

// ---- The top bar ----------------------------------------------------------------------------------
const search = textInput('', { type: 'search', id: 'kb-search', placeholder: t('searchPlaceholder'), 'aria-label': t('search') });
search.addEventListener('input', () => {
  filter.q = search.value;
  clearBtn.classList.toggle('hidden', !filterActive(filter));
  board.render();
});
const statsEl = h('div.kb-stats', { role: 'status' });
let clearBtn = h('button.btn.small.hidden', { type: 'button' });

function renderBar() {
  const searching = document.activeElement === search;
  const projects = kstore.projects;
  const projectSel = select<string>([['', `🏢 ${t('allProjects')}`], ...projects.map((p) => [p.id, `🏢 ${p.name}${p.open ? '' : ` (${t('closed')})`}`] as const)], kstore.project ?? '', { 'aria-label': t('project'), id: 'kb-project' });
  // A remembered project that's gone: all of them instead.
  if (kstore.loaded && kstore.project && !projects.some((p) => p.id === kstore.project)) projectSel.value = '';
  projectSel.addEventListener('change', () => pickProject(projectSel.value || null));

  const repos = (kstore.project ? kstore.projectOf(kstore.project)?.repos : projects.flatMap((p) => p.repos.map((r) => ({ ...r, name: `${p.name} / ${r.name}` })))) ?? [];
  const uniqueRepos = [...new Map(repos.map((r) => [r.id, r])).values()];
  const repoSel = select<string>([['', `📦 ${t('allRepos')}`], ...uniqueRepos.map((r) => [r.id, `📦 ${r.name}`] as const)], filter.repos[0] ?? '', { 'aria-label': t('repository') });
  repoSel.classList.toggle('hidden', uniqueRepos.length < 2 && !filter.repos.length);
  repoSel.addEventListener('change', () => setFilter({ repos: repoSel.value ? [repoSel.value] : [] }));
  const stateSel = select<StateFilter>(STATE_FILTERS.map((s) => [s, t(`filter.${s}`)] as const), filter.state, { 'aria-label': t('state') });
  stateSel.addEventListener('change', () => setFilter({ state: stateSel.value as StateFilter }));
  const toolSel = select<string>([['', t('allTools')], ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], filter.tools[0] ?? '', { 'aria-label': t('tool') });
  toolSel.addEventListener('change', () => setFilter({ tools: toolSel.value ? [toolSel.value as KanbanTool] : [] }));
  const ticketSel = select<TicketFilter>(TICKET_FILTERS.map((x) => [x, t(`ticketFilter.${x}`)] as const), filter.ticket, { 'aria-label': t('ticket') });
  ticketSel.addEventListener('change', () => setFilter({ ticket: ticketSel.value as TicketFilter }));
  clearBtn = h('button.btn.small', { type: 'button', class: filterActive(filter) ? '' : 'hidden', onclick: () => clearFilters() }, `✕ ${t('clearFilters')}`);

  const langSel = select<Lang>(LANGS.map((l) => [l, l.toUpperCase()] as const), lang(), { 'aria-label': t('language'), title: t('language') });
  langSel.addEventListener('change', () => setLang(langSel.value as Lang));
  const to3d = h('a.btn', { href: '/?3d=1', title: t('to3dHint') }, `🏢 ${t('to3d')}`);
  to3d.addEventListener('click', () => {
    // The 3D office opens on the floor this page is on (it reads the same remembered floor).
    if (kstore.project && store.floor !== kstore.project) net.send({ t: 'floor.go', floor: kstore.project });
  });

  search.placeholder = t('searchPlaceholder');
  search.setAttribute('aria-label', t('search'));
  bar.replaceChildren(
    h('div.kb-bar-row', {}, h('h1.kb-brand', {}, '🗂️ ', h('span', {}, t('kanban'))), projectSel, search, h('span.grow'), statsEl, h('button.btn', { type: 'button', id: 'kb-issues', onclick: showIssues, title: t('issuesHint'), 'aria-label': t('issues') }, '📌 ', h('span.kb-lbl', {}, t('issues'))), h('button.btn.primary', { type: 'button', id: 'kb-new', onclick: () => newTask(), title: 'N' }, `＋ ${t('newTask')}`)),
    h(
      'div.kb-bar-row.kb-filters',
      { role: 'group', 'aria-label': t('filters') },
      repoSel,
      stateSel,
      toolSel,
      ticketSel,
      clearBtn,
      h('span.grow'),
      h('button.btn.small', { type: 'button', 'aria-pressed': String(archiveOpen), onclick: toggleArchive, title: t('archiveHint2') }, `🗄️ ${t('archive')}`),
      langSel,
      to3d,
      h('button.btn.small', { type: 'button', onclick: () => showSettings(), 'aria-label': t('settings'), title: t('settings') }, '⚙️'),
    ),
  );
  paintStats();
  if (searching) search.focus();
}

/** The counts in the top bar, and the tab's title: redrawn on their own, so the search box keeps its focus. */
function paintStats() {
  const s = boardStats(kstore.tasks.values(), kstore.project);
  statsEl.setAttribute('aria-label', t('stats'));
  statsEl.replaceChildren(
    h('span', { title: t('statTotal') }, `🗂️ ${s.total}`),
    h('span', { title: t('statRunning') }, `🚧 ${s.running}`),
    h('span', { class: s.attention ? 'hot' : '', title: t('statAttention') }, `🙋 ${s.attention}`),
    h('span', { title: t('statReview') }, `👀 ${s.review}`),
  );
  const name = kstore.projectOf(kstore.project ?? undefined)?.name;
  document.title = `${s.attention ? `(${s.attention}) ` : ''}${name ? `${name} · ` : ''}${t('kanban')} · Agent Office`;
}

function setFilter(patch: Partial<BoardFilter>) {
  Object.assign(filter, patch);
  saveFilter();
  clearBtn.classList.toggle('hidden', !filterActive(filter));
  board.render();
}

function clearFilters() {
  Object.assign(filter, { ...EMPTY_FILTER, q: '' });
  search.value = '';
  saveFilter();
  renderBar();
  board.render();
}

function pickProject(id: string | null) {
  kstore.project = id;
  try {
    localStorage.setItem(PROJECT_KEY, id ?? '');
  } catch {
    // storage blocked
  }
  // Another project's repositories aren't this one's.
  if (filter.repos.length) filter.repos = [];
  history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { project: id })}`);
  if (id && store.floor !== id) net.send({ t: 'floor.go', floor: id });
  kstore.loaded = false;
  subscribe();
  renderBar();
  board.render();
}

function subscribe() {
  if (!net.up) return;
  api
    .request<Extract<KanbanServerMsg, { t: 'kanban.snapshot' }>>({ t: 'kanban.subscribe', project: kstore.project, ...(kstore.includeArchived ? { includeArchived: true } : {}) })
    .then((snap) => {
      // The office may answer for another project than asked (one that's gone: all of them).
      if (snap.t !== 'kanban.snapshot' || snap.project === kstore.project) return;
      kstore.project = snap.project;
      kstore.apply(snap);
      renderBar();
      board.render();
    })
    .catch((err: KanbanError) => {
      // A lost connection subscribes again when it's back.
      if (!err.fromOffice) return;
      toast(err.message, 'error');
      // Most likely a project that's gone: all of them instead.
      if (kstore.project) pickProject(null);
    });
}

function newTask() {
  openCreate(api, { project: kstore.project ?? store.floor ?? undefined, created: (id) => openTask(id) });
}

function showIssues() {
  const p = kstore.project ?? (kstore.projectOf(store.floor ?? undefined) ? store.floor : kstore.projects[0]?.id);
  if (!p) return toast(t('noProjects'), 'warn');
  openIssues(api, p, (id) => openTask(id));
}

function showSettings(first?: Parameters<typeof openKanbanSettings>[1]['first']) {
  openKanbanSettings(api, { first, project: kstore.project ?? undefined, openPromptEditor: (id) => openPromptEditor(net, id) });
}

// ---- Messages -------------------------------------------------------------------------------------
let linkOpened = false;
api.on((msg: KanbanServerMsg) => {
  const changed = kstore.apply(msg);
  if (msg.t === 'kanban.task') detail.cardChanged(msg.task.id);
  if (msg.t === 'kanban.task.removed') detail.removed(msg.id);
  detail.apply(msg);
  if (msg.t === 'kanban.snapshot' && changed && !linkOpened) {
    linkOpened = true;
    if (link.task) openTask(link.task);
    if (link.settings) showSettings();
  }
  if (changed) {
    // A card's change only moves the counts; the rest of the bar is redrawn when what it lists changes.
    if (msg.t === 'kanban.task' || msg.t === 'kanban.task.removed') paintStats();
    else renderBar();
    board.render();
    if (msg.t !== 'kanban.task' && detail.id !== null) detail.render();
  }
});

net.onStatus((up) => $('conn').classList.toggle('hidden', up));
net.onMessage((msg) => {
  store.apply(msg);
  routeTerminalMessage(msg);
  routeChangesMessage(msg);
  routePullMessage(msg);
  routeWorktreeMessage(msg);
  switch (msg.t) {
    case 'welcome': {
      // Back from a restart on another version: this page's code is stale, so load the new one.
      if (!bootVersion) bootVersion = msg.version;
      else if (msg.version !== bootVersion) return location.reload();
      // A reconnected office has forgotten the subscription, and which terminal was open.
      subscribe();
      const openId = openTerminalFor();
      if (openId && store.workers.has(openId)) net.send({ t: 'worker.attach', workerId: openId });
      const watching = openChangesFor();
      if (watching && store.workers.has(watching.workerId)) net.send({ t: 'changes.watch', ...watching });
      if (kstore.project && store.floor !== kstore.project && store.floors.some((f) => f.id === kstore.project)) net.send({ t: 'floor.go', floor: kstore.project });
      break;
    }
    case 'toast':
      toast(msg.text, msg.level);
      break;
    case 'upgrade':
      if (msg.state.phase === 'restarting') {
        net.expectRestart();
        toast(t('restarting'));
      }
      break;
  }
});
// A worker's name and state in the detail's Terminal tab come from the floor's workers.
store.on('workers', () => detail.workersChanged());

// ---- Keys -----------------------------------------------------------------------------------------
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
window.addEventListener('keydown', (e) => {
  if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && detail.id !== null) {
    e.preventDefault();
    // Half-written text isn't thrown away by one Esc: the first one leaves the box, the next closes.
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (typing(e) && 'value' in el && el.value.trim()) return el.blur();
    detail.close();
    return;
  }
  if (typing(e)) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    newTask();
  }
});

// The detail panel sits under the top bar, however tall the bar wraps to.
new ResizeObserver(() => document.documentElement.style.setProperty('--kb-bar-h', `${bar.offsetHeight}px`)).observe(bar);

// Every retry countdown ticks by itself.
setInterval(() => tickCountdowns(document), 1000);

onLang(() => {
  document.documentElement.lang = lang();
  $('conn').textContent = t('reconnecting');
  renderBar();
  board.render();
  if (detail.id !== null) detail.render();
});

// ---- In -------------------------------------------------------------------------------------------
function askName(done: (name: string) => void) {
  const input = h('input', { type: 'text', maxlength: 24, placeholder: t('yourName'), 'aria-label': t('yourName'), autocomplete: 'nickname' }) as HTMLInputElement;
  const form = h('form.modal.lite-name', {}, h('header', {}, h('h2', {}, `👋 ${t('whoIsIt')}`)), h('div.body', {}, h('p', {}, t('nameWhy')), input), h('footer', {}, h('button.btn.primary', { type: 'submit' }, t('comeIn'))));
  const modal = openModal(form, { escCloses: false, backdropCloses: false });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    modal.close();
    done(name);
  });
  setTimeout(() => input.focus(), 30);
}

document.documentElement.lang = lang();
$('conn').textContent = t('reconnecting');
renderBar();
board.render();

void (async () => {
  try {
    const res = await fetch('/api/whoami', { cache: 'no-store' });
    if (res.status === 401) return void (location.href = `/login?next=${encodeURIComponent('/kanban')}`);
    const { me } = (await res.json()) as { me?: typeof store.me };
    if (me) store.me = me;
  } catch {
    // the welcome message says it too
  }
  if (store.me.account) store.profile.name = store.me.account.name;
  if (saved || store.me.account) return net.connect();
  askName((name) => {
    store.profile.name = name;
    saveProfile({ name, color: store.profile.color });
    net.connect();
  });
})();

// Debug handle for quick checks from the console / headless screenshots.
(window as unknown as { __kanban: unknown }).__kanban = { store, kstore, net, api };
