// When a usage limit that stopped a run starts over, for autoResume: what its text says (Claude's
// wording, see markers.resetTime), else, for a Codex run, what the Codex account's limits say.
import type { KanbanTool } from '../../../shared/kanban/types.js';
import type { KanbanContext } from '../registry.js';
import { resetTime } from './markers.js';

/** The run the limit stopped: its tool, and the worker that ran it (for its Codex home). */
interface LimitedRun {
  tool: KanbanTool;
  floorId: string;
  workerId: string;
}

/** What a usage or rate limit says (a plain lost connection has no allowance to ask about). */
const LIMIT_WORDS = /usage limit|rate limit|hit your limit|quota|try again (?:at|in)/i;

/**
 * The reset time (ms since epoch), or undefined when nobody says (the caller backs off instead).
 * Call it before the run is finished: the worker's Codex home is read in its synchronous part, while
 * the worker is still there. The Codex read deliberately skips the 20-second gap (the limit just hit),
 * and its wait of at most 5 seconds holds the task's serial chain.
 */
export async function limitReset(ctx: KanbanContext, run: LimitedRun, said: string, now: number): Promise<number | undefined> {
  const fromText = resetTime(said, now);
  if (fromText !== undefined || run.tool !== 'codex' || !ctx.codexResetAt || !LIMIT_WORDS.test(said)) return fromText;
  try {
    return await ctx.codexResetAt(ctx.floor(run.floorId)?.workers.transcripts(run.workerId)?.codexHome);
  } catch {
    return undefined;
  }
}
