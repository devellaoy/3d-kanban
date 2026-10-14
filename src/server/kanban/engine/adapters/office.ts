// Which of the comments the office typed into a run its session log shows (docs/kanban-architecture.md §4, "Comments"). One log prompt
// acknowledges at most one comment, the earliest not yet matched whose text it starts like, so two comments that begin alike are told apart.

/** A comment typed into the run, as the readers follow it. */
export interface OfficePrompt {
  at: number;
  head: string;
  heard?: boolean;
  /** A reader found it in the log once (kept on the run): never waited for again, whatever the tail it reads later holds. */
  seen?: boolean;
}

/**
 * `received`: indices of the comments the log shows (or showed before: `seen`), or whose moment lies before the start of the tail that was read
 * (`cutBefore`: a log cut at its head says nothing of them, and the tail's later activity shows the agent went on, so they count as received).
 * `fresh`: those among them not `seen` before, for the engine to remember.
 */
export function officeReceipts(
  prompts: OfficePrompt[],
  lines: { at: number; text: string }[],
  starts: (text: string, head: string) => boolean,
  cutBefore?: number,
): { received: Set<number>; fresh: number[] } {
  const received = new Set<number>();
  prompts.forEach((p, i) => p.seen && received.add(i));
  const order = prompts.flatMap((_, i) => (received.has(i) ? [] : [i])).sort((a, b) => prompts[a].at - prompts[b].at);
  const matched = new Set<number>();
  for (const l of [...lines].sort((a, b) => a.at - b.at)) {
    const i = order.find((k) => !matched.has(k) && prompts[k].at <= l.at && starts(l.text, prompts[k].head));
    if (i !== undefined) matched.add(i);
  }
  const fresh = order.filter((i) => matched.has(i) || (cutBefore !== undefined && prompts[i].at < cutBefore));
  for (const i of fresh) received.add(i);
  return { received, fresh };
}
