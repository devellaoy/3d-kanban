// How a Stop ends when the agent can't rest by itself: the run is stopped, and the worker restarted at its desk (never sent home).

import type { Floor } from '../../floor.js';

/** Why Esc can't finish a Stop: the agent had background agents at work, or it didn't rest in time after Esc. */
export type StopReason = 'background' | 'timeout';
const WHY: Record<StopReason, string> = { background: 'Stopped while its background agents worked', timeout: "It didn't stop in a few seconds after Esc" };

/** What a Stop that Esc couldn't finish needs of the engine (see Orchestrator.interrupt). */
export interface StopRun {
  workerId: string;
  /** The worker's floor, when it is still open. */
  floor(): Floor | undefined;
  /** Runs `fn` on the task's serial queue. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Ends the run as stopped; false when it already ended (the Stop hook or a rest got there first). */
  stop(): Promise<boolean>;
  note(text: string): void;
  /** Whether the agent's own log shows the Esc taken (the turn is over), for an agent that fires no Stop hook on Esc. */
  interrupted(file: string): boolean;
}

/**
 * Ends a Stop that Esc didn't: an Esc the transcript confirms is the turn's end (the worker rests, no restart). Otherwise the run
 * is stopped first (so the old process's last events and the new one's find it forgotten), and, if it hadn't already ended, the
 * worker restarted on its session without a prompt (which also ends its in-process background helpers). A restart that fails (no
 * session yet, a worker that can't be relaunched, a process that won't exit) ends a working agent's process in place, or leaves a
 * resting one as it is: a Stop never sends a worker home, and never leaves the agent running.
 */
export async function endStop(run: StopRun, reason: StopReason): Promise<void> {
  const floor = run.floor();
  const id = run.workerId;
  const file = reason === 'timeout' ? floor?.workers.transcripts(id)?.claude : undefined;
  const rested = !!file && run.interrupted(file);
  if (rested) floor!.workers.rested(id);
  const ended = await run.serial(run.stop);
  if (!ended || rested || !floor) return;
  const err = await floor.workers.relaunch(id);
  if (!err) return run.note(`${WHY[reason]}: restarted on its session at its desk.`);
  const status = floor.workers.get(id)?.status;
  if (status !== 'working' && status !== 'starting') return run.note(`${WHY[reason]}: couldn't restart it (${err}); it stays as it is.`);
  const left = await floor.workers.halt(id);
  run.note(`${WHY[reason]}: couldn't restart it (${err}), so its agent was ended${left ? ` (${left})` : ''}; it stays at its desk.`);
}
