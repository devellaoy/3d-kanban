// Small helpers the integrations share: answering HTTP requests, reading their bodies, clipping
// text to a bound, creating a task the way the create dialog does, and the WS answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanCaller, KanbanClient, KanbanContext } from '../registry.js';
import type { KanbanTask, TaskType } from '../../../shared/kanban/types.js';

/** The most a JSON request body may be. */
export const BODY_MAX = 256 * 1024;
/** What readJson resolves to for a body over its limit. */
export const BODY_TOO_BIG = 'The request body is too big';

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** A request's JSON body; undefined when there's none, a string when it can't be read. */
export function readJson(req: IncomingMessage, max = BODY_MAX): Promise<unknown | string> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        resolve(BODY_TOO_BIG);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        resolve('The request body is not JSON');
      }
    });
    req.on('error', () => resolve('The request body could not be read'));
  });
}

/** Whether a request came from this machine (the hook server listens on 127.0.0.1 only, but say so twice). */
export function fromLoopback(req: IncomingMessage): boolean {
  const a = req.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}

/** The names this machine goes by in a Host header (the hook server listens on loopback only). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `host:port` when it's one of this machine's names with `port`, else undefined. */
function loopbackHost(value: string, port: string): string | undefined {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(value.trim());
  if (!m || m[2] !== port) return undefined;
  const name = m[1].toLowerCase();
  return LOOPBACK_HOSTS.has(name) ? `${name}:${m[2]}` : undefined;
}

/** Why a loopback compatibility request was refused (see loopbackRefusal). */
export interface LoopbackRefusal {
  status: number;
  code: 'request.badHost' | 'request.crossOrigin' | 'request.notJson' | 'request.tooBig' | 'request.method';
  message: string;
}

/**
 * Why a request to a loopback compatibility route (/api/v1, /api/tasks/reference) must be refused,
 * or undefined when it may go on. Listening on 127.0.0.1 keeps other machines out, but not the web
 * pages this machine's browser has open:
 * - DNS rebinding: a page whose name now points at 127.0.0.1 is same-origin with the hook server as
 *   far as the browser knows, but its requests say its own name in Host. So Host must be one of this
 *   machine's names with the port the request came in on.
 * - CSRF: a cross-site form or fetch says where it comes from (Origin, Sec-Fetch-Site), so any Origin
 *   must be this same host. A POST must also say its body is JSON: a page can't send that without a
 *   CORS preflight, and no route here ever answers one with CORS headers.
 * `port` is the port the server listens on (the socket's own, by default).
 */
export function loopbackRefusal(req: IncomingMessage, port = String(req.socket?.localPort ?? '')): LoopbackRefusal | undefined {
  const host = loopbackHost(String(req.headers.host ?? ''), port);
  if (!host) return { status: 403, code: 'request.badHost', message: `Only as http://127.0.0.1:${port} (or localhost): the Host header names another server` };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const o = /^http:\/\/([^/]+)$/i.exec(String(origin).trim());
    const from = o ? loopbackHost(o[1], port) : undefined;
    if (from !== host) return { status: 403, code: 'request.crossOrigin', message: 'Requests from web pages are refused' };
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, code: 'request.crossOrigin', message: 'Requests from web pages are refused' };
  if (req.method === 'OPTIONS') return { status: 405, code: 'request.method', message: 'No cross-origin requests' };
  if (req.method === 'POST') {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { status: 415, code: 'request.notJson', message: 'A POST must send Content-Type: application/json (its body may be empty)' };
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > BODY_MAX) return { status: 413, code: 'request.tooBig', message: `The request body may be at most ${BODY_MAX / 1024} KB` };
  }
  return undefined;
}

/** `s` cut to `max` characters, saying it was. */
export function clip(s: string | undefined, max: number): string {
  const t = s ?? '';
  return t.length > max ? `${t.slice(0, max)}\n… (cut: ${(t.length - max).toLocaleString('en-US')} more characters)` : t;
}

export const ok = (c: KanbanClient, rid: string | undefined, extra: { taskId?: number; workerId?: string; existed?: boolean; startError?: string } = {}) =>
  c.send({ t: 'kanban.ok', ...(rid ? { rid } : {}), ...extra });
export const fail = (c: KanbanClient, rid: string | undefined, message: string) => c.send({ t: 'kanban.error', ...(rid ? { rid } : {}), message });

/** A new task from an integration (an issue, the /api/v1 API), with the office's and project's defaults, as the create dialog makes one. */
export interface IntegrationTaskInput {
  project: string;
  title: string;
  description: string;
  ticket?: string;
  ticketUrl?: string;
  type?: TaskType;
  usePlan?: boolean;
}

/**
 * Creates a task, or finds the one its ticket already has in the project (issues → tasks is
 * idempotent by ticket, as ai-kanban's POST /api/v1/tasks was). Starts it when asked and new, or
 * still in todo. The browsers hear about it.
 */
export async function createIntegrationTask(
  ctx: KanbanContext,
  input: IntegrationTaskInput,
  who: KanbanCaller,
  start = false,
): Promise<{ task: KanbanTask; existed: boolean; startError?: string }> {
  const ticket = input.ticket?.trim() || undefined;
  let existed = true;
  const task = ctx.repo.transaction(() => {
    const had = ticket ? ctx.repo.findTaskByTicket(input.project, ticket) : undefined;
    if (had) return had;
    existed = false;
    const d = ctx.settings.get().defaults;
    return ctx.repo.createTask({
      project: input.project,
      title: input.title.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled',
      description: input.description.slice(0, 100_000),
      type: input.type ?? 'implement',
      ...(ticket ? { ticket } : {}),
      ...(input.ticketUrl ? { ticketUrl: input.ticketUrl } : {}),
      repoIds: null,
      tool: d.tool,
      ...(d.model ? { model: d.model } : {}),
      ...(d.effort ? { effort: d.effort } : {}),
      usePlan: input.usePlan ?? d.usePlan,
      planApproval: ctx.settings.planApproval(input.project),
      useReview: d.useReview,
      createdBy: who.name,
    });
  });
  if (!existed) {
    ctx.repo.appendEvent(task.id, 'created', { by: who.name, ...(ticket ? { ticket } : {}) });
    ctx.taskChanged(task.id);
  }
  let startError: string | undefined;
  if (start && task.status === 'todo') {
    const err = await ctx.engine.start(task.id, who);
    if (typeof err === 'string' && err) startError = err;
    ctx.taskChanged(task.id);
  }
  return { task: ctx.repo.getTask(task.id) ?? task, existed, ...(startError ? { startError } : {}) };
}
