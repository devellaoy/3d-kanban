// A task whose agent asked something (waiting, agent_asking), as the task view and the card show it:
// a question in a live terminal, or one whose run is over (the task was put on hold, the office
// restarted, or the agent ended its turn on the question). No DOM here, so the tests read it as it is.

import type { KanbanRun, KanbanTask } from '../../shared/kanban/types.js';

type Subject = Pick<KanbanTask, 'phase' | 'workerId' | 'reviewerWorkerId' | 'askingKind'>;

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

/** The asking worker: the reviewer during a review round, else the implementer. */
function askingWorker(task: Subject): string | undefined {
  return task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
}

/**
 * Whether the asking agent's run is still going, which is what the server goes by when an answer comes
 * (a live run gets it typed into its terminal; with none, the answer starts the agent again). `runs` are
 * the task's runs when the view has them; without them (a card), a hired worker stands for a live run.
 */
export function askingLive(task: Subject, runs?: readonly Pick<KanbanRun, 'status'>[]): boolean {
  return runs ? runs.some((r) => r.status === 'running') : !!askingWorker(task);
}

export function askingView(task: Subject, runs?: readonly Pick<KanbanRun, 'status'>[]): AskingView {
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
  const terminalOf = askingWorker(task);
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
