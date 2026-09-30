// The report files an investigation writes (<filesDir>/reports/task-<id>/), for the detail panel:
//
//   GET /api/kanban/tasks/<id>/reports                 → {taskId, reports: KanbanReportFile[]}
//   GET /api/kanban/tasks/<id>/reports/<name>[?download=1] → the file, as text
//
// A name is only ever looked up in the listing (never joined onto a path as given), the listing skips
// symbolic links and dot files, and the file served must still resolve inside the task's folder. It
// goes out as text/markdown or text/plain (never HTML), with nosniff and a sandboxing CSP, at most
// REPORT_MAX_BYTES. Anyone signed in to the kanban may read them.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import type { KanbanReportFile } from '../../../../shared/kanban/types.js';
import { reportDir } from '../refs/resolve.js';
import { sendJson } from '../util.js';

export const REPORT_MAX_BYTES = 2 * 1024 * 1024;
const REPORTS_MAX = 200;
const DEPTH_MAX = 3;
const ROUTE_RE = /^\/api\/kanban\/tasks\/(\d{1,12})\/reports(?:\/(.+))?$/;

/** A task's report files, newest first: regular files only, names relative to its folder with `/`. */
export function listReports(dir: string): (KanbanReportFile & { file: string })[] {
  const out: (KanbanReportFile & { file: string })[] = [];
  const walk = (d: string, rel: string[], depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || /[\u0000-\u001f\u007f\\]/.test(name)) continue;
      const file = path.join(d, name);
      try {
        const st = lstatSync(file);
        if (st.isDirectory()) {
          if (depth < DEPTH_MAX) walk(file, [...rel, name], depth + 1);
        } else if (st.isFile()) out.push({ name: [...rel, name].join('/'), size: st.size, mtime: Math.round(st.mtimeMs), file });
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(dir, [], 0);
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, REPORTS_MAX);
}

/** The listed report called `name`, or undefined (so `../x`, absolute paths and links never match). */
export function findReport(dir: string, name: string): (KanbanReportFile & { file: string }) | undefined {
  const hit = listReports(dir).find((r) => r.name === name);
  if (!hit) return undefined;
  // Belt and braces: whatever the listing said, the file must really be inside the task's folder.
  try {
    const root = realpathSync(dir);
    const real = realpathSync(hit.file);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  } catch {
    return undefined;
  }
  return hit;
}

/** The type a report is served as: markdown for .md, plain text for everything else. */
export function reportType(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
}

export function createReportsPlugin(ctx: KanbanContext): KanbanPlugin {
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const m = ROUTE_RE.exec(url.pathname);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' }), true;
    const task = ctx.repo.getTask(Number(m[1]));
    if (!task) return sendJson(res, 404, { error: `There's no task #${m[1]}` }), true;
    const dir = reportDir(ctx.filesDir, task.id);
    if (m[2] === undefined) {
      const reports: KanbanReportFile[] = listReports(dir).map(({ name, size, mtime }) => ({ name, size, mtime }));
      return sendJson(res, 200, { taskId: task.id, reports }), true;
    }
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return sendJson(res, 400, { error: 'That report name is garbled' }), true;
    }
    const hit = findReport(dir, name);
    if (!hit) return sendJson(res, 404, { error: `Task #${task.id} has no report ${name.slice(0, 200)}` }), true;
    if (hit.size > REPORT_MAX_BYTES) return sendJson(res, 413, { error: `That report is over ${REPORT_MAX_BYTES / 1024 / 1024} MB: open it on the office's machine (${hit.file})` }), true;
    let body: Buffer;
    try {
      body = readFileSync(hit.file);
    } catch {
      return sendJson(res, 404, { error: 'That report is gone' }), true;
    }
    const base = name.split('/').pop() ?? 'report';
    const ascii = base.replace(/[^\w.-]+/g, '_') || 'report';
    const download = url.searchParams.get('download') === '1';
    res.writeHead(200, {
      'content-type': reportType(name),
      'content-length': String(body.length),
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
  return { name: 'reports', http: { '/api/kanban/tasks/': (req, res, url) => handle(req, res, url) } };
}
