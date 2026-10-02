// The visitor's own office: while its admin visits someone, their browser's /ws?visit=<login>
// socket is a pipe to the owner's office through the relay. Frames go both ways untouched (the
// owner's office does the judging: its gate for what comes in, its filter for what goes out), and
// the same pipe carries the owner's answers to the read-only GETs the windows ask for. When the
// visit ends, for whatever reason, the browser gets `mp.ended` and the socket closes with 4000.
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { lookFromSeed, sanitizeLook } from '../../shared/avatar.js';
import { LOGIN_RE, MP_BODY_MAX, MP_FRAME_MAX, MP_HIGH_WATER, MP_PROTOCOL, loginKey, type MpVisitProfile, type RelayToOffice } from '../../shared/multiplayer/wire.js';
import type { Session } from '../auth.js';
import type { Ctx } from '../office/context.js';
import { COLOR_RE, str } from '../office/input.js';
import { mpOf } from './registry.js';
import type { Multiplayer } from './index.js';

/** The close code the browser sees when its visit is over (the page goes back to its own office). */
export const VISIT_ENDED = 4000;
const HTTP_TIMEOUT_MS = 45_000;
const QUEUE_MAX = 100;

interface Pipe {
  sid: string;
  login: string;
  ws: WebSocket;
  open: boolean;
  /** What the browser said before the owner accepted. */
  queue: string[];
}

export interface HttpAnswer {
  status: number;
  type: string;
  body: Buffer;
}

interface PendingHttp {
  sid: string;
  resolve(a: HttpAnswer): void;
  timer: NodeJS.Timeout;
}

export class Guest {
  readonly pipes = new Map<string, Pipe>();
  private http = new Map<string, PendingHttp>();

  constructor(private mp: Multiplayer) {}

  /** Whose office this office's browsers are visiting now (the first), for the presence it shows. */
  get visiting(): string | undefined {
    return this.pipes.values().next().value?.login;
  }

  pipe(ws: WebSocket, login: string, profile: MpVisitProfile) {
    const { link } = this.mp;
    const sid = randomBytes(12).toString('base64url');
    const p: Pipe = { sid, login, ws, open: false, queue: [] };
    this.pipes.set(sid, p);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.length > MP_FRAME_MAX) return;
      if (!p.open) {
        if (p.queue.length < QUEUE_MAX) p.queue.push(text);
        return;
      }
      link.send({ t: 'visit.frame', sid, data: text }, true);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (!this.pipes.delete(sid)) return;
      this.dropHttp(sid);
      link.send({ t: 'visit.close', sid, reason: 'The visitor left' });
      this.mp.updatePresence();
    });
    if (!link.send({ t: 'visit.open', sid, to: login, version: this.mp.version, protocol: MP_PROTOCOL, profile })) return this.end(p, 'This office is not connected to the relay');
    this.mp.updatePresence();
  }

  /** visit.accept / visit.frame / visit.close from the owner's office. Returns whether the sid is one of ours. */
  message(msg: Extract<RelayToOffice, { t: 'visit.accept' | 'visit.frame' | 'visit.close' }>): boolean {
    const p = this.pipes.get(msg.sid);
    if (!p) return false;
    if (msg.t === 'visit.accept') {
      p.open = true;
      for (const text of p.queue.splice(0)) this.mp.link.send({ t: 'visit.frame', sid: p.sid, data: text }, true);
    } else if (msg.t === 'visit.frame') {
      if (p.ws.readyState === p.ws.OPEN && p.ws.bufferedAmount < MP_HIGH_WATER) p.ws.send(msg.data);
    } else this.end(p, msg.reason || 'The visit ended');
    return true;
  }

  /** Tells the browser why, and hangs up. */
  private end(p: Pipe, reason: string) {
    this.pipes.delete(p.sid);
    this.dropHttp(p.sid);
    if (p.ws.readyState === p.ws.OPEN) {
      p.ws.send(JSON.stringify({ t: 'mp.ended', reason }));
      p.ws.close(VISIT_ENDED, 'Visit ended');
    }
    this.mp.updatePresence();
  }

  endAll(reason: string) {
    for (const p of [...this.pipes.values()]) this.end(p, reason);
  }

  // --- HTTP through the owner ---------------------------------------------------------------------

  /** Asks the owner of the open visit to `login` for a GET (`path` with its query); undefined when there is no such visit. */
  request(login: string, path: string): Promise<HttpAnswer> | undefined {
    const p = [...this.pipes.values()].find((x) => x.open && loginKey(x.login) === loginKey(login));
    if (!p) return undefined;
    const rid = randomBytes(9).toString('base64url');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.http.delete(rid);
        resolve({ status: 504, type: 'application/json', body: Buffer.from('{"error":"The other office took too long to answer"}') });
      }, HTTP_TIMEOUT_MS);
      this.http.set(rid, { sid: p.sid, resolve, timer });
      if (!this.mp.link.send({ t: 'visit.http', sid: p.sid, rid, path })) this.answer(rid, { status: 502, type: 'application/json', body: Buffer.from('{"error":"Not connected to the relay"}') });
    });
  }

  httpres(msg: Extract<RelayToOffice, { t: 'visit.httpres' }>) {
    if (this.http.get(msg.rid)?.sid !== msg.sid) return;
    // The body is the other office's word: decoded strictly and held to the size limit.
    const valid = msg.body.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(msg.body);
    const body = valid ? Buffer.from(msg.body, 'base64') : undefined;
    if (!body || body.length > MP_BODY_MAX) return this.answer(msg.rid, { status: 502, type: 'application/json', body: Buffer.from('{"error":"The other office sent something unreadable"}') });
    this.answer(msg.rid, { status: msg.status, type: msg.type, body });
  }

  private answer(rid: string, a: HttpAnswer) {
    const h = this.http.get(rid);
    if (!h) return;
    clearTimeout(h.timer);
    this.http.delete(rid);
    h.resolve(a);
  }

  private dropHttp(sid: string) {
    for (const [rid, h] of this.http) if (h.sid === sid) this.answer(rid, { status: 502, type: 'application/json', body: Buffer.from('{"error":"The visit ended"}') });
  }
}

/** A browser's own look and name for the visit, from the same query a normal connection reads. */
function profileOf(url: URL, session: Session): MpVisitProfile {
  const q = url.searchParams;
  const colorParam = q.get('color') ?? '';
  const intParam = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  const look = sanitizeLook({ skin: intParam('skin'), hair: intParam('hair'), style: intParam('style') }, lookFromSeed(url.search));
  return { name: session.account?.name ?? (str(q.get('name'), 24).trim() || 'Guest'), color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7', ...look };
}

/**
 * `/ws?visit=<login>`, after the session and same-origin checks: an admin whose office is online on
 * the relay gets a pipe to that player's office; anyone else is refused.
 */
export function mpVisitUpgrade(ctx: Ctx, wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Session) {
  const mp = mpOf(ctx);
  const login = url.searchParams.get('visit') ?? '';
  if (!mp?.link.online || !LOGIN_RE.test(login) || !ctx.meOf(session.account?.id).admin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => mp.guest.pipe(ws, login, profileOf(url, session)));
}
