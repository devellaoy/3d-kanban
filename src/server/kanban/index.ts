// The kanban, installed into the office (server.ts calls installKanban once its floors are open).
// It builds the KanbanContext every part gets (registry.ts), wires up the engine and the plugins,
// and is the one door server.ts talks to: WS messages (handleWs), browser routes under /api/kanban/
// (handleHttp), task workers' hook-server routes (handleHook), ai-kanban's loopback compatibility
// routes (handleLoopback), and who's listening to which project's deltas.

import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { FloorDef } from '../building.js';
import type { Floor } from '../floor.js';
import type {
  KanbanCaller,
  KanbanClient,
  KanbanContext,
  KanbanHookCaller,
  KanbanHookHandler,
  KanbanHttpHandler,
  KanbanLoopbackHandler,
  KanbanPlugin,
  KanbanPluginFactory,
  KanbanPullsApi,
  KanbanRefsApi,
  KanbanWsHandler,
} from './registry.js';
import { KanbanRepository } from './db/repository.js';
import { kanbanDbPath, openKanbanDb } from './db/open.js';
import { KanbanSecrets, KanbanSettingsStore } from './settings.js';
import { primaryRepo, projectRepos, validateProjectRepos } from './projects.js';
import { attachmentPath } from './uploads.js';
import { createCorePlugin, projectInfos } from './ws.js';
import { createEngine, type KanbanEngine } from './engine/index.js';
import { createPulls, createRefs, integrationPlugins } from './integrations/index.js';
import { parseKanbanClientMsg, ridOf, type KanbanClientType, type KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { ProjectRepo } from '../../shared/kanban/types.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { KanbanRunAs } from './registry.js';
import { promptTaskWorker, resumeTaskWorker } from './coupling.js';

/** What the office hands the kanban. */
export interface KanbanOffice {
  /** The office's data dir (`<officeData>/.agent-office`, cfg.dataDir). */
  dataDir: string;
  /** Every floor of the building, open or not (Building.list). */
  floors(): FloorDef[];
  /** An open floor. */
  floor(id: string): Floor | undefined;
  /** Saves a floor's repositories, already checked (Building.setRepos). */
  saveRepos(id: string, repos: ProjectRepo[] | undefined): FloorDef | string;
  /** Renames a floor (Building.setName) and tells the office's clients. */
  saveName?(id: string, name: string): FloorDef | string;
  /** The office-wide custom prompt texts (OfficePrompts.state().custom). */
  officePrompts(): Partial<Record<string, { text: string }>>;
  /** The loopback hook server's base URL. */
  hookUrl: string;
  toast(floorId: string, text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Why the office can't take another worker now (upstream's Capacity.full: its worker limit), if it can't. */
  capacity?(): string | undefined;
  /** Upstream's sign-in rule (signins as RunAs): task hires run on their owner's own Claude sign-in. */
  runAs?: KanbanRunAs;
  /** The office's team notifications (upstream's webhook). */
  notify?(title: string, detail?: string): void;
}

export interface KanbanInstallOptions extends KanbanOffice {
  /** The database file; the default is kanbanDbPath(dataDir). ':memory:' for tests. */
  dbFile?: string;
  /** Stand-ins, for tests. */
  createEngine?: (ctx: KanbanContext) => KanbanEngine;
  createPulls?: (ctx: KanbanContext) => KanbanPullsApi;
  createRefs?: (ctx: KanbanContext) => KanbanRefsApi;
  plugins?: KanbanPluginFactory[];
}

export interface Kanban {
  ctx: KanbanContext;
  engine: KanbanEngine;
  plugins: KanbanPlugin[];
  /** A browser's `kanban.*` message: checked field by field, then handled by the plugin that owns its type. */
  handleWs(c: KanbanClient, raw: unknown): void;
  /** /api/kanban/* for a signed-in browser. False: nothing here answers that path. */
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanCaller): Promise<boolean>;
  /** /office/tasks* from a task worker whose hook token server.ts has checked. */
  handleHook(req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanHookCaller): Promise<boolean>;
  /** Loopback routes whose auth the plugin decides (/api/tasks/reference, /api/v1/). */
  handleLoopback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** A browser went away: it hears nothing more. */
  clientGone(clientId: string): void;
  /** Floors (or their repositories) may have changed: subscribers hear the projects when they did. */
  projectsChanged(): void;
  /** A prompt to a worker on someone's behalf: `asComment`, a task comment for a task worker (see coupling.ts); undefined: upstream types it in. */
  workerPrompt(info: WorkerInfo, text: string, who: KanbanCaller, asComment?: boolean): Promise<string | void> | undefined;
  /** R on a worker: the task's Retry for a task worker whose task waits (see coupling.ts); undefined: upstream resumes it. */
  workerResume(info: WorkerInfo, who: KanbanCaller): Promise<string | void> | undefined;
  shutdown(): void;
}

interface Subscriber {
  client: KanbanClient;
  project: string | null;
  includeArchived: boolean;
}

/** Longest prefix first, so '/api/kanban/attachments/' wins over '/api/kanban/'. */
function routeTable<H>(plugins: KanbanPlugin[], pick: (p: KanbanPlugin) => Record<string, H> | undefined): [string, H][] {
  const out: [string, H][] = [];
  for (const p of plugins) for (const [prefix, h] of Object.entries(pick(p) ?? {})) out.push([prefix, h]);
  return out.sort((a, b) => b[0].length - a[0].length);
}

async function route<A extends unknown[]>(table: [string, (...args: A) => boolean | Promise<boolean>][], pathname: string, args: A): Promise<boolean> {
  for (const [prefix, h] of table) {
    if (pathname !== prefix && !pathname.startsWith(prefix)) continue;
    if (await h(...args)) return true;
  }
  return false;
}

export function installKanban(opts: KanbanInstallOptions): Kanban {
  const dataDir = opts.dataDir;
  const filesDir = path.join(dataDir, 'kanban');
  const db = openKanbanDb(opts.dbFile ?? kanbanDbPath(dataDir));
  const repo = new KanbanRepository(db);
  const subscribers = new Map<string, Subscriber>();
  /** The project of each task a card went out for, to say where a deleted one was. */
  const taskProjects = new Map<number, string>();

  const broadcast = (msg: KanbanServerMsg, project: string | null) => {
    // An archived card leaves the board of anyone not looking at the archive.
    const archived = msg.t === 'kanban.task' && msg.task.status === 'archived';
    for (const s of subscribers.values()) {
      if (project !== null && s.project !== null && s.project !== project) continue;
      try {
        if (archived && !s.includeArchived && msg.t === 'kanban.task') s.client.send({ t: 'kanban.task.removed', id: msg.task.id, project: msg.task.project });
        else s.client.send(msg);
      } catch (err) {
        console.error(`agent-office: couldn't send a kanban update: ${(err as Error).message}`);
      }
    }
  };

  const settings = new KanbanSettingsStore(dataDir);
  const secrets = new KanbanSecrets(dataDir);
  const project = (id: string) => opts.floors().find((d) => d.id === id);

  let plugins: KanbanPlugin[] = [];
  const ctx = {
    dataDir,
    filesDir,
    repo,
    settings,
    secrets,
    projects: () => opts.floors(),
    project,
    floor: (id: string) => opts.floor(id),
    repos: (id: string) => {
      const def = project(id);
      return def ? projectRepos(def) : [];
    },
    setRepos: (id: string, repos: ProjectRepo[]) => {
      const def = project(id);
      if (!def) return 'No such project';
      const checked = validateProjectRepos(def, repos);
      if (typeof checked === 'string') return checked;
      // Just the floor's own checkout, as it is: the floor goes back to having no list of its own.
      const plain = checked.length === 1 && JSON.stringify(checked[0]) === JSON.stringify(primaryRepo(def));
      const saved = opts.saveRepos(id, plain ? undefined : checked);
      return typeof saved === 'string' ? saved : undefined;
    },
    setName: (id: string, name: string) => {
      if (!project(id)) return 'No such project';
      if (!opts.saveName) return "This office can't rename projects";
      const was = project(id)!.name;
      const r = opts.saveName(id, name);
      if (typeof r === 'string') return r;
      // A saved list's primary still called after the project takes the new name too (one without a list follows the floor anyway).
      const primary = r.repos?.find((x) => x.primary);
      if (r.repos && primary?.name === was && !r.repos.some((x) => !x.primary && x.name.toLowerCase() === r.name.toLowerCase())) {
        opts.saveRepos(id, r.repos.map((x) => (x.primary ? { ...x, name: r.name } : x)));
      }
      return undefined;
    },
    officePrompts: () => opts.officePrompts(),
    hookUrl: opts.hookUrl,
    broadcast,
    toast: (floorId: string, text: string, level?: 'info' | 'warn' | 'error') => opts.toast(floorId, text, level),
    ...(opts.capacity ? { capacity: () => opts.capacity!() } : {}),
    ...(opts.runAs ? { runAs: opts.runAs } : {}),
    ...(opts.notify ? { notify: (title: string, detail?: string) => opts.notify!(title, detail) } : {}),
    card: (taskId: number) =>
      repo.card(taskId, (t) => {
        const r = settings.effectiveReview(t.project, t.overrides);
        return { rounds: r.rounds, tool: r.tool };
      }),
    taskChanged: (taskId: number) => {
      const card = ctx.card(taskId);
      if (card) {
        taskProjects.set(taskId, card.project);
        broadcast({ t: 'kanban.task', task: card }, card.project);
        // Its workers in the 3D office show the card too (WorkerInfo.kanban).
        return (ctx.engine as Partial<KanbanEngine> | undefined)?.cardChanged?.(taskId);
      }
      const was = taskProjects.get(taskId);
      taskProjects.delete(taskId);
      broadcast({ t: 'kanban.task.removed', id: taskId, project: was ?? '' }, was ?? null);
    },
    attachmentFile: (id: string) => {
      const a = repo.getAttachment(id);
      return a && attachmentPath(filesDir, a);
    },
    workerExtras: (taskId: number, tool: 'claude' | 'codex', phase: string) => {
      const args: string[] = [];
      const env: Record<string, string> = {};
      // A plugin that fails loses only its own part of the launch.
      const guarded = <T>(p: KanbanPlugin, fn: () => T | undefined): T | undefined => {
        try {
          return fn();
        } catch (err) {
          console.error(`agent-office: the kanban's ${p.name} couldn't add to task #${taskId}'s worker: ${(err as Error).message}`);
          return undefined;
        }
      };
      for (const p of plugins) {
        args.push(...(guarded(p, () => p.workerArgs?.(taskId, tool, phase)) ?? []));
        Object.assign(env, guarded(p, () => p.workerEnv?.(taskId)) ?? {});
      }
      return { args, env };
    },
  } as KanbanContext;

  // The parts: each only reaches the others through ctx, lazily, so the order here doesn't matter to them.
  ctx.pulls = (opts.createPulls ?? createPulls)(ctx);
  ctx.refs = (opts.createRefs ?? createRefs)(ctx);
  const engine = (opts.createEngine ?? createEngine)(ctx);
  ctx.engine = engine;

  const subs = {
    subscribe(c: KanbanClient, p: string | null, includeArchived: boolean) {
      subscribers.set(c.clientId, { client: c, project: p, includeArchived });
    },
    unsubscribe(clientId: string) {
      subscribers.delete(clientId);
    },
  };
  plugins = [createCorePlugin(ctx, subs), ...(opts.plugins ?? integrationPlugins).map((f) => f(ctx))];

  // One plugin per message type: the first to claim one keeps it.
  const wsRoutes = new Map<KanbanClientType, { plugin: string; handler: KanbanWsHandler }>();
  for (const p of plugins) {
    for (const [t, handler] of Object.entries(p.ws ?? {}) as [KanbanClientType, KanbanWsHandler][]) {
      const had = wsRoutes.get(t);
      if (had) console.error(`agent-office: the kanban's ${p.name} and ${had.plugin} both handle ${t}; ${had.plugin} keeps it`);
      else wsRoutes.set(t, { plugin: p.name, handler });
    }
  }
  const httpRoutes = routeTable<KanbanHttpHandler>(plugins, (p) => p.http);
  const hookRoutes = routeTable<KanbanHookHandler>(plugins, (p) => p.hook);
  const loopbackRoutes = routeTable<KanbanLoopbackHandler>(plugins, (p) => p.loopback);

  const failWs = (c: KanbanClient, rid: string | undefined, message: string) => c.send({ t: 'kanban.error', ...(rid ? { rid } : {}), message });
  const crashed = (c: KanbanClient, rid: string | undefined, t: string, err: unknown) => {
    console.error(`agent-office: the kanban's ${t} failed:`, err);
    failWs(c, rid, `Something went wrong: ${(err as Error)?.message ?? String(err)}`);
  };

  // Everything exists: now the parts may start doing things by themselves.
  try {
    engine.begin();
  } catch (err) {
    console.error('agent-office: the kanban engine failed to start:', err);
  }
  for (const p of plugins) {
    try {
      p.start?.();
    } catch (err) {
      console.error(`agent-office: the kanban's ${p.name} failed to start:`, err);
    }
  }

  let projectsSent = '';
  let closed = false;

  return {
    ctx,
    engine,
    plugins,
    handleWs(c, raw) {
      if (closed) return;
      const msg = parseKanbanClientMsg(raw);
      if (typeof msg === 'string') return failWs(c, ridOf(raw), msg);
      const r = wsRoutes.get(msg.t);
      if (!r) return failWs(c, msg.rid, `${msg.t} isn't available on this office yet`);
      try {
        const done = r.handler(c, msg as never);
        if (done instanceof Promise) done.catch((err) => crashed(c, msg.rid, msg.t, err));
      } catch (err) {
        crashed(c, msg.rid, msg.t, err);
      }
    },
    handleHttp: (req, res, url, who) => route(httpRoutes, url.pathname, [req, res, url, who]),
    handleHook: (req, res, url, who) => route(hookRoutes, url.pathname, [req, res, url, who]),
    handleLoopback: (req, res, url) => route(loopbackRoutes, url.pathname, [req, res, url]),
    clientGone(clientId) {
      subscribers.delete(clientId);
    },
    projectsChanged() {
      if (closed || !subscribers.size) return;
      const projects = projectInfos(ctx);
      const json = JSON.stringify(projects);
      if (json === projectsSent) return;
      projectsSent = json;
      broadcast({ t: 'kanban.projects', projects }, null);
    },
    workerPrompt: (info, text, who, asComment) => (closed ? undefined : promptTaskWorker(ctx, info, text, who, asComment)),
    workerResume: (info, who) => (closed ? undefined : resumeTaskWorker(ctx, info, who)),
    shutdown() {
      if (closed) return;
      closed = true;
      for (const p of plugins) {
        try {
          p.stop?.();
        } catch (err) {
          console.error(`agent-office: the kanban's ${p.name} failed to stop:`, err);
        }
      }
      try {
        engine.dispose();
      } catch (err) {
        console.error('agent-office: the kanban engine failed to stop:', err);
      }
      subscribers.clear();
      db.close();
    },
  };
}

export type { KanbanCaller, KanbanClient, KanbanHookCaller } from './registry.js';
