/**
 * Carrying an issue card: off the issues board (or its window's ✋) into your hands, and E with it at
 * an empty desk, a worker, the queue, the meeting room or the herald hands it over; Q puts it back.
 * Which card you hold is the office's (ctx.carrying), since so much else looks at it.
 */
import type { CarriedIssue, GhIssue, WorkerInfo } from '../../../shared/protocol';
import { isAsleep } from '../../../shared/status';
import type { Ctx, Hint } from '../../core/context';
import { aside, key } from '../../core/hint';
import type { HireOptions } from '../workers/actions';
import { store } from '../../state';
import { closeAllModals, h, toast } from '../../ui/dom';
import { type MeetingPreset } from '../../ui/meeting';
import { worktreePref } from '../../ui/prompt';
import { officeChoice } from '../../ui/provider';
import { hiringPaused } from '../../ui/usage';
import type { Interactable } from '../../world/types';
// Cards from the project's issue sources, by their key, and a card as a kanban task.
import { cardId } from '../../../shared/kanban/issuecard.js';
import { cardFields, cardMeeting, cardOnQueue, cardPrompt, cardTask, issueCardLabel, takeCard } from '../../kanban/issuecards';
import { cardToTaskWorker } from '../../kanban/office3d';

export interface CarryingDeps {
  /** Puts `card` in your hands, or none: what ctx.carrying says from then on. */
  hold(card: CarriedIssue | null): void;
  /** The issues board, which leaves off the cards someone's carrying around (see features/boards). */
  boards: { cardMoved(): void };
  /** The note on the issues board you're pointing at, if any (see aimedNote in input/pointer.ts). */
  aimedNote(): GhIssue | null;
  /** Plays the reach on your hands and your character, and shows it to everyone else. */
  reach(): void;
  /** Drops the ball, if it's in your hands (see features/basketball). */
  dropBall(): void;
  /** Hires a worker at `deskId` (see hire in features/workers/actions.ts). */
  hire(deskId: string, prompt?: string, options?: HireOptions): void;
  /** The seat the herald sends a new worker to (see heraldSeat in features/workers/views.ts). */
  heraldSeat(): string | undefined;
  /** Seats you've just sent a worker out to from the herald, so a second goes elsewhere. */
  heraldHires: Map<string, { floor: string | null; at: number }>;
  /** The office is at its worker limit: says so, and says yes. */
  officeIsFull(): boolean;
  /** The meeting room's window, prefilled with `preset`. */
  showMeeting(preset?: MeetingPreset): void;
}

export function installCarrying(ctx: Ctx, deps: CarryingDeps) {
  function setCarrying(card: CarriedIssue | null) {
    if ((card ? cardId(card) : '') === (ctx.carrying() ? cardId(ctx.carrying()!) : '')) return;
    deps.hold(card);
    ctx.me.carry(card);
    ctx.hands.carry(card);
    ctx.net.send({ t: 'carry', issue: card?.issue, title: card?.title, ...(card?.key ? { issueKey: card.key } : {}) });
    deps.boards.cardMoved();
    ctx.hint.invalidate();
  }

  /** ✋ in an issue's window, or E at its note on the board: its card comes off the board and into your hands. */
  function pickUp(it: GhIssue) {
    closeAllModals();
    deps.dropBall();
    const carrying = ctx.carrying();
    // A card from the project's issue sources by its key.
    if (carrying && cardId(carrying) === cardId(it)) return;
    if (carrying) toast(`📌 ${issueCardLabel(carrying)} went back on the board`);
    setCarrying(takeCard(it));
    ctx.sound.paper();
    toast(`✋ You took ${issueCardLabel(it)} off the board: take it to an empty desk, a worker or the 📋 queue and press E`);
  }

  /** Q, or E at the issues board: the card goes back where it came from. */
  function putBack() {
    const carrying = ctx.carrying();
    if (!carrying) return;
    toast(`📌 ${issueCardLabel(carrying)} is back on the board`);
    setCarrying(null);
    ctx.sound.paper();
  }
  ctx.keys.bind({
    code: 'KeyQ',
    when: () => !!ctx.carrying(),
    run: () => {
      deps.reach();
      putBack();
    },
  });

  /**
   * E with a card in your hands: an empty desk hires a worker for the issue (with the prompt 🤖 Hand
   * to a worker uses), an agent at a desk gets it as its next prompt, the queue board queues it, and
   * the issues board takes it back (or swaps it for the `note` you point at there). False when it's none
   * of those, so E does what it always does there.
   */
  function dropCard(it: Interactable, card: CarriedIssue, note: GhIssue | null): boolean {
    if (it.kind === 'issues') {
      if (note) pickUp(note);
      else putBack();
      return true;
    }
    // A card from the project's issue sources goes by its key, with its own prompt.
    const prompt = cardPrompt(card);
    const name = issueCardLabel(card);
    const ids = cardFields(card);
    if (it.kind === 'queue') {
      if (cardOnQueue(card)) toast(`${name} is already on the queue`, 'warn');
      else {
        const { provider, model, effort } = officeChoice(store.project);
        ctx.net.send({ t: 'queue.add', prompt, title: `${name} ${card.title}`, ...ids, provider, model, effort });
        putDown();
      }
      return true;
    }
    // At the meeting room: a meeting about it, and the card goes back up on the board.
    if (it.kind === 'meeting' || (it.kind === 'desk' && it.deskId && ctx.plan().byId.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
      putBack();
      deps.showMeeting(cardMeeting(card));
      return true;
    }
    // To the herald: someone's sent out for it, to the first free seat.
    if (it.kind === 'herald') {
      const deskId = deps.heraldSeat();
      if (!deskId) toast('Every seat at the tables is taken', 'warn');
      else if (hiringPaused()) toast('💸 Budget spent — hiring resumes tomorrow', 'warn');
      else if (!deps.officeIsFull()) {
        const { provider, model, effort } = officeChoice(store.project);
        deps.heraldHires.set(deskId, { floor: store.floor, at: performance.now() });
        deps.hire(deskId, prompt, { worktree: !!store.project?.branch && worktreePref(), provider, model, effort, issue: ids, via: 'herald' });
        putDown();
      }
      return true;
    }
    if (it.kind !== 'desk' || !it.deskId) return false;
    const w = store.workerAtDesk(it.deskId);
    const why = w ? cantTakeCard(w) : hiringPaused() ? '💸 Budget spent — hiring resumes tomorrow' : '';
    if (why) toast(why, 'warn');
    else if (w && cardToTaskWorker(ctx.net, w, card, prompt, putDown)) {
      // Only the task's own issue goes to a task worker, as a message on the task.
    } else if (w) {
      ctx.net.send({ t: 'worker.prompt', workerId: w.id, prompt, ...ids });
      putDown();
    } else if (!deps.officeIsFull()) {
      const { provider, model, effort } = officeChoice(store.project);
      deps.hire(it.deskId, prompt, { worktree: !!store.project?.branch && worktreePref(), provider, model, effort, issue: ids });
      putDown();
    }
    return true;
  }

  /** The card left your hands for a desk or the queue (the office says who took it). */
  function putDown() {
    setCarrying(null);
    ctx.sound.paper();
  }

  /** P with a card at an empty desk: the issue as a kanban task, starting there. */
  function cardTaskAt(deskId: string, card: CarriedIssue) {
    if (hiringPaused()) return toast('💸 Budget spent — hiring resumes tomorrow', 'warn');
    if (deps.officeIsFull()) return;
    cardTask(ctx.net, card, deskId, ctx.plan().byId.get(deskId)!.label);
    putBack();
  }

  /** Why the worker at a desk can't be handed an issue card right now, or '' when it can. */
  function cantTakeCard(w: WorkerInfo): string {
    if (w.kind === 'shell') return `${w.name} is a shell, not an agent`;
    if (w.lost) return `${w.name}'s worktree was deleted — press E at its desk to fix it`;
    if (isAsleep(w.status)) return `${w.name} is asleep — press R to resume first`;
    if (w.status === 'needs_input') return `${w.name} is waiting on an answer — open the terminal first`;
    return '';
  }

  /** With an issue card in your hands: what E does with it here, and how to put it back. */
  function carryHint(card: CarriedIssue, it: Interactable | null): Hint {
    const parts = (...mid: (HTMLElement | string)[]) => [h('span.title', {}, `🗂️ ${issueCardLabel(card)} in hand`), ...mid, key('Q', 'Put it back')];
    const aimedNote = deps.aimedNote();
    if (it?.kind === 'issues') return aimedNote ? { k: cardId(aimedNote), parts: parts(key('E', `Swap it for ${issueCardLabel(aimedNote)}`)) } : { k: '', parts: parts(key('E', 'Pin it back up')) };
    if (it?.kind === 'ball') return { k: 'ball', parts: parts(aside('🏀 hands full')) };
    if (it?.kind === 'queue') {
      const on = cardOnQueue(card); // by its key too
      return { k: String(on), parts: parts(on ? aside('already on the queue') : key('E', 'Put it on the queue')) };
    }
    if (it?.kind === 'herald') {
      const paused = hiringPaused();
      return { k: `herald|${paused}`, parts: parts(paused ? h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow') : key('E', 'Send someone out for it')) };
    }
    if (it?.kind === 'meeting' || (it?.kind === 'desk' && it.deskId && ctx.plan().byId.get(it.deskId)?.room && !store.workerAtDesk(it.deskId))) {
      return { k: 'meeting', parts: parts(key('E', 'Call a meeting about it')) };
    }
    if (it?.kind === 'desk' && it.deskId) {
      const w = store.workerAtDesk(it.deskId);
      if (!w) {
        const paused = hiringPaused();
        return { k: String(paused), parts: parts(paused ? h('span.cost', {}, '💸 Budget spent — hiring resumes tomorrow') : key('E', 'Hire a worker for it'), paused ? '' : key('P', '🗂️ Kanban task')) };
      }
      const why = cantTakeCard(w);
      return { k: w.id + w.status + why, parts: parts(why ? aside(why) : key('E', `Hand it to ${w.name}`)) };
    }
    // Anything else works as usual, card in hand.
    if (it) {
      const rest = ctx.interactions.hint(it);
      return { k: rest.k, parts: parts(...rest.parts) };
    }
    return { k: '', parts: parts(aside('take it to an empty desk, a worker or the 📋 queue')) };
  }

  return { setCarrying, pickUp, dropCard, carryHint, cardTaskAt };
}
