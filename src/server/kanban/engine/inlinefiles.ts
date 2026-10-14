// Pictures and files people put into a text at the cursor are Markdown links to the office's own
// attachment route: `![name](/api/kanban/attachments/<id>)` and `[name](…)`. An agent can't fetch
// those, so the prompt text gets the path of the file's copy in the task's grant folder instead.

import type { KanbanRepository } from '../db/repository.js';
import { grantFiles } from '../uploads.js';

// The URL may be absolute (the link was pasted with the office's address); only the path counts.
const LINK_RE = /(!?)\[([^\]\n]*)\]\((?:https?:\/\/[^\s)/]+)?\/api\/kanban\/attachments\/([a-f0-9]{16,64})\)/g;

/** The ids of the attachments a text links, in order of first appearance. */
export function linkedAttachmentIds(text: string): string[] {
  return [...new Set([...text.matchAll(LINK_RE)].map((m) => m[3]))];
}

/** The files from `files` that `text` does not link (the ones a prompt still has to list). */
export function unlinkedFiles<T extends { id: string }>(text: string, files: T[]): T[] {
  const linked = new Set(linkedAttachmentIds(text));
  return files.filter((f) => !linked.has(f.id));
}

/** `text` with each link to one of the task's attachments (or to one of `accepted`: uploads the message being composed is about to link to the task) pointing at its file in the task's grant folder (copied there first). Other ids, or files gone from disk, stay as they are. */
export function inlineFiles(ctx: { repo: Pick<KanbanRepository, 'getAttachment'>; filesDir: string }, taskId: number, text: string, accepted: { id: string }[] = []): string {
  if (!text.includes('/api/kanban/attachments/')) return text;
  return text.replace(LINK_RE, (whole, bang: string, name: string, id: string) => {
    const row = ctx.repo.getAttachment(id);
    // Only the task's own files: another task's id must not open its folder to this one.
    if (!row || (row.taskId !== taskId && !accepted.some((a) => a.id === id))) return whole;
    const [file] = grantFiles(ctx.filesDir, taskId, [row]);
    return file ? `${bang}[${name}](${file})` : whole;
  });
}
