// The office's outbound WebSocket to the relay: hello, the player list, presence, and the visit
// traffic (which the Multiplayer service routes). It reconnects with a growing pause while the
// office wants to be online, and stops for the failures that retrying cannot fix (a wrong password,
// a refused identity, another connection of the same login).
import WebSocket from 'ws';
import {
  MP_CLOSE,
  MP_FRAME_MAX,
  MP_TOO_LARGE,
  MP_HIGH_WATER,
  MP_MAX_PAYLOAD,
  MP_PATH,
  MP_PROTOCOL,
  parseRelayMsg,
  type MpWhere,
  type MpWirePlayer,
  type OfficeToRelay,
  type RelayToOffice,
} from '../../shared/multiplayer/wire.js';
import { Reassembler, splitFrame } from './chunks.js';
import type { MpConfigStore } from './config.js';

export type LinkStatus = 'off' | 'connecting' | 'online' | 'error';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The relay pings every 30 s; a link that has heard nothing for this long is dead. */
const SILENCE_MS = 100_000;

/**
 * The WebSocket URL for what someone typed: `https://host` → `wss://host/mp`, `wss://host` the
 * same, a bare `host` is taken as wss. Plain ws:// and http:// only for this machine, since the
 * relay password and the visit traffic would cross the network in the clear.
 */
export function normalizeRelayUrl(input: string): { url: string } | { error: string } {
  const typed = input.trim();
  if (!typed || typed.length > 300) return { error: 'Enter the relay\'s address' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `wss://${typed}`);
  } catch {
    return { error: 'That is not a web address' };
  }
  const scheme = { 'wss:': 'wss:', 'https:': 'wss:', 'ws:': 'ws:', 'http:': 'ws:' }[u.protocol];
  if (!scheme) return { error: 'The relay\'s address starts with https:// or wss://' };
  if (scheme === 'ws:' && !LOCAL_HOSTS.has(u.hostname)) return { error: 'Use https:// or wss:// — the relay\'s password must not travel in the clear' };
  if (u.username || u.password) return { error: 'Leave the password out of the address' };
  const pathname = u.pathname === '/' || u.pathname === '' ? MP_PATH : u.pathname;
  return { url: `${scheme}//${u.host}${pathname}` };
}

export interface LinkOptions {
  config: MpConfigStore;
  version: string;
  /** The status, error, login or player list changed. */
  onChange(): void;
  /** Anything the relay sent besides the welcome and the player list. */
  onMessage(msg: RelayToOffice): void;
  /** The link went down (or was closed): sessions riding on it are over. */
  onDown(): void;
}

export class Link {
  status: LinkStatus = 'off';
  error?: string;
  login?: string;
  players: MpWirePlayer[] = [];
  /** The relay's GitHub OAuth App client id, once it has told us (in welcome or need-identity). */
  clientId?: string;
  /** Connecting cannot go on until the person signs in to GitHub (no token, or the relay refused it). */
  needsIdentity = false;
  private ws?: WebSocket;
  private pieces = new Reassembler();
  private queued = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private lastHeard = 0;
  private backoff = BACKOFF_START_MS;
  private presence: { where: MpWhere; floorKey?: string } = { where: 'home' };

  constructor(private o: LinkOptions) {
    this.login = o.config.get().login;
  }

  get online(): boolean {
    return this.status === 'online' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Bytes queued on the whole connection (all visits and the control traffic together). */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Characters of `visit.frame` text queued for one visit and not yet written out. One link carries
   * every visitor we host and every visit we make, so congestion is judged per visit: one
   * visitor's big welcome must not make the others skip frames or end their visits.
   */
  queuedFor(sid: string): number {
    return this.queued.get(sid) ?? 0;
  }

  /** Starts (or restarts) connecting, if there is an address and a password. */
  connect() {
    this.stop();
    const { url, password } = this.o.config.get();
    if (!url || !password) return this.set('off');
    this.backoff = BACKOFF_START_MS;
    this.needsIdentity = false;
    this.open();
  }

  disconnect() {
    this.stop();
    this.players = [];
    this.set('off');
  }

  private stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.pieces.clear();
    if (ws) {
      ws.removeAllListeners('close');
      ws.on('error', () => {});
      ws.terminate();
      this.o.onDown();
    }
  }

  private set(status: LinkStatus, error?: string) {
    this.status = status;
    this.error = error;
    this.o.onChange();
  }

  private open() {
    const { url, password, identityToken } = this.o.config.get();
    this.set('connecting', this.error);
    const ws = new WebSocket(url, { maxPayload: MP_MAX_PAYLOAD, handshakeTimeout: 10_000 });
    this.ws = ws;
    this.lastHeard = Date.now();
    ws.on('open', () => {
      this.lastHeard = Date.now();
      this.send({ t: 'hello', password, ...(identityToken ? { identityToken } : {}), version: this.o.version, protocol: MP_PROTOCOL });
    });
    ws.on('ping', () => (this.lastHeard = Date.now()));
    ws.on('message', (data, isBinary) => {
      this.lastHeard = Date.now();
      if (isBinary) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseRelayMsg(raw);
      if (msg) this.receive(msg);
    });
    ws.on('error', () => {});
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.pieces.clear();
      clearInterval(this.watchdog);
      this.players = [];
      this.o.onDown();
      this.closed(code, reason.toString());
    });
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_MS) ws.terminate();
    }, 30_000);
    this.watchdog.unref();
  }

  private receive(msg: RelayToOffice) {
    switch (msg.t) {
      case 'welcome':
        this.login = msg.login;
        if (msg.githubClientId) this.clientId = msg.githubClientId;
        if (this.o.config.get().login !== msg.login) this.o.config.update({ login: msg.login });
        this.backoff = BACKOFF_START_MS;
        this.set('online');
        this.sendPresence();
        return;
      case 'need-identity':
        if (msg.githubClientId) this.clientId = msg.githubClientId;
        return; // the relay closes right after; closed() says what to show
      case 'players':
        this.players = msg.players;
        return this.o.onChange();
      case 'visit.frame': {
        if (!msg.part) return this.o.onMessage(msg);
        const got = this.pieces.push(msg.sid, msg.data, msg.part);
        if (!got) return;
        if ('error' in got) return this.abort(msg.sid, got.error);
        return this.o.onMessage({ t: 'visit.frame', sid: msg.sid, data: got.data });
      }
      case 'visit.close':
        this.pieces.drop(msg.sid);
        return this.o.onMessage(msg);
      default:
        return this.o.onMessage(msg);
    }
  }

  /** Whatever the close meant: a reason to stop and show, or a reason to try again. */
  private closed(code: number, reason: string) {
    const stopWith = (error: string, identity = false) => {
      this.needsIdentity = identity;
      this.set('error', error);
    };
    if (code === MP_CLOSE.password) return stopWith('Wrong relay password');
    if (code === MP_CLOSE.identity) return stopWith('The relay did not accept your GitHub sign-in: sign in again', true);
    if (code === MP_CLOSE.replaced) return stopWith('Another office signed in as the same GitHub user and took this connection');
    if (code === 1000 && !this.o.config.get().identityToken) return stopWith('Sign in to GitHub to connect', true);
    const wait = code === MP_CLOSE.rateLimited ? BACKOFF_MAX_MS : this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.set('connecting', reason || (this.error ?? 'The relay cannot be reached; trying again'));
    this.timer = setTimeout(() => this.open(), wait);
    this.timer.unref();
  }

  /** Sends one message. `droppable` ones are skipped while the link is backed up. Returns whether it was sent. */
  send(msg: OfficeToRelay, droppable = false): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (droppable && (msg.t === 'visit.frame' ? this.queuedFor(msg.sid) : ws.bufferedAmount) > MP_HIGH_WATER) return false;
    if (msg.t === 'visit.frame' && !msg.part && msg.data.length > MP_FRAME_MAX) {
      // Too big for one frame: it goes in pieces (which must all arrive, so none is droppable).
      const pieces = splitFrame(msg.data);
      if (!pieces) {
        this.abort(msg.sid, MP_TOO_LARGE);
        return false;
      }
      for (const piece of pieces) this.write(ws, msg.sid, JSON.stringify({ t: 'visit.frame', sid: msg.sid, ...piece }));
      return true;
    }
    this.write(ws, msg.t === 'visit.frame' ? msg.sid : undefined, JSON.stringify(msg));
    return true;
  }

  /** ws.send, counting a visit's bytes until the socket has taken them. */
  private write(ws: WebSocket, sid: string | undefined, text: string) {
    if (sid === undefined) return ws.send(text);
    this.queued.set(sid, this.queuedFor(sid) + text.length);
    ws.send(text, () => {
      const left = this.queuedFor(sid) - text.length;
      if (left > 0) this.queued.set(sid, left);
      else this.queued.delete(sid);
    });
  }

  /**
   * A message this office cannot relay (or receive): the visit ends with a reason on both sides, not
   * with a message that silently never arrives. Our own side is told after the current call returns.
   */
  private abort(sid: string, reason: string) {
    this.pieces.drop(sid);
    this.send({ t: 'visit.close', sid, reason });
    queueMicrotask(() => this.o.onMessage({ t: 'visit.close', sid, reason }));
  }

  /** Where this office's owner is now (see Multiplayer.updatePresence); kept for the next connection too. */
  setPresence(where: MpWhere, floorKey?: string) {
    const same = JSON.stringify(where) === JSON.stringify(this.presence.where) && floorKey === this.presence.floorKey;
    this.presence = { where, floorKey };
    if (!same) this.sendPresence();
  }

  private sendPresence() {
    const { where, floorKey } = this.presence;
    if (this.status === 'online') this.send({ t: 'presence', where, ...(floorKey && where === 'home' ? { floorKey } : {}) });
  }

  /**
   * Asks the relay for its GitHub client id with a throwaway connection that says hello without a
   * token (the relay answers `need-identity` with it and hangs up). Rejects with what went wrong.
   */
  fetchClientId(): Promise<string> {
    if (this.clientId) return Promise.resolve(this.clientId);
    const { url, password } = this.o.config.get();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: MP_MAX_PAYLOAD, handshakeTimeout: 10_000 });
      const fail = (why: string) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('The relay did not answer'), 12_000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', password, version: this.o.version, protocol: MP_PROTOCOL })));
      ws.on('message', (data) => {
        let msg: RelayToOffice | undefined;
        try {
          msg = parseRelayMsg(JSON.parse(data.toString()));
        } catch {
          msg = undefined;
        }
        if (msg?.t !== 'need-identity' && msg?.t !== 'welcome') return;
        clearTimeout(timer);
        ws.close();
        if (msg.githubClientId) resolve((this.clientId = msg.githubClientId));
        else reject(new Error('This relay has no GitHub client id set up, so offices cannot sign in to it'));
      });
      ws.on('close', (code) => fail(code === MP_CLOSE.password ? 'Wrong relay password' : 'The relay closed the connection'));
      ws.on('error', () => fail('The relay cannot be reached'));
    });
  }
}
