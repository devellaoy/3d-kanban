// "Write with AI" on a project's Debugging and testing and Pull-request review instructions, without the
// DOM (instructionsdraft.ts draws the button's status line and the review window, this decides): what is
// asked, which of the two fields is being written, whether an answer still has a place to go, what a
// failure says and what the review window says of the proposal.

import type { InstructionsDraftField } from '../../shared/kanban/instructionsdraft.js';
import type { KanbanRequest } from './api';

/** How long the browser waits: past the office's own limit for the agent (5 min), so the office's reason arrives. */
export const INSTRUCTIONS_ANSWER_MS = 310_000;

/** The fields as the settings name them. */
export const FIELD_NAMES: Record<InstructionsDraftField, string> = { testing: 'Debugging and testing', prReview: 'Pull-request review' };

export const ACTION_LABEL = 'Write with AI';
export const ACTION_TITLE =
  'Write with AI (Alt+Shift+Enter): Claude reads the project’s repositories. An empty field is written from them; a field with text is completed and put under headings. You check the text first, and nothing is saved until you press Save.';
export const RUNNING_TEXT = 'Writing the instructions from the repositories… this can take a few minutes';
export const BUSY_TEXT = 'The instructions are already being written: wait for them, or press Cancel first';

/** The request: the field and what it says now (saved or not, empty or not). */
export function draftRequest(project: string, field: InstructionsDraftField, text: string): KanbanRequest {
  return { t: 'kanban.instructions.draft', project, field, text };
}

/** What ends the browser's running draft at the office. */
export function cancelRequest(project: string): KanbanRequest {
  return { t: 'kanban.instructions.draft.cancel', project };
}

/**
 * Which of a project's two fields is being written. One at a time: a second start is refused while one
 * runs. An answer counts only for the run it was asked in, so one that comes after a cancel, after the
 * pane was drawn anew or after a newer run is dropped.
 */
export class DraftRuns {
  private seq = 0;
  private field: InstructionsDraftField | null = null;

  /** The field being written now, if any. */
  get running(): InstructionsDraftField | null {
    return this.field;
  }

  /** Starts a run for `field` and gives its number, or null while one is running. */
  start(field: InstructionsDraftField): number | null {
    if (this.field) return null;
    this.field = field;
    return ++this.seq;
  }

  /** An answer (or a failure) of run `n` came: whether it still counts. The run is over when it does. */
  settle(n: number): boolean {
    if (!this.field || n !== this.seq) return false;
    this.field = null;
    return true;
  }

  /** Voids the running draft (Cancel, the pane drawn anew, another project picked). Says whether there was one. */
  drop(): boolean {
    if (!this.field) return false;
    this.field = null;
    this.seq++;
    return true;
  }
}

/** What to say of a failed draft, or null for one that was cancelled or replaced by a newer request, which is no news. */
export function draftFailure(err: unknown): string | null {
  const why = (err instanceof Error ? err.message : String(err ?? '')).trim();
  return /^cancell?ed$/i.test(why) ? null : `Couldn’t write the instructions: ${why || 'no reason given'}`;
}

/** The review window's title. */
export function reviewTitle(field: InstructionsDraftField): string {
  return `${FIELD_NAMES[field]}: written by AI`;
}

/** What the review window can do with the text: put it in the field, or (the field is gone or locked) only hand it over to copy. */
export type ReviewMode = 'use' | 'copy';

export function reviewMode(field: { connected: boolean; locked: boolean }): ReviewMode {
  return field.connected && !field.locked ? 'use' : 'copy';
}

/** The line over the proposal: check it, nothing is saved yet, and what using it does to the field as it is now. */
export function reviewLead(field: InstructionsDraftField, mode: ReviewMode, current: string): string {
  const check = 'Check the text before you use it.';
  if (mode === 'copy') return `${check} The ${FIELD_NAMES[field]} field it was written for is no longer open, so it can’t be put there: copy it and paste it where it belongs.`;
  const saved = 'Nothing is saved until you press Save in the settings.';
  return current.trim() ? `${check} It replaces the text that is in ${FIELD_NAMES[field]} now. ${saved}` : `${check} ${saved}`;
}

/** The text as the field takes it: cut to the field's longest text (a negative `max` is no limit). */
export function clipToField(text: string, max: number): string {
  return max >= 0 && text.length > max ? text.slice(0, max) : text;
}

/**
 * Whether closing the review window also closes the Settings under it. In the 3D office a window closed with
 * its ✕ or Esc puts you straight back into mouse-look, which needs every window gone; the window's own buttons
 * (Use this text, Discard) go back to the settings, where the text is saved. The kanban page has no mouse-look.
 */
export function closesSettingsToo(how: { byButton: boolean; inOffice: boolean }): boolean {
  return how.inOffice && !how.byButton;
}

/**
 * The texts of a project's instruction boxes as they stood, unsaved, when the review window took the Settings
 * with it (closesSettingsToo). Kept in memory only, and given back once, to the boxes of the same project the
 * next time its settings are drawn: nothing is saved by this, the person still presses Save.
 */
export class KeptTexts {
  private kept = new Map<string, Record<string, string>>();

  keep(project: string, texts: Record<string, string>): void {
    this.kept.set(project, { ...texts });
  }

  /** The kept texts that differ from what the boxes hold now (`now`), by box; they are forgotten with this. */
  take(project: string, now: Record<string, string>): Record<string, string> {
    const was = this.kept.get(project);
    this.kept.delete(project);
    const back: Record<string, string> = {};
    for (const [name, text] of Object.entries(was ?? {})) if (name in now && now[name] !== text) back[name] = text;
    return back;
  }
}
