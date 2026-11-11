import './prompt.css';
import type { AgentEffort, AgentProvider, LostBranch, ServerMsg, WorktreeCleanup, WorktreeState } from '../../shared/protocol';
import { h, toast } from './dom';
import { icon, type IconName } from './icons';
import { btn, sendKeyHint } from './kit';
import { modalShell, openShell } from './shell';
import { store } from '../state';
import { providerPicker, type ProviderPicker } from './provider';
// The "Run as a kanban task" toggle in the hire dialog.
import { kanbanSection, type KanbanOption } from '../kanban/hireform';
import { onSendKey } from '../kanban/sendkey';
import { attachBox } from '../kanban/attachbox';
import type { KanbanAttachment } from '../../shared/kanban/types.js';

export interface PromptOptions {
  title: string;
  subtitle?: string;
  /** A warning over the prompt, e.g. that the machine is under pressure. */
  warning?: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  /** Allow hiring a worker without an initial prompt (the direct hire flow). */
  allowEmpty?: boolean;
  /** Offer the "own git worktree" option (only when hiring a new worker). */
  worktreeOption?: boolean;
  /** Offer the configured agent provider choice (only when hiring a new worker). */
  providerOption?: boolean;
  /** Other floors' projects a new worker in its own worktree can work in too (see WorkerInfo.repos). */
  repoOptions?: { id: string; name: string }[];
  /** Offer "Run as a kanban task" (hiring only); while it's on, sending makes the task instead of calling onSubmit. */
  kanbanOption?: KanbanOption;
  /** Files can be attached (the paperclip, paste, drop): they are uploaded to the kanban and their ids go with the hire. */
  attachments?: boolean;
  /** Files already uploaded that start in the list (needs `attachments`). */
  presetAttachments?: KanbanAttachment[];
  /** The worktree box's first state, in place of the last hire's choice (the stored choice only changes when the person sends). */
  worktreeDefault?: boolean;
  /** The longest a plain hire's prompt may be; a longer one is refused with a toast. */
  maxLength?: number;
  /** One more checkbox; ticking it also ticks the worktree box when there is one. */
  toggle?: { label: string; checked: boolean; onChange(on: boolean, ta: HTMLTextAreaElement): void };
  /** Checked when the person sends a plain hire (the kanban toggle off), before the dialog closes: a string is why it can't be, shown as a warning with the dialog kept open. */
  canHire?(): string | undefined;
  /** Opens with the cursor (and the view) at the start of `initial`, not its end: its first line matters (a hand-off's title). */
  fromTop?: boolean;
  /** A second button that sends with `raw` (a task implementer's "type straight into the terminal"). */
  rawLabel?: string;
  onSubmit(text: string, opts: { worktree: boolean; provider?: AgentProvider; model?: string; effort?: AgentEffort; repos: string[]; raw?: boolean; attachmentIds?: string[] }): void;
}

const WT_KEY = 'agent-office.worktree';
/** Whether the last hire asked for its own git worktree (the Ask window shares the choice). */
export function worktreePref(): boolean {
  try {
    return localStorage.getItem(WT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Hiring across repositories: other floors' projects the new worker takes on too, each in a worktree
 * of its own on the same branch. That needs a worktree of its own here, so picking one ticks `wtBox`
 * and unticking that clears them.
 */
export function repoPicker(options: { id: string; name: string }[] | undefined, wtBox: HTMLInputElement): { element: HTMLElement | null; value(): string[] } {
  const picks = (options ?? []).map((r) => {
    const box = h('input', { type: 'checkbox', value: r.id, onchange: () => box.checked && (wtBox.checked = true) }) as HTMLInputElement;
    return { id: r.id, box, el: h('label.repo-pick', { title: `A worktree of ${r.name} too, on the same branch, with a pull request of its own` }, box, r.name) };
  });
  if (!picks.length) return { element: null, value: () => [] };
  wtBox.addEventListener('change', () => {
    if (!wtBox.checked) for (const p of picks) p.box.checked = false;
  });
  return {
    element: h('div.repo-picks', { role: 'group', 'aria-label': 'Other projects to work in' }, h('span', {}, 'Also work in'), ...picks.map((p) => p.el)),
    value: () => picks.filter((p) => p.box.checked).map((p) => p.id),
  };
}

let formSeq = 0;

/** A tick box of the prompt dialogs: the box, an optional icon and its words. */
function tickRow(box: HTMLInputElement, label: string, mark?: IconName, title?: string): HTMLElement {
  return h('label.check-line.prompt-tick', { for: box.id, title }, box, mark ? icon(mark, { size: 14 }) : null, label);
}

export function openPrompt(opts: PromptOptions) {
  const ta = h('textarea.inp', { rows: 7, placeholder: opts.placeholder ?? 'What should the worker work on?', 'aria-label': 'Prompt' }) as HTMLTextAreaElement;
  ta.value = opts.initial ?? '';
  const wtBox = h('input', { type: 'checkbox', id: 'wt-toggle' }) as HTMLInputElement;
  wtBox.checked = opts.worktreeDefault ?? worktreePref();
  const wtRow = opts.worktreeOption ? tickRow(wtBox, 'Work in its own git worktree & branch', 'git-branch', 'Isolate this worker on its own branch so parallel workers never collide') : null;
  const extraBox = opts.toggle ? (h('input', { type: 'checkbox', id: 'extra-toggle' }) as HTMLInputElement) : null;
  if (extraBox && opts.toggle) {
    extraBox.checked = opts.toggle.checked;
    extraBox.addEventListener('change', () => {
      if (extraBox.checked && opts.worktreeOption) wtBox.checked = true;
      opts.toggle!.onChange(extraBox.checked, ta);
    });
    // Without its own worktree there is nothing for the toggle to start from.
    wtBox.addEventListener('change', () => {
      if (wtBox.checked || !extraBox.checked) return;
      extraBox.checked = false;
      opts.toggle!.onChange(false, ta);
    });
  }
  const extraRow = extraBox && opts.toggle ? tickRow(extraBox, opts.toggle.label) : null;
  const repos = repoPicker(opts.worktreeOption ? opts.repoOptions : undefined, wtBox);
  const provider: ProviderPicker | null = opts.providerOption ? providerPicker(store.project, 'prompt-provider') : null;
  const formId = `prompt-form-${++formSeq}`;
  const sendLabel = opts.submitLabel ?? 'Send';
  const submit = btn(sendLabel, { kind: 'primary', attrs: { type: 'submit', form: formId } });
  const cancel = btn('Cancel', { kind: 'quiet' });
  // The kanban toggle and the raw button.
  const kanban = opts.kanbanOption ? kanbanSection(opts.kanbanOption, provider) : null;
  const rawBtn = opts.rawLabel ? btn(opts.rawLabel, { attrs: { class: 'kb-raw' } }) : null;
  const subtitle = opts.subtitle ? h('p.prompt-sub', {}, opts.subtitle) : null;
  const form = h('form.prompt-form', { id: formId }, opts.warning ? h('p.setting-note.bad.prompt-warn', { role: 'alert' }, opts.warning) : null, subtitle, ta, provider?.element ?? null, wtRow, extraRow, repos.element, kanban?.element ?? null) as HTMLFormElement;
  form.noValidate = true;
  const shell = modalShell({ cls: `prompt${rawBtn ? ' w640' : ''}`, title: opts.title, body: form, footerLeft: [sendKeyHint()], footerRight: [cancel, rawBtn, submit] });
  const body = shell.main;
  const files = opts.attachments ? attachBox({ target: ta, dropZone: body, insertLinks: false }) : null;
  if (files) ta.after(files.el);
  for (const a of opts.presetAttachments ?? []) files?.adopt(a);
  // While the toggle is on, a task is made: no worktree options (the engine has its own), its own title.
  const kanbanPaint = (on: boolean) => {
    wtRow?.classList.toggle('hidden', on);
    repos.element?.classList.toggle('hidden', on);
    // The subtitle is about hiring ("start with an empty prompt"): a task needs its text, and says so below.
    subtitle?.classList.toggle('hidden', on);
    shell.setTitle(on ? (opts.kanbanOption?.title ?? opts.title) : opts.title);
    submit.textContent = on ? 'Create and start' : sendLabel;
    ta.placeholder = !on ? (opts.placeholder ?? 'What should the worker work on?') : kanban?.hasIssue() ? 'Anything to add? It goes above the issue’s text' : 'What’s the task? Its first line is the title';
  };
  if (kanban) {
    kanban.onChange(kanbanPaint);
    kanbanPaint(kanban.on());
  }

  const modal = openShell(shell);
  // A file dropped beside the body's drop zone would have the browser open it in place of the office.
  if (files) for (const type of ['dragover', 'drop']) modal.backdrop.addEventListener(type, (e) => e.preventDefault());
  cancel.addEventListener('click', () => modal.close());
  let sending = false;
  const send = (raw?: boolean) => {
    // One send at a time, whichever way the next one would go: the toggle or the picked issue may have changed while the office answers.
    if (sending) return;
    const text = ta.value.trim();
    if (files?.busy()) return void toast('Files are still uploading', 'warn');
    const attachmentIds = files?.ids() ?? [];
    // The hire makes a kanban task, which needs its text, unless an issue was picked: its title is the task's.
    if (kanban?.on()) {
      if (!text && !kanban.hasIssue()) return ta.focus();
      if (provider && !provider.valid()) return;
      const agent = { provider: provider?.value(), model: provider?.model(), effort: provider?.effort(), attachmentIds };
      // The dialog closes once the office made the task: turned down (or the connection gone), it stays open with what was written.
      sending = true;
      submit.disabled = true;
      return void kanban.send(text, agent).then((made) => {
        sending = false;
        submit.disabled = false;
        if (made) modal.close();
      });
    }
    if (!text && !opts.allowEmpty) {
      ta.focus();
      return;
    }
    if (provider && !provider.valid()) return;
    const why = opts.canHire?.();
    if (why) return void toast(why, 'warn');
    if (opts.maxLength && text.length > opts.maxLength) return void toast(`The prompt is ${text.length.toLocaleString()} characters; a worker's first prompt takes at most ${opts.maxLength.toLocaleString()}. Cut it down or run it as a kanban task`, 'warn');
    modal.close();
    if (opts.worktreeOption) {
      try {
        localStorage.setItem(WT_KEY, wtBox.checked ? '1' : '0');
      } catch {
        // storage blocked
      }
    }
    const worktree = !!opts.worktreeOption && wtBox.checked;
    opts.onSubmit(text, { worktree, provider: provider?.value(), model: provider?.model(), effort: provider?.effort(), repos: worktree ? repos.value() : [], ...(raw ? { raw } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) });
  };
  rawBtn?.addEventListener('click', () => send(true));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  onSendKey(ta, () => send());
  setTimeout(() => {
    ta.focus();
    const at = opts.fromTop ? 0 : ta.value.length;
    ta.setSelectionRange(at, at);
    if (opts.fromTop) ta.scrollTop = 0;
  }, 30);
}

export interface ConfirmOptions {
  /** `false` for a plain primary button. */
  danger?: boolean;
  /** What it is about, in mono after the title ("#144"). */
  id?: string;
  /** A line in bold over the explanation (the task's title, say). */
  lead?: string;
  /** The confirm button's icon ("trash-2" for Delete). */
  icon?: IconName;
}

/** A yes/no question before something that can't be undone (`danger: false` for a plain primary button). */
export function confirmDialog(title: string, body: string, confirmLabel: string, onConfirm: () => void, opts: ConfirmOptions = {}) {
  const danger = opts.danger !== false;
  const yes = btn(confirmLabel, { kind: danger ? 'danger' : 'primary', icon: opts.icon, attrs: { autofocus: true } });
  const no = btn('Cancel', { kind: 'quiet' });
  const shell = modalShell({
    cls: `confirm w420${danger ? ' danger' : ''}`,
    role: 'alertdialog',
    icon: danger ? 'triangle-alert' : 'info',
    title,
    id: opts.id,
    body: h('div.confirm-body', {}, opts.lead ? h('strong', {}, opts.lead) : null, h('span', {}, body)),
    footerRight: [no, yes],
  });
  const modal = openShell(shell);
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => {
    modal.close();
    onConfirm();
  });
}

export interface SendHomeOptions {
  workerId: string;
  name: string;
  /** The desk's label. */
  where: string;
  worktree: { path: string; branch: string };
  /** A worker across repositories: the folders of its workspace, its own floor's first (see WorkerInfo.repos). */
  repos?: string[];
  /** Asks the office what the worktree holds; the answer comes back through routeWorktreeMessage. */
  ask(): void;
  onConfirm(cleanup: WorktreeCleanup): void;
  /** A block over the choices (a task worker's task, kanban/sendhome.ts). */
  extra?: HTMLElement;
}

/** Whoever is waiting to hear what a worker's worktree holds, by worker id. */
const worktreeChecks = new Map<string, (state: WorktreeState) => void>();

export function routeWorktreeMessage(msg: ServerMsg) {
  if (msg.t !== 'worker.worktree') return;
  worktreeChecks.get(msg.workerId)?.(msg.state);
  worktreeChecks.delete(msg.workerId);
}

function inspectWorktree(workerId: string, ask: () => void): Promise<WorktreeState> {
  return new Promise((resolve) => {
    worktreeChecks.set(workerId, resolve);
    ask();
    setTimeout(() => {
      if (worktreeChecks.get(workerId) !== resolve) return;
      worktreeChecks.delete(workerId);
      resolve({ exists: true, dirty: 0, ahead: 0, unpushed: 0, error: 'the office did not answer' });
    }, 8000);
  });
}

const CLEANUP_LABEL: Record<WorktreeCleanup, string> = {
  all: 'Send home & delete both',
  worktree: 'Send home & delete worktree',
  keep: 'Send home',
};

/**
 * Sending home a worker that has its own worktree: pick what becomes of the worktree and its branch.
 * Opens on "keep" while the office checks the worktree, then suggests deleting when nothing would be lost.
 */
export function sendHomeDialog(opts: SendHomeOptions) {
  const { branch, path } = opts.worktree;
  const across = opts.repos && opts.repos.length > 1 ? opts.repos : undefined;
  // The command is `kanban3d` (prune).
  const choices: [WorktreeCleanup, string, string][] = across
    ? [
        ['all', 'Delete the worktrees and their branch', `Removes its worktrees of ${across.join(', ')}, and ${branch} in each.`],
        ['worktree', 'Delete the worktrees, keep the branch', `${branch} stays in each for a pull request or a later checkout.`],
        ['keep', 'Keep them all', 'Leaves everything as it is; kanban3d prune in each project tidies up later.'],
      ]
    : [
        ['all', 'Delete the worktree and its branch', `Removes ${path} and ${branch}.`],
        ['worktree', 'Delete the worktree, keep the branch', `${branch} stays for a pull request or a later checkout.`],
        ['keep', 'Keep both', 'Leaves everything as it is; kanban3d prune tidies up later.'],
      ];
  const radios = new Map<WorktreeCleanup, HTMLInputElement>();
  let touched = false;
  const formId = `send-home-${++formSeq}`;
  const yesText = h('span', {}, CLEANUP_LABEL.keep);
  const yes = h('button.btn.danger.lg', { type: 'submit', form: formId, autofocus: true }, icon('log-out'), yesText);
  const chosen = (): WorktreeCleanup => [...radios].find(([, r]) => r.checked)?.[0] ?? 'keep';
  const pick = (c: WorktreeCleanup) => {
    radios.get(c)!.checked = true;
    yesText.textContent = CLEANUP_LABEL[c];
  };
  const list = h(
    'div.choices',
    {},
    ...choices.map(([value, title, sub]) => {
      const r = h('input', {
        type: 'radio',
        name: 'cleanup',
        value,
        onchange: () => {
          touched = true;
          yesText.textContent = CLEANUP_LABEL[chosen()];
        },
      }) as HTMLInputElement;
      radios.set(value, r);
      return h('label.choice', {}, r, h('span', {}, title, h('small', {}, sub)));
    }),
  );
  const status = h('p.wt-status', {}, `Checking what ${branch} holds…`);
  const no = btn('Cancel', { kind: 'quiet' });
  const form = h(
    'form.send-home',
    { id: formId },
    opts.extra ?? null,
    h('p.confirm-lead', {}, `This stops the session at ${opts.where} for everyone and frees the desk. ${opts.name} worked ${across ? `in worktrees of ${across.join(', ')}, each` : 'in its own worktree'} on `, h('code.code-chip', {}, branch), ':'),
    list,
    status,
  ) as HTMLFormElement;
  const shell = modalShell({ cls: 'confirm danger w480', icon: 'triangle-alert', title: `Send ${opts.name} home?`, body: form, footerRight: [no, yes] });
  pick('keep');
  const modal = openShell(shell);
  no.addEventListener('click', () => modal.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const cleanup = chosen();
    modal.close();
    opts.onConfirm(cleanup);
  });
  void inspectWorktree(opts.workerId, opts.ask).then((s) => {
    if (!form.isConnected) return;
    // Across repositories, a line for each worktree, named.
    const each = s.repos?.length ? s.repos.map((r) => describeState(r.state, branch, `${r.name}: `)) : [describeState(s, branch)];
    const lines = each.flatMap((d) => d.lines);
    const risky = each.some((d) => d.risky);
    if (s.repos?.length && s.error && !lines.length) lines.push(`Couldn't check the worktrees: ${s.error}.`);
    status.replaceChildren(...lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
    status.classList.toggle('warn', risky || (!!s.error && !s.repos?.length));
    if (!touched) pick(risky ? 'keep' : 'all');
  });
}

export interface LostWorktreeOptions {
  name: string;
  worktree: { path: string; branch: string };
  lost: { branch: LostBranch };
  /** A worker across repositories: its workspace folder, deleted with every worktree in it. */
  workspace?: string;
  /** The other workers on the floor whose worktrees were deleted too. */
  others: string[];
  /** Its process is still running, in the deleted folder: its terminal is there to look at. */
  openTerminal?: () => void;
  /** Puts the folder back, for `all` the others' too. */
  rebuild(all: boolean): void;
  sendHome(): void;
}

/**
 * A worker whose worktree was deleted outside agent-office (see WorkerInfo.lost): says what happened
 * and what's left, and puts it back (every lost worker's at once, when there are more), or sends it home.
 */
export function lostWorktreeDialog(opts: LostWorktreeOptions) {
  const { name, others } = opts;
  const { branch } = opts.worktree;
  const folder = opts.workspace ?? opts.worktree.path;
  const title = `${name}'s worktree was deleted`;
  const what = {
    here: `Its branch ${branch} is still here. Rebuilding checks it out again in the same place, and ${name} carries on its conversation; only uncommitted changes went with the folder.`,
    origin: `Its branch ${branch} was deleted too, but it had been pushed: rebuilding checks origin's copy out again in the same place, and ${name} carries on its conversation.`,
    gone: `Its branch ${branch} was deleted too and was never pushed, so the work on it is gone. Rebuilding makes the branch again from where it started, and ${name} carries on its conversation.`,
  }[opts.lost.branch];
  const one = btn('Rebuild worktree', { kind: 'primary', icon: 'rotate-cw', attrs: { autofocus: true } });
  const all = others.length ? btn(`Rebuild all ${others.length + 1}`) : null;
  const home = btn('Send home…', { kind: 'quiet-danger', icon: 'log-out' });
  const look = opts.openTerminal ? btn('Open the terminal', { icon: 'square-terminal' }) : null;
  const shell = modalShell({
    cls: 'confirm lost-worktree',
    role: 'alertdialog',
    icon: 'triangle-alert',
    title,
    body: h(
      'div.confirm-body',
      {},
      h('strong', {}, `${folder} was deleted outside agent-office, so ${name} ${opts.openTerminal ? 'is running in a folder that no longer exists' : "can't start there"}.`),
      h('span', {}, what),
      others.length ? h('p.wt-status.warn', {}, `${plural(others.length, 'other worker')} on this floor lost ${others.length === 1 ? 'its worktree' : 'their worktrees'} too: ${others.join(', ')}.`) : null,
    ),
    footerLeft: [home],
    footerRight: [look, all, one],
  });
  const modal = openShell(shell);
  const then = (fn: () => void) => () => {
    modal.close();
    fn();
  };
  one.addEventListener('click', then(() => opts.rebuild(false)));
  all?.addEventListener('click', then(() => opts.rebuild(true)));
  home.addEventListener('click', then(opts.sendHome));
  if (look) look.addEventListener('click', then(opts.openTerminal!));
}

/** What deleting one worktree (and its branch) would lose, in a line or two for the send-home dialog. */
function describeState(s: WorktreeState, branch: string, prefix = ''): { lines: string[]; risky: boolean } {
  if (s.error) return { lines: [`${prefix}Couldn't check the worktree: ${s.error}.`], risky: true };
  const lines: string[] = [];
  let risky = false;
  if (!s.exists) lines.push(`${prefix}The worktree folder is already gone.`);
  if (s.dirty) {
    lines.push(`${prefix}${plural(s.dirty, 'uncommitted change')} in the worktree — deleting it loses them.`);
    risky = true;
  }
  if (s.unpushed) {
    lines.push(`${prefix}${plural(s.unpushed, 'commit')} on ${branch} that no remote has — deleting the branch loses them.`);
    risky = true;
  } else if (s.ahead) lines.push(`${prefix}${plural(s.ahead, 'commit')} on ${branch}, all pushed or merged.`);
  if (!lines.length) lines.push(`${prefix}Nothing on the branch yet and a clean worktree: safe to delete.`);
  return { lines, risky };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
