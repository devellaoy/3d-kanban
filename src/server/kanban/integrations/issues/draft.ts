// kanban.issues.draft: the default agent (the kanban Settings' tool and model) writes a short task
// prompt from an issue, for the New task form's description. One run per browser, a few at once.

import type { KanbanClientMsg, KanbanClientType } from '../../../../shared/kanban/protocol.js';
import type { NormalizedIssue } from '../../../../shared/kanban/types.js';
import { childEnv } from '../../../workers/env.js';
import { Composer } from '../../engine/compose.js';
import { runOneShot, type OneShotRun } from '../../oneshot.js';
import type { KanbanClient, KanbanContext, KanbanPlugin } from '../../registry.js';
import { fail } from '../util.js';

type Msg<T extends KanbanClientType> = Extract<KanbanClientMsg, { t: T }>;

/** How much of the issue's body the agent gets. */
const BODY_MAX = 8000;
/** The longest draft that goes to the form. */
const DRAFT_MAX = 1500;
/** Runs at once, the whole office over. */
const RUNS_MAX = 4;

export interface DraftDeps {
  find(project: string, key: string): NormalizedIssue | undefined;
  load(project: string, key: string, source?: string): Promise<NormalizedIssue | undefined>;
  remember(project: string, issue: NormalizedIssue): void;
  /** Stand-in for the agent, for tests. */
  run?: typeof runOneShot;
}

/** The agent's answer as a task prompt: no code fence or quotes around it, not too long. */
export function cleanDraft(raw: string): string {
  let t = raw.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  // Only a pair that wraps the whole text: quotes inside it are the text's own.
  const quoted = /^(?:"([^"]*)"|“([^“”]*)”|'([^']*)')$/.exec(t);
  if (quoted) t = (quoted[1] ?? quoted[2] ?? quoted[3]).trim();
  return t.length > DRAFT_MAX ? `${t.slice(0, DRAFT_MAX - 1).trimEnd()}…` : t;
}

export function draftHandlers(ctx: KanbanContext, deps: DraftDeps): { ws: NonNullable<KanbanPlugin['ws']>; stop(): void } {
  const run = deps.run ?? runOneShot;
  /** What is running, by the browser that asked. */
  const running = new Map<string, OneShotRun>();
  const compose = new Composer(ctx);

  const draft = async (c: KanbanClient, m: Msg<'kanban.issues.draft'>): Promise<void> => {
    const empty = () => c.send({ t: 'kanban.issueDraft', ...(m.rid ? { rid: m.rid } : {}), text: '' });
    if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
    // The prompt emptied (office or project) turns the drafting off: nothing but the language rule is left.
    if (!compose.text('kanban.issueDraft', m.project, { language: '' }).trim()) return empty();
    if (ctx.hiringPaused?.()) return empty();
    try {
      const issue = deps.find(m.project, m.issueKey) ?? (await deps.load(m.project, m.issueKey, m.source));
      if (!issue) return fail(c, m.rid, `${m.issueKey} isn't among the project's issues (any more)`);
      deps.remember(m.project, issue);
      const { tool, model } = ctx.settings.get().defaults;
      const kind = tool === 'codex' ? 'codex' : 'claude';
      let env = childEnv();
      if (kind === 'claude' && ctx.runAs && c.accountId) {
        if (!ctx.runAs.claudeReady(c.accountId)) return fail(c, m.rid, ctx.runAs.why('claude'));
        ctx.runAs.apply?.(c.accountId, env);
      }
      const cmd = ctx.agentBin?.(kind);
      if (!cmd) return fail(c, m.rid, `${kind === 'codex' ? 'Codex' : 'Claude'} isn't available on the office's machine`);

      // A new request from the same browser replaces its earlier one.
      const key = c.clientId;
      running.get(key)?.kill();
      running.delete(key);
      if (running.size >= RUNS_MAX) return fail(c, m.rid, 'The office is busy drafting, try again in a moment');
      const one = run({
        cmd,
        tool: kind,
        ...(model ? { model } : {}),
        system: compose.text('kanban.issueDraft', m.project, { language: compose.language(m.project) }),
        input: `Issue ${issue.key}: ${issue.title}\n\n${issue.body.slice(0, BODY_MAX)}`,
        env,
      });
      running.set(key, one);
      const res = await one.done;
      if (running.get(key) === one) running.delete(key);
      if ('error' in res) return fail(c, m.rid, res.error);
      const text = cleanDraft(res.text);
      if (!text) return fail(c, m.rid, 'The agent wrote nothing');
      c.send({ t: 'kanban.issueDraft', ...(m.rid ? { rid: m.rid } : {}), text });
    } catch (err) {
      fail(c, m.rid, (err as Error)?.message ?? String(err));
    }
  };

  return {
    ws: { 'kanban.issues.draft': draft },
    stop() {
      for (const r of running.values()) r.kill();
      running.clear();
    },
  };
}
