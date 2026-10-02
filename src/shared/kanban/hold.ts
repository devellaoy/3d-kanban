// A task on hold (docs/kanban-architecture.md): put aside from Waiting or Review until something it
// depends on is there. Its workers go home (worktree and session kept on the task), the desk frees
// up, and the 3D office shows it as a figure in the lounge (see lounge.ts) until it is resumed.

import type { TaskStatus } from './types.js';
import { bad, text, type Obj } from './validate.js';

/** Why and since when a task is on hold; kept on the task while it is, cleared when it is resumed. */
export interface TaskHold {
  /** When it was put on hold (ms). */
  at: number;
  /** Who put it on hold (a person's name, or the part of the office that did). */
  by: string;
  /** The column it came from. */
  from: 'waiting' | 'review';
  /** The reason, as the person gave it. */
  note?: string;
  /** "Hold until" (ms; the start of that local day is fine): what the task waits for is due then. */
  until?: number;
  /** The implementer's look, so the lounge figure and the worker hired on resume keep its name and colour. */
  worker?: { name: string; color: string };
  /** The desk it sat at, to hire its worker there again when it is free. */
  deskId?: string;
}

// The hold lives here and not in types.ts, which is at its size ceiling (tests/size.test.ts): a module
// augmentation in a file of the program applies to every file that uses these types, the way
// client/kanban/watch3d.ts adds a field to Worker.
declare module './types.js' {
  interface KanbanTask {
    hold?: TaskHold;
  }
  interface KanbanTaskCard {
    hold?: TaskHold;
  }
  /** What an agent reading the task (office-tasks, the references) is told of its hold. */
  interface TaskRefBundle {
    hold?: { at: number; note?: string; until?: number };
  }
}

/** The longest reason a hold (or a message sent along with a resume) may give. */
export const HOLD_NOTE_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far ahead "hold until" may reach: about two years. */
export const HOLD_UNTIL_MAX_MS = 2 * 365 * DAY_MS;

/** A usable "hold until": a whole number of ms, no more than a day in the past (today's date counts) and no more than two years ahead. */
export function validHoldUntil(until: unknown, now: number): until is number {
  return typeof until === 'number' && Number.isInteger(until) && until > now - DAY_MS && until <= now + HOLD_UNTIL_MAX_MS;
}

/**
 * The `note` and `until` of a kanban.task.move (the validator's one-line call). A note comes with a
 * move to on_hold (the reason) or to in_progress (a message for the agent when it is resumed); a date
 * only with a move to on_hold. Returns only what was given.
 */
export function moveExtras(r: Obj, to: TaskStatus, now = Date.now()): { note?: string; until?: number } {
  const out: { note?: string; until?: number } = {};
  if (r.note !== undefined) {
    if (to !== 'on_hold' && to !== 'in_progress') bad('A note goes only with a move to On hold or In progress');
    const note = text(r.note, 'The note', HOLD_NOTE_MAX, { empty: true }).trim();
    if (note) out.note = note;
  }
  if (r.until !== undefined) {
    if (to !== 'on_hold') bad('A date goes only with a move to On hold');
    if (!validHoldUntil(r.until, now)) bad("The date isn't one a task can be held until");
    out.until = r.until as number;
  }
  return out;
}

/** "15.11." as a person writes the day in Finland, in the viewer's own time zone. */
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

/** What a hold says in a line: "⏸️ waiting for the API keys · until 15.11." ("(passed)" once the day is gone). */
export function holdLine(hold: TaskHold, now: number): string {
  const parts: string[] = [];
  const note = hold.note?.trim();
  parts.push(note ? `⏸️ ${note}` : '⏸️ on hold');
  if (hold.until !== undefined) parts.push(`until ${day(hold.until)}${hold.until < now ? ' (passed)' : ''}`);
  return parts.join(' · ');
}
