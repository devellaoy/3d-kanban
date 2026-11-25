// A task whose agent asked something (waiting, agent_asking), as the task view and the card show it:
// a question in a live terminal, or one whose run is over (the task was put on hold, the office
// restarted, or the agent ended its turn on the question). No DOM here, so the tests read it as it is.

import type { KanbanRun, KanbanTask } from '../../shared/kanban/types.js';

type Subject = Pick<KanbanTask, 'phase' | 'workerId' | 'reviewerWorkerId' | 'askingKind'> & { coReviewers?: readonly { seat: number; workerId?: string }[] };
type Runs = readonly Pick<KanbanRun, 'status' | 'workerId'>[];

/** What the view shows of an asking task. */
export interface AskingView {
  /** Its run is still going: the question is in the agent's terminal. */
  live: boolean;
  /** The banner's title and the card's words. */
  title: string;
  /** The answer box is shown (a live permission prompt, or one the office can't tell, is answered in the terminal). */
  answerBox: boolean;
  /** The worker whose terminal "Open the terminal" leads to: only while the run is live. */
  terminalOf?: string;
  /** A line in bold: where to answer when it isn't here. */
  instruction?: string;
  /** The small print under it: what an answer or a comment does. */
  note: string;
  /** Send the answer's tooltip. */
  sendTitle: string;
}

/**
 * The asking worker: a reviewer during a review round, else the implementer. A round with additional
 * reviewers has several at once, and the task doesn't say which of them asked: the first one whose run
 * is still going (the main reviewer before the others, by seat), else the first one at a desk.
 */
function askingWorker(task: Subject, runs?: Runs): string | undefined {
  if (task.phase !== 'review' && task.phase !== 'pr-review') return task.workerId;
  const co = [...(task.coReviewers ?? [])].sort((a, b) => a.seat - b.seat).map((r) => r.workerId);
  const reviewers = [task.reviewerWorkerId, ...co].filter((id): id is string => !!id);
  const running = new Set(runs?.filter((r) => r.status === 'running').map((r) => r.workerId));
  return reviewers.find((id) => running.has(id)) ?? reviewers[0];
}

/**
 * Whether the asking agent's run is still going, which is what the server goes by when an answer comes
 * (a live run gets it typed into its terminal; with none, the answer starts the agent again). `runs` are
 * the task's runs when the view has them; without them (a card), a hired worker stands for a live run.
 */
export function askingLive(task: Subject, runs?: Runs): boolean {
  return runs ? runs.some((r) => r.status === 'running') : !!askingWorker(task);
}

export function askingView(task: Subject, runs?: Runs): AskingView {
  if (!askingLive(task, runs)) {
    return {
      live: false,
      title: 'The agent asked a question',
      answerBox: true,
      note: 'Its run is over: your answer (or a comment) starts the agent again with it.',
      sendTitle: 'Give the agent your answer: it starts again and carries on with it',
    };
  }
  const title = 'The agent is asking in its terminal';
  const terminalOf = askingWorker(task, runs);
  // From here only a question is answered: typed text and Enter would pick a permission prompt's highlighted option.
  if (task.askingKind === 'question') {
    return { live: true, title, answerBox: true, terminalOf, note: 'Your answer is typed into its terminal, as if you typed it there.', sendTitle: 'Type your answer into the agent’s terminal: it carries on with it' };
  }
  return {
    live: true,
    title,
    answerBox: false,
    terminalOf,
    instruction: task.askingKind === 'permission' ? 'The agent asks for a permission: answer it in its terminal.' : 'The agent waits on something in its terminal: answer it there.',
    note: 'A comment waits until that turn is over.',
    sendTitle: '',
  };
}
