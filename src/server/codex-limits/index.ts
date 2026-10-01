// The Codex limits of the office: one reader per Codex home (CODEX_HOME), the browsers watching
// each, and the lookup the kanban makes when a Codex run hits a usage limit. Made the first time
// it's needed, so an office nobody asks anything of never looks for `codex`.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '../office/client.js';
import type { Ctx } from '../office/context.js';
import { codexHome } from '../providers/codex.js';
import { resolveCommand } from '../workers.js';
import { childEnv } from '../workers/env.js';
import type { CodexLimits } from '../../shared/codex-limits/protocol.js';
import { CodexLimitsReader, pickReset, type Ask } from './reader.js';

/** A reader nobody watched or asked for this long is dropped. */
const IDLE_MS = 30 * 60_000;
/** A missing `codex` is looked for again at most this often. */
const LOOK_AGAIN_MS = 10 * 60_000;
/** The kanban reads the numbers afresh, and waits at most this long for them. */
const KANBAN_WAIT_MS = 5_000;

/** The same home spelled two ways (a symlink, a relative path) is one. */
export function normaliseHome(home: string): string {
  const resolved = path.resolve(home);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

let office: string | undefined;
/** The office's own Codex home (its environment doesn't change while it runs). */
const officeHome = () => (office ??= normaliseHome(codexHome(process.cwd(), childEnv())));

/** The Codex home a browser's numbers are those of: today the office's own, as Codex workers get it. */
export function codexHomeOf(_ctx: Ctx, _client: Client): string {
  return officeHome();
}

/** Stand-ins, for tests. */
export interface CodexLimitsDeps {
  ask?: Ask;
  codexPath?: () => string | null;
  /** Which home a client watches. */
  homeOf?: (c: Client) => string;
}

// Several homes and a per-client `watching` map, though every client has the office's home today: the kanban's
// resetAt names the home of the worker that hit a limit, and codexHomeOf will scope per account or floor with
// upstream #199 (that is also why a reader nobody uses for IDLE_MS is dropped).
export class CodexLimitsRegistry {
  private readers = new Map<string, CodexLimitsReader>();
  /** Which home each watching browser (client id) has in view. */
  private watching = new Map<string, string>();
  private command: { path: string | null; at: number } | undefined;

  constructor(
    private ctx: Ctx,
    private deps: CodexLimitsDeps = {},
  ) {}

  /** `codex`, looked for on first need; a miss is looked for again after a while. */
  private codex(): string | null {
    const now = Date.now();
    if (!this.command || (this.command.path === null && now - this.command.at >= LOOK_AGAIN_MS)) this.command = { path: resolveCommand('codex'), at: now };
    return this.command.path;
  }

  private readerFor(home: string): CodexLimitsReader {
    for (const [key, r] of this.readers) {
      if (r.watching === 0 && Date.now() - r.lastUse >= IDLE_MS) {
        r.close();
        this.readers.delete(key);
      }
    }
    let r = this.readers.get(home);
    if (!r) {
      r = new CodexLimitsReader({
        codexPath: () => (this.deps.codexPath ? this.deps.codexPath() : this.codex()),
        ...(this.deps.ask ? { ask: this.deps.ask } : {}),
        env: { ...childEnv(), CODEX_HOME: home },
        onChange: (state) => this.changed(home, state),
        onMissing: () => (this.command = { path: null, at: Date.now() }),
      });
      this.readers.set(home, r);
    }
    return r;
  }

  private changed(home: string, state: CodexLimits) {
    for (const [id, h] of [...this.watching]) {
      if (h !== home) continue;
      const c = this.ctx.clients.get(id);
      if (!c || c.out) this.unwatchId(id);
      else this.ctx.sendTo(c, { t: 'codex-limits', state });
    }
  }

  /** `c` has the limits in view: it's sent what is known at once, and told of every change. */
  watch(c: Client) {
    if (c.out) return;
    const home = this.deps.homeOf ? normaliseHome(this.deps.homeOf(c)) : codexHomeOf(this.ctx, c);
    if (this.watching.get(c.id) !== home) this.unwatchId(c.id);
    this.watching.set(c.id, home);
    const reader = this.readerFor(home);
    this.ctx.sendTo(c, { t: 'codex-limits', state: reader.state });
    reader.watch(c.id);
  }

  unwatchId(id: string) {
    const home = this.watching.get(id);
    if (home === undefined) return;
    this.watching.delete(id);
    this.readers.get(home)?.unwatch(id);
  }

  /** A watcher asks for a fresh read. */
  refresh(c: Client) {
    const home = this.watching.get(c.id);
    if (home !== undefined && !c.out) void this.readers.get(home)?.refresh();
  }

  /** When the limit a Codex run on `home` (the office's, when not given) hit starts over; undefined when unknown. */
  async resetAt(home?: string): Promise<number | undefined> {
    const state = await this.readerFor(home ? normaliseHome(home) : officeHome()).fresh(KANBAN_WAIT_MS);
    return state ? pickReset(state) : undefined;
  }

  close() {
    for (const r of this.readers.values()) r.close();
    this.readers.clear();
    this.watching.clear();
  }
}

const registries = new WeakMap<Ctx, CodexLimitsRegistry>();

export function codexLimitsOf(ctx: Ctx, deps?: CodexLimitsDeps): CodexLimitsRegistry {
  let r = registries.get(ctx);
  if (!r) registries.set(ctx, (r = new CodexLimitsRegistry(ctx, deps)));
  return r;
}

/** `c` left (or was signed out): it watches no more. Makes nothing if nobody ever watched. */
export function unwatchCodexLimits(ctx: Ctx, clientId: string) {
  registries.get(ctx)?.unwatchId(clientId);
}

/** An account's clients stop watching (its account was revoked). */
export function unwatchAccountCodexLimits(ctx: Ctx, accountId: string) {
  for (const c of ctx.clients.values()) if (c.accountId === accountId) unwatchCodexLimits(ctx, c.id);
}

export function closeCodexLimits(ctx: Ctx) {
  registries.get(ctx)?.close();
  registries.delete(ctx);
}
