// The 2D view's and the kanban page's way to put a worker on something: a new one at a free desk, a
// prompt for one that's here, the meeting room, and the BoardActions the 📌 Issues and 🔀 Pull Requests
// boards call. Both pages are in the office without standing anywhere in it, so "go to its desk" is its
// terminal instead (`openWorker`).

import { DESK_BY_ID, nextFreeSeat } from '../../shared/layout';
import { officeFull, pressureNote } from '../../shared/machine';
import { isAsleep } from '../../shared/status';
import type { AgentEffort, AgentProvider } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { openSafe } from '../ui/url';
import { closeAllModals, toast } from '../ui/dom';
import type { BoardActions } from '../ui/github/prompts';
import { openPull } from '../ui/pull';
import { findItem, ownPullRepo } from '../ui/github/ghrepo';
import { promptKind } from '../kanban/office';
import { askWorker, hireOption } from '../kanban/office3d';
import { cardTask } from '../kanban/issuecards'; // a card from the issue sources too
import { openAsk } from '../ui/ask';
import { openPrompt } from '../ui/prompt';
import { openMeeting, type MeetingPreset } from '../ui/meeting';
import { repoChoices } from './hiring';

const NO_SEAT = 'Every desk and bean bag is taken — send a worker home first, or put a bean bag down in build mode (U)';

export function officeActions(net: Net, openWorker: (id: string) => void) {
  function hire(deskId: string, prompt: string | undefined, worktree: boolean, provider?: AgentProvider, model?: string, effort?: AgentEffort, repos?: string[], extra: { attachmentIds?: string[]; meeting?: string } = {}) {
    net.send({ t: 'worker.spawn', deskId, prompt, worktree, provider, model, effort, repos: repos?.length ? repos : undefined, ...(extra.attachmentIds?.length ? { attachmentIds: extra.attachmentIds } : {}), ...(extra.meeting ? { meeting: extra.meeting } : {}) });
  }

  /** The next free seat for a new worker, the back office's included as far as the floor's built out (see WING). */
  const freeSeat = () => nextFreeSeat((id) => !!store.workerAtDesk(id), store.floorPlan.wing, store.plan().removed)?.id;

  /** The office is at its worker limit: says so, and says yes (the office would refuse the hire anyway). */
  function officeIsFull(): boolean {
    const m = store.machine;
    if (!officeFull(m)) return false;
    toast(`🚫 The office is at its limit of ${m.limit} worker${m.limit === 1 ? '' : 's'} — send one home before hiring another`, 'warn');
    return true;
  }

  /** The desk for a new worker from the kanban page's bar, or why there is none (said in a toast). */
  function deskForNew(): string | undefined {
    if (!store.project) return void toast('Pick a floor first', 'warn');
    if (officeIsFull()) return;
    const desk = freeSeat();
    if (!desk) toast(NO_SEAT, 'warn');
    return desk;
  }

  /** The 3D office's plain hire dialog, without the kanban's option and attachments. */
  function hireNew(floorName?: string) {
    const desk = deskForNew();
    if (!desk || !store.project) return;
    openPrompt({
      title: `✨ Hire a worker at ${DESK_BY_ID.get(desk)!.label}${floorName ? ` · ${floorName}` : ''}`,
      subtitle: 'You can start with an empty prompt and send work later.',
      warning: pressureNote(store.machine),
      placeholder: 'Optional first task…',
      submitLabel: 'Hire & start',
      allowEmpty: true,
      providerOption: true,
      worktreeOption: !!store.project.branch,
      repoOptions: repoChoices(),
      // Asked before the dialog closes, so with no seat left it stays open with what was written.
      canHire: () => (seatNow() ? undefined : NO_SEAT),
      onSubmit: (text, o) => {
        const seat = seatNow();
        if (seat) hire(seat, text || undefined, o.worktree, o.provider, o.model, o.effort, o.repos);
      },
    });
    // A kanban task may have taken that desk while the dialog was open (the engine picks seats the same way): the next free one then.
    function seatNow() {
      return store.workerAtDesk(desk!) ? freeSeat() : desk;
    }
  }

  /** A shell at the next free desk; the desk's id, or undefined when nothing was sent. */
  function openShell(): string | undefined {
    const deskId = deskForNew();
    if (deskId) net.send({ t: 'worker.spawn', deskId, kind: 'shell' });
    return deskId;
  }

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
          officeIsFull,
          hire: (deskId, prompt, o) => hire(deskId, prompt, o.worktree, o.provider, o.model, o.effort, o.repos, o),
        },
      },
      preset,
    );
  }

  return { boardActions, sendToWorker, showMeeting, freeSeat, hire, officeIsFull, hireNew, openShell };
}
