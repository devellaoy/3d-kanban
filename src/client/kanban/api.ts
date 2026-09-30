// The kanban's side of the WebSocket (docs/kanban-architecture.md §6): requests carry a `rid` and are
// answered exactly once, with the typed message named on the request, `kanban.ok` or `kanban.error`;
// everything else under `kanban.*` is a delta. One bus per Net, so the kanban page, the prompt
// editor's project scope and the PR board's review picker can all listen without adding handlers
// to the Net each time they open (it has no way to take one back).

import type { Net } from '../net';
import type { ServerMsg } from '../../shared/protocol';
import type { KanbanClientMsg, KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { t } from './i18n';

type WithoutRid<T> = T extends unknown ? Omit<T, 'rid'> : never;
export type KanbanRequest = WithoutRid<KanbanClientMsg>;
export type KanbanOk = Extract<KanbanServerMsg, { t: 'kanban.ok' }>;

/** A request the office turned down (kanban.error: `fromOffice`), or one it never answered. */
export class KanbanError extends Error {
  constructor(
    message: string,
    readonly fromOffice = false,
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

  constructor(private net: Net) {
    net.onMessage((msg: ServerMsg) => {
      // A new connection has forgotten what was asked on the old one.
      if (msg.t === 'welcome') this.failAll(t('connectionLost'));
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
      if (!up) this.failAll(t('connectionLost'));
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

  /** Sends without waiting for the answer (deltas still come). */
  send(msg: KanbanRequest) {
    this.net.send(msg as KanbanClientMsg);
  }

  /**
   * Sends a request and resolves to its answer: the typed reply, or kanban.ok. Rejects with a
   * KanbanError carrying the office's reason when it says no, or when nothing comes back.
   */
  request<T extends KanbanServerMsg = KanbanServerMsg>(msg: KanbanRequest): Promise<T> {
    if (!this.net.up) return Promise.reject(new KanbanError(t('notConnected')));
    const rid = `k${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new KanbanError(t('noAnswer')));
      }, ANSWER_MS);
      this.pending.set(rid, { resolve: resolve as (m: KanbanServerMsg) => void, reject, timer });
      this.net.send({ ...msg, rid } as KanbanClientMsg);
    });
  }

  private failAll(why: string) {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new KanbanError(why));
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
