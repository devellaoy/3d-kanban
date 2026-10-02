// The multiplayer wire between an office and the relay (`kanban3d relay`): one JSON object per
// WebSocket text frame, `t` names the kind. The relay never sees a repository or floor name or a
// repo-scoped token: floors are opaque `floorKey`s the owner makes up, and identity is a GitHub
// login proved by a no-scope OAuth token the relay checks once and forgets.
//
// Everything that arrives over this wire is untrusted (the relay trusts offices no more than an
// office trusts the relay), so `parseOfficeMsg` / `parseRelayMsg` check every field before the
// rest of the code sees a message. No Node imports here: the browser-facing types use this file too.

/** Bump when a message changes shape. A visit needs both offices (and so the visit.open) on the same one. */
export const MP_PROTOCOL = 1;

/** The relay's WebSocket path. */
export const MP_PATH = '/mp';

/** One `visit.frame`'s `data` (a browser frame, as the text it was), in characters. */
export const MP_FRAME_MAX = 2 * 1024 * 1024;
/** What a `visit.httpres` body may weigh decoded; it travels base64 (MP_BODY_B64_MAX characters). */
export const MP_BODY_MAX = 8 * 1024 * 1024;
export const MP_BODY_B64_MAX = Math.ceil(MP_BODY_MAX / 3) * 4;
/** The biggest WebSocket message either side accepts: a full body plus its envelope. */
export const MP_MAX_PAYLOAD = MP_BODY_B64_MAX + 64 * 1024;
/** A receiver whose socket has this much queued gets no more frames (they are droppable, like cursors). */
export const MP_HIGH_WATER = 4 * 1024 * 1024;

/** WebSocket close codes the relay uses (4xxx is the application range). */
export const MP_CLOSE = {
  /** The password was wrong. */
  password: 4401,
  /** The identity token was bad (or GitHub could not be asked). */
  identity: 4403,
  /** A malformed or oversized message, or one before `hello`, or no `hello` in time. */
  protocol: 4400,
  /** Too many attempts from one address. */
  rateLimited: 4429,
  /** A newer connection of the same login replaced this one. */
  replaced: 4409,
  /** The relay is shutting down. */
  shutdown: 4503,
} as const;

// --- Shapes ---------------------------------------------------------------------------------------

export const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
/** A visit session id, made by the visitor's office. */
export const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A request id (probe, http), made by the asker. */
export const RID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The random per-floor string an owner chooses to show "I am on one of my shared floors" without a name. */
export const FLOOR_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const MP_LIMITS = { password: 256, token: 512, version: 64, reason: 300, name: 100, path: 2000, type: 200, floors: 64, players: 500 } as const;

/** Where a player is: in their own office, or visiting another's. */
export type MpWhere = 'home' | { visiting: string };

/** What the owner's office needs to draw the visitor: name, colour and look (see shared/avatar.ts). */
export interface MpVisitProfile {
  name: string;
  color: string;
  skin: number;
  hair: number;
  style: number;
}

/** One row of the relay's directory, sent to every connected office whenever it changes. */
export interface MpWirePlayer {
  /** GitHub login, in its own case (compare lowercased). */
  login: string;
  /** A display name the office gave itself in `hello`, when it did. */
  name?: string;
  online: true;
  where: MpWhere;
  /** The opaque key of the shared floor they are on, when they are on one. */
  floorKey?: string;
}

/** A floor an owner shows a probing visitor: only floors that visitor may enter. `key` is the owner's floorKey. */
export interface MpProbeFloor {
  key: string;
  name: string;
}

// --- Messages -------------------------------------------------------------------------------------

/**
 * Office → relay. The first message must be `hello`, within a few seconds; anything else before it
 * closes the socket with MP_CLOSE.protocol.
 */
export type OfficeToRelay =
  /**
   * `identityToken` is a GitHub OAuth token with no scopes (from the device flow). Without it, a
   * right password is answered with `need-identity` (so the office can run the device flow with the
   * relay's client id) and the socket is closed by the relay right after.
   */
  | { t: 'hello'; password: string; identityToken?: string; name?: string; version: string; protocol: number }
  /** Where this office's owner is now; `floorKey` only while `where` is 'home' and the floor is shared. */
  | { t: 'presence'; where: MpWhere; floorKey?: string }
  /** Ask to visit `to` (a login). The relay sets `from`; the owner answers visit.accept or visit.close. */
  | { t: 'visit.open'; sid: string; to: string; version: string; protocol: number; profile: MpVisitProfile }
  /** Owner → visitor, through the relay: come in. */
  | { t: 'visit.accept'; sid: string }
  /** Either party ends the session (or the owner refuses it), with a reason to show. */
  | { t: 'visit.close'; sid: string; reason: string }
  /** A browser frame, as text, to the other party. Droppable. */
  | { t: 'visit.frame'; sid: string; data: string }
  /** Visitor → owner: a read-only GET the visitor's browser wants (see the owner's allowlist). */
  | { t: 'visit.http'; sid: string; rid: string; path: string }
  /** Owner → visitor: the answer. `body` is base64. */
  | { t: 'visit.httpres'; sid: string; rid: string; status: number; type: string; body: string }
  /** Visitor → owner: which of your floors may I see? */
  | { t: 'probe'; rid: string; to: string }
  | { t: 'probe.res'; rid: string; floors: MpProbeFloor[] };

/** Relay → office. */
export type RelayToOffice =
  /** Hello was accepted. `githubClientId` lets the office run the device flow later. */
  | { t: 'welcome'; login: string; githubClientId?: string }
  /** The password was right but there was no identityToken (see hello); the relay closes the socket after this. */
  | { t: 'need-identity'; githubClientId?: string }
  | { t: 'players'; players: MpWirePlayer[] }
  /** `from` is the visitor's login, set by the relay from the authenticated connection. */
  | { t: 'visit.open'; sid: string; from: string; version: string; protocol: number; profile: MpVisitProfile }
  | { t: 'visit.accept'; sid: string }
  | { t: 'visit.close'; sid: string; reason: string }
  | { t: 'visit.frame'; sid: string; data: string }
  | { t: 'visit.http'; sid: string; rid: string; path: string }
  | { t: 'visit.httpres'; sid: string; rid: string; status: number; type: string; body: string }
  | { t: 'probe'; rid: string; from: string }
  | { t: 'probe.res'; rid: string; floors: MpProbeFloor[] };

// --- Validators -----------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0): string | undefined => (typeof v === 'string' && v.length >= min && v.length <= max ? v : undefined);
const matching = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** A login for use as a map key: GitHub logins are case-insensitive. */
export const loginKey = (login: string): string => login.toLowerCase();

export function parseWhere(v: unknown): MpWhere | undefined {
  if (v === 'home') return 'home';
  if (isObj(v) && Object.keys(v).length === 1) {
    const login = matching(v.visiting, LOGIN_RE);
    if (login) return { visiting: login };
  }
  return undefined;
}

export function parseProfile(v: unknown): MpVisitProfile | undefined {
  if (!isObj(v)) return undefined;
  const name = str(v.name, MP_LIMITS.name, 1);
  const color = str(v.color, 32, 1);
  const skin = int(v.skin, 0, 99);
  const hair = int(v.hair, 0, 99);
  const style = int(v.style, 0, 99);
  if (name === undefined || color === undefined || skin === undefined || hair === undefined || style === undefined) return undefined;
  return { name, color, skin, hair, style };
}

function parseFloors(v: unknown): MpProbeFloor[] | undefined {
  if (!Array.isArray(v) || v.length > MP_LIMITS.floors) return undefined;
  const out: MpProbeFloor[] = [];
  for (const f of v) {
    if (!isObj(f)) return undefined;
    const key = matching(f.key, FLOOR_KEY_RE);
    const name = str(f.name, MP_LIMITS.name, 1);
    if (key === undefined || name === undefined) return undefined;
    out.push({ key, name });
  }
  return out;
}

function parsePlayers(v: unknown): MpWirePlayer[] | undefined {
  if (!Array.isArray(v) || v.length > MP_LIMITS.players) return undefined;
  const out: MpWirePlayer[] = [];
  for (const p of v) {
    if (!isObj(p)) return undefined;
    const login = matching(p.login, LOGIN_RE);
    const where = parseWhere(p.where);
    if (login === undefined || !where) return undefined;
    const row: MpWirePlayer = { login, online: true, where };
    if (p.name !== undefined) {
      const name = str(p.name, MP_LIMITS.name);
      if (name === undefined) return undefined;
      row.name = name;
    }
    if (p.floorKey !== undefined) {
      const floorKey = matching(p.floorKey, FLOOR_KEY_RE);
      if (floorKey === undefined) return undefined;
      row.floorKey = floorKey;
    }
    out.push(row);
  }
  return out;
}

/**
 * The messages both directions share, with `from`/`to` swapped for the two ends. `side`: what the
 * message carries for that end ('office': the relay-bound form, 'relay': the office-bound form).
 */
function parseCommon(r: Obj, side: 'office' | 'relay'): OfficeToRelay | RelayToOffice | undefined {
  const sid = matching(r.sid, SID_RE);
  const rid = matching(r.rid, RID_RE);
  switch (r.t) {
    case 'visit.open': {
      const version = str(r.version, MP_LIMITS.version, 1);
      const protocol = int(r.protocol, 0, 1_000_000);
      const profile = parseProfile(r.profile);
      if (!sid || version === undefined || protocol === undefined || !profile) return undefined;
      if (side === 'office') {
        const to = matching(r.to, LOGIN_RE);
        return to ? { t: 'visit.open', sid, to, version, protocol, profile } : undefined;
      }
      const from = matching(r.from, LOGIN_RE);
      return from ? { t: 'visit.open', sid, from, version, protocol, profile } : undefined;
    }
    case 'visit.accept':
      return sid ? { t: 'visit.accept', sid } : undefined;
    case 'visit.close': {
      const reason = str(r.reason, MP_LIMITS.reason);
      return sid && reason !== undefined ? { t: 'visit.close', sid, reason } : undefined;
    }
    case 'visit.frame': {
      const data = str(r.data, MP_FRAME_MAX);
      return sid && data !== undefined ? { t: 'visit.frame', sid, data } : undefined;
    }
    case 'visit.http': {
      const path = str(r.path, MP_LIMITS.path, 1);
      return sid && rid && path !== undefined && path.startsWith('/') ? { t: 'visit.http', sid, rid, path } : undefined;
    }
    case 'visit.httpres': {
      const status = int(r.status, 100, 599);
      const type = str(r.type, MP_LIMITS.type);
      // The relay does not decode the body, so it checks only the size; the receiving office decodes it strictly.
      const body = str(r.body, MP_BODY_B64_MAX);
      return sid && rid && status !== undefined && type !== undefined && body !== undefined ? { t: 'visit.httpres', sid, rid, status, type, body } : undefined;
    }
    case 'probe': {
      if (!rid) return undefined;
      if (side === 'office') {
        const to = matching(r.to, LOGIN_RE);
        return to ? { t: 'probe', rid, to } : undefined;
      }
      const from = matching(r.from, LOGIN_RE);
      return from ? { t: 'probe', rid, from } : undefined;
    }
    case 'probe.res': {
      const floors = parseFloors(r.floors);
      return rid && floors ? { t: 'probe.res', rid, floors } : undefined;
    }
  }
  return undefined;
}

/** Checks a message an office sent the relay; undefined if it is not one, field by field. */
export function parseOfficeMsg(raw: unknown): OfficeToRelay | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.t) {
    case 'hello': {
      const password = str(raw.password, MP_LIMITS.password);
      const version = str(raw.version, MP_LIMITS.version, 1);
      const protocol = int(raw.protocol, 0, 1_000_000);
      if (password === undefined || version === undefined || protocol === undefined) return undefined;
      const msg: Extract<OfficeToRelay, { t: 'hello' }> = { t: 'hello', password, version, protocol };
      if (raw.identityToken !== undefined) {
        const token = str(raw.identityToken, MP_LIMITS.token, 1);
        if (token === undefined) return undefined;
        msg.identityToken = token;
      }
      if (raw.name !== undefined) {
        const name = str(raw.name, MP_LIMITS.name);
        if (name === undefined) return undefined;
        if (name) msg.name = name;
      }
      return msg;
    }
    case 'presence': {
      const where = parseWhere(raw.where);
      if (!where) return undefined;
      if (raw.floorKey === undefined) return { t: 'presence', where };
      const floorKey = matching(raw.floorKey, FLOOR_KEY_RE);
      // A floor key only means something at home.
      return floorKey && where === 'home' ? { t: 'presence', where, floorKey } : undefined;
    }
    case 'welcome':
    case 'need-identity':
    case 'players':
      return undefined; // relay → office only
  }
  return parseCommon(raw, 'office') as OfficeToRelay | undefined;
}

/** Checks a message the relay sent an office. */
export function parseRelayMsg(raw: unknown): RelayToOffice | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.t) {
    case 'welcome': {
      const login = matching(raw.login, LOGIN_RE);
      if (!login) return undefined;
      const id = raw.githubClientId === undefined ? undefined : str(raw.githubClientId, 100, 1);
      return id === undefined && raw.githubClientId !== undefined ? undefined : { t: 'welcome', login, ...(id ? { githubClientId: id } : {}) };
    }
    case 'need-identity': {
      const id = raw.githubClientId === undefined ? undefined : str(raw.githubClientId, 100, 1);
      return id === undefined && raw.githubClientId !== undefined ? undefined : { t: 'need-identity', ...(id ? { githubClientId: id } : {}) };
    }
    case 'players': {
      const players = parsePlayers(raw.players);
      return players ? { t: 'players', players } : undefined;
    }
    case 'hello':
    case 'presence':
      return undefined; // office → relay only
  }
  return parseCommon(raw, 'relay') as RelayToOffice | undefined;
}
