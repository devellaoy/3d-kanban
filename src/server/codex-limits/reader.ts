// The Codex sign-in's 5-hour and weekly allowance, read through Codex's own local app-server
// (`codex app-server`, JSON-RPC `account/rateLimits/read`). Codex deals with the sign-in itself:
// this never opens or forwards its credential files, and only the normalised numbers leave here.
// Reader and normaliser adapted from upstream AgentSystemLabs/agent-office#232 (unmerged), reworked:
// it reads only while someone watches, per CODEX_HOME, and labels windows by their length.
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { CodexLimits } from '../../shared/codex-limits/protocol.js';
import type { PlanWindow } from '../../shared/protocol.js';

const POLL_MS = 2 * 60_000;
/** A click reads again, at most this often. */
const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 1024 * 1024;
/** Not signed in with a ChatGPT plan (signed out, an API key): look again much later. */
const NO_PLAN_MS = 30 * 60_000;
/** After this many failed reads in a row (no network, a `codex` too old to answer), wait longer. */
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;
const LABEL_MAX = 24;

/** What asking the app-server came to: its answer to `account/rateLimits/read`, and how Codex is signed in. */
export interface Answer {
  result?: unknown;
  /** `account/updated`'s authMode: a string, null when signed out, undefined when it never said. */
  auth?: string | null;
  error?: string;
}

export type Ask = (codex: string, env: Record<string, string>, signal?: AbortSignal) => Promise<Answer>;

export interface ReaderOptions {
  /** The `codex` binary, or null when it isn't installed (nothing is then ever spawned). */
  codexPath: () => string | null;
  /** Environment for it: the office's own, with this reader's CODEX_HOME. */
  env: Record<string, string>;
  /** The state changed: tell the watchers. */
  onChange: (state: CodexLimits) => void;
  ask?: Ask;
  now?: () => number;
  /** `codex` couldn't be started (it was removed since it was found). */
  onMissing?: () => void;
}

/** An error that says Codex isn't signed in (not just any mention of auth: a refresh that failed on the network is no sign-out). */
const SIGNED_OUT_ERROR = /not (?:signed|logged) in|unauthori[sz]ed|\b401\b/i;
const PLAN_AUTH = new Set(['chatgpt', 'chatgptAuthTokens']);

/** "5-hour", "Weekly", else the window's length as "6h" / "2d" / "45m". */
function windowLabel(mins: number | null): string {
  if (mins === 300) return '5-hour';
  if (mins === 10_080) return 'Weekly';
  if (mins === null) return 'Limit';
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function toWindow(w: unknown): (PlanWindow & { mins: number | null }) | undefined {
  const o = w && typeof w === 'object' ? (w as Record<string, unknown>) : undefined;
  if (typeof o?.usedPercent !== 'number' || !Number.isFinite(o.usedPercent)) return undefined;
  const mins = typeof o.windowDurationMins === 'number' && Number.isFinite(o.windowDurationMins) && o.windowDurationMins > 0 ? Math.round(o.windowDurationMins) : null;
  const resetsAt = typeof o.resetsAt === 'number' && Number.isFinite(o.resetsAt) && o.resetsAt > 0 ? o.resetsAt * 1000 : undefined;
  return { label: windowLabel(mins), pct: Math.max(0, Math.min(100, o.usedPercent)), ...(resetsAt ? { resetsAt } : {}), mins };
}

/**
 * Codex's answer as display-only numbers. The windows are labelled by their length, never by
 * primary/secondary (a Pro plan has the week alone as `primary`), shortest first. Nothing else of the
 * answer (account id, credits…) is kept. `auth` is how Codex says it is signed in, when it said.
 */
export function codexPlanLimits(answer: unknown, auth: string | null | undefined, now: number): CodexLimits {
  const base = { windows: [], at: 0, checkedAt: now };
  if (auth === null || (auth !== undefined && !PLAN_AUTH.has(auth))) return { status: 'signedOut', ...base };
  const a = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const byId = a.rateLimitsByLimitId && typeof a.rateLimitsByLimitId === 'object' ? (a.rateLimitsByLimitId as Record<string, unknown>) : undefined;
  const snap = [byId?.codex, a.rateLimits].find((s) => s && typeof s === 'object') as Record<string, unknown> | undefined;
  const found = [toWindow(snap?.primary), toWindow(snap?.secondary)].filter((w) => w !== undefined);
  const windows = found.sort((x, y) => (x.mins ?? Infinity) - (y.mins ?? Infinity)).map(({ mins: _mins, ...w }) => w);
  if (!windows.length) return { status: 'error', ...base };
  const planType = [snap?.planType, a.planType].find((p) => typeof p === 'string' && p) as string | undefined;
  const reached = snap?.rateLimitReachedType != null || windows.some((w) => w.pct >= 100);
  return { status: 'ready', ...(planType ? { plan: planType.slice(0, LABEL_MAX) } : {}), windows, at: now, checkedAt: now, ...(reached ? { reached: true } : {}) };
}

/**
 * When the limit that stopped Codex starts over (ms since epoch): the latest reset among the
 * windows at 100% (Codex stays blocked until every exhausted window has reset). It doesn't say which
 * window it reached: with none at 100% but the limit reported as reached (the percentages lag), the
 * fullest window's reset; otherwise it's unknown.
 */
export function pickReset(state: CodexLimits): number | undefined {
  if (state.status !== 'ready') return undefined;
  const withReset = state.windows.filter((w) => w.resetsAt !== undefined);
  const full = withReset.filter((w) => w.pct >= 100);
  if (full.length) return Math.max(...full.map((w) => w.resetsAt!));
  // Codex says the limit is reached but the percentages lag: the fullest window is the one.
  if (!state.reached || !withReset.length) return undefined;
  return withReset.reduce((a, w) => (w.pct > a.pct ? w : a)).resetsAt;
}

/** Kills the app-server and anything it started: its whole process group, or on Windows its tree. */
function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') return void spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Starts `codex app-server`, asks for the rate limits and stops it again. Never rejects. */
export function askAppServer(codex: string, env: Record<string, string>, signal?: AbortSignal, limits: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let total = 0;
    let initialized = false;
    let auth: string | null | undefined;
    const child = spawn(codex, ['app-server', '--listen', 'stdio://'], {
      cwd: os.tmpdir(),
      env,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(codex),
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32', // its own process group, so the fallback kill reaches whatever it started
    });
    const finish = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
      // The app-server exits when its stdin closes; the kill is only for one that doesn't.
      child.stdin.end();
      const kill = setTimeout(() => killTree(child), 2000);
      kill.unref();
      child.once('close', () => clearTimeout(kill));
    };
    const onAbort = () => finish({ error: 'stopped' });
    const timer = setTimeout(() => finish({ error: 'timed out' }), limits.timeoutMs ?? TIMEOUT_MS);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      total += Buffer.byteLength(chunk);
      if (total > (limits.maxBytes ?? MAX_OUTPUT)) return finish({ error: 'too much output' });
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: { id?: number; method?: string; params?: { authMode?: string | null }; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === 'account/updated') auth = msg.params?.authMode ?? null;
        else if (msg.id === 1) {
          if (msg.error || initialized) return finish({ error: msg.error?.message ?? 'bad answer' });
          initialized = true;
          child.stdin.write('{"method":"initialized","params":{}}\n');
          child.stdin.write('{"method":"account/rateLimits/read","id":2}\n');
        } else if (msg.id === 2) {
          finish(msg.error ? { error: msg.error.message ?? 'failed', auth } : { result: msg.result, auth });
        }
      }
    });
    child.once('error', (e) => finish({ error: e.message }));
    child.once('close', () => finish({ error: 'exited' }));
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'agent-office', title: 'Agent Office', version: '0.1.0' } } })}\n`);
  });
}

/** The allowance of one Codex home. It reads only while someone watches (or the kanban asks), and shares each read. */
export class CodexLimitsReader {
  private limits: CodexLimits = { status: 'off', windows: [], at: 0, checkedAt: 0 };
  private watchers = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private lastRead = 0;
  private startedAt = 0;
  /** How long after the last read the next automatic one is due (what that read came to decides). */
  private wait = 0;
  private fails = 0;
  private closed = false;
  private touched: number;
  private ask: Ask;
  private now: () => number;

  constructor(private opts: ReaderOptions) {
    this.ask = opts.ask ?? askAppServer;
    this.now = opts.now ?? Date.now;
    this.touched = this.now();
  }

  get state(): CodexLimits {
    return this.limits;
  }

  get watching(): number {
    return this.watchers.size;
  }

  /** When someone last watched, asked or a read finished (ms): a reader nobody uses can be dropped. */
  get lastUse(): number {
    return this.watchers.size ? this.now() : this.touched;
  }

  /** `id` has the numbers in view: they get read now only if the last read is older than the poll, then every poll. */
  watch(id: string) {
    if (this.closed) return;
    this.watchers.add(id);
    this.touched = this.now();
    this.schedule();
  }

  unwatch(id: string) {
    this.watchers.delete(id);
    this.touched = this.now();
    if (!this.watchers.size) this.stopTimer();
  }

  /** Reads now, unless a read is running (shared) or one just finished. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    if (this.now() - this.lastRead < MIN_GAP_MS) return Promise.resolve();
    return this.read();
  }

  /**
   * Numbers read after this call, whatever the age of the cache or the gap since the last read (a
   * run that just hit its limit must see the limit): a read already under way when it's called
   * doesn't count, so another follows it. Undefined if that takes longer than `waitMs`.
   */
  async fresh(waitMs: number): Promise<CodexLimits | undefined> {
    if (this.closed) return undefined;
    const asked = this.now();
    this.touched = asked;
    let over = false; // the wait ran out: no further read is started
    const done = async () => {
      while (!this.closed && !over) {
        if (!this.running) return void (await this.read());
        const started = this.startedAt;
        await this.running;
        if (started >= asked) return;
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((res) => {
      timer = setTimeout(() => ((over = true), res()), waitMs);
      timer.unref();
    });
    const ok = await Promise.race([done().then(() => true), gaveUp.then(() => false)]);
    clearTimeout(timer);
    return ok && !this.closed ? this.limits : undefined;
  }

  close() {
    this.closed = true;
    this.stopTimer();
    this.abort?.abort();
  }

  private stopTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Arms the next automatic read (only while watched), or reads at once when it's due. */
  private schedule() {
    if (this.closed || !this.watchers.size || this.running) return;
    this.stopTimer();
    const due = Math.max(0, this.lastRead + this.wait - this.now());
    this.timer = setTimeout(() => void this.read(), due);
    this.timer.unref();
  }

  private set(next: CodexLimits) {
    this.limits = next;
    this.opts.onChange(next);
  }

  private read(): Promise<void> {
    this.stopTimer();
    this.startedAt = this.now();
    this.running = this.doRead().finally(() => {
      this.running = undefined;
      this.abort = undefined;
      this.schedule();
    });
    return this.running;
  }

  private async doRead() {
    const codex = this.opts.codexPath();
    if (!codex) {
      this.lastRead = this.now();
      this.wait = BACKOFF_MS;
      return this.set({ status: 'missing', windows: [], at: 0, checkedAt: this.lastRead });
    }
    if (this.limits.status === 'off') this.set({ ...this.limits, status: 'checking' });
    this.abort = new AbortController();
    const answer = await this.ask(codex, this.opts.env, this.abort.signal);
    this.lastRead = this.now();
    this.touched = this.lastRead;
    if (this.closed) return;
    const next = answer.error ? undefined : codexPlanLimits(answer.result, answer.auth, this.lastRead);
    if (answer.error && /ENOENT/.test(answer.error)) {
      // `codex` was removed after it was found: forget where it was, and look for it again later.
      this.opts.onMissing?.();
      this.wait = BACKOFF_MS;
      return this.set({ status: 'missing', windows: [], at: 0, checkedAt: this.lastRead });
    }
    if (next?.status === 'signedOut' || (answer.error && SIGNED_OUT_ERROR.test(answer.error))) {
      this.fails = 0;
      this.wait = NO_PLAN_MS;
      return this.set({ status: 'signedOut', windows: [], at: 0, checkedAt: this.lastRead });
    }
    if (next?.status === 'ready') {
      this.fails = 0;
      this.wait = POLL_MS;
      return this.set(next);
    }
    // A failed read keeps the last good windows, as of their own time.
    this.wait = POLL_MS;
    if (++this.fails >= FAILS_BEFORE_BACKOFF) {
      this.fails = 0;
      this.wait = BACKOFF_MS;
    }
    this.set({ ...this.limits, status: 'error', checkedAt: this.lastRead });
  }
}
