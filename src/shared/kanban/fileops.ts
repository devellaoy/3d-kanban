// Opening a file a task's conversation names (a path in an agent's message) in VS Code on the office's
// machine. The browser names the task and the path as written; the office only opens it when it lies in
// one of the task's folders (server/kanban/openfile.ts). protocol.ts joins these into the kanban's unions.

import { bad, id, optInt, text, type Obj, type Req } from './validate.js';

/** The longest path the browser may name. */
export const OPEN_FILE_PATH_MAX = 1000;

export type FileOpsClientMsg =
  /** Admins: opens `path` (relative to the task's folders, or absolute inside one) at `line`; answered with kanban.ok. */
  Req<{ t: 'kanban.task.openFile'; id: number; path: string; line?: number }>;

export const FILE_OPS_CLIENT_TYPE_LIST: Readonly<Record<FileOpsClientMsg['t'], true>> = {
  'kanban.task.openFile': true,
};

export function parseFileOpsMsg(t: FileOpsClientMsg['t'], r: Obj): Omit<FileOpsClientMsg, 'rid'> {
  if (t !== 'kanban.task.openFile') return bad(`Unknown kanban message ${t}`);
  const p = text(r.path, 'The path', OPEN_FILE_PATH_MAX).trim();
  if (p.includes('\0') || p.includes('\n')) bad('The path must be one line');
  const line = optInt(r.line, 'The line', 1, 10_000_000);
  return { t, id: id(r.id), path: p, ...(line !== undefined ? { line } : {}) };
}
