// What the kanban engine asks of the worker manager: the base class
// WorkerManager extends, so its hooks in workers/manager.ts stay one-liners. Observers hear every
// worker's status changes and hooks, keep guards keep a task's worktree as its worker goes home,
// and a worker can be relaunched on its session with other flags.
import type { AgentEffort, WorkerInfo, WorkerStatus } from '../../shared/protocol.js';
import type { DepartureIntent } from '../../shared/kanban/types.js';
import { CARRY_ON_STAGGER_MS, carries } from '../workers/carryon.js';
import { codexHookTrustArgs } from './codex-trust.js';
import type { Pty } from '../ptys.js';
import { validateWorkerEffort, validateWorkerModel } from '../agents.js';
import type { WorktreeCleanup } from '../worktrees.js';
import type { SpawnExtra, Worker, WorkerHandle, WorkerObservation, WorkerObserver } from '../workers/types.js';

export type { DepartureIntent };

/** What an observer is told apart from who it is about (see WorkerManager.emitUpdate). */
export type Observed = Omit<WorkerObservation, 'workerId' | 'info' | 'transcript' | 'codexTranscript'>;

/** What a Codex worker's adapter keeps of its session (providers/codex.ts), as the engine reads it. */
interface CodexLog {
  transcript?: string;
  home?: string;
}

/** Kills a process and waits for it to exit: SIGTERM, then after 5 s SIGKILL and a few more seconds; resolves to what went wrong if it is still there. */
async function endProcess(proc: Pty, name: string): Promise<string | undefined> {
  let exited = false;
  proc.onExit(() => (exited = true));
  const within = async (ms: number) => {
    for (const end = Date.now() + ms; !exited && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
    return exited;
  };
  for (const [signal, ms] of [[undefined, 5000], ['SIGKILL', 3000]] as const) {
    try {
      proc.kill(signal);
    } catch {
      // already gone
    }
    if (await within(ms)) return undefined;
  }
  return `${name}'s old process didn't exit`;
}

export abstract class KanbanWorkers {
  protected abstract readonly workers: Map<string, Worker>;
  protected abstract emitUpdate(w: Worker): void;
  protected abstract setStatus(w: Worker, status: WorkerStatus): void;
  abstract resume(id: string, prompt?: string): string | undefined;

  /** Workers whose current run the engine follows: an agent that exits on a failed resume is the engine's to deal with, not upstream's silent fresh start (see follows). */
  protected readonly followed = new Set<string>();
  /** The engine follows (or stops following) a worker's run. Not kept across restarts: the engine follows again what it re-attaches. */
  follows(id: string, on: boolean) {
    if (on) this.followed.add(id);
    else this.followed.delete(id);
  }

  /** ⚙️ Settings: whether workers cut off mid-turn by the office stopping carry on by themselves (set by the floor; on without it). */
  carryOn: () => boolean = () => true;
  /** Between one carrying-on worker's start and the next one's. */
  carryOnStaggerMs = CARRY_ON_STAGGER_MS;

  /** Whether `id` will pick its cut-off turn up by itself once the office has started (QueueWorkers.carriesOn; never a task's worker). */
  carriesOn(id: string): boolean {
    const w = this.workers.get(id);
    return !!w && carries(w, this.carryOn());
  }

  /** Why the worker's carry-on was given up (the budget was spent, its session or worktree was gone), so it will not pick its turn up; undefined when it was not. */
  carryOnDropped(id: string): string | undefined {
    return this.workers.get(id)?.carryOnDropped;
  }

  /** What the engine asks at reconcile: does the office carry its cut-off workers on itself (then it resumes a task's worker as the engine tells it to, with its own prompt)? */
  carriesOnAfterRestart(): boolean {
    return this.carryOn();
  }

  /** The worker's status as the office closed, when its terminal did not survive (only meaningful for the first reconcile after start: it is not cleared at runtime); undefined when it survived, was adopted or never saved. */
  cutOffStatus(id: string): WorkerStatus | undefined {
    return this.workers.get(id)?.cutOff;
  }

  /** Who hears about status changes and hooks (see addObserver). */
  private observers = new Set<WorkerObserver>();
  /** Who may keep a worker's worktree as it goes home (see addKeepGuard). */
  private keepGuards = new Set<(info: WorkerInfo) => boolean>();

  /**
   * Stops a running agent and starts it again on the same session (--resume), with new launch
   * arguments (a phase needing other permission flags) and `prompt` as its next message. `model` /
   * `effort`, when the keys are there, replace the worker's own (undefined clears them), as spawn
   * checks them. Resolves to what went wrong, if anything.
   */
  async relaunch(id: string, opts: { launchArgs?: string[]; prompt?: string; env?: Record<string, string>; model?: string; effort?: AgentEffort } = {}): Promise<string | undefined> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.info.kind !== 'agent' || w.dsh) return `${w.info.name} can't be relaunched`;
    if (!w.info.sessionId) return `${w.info.name} has no session to carry on yet`;
    const setModel = 'model' in opts;
    const setEffort = 'effort' in opts;
    const modelError = setModel ? validateWorkerModel('agent', w.info.provider, opts.model) : undefined;
    if (modelError) return modelError;
    const effortError = setEffort ? validateWorkerEffort('agent', w.info.provider, opts.effort) : undefined;
    if (effortError) return effortError;
    if ((setModel && w.info.model !== opts.model) || (setEffort && w.info.effort !== opts.effort)) {
      if (setModel) w.info.model = opts.model;
      if (setEffort) w.info.effort = opts.effort;
      this.emitUpdate(w);
    }
    if (opts.launchArgs) (w.extra ??= {}).launchArgs = [...opts.launchArgs];
    // A phase may bring other variables (its skills, say), like its other flags.
    if (opts.env) (w.extra ??= {}).env = { ...opts.env };
    const proc = w.pty;
    // Gone before it exits, so the exit handler knows it was the office and stays quiet.
    w.pty = undefined;
    // The old process lets go of the session before the new one picks it up; one that won't leave is not resumed over (two agents on a session).
    const stuck = proc && (await endProcess(proc, w.info.name));
    if (stuck) {
      if (!w.pty && this.workers.get(id) === w) w.pty = proc;
      return stuck;
    }
    if (this.workers.get(id) !== w) return 'No such worker';
    if (w.pty) return 'Worker is already running';
    w.interrupted = false;
    (w.extra ??= {}).restartedAt = Date.now();
    return this.resume(id, opts.prompt);
  }

  /** Ends a worker's agent process in place (the exit handler then marks it `exited` at its desk: R resumes it); resolves to what went wrong, if anything. */
  async halt(id: string): Promise<string | undefined> {
    const w = this.workers.get(id);
    return w?.pty ? endProcess(w.pty, w.info.name) : undefined;
  }

  /** A worker whose turn is over without a Stop hook (Esc'd): at rest, as it was `working` a moment ago. */
  rested(id: string) {
    const w = this.workers.get(id);
    if (w?.info.status === 'working') this.setStatus(w, 'done');
  }

  /** Hears every worker's status changes and hooks (see WorkerObservation); returns how to stop. */
  addObserver(fn: WorkerObserver): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  /**
   * `guard` says when a worker's worktree must stay as it goes home, whatever cleanup was asked for
   * (the kanban keeps a task's worktree while it's still needed there); returns how to stop.
   */
  addKeepGuard(guard: (info: WorkerInfo) => boolean): () => void {
    this.keepGuards.add(guard);
    return () => this.keepGuards.delete(guard);
  }

  /** A task worker's card as it is now (WorkerInfo.kanban), for every browser with the worker's update. */
  setKanbanSummary(id: string, summary: NonNullable<WorkerInfo['kanban']>) {
    const w = this.workers.get(id);
    if (!w?.info.kanban || JSON.stringify(w.info.kanban) === JSON.stringify(summary)) return;
    w.info.kanban = summary;
    this.emitUpdate(w);
  }

  /** When the office last restarted this worker's agent process (see SpawnExtra.restartedAt). */
  restartedAt(id: string): number | undefined {
    return this.workers.get(id)?.extra?.restartedAt;
  }

  /** The phase flags a worker launches with now (see SpawnExtra.launchArgs), so the engine knows when a phase needs a relaunch. */
  launchArgsOf(id: string): string[] | undefined {
    const args = this.workers.get(id)?.extra?.launchArgs;
    return args && [...args];
  }

  /** Where a worker's session is logged, for the engine to read its turns (see docs/fork.md, M0 spike results). */
  transcripts(id: string): { sessionId?: string; claude?: string; codex?: string; codexHome?: string } | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    const codex = codexLog(w);
    return { sessionId: w.info.sessionId, claude: w.tracker.transcript, codex: codex?.transcript, codexHome: codex?.home };
  }

  /** A status change, after the update that tells everyone (the observers hear it: see WorkerObservation). */
  protected emitted(w: Worker, seen: Observed) {
    this.emitUpdate(w);
    this.observe(w, seen);
  }

  /** What a worker's provider adapter is handed of it, with the hook events it takes heard by the observers too. */
  protected observable(w: Worker, handle: Omit<WorkerHandle, 'observeHook'>): WorkerHandle {
    return Object.assign(handle, { observeHook: (hookEvent: string | undefined, tool: string | undefined, payload: unknown) => this.observe(w, { event: 'hook', hookEvent, tool, payload }) }) as WorkerHandle;
  }

  /** A worker was just hired (WorkerManager.spawn): its owner, how the kanban launches it, and which task it works on (see SpawnExtra). */
  protected hired(w: Worker, owner: string | undefined, extra: SpawnExtra | undefined) {
    w.owner = owner;
    w.extra = kanbanExtra(extra);
    w.launchTail = extra?.promptTail;
    if (extra?.readDir && w.extra && (w.info.provider === 'claude' || w.info.provider === 'codex')) w.extra.launchArgs = [...(w.extra.launchArgs ?? []), '--add-dir', extra.readDir];
    if (extra?.resumeSessionId) w.info.sessionId = extra.resumeSessionId;
    if (extra?.kanban) w.info.kanban = { taskId: extra.kanban.taskId, role: extra.kanban.role };
  }

  protected observe(w: Worker, o: Observed) {
    if (!this.observers.size) return;
    const seen: WorkerObservation = { workerId: w.info.id, info: { ...w.info }, transcript: w.tracker.transcript, codexTranscript: codexLog(w)?.transcript, ...o };
    for (const fn of this.observers) {
      try {
        fn(seen);
      } catch (err) {
        console.error(`agent-office: a worker observer failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * A worker is being sent home (WorkerManager.kill): why it goes, for the observers; and what becomes
   * of its worktree. A task's stays while the kanban still needs it there (see addKeepGuard); without
   * the kanban, a worker seated in someone else's worktree (SpawnExtra.reuse) never takes it away.
   */
  protected departing(w: Worker, intent: DepartureIntent | undefined, cleanup: WorktreeCleanup | undefined): WorktreeCleanup | undefined {
    if (intent) w.departure = intent;
    return (this.keepGuards.size ? [...this.keepGuards].some((g) => g(w.info)) : w.extra?.reused) ? 'keep' : cleanup;
  }
}

/** Codex's session log of a worker, when it runs Codex. */
function codexLog(w: Worker): CodexLog | undefined {
  return w.info.provider === 'codex' ? (w.state as CodexLog) : undefined;
}

/** How a hire is launched, kept on its worker (Worker.extra): a kanban hire's flags and settings, undefined for any other hire. Its `id`, `promptTail` and `readDir` are for the first launch only: only `launchArgs` is kept (a direct hire's `readDir` is added to it, see hired()). */
function kanbanExtra(extra: SpawnExtra | undefined): Worker['extra'] {
  return extra && { launchArgs: extra.launchArgs && [...extra.launchArgs], env: extra.env && { ...extra.env }, settingsFile: extra.settingsFile, reused: !!extra.reuse };
}

/** The setup a worker's provider launches with: for a kanban hire of Claude, the settings file that skips the bypass-mode confirmation. */
export function kanbanSetup(w: Worker, adapter: { id: string }, setup: unknown): unknown {
  const s = setup as { settings?: string; kanbanSettings?: string } | undefined;
  return adapter.id === 'claude' && w.extra?.settingsFile === 'kanban' && s?.kanbanSettings ? { ...s, settings: s.kanbanSettings } : setup;
}

/** The flags a worker's provider launches with: a kanban hire of Codex also gets the trusted hashes of the office's hooks (they name this floor's hook path, so they are made per launch). */
export function kanbanExtraArgs(w: Worker, adapter: { id: string }, setup: unknown): string[] | undefined {
  const hook = (setup as { hook?: unknown } | undefined)?.hook;
  return adapter.id === 'codex' && w.info.kanban && typeof hook === 'string' ? [...codexHookTrustArgs(hook), ...(w.extra?.launchArgs ?? [])] : w.extra?.launchArgs;
}

/** What an agent worker's environment gets from the kanban: AGENT_OFFICE_TASKS shows it the task tools (bin/office-tasks.js, the MCP server), as the kanban is always on here. */
export function kanbanWorkerEnv(info: Pick<WorkerInfo, 'kind'>): Record<string, string> {
  return info.kind === 'shell' ? {} : { AGENT_OFFICE_TASKS: '1' };
}

/** What a hire's WorkerInfo takes from its SpawnExtra: byPerson when createdBy names the person who hired it at a desk. */
export function kanbanHireInfo(extra?: Pick<SpawnExtra, 'byPerson'>): { byPerson?: true } {
  return extra?.byPerson ? { byPerson: true } : {};
}
