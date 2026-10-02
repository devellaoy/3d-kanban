// The owner's side of a visit: someone from the relay asks to come in (`visit.open`), and if their
// version matches and they can read at least one shared floor on GitHub, they join as a Client
// whose socket is a RemoteSocket. From there they go through the same connection code as anyone,
// but they are `visitor`s: what they send passes the inbound gate (ws/dispatch.ts) and what the
// office sends them passes the outbound filter (remote-socket.ts).
import { MP_PROTOCOL, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { VisitorScope } from '../../shared/multiplayer/allow.js';
import type { Ctx } from '../office/context.js';
import { onConnection } from '../ws/connection.js';
import { RemoteSocket } from './remote-socket.js';
import { repoPrint } from './access.js';
import { workerFloors } from './gate.js';
import type { Multiplayer } from './index.js';

type Msg<T extends RelayToOffice['t']> = Extract<RelayToOffice, { t: T }>;

interface Hosted {
  sock: RemoteSocket;
  scope: VisitorScope;
  /** Floor id → the repositories (repoPrint) the visitor was verified against; a floor whose project changed is taken away until it is verified again. */
  prints: Map<string, string>;
  /** Floors taken away, with the repositories they had when GitHub last said no (or has not answered yet): asked again when the project changes once more. */
  denied: Map<string, string>;
}

export class Host {
  readonly sessions = new Map<string, Hosted>();
  /** Visits being checked against GitHub, so a repeated visit.open for the same id is ignored; `ended` when the visitor withdrew or the link dropped meanwhile. */
  private pending = new Map<string, { ended: boolean }>();

  constructor(
    private mp: Multiplayer,
    private ctx: Ctx,
  ) {}

  /** Visitors in the office now (for their count and for ending visits of a floor that stopped being shared). */
  visitors(): { sid: string; scope: VisitorScope; sock: RemoteSocket }[] {
    return [...this.sessions].map(([sid, h]) => ({ sid, ...h }));
  }

  async open(msg: Msg<'visit.open'>) {
    const { ctx, mp } = this;
    const { sid } = msg;
    if (this.sessions.has(sid) || this.pending.has(sid)) return;
    const refuse = (reason: string) => void mp.link.send({ t: 'visit.close', sid, reason });
    const wait = { ended: false };
    this.pending.set(sid, wait);
    try {
      // The messages are shaped by the code, so both offices must run the same.
      if (msg.protocol !== MP_PROTOCOL || msg.version !== mp.version) {
        return refuse(`@${mp.link.login ?? 'the owner'} runs version ${mp.version} — update both offices to the same version`);
      }
      // GitHub takes a while, and the owner may unshare a floor or change its repositories meanwhile:
      // `admitted` checks the answer against the config as it is when it comes back.
      const allowed = await mp.admitted(msg.from);
      if (wait.ended || !mp.link.online) return;
      if (!allowed.size) return refuse("You don't have access to any shared floor");
      this.admit(msg, allowed);
    } catch (err) {
      refuse(`The visit could not start: ${(err as Error).message}`.slice(0, 200));
    } finally {
      this.pending.delete(sid);
    }
  }

  private admit(msg: Msg<'visit.open'>, verified: Map<string, string>) {
    const { ctx, mp } = this;
    const { sid, profile } = msg;
    const allowed = [...verified.keys()];
    const scope: VisitorScope = { login: msg.from, floors: new Set(allowed), projects: new Set(allowed) };
    const sock = new RemoteSocket(
      {
        frame: (data, drop) => mp.link.send({ t: 'visit.frame', sid, data, ...(drop ? { drop: true as const } : {}) }, !!drop),
        up: () => mp.link.online,
        bufferedAmount: () => mp.link.bufferedAmount,
        closed: (reason) => void mp.link.send({ t: 'visit.close', sid, reason: reason.slice(0, 250) }),
      },
      scope,
      { floorOfPeer: (id) => ctx.clients.get(id)?.peer.floor, workerFloors: (id) => workerFloors(ctx, id), projectOfTask: (id) => ctx.kanban?.ctx.repo.getTask(id)?.project },
    );
    this.sessions.set(sid, { sock, scope, prints: new Map(verified), denied: new Map() });
    sock.once('close', () => this.sessions.delete(sid));
    // Accepted before the welcome goes out, since the relay passes frames only for an accepted visit.
    mp.link.send({ t: 'visit.accept', sid });
    // Their look comes in the way a browser's does, through the query the connection code validates.
    const q = new URLSearchParams({ color: profile.color, skin: String(profile.skin), hair: String(profile.hair), style: String(profile.style), floor: allowed[0] });
    onConnection(ctx, sock.asWebSocket(), new URL(`http://visit/ws?${q}`), {}, scope);
  }

  /** A visit.frame / visit.close from the visitor's office. Returns whether the sid is one of ours. */
  message(msg: Msg<'visit.frame'> | Msg<'visit.close'>): boolean {
    const h = this.sessions.get(msg.sid);
    if (!h) {
      // The visitor gave up while their access was being checked.
      const wait = msg.t === 'visit.close' ? this.pending.get(msg.sid) : undefined;
      if (wait) wait.ended = true;
      return !!wait;
    }
    if (msg.t === 'visit.frame') h.sock.receive(msg.data);
    else h.sock.end(msg.reason, false);
    return true;
  }

  /** Ends every visit (the link dropped, or multiplayer was switched off). */
  endAll(reason: string, notify: boolean) {
    for (const wait of this.pending.values()) wait.ended = true;
    for (const h of [...this.sessions.values()]) h.sock.end(reason, notify);
  }

  /**
   * The floors or projects of the office changed: a visitor loses every floor whose repositories are
   * not the ones they were verified against (or that is no longer shared) at once, and gets it back
   * only if GitHub says they can read every repository it has now.
   */
  recheck() {
    const { ctx, mp } = this;
    if (!this.sessions.size) return;
    const defs = new Map(ctx.building.list().map((d) => [d.id, d]));
    const shared = mp.cfg.get().sharedFloors;
    for (const [sid, h] of [...this.sessions]) {
      const changed = (id: string, print: string) => {
        const def = defs.get(id);
        return !def || !shared.includes(id) || repoPrint(def) !== print;
      };
      const stale = [...h.prints].filter(([id, print]) => changed(id, print)).map(([id]) => id);
      // A floor taken away earlier gets another chance when its repositories change again.
      const retry = [...h.denied].filter(([id, print]) => defs.has(id) && changed(id, print)).map(([id]) => id);
      if (!stale.length && !retry.length) continue;
      for (const id of stale) {
        h.prints.delete(id);
        mp.unshared(id, h.scope);
      }
      const tried = [...stale, ...retry].filter((id) => defs.has(id));
      for (const id of tried) h.denied.set(id, repoPrint(defs.get(id)!));
      this.tell(h);
      void this.regain(sid, h, tried);
    }
  }

  /** Verifies the visitor again for floors they lost and gives back those they can still read (the visit may be over by then). */
  private async regain(sid: string, h: Hosted, lost: string[]) {
    const now = await this.mp.admitted(h.scope.login).catch(() => new Map<string, string>());
    if (this.sessions.get(sid) !== h || h.sock.readyState !== 1) return;
    for (const id of lost) {
      const print = now.get(id);
      if (print === undefined || h.prints.has(id)) continue;
      h.prints.set(id, print);
      h.denied.delete(id);
      (h.scope.floors as Set<string>).add(id);
      (h.scope.projects as Set<string>).add(id);
    }
    this.tell(h);
  }

  /** Their floor list, as it is in their scope now. */
  private tell(h: Hosted) {
    const c = [...this.ctx.clients.values()].find((x) => x.visitor === h.scope);
    if (c) this.ctx.sendTo(c, { t: 'floors', floors: this.ctx.floorInfos() });
  }
}
