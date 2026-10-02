// Files attached to tasks and comments: uploaded one per request to the office (server/kanban/uploads.ts:
// POST /api/kanban/upload?name=<name>[&task=<id>], the raw bytes as the body → {attachment}), then
// named by id in kanban.task.create / kanban.comment.add. The helpers up top are pure (tested);
// the upload itself needs fetch.

import type { KanbanAttachment } from '../../shared/kanban/types.js';
import { apiUrl } from '../multiplayer/visit';

/** The most a single upload may be (the office's UPLOAD_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Where the office serves an attachment back. */
export function attachmentUrl(id: string): string {
  return apiUrl(`/api/kanban/attachments/${encodeURIComponent(id)}`);
}

/** Pictures the office shows inline (not SVG, which could carry script). */
export function isImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
}

/** "812 B", "14 kB", "3.2 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Markdown for an attachment in a description: a picture shows, anything else is a link. */
export function attachmentMarkdown(a: Pick<KanbanAttachment, 'id' | 'name' | 'mime'>): string {
  const name = a.name.replace(/[[\]\\]/g, '');
  return `${isImage(a.mime) ? '!' : ''}[${name}](${attachmentUrl(a.id)})`;
}

/** A name for a pasted picture, which has none of its own: "pasted-2026-09-30-1412.png". */
export function pastedName(mime: string, now = new Date()): string {
  const ext = /png/.test(mime) ? 'png' : /jpe?g/.test(mime) ? 'jpg' : /gif/.test(mime) ? 'gif' : /webp/.test(mime) ? 'webp' : 'bin';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `pasted-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

/** Inserts `snippet` into `text` at the cursor, on a line of its own. Returns the new text and where the cursor goes. */
export function insertAt(text: string, at: number, snippet: string): { text: string; cursor: number } {
  const i = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, i);
  const after = text.slice(i);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const trail = after && !after.startsWith('\n') ? '\n' : '';
  const out = `${before}${lead}${snippet}${trail}${after}`;
  return { text: out, cursor: before.length + lead.length + snippet.length };
}

/** The #123 references in a line of text, split out so they can be linked to their tasks (not inside words or URLs). */
export function splitTaskRefs(text: string): (string | { task: number; text: string })[] {
  const out: (string | { task: number; text: string })[] = [];
  const re = /(^|[^\w/&#`])#(\d{1,9})\b/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1].length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ task: Number(m[2]), text: `#${m[2]}` });
    at = start + m[2].length + 1;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Sends one file to the office. Rejects with the office's reason. */
export async function uploadAttachment(file: Blob, name: string, taskId?: number): Promise<KanbanAttachment> {
  if (file.size > UPLOAD_MAX_BYTES) throw new Error(`${name}: ${formatSize(file.size)} > ${formatSize(UPLOAD_MAX_BYTES)}`);
  const q = new URLSearchParams({ name });
  if (taskId) q.set('task', String(taskId));
  const res = await fetch(`/api/kanban/upload?${q}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const r = (await res.json().catch(() => ({}))) as { attachment?: KanbanAttachment; error?: string };
  if (!res.ok || !r.attachment) throw new Error(r.error ?? `${name}: HTTP ${res.status}`);
  return r.attachment;
}
