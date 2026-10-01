/**
 * What you do with workers: hire one at a desk (with a task, or a shell), prompt it, wake it, send it
 * home, fix a worktree deleted outside the office, open its pull requests; ask a board agent; stand
 * at a desk; and what the hint bar says at a desk or a board agent's kiosk. Also what the boards'
 * buttons do with a worker.
 */
import { STATION_AGENT, deskSeat, type DeskDef } from '../../../shared/layout';
import { canLabel } from '../../../shared/floorplan';
import { officeFull, pressureNote } from '../../../shared/machine';
import type { AgentEffort, AgentProvider, GhIssue, WorkerInfo } from '../../../shared/protocol';
import { isAsleep, isBusy } from '../../../shared/status';
import type { Ctx, Hint } from '../../core/context';
import type { CoreState } from '../../core/ctx';
import { seatBuilt } from '../../core/floors';
import { aside, key } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { STATION_INFO } from '../../core/stations';
import { askNotifyPermission, notifyPermission } from '../../notify';
import { repoChoices } from '../../shared/hiring';
import { store } from '../../state';
import { openAsk } from '../../ui/ask';
import { STATUS_LABEL, clip, closeAllModals, h, toast } from '../../ui/dom';
import { openDeskLabel } from '../../ui/floorplan';
import type { MeetingPreset } from '../../ui/meeting';
import { confirmDialog, lostWorktreeDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from '../../ui/prompt';
import { providerLabel, resolvedProvider } from '../../ui/provider';
import { openPull } from '../../ui/pull';
import { openRepoPulls, workerRepos } from '../../ui/repos';
import { openTerminal } from '../../ui/terminal';
import { hiringPaused, usageLabel, usageTitle } from '../../ui/usage';
// 3d-kanban: a worker's PR by its repository too, task workers in the office, and issue cards from the issue sources.
import { findItem, ownPullRepo } from '../../kanban/ghrepo';
import { canRetry, kanbanCard, kanbanOf, promptKind, waitText, workerLabel } from '../../kanban/office';
import { askWorker, cardToTaskWorker, hireOption, promptTaskWorker, retryTask } from '../../kanban/office3d';
import { cardTask } from '../../kanban/issuecards';
import { sendTaskWorkerHome } from '../../kanban/sendhome';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    desk: true;
    station: true;
  }
}

export type WorkerActionsParts = Pick<Parts, 'worlds' | 'seating' | 'walking' | 'waiting' | 'meeting' | 'cards'>;

/** Registers the worktree answer (worker.worktree), and defines what's done at a desk and at a board agent. */
export function installWorkerActions(ctx: Ctx, core: CoreState, parts: WorkerActionsParts) {
  const { player, net, me, settings } = ctx;
  const { plan, inOffice } = parts.worlds;
  const openWorkerTerminal = (id: string) => parts.waiting.openWorkerTerminal(id);
  const openWorkerChanges = (id: string, repo?: string) => parts.waiting.openWorkerChanges(id, repo);

  function freeDesk(): string | null {
    // Prefer the empty desk nearest to you; when they're all taken, the bean bag that's out.
    let best: string | null = null;
    let bestD = Infinity;
    for (const d of plan().desks) {
      if (!seatBuilt(d.id)) continue;
      if (store.workerAtDesk(d.id)) continue;
      const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
      if (dist < bestD) {
        bestD = dist;
        best = d.id;
      }
    }
    return best ?? firstFreeSeat() ?? null;
  }

  /** The first seat nobody's at, in the map's order: the desks (as far as the floor's built out), then the overflow seats. */
  function firstFreeSeat(): string | undefined {
    return [...plan().desks, ...plan().overflow].find((d) => seatBuilt(d.id) && !store.workerAtDesk(d.id))?.id;
  }

  let askedToNotify = false;

  /** The office is at its worker limit: says so, and says yes (the office would refuse the hire anyway). */
  function officeIsFull(): boolean {
    const m = store.machine;
    if (!officeFull(m)) return false;
    toast(`🚫 The office is at its limit of ${m.limit} worker${m.limit === 1 ? '' : 's'} — send one home before hiring another`, 'warn');
    return true;
  }

  function hire(deskId: string, prompt?: string, worktree = false, provider?: AgentProvider, model?: string, effort?: AgentEffort, issue?: number | { issue?: number; issueKey?: string }, repos?: string[], via?: 'herald') {
    // 3d-kanban: `issue` can be a card's fields (kanban/issuecards cardFields): the floor's own issue's number and an issue source's key.
    const ids = typeof issue === 'object' ? issue : { issue };
    net.send({ t: 'worker.spawn', deskId, prompt, worktree, provider, model, effort, issue: ids.issue, repos: repos?.length ? repos : undefined, via, ...(ids.issueKey ? { issueKey: ids.issueKey } : {}) });
    // The moment notifications start to matter: ask once (it has to come from a key press or click).
    if (settings.notify && notifyPermission() === 'default' && !askedToNotify) {
      askedToNotify = true;
      void askNotifyPermission();
    }
  }

  function openShell(deskId: string) {
    if (officeIsFull()) return;
    net.send({ t: 'worker.spawn', deskId, kind: 'shell' });
  }

  function promptAtDesk(deskId: string) {
    const w = store.workerAtDesk(deskId);
    const desk = plan().byId.get(deskId)!;
    if (!w) {
      if (officeIsFull()) return;
      openPrompt({
        title: `✨ Hire at ${desk.label}`, // 3d-kanban: "task" is a kanban task now
        subtitle: 'A fresh worker will sit down and start on this right away.',
        warning: pressureNote(store.machine),
        submitLabel: 'Hire & start',
        providerOption: true,
        worktreeOption: !!store.project?.branch,
        repoOptions: repoChoices(),
        kanbanOption: hireOption(net, () => deskId, desk.label), // 3d-kanban
        onSubmit: (text, o) => hire(deskId, text, o.worktree, o.provider, o.model, o.effort, undefined, o.repos),
      });
    } else if (w.lost) {
      fixLostWorktree(w);
    } else if (isAsleep(w.status)) {
      toast(`${w.name} is asleep — press R to resume first`, 'warn');
    } else if (promptTaskWorker(net, w, () => openWorkerTerminal(w.id))) {
      // 3d-kanban: a message on its task (or its terminal, for a reviewer).
    } else if (w.kind === 'shell') {
      openPrompt({
        title: `🐚 Run in ${w.name}`,
        placeholder: 'npm run dev',
        submitLabel: 'Run ▶',
        onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text }),
      });
    } else {
      openPrompt({
        title: `💬 Prompt ${w.name}`,
        subtitle: w.status === 'working' ? `${w.name} is busy — your message will be queued in their input box.` : undefined,
        onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: w.id, prompt: text }),
      });
    }
  }

  /** Direct hire from an empty desk, with an optional first prompt and provider choice. */
  function hireAtDesk(deskId: string) {
    const desk = plan().byId.get(deskId)!;
    if (officeIsFull()) return;
    openPrompt({
      title: `✨ Hire a worker at ${desk.label}`,
      subtitle: 'You can start with an empty prompt and send work later.',
      warning: pressureNote(store.machine),
      placeholder: 'Optional first task…',
      submitLabel: 'Hire & start',
      allowEmpty: true,
      providerOption: true,
      worktreeOption: !!store.project?.branch,
      repoOptions: repoChoices(),
      kanbanOption: hireOption(net, () => deskId, desk.label), // 3d-kanban
      onSubmit: (text, o) => hire(deskId, text || undefined, o.worktree, o.provider, o.model, o.effort, undefined, o.repos),
    });
  }

  ctx.messages.on('worker.worktree', routeWorktreeMessage);
  function killWorker(id: string) {
    const w = store.workers.get(id);
    if (!w) return;
    const where = plan().byId.get(w.deskId)?.label ?? 'the desk';
    const session = w.kind === 'shell' ? 'shared shell' : `${providerLabel(w.provider, store.project)} session`;
    // 3d-kanban: a task worker's dialog has its task in it (Move to Done), and says so to the engine.
    if (sendTaskWorkerHome(net, w, where)) return;
    if (w.meeting) {
      // The meeting's worktree is the whole table's: it's tidied away once they've all gone.
      const m = store.meeting.current;
      const on = m?.id === w.meeting && m.status === 'running';
      confirmDialog(`Send ${w.name} home?`, on ? `${w.name} is in the meeting on “${m.title}”, which stops without it.` : `${w.name} leaves the meeting room.`, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
      return;
    }
    if (w.worktree) {
      // A worker with its own worktree: choose what becomes of the worktree and its branch.
      sendHomeDialog({
        workerId: id,
        name: w.name,
        where,
        worktree: w.worktree,
        repos: w.repos?.length ? [w.worktree.path.split('/').pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
        ask: () => net.send({ t: 'worker.worktree', workerId: id }),
        onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: id, cleanup }),
      });
      return;
    }
    const body = plan().byId.get(w.deskId)?.station
      ? `This stops its ${session} for everyone, and it forgets what it was asked. The next prompt at the ${where} starts a fresh one.`
      : `This stops the ${session} at ${where} for everyone and frees the desk.`;
    confirmDialog(`Send ${w.name} home?`, body, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
  }

  /** E at a board agent: type it a request. It's hired with it when nobody is there yet. */
  function askStation(deskId: string) {
    const kind = plan().byId.get(deskId)?.station;
    if (!kind) return;
    const w = store.workerAtDesk(deskId);
    const name = STATION_AGENT[kind].name;
    const info = STATION_INFO[kind];
    // A prompt typed into a question it's asking would answer it.
    if (w?.status === 'needs_input') {
      toast(`The ${name} is waiting on an answer — here's its terminal`, 'warn');
      return openWorkerTerminal(w.id);
    }
    // Nobody there yet: asking hires the agent.
    if (!w && officeIsFull()) return;
    const subtitle = !w
      ? `${info.does}, in a terminal of my own: press O at the kiosk to watch.`
      : isAsleep(w.status)
        ? `The ${name} is asleep: this wakes it up, and it carries on where it left off.`
        : isBusy(w.status)
          ? `The ${name} is busy. Your prompt waits in its input box until it's done.`
          : undefined;
    openPrompt({
      title: `${info.icon} Ask the ${name}`,
      subtitle,
      placeholder: `e.g. ${info.example}`,
      submitLabel: 'Send ✨',
      warning: w ? undefined : pressureNote(store.machine),
      onSubmit: (text) => net.send({ t: 'station.prompt', deskId, prompt: text }),
    });
  }

  function resumeWorker(w: WorkerInfo) {
    if (w.lost) return fixLostWorktree(w);
    if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved Claude session — starting a fresh one`, 'warn');
    net.send({ t: 'worker.resume', workerId: w.id });
  }

  /**
   * Anything done with a worker whose worktree was deleted outside agent-office (see WorkerInfo.lost):
   * it can't work there, so this says so and offers to put the folder back, everyone's at once when
   * more are lost, or to send it home.
   */
  function fixLostWorktree(w: WorkerInfo) {
    if (!w.lost || !w.worktree) return;
    const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
    lostWorktreeDialog({
      name: w.name,
      worktree: w.worktree,
      lost: w.lost,
      workspace: w.repos?.length ? w.worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
      others: others.map((o) => o.name),
      openTerminal: isAsleep(w.status) ? undefined : () => openTerminal(net, w.id, () => openWorkerChanges(w.id)),
      rebuild: (all) => {
        toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
        net.send({ t: 'worker.rebuild', workerId: w.id, all });
      },
      sendHome: () => killWorker(w.id),
    });
  }

  /** Whether a worker's branch can become a PR: it has its own worktree, still there, and isn't mid-turn. */
  function prReady(w: WorkerInfo) {
    return !!w.worktree && !w.lost && !isBusy(w.status);
  }

  /** O at a desk: see the worker's pull request, or push its branch and open one. */
  function pullRequestFor(w: WorkerInfo) {
    if (w.repos?.length) return pullRequestsFor(w);
    if (w.pr) {
      // 3d-kanban: in the floor's own repository, not another of the project's with the same number.
      const it = findItem(store.pulls.items, w.pr.number, ownPullRepo(w.pr, store.currentFloor()?.repo));
      if (it) openPull(it, net, boardActions());
      else window.open(w.pr.url, '_blank', 'noopener');
      return;
    }
    if (!w.worktree) return toast(`${w.name} works in the main checkout — only workers with their own worktree can open a PR`, 'warn');
    if (w.lost) return fixLostWorktree(w);
    if (w.prOpening) return;
    if (!prReady(w)) return toast(`${w.name} is still ${STATUS_LABEL[w.status]} — wait until it's done`, 'warn');
    // 3d-kanban: the office has an agent do it now (the worker itself, or the task's pr phase).
    toast(`🤖 An agent is opening the pull request: ${w.name} pushes ${w.worktree.branch} and writes it up…`);
    net.send({ t: 'worker.pr', workerId: w.id });
  }

  /**
   * O at the desk of a worker across repositories: with no pull request yet, the office opens one in
   * each repository it committed to (and lists them all in each one). Once it has one, O shows each
   * repository's, with a button for the ones still missing.
   */
  function pullRequestsFor(w: WorkerInfo) {
    const open = () => {
      const now = store.workers.get(w.id);
      if (!now || now.prOpening) return;
      if (now.lost) return fixLostWorktree(now);
      if (!prReady(now)) return toast(`${now.name} is still ${STATUS_LABEL[now.status]} — wait until it's done`, 'warn');
      // 3d-kanban: an agent opens them now.
      toast(`🤖 An agent is opening the pull requests: ${now.name} pushes ${now.worktree?.branch ?? 'its branch'} in each of its repositories and writes them up…`);
      net.send({ t: 'worker.pr', workerId: now.id });
    };
    if (!workerRepos(w).some((r) => r.pr)) return open();
    openRepoPulls(w.id, {
      openPull: (number, url) => {
        // 3d-kanban: in the floor's own repository, not another of the project's with the same number.
        const it = findItem(store.pulls.items, number, ownPullRepo({ url }, store.currentFloor()?.repo));
        if (it) openPull(it, net, boardActions());
        else window.open(url, '_blank', 'noopener');
      },
      openMissing: open,
      changes: (repo) => openWorkerChanges(w.id, repo),
    });
  }

  /** Puts you in front of a desk, looking at it: the PR board's "Go to desk". */
  function goToDesk(deskId: string) {
    const desk = plan().byId.get(deskId);
    if (!desk) return;
    closeAllModals();
    standAt(desk);
    const w = store.workerAtDesk(deskId);
    toast(w ? `You're at ${desk.label}, ${w.name}'s desk` : `You're at ${desk.label}`);
  }

  /** Behind the worker, looking over their shoulder at the laptop (or in front of a board agent's kiosk). */
  function standAt(desk: DeskDef) {
    const { seating } = parts;
    if (player.seat) seating.standUp();
    // The car first (the activities' own order has it last).
    ctx.activities.stop('driver', 'desk');
    ctx.activities.stopAll('desk');
    parts.walking.stopWalkingTo();
    // In line for the throne: in front of it, where it stands.
    const w = store.workerAtDesk(desk.id);
    const court = parts.worlds.court();
    const inLine = w && court ? court.spotOf(w.id) : -1;
    if (inLine >= 0) {
      // At the front: up on the throne, if it's free, where E is for them.
      const throne = inLine === 0 && plan().throne ? seating.freePlace(plan().throne!) : null;
      if (throne) {
        player.pos.set(throne.x, throne.y, throne.z);
        player.sit(throne);
        me.sit(throne.hips);
        net.send({ t: 'sit', seat: throne.key });
        player.camYaw = throne.rotY - Math.PI;
        player.lookPitch = -0.2;
        return;
      }
      // Else beside it in line, turned to it.
      const at = plan().lineup[inLine];
      const x = at.x + Math.cos(at.rotY) * 1.3;
      const z = at.z - Math.sin(at.rotY) * 1.3;
      player.pos.set(x, parts.worlds.groundHere(x, z, 1.5), z);
      player.vy = 0;
      player.facing = Math.atan2(at.x - x, at.z - z);
      player.camYaw = player.facing - Math.PI;
      player.lookPitch = -0.2;
      return;
    }
    let spot = deskSeat(desk, desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4);
    // On a map of its own, the office's distances can land in a pillar: the nearest open floor to it.
    const world = ctx.world();
    if (!inOffice() && (!player.fits(spot.x, spot.z, 0) || !world.nav.walkable(spot.x, spot.z))) {
      const [x, z] = world.nav.nearestWalkable([spot.x, spot.z]);
      spot = { x, z };
    }
    player.pos.set(spot.x, 0, spot.z);
    player.vy = 0;
    player.facing = Math.atan2(desk.x - spot.x, desk.z - spot.z);
    player.camYaw = player.facing - Math.PI;
    player.lookPitch = -0.2;
  }

  function deskHint(deskId: string): Hint {
    const w = store.workerAtDesk(deskId);
    if (!w && plan().byId.get(deskId)?.room) return { k: 'room', parts: [h('span.title', {}, `🤝 ${plan().byId.get(deskId)!.label} · free`), key('E', 'Call a meeting')] };
    // The sign over it, if it has one, and L to hang one (or change it).
    const sign = store.floorPlan.labels[deskId]?.text;
    const labelKey = canLabel(deskId) ? key('L', sign ? 'Sign' : 'Label') : '';
    const deskName = `${sign ? `🪧 ${sign} · ` : ''}${plan().byId.get(deskId)!.label}`;
    if (!w) {
      const paused = hiringPaused();
      const m = store.machine;
      const full = officeFull(m);
      return {
        k: `${paused}|${full}|${m.workers}|${m.limit}|${!!m.pressure}|${sign}`,
        parts: [
          h('span.title', {}, `${deskName} · empty`),
          ...(full
            ? [h('span.cost', {}, `🚫 Office full · ${m.workers} of ${m.limit} workers`)]
            : [
                m.pressure ? h('span.cost', { title: `This machine is under pressure: ${m.pressure}` }, '⚠️ Machine under pressure') : '',
                ...(paused ? [h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow')] : [key('E', 'Hire a worker'), key('P', 'Hire with a task')]),
                key('B', 'Shell'),
              ]),
          labelKey,
        ],
      };
    }
    if (w.lost && w.worktree) {
      return {
        k: `lost|${w.id}|${w.lost.branch}|${sign}`,
        parts: [
          h('span.title', {}, `${sign ? `🪧 ${sign} · ` : ''}${w.name} · 🌿 worktree deleted`),
          aside('deleted outside agent-office'),
          key('E', 'Fix it'),
          key('X', 'Send home'),
          labelKey,
        ],
      };
    }
    const doing = w.activity ? clip(w.activity, 48) : '';
    const workerProvider = w.kind === 'agent' ? resolvedProvider(w.provider, store.project) : undefined;
    const spent = w.kind === 'agent' && w.usage ? usageLabel(w.usage, workerProvider) : '';
    const shell = w.kind === 'shell';
    // 3d-kanban: a task worker's task, and R to retry it while it waits.
    const card = kanbanCard(w, Date.now());
    const task = card ? `${card.name} · ${card.summary}` : '';
    const retry = !isAsleep(w.status) && canRetry(w);
    return {
      k: w.status + w.id + (w.pr?.number ?? '') + (w.repos?.map((r) => r.pr?.number ?? '-').join() ?? '') + (w.prOpening ? '!' : '') + doing + spent + (sign ?? '') + task,
      parts: [
        h('span.title', {}, `${sign ? `🪧 ${sign} · ` : ''}${workerLabel(w)} · ${STATUS_LABEL[w.status]}`), // 3d-kanban: workerLabel
        task ? aside(clip(task, 90)) : '', // 3d-kanban
        retry ? key('R', 'Retry task') : '', // 3d-kanban
        doing ? aside(doing) : '',
        spent ? h('span.cost', { title: usageTitle(w.usage!, workerProvider) }, spent) : '',
        key('E', 'Open terminal'),
        key('C', 'Changes'),
        isAsleep(w.status) ? key('R', shell ? 'Restart' : 'Resume') : key('P', shell ? 'Run command' : 'Prompt'),
        // 3d-kanban: an agent opens it.
        w.repos?.length ? reposKey(w) : w.pr ? key('O', `PR #${w.pr.number}`) : w.prOpening ? aside('⏳ Agent opening PR…') : prReady(w) ? key('O', 'Agent opens PR') : '',
        key('X', 'Send home'),
        labelKey,
      ],
    };
  }

  /** The O in the desk hint of a worker across repositories: its pull requests so far, or opening them. */
  function reposKey(w: WorkerInfo) {
    const repos = workerRepos(w);
    const prs = repos.filter((r) => r.pr).length;
    // 3d-kanban: an agent opens them.
    if (w.prOpening) return aside('⏳ Agent opening PRs…');
    if (prs) return key('O', `${prs} of ${repos.length} PRs`);
    return prReady(w) ? key('O', `Agent opens PRs (${repos.length} repos)`) : '';
  }

  function stationHint(deskId: string): Hint {
    const kind = plan().byId.get(deskId)?.station;
    if (!kind) return { k: '', parts: [] };
    const w = store.workerAtDesk(deskId);
    const info = STATION_INFO[kind];
    if (!w) {
      const m = store.machine;
      const full = officeFull(m);
      return {
        k: `${full}|${m.workers}|${m.limit}`,
        parts: [
          h('span.title', {}, `${info.icon} ${STATION_AGENT[kind].name}`),
          aside(info.offer.replace(/^Ask me /, '')),
          full ? h('span.cost', {}, `🚫 Office full · ${m.workers} of ${m.limit} workers`) : key('E', 'Prompt'),
        ],
      };
    }
    const doing = w.activity ? clip(w.activity, 48) : '';
    const provider = resolvedProvider(w.provider, store.project);
    const spent = w.usage ? usageLabel(w.usage, provider) : '';
    return {
      k: w.status + w.id + doing + spent,
      parts: [
        h('span.title', {}, `${info.icon} ${w.name} · ${STATUS_LABEL[w.status]}`),
        doing ? aside(doing) : '',
        spent ? h('span.cost', { title: usageTitle(w.usage!, provider) }, spent) : '',
        key('E', isAsleep(w.status) ? 'Wake with a prompt' : 'Prompt'),
        key('O', 'Terminal'),
        key('X', 'Send home'),
      ],
    };
  }

  ctx.interactions.define('desk', {
    reach: 4.5,
    hint: (it) => (it.deskId ? deskHint(it.deskId) : { k: '', parts: [] }),
    use: (it, key) => {
      if (!it.deskId) return;
      if (key === 'L') return openDeskLabel(net, it.deskId);
      const w = store.workerAtDesk(it.deskId);
      // Nobody is hired at the meeting table: a meeting seats its own workers there.
      if (!w && plan().byId.get(it.deskId)?.room) return key === 'E' ? parts.meeting.showMeeting() : undefined;
      if (key === 'B' && !w) return openShell(it.deskId);
      // 3d-kanban: P with an issue card at an empty desk makes it a kanban task there.
      if (key === 'P' && ctx.carrying() && !w) return parts.cards.cardTaskAt(it.deskId, ctx.carrying()!);
      if (key === 'P') return promptAtDesk(it.deskId);
      if (key === 'E') return w ? openWorkerTerminal(w.id) : hireAtDesk(it.deskId);
      if (key === 'C' && w) return openWorkerChanges(w.id);
      if (key === 'R' && w && isAsleep(w.status)) return resumeWorker(w);
      if (key === 'R' && w && retryTask(net, w)) return; // 3d-kanban: its task waits: retry it
      if (key === 'X' && w) return killWorker(w.id);
      if (key === 'O' && w) return pullRequestFor(w);
    },
  });
  ctx.interactions.define('station', {
    reach: 4.5,
    hint: (it) => (it.deskId ? stationHint(it.deskId) : { k: '', parts: [] }),
    use: (it, key) => {
      if (!it.deskId) return;
      const w = store.workerAtDesk(it.deskId);
      if (key === 'E' || key === 'P') return askStation(it.deskId);
      if (key === 'O' && w) return openWorkerTerminal(w.id);
      if (key === 'X' && w) return killWorker(w.id);
    },
  });

  /** A prompt from the boards goes to a new worker at a free desk, or to one already at a desk. */
  function sendToWorker(title: string, text: { context?: string; initial?: string }) {
    const desk = freeDesk();
    const awake = [...store.workers.values()].filter((w) => w.kind === 'agent' && !isAsleep(w.status) && promptKind(w) !== 'terminal'); // 3d-kanban: not a task's reviewer, which takes nothing but its terminal
    if (!desk && !awake.length) {
      toast('Every desk and bean bag is taken — send a worker home first', 'warn');
      return;
    }
    openAsk({
      title,
      ...text,
      newDesk: desk ? plan().byId.get(desk)!.label : undefined,
      workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status, task: w.kanban?.taskId })), // 3d-kanban: task
      worktreeOption: !!store.project?.branch,
      providerOption: true,
      repoOptions: repoChoices(),
      kanbanOption: desk ? hireOption(net, () => desk, plan().byId.get(desk)!.label) : undefined, // 3d-kanban
      onSubmit: (prompt, to, worktree, provider, model, effort, repos) => {
        if (to) askWorker(net, to, prompt); // 3d-kanban: a message on its task for a task worker
        else if (desk) hire(desk, prompt, worktree, provider, model, effort, undefined, repos);
      },
    });
  }

  /** What the boards' buttons do: hand an issue to a worker, queue it, call a meeting about it, go to a desk, take its card. */
  function boardActions() {
    return {
      queue: (prompt: string, title: string, issue: number, provider?: AgentProvider, model?: string, effort?: AgentEffort) => net.send({ t: 'queue.add', prompt, title, issue, provider, model, effort }),
      assign: (prompt: string, title: string) => sendToWorker(`🤖 ${title}`, { initial: prompt }),
      ask: (context: string, title: string) => sendToWorker(`✍️ ${title}`, { context }),
      meeting: (preset: MeetingPreset) => parts.meeting.showMeeting(preset),
      goToDesk,
      pickUp: parts.cards.pickUp,
      // 3d-kanban: the issue as a kanban task, at the desk nearest you (or wherever the engine finds one).
      kanbanTask: (it: GhIssue) => {
        const desk = freeDesk() ?? undefined;
        cardTask(net, it, desk, desk ? plan().byId.get(desk)!.label : 'the next free desk');
      },
    };
  }

  return { officeIsFull, firstFreeSeat, hire, hireAtDesk, resumeWorker, fixLostWorktree, pullRequestFor, standAt, boardActions, goToDesk };
}
