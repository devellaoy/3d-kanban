import { SPAWN_PROMPT_MAX, composeHandoff, handoffTag, outputFileName, toggleParagraph } from '../../shared/meeting-handoff';
import { pressureNote } from '../../shared/machine';
import { promptText } from '../../shared/prompts';
import type { AgentEffort, AgentProvider, ArchivedMeeting, MeetingFileText, MeetingFiles } from '../../shared/protocol';
import { uploadAttachment } from '../kanban/attach';
import { kanbanTool } from '../kanban/office';
import { hireOption } from '../kanban/office3d';
import { officeCss } from '../kanban/officecss';
import type { KanbanOption } from '../kanban/hireform';
import type { Net } from '../net';
import { repoChoices } from '../shared/hiring';
import { store } from '../state';
import { clip, h, toast } from './dom';
import { handoffGate } from './handoffgate';
import { fileProblem, get } from './meetingapi';
import { openPrompt } from './prompt';
import { officeChoice } from './provider';

// A finished meeting's output handed on as follow-up work: the hire dialog, prefilled (shared/meeting-handoff.ts
// composes the text), either as a kanban task (its toggle starts ticked) or as a plain worker.

/** What the hand-off needs of the view it is opened from (the 3D office or the 2D one). */
export interface HandoffHost {
  /** A free seat for a new worker, nearest first; undefined when every one is taken. */
  freeDesk(): { id: string; label: string } | undefined;
  /** Says so and returns true when the office is at its worker limit. */
  officeIsFull(): boolean;
  hire(deskId: string, prompt: string, o: { worktree: boolean; provider?: AgentProvider; model?: string; effort?: AgentEffort; repos: string[]; attachmentIds?: string[]; meeting?: string }): void;
}

/** The window the buttons are in: closed before the hire dialog opens, and asked whether it still is after each wait. */
export interface HandoffWindow {
  close(): void;
  isOpen(): boolean;
}

/** One hand-off at a time on the page: a second press while the first is fetching does nothing. */
const gate = handoffGate();

/** Whether this floor can have a kanban task made from a meeting (a project's floor, Claude Code or Codex as the worker). */
export const canMakeTask = (): boolean => !!store.floor && !!store.project && !!kanbanTool(officeChoice(store.project).provider);

/**
 * Opens the hire dialog with the meeting `id`'s output as the prompt. The meeting's window is closed first, so closing the
 * dialog puts the player straight back into mouse-look. It is dropped when the window was closed or the floor changed while
 * it waited (and a second press meanwhile does nothing). Visitors never get here (the buttons aren't offered).
 */
export async function handOffMeeting(net: Net, id: string, kind: 'task' | 'worker', host: HandoffHost, win: HandoffWindow): Promise<void> {
  const floor = store.floor;
  const run = gate.begin(() => win.isOpen() && store.floor === floor);
  if (!run) return;
  try {
    await handOff(net, id, kind, host, win, run.ok);
  } finally {
    run.end();
  }
}

async function handOff(net: Net, id: string, kind: 'task' | 'worker', host: HandoffHost, win: HandoffWindow, ok: () => boolean): Promise<void> {
  const enc = encodeURIComponent(id);
  const [rec, list] = await Promise.all([get<ArchivedMeeting>(`/api/meetings/${enc}`), get<MeetingFiles>(`/api/meetings/${enc}/files`)]);
  if (!ok()) return; // the window was closed (or the floor changed) while the archive answered
  if (!rec.ok) return void toast(`Couldn’t open the meeting: ${rec.error}`, 'warn');
  if (!list.ok) return void toast(`Couldn’t open the meeting’s notes: ${list.error}`, 'warn');
  const record = rec.data;
  const out = list.data.files.find((f) => f.kind === 'output');
  if (!out) return void toast('This meeting has no output to hand on', 'warn');
  const file = await get<MeetingFileText>(`/api/meetings/${enc}/file`, { name: out.name });
  if (!ok()) return;
  if (!file.ok) return void toast(fileProblem(file.status, file.error), 'warn');
  if (host.officeIsFull()) return;

  const desk = host.freeDesk();
  const base = hireOption(net, () => desk?.id, desk?.label ?? 'the next free desk');
  if (kind === 'task') {
    if (!base || !kanbanTool(officeChoice(store.project).provider)) return void toast('A kanban task needs a project’s floor and Claude Code or Codex as the worker', 'warn');
  } else if (!desk) return void toast('Every desk and bean bag is taken — send a worker home first', 'warn');

  const templates = { main: promptText(store.prompts.custom, 'meeting.handoff'), pr: promptText(store.prompts.custom, 'meeting.handoff.pr'), stopped: promptText(store.prompts.custom, 'meeting.handoff.stopped'), branch: promptText(store.prompts.custom, 'meeting.handoff.branch') };
  const { text, attach, branchParagraph } = composeHandoff({ record, output: file.data.text, templates, withBranch: false, canAttach: !!base });
  const presetAttachments = [];
  if (attach) {
    const name = outputFileName(record.output);
    try {
      presetAttachments.push(await uploadAttachment(new File([file.data.text], name, { type: /\.(md|markdown)$/i.test(name) ? 'text/markdown' : 'text/plain' }), name));
    } catch (e) {
      return void (ok() && toast(`Couldn’t attach the output: ${(e as Error).message}`, 'error'));
    }
    // Uploaded for nothing when it's dropped: the office sweeps loose uploads after a day.
    if (!ok()) return;
  }

  let kanbanOption: KanbanOption | undefined;
  if (base) {
    officeCss();
    kanbanOption = { ...base, ...(desk ? {} : { queued: true as const }), title: `🗂️ ${clip(record.title.split('\n')[0], 60)}`, checked: kind === 'task', tags: [handoffTag(id)], onCreated: (task) => net.send({ t: 'meeting.handed', id, task }) };
  }
  win.close();
  openPrompt({
    title: `${kind === 'task' ? '🗂️' : '🤖'} ${clip(record.title.split('\n')[0], 60)}`,
    subtitle: `Handed on from the meeting “${clip(record.title.split('\n')[0], 60)}”: its output, ready to edit.`,
    warning: pressureNote(store.machine),
    initial: text,
    fromTop: true,
    maxLength: SPAWN_PROMPT_MAX,
    submitLabel: 'Hire & start',
    providerOption: true,
    worktreeOption: !!store.project?.branch,
    worktreeDefault: true,
    repoOptions: repoChoices(),
    attachments: !!kanbanOption,
    presetAttachments,
    kanbanOption,
    toggle: branchParagraph ? { label: `🌿 Start from the meeting’s branch (${record.branch})`, checked: false, onChange: (on, ta) => void (ta.value = toggleParagraph(ta.value, branchParagraph, on)) } : undefined,
    onSubmit: (prompt, o) => (desk ? host.hire(desk.id, prompt, { ...o, meeting: id }) : toast('No free desk for a worker — every desk and bean bag is taken. Run it as a kanban task or send a worker home first', 'warn')),
  });
}

/** What a meeting was handed on to, compact: "→ #12, Pixel". */
export const handedLabel = (m: { handedTo?: { task?: number; worker?: string }[] }): string => (m.handedTo?.length ? `→ ${m.handedTo.map((x) => (x.task !== undefined ? `#${x.task}` : x.worker)).join(', ')}` : '');

/** The two buttons that hand a finished meeting's output on (the kanban one only where a task can be made). */
export function handoffButtons(net: Net, id: string, host: HandoffHost, win: HandoffWindow): Node[] {
  const btn = (kind: 'task' | 'worker', label: string, title: string) => h('button.btn', { type: 'button', title, onclick: () => void handOffMeeting(net, id, kind, host, win) }, label);
  return [
    ...(canMakeTask() ? [btn('task', '🗂️ Make a kanban task', 'Open the hire dialog with the output as a kanban task')] : []),
    btn('worker', '🤖 Hand to a worker', 'Open the hire dialog with the output as the new worker’s prompt'),
  ];
}
