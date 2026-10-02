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
import type { Multiplayer } from './index.js';

type Msg<T extends RelayToOffice['t']> = Extract<RelayToOffice, { t: T }>;

interface Hosted {
  sock: RemoteSocket;
  scope: VisitorScope;
}

export class Host {
  readonly sessions = new Map<string, Hosted>();
  /** Visits being checked against GitHub, so a repeated visit.open for the same id is ignored. */
  private pending = new Set<string>();

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
    this.pending.add(sid);
    try {
      // The messages are shaped by the code, so both offices must run the same.
      if (msg.protocol !== MP_PROTOCOL || msg.version !== mp.version) {
        return refuse(`@${mp.link.login ?? 'the owner'} runs version ${mp.version} — update both offices to the same version`);
      }
      const defs = ctx.building.list().filter((d) => ctx.floors.has(d.id));
      const allowed = await mp.access.allowedFloors(defs, mp.cfg.get().sharedFloors, msg.from);
      if (!mp.link.online) return;
      if (!allowed.length) return refuse("You don't have access to any shared floor");
      this.admit(msg, allowed);
    } catch (err) {
      refuse(`The visit could not start: ${(err as Error).message}`.slice(0, 200));
    } finally {
      this.pending.delete(sid);
    }
  }

  private admit(msg: Msg<'visit.open'>, allowed: string[]) {
    const { ctx, mp } = this;
    const { sid, profile } = msg;
    const scope: VisitorScope = { login: msg.from, floors: new Set(allowed), projects: new Set(allowed) };
    const sock = new RemoteSocket(
      {
        frame: (data) => mp.link.send({ t: 'visit.frame', sid, data }, true),
        up: () => mp.link.online,
        bufferedAmount: () => mp.link.bufferedAmount,
        closed: (reason) => void mp.link.send({ t: 'visit.close', sid, reason: reason.slice(0, 250) }),
      },
      scope,
      { floorOfPeer: (id) => ctx.clients.get(id)?.peer.floor, projectOfTask: (id) => ctx.kanban?.ctx.repo.getTask(id)?.project },
    );
    this.sessions.set(sid, { sock, scope });
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
    if (!h) return false;
    if (msg.t === 'visit.frame') h.sock.receive(msg.data);
    else h.sock.end(msg.reason, false);
    return true;
  }

  /** Ends every visit (the link dropped, or multiplayer was switched off). */
  endAll(reason: string, notify: boolean) {
    for (const h of [...this.sessions.values()]) h.sock.end(reason, notify);
  }
}
