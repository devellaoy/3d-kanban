// "Write with AI" for a project's Debugging and testing / Pull-request review instructions: the browser
// sends the field's current text, the office's Claude reads the project's repositories read-only and answers
// with a proposal (server/kanban/integrations/instructions-draft). protocol.ts joins these into the kanban's unions.

import { KANBAN_LIMITS, bad, oneOf, project, text, type Obj, type Req } from './validate.js';

export const INSTRUCTIONS_DRAFT_FIELDS = ['testing', 'prReview'] as const;
/** Which instruction field: `testing` = testingInstructions, `prReview` = prReviewInstructions. */
export type InstructionsDraftField = (typeof INSTRUCTIONS_DRAFT_FIELDS)[number];

export type InstructionsDraftClientMsg =
  /** Admins: writes or improves the field; `text` is its current (maybe unsaved, maybe empty) content. Answered with kanban.instructionsDraft or an error. */
  | Req<{ t: 'kanban.instructions.draft'; project: string; field: InstructionsDraftField; text: string }>
  /** Admins: ends the browser's running draft of the project; answered with kanban.ok. */
  | Req<{ t: 'kanban.instructions.draft.cancel'; project: string }>;

export type InstructionsDraftServerMsg =
  /** The proposal. */
  { t: 'kanban.instructionsDraft'; rid?: string; text: string };

export const INSTRUCTIONS_DRAFT_CLIENT_TYPE_LIST: Readonly<Record<InstructionsDraftClientMsg['t'], true>> = {
  'kanban.instructions.draft': true,
  'kanban.instructions.draft.cancel': true,
};

type Bare<T> = T extends unknown ? Omit<T, 'rid'> : never;

export function parseInstructionsDraftMsg(t: InstructionsDraftClientMsg['t'], r: Obj): Bare<InstructionsDraftClientMsg> {
  const proj = project(r.project);
  if (t === 'kanban.instructions.draft.cancel') return { t, project: proj };
  if (t !== 'kanban.instructions.draft') return bad(`Unknown kanban message ${t}`);
  return { t, project: proj, field: oneOf(r.field, 'field', INSTRUCTIONS_DRAFT_FIELDS), text: text(r.text, 'The text', KANBAN_LIMITS.promptText, { empty: true }) };
}
