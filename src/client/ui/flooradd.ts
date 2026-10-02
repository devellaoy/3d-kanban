import type { ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';

// Asking the office for a new floor: a GitHub repository it clones, or a folder on its machine made a
// floor as it is (admins only). The elevator asks, and so does the kanban's ＋ New project; the
// answer (floor.added) comes back to whoever asked, echoing the request's id (and what was asked for).

type Added = Extract<ServerMsg, { t: 'floor.added' }>;
type Answer = { floor: string } | { error: string };

/** What a request hears back while it waits: its floor.added, or null when the connection started over. */
const addedWaiters = new Set<(msg: Added | null) => void>();

/** The last request id this page made up (see requestFloor). */
let lastRid = 0;
/** This page's own prefix for them, so two tabs' requests never look alike. */
const RID_PREFIX = `f${Math.random().toString(36).slice(2, 8)}`;

/** The answer for a request the office can no longer give one to. */
export const DROPPED = 'The connection dropped before the office answered: look in the elevator whether the floor is there';

/**
 * Both pages feed server messages through here, so whoever's waiting on a new floor hears back. A
 * welcome is a connection starting over (nothing asks before the first one), and the office has
 * forgotten who asked by then: whoever's still waiting is told so rather than left waiting.
 */
export function routeFloorAdded(msg: ServerMsg) {
  if (msg.t === 'floor.added') for (const fn of addedWaiters) fn(msg);
  else if (msg.t === 'welcome') for (const fn of addedWaiters) fn(null);
}

/**
 * Sends floor.add with an id of its own and resolves on the floor.added that echoes it: the new floor's
 * id, or why it couldn't be. Two requests for the same repository each hear their own answer. An answer
 * without an id (an office from before ids) goes by the repository or folder it echoes instead. A clone
 * can take a while; it gives up only if the connection drops.
 */
export function requestFloor(net: Pick<Net, 'send'>, input: { repo: string } | { dir: string }): Promise<Answer> {
  return new Promise((resolve) => {
    const rid = `${RID_PREFIX}-${++lastRid}`;
    const repo = 'repo' in input ? input.repo : undefined;
    const dir = 'dir' in input ? input.dir : undefined;
    const mine = (msg: Added) => (msg.rid !== undefined ? msg.rid === rid : repo !== undefined ? msg.repo === repo : msg.dir === dir);
    const onAdded = (msg: Added | null) => {
      if (msg && !mine(msg)) return;
      addedWaiters.delete(onAdded);
      if (!msg) resolve({ error: DROPPED });
      else resolve(msg.error || !msg.floor ? { error: msg.error ?? 'The floor could not be added' } : { floor: msg.floor });
    };
    addedWaiters.add(onAdded);
    net.send({ t: 'floor.add', ...input, rid });
  });
}

/**
 * What's typed, trimmed, when it's a folder's path rather than a repository: /…, ~…, \…, C:…, or
 * ./… and ../… (and . or .. alone). A dot on its own doesn't make one: .github is a repository's name.
 */
export function folderPath(text: string): string | undefined {
  const t = text.trim();
  return /^([~/\\]|[A-Za-z]:|\.\.?([/\\]|$))/.test(t) ? t : undefined;
}

/** Why that folder can't be asked for from here, if it can't: only admins may, and only by its full path. */
export function folderProblem(dir: string, admin: boolean): string | undefined {
  if (!admin) return 'Only admins can add a folder as a project';
  if (dir.startsWith('.')) return 'Use the folder’s full path, like /Users/me/work/notes or ~/work/notes';
  return undefined;
}

/** What making a folder a floor does, for under the box it's typed in. */
export function folderNote(dir: string): string {
  return `The folder becomes a floor as it is. A git checkout’s GitHub repository is picked up; without git the floor has no worktrees, branches or pull requests. The office keeps its data in ${dir.replace(/[/\\]+$/, '') || dir}/.agent-office.`;
}
