// The DOM-free part of changing a task's issue from its Issue tab (issuelink.ts): the patch a pick, a
// key typed by hand or an unlink sends with kanban.task.update, and when the tab offers it at all.

import { KANBAN_LIMITS } from '../../shared/kanban/protocol.js';

/** The two fields of a kanban.task.update patch that say which issue a task is about (`null` clears). */
export interface TicketPatch {
  ticket: string | null;
  ticketUrl: string | null;
}

/** What the task has now. */
type Linked = { ticket?: string; ticketUrl?: string };

/** The office takes only an http(s) link without spaces (`url` in shared/kanban/taskinput.ts). */
const LINK_RE = /^https?:\/\/\S+$/;

/** A task's issue can be changed at any status but the archive (the office refuses it there). */
export const canChangeIssue = (task: { status: string }) => task.status !== 'archived';

/** An issue picked from the project's list: its key and its own link. */
export function pickedPatch(issue: { key: string; url?: string }): TicketPatch {
  const url = issue.url?.trim() ?? '';
  return { ticket: issue.key, ticketUrl: LINK_RE.test(url) ? url : null };
}

/** No issue any more: the key and its link both go. */
export const unlinkPatch = (): TicketPatch => ({ ticket: null, ticketUrl: null });

/**
 * A key typed by hand with its optional link, or the reason it can't be saved. An empty link clears
 * the one the task has, and so does the old issue's link left in place under a new key: the link of
 * the issue before never stays on another one.
 */
export function typedPatch(key: string, link: string, now: Linked = {}): TicketPatch | string {
  const ticket = key.trim();
  let url = link.trim();
  if (!ticket) return 'Type the issue’s key (✕ Unlink takes the issue off the task)';
  if (ticket.length > KANBAN_LIMITS.ticket) return `The key is too long (${KANBAN_LIMITS.ticket} characters at most)`;
  if (url && ticket !== (now.ticket ?? '') && url === (now.ticketUrl ?? '')) url = '';
  if (url && !LINK_RE.test(url)) return 'The link must be an http(s) URL';
  if (url.length > KANBAN_LIMITS.url) return `The link is too long (${KANBAN_LIMITS.url} characters at most)`;
  return { ticket, ticketUrl: url || null };
}

/** Whether the patch would leave the task as it is (nothing to send). */
export const sameIssue = (now: Linked, patch: TicketPatch) => (now.ticket ?? null) === patch.ticket && (now.ticketUrl ?? null) === patch.ticketUrl;

/** What the toast says once the office has taken the patch. */
export const savedText = (patch: TicketPatch) => (patch.ticket ? `Issue ${patch.ticket} linked` : 'Issue unlinked');
