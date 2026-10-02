// What the office remembers about multiplayer: <dataDir>/multiplayer.json. It holds the relay's
// password and this office's GitHub identity token, so it is written for its owner only (0600) and
// never sent to a browser: they get `passwordSet` and the login, nothing more.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FLOOR_KEY_RE } from '../../shared/multiplayer/wire.js';

export interface MpConfig {
  /** Connect to the relay (and again after a restart). */
  enabled: boolean;
  url: string;
  password: string;
  /** A GitHub OAuth token with no scopes: it proves who this office is to the relay, nothing else. */
  identityToken: string;
  /** Who the relay last said this office is. */
  login?: string;
  /** Floor ids this office shows to visitors (off by default); each visitor still needs GitHub access to its repos. */
  sharedFloors: string[];
  /** floor id → the random key the relay's player list shows instead of the floor's name. */
  floorKeys: Record<string, string>;
}

const EMPTY: MpConfig = { enabled: false, url: '', password: '', identityToken: '', sharedFloors: [], floorKeys: {} };
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '');

export class MpConfigStore {
  private file: string;
  private cfg: MpConfig;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'multiplayer.json');
    this.cfg = this.load();
  }

  private load(): MpConfig {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const keys: Record<string, string> = {};
      if (raw.floorKeys && typeof raw.floorKeys === 'object') {
        for (const [id, key] of Object.entries(raw.floorKeys)) if (typeof key === 'string' && FLOOR_KEY_RE.test(key)) keys[id] = key;
      }
      const login = text(raw.login, 39);
      return {
        enabled: raw.enabled === true,
        url: text(raw.url, 300),
        password: text(raw.password, 200),
        identityToken: text(raw.identityToken, 512),
        ...(login ? { login } : {}),
        sharedFloors: Array.isArray(raw.sharedFloors) ? raw.sharedFloors.filter((f): f is string => typeof f === 'string').slice(0, 64) : [],
        floorKeys: keys,
      };
    } catch {
      return { ...EMPTY, sharedFloors: [], floorKeys: {} };
    }
  }

  get(): Readonly<MpConfig> {
    return this.cfg;
  }

  update(patch: Partial<MpConfig>) {
    this.cfg = { ...this.cfg, ...patch };
    if (!this.cfg.login) delete this.cfg.login;
    this.save();
  }

  /** The key a floor shows on the relay; made on first use and kept, so it stays the same between visits. */
  floorKey(floorId: string): string {
    let key = this.cfg.floorKeys[floorId];
    if (!key) {
      key = randomBytes(12).toString('base64url');
      this.update({ floorKeys: { ...this.cfg.floorKeys, [floorId]: key } });
    }
    return key;
  }

  /** Written next to the file and renamed over it, so a crash never leaves half a password behind. */
  private save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: multiplayer.json couldn't be saved: ${(err as Error).message}`);
    }
  }
}
