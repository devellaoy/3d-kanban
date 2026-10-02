// Files attached to a direct hire (a worker hired at a desk, not for a kanban task): which uploads they are.
import { ATTACHMENT_ID_RE, KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import type { KanbanRepository } from './db/repository.js';
import { attachmentPath } from './uploads.js';

/**
 * The files `who` uploaded beforehand (POST /api/kanban/upload with no task, so they belong to no task yet),
 * to be copied for the worker (DropStore.copyIn). `who` is the caller as the upload route records them: their
 * account name, or 'Guest' without accounts.
 * undefined: no files; a string: why the hire can't go ahead.
 */
export function hireFiles(repo: Pick<KanbanRepository, 'getAttachment'>, filesDir: string, ids: unknown, who: string): { path: string; name: string; type: string }[] | string | undefined {
  if (ids === undefined || (Array.isArray(ids) && !ids.length)) return undefined;
  if (!Array.isArray(ids) || ids.length > KANBAN_LIMITS.attachments || !ids.every((x) => typeof x === 'string' && ATTACHMENT_ID_RE.test(x))) return 'Bad attachments';
  const rows = [...new Set(ids as string[])].map((id) => repo.getAttachment(id));
  // Only loose uploads (a task's aren't the hire's to take), and only the caller's own. Comparing names is safe
  // today: with accounts a person's name in the office is locked to their account's (the presence handler's
  // profile only renames when there is no account) and the upload route records the account's name; without
  // accounts every upload and every caller is 'Guest'. An account renamed meanwhile loses its loose uploads
  // (they are one click to attach again).
  if (rows.some((a) => !a || a.taskId !== undefined || a.createdBy !== who)) return 'An attached file is gone: attach it again';
  return rows.map((a) => ({ path: attachmentPath(filesDir, a!), name: a!.name, type: a!.mime }));
}
