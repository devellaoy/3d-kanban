// How a Stop ends when the agent can't rest by itself: the run is stopped, and the worker restarted at its desk (never sent home).

import type { Floor } from '../../floor.js';

/** A Stop that Esc can't finish (background agents at work, or no rest after Esc). */
export const STOP_WHILE_BACKGROUND = 'Stopped while its background agents worked: restarted on its session at its desk, which ended them.';
export const STOP_TIMED_OUT = "It didn't stop in a few seconds after Esc: restarted on its session at its desk.";

/**
 * Ends the run as stopped first (so the old process's last events and the new one's find it forgotten), then restarts the
 * worker on its session without a prompt (which also ends its background helpers) and notes it. A restart that fails
 * (no session yet, a worker that can't be relaunched) leaves the worker where it is and says so: a Stop never sends a worker home.
 */
export async function stopAndRestart(floor: Floor, workerId: string, stop: () => Promise<void>, note: (text: string) => void, text: string): Promise<void> {
  await stop();
  const err = await floor.workers.relaunch(workerId);
  if (!err) return note(text);
  const reason = `${text.replace(/: restarted.*$/, '')}: couldn't restart it (${err})`;
  note(`${reason}, so it stays as it is.`);
}
