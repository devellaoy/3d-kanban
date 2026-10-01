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

/** The reset time (ms since epoch), or undefined when nobody says (the caller backs off instead). */
export async function limitReset(ctx: KanbanContext, run: LimitedRun, said: string, now: number): Promise<number | undefined> {
  const fromText = resetTime(said, now);
  if (fromText !== undefined || run.tool !== 'codex' || !ctx.codexResetAt) return fromText;
  try {
    return await ctx.codexResetAt(ctx.floor(run.floorId)?.workers.transcripts(run.workerId)?.codexHome);
  } catch {
    return undefined;
  }
}
