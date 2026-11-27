// kanban.instructions.draft: Claude reads the project's repositories read-only and writes (or improves) the
// project's Debugging and testing or Pull-request review instructions, for the settings page's review window.
// Admins only. Claude only (Codex can't be limited to read-only tools). One run per browser, a few at once.

import { statSync } from 'node:fs';
import { childEnv } from '../../../workers/env.js';
import { runOneShot, type OneShotRun } from '../../oneshot.js';
import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import { fail } from '../util.js';
import { draftInput, draftSystem } from './prompt.js';

/** A run may take this long: it reads a whole project. */
export const INSTRUCTIONS_DRAFT_TIMEOUT_MS = 5 * 60_000;
/** Runs at once, the whole office over. */
export const INSTRUCTIONS_DRAFT_RUNS_MAX = 2;
/** The longest text that goes to the review window. */
export const INSTRUCTIONS_DRAFT_MAX = 20_000;

const TOOLS = ['Read', 'Glob', 'Grep'];
export interface InstructionsDraftDeps {
  /** Stand-in for the agent, for tests. */
  run?: typeof runOneShot;
}

/** The agent's answer as the field's text: no code fence around it, not too long. */
export function cleanInstructions(raw: string): string {
  let t = raw.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t.length > INSTRUCTIONS_DRAFT_MAX ? t.slice(0, INSTRUCTIONS_DRAFT_MAX).trimEnd() : t;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function createInstructionsDraftPlugin(ctx: KanbanContext, deps: InstructionsDraftDeps = {}): KanbanPlugin {
  const run = deps.run ?? runOneShot;
  /** The newest request of each browser (by clientId), with its run once it has one. */
  const newest = new Map<string, { project: string; run?: OneShotRun }>();
  let stopped = false;
  const runs = () => [...newest.values()].filter((e) => e.run).length;

  return {
    name: 'instructions-draft',
    ws: {
      'kanban.instructions.draft': async (c, m) => {
        if (!c.admin) return fail(c, m.rid, 'Only an admin can change that');
        const info = ctx.project(m.project);
        if (!info) return fail(c, m.rid, `There's no project ${m.project}`);
        if (ctx.hiringPaused?.()) return fail(c, m.rid, `The office isn't starting agents now: ${ctx.hiringPaused()}`);
        const cmd = ctx.claudeBin?.();
        if (!cmd) return fail(c, m.rid, "Claude isn't available on the office's machine");
        const env = childEnv();
        if (ctx.runAs && c.accountId) {
          if (!ctx.runAs.claudeReady(c.accountId)) return fail(c, m.rid, ctx.runAs.why('claude'));
          ctx.runAs.apply?.(c.accountId, env);
        }
        const repos = ctx.repos(m.project);
        const dirs = [...new Set(repos.map((r) => r.dir).filter(isDir))];
        if (!dirs.length) return fail(c, m.rid, "None of the project's repository folders exists on the office's machine");
        // This request is the browser's newest from here on: the earlier one's run, if it has one, ends now.
        const key = c.clientId;
        const mine: { project: string; run?: OneShotRun } = { project: m.project };
        newest.get(key)?.run?.kill();
        newest.set(key, mine);
        try {
          if (stopped) return fail(c, m.rid, 'cancelled');
          if (runs() >= INSTRUCTIONS_DRAFT_RUNS_MAX) return fail(c, m.rid, 'The office is busy writing instructions, try again in a moment');
          const settings = ctx.settings.get();
          const saved = ctx.settings.project(m.project);
          const model = settings.defaults.tool === 'claude' ? settings.defaults.model : undefined;
          const one = run({
            cmd,
            ...(model ? { model } : {}),
            system: draftSystem(m.field, ctx.languages?.().talk),
            input: draftInput({
              projectName: info.name,
              repos,
              general: saved.generalInstructions,
              other: m.field === 'testing' ? saved.prReviewInstructions : saved.testingInstructions,
              current: m.text,
              field: m.field,
            }),
            env,
            timeoutMs: INSTRUCTIONS_DRAFT_TIMEOUT_MS,
            tools: TOOLS,
            addDirs: dirs,
          });
          mine.run = one;
          const res = await one.done;
          if ('error' in res) return fail(c, m.rid, res.error);
          const text = cleanInstructions(res.text);
          if (!text) return fail(c, m.rid, 'The agent wrote nothing');
          c.send({ t: 'kanban.instructionsDraft', ...(m.rid ? { rid: m.rid } : {}), text });
        } catch (err) {
          fail(c, m.rid, (err as Error)?.message ?? String(err));
        } finally {
          // Only its own entry: a newer request of the browser has put one of its own there.
          if (newest.get(key) === mine) newest.delete(key);
        }
      },
      'kanban.instructions.draft.cancel': (c, m) => {
        if (!c.admin) return fail(c, m.rid, 'Only an admin can change that');
        const e = newest.get(c.clientId);
        if (e && e.project === m.project) e.run?.kill();
        c.send({ t: 'kanban.ok', ...(m.rid ? { rid: m.rid } : {}) });
      },
    },
    stop() {
      stopped = true;
      for (const e of newest.values()) e.run?.kill();
      newest.clear();
    },
  };
}
