// The kanban page (/kanban): the task process as a board, beside the 3D office. It connects the way the
// 2D view does (a Net in lite mode: in the office without standing anywhere in it), subscribes to the
// kanban's deltas for one project or all of them, and reuses upstream's windows for a task worker's
// terminal and changes. Picking a project also takes you to its floor, so 3D office opens where you were.

import { Net } from '../net';
import { AVATAR_COLORS, lastFloor, loadProfile, loadSettings, saveProfile, saveSettings, store } from '../state';
import { randomLook } from '../../shared/avatar';
import { $, h, modalOpen, openModal, toast } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { btn, selectChip } from '../ui/kit';
import { openTerminal, openTerminalFor, routeTerminalMessage, type TerminalOptions } from '../ui/terminal';
import { openChanges, openChangesFor, routeChangesMessage } from '../ui/changes';
import { routeWorktreeMessage } from '../ui/prompt';
import { routePullMessage } from '../ui/pull';
import { routeFloorAdded } from '../ui/flooradd';
import { openSettings } from '../ui/settings';
import { DesktopNotifier } from '../notify';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { KANBAN_TOOLS, type KanbanTool, type TaskStatus } from '../../shared/kanban/types.js';
import { kanbanApi, type KanbanError, type KanbanOk } from './api';
import { Board } from './board';
import { tickCountdowns } from './card';
import { openCreate } from './create';
import { moveWithDialog } from './holddialog';
import { openIssues } from './issues';
import { openPulls } from './pulls';
import { officeActions } from '../shared/officeactions';
import { workerOpener } from '../shared/openworker';
import { installWorkerBar } from './workerbar';
import { boardStats, deepLink, EMPTY_FILTER, filterActive, isTaskTab, parseDeepLink, STATE_FILTERS, TICKET_FILTERS, type BoardFilter, type StateFilter, type TicketFilter } from './model';
import { kstore } from './store';
import { TaskWindows } from './taskwindow';
import { toolName } from './labels';
import { run, select, textInput } from './ui';
import { initAppearance } from '../themes';

initAppearance();

const link = parseDeepLink(location.search);
const FILTER_KEY = 'kanban.filter';
const PROJECT_KEY = 'kanban.project';
const STATE_FILTER_NAMES: Record<StateFilter, string> = { all: 'Any', running: 'Running', attention: 'Needs you', retrying: 'Waiting to retry', has_pr: 'Has a PR' };
const TICKET_FILTER_NAMES: Record<TicketFilter, string> = { any: 'Any', with: 'With a ticket', without: 'Without a ticket' };

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
let archiveOpen = false;

const board = new Board({
  root: boardEl,
  filter: () => filter,
  open: (id) => openTask(id),
  move: (id, to) => move(id, to),
  archiveOpen: () => archiveOpen,
  toggleArchive: () => toggleArchive(),
  selected: () => taskWindows.id,
  newTask: () => newTask(),
});

const taskWindows = new TaskWindows({
  net,
  openTask: (id) => openTask(id),
  tabChanged: (tab) => history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { tab })}`),
  closed: () => {
    history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { task: null })}`);
    board.render();
    // Back to the card it was opened from, for the keyboard.
    if (lastOpened) boardEl.querySelector<HTMLElement>(`.kb-card[data-id="${lastOpened}"]`)?.focus();
  },
  edit: (task) => openCreate(api, { task }),
  moveMenu: (id) => board.moveMenu(id),
  onFloor,
  openWorker: (workerId, opts, onChanges) => showTerminal(workerId, opts, onChanges),
});

let lastOpened: number | null = null;
function openTask(id: number, tab?: string) {
  lastOpened = id;
  const same = taskWindows.id === id;
  taskWindows.open(id, isTaskTab(tab) ? tab : undefined);
  history.replaceState(null, '', `${location.pathname}${deepLink(location.search, { task: id, ...(same && !tab ? {} : { tab: taskWindows.tab }) })}`);
  board.render();
}

async function move(id: number, to: TaskStatus) {
  // To On hold and from On hold to In progress a small dialog comes first (holddialog.ts); cancelling it moves nothing.
  moveWithDialog(id, kstore.tasks.get(id), to, async (extras) => {
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.task.move', id, to, ...extras }));
    if (ok?.startError) toast(ok.startError, 'warn');
  });
}

function toggleArchive() {
  archiveOpen = !archiveOpen;
  kstore.includeArchived = archiveOpen;
  subscribe();
  renderBar();
  board.render();
}

/** A task worker's terminal. The narrow screen gets the keypad, as on the 2D view. */
function showTerminal(workerId: string, opts: TerminalOptions = {}, onChanges?: () => void) {
  return openTerminal(net, workerId, onChanges ?? (() => openChanges(net, workerId, () => showTerminal(workerId, opts))), undefined, { ...opts, keypad: window.matchMedia('(max-width: 700px)').matches });
}

/**
 * Runs `then` once the page is on `project`'s floor with `workerId` in sight: the office tells a page
 * only about the workers of the floor it's on, so another project's terminal takes a ride first.
 * `failed` runs when it can't (after the user has been told why).
 */
function onFloor(project: string, workerId: string, then: () => void, failed: () => void = () => {}) {
  if (store.floor === project && store.workers.has(workerId)) return then();
  if (store.floor === project) {
    toast('That worker isn’t here any more', 'warn');
    return failed();
  }
  const note = toast(`Going to ${kstore.projectOf(project)?.name ?? project}’s floor…`);
  let done = false;
  const check = () => {
    if (done || store.floor !== project) return;
    done = true;
    offFloor();
    offWorkers();
    clearTimeout(timer);
    note.remove();
    if (store.workers.has(workerId)) then();
    else {
      toast('That worker isn’t here any more', 'warn');
      failed();
    }
  };
  const offFloor = store.on('floor', check);
  const offWorkers = store.on('workers', check);
  const timer = setTimeout(() => {
    offFloor();
    offWorkers();
    if (done) return;
    toast('Couldn’t get to that floor', 'error');
    failed();
  }, 8000);
  net.send({ t: 'floor.go', floor: project });
}

// ---- The top bar ----------------------------------------------------------------------------------
const search = textInput('', { type: 'search', id: 'kb-search', placeholder: 'Search by #id, words, ticket or repo', 'aria-label': 'Search tasks' });
search.addEventListener('input', () => {
  filter.q = search.value;
  clearBtn.classList.toggle('hidden', !filterActive(filter));
  board.render();
});
const searchBox = h('label.kb-search', {}, icon('search'), search, h('kbd.kbd', { 'aria-hidden': 'true' }, '/'));
const statsEl = h('div.kb-stats', { role: 'status' });
let clearBtn = h('button.btn.hidden', { type: 'button' });
/** Each filter chip's repaint (its picked value and whether it counts as set), for a filter changed from code. */
let syncChips: (() => void)[] = [];

function renderBar() {
  const searching = document.activeElement === search;
  const projects = kstore.projects;
  const projectSel = select<string>([['', 'All projects'], ...projects.map((p) => [p.id, `${p.name}${p.open ? '' : ' (closed)'}`] as const)], kstore.project ?? '', { 'aria-label': 'Project', id: 'kb-project' });
  // A remembered project that's gone: all of them instead.
  if (kstore.loaded && kstore.project && !projects.some((p) => p.id === kstore.project)) projectSel.value = '';
  projectSel.addEventListener('change', () => pickProject(projectSel.value || null));

  // The filters are native selects under a chip's looks (ui/kit.ts selectChip). Their own listeners come
  // first, so the chip repaints from the filter as it is after the change.
  const repos = (kstore.project ? kstore.projectOf(kstore.project)?.repos : projects.flatMap((p) => p.repos.map((r) => ({ ...r, name: `${p.name} / ${r.name}` })))) ?? [];
  const uniqueRepos = [...new Map(repos.map((r) => [r.id, r])).values()];
  const repoSel = select<string>([['', 'All'], ...uniqueRepos.map((r) => [r.id, r.name] as const)], filter.repos[0] ?? '', { 'aria-label': 'Repository' });
  repoSel.addEventListener('change', () => setFilter({ repos: repoSel.value ? [repoSel.value] : [] }));
  const stateSel = select<StateFilter>(STATE_FILTERS.map((s) => [s, STATE_FILTER_NAMES[s]] as const), filter.state, { 'aria-label': 'State' });
  stateSel.addEventListener('change', () => setFilter({ state: stateSel.value as StateFilter }));
  const toolSel = select<string>([['', 'All'], ...KANBAN_TOOLS.map((x) => [x, toolName(x)] as const)], filter.tools[0] ?? '', { 'aria-label': 'Agent' });
  toolSel.addEventListener('change', () => setFilter({ tools: toolSel.value ? [toolSel.value as KanbanTool] : [] }));
  const ticketSel = select<TicketFilter>(TICKET_FILTERS.map((x) => [x, TICKET_FILTER_NAMES[x]] as const), filter.ticket, { 'aria-label': 'Ticket' });
  ticketSel.addEventListener('change', () => setFilter({ ticket: ticketSel.value as TicketFilter }));
  const chips = [
    selectChip(repoSel, { label: 'Repo', cls: uniqueRepos.length < 2 && !filter.repos.length ? 'hidden' : '', on: () => filter.repos.length > 0 }),
    selectChip(stateSel, { label: 'State', on: () => filter.state !== 'all' }),
    selectChip(toolSel, { label: 'Agent', on: () => filter.tools.length > 0 }),
    selectChip(ticketSel, { label: 'Ticket', on: () => filter.ticket !== 'any' }),
  ];
  syncChips = chips.map((c) => c.sync);
  clearBtn = btn('Clear', { kind: 'quiet', size: 'sm', icon: 'x', attrs: { class: filterActive(filter) ? '' : 'hidden', onclick: () => clearFilters() } });

  const to3d = h('a.btn.quiet.sm', { href: '/?3d=1', title: 'Back to the 3D office, on this project’s floor' }, icon('box'), '3D office');
  to3d.addEventListener('click', () => {
    // The 3D office opens on the floor this page is on (it reads the same remembered floor).
    if (kstore.project && store.floor !== kstore.project) net.send({ t: 'floor.go', floor: kstore.project });
  });

  bar.replaceChildren(
    h(
      'div.kb-bar-row',
      {},
      h('h1.kb-brand', {}, icon('square-kanban', { size: 18 }), h('span', {}, 'Kanban')),
      selectChip(projectSel, { icon: 'building-2', cls: 'md kb-project' }).el,
      searchBox,
      h(
        'div.kb-bar-right',
        {},
        statsEl,
        h(
          'div.kb-bar-actions',
          {},
          h('button.btn.secondary.md', { type: 'button', id: 'kb-issues', onclick: showIssues, title: "The project's issues from its issue sources: make tasks of them", 'aria-label': 'Issues' }, icon('circle-dot'), h('span.kb-lbl', {}, 'Issues')),
          h('button.btn.secondary.md', { type: 'button', id: 'kb-pulls', onclick: () => openPulls(net, kstore.project, boardActions), title: 'The pull requests of the project’s repositories', 'aria-label': 'Pull requests' }, icon('git-pull-request'), h('span.kb-lbl', {}, 'Pull requests')),
          btn('New task', { kind: 'primary', size: 'md', icon: 'plus', attrs: { id: 'kb-new', onclick: () => newTask(), title: 'New task (N)' } }),
        ),
      ),
    ),
    h(
      'div.kb-bar-row.kb-filters',
      { role: 'group', 'aria-label': 'Filters' },
      h('span.kb-filter-label', {}, icon('list-filter'), 'Filter'),
      ...chips.map((c) => c.el),
      clearBtn,
      h(
        'div.kb-filters-right',
        {},
        btn('Archive', { kind: 'quiet', size: 'sm', icon: 'archive', attrs: { 'aria-pressed': String(archiveOpen), onclick: toggleArchive, title: 'Show the archived tasks as a column' } }),
        to3d,
        iconButton('settings', 'Settings', { class: 'sm', onclick: () => showSettings() }),
      ),
    ),
  );
  paintStats();
  if (searching) search.focus();
}

/** The counts in the top bar, and the tab's title: redrawn on their own, so the search box keeps its focus. */
function paintStats() {
  const s = boardStats(kstore.tasks.values(), kstore.project);
  const n = (count: number, words: string, title: string, mark: Node | null = null) => h('span', { title }, mark, h('strong', {}, String(count)), ` ${words}`);
  statsEl.setAttribute('aria-label', 'Board counts');
  statsEl.replaceChildren(
    n(s.total, s.total === 1 ? 'task' : 'tasks', 'Tasks on the board'),
    n(s.running, 'running', 'Running now', s.running ? h('span.run-dot') : null),
    s.attention
      ? h('span.attn-pill', { title: 'Waiting on you' }, icon('hand', { size: 13 }), `${s.attention} ${s.attention === 1 ? 'needs' : 'need'} you`)
      : n(0, 'need you', 'Waiting on you'),
    n(s.review, 'to review', 'Ready for your review'),
  );
  const name = kstore.projectOf(kstore.project ?? undefined)?.name;
  document.title = `${s.attention ? `(${s.attention}) ` : ''}${name ? `${name} · ` : ''}Kanban · Agent Office`;
}

function setFilter(patch: Partial<BoardFilter>) {
  Object.assign(filter, patch);
  saveFilter();
  clearBtn.classList.toggle('hidden', !filterActive(filter));
  for (const sync of syncChips) sync();
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
  workerBar.refresh();
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
      workerBar.refresh();
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

/** The pull requests board (and the meeting room, hiring and prompts its buttons lead to), as the 2D view has them. */
const { boardActions, hireNew, openShell } = officeActions(net, (id) => {
  // "Go to its desk" is its terminal here: a task worker's in its task's window, as everywhere on this page.
  // Nothing is resumed on the way (for a waiting task that would be its Retry).
  const task = store.workers.get(id)?.kanban?.taskId;
  if (task) openTask(task, 'terminal');
  else showTerminal(id);
});

/** The bottom bar: the floor's plain workers as tabs (their terminals as the 2D view opens them), and a new worker or shell. */
const { openWorker: openPlainWorker, sendHome } = workerOpener(net, { keypad: () => window.matchMedia('(max-width: 700px)').matches });
const workerBar = installWorkerBar({ root: $('kb-workers'), openWorker: openPlainWorker, sendHome, hireNew, openShell, boardProject: () => kstore.project, projectName: (id) => kstore.projectOf(id)?.name, goToFloor: (id) => net.send({ t: 'floor.go', floor: id }) });

function showIssues() {
  const p = kstore.project ?? (kstore.projectOf(store.floor ?? undefined) ? store.floor : kstore.projects[0]?.id);
  if (!p) return toast('No projects yet: add a floor in the 3D office first.', 'warn');
  openIssues(api, p, (id) => openTask(id));
}

/** Your own settings, kept in this browser like the 3D office's: what the settings window changes. */
const settings = loadSettings();
let notifier: DesktopNotifier | undefined;

/** The office's Settings, the same window as in the 3D office, opened on Kanban (Projects is on this board's project). */
function showSettings() {
  // The 3D office in another tab may have changed them since this page loaded: saving here writes them all.
  Object.assign(settings, loadSettings());
  notifier ??= new DesktopNotifier(() => settings.notify, () => {});
  openSettings(
    net,
    settings,
    (s) => {
      Object.assign(settings, s);
      saveSettings(settings);
    },
    () => {
      // The character editor draws in 3D: loaded only when it's asked for.
      void import('../ui/character').then(({ openCharacter }) =>
        openCharacter(false, (p) => {
          store.profile = p;
          net.send({ t: 'profile', name: p.name, color: p.color, look: p.look });
        }),
      );
    },
    () => {},
    notifier,
    () => {
      void fetch('/api/logout', { method: 'POST' })
        .catch(() => {})
        .then(() => (location.href = '/login'));
    },
    undefined,
    'kanban',
  );
}

// ---- Messages -------------------------------------------------------------------------------------
let linkOpened = false;
api.on((msg: KanbanServerMsg) => {
  // The open task's view follows its own deltas (taskview.ts); the page keeps the board.
  const changed = kstore.apply(msg);
  if (msg.t === 'kanban.snapshot' && changed && !linkOpened) {
    linkOpened = true;
    if (link.task) openTask(link.task, link.tab);
    if (link.settings) showSettings();
  }
  if (changed) {
    // A card's change only moves the counts; the rest of the bar is redrawn when what it lists changes.
    if (msg.t === 'kanban.task' || msg.t === 'kanban.task.removed') paintStats();
    else renderBar();
    board.render();
  }
});

net.onStatus((up) => $('conn').classList.toggle('hidden', up));
net.onMessage((msg) => {
  store.apply(msg);
  routeTerminalMessage(msg);
  routeChangesMessage(msg);
  routePullMessage(msg);
  routeWorktreeMessage(msg);
  routeFloorAdded(msg);
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
        toast('The office is restarting on its new version. Back in a minute.');
      }
      break;
  }
});

// ---- Keys -----------------------------------------------------------------------------------------
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
window.addEventListener('keydown', (e) => {
  if (modalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (typing(e)) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    newTask();
  }
});

// Every retry countdown ticks by itself.
setInterval(() => tickCountdowns(document), 1000);

// ---- In -------------------------------------------------------------------------------------------
function askName(done: (name: string) => void) {
  const input = h('input', { type: 'text', maxlength: 24, placeholder: 'Your name', 'aria-label': 'Your name', autocomplete: 'nickname' }) as HTMLInputElement;
  const form = h('form.modal.lite-name', {}, h('header', {}, h('h2', {}, 'Who is it?')), h('div.body', {}, h('p', {}, 'Your teammates see this name on what you write and send.'), input), h('footer', {}, h('button.btn.primary', { type: 'submit' }, 'Come on in')));
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
