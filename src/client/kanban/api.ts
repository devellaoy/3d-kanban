// The kanban's side of the WebSocket (docs/kanban-architecture.md §6): requests carry a `rid` and are
// answered exactly once, with the typed message named on the request, `kanban.ok` or `kanban.error`;
// everything else under `kanban.*` is a delta. One bus per Net, so the kanban page, the prompt
// editor's project scope and the PR board's review picker can all listen without adding handlers
// to the Net each time they open (it has no way to take one back).
//
// The office keeps one delta filter per connection (kanban.subscribe {project}; the last one wins).
// A page that subscribes itself (the kanban page) owns that filter. Anything else that needs a
// project's deltas (a task view in the 3D office) asks with watch(): the bus subscribes for the
// watched projects together (one of them, or all when they differ), and unsubscribes when the last
// watch ends. Watches never touch a filter a page owns: they ride on it.

import type { Net } from '../net';
import type { ServerMsg } from '../../shared/protocol';
import type { KanbanClientMsg, KanbanServerMsg } from '../../shared/kanban/protocol.js';

type WithoutRid<T> = T extends unknown ? Omit<T, 'rid'> : never;
export type KanbanRequest = WithoutRid<KanbanClientMsg>;
export type KanbanOk = Extract<KanbanServerMsg, { t: 'kanban.ok' }>;

/** A request the office turned down (kanban.error: `fromOffice`), or one it never answered (`lost`: the connection went or started over). */
export class KanbanError extends Error {
  constructor(
    message: string,
    readonly fromOffice = false,
    readonly lost = false,
  ) {
    super(message);
  }
}

/** How long a request waits for its answer before giving up. */
const ANSWER_MS = 30_000;

interface Pending {
  resolve(msg: KanbanServerMsg): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class KanbanApi {
  private seq = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(msg: KanbanServerMsg) => void>();
  private welcomes = new Set<() => void>();
  private watches = new Map<number, string>();
  private watchSeq = 0;
  /** Something subscribed the connection itself: its filter stands, watches ride on it. */
  private owned = false;
  /** The filter the watches last asked for; undefined when they asked for none. */
  private watching: string | null | undefined = undefined;

  constructor(readonly net: Net) {
    net.onMessage((msg: ServerMsg) => {
      // A new connection has forgotten what was asked on the old one (a page subscribes again itself).
      if (msg.t === 'welcome') {
        this.failAll('The connection to the office was lost: try again');
        this.watching = undefined;
        this.syncWatches();
        for (const fn of [...this.welcomes]) fn();
      }
      if (typeof msg.t !== 'string' || !msg.t.startsWith('kanban.')) return;
      const k = msg as KanbanServerMsg;
      const rid = 'rid' in k ? k.rid : undefined;
      const waiter = rid ? this.pending.get(rid) : undefined;
      if (waiter && rid) {
        this.pending.delete(rid);
        clearTimeout(waiter.timer);
        if (k.t === 'kanban.error') waiter.reject(new KanbanError(k.message, true));
        else waiter.resolve(k);
      }
      // Answers go to the listeners too: a snapshot asked for by one view is news for the others.
      for (const fn of this.listeners) fn(k);
    });
    net.onStatus((up) => {
      if (!up) this.failAll('The connection to the office was lost: try again');
    });
  }

  get up(): boolean {
    return this.net.up;
  }

  /** Hears every kanban message from the office; returns how to stop. */
  on(fn: (msg: KanbanServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs `fn` each time the office welcomes the connection (again): what was asked before is lost then. Returns how to stop. */
  onWelcome(fn: () => void): () => void {
    this.welcomes.add(fn);
    return () => this.welcomes.delete(fn);
  }

  /** Sends without waiting for the answer (deltas still come). */
  send(msg: KanbanRequest) {
    this.claims(msg);
    this.net.send(msg as KanbanClientMsg);
  }

  /**
   * Asks for `project`'s deltas (kanban.task, kanban.comment, kanban.run, kanban.plan) until the
   * returned function is called. Heard through on(), like every other kanban message.
   */
  watch(project: string): () => void {
    const id = ++this.watchSeq;
    this.watches.set(id, project);
    this.syncWatches();
    return () => {
      if (this.watches.delete(id)) this.syncWatches();
    };
  }

  /** Whether the connection's filter is a page's own (then watches send nothing). */
  get pageSubscribed(): boolean {
    return this.owned;
  }

  /** A page's own subscribe takes the filter over from the watches for good. */
  private claims(msg: KanbanRequest) {
    if (msg.t !== 'kanban.subscribe' && msg.t !== 'kanban.unsubscribe') return;
    this.owned = true;
    this.watching = undefined;
  }

  private syncWatches() {
    if (this.owned || !this.net.up) return;
    const projects = new Set(this.watches.values());
    const want = projects.size === 0 ? undefined : projects.size === 1 ? [...projects][0] : null;
    if (want === this.watching) return;
    const had = this.watching;
    this.watching = want;
    if (want === undefined) {
      if (had !== undefined) this.net.send({ t: 'kanban.unsubscribe' });
    } else this.net.send({ t: 'kanban.subscribe', project: want });
  }

  /**
   * Sends a request and resolves to its answer: the typed reply, or kanban.ok. Rejects with a
   * KanbanError carrying the office's reason when it says no, or when nothing comes back.
   */
  request<T extends KanbanServerMsg = KanbanServerMsg>(msg: KanbanRequest): Promise<T> {
    if (!this.net.up) return Promise.reject(new KanbanError('Not connected to the office', false, true));
    this.claims(msg);
    const rid = `k${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new KanbanError('The office didn’t answer'));
      }, ANSWER_MS);
      this.pending.set(rid, { resolve: resolve as (m: KanbanServerMsg) => void, reject, timer });
      this.net.send({ ...msg, rid } as KanbanClientMsg);
    });
  }

  private failAll(why: string) {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new KanbanError(why, false, true));
      this.pending.delete(rid);
    }
  }
}

const apis = new WeakMap<Net, KanbanApi>();

/** The kanban bus of a connection, made the first time it's asked for. */
export function kanbanApi(net: Net): KanbanApi {
  let api = apis.get(net);
  if (!api) apis.set(net, (api = new KanbanApi(net)));
  return api;
}

/** A JSON answer from the office's HTTP API (a task's changes, its reports), or its `{error}` as a thrown Error. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new Error((body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`);
  return body as T;
}
