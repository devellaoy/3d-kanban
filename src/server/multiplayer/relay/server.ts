// The relay: the meeting point for offices (`kanban3d relay`). Offices connect outbound over a
// WebSocket on /mp, prove the shared password and who they are, and then see each other in a
// directory and pass visit traffic to one another through here. The relay holds no repository or
// floor names and no repo-scoped tokens; what it forwards (visit frames) it can see, but never
// interprets.
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  LOGIN_RE,
  MP_CLOSE,
  MP_MAX_PAYLOAD,
  MP_PATH,
  parseOfficeMsg,
  type OfficeToRelay,
} from '../../../shared/multiplayer/wire.js';
import { clientIp } from '../../http/util.js';
import { Directory, Peer } from './directory.js';
import { githubVerifier, type IdentityVerifier } from './github.js';
import { Sessions } from './sessions.js';

export interface RelayOptions {
  port: number;
  host: string;
  password: string;
  /** Offices use it to run GitHub's device flow; sent in `welcome` and `need-identity`. */
  githubClientId?: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  verifier?: IdentityVerifier;
  /** Read the client address from X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean;
  log?: (line: string) => void;
  /** Tuning knobs, for tests. */
  heartbeatMs?: number;
  helloTimeoutMs?: number;
}

export interface RunningRelay {
  port: number;
  close(): Promise<void>;
}

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 5 * 60_000;

/** Counts password attempts per address, like Auth.allowAttempt. */
class Attempts {
  private by = new Map<string, { count: number; resetAt: number }>();
  allow(ip: string): boolean {
    const now = Date.now();
    if (this.by.size > 10_000) for (const [k, v] of this.by) if (v.resetAt < now) this.by.delete(k);
    const rec = this.by.get(ip);
    if (!rec || rec.resetAt < now) {
      this.by.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return true;
    }
    return ++rec.count <= MAX_ATTEMPTS;
  }
  success(ip: string) {
    this.by.delete(ip);
  }
}

interface Conn {
  ws: WebSocket;
  ip: string;
  peer?: Peer;
  alive: boolean;
}

export function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  const log = opts.log ?? (() => {});
  const verifier = opts.verifier ?? githubVerifier();
  const salt = randomBytes(16);
  const verifierHash = scryptSync(opts.password, salt, 32);
  const checkPassword = (candidate: string) =>
    new Promise<boolean>((resolve) => scrypt(candidate, salt, 32, (err, derived) => resolve(!err && timingSafeEqual(derived, verifierHash))));
  const attempts = new Attempts();
  const directory = new Directory();
  const sessions = new Sessions(directory);
  const conns = new Set<Conn>();

  const handler: http.RequestListener = (req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, offices: directory.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  };
  const server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ server, path: MP_PATH, maxPayload: MP_MAX_PAYLOAD });

  // The player list is rebroadcast shortly after the last change, so a burst of presence updates is one message.
  let pending: NodeJS.Timeout | undefined;
  const broadcastPlayers = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const msg = { t: 'players' as const, players: directory.list() };
      for (const p of directory.all()) p.send(msg, true);
    }, 20);
  };

  /** Hello: the password, then who they are. Resolves to the peer, or closes the socket. */
  async function hello(conn: Conn, msg: Extract<OfficeToRelay, { t: 'hello' }>): Promise<Peer | undefined> {
    const { ws } = conn;
    if (!attempts.allow(conn.ip)) return void ws.close(MP_CLOSE.rateLimited, 'Too many attempts');
    if (!(await checkPassword(msg.password))) return void ws.close(MP_CLOSE.password, 'Wrong password');
    if (!msg.identityToken) {
      // Password right, no identity yet: the office needs the client id to run the device flow. The
      // socket closes after this (normally, not as an error): the office reconnects once it has a token.
      attempts.success(conn.ip);
      ws.send(JSON.stringify({ t: 'need-identity', ...(opts.githubClientId ? { githubClientId: opts.githubClientId } : {}) }));
      ws.close(1000, 'Identity needed');
      return undefined;
    }
    let login: string;
    try {
      login = await verifier.login(msg.identityToken);
    } catch (err) {
      log(`identity refused for ${conn.ip}: ${(err as Error).message}`);
      return void ws.close(MP_CLOSE.identity, 'GitHub did not accept the token');
    }
    // The token is not kept anywhere past this point.
    if (!LOGIN_RE.test(login)) return void ws.close(MP_CLOSE.identity, 'Unusable GitHub login');
    if (ws.readyState !== ws.OPEN) return undefined;
    attempts.success(conn.ip);
    const peer = new Peer(login, msg.name, ws);
    const old = directory.add(peer);
    if (old) {
      // One connection per login: the newer one wins.
      old.dead = true;
      sessions.dropPeer(old);
      old.ws.close(MP_CLOSE.replaced, 'Replaced by a newer connection');
    }
    peer.send({ t: 'welcome', login: peer.login, ...(opts.githubClientId ? { githubClientId: opts.githubClientId } : {}) });
    log(`${peer.login} connected (${directory.size} online)`);
    broadcastPlayers();
    return peer;
  }

  function route(peer: Peer, msg: OfficeToRelay) {
    switch (msg.t) {
      case 'presence':
        if (JSON.stringify([peer.where, peer.floorKey]) === JSON.stringify([msg.where, msg.floorKey])) return;
        peer.where = msg.where;
        peer.floorKey = msg.floorKey;
        return broadcastPlayers();
      case 'visit.open':
        return sessions.open(peer, msg);
      case 'visit.accept':
        return sessions.accept(peer, msg);
      case 'visit.close':
        return sessions.close(peer, msg);
      case 'visit.frame':
        return void sessions.frame(peer, msg);
      case 'visit.http':
        return sessions.http(peer, msg);
      case 'visit.httpres':
        return sessions.httpres(peer, msg);
      case 'probe':
        return sessions.probe(peer, msg);
      case 'probe.res':
        return sessions.probeRes(peer, msg);
      case 'hello':
        return; // already in
    }
  }

  async function onMessage(conn: Conn, data: RawData, isBinary: boolean) {
    if (isBinary) return void conn.ws.close(MP_CLOSE.protocol, 'Text frames only');
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      raw = undefined;
    }
    const msg = parseOfficeMsg(raw);
    if (!conn.peer) {
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      if (msg?.t !== 'hello') return void conn.ws.close(MP_CLOSE.protocol, 'Say hello first');
      conn.peer = await hello(conn, msg);
      return;
    }
    // An invalid message (including a frame or body over its limit) is dropped; the link carries on.
    if (!msg) return void log(`${conn.peer.login}: dropped an invalid message`);
    if (!conn.peer.dead) route(conn.peer, msg);
  }

  wss.on('connection', (ws, req) => {
    const conn: Conn = { ws, ip: clientIp(req, !!opts.trustProxy), alive: true };
    conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.peer && ws.readyState === ws.OPEN) ws.close(MP_CLOSE.protocol, 'No hello');
    }, opts.helloTimeoutMs ?? 10_000);
    ws.on('pong', () => (conn.alive = true));
    // One message at a time per link, so a hello (which waits on scrypt and GitHub) is done before what follows it.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      chain = chain.then(() => onMessage(conn, data, isBinary)).catch((err) => {
        log(`link error: ${(err as Error).message}`);
        ws.terminate();
      });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimer);
      conns.delete(conn);
      const peer = conn.peer;
      if (!peer) return;
      peer.dead = true;
      sessions.dropPeer(peer);
      if (directory.remove(peer)) {
        log(`${peer.login} left (${directory.size} online)`);
        broadcastPlayers();
      }
    });
  });

  // Heartbeat: a link that did not answer the last ping is dead; the visits it was in end.
  const beat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
    sessions.sweep();
  }, opts.heartbeatMs ?? 30_000);
  beat.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(beat);
            if (pending) clearTimeout(pending);
            for (const c of conns) c.ws.close(MP_CLOSE.shutdown, 'Relay shutting down');
            wss.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
