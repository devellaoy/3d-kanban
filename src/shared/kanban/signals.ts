// How an agent says, with a command rather than in its text, how its turn ends (docs/kanban-architecture.md §4, "The end of a turn").

/** How an agent says, with a command rather than in its text, how its turn ends (office-tasks done, the MCP tool report_turn). */
export type TurnSignal = { kind: 'plan-ready' | 'ask' | 'done' } | { kind: 'review'; verdict: 'approved' | 'changes' } | { kind: 'pr'; url: string };

/** The longest pull request URL taken. */
const URL_MAX = 2000;

/** Parses a request body into a TurnSignal; undefined when it is none. */
export function parseTurnSignal(v: unknown): TurnSignal | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { kind?: unknown; verdict?: unknown; url?: unknown };
  switch (o.kind) {
    case 'plan-ready':
    case 'ask':
    case 'done':
      return { kind: o.kind };
    case 'review':
      return o.verdict === 'approved' || o.verdict === 'changes' ? { kind: 'review', verdict: o.verdict } : undefined;
    case 'pr': {
      const url = typeof o.url === 'string' ? o.url.trim() : '';
      return url && url.length <= URL_MAX && !/\s/.test(url) ? { kind: 'pr', url } : undefined;
    }
    default:
      return undefined;
  }
}
