// Shell tabs: plain login shells in a worker's folder, run in-process (they die with the office) and
// shared by everyone who opens that worker's window. See shared/shelltabs/protocol.ts.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import * as pty from '@lydell/node-pty';
import type { ShellTab, ShellTabServerMsg } from '../../shared/shelltabs/protocol.js';
import type { Client } from '../office/client.js';
import { screenSnapshot } from '../screen.js';
import { SLOW_CLIENT_BYTES } from '../office/client.js';
import { SCROLLBACK } from '../ptys.js';
import { WIN, defaultShell } from '../workers/process.js';
import { clamp } from '../workers/util.js';

export const MAX_SHELL_TABS = 6;
/** How long a shell has to end on SIGHUP before its whole process group is killed. */
const KILL_GRACE_MS = 2000;
/** The same pause the office takes before re-sending a terminal to a viewer who fell behind. */
const RESYNC_MS = 1000;

/** What a viewer's socket still has queued (clients in tests have no socket). */
const queued = (c: Client) => (c as { ws?: { bufferedAmount?: number } }).ws?.bufferedAmount ?? 0;

/** A process and everything under it, read off the process table (a job the shell runs has a process group of its own, so killing the shell's group alone misses it). */
function withDescendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  try {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).split('\n')) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (p && pp) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    }
  } catch {
    // no ps: the shell's own group has to do
  }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  return all;
}

/** Ends a shell and what it started: SIGHUP to its process group and every descendant, then SIGKILL after a grace period (at once with `now`). */
function killGroup(proc: pty.IPty, now: boolean) {
  const pid = proc.pid;
  if (WIN || !pid) return void proc.kill();
  const pids = withDescendants(pid);
  const send = (sig: NodeJS.Signals) => {
    for (const target of [-pid, ...pids]) {
      try {
        process.kill(target, sig);
      } catch {
        // already gone
      }
    }
  };
  if (now) return send('SIGKILL');
  send('SIGHUP');
  setTimeout(() => send('SIGKILL'), KILL_GRACE_MS).unref();
}

/** What a shell needs to start, or why it can't. */
export type ShellStart = { cwd: string; env: Record<string, string> } | string;

export interface ShellDeps {
  send(c: Client, msg: ShellTabServerMsg): void;
  /** `c` is whoever opens the tab. */
  spec(workerId: string, c: Client): ShellStart;
}

interface Tab {
  info: ShellTab;
  proc: pty.IPty;
  term: InstanceType<typeof headless.Terminal>;
  snapshot: () => string;
  cols: number;
  rows: number;
  viewers: Set<Client>;
  /** Viewers that fell behind: they skip output and get a fresh snapshot once their socket drains. */
  stale: Set<Client>;
  /** Output of this tick, not sent yet. */
  pending: string;
}

export class ShellTabs {
  private tabs = new Map<string, Tab>();
  private subs = new Map<string, Set<Client>>();
  private shell: string;
  private args: string[];
  private resync?: NodeJS.Timeout;

  constructor(
    private deps: ShellDeps,
    opts: { shell?: string; args?: string[] } = {},
  ) {
    this.shell = opts.shell ?? defaultShell();
    this.args = opts.args ?? (WIN ? [] : ['-l']);
  }

  private of(workerId: string): Tab[] {
    return [...this.tabs.values()].filter((t) => t.info.workerId === workerId);
  }

  /** Sends a worker's tabs to its subscribers, and (with `opened`) to the opener even if they aren't one. */
  private notify(workerId: string, opener?: Client, opened?: string) {
    const tabs = this.of(workerId).map((t) => t.info);
    const subs = this.subs.get(workerId);
    for (const c of subs ?? []) this.deps.send(c, { t: 'shelltab.tabs', workerId, tabs, ...(c === opener && opened ? { opened } : {}) });
    if (opener && opened && !subs?.has(opener)) this.deps.send(opener, { t: 'shelltab.tabs', workerId, tabs, opened });
  }

  list(c: Client, workerId: string) {
    let set = this.subs.get(workerId);
    if (!set) this.subs.set(workerId, (set = new Set()));
    set.add(c);
    this.deps.send(c, { t: 'shelltab.tabs', workerId, tabs: this.of(workerId).map((t) => t.info) });
  }

  unlist(c: Client, workerId: string) {
    const set = this.subs.get(workerId);
    set?.delete(c);
    if (set && !set.size) this.subs.delete(workerId);
  }

  /** Opens a shell tab; returns why it couldn't. */
  open(c: Client, workerId: string, by: string): string | undefined {
    if (this.of(workerId).length >= MAX_SHELL_TABS) return `A worker can have at most ${MAX_SHELL_TABS} shell tabs`;
    const start = this.deps.spec(workerId, c);
    if (typeof start === 'string') return start;
    const used = new Set(this.of(workerId).map((t) => t.info.title));
    let n = 1;
    while (used.has(`🐚 Shell ${n}`)) n++;
    const cols = 80;
    const rows = 24;
    let proc: pty.IPty;
    try {
      proc = pty.spawn(this.shell, this.args, { name: 'xterm-256color', cols, rows, cwd: start.cwd, env: start.env });
    } catch (e) {
      return `The shell could not start: ${(e as Error).message}`;
    }
    const term = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    const tab: Tab = {
      info: { id: randomBytes(6).toString('hex'), workerId, title: `🐚 Shell ${n}`, by, at: Date.now() },
      proc,
      term,
      snapshot: screenSnapshot(term, ser),
      cols,
      rows,
      viewers: new Set(),
      stale: new Set(),
      pending: '',
    };
    this.tabs.set(tab.info.id, tab);
    proc.onData((data) => {
      if (this.tabs.get(tab.info.id) !== tab) return;
      term.write(data);
      // Chunks of one tick go out as one message.
      if (!tab.pending) setImmediate(() => this.flush(tab));
      tab.pending += data;
    });
    proc.onExit(() => {
      if (this.tabs.get(tab.info.id) !== tab) return; // closed on purpose: already announced
      this.drop(tab, false);
      this.notify(workerId);
    });
    this.notify(workerId, c, tab.info.id);
    return undefined;
  }

  /** Tells every viewer the tab's size and how many are watching. */
  private announce(tab: Tab) {
    for (const v of tab.viewers) this.deps.send(v, { t: 'shelltab.size', tabId: tab.info.id, cols: tab.cols, rows: tab.rows, viewers: tab.viewers.size });
  }

  private flush(tab: Tab) {
    const data = tab.pending;
    tab.pending = '';
    if (!data || this.tabs.get(tab.info.id) !== tab) return;
    for (const v of tab.viewers) {
      if (tab.stale.has(v)) continue;
      if (queued(v) > SLOW_CLIENT_BYTES) {
        tab.stale.add(v);
        this.resync ??= setInterval(() => this.catchUp(), RESYNC_MS).unref();
      } else this.deps.send(v, { t: 'shelltab.data', tabId: tab.info.id, data });
    }
  }

  /** Viewers who fell behind and whose socket has drained get the screen as it is now. */
  private catchUp() {
    let left = 0;
    for (const tab of this.tabs.values()) {
      for (const v of [...tab.stale]) {
        if (!tab.viewers.has(v)) tab.stale.delete(v);
        else if (queued(v) <= SLOW_CLIENT_BYTES / 8) {
          tab.stale.delete(v);
          this.deps.send(v, { t: 'shelltab.snapshot', tabId: tab.info.id, data: tab.snapshot(), cols: tab.cols, rows: tab.rows });
        }
      }
      left += tab.stale.size;
    }
    if (!left && this.resync) this.resync = void clearInterval(this.resync);
  }

  private drop(tab: Tab, kill: boolean | 'now') {
    this.tabs.delete(tab.info.id);
    tab.viewers.clear();
    tab.stale.clear();
    if (kill) killGroup(tab.proc, kill === 'now');
    tab.term.dispose();
  }

  close(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.drop(tab, true);
    this.notify(tab.info.workerId);
  }

  /** The tab's info, for checking a tab belongs to a worker you may use. */
  get(tabId: string): ShellTab | undefined {
    return this.tabs.get(tabId)?.info;
  }

  attach(c: Client, tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.viewers.add(c);
    tab.stale.delete(c);
    this.deps.send(c, { t: 'shelltab.snapshot', tabId, data: tab.snapshot(), cols: tab.cols, rows: tab.rows });
    this.announce(tab);
  }

  detach(c: Client, tabId: string) {
    const tab = this.tabs.get(tabId);
    if (tab?.viewers.delete(c)) this.announce(tab);
  }

  /** Keys typed by someone who is attached to the tab. */
  input(c: Client, tabId: string, data: string) {
    const tab = this.tabs.get(tabId);
    if (!tab?.viewers.has(c) || !data) return;
    try {
      tab.proc.write(data);
    } catch {
      // it exited between checks
    }
  }

  resize(c: Client, tabId: string, cols: number, rows: number) {
    const tab = this.tabs.get(tabId);
    if (!tab?.viewers.has(c)) return;
    cols = clamp(Math.floor(cols) || 0, 20, 400);
    rows = clamp(Math.floor(rows) || 0, 5, 200);
    if (cols === tab.cols && rows === tab.rows) return;
    tab.cols = cols;
    tab.rows = rows;
    try {
      tab.proc.resize(cols, rows);
      tab.term.resize(cols, rows);
    } catch {
      // it exited between checks
    }
    this.announce(tab);
  }

  /** `c` is gone (or left the worker's floor): no more tab lists or output for them. `workerIds` limits it to those workers' tabs. */
  forget(c: Client, workerIds?: ReadonlySet<string>) {
    for (const [id, set] of [...this.subs]) {
      if (workerIds && !workerIds.has(id)) continue;
      set.delete(c);
      if (!set.size) this.subs.delete(id);
    }
    for (const t of this.tabs.values()) if ((!workerIds || workerIds.has(t.info.workerId)) && t.viewers.delete(c)) this.announce(t);
  }

  /** The worker went home: its shells end. */
  removeWorker(workerId: string) {
    const mine = this.of(workerId);
    for (const t of mine) this.drop(t, true);
    if (mine.length) this.notify(workerId);
    this.subs.delete(workerId);
  }

  closeAll() {
    for (const t of [...this.tabs.values()]) this.drop(t, 'now'); // the office is exiting: no grace
    this.subs.clear();
    if (this.resync) this.resync = void clearInterval(this.resync);
  }
}
