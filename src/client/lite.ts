// The 2D view (/lite): the office without the 3D, for a phone or a computer the 3D office is too
// much for. Every worker on the floor and how it's doing, the ones waiting on someone first; its
// terminal, with the keys a phone's keyboard hasn't got and a box to send it a prompt; and the boards
// and the task queue. You're in the office as someone on the 2D view (PeerInfo.lite), not standing
// anywhere in it.

import { Net } from './net';
import { initAppearance } from './themes';
import { AVATAR_COLORS, loadProfile, loadSettings, saveProfile, store } from './state';
import { randomLook } from '../shared/avatar';
import { ROOF } from '../shared/rooftop';
import { DESK_BY_ID, nextFreeSeat } from '../shared/layout';
import { officeFull } from '../shared/machine';
import { isAsleep } from '../shared/status';
import type { AgentEffort, AgentProvider, FloorInfo, WorkerInfo } from '../shared/protocol';
import { openSafe } from './ui/url';
import { $, closeAllModals, doingNow, h, onDoingChange, onModalChange, openModal, readingNow, toast } from './ui/dom';
import { openTerminal, openTerminalFor, routeTerminalMessage } from './ui/terminal';
import { openChanges, openChangesFor, routeChangesMessage } from './ui/changes';
import { lostWorktreeDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from './ui/prompt';
import { openBoard } from './ui/boards';
import type { BoardActions } from './ui/github/prompts';
import { openPull, routePullMessage } from './ui/pull';
// A worker's PR by its repository too, on a project with several.
import { findItem, ownPullRepo } from './ui/github/ghrepo';
// Task workers on the 2D view.
import { promptKind } from './kanban/office';
import { askWorker, hireOption, promptTaskWorker } from './kanban/office3d';
import { cardTask } from './kanban/issuecards'; // a card from the issue sources too
import { sendTaskWorkerHome } from './kanban/sendhome';
import { openQueue } from './ui/queue';
import { openAsk } from './ui/ask';
import { openMeeting, type MeetingPreset } from './ui/meeting';
import { openSignIns } from './ui/signins';
import { byUrgency, waitingInOrder, waitingLabel } from './nextup';
import { askNotifyPermission, DesktopNotifier, notifyPermission, shouldAlert, waitingOnSomeone } from './notify';
import { repoChoices } from './shared/hiring';
import { workerCard } from './shared/workercard';
// The tab title counts the workers waiting on someone, on every floor, as the 3D office's does.
import { renderTitle } from './shared/title';

initAppearance();

// Sent here because this browser can't draw the 3D office (see noWebGL in core/scene.ts).
if (new URLSearchParams(location.search).get('why') === 'webgl') {
  history.replaceState(null, '', location.pathname);
  toast("This browser can't draw the 3D office (WebGL is off or missing), so here's the 2D view", 'warn');
}

// Your name and color from the 3D office, if this browser has been in it. Nobody sees a character
// of yours from here, so a look is only made up to connect with.
const saved = loadProfile();
store.profile = { name: saved?.name ?? 'Guest', color: saved?.color ?? AVATAR_COLORS[1], look: saved?.look ?? randomLook() };
const net = new Net(() => store.profile, () => null, true);
const settings = loadSettings();
const notifier = new DesktopNotifier(() => settings.notify, (id) => openWorker(id));

/** The server version this page was loaded with. */
let bootVersion = '';

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
      offTheRoof();
      // After a reconnect the server has forgotten which terminal we had open, and what we're doing.
      sendDoing(true);
      const openId = openTerminalFor();
      if (openId && store.workers.has(openId)) net.send({ t: 'worker.attach', workerId: openId });
      const watching = openChangesFor();
      if (watching && store.workers.has(watching.workerId)) net.send({ t: 'changes.watch', ...watching });
      break;
    }
    case 'floor.enter':
      offTheRoof();
      break;
    case 'toast':
      toast(msg.text, msg.level);
      break;
    case 'signins.needed':
      openSignIns(net, msg.why);
      break;
    case 'upgrade':
      if (msg.state.phase === 'restarting') {
        net.expectRestart();
        toast('⬆️ The office is restarting on its new version. Back in a minute.');
      }
      break;
  }
});

/** Nothing to see up on the roof from here: down to the first floor instead (the 3D office left you up there, say). */
function offTheRoof() {
  if (store.floor !== ROOF) return;
  const to = store.floors.find((f) => !f.cloning);
  if (to) net.send({ t: 'floor.go', floor: to.id });
}

// ---- The floor you're on ------------------------------------------------------------------------
const floorSelect = $('floor') as HTMLSelectElement;
const floorLabel = (f: FloorInfo) => `${f.name}${f.cloning ? ' (cloning…)' : f.waiting ? ` · 🙋 ${f.waiting}` : ''}`;

function renderFloors() {
  const options = store.floors.map((f) => h('option', { value: f.id, disabled: !!f.cloning }, floorLabel(f)));
  if (!store.floors.length) options.push(h('option', { value: '' }, 'No floors yet'));
  floorSelect.replaceChildren(...options);
  floorSelect.value = store.floor ?? '';
  floorSelect.disabled = store.floors.length < 2;
  const p = store.project;
  const f = store.currentFloor();
  $('floor-meta').textContent = p ? [p.branch && `⎇ ${p.branch}`, f?.repo ?? p.dir, f && `👥 ${f.people} here`].filter(Boolean).join(' · ') : store.floors.length ? '' : 'Add a project from the elevator in the 3D office.';
  // Someone waiting on another floor: a way straight there.
  const elsewhere = store.floors.filter((o) => o.id !== store.floor && o.waiting > 0 && !o.cloning);
  const box = $('elsewhere');
  box.classList.toggle('hidden', !elsewhere.length);
  box.replaceChildren(
    ...elsewhere.map((o) =>
      h('button.btn.lite-go', { type: 'button', onclick: () => net.send({ t: 'floor.go', floor: o.id }) }, `🙋 ${o.waiting} waiting on ${o.name}`, h('span', { 'aria-hidden': 'true' }, '→')),
    ),
  );
  // The kanban link opens on this floor's project.
  ($('to-kanban') as HTMLAnchorElement).href = store.floor ? `/kanban?project=${encodeURIComponent(store.floor)}` : '/kanban';
  renderTitle();
}
floorSelect.addEventListener('change', () => {
  if (floorSelect.value && floorSelect.value !== store.floor) net.send({ t: 'floor.go', floor: floorSelect.value });
});
store.on('floors', renderFloors);
store.on('floor', renderFloors);
store.on('project', renderFloors);

// ---- Workers ------------------------------------------------------------------------------------
/** Whether each worker waited on someone when last seen, to tell when one starts. */
const lastWaiting = new Map<string, boolean>();

function renderWorkers() {
  const list = byUrgency(store.workers.values());
  const ul = $('workers');
  ul.replaceChildren(...list.map((w) => workerCard(w, { onOpen: openWorker, onPrompt: promptWorker })));
  if (!list.length) ul.append(h('li.lite-empty', {}, store.project ? 'Nobody is working on this floor. ✨ New task hires someone.' : 'No workers here.'));
  $('waiting-now').textContent = waitingLabel(waitingInOrder(list));
  renderTitle();
}

/** A worker needs input or is done: a notification while you're elsewhere, and a buzz. */
function noticeWorkers() {
  for (const w of store.workers.values()) {
    const now = waitingOnSomeone(w);
    const before = lastWaiting.get(w.id);
    lastWaiting.set(w.id, now);
    if (!now || !shouldAlert(before, now)) continue;
    notifier.alert(w);
    if (w.status === 'needs_input') navigator.vibrate?.(200);
  }
  notifier.sync(store.workers);
}

store.on('workers', () => {
  noticeWorkers();
  renderWorkers();
});
store.on('project', renderWorkers);
// "3m ago" moves on by itself.
setInterval(renderWorkers, 30_000);

/** Its terminal, with the keypad, waking it up first if it's asleep. */
function openWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.lost) return fixLostWorktree(w);
  if (isAsleep(w.status)) {
    if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved session — starting a fresh one`, 'warn');
    net.send({ t: 'worker.resume', workerId: id });
  }
  openTerminal(net, id, () => openChanges(net, id, () => openWorker(id)), undefined, { keypad: true });
}

/** Its worktree was deleted outside agent-office: put it back (everyone's who lost theirs), or send it home. */
function fixLostWorktree(w: WorkerInfo) {
  if (!w.lost || !w.worktree) return;
  const worktree = w.worktree;
  const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
  lostWorktreeDialog({
    name: w.name,
    worktree,
    lost: w.lost,
    workspace: w.repos?.length ? worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
    others: others.map((o) => o.name),
    openTerminal: isAsleep(w.status) ? undefined : () => openTerminal(net, w.id, () => openChanges(net, w.id, () => openWorker(w.id)), undefined, { keypad: true }),
    rebuild: (all) => {
      toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
      net.send({ t: 'worker.rebuild', workerId: w.id, all });
    },
    // A task worker's dialog has its task in it.
    sendHome: () =>
      sendTaskWorkerHome(net, w, DESK_BY_ID.get(w.deskId)?.label ?? 'its desk') ||
      sendHomeDialog({
        workerId: w.id,
        name: w.name,
        where: DESK_BY_ID.get(w.deskId)?.label ?? 'its desk',
        worktree,
        repos: w.repos?.length ? [worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
        ask: () => net.send({ t: 'worker.worktree', workerId: w.id }),
        onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: w.id, cleanup }),
      }),
  });
}

function promptWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  // A message on its task (or its terminal, for a reviewer).
  if (promptTaskWorker(net, w, () => openWorker(id))) return;
  openPrompt({
    title: `✍️ Prompt ${w.name}`,
    subtitle: w.status === 'working' ? `${w.name} is busy, so this waits in its input box until it's done.` : undefined,
    placeholder: 'What should it do next?',
    submitLabel: 'Send',
    onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: id, prompt: text }),
  });
}

// ---- New work: a prompt for a worker who's here, or a new one at a free desk -------------------
function hire(deskId: string, prompt: string, worktree: boolean, provider?: AgentProvider, model?: string, effort?: AgentEffort, repos?: string[], extra: { attachmentIds?: string[]; meeting?: string } = {}) {
  net.send({ t: 'worker.spawn', deskId, prompt, worktree, provider, model, effort, repos: repos?.length ? repos : undefined, ...(extra.attachmentIds?.length ? { attachmentIds: extra.attachmentIds } : {}), ...(extra.meeting ? { meeting: extra.meeting } : {}) });
}

/** The next free seat for a new worker, the back office's included as far as the floor's built out (see WING). */
const freeSeat = () => nextFreeSeat((id) => !!store.workerAtDesk(id), store.floorPlan.wing, store.plan().removed)?.id;

function sendToWorker(title: string, text: { context?: string; initial?: string } = {}) {
  if (!store.project) return toast('Pick a floor first', 'warn');
  const desk = freeSeat();
  // Not a task's reviewer, which takes nothing but its terminal.
  const awake = [...store.workers.values()].filter((w) => w.kind === 'agent' && !isAsleep(w.status) && promptKind(w) !== 'terminal');
  if (!desk && !awake.length) return toast('Every desk and bean bag is taken — send a worker home first, or put a bean bag down in build mode (U)', 'warn');
  openAsk({
    title,
    ...text,
    newDesk: desk ? DESK_BY_ID.get(desk)!.label : undefined,
    workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status, task: w.kanban?.taskId })),
    kanbanOption: desk ? hireOption(net, () => desk, DESK_BY_ID.get(desk)!.label) : undefined,
    worktreeOption: !!store.project.branch,
    providerOption: true,
    repoOptions: repoChoices(),
    onSubmit: (prompt, to, worktree, provider, model, effort, repos) => {
      if (to) askWorker(net, to, prompt); // a message on its task for a task worker
      else if (desk) hire(desk, prompt, worktree, provider, model, effort, repos);
    },
  });
}

// ---- The boards, the queue and the meeting room -------------------------------------------------
function boardActions(): BoardActions {
  return {
    queue: (prompt, title, issue, provider, model, effort) => net.send({ t: 'queue.add', prompt, title, issue, provider, model, effort }),
    assign: (prompt, title) => sendToWorker(`🤖 ${title}`, { initial: prompt }),
    ask: (context, title) => sendToWorker(`✍️ ${title}`, { context }),
    // There's no desk to walk to from here: its terminal instead.
    goToDesk: (deskId) => {
      const w = store.workerAtDesk(deskId);
      if (!w) return;
      closeAllModals();
      openWorker(w.id);
    },
    meeting: (preset) => showMeeting(preset),
    // The issue as a kanban task, at the next free desk (or wherever the engine finds one).
    kanbanTask: (it) => {
      const desk = freeSeat();
      cardTask(net, it, desk, desk ? DESK_BY_ID.get(desk)!.label : 'the next free desk');
    },
  };
}

function showMeeting(preset?: MeetingPreset) {
  openMeeting(
    net,
    {
      openTerminal: openWorker,
      openPr: (id) => {
        const w = store.workers.get(id);
        if (!w) return;
        // In the floor's own repository, not another of the project's with the same number.
        const it = w.pr && findItem(store.pulls.items, w.pr.number, ownPullRepo(w.pr, store.currentFloor()?.repo));
        if (it) openPull(it, net, boardActions());
        else if (w.pr) openSafe(w.pr.url);
        else net.send({ t: 'worker.pr', workerId: id });
      },
      handoff: {
        freeDesk: () => {
          const id = freeSeat();
          return id ? { id, label: DESK_BY_ID.get(id)!.label } : undefined;
        },
        officeIsFull: () => {
          if (!officeFull(store.machine)) return false;
          toast(`🚫 The office is at its limit of ${store.machine.limit} workers — send one home before hiring another`, 'warn');
          return true;
        },
        hire: (deskId, prompt, o) => hire(deskId, prompt, o.worktree, o.provider, o.model, o.effort, o.repos, o),
      },
    },
    preset,
  );
}

$('btn-issues').addEventListener('click', () => openBoard('issues', net, boardActions()));
$('btn-pulls').addEventListener('click', () => openBoard('pulls', net, boardActions()));
$('btn-queue').addEventListener('click', () => openQueue(net, { openTerminal: openWorker }));
$('btn-new').addEventListener('click', () => sendToWorker('✨ New task'));

function renderNav() {
  const count = (id: string, n: number) => ($(id).querySelector('.n')!.textContent = n ? String(n) : '');
  count('btn-issues', store.issues.items.filter((i) => i.state === 'OPEN').length);
  count('btn-pulls', store.pulls.items.filter((p) => p.state === 'OPEN').length);
  count('btn-queue', store.queue.tasks.filter((t) => t.status !== 'done').length);
}
store.on('issues', renderNav);
store.on('pulls', renderNav);
store.on('queue', renderNav);

// ---- What you have open, for the others (see PeerInfo.doing) -----------------------------------
let doingSent: string | undefined;
let readingSent = false;
function sendDoing(reconnected = false) {
  if (reconnected) {
    doingSent = undefined;
    readingSent = false;
  }
  const what = doingNow();
  const reading = readingNow();
  if (what === doingSent && reading === readingSent) return;
  doingSent = what;
  readingSent = reading;
  net.send({ t: 'doing', what, reading });
}
onModalChange(() => sendDoing());
onDoingChange(() => sendDoing());

// ---- Notifications ------------------------------------------------------------------------------
// The browser only asks from a tap, so there's a button for it while it hasn't been asked.
const bell = h('button.btn', { type: 'button', title: 'Get a notification when a worker needs input or is done', 'aria-label': 'Turn on notifications' }, '🔔');
bell.addEventListener('click', async () => {
  await askNotifyPermission();
  bell.remove();
});
if (notifyPermission() === 'default' && settings.notify) $('to-3d').before(bell);

// ---- In ----------------------------------------------------------------------------------------
/** Your name, the first time this browser comes in on the shared password. */
function askName(done: (name: string) => void) {
  const input = h('input', { type: 'text', maxlength: 24, placeholder: 'Your name', 'aria-label': 'Your name', autocomplete: 'nickname' }) as HTMLInputElement;
  const form = h(
    'form.modal.lite-name',
    {},
    h('header', {}, h('h2', {}, '👋 Who is it?')),
    h('div.body', {}, h('p', {}, 'Your teammates see this name on what you type and send.'), input),
    h('footer', {}, h('button.btn.primary', { type: 'submit' }, 'Come on in')),
  );
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

void (async () => {
  try {
    const res = await fetch('/api/whoami', { cache: 'no-store' });
    if (res.status === 401) return void (location.href = '/login?next=/lite');
    const { me } = (await res.json()) as { me?: typeof store.me };
    if (me) store.me = me;
  } catch {
    // the welcome message says it too
  }
  // With an account of your own, your name is that account's.
  if (store.me.account) store.profile.name = store.me.account.name;
  if (saved || store.me.account) return net.connect();
  askName((name) => {
    store.profile.name = name;
    // No look: the 3D office still has you pick a character the first time you go in.
    saveProfile({ name, color: store.profile.color });
    net.connect();
  });
})();

renderFloors();
renderWorkers();
renderNav();

// Debug handle for quick checks from the console / headless screenshots.
(window as any).__lite = { store, net };
