// A task's UI images (<filesDir>/grants/task-<id>/ui/, see engine/uitesting.ts), for the detail's Images tab:
//
//   GET    /api/kanban/tasks/<id>/images         → {taskId, images: KanbanTaskImage[]}
//   GET    /api/kanban/tasks/<id>/images/<name>  → the image
//   DELETE /api/kanban/tasks/<id>/images/<name>  → removes it (answers the list that is left)
//
// A name is only ever looked up in the listing (never joined onto a path as given), the listing skips
// links and names that do not fit the pattern, and the file served must still resolve inside the folder.
// Images go out by the type of their extension with nosniff and a sandboxing CSP, never cached (an
// agent retakes a picture under the same name). Anyone signed in may read them and, as with editing a
// task, remove one; a visitor of a shared office is held to reading by the router (multiplayer/paths.ts).

import { createReadStream, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import { uiImageType, type KanbanTaskImage, type KanbanTaskImageList } from '../../../../shared/kanban/uitesting.js';
import { listUiImages, uiImagesDir, type UiImageFile } from '../../engine/uitesting.js';
import { sendJson } from '../util.js';

const ROUTE_RE = /^\/api\/kanban\/tasks\/(\d{1,12})\/images(?:\/(.+))?$/;

/** The listed image called `name`, or undefined (so `../x`, absolute paths and links never match). */
export function findUiImage(dir: string, name: string): UiImageFile | undefined {
  const hit = listUiImages(dir).find((i) => i.name === name);
  if (!hit) return undefined;
  try {
    const rel = path.relative(realpathSync(dir), realpathSync(hit.file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  } catch {
    return undefined;
  }
  return hit;
}

const plain = ({ name, kind, subject, size, mtime }: KanbanTaskImage): KanbanTaskImage => ({ name, kind, subject, size, mtime });

export function createImagesPlugin(ctx: KanbanContext): KanbanPlugin {
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    if (!read && method !== 'DELETE') return sendJson(res, 405, { error: 'GET or DELETE only' }), true;
    const task = ctx.repo.getTask(Number(m[1]));
    if (!task) return sendJson(res, 404, { error: `There's no task #${m[1]}` }), true;
    const dir = uiImagesDir(ctx.filesDir, task.id);
    const list = (): KanbanTaskImageList => ({ taskId: task.id, images: listUiImages(dir).map(plain) });
    if (m[2] === undefined) {
      if (!read) return sendJson(res, 405, { error: 'GET only' }), true;
      return sendJson(res, 200, list()), true;
    }
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return sendJson(res, 400, { error: 'That image name is garbled' }), true;
    }
    const hit = findUiImage(dir, name);
    if (!hit) return sendJson(res, 404, { error: `Task #${task.id} has no image ${name.slice(0, 200)}` }), true;
    if (method === 'DELETE') {
      try {
        rmSync(hit.file);
      } catch {
        return sendJson(res, 404, { error: 'That image is gone' }), true;
      }
      return sendJson(res, 200, list()), true;
    }
    res.writeHead(200, {
      'content-type': uiImageType(name),
      'content-length': String(hit.size),
      'content-disposition': `inline; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    });
    if (method === 'HEAD') res.end();
    else createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
    return true;
  };
  return { name: 'images', http: { '/api/kanban/tasks/': (req, res, url) => handle(req, res, url) } };
}
