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
import { githubVerifier, TokenRejected, type IdentityVerifier } from './github-user.js';

export type LinkStatus = 'off' | 'connecting' | 'online' | 'error';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The longest pause while the relay could not check our GitHub sign-in (it is not our fault, so we keep trying). */
const IDENTITY_BACKOFF_MAX_MS = 60_000;
/** The least we wait after the relay could not ask GitHub, so a GitHub outage is not hammered. */
const UNAVAILABLE_MIN_MS = 5000;
/** A wake-up check that comes this much later than planned means the computer slept. */
const SLEEP_SLACK_MS = 15_000;
/** The relay pings every 30 s; a link that has heard nothing for this long is dead. */
const SILENCE_MS = 100_000;
/** After a wake from sleep an open socket gets this long to answer a ping before it is dropped. */
const WAKE_PROBE_MS = 5000;
/** This many 4403s in a row that GitHub contradicts mean the relay is at fault, not the token. */
const CONTRADICTED_MAX = 10;

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
  /** Asks GitHub whether our token is still good, after the relay refused it. Tests inject one. */
  verifier?: IdentityVerifier;
  /** The clock; tests move it to pretend the computer slept. */
  now?: () => number;
  /** How often to look for a wake from sleep and for a silent socket. */
  wakeTickMs?: number;
  /** The first pause before retrying (tests make it short). */
  backoffStartMs?: number;
  /** The longest pause while the relay could not check our GitHub sign-in (tests make it short). */
  identityBackoffMaxMs?: number;
  /** The least pause after the relay could not ask GitHub (close 4504). */
  unavailableMinMs?: number;
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
  /** One interval for as long as the link wants to be connected: spots a wake from sleep and a silent socket. */
  private tick?: NodeJS.Timeout;
  private lastTick = 0;
  /** Bumped by open and disconnect (connect goes through one of them), so a GitHub check that finishes late does nothing. */
  private generation = 0;
  /** Consecutive 4403s that GitHub contradicted. */
  private contradicted = 0;
  private lastLoggedCode?: number;
  private verifier: IdentityVerifier;
  private lastHeard = 0;
  private backoff: number;
  private presence: { where: MpWhere; floorKey?: string } = { where: 'home' };

  constructor(private o: LinkOptions) {
    this.login = o.config.get().login;
    this.verifier = o.verifier ?? githubVerifier();
    this.backoff = this.backoffStart;
  }

  private get backoffStart(): number {
    return this.o.backoffStartMs ?? BACKOFF_START_MS;
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
    if (!url || !password) {
      this.generation++; // a GitHub check still running must not act on a link that is off
      this.stopTick();
      return this.set('off');
    }
    this.backoff = this.backoffStart;
    this.contradicted = 0;
    this.needsIdentity = false;
    this.startTick();
    this.open();
  }

  disconnect() {
    this.generation++;
    this.stop();
    this.stopTick();
    this.players = [];
    this.set('off');
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private stopTick() {
    clearInterval(this.tick);
    this.tick = undefined;
  }

  /**
   * Timers stop while a computer sleeps, so on wake the socket may be dead and the pause before the
   * next try may be long. A tick that comes much later than planned means that happened: a waiting
   * link tries again now, and an open socket gets a ping and a few seconds to answer it. The same
   * tick drops a socket that has been silent too long.
   */
  private startTick() {
    const every = this.o.wakeTickMs ?? 5000;
    this.stopTick();
    this.lastTick = this.now();
    this.tick = setInterval(() => {
      const t = this.now();
      const slept = t - this.lastTick > every + SLEEP_SLACK_MS;
      this.lastTick = t;
      const ws = this.ws;
      if (slept && (this.status === 'connecting' || this.status === 'online')) {
        this.backoff = this.backoffStart;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
          this.lastHeard = t - SILENCE_MS + WAKE_PROBE_MS;
        } else if (ws) {
          ws.terminate(); // still handshaking: the close handler tries again after the short pause
        } else if (this.timer) {
          clearTimeout(this.timer);
          this.timer = undefined;
          this.open();
        }
        return;
      }
      if (ws && t - this.lastHeard > SILENCE_MS) ws.terminate();
    }, every);
    this.tick.unref();
  }

  private stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
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
    // A GitHub check still running for an earlier attempt must not act on this one.
    this.generation++;
    const { url, password, identityToken } = this.o.config.get();
    this.set('connecting', this.error);
    const ws = new WebSocket(url, { maxPayload: MP_MAX_PAYLOAD, handshakeTimeout: 10_000 });
    this.ws = ws;
    this.lastHeard = this.now();
    ws.on('open', () => {
      this.lastHeard = this.now();
      this.send({ t: 'hello', password, ...(identityToken ? { identityToken } : {}), version: this.o.version, protocol: MP_PROTOCOL });
    });
    ws.on('ping', () => (this.lastHeard = this.now()));
    ws.on('pong', () => (this.lastHeard = this.now()));
    ws.on('message', (data, isBinary) => {
      this.lastHeard = this.now();
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
      this.players = [];
      this.o.onDown();
      this.closed(code, reason.toString());
    });
  }

  private receive(msg: RelayToOffice) {
    switch (msg.t) {
      case 'welcome':
        this.login = msg.login;
        if (msg.githubClientId) this.clientId = msg.githubClientId;
        if (this.o.config.get().login !== msg.login) this.o.config.update({ login: msg.login });
        this.backoff = this.backoffStart;
        this.contradicted = 0;
        this.lastLoggedCode = undefined;
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
  private closed(code: number, rawReason: string) {
    // The reason comes from the network: no control characters in the log or on screen.
    const reason = rawReason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
    if (code !== this.lastLoggedCode) {
      this.lastLoggedCode = code;
      console.warn(`agent-office: multiplayer link closed ${code}${reason ? ` ${reason}` : ''}`);
    }
    const stopWith = (error: string, identity = false) => {
      this.needsIdentity = identity;
      this.set('error', error);
    };
    if (code === MP_CLOSE.password) return stopWith('Wrong relay password');
    if (code === MP_CLOSE.replaced) return stopWith('Another office signed in as the same GitHub user and took this connection');
    if (code === 1000 && !this.o.config.get().identityToken) return stopWith('Sign in to GitHub to connect', true);
    if (code === MP_CLOSE.identity) return void this.checkToken();
    if (code === MP_CLOSE.identityUnavailable) return this.retry('GitHub could not be reached; trying again', { floor: this.o.unavailableMinMs ?? UNAVAILABLE_MIN_MS });
    this.retry(reason || (this.error ?? 'The relay cannot be reached; trying again'), code === MP_CLOSE.rateLimited ? { floor: BACKOFF_MAX_MS } : {});
  }

  /** Shows why we are waiting, grows the pause (never below `floor`, never above `cap`) and opens again after it. */
  private retry(why: string, { floor = 0, cap = BACKOFF_MAX_MS }: { floor?: number; cap?: number } = {}) {
    const wait = Math.max(floor, Math.min(this.backoff, cap));
    this.backoff = Math.min(cap, this.backoff * 2);
    this.set('connecting', why);
    this.timer = setTimeout(() => {
      // Fired: nothing is pending any more, so a wake from sleep must not open a second connection.
      this.timer = undefined;
      this.open();
    }, wait);
    this.timer.unref();
  }

  /**
   * The relay refused our token. Only GitHub can say whether it really is bad (older relays also
   * refuse when they merely could not reach GitHub), so ask it ourselves before sending the person
   * to sign in again. If GitHub keeps contradicting the relay, the relay is at fault: stop and say so.
   */
  private async checkToken() {
    const token = this.o.config.get().identityToken;
    if (!token) return this.signInAgain();
    const gen = this.generation;
    this.set('connecting', 'Checking your GitHub sign-in…');
    let rejected = false;
    try {
      await this.verifier.login(token);
    } catch (e) {
      rejected = e instanceof TokenRejected;
    }
    if (gen !== this.generation) return;
    if (rejected) return this.signInAgain();
    if (++this.contradicted >= CONTRADICTED_MAX) {
      this.needsIdentity = false;
      return this.set('error', 'The relay keeps refusing your GitHub sign-in although GitHub accepts it; check the relay');
    }
    this.retry('The relay could not check your GitHub sign-in; trying again', { cap: this.o.identityBackoffMaxMs ?? IDENTITY_BACKOFF_MAX_MS });
  }

  private signInAgain() {
    this.needsIdentity = true;
    this.set('error', 'The relay did not accept your GitHub sign-in: sign in again');
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
